import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CheckoutController } from '../checkout/controller';
import { ApiError, type Storage } from '../domain/types';
import { createLiveApi, type ConnectedConfig } from './http-api';
import { MAX_RECEIPT_BYTES, PDF_MIME_TYPE } from './receipt';

const config: ConnectedConfig = {
  profile: 'stage',
  apiBaseUrl: 'https://api.crustcaper.test/api/v1',
  storeId: 'kigali',
  pspHosts: ['checkout.example.test'],
};
const journalKey = 'checkout.stage';
const now = () => Date.parse('2026-11-25T10:00:00Z');
const expiresAt = '2026-11-26T10:00:00Z';
const accessToken = 'guest_' + 'a'.repeat(40);
const refreshToken = 'refresh_' + 'b'.repeat(40);
const refreshExpiresAt = '2027-01-26T10:00:00Z';
const session = { accessToken, expiresAt, refreshToken, refreshExpiresAt };
const cartLine = { sku: 'double-smash', quantity: 1, unitPrice: 9200, modifierIds: [] };
const pickupOrderId = 'ab83bbb6-fd3c-4fad-99c7-4538319add23';
const installationId = '67295c19-0610-4210-94df-79d8161bb727';
const pushConfig = { ...config, pushProjectId: '13015b68-c43c-481a-be41-1ff695c1a37b' };
const order = {
  id: 'order-17',
  storeId: 'kigali',
  slotId: 'lunch',
  lines: [cartLine],
  total: 9200,
  tax: 0,
  currency: 'RWF',
  paymentStatus: 'processing',
  status: 'awaiting_payment',
  pickupCode: null,
  receiptStatus: 'pending',
  receiptUrl: null,
  paymentAttempt: { id: 'attempt-1', status: 'processing', checkoutUrl: 'https://checkout.example.test/pay/one' },
  createdAt: '2026-11-25T10:00:00Z',
  reservationExpiresAt: '2026-11-25T10:10:00Z',
  pickupStartsAt: '2026-11-25T10:15:00Z',
  pickupEndsAt: '2026-11-25T10:25:00Z',
};

function memory() {
  const data = new Map<string, string>();
  const storage: Storage & { removeItem(key: string): Promise<void> } = {
    async getItem(key) { return data.get(key) ?? null; },
    async setItem(key, value) { data.set(key, value); },
    async removeItem(key) { data.delete(key); },
  };
  return { data, storage };
}

type Call = { url: string; method?: string; key: string | null; token: string | null; accept: string | null; installationId: string | null; body: unknown };
function transport(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const call = {
      url: String(input),
      method: init?.method,
      key: headers.get('Idempotency-Key'),
      token: headers.get('Authorization'),
      accept: headers.get('Accept'),
      installationId: headers.get('X-Installation-Id'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.credentials, 'omit');
    calls.push(call);
    return handler(call);
  };
  return { calls, fetcher };
}

test('connected order reads retain validated purchased items without putting them into repeat offers', async () => {
  const { storage } = memory();
  const soldItem = {
    catalogVersion: 'sale-1', name: { en: 'Original burger', rw: 'Burgeri ya mbere' },
    ingredients: [{ en: 'Bun', rw: 'Umugati' }],
    allergens: [{ en: 'Wheat', rw: 'Ingano' }],
    modifiers: [{ id: 'extra-cheese', name: { en: 'Extra cheese', rw: 'Foromaje y’inyongera' }, price: 500 }],
  };
  const selectedLine = { ...cartLine, modifierIds: ['extra-cheese'] };
  let orderLine: object = { ...selectedLine, soldItem };
  const { fetcher } = transport(call => {
    if (call.url.endsWith('/guest-sessions')) return Response.json(session, { status: 201 });
    assert.equal(call.token, 'Bearer ' + accessToken);
    if (call.url.endsWith(`/orders/${order.id}/reorder`)) {
      return Response.json({ lines: [{ ...selectedLine, unitPrice: 9800, soldItem }], changes: [] });
    }
    assert.equal(call.url, config.apiBaseUrl + '/orders/' + order.id);
    return Response.json({ ...order, lines: [orderLine] });
  });
  const api = createLiveApi({ config, storage, journalKey, fetcher, now });
  assert.deepEqual((await api.getOrder(order.id)).lines, [{ ...selectedLine, soldItem }]);
  assert.deepEqual(await api.reorder(order.id), { lines: [{ ...selectedLine, unitPrice: 9800 }], changes: [] });

  orderLine = selectedLine;
  assert.deepEqual((await api.getOrder(order.id)).lines, [selectedLine]);
  orderLine = { ...selectedLine, soldItem: { ...soldItem, modifiers: [{ ...soldItem.modifiers[0], id: 'no-pickles' }] } };
  await assert.rejects(api.getOrder(order.id), { code: 'invalid_response' });
  orderLine = { ...selectedLine, soldItem: { ...soldItem, allergens: [{ en: 'Wheat' }] } };
  await assert.rejects(api.getOrder(order.id), { code: 'invalid_response' });
});

test('pickup alert reads, opt-in and opt-out are bearer scoped and reuse a private installation after restart', async () => {
  const { storage, data } = memory();
  const fixtureToken = 'ExpoPushToken[test-fixture]';
  let enabled = false;
  let available = true;
  let installations = 0;
  const { fetcher, calls } = transport(call => {
    if (call.url.endsWith('/guest-sessions')) {
      assert.equal(call.installationId, null);
      return Response.json(session, { status: 201 });
    }
    assert.equal(call.url, config.apiBaseUrl + `/orders/${pickupOrderId}/pickup-alert`);
    assert.equal(call.token, 'Bearer ' + accessToken);
    assert.equal(call.installationId, installationId);
    assert.equal(call.key, null);
    assert.equal(data.get(journalKey + '.installation'), installationId);
    if (call.method === 'PUT') {
      assert.deepEqual(call.body, { token: fixtureToken, locale: 'rw' });
      enabled = true;
    } else assert.equal(call.body, undefined);
    if (call.method === 'DELETE') {
      enabled = false;
      return new Response(null, { status: 204 });
    }
    return Response.json({ enabled, available });
  });
  const options = {
    config: pushConfig, storage, journalKey, fetcher, now,
    newInstallationId: () => { installations++; return installationId; },
  };
  const first = createLiveApi(options).pickupAlerts!;
  const reads = await Promise.all([first.get(pickupOrderId), first.get(pickupOrderId)]);
  assert.deepEqual(reads, [{ enabled: false, available: true }, { enabled: false, available: true }]);
  assert.deepEqual(await first.enable(pickupOrderId, fixtureToken, 'rw'), { enabled: true, available: true });
  assert.ok([...data.values()].every(value => !value.includes(fixtureToken)));
  available = false;
  const restarted = createLiveApi(options).pickupAlerts!;
  assert.deepEqual(await restarted.get(pickupOrderId), { enabled: true, available: false });
  await restarted.disable(pickupOrderId);
  assert.deepEqual(await restarted.get(pickupOrderId), { enabled: false, available: false });
  assert.equal(installations, 1);
  assert.deepEqual(calls.filter(call => call.installationId).map(call => call.method), ['GET', 'GET', 'PUT', 'GET', 'DELETE', 'GET']);
});

test('pickup alert is disabled outside configured native stage or production and rejects malformed inputs', async () => {
  const { storage, data } = memory();
  const { fetcher, calls } = transport(() => { throw new Error('unexpected request'); });
  const options = { storage, journalKey, fetcher, now, newInstallationId: () => installationId };
  assert.equal(createLiveApi({ ...options, config }).pickupAlerts, undefined);
  assert.equal(createLiveApi({ ...options, config: { ...pushConfig, profile: 'local' } }).pickupAlerts, undefined);
  assert.equal(createLiveApi({ ...options, config: pushConfig, newInstallationId: undefined }).pickupAlerts, undefined);

  const alerts = createLiveApi({ ...options, config: pushConfig }).pickupAlerts!;
  await assert.rejects(alerts.get('../orders'), { code: 'invalid_input' });
  await assert.rejects(alerts.enable(pickupOrderId, 'unverified-token', 'en'), { code: 'invalid_input' });
  data.set(journalKey + '.installation', 'corrupt');
  await assert.rejects(alerts.get(pickupOrderId), { code: 'storage_unavailable' });
  assert.equal(data.get(journalKey + '.installation'), 'corrupt');
  assert.deepEqual(calls, []);
});

test('failed opt-in and opt-out never appear confirmed', async () => {
  const { storage } = memory();
  const { fetcher } = transport(call => {
    if (call.url.endsWith('/guest-sessions')) return Response.json(session, { status: 201 });
    if (call.method === 'PUT') return Response.json({ code: 'pickup_alert_unavailable' }, { status: 409 });
    if (call.method === 'DELETE') return Response.json(null);
    return Response.json({ enabled: 'false' });
  });
  const alerts = createLiveApi({ config: pushConfig, storage, journalKey, fetcher, now, newInstallationId: () => installationId }).pickupAlerts!;
  await assert.rejects(alerts.enable(pickupOrderId, 'ExponentPushToken[test-fixture]', 'en'), { code: 'pickup_alert_unavailable' });
  await assert.rejects(alerts.disable(pickupOrderId), { code: 'invalid_response' });
  await assert.rejects(alerts.get(pickupOrderId), { code: 'invalid_response' });
});

test('connected requests share one durable guest identity and recover with the same key after restart', async () => {
  const { storage, data } = memory();
  const { fetcher, calls } = transport(call => {
    if (call.url.endsWith('/guest-sessions')) return Response.json(session, { status: 201 });
    assert.equal(call.token, 'Bearer ' + accessToken);
    assert.equal(JSON.parse(data.get(journalKey + '.guest') ?? '{}').accessToken, accessToken);
    return Response.json(order);
  });
  const options = { config, storage, journalKey, fetcher, now };
  const api = createLiveApi(options);
  const contact = { quoteId: 'q-1', phone: '+250700000000', email: 'buyer@example.test' };
  await Promise.all([api.createOrder(contact, 'key-one'), api.getOrder(order.id)]);
  const restored = await createLiveApi(options).recoverOrder?.('key-one');
  assert.equal(restored?.id, order.id);
  assert.equal(calls.filter(call => call.url.endsWith('/guest-sessions')).length, 1);
  assert.equal(calls.find(call => call.url.endsWith('/orders'))?.key, 'key-one');
  assert.equal(calls.find(call => call.url.endsWith('/orders/recovery'))?.key, 'key-one');
  assert.deepEqual(calls.find(call => call.url.endsWith('/orders'))?.body, contact);
  assert.doesNotMatch(JSON.stringify([...data.values()]), /buyer@|700000000/);
});

test('lost, corrupt or expired guest identity cannot silently adopt a new guest for a saved checkout', async () => {
  const { storage, data } = memory();
  await storage.setItem(journalKey, '{"active":{"phase":"creating"}}');
  const { fetcher, calls } = transport(() => Response.json(session));
  const api = createLiveApi({ config, storage, journalKey, fetcher, now });
  await assert.rejects(() => api.getOrder(order.id), { code: 'unauthenticated' });
  data.set(journalKey + '.guest', 'damaged');
  await assert.rejects(() => api.getOrder(order.id), { code: 'storage_unavailable' });
  data.set(journalKey + '.guest', JSON.stringify({ ...session, expiresAt: '2026-11-25T09:00:00Z', refreshExpiresAt: '2026-11-25T09:30:00Z' }));
  await assert.rejects(() => api.getOrder(order.id), { code: 'unauthenticated' });
  assert.equal(calls.length, 0);
});

test('expired credentials can be replaced when no checkout or order history is saved', async () => {
  for (const previous of [null, { version: 1, active: null, orderIds: [] }]) {
    const { storage, data } = memory();
    data.set(journalKey + '.guest', JSON.stringify({
      ...session, expiresAt: '2026-11-25T09:00:00Z', refreshExpiresAt: '2026-11-25T09:30:00Z',
      accessToken: 'old_access_' + 'x'.repeat(40),
    }));
    if (previous) data.set(journalKey, JSON.stringify(previous));
    const { fetcher, calls } = transport(call => {
      if (call.url.endsWith('/guest-sessions')) return Response.json(session);
      assert.equal(call.token, 'Bearer ' + accessToken);
      return Response.json({
        quoteId: 'q-1', storeId: config.storeId, slotId: 'lunch', lines: [cartLine],
        subtotal: 9200, tax: 0, total: 9200, currency: 'RWF', expiresAt, changes: [],
        pickupStartsAt: order.pickupStartsAt, pickupEndsAt: order.pickupEndsAt,
      });
    });
    const api = createLiveApi({ config, storage, journalKey, fetcher, now });
    assert.equal((await api.createQuote({ storeId: config.storeId, slotId: 'lunch', lines: [cartLine] })).id, 'q-1');
    assert.deepEqual(calls.map(call => new URL(call.url).pathname), ['/api/v1/guest-sessions', '/api/v1/quotes']);
    assert.equal(JSON.parse(data.get(journalKey + '.guest') ?? '{}').accessToken, accessToken);
  }
});

test('expiring a former guest never issues a new identity over saved order history', async () => {
  const { storage, data } = memory();
  const previous = JSON.stringify({ version: 1, active: null, orderIds: [order.id] });
  const expired = JSON.stringify({ ...session, expiresAt: '2026-11-25T09:00:00Z', refreshExpiresAt: '2026-11-25T09:30:00Z' });
  data.set(journalKey, previous);
  data.set(journalKey + '.guest', expired);
  const { fetcher, calls } = transport(() => Response.json(session));
  const api = createLiveApi({ config, storage, journalKey, fetcher, now });
  await assert.rejects(() => api.createQuote({ storeId: config.storeId, slotId: 'lunch', lines: [cartLine] }),
    { code: 'unauthenticated' });
  assert.equal(calls.length, 0);
  assert.equal(data.get(journalKey), previous);
  assert.equal(data.get(journalKey + '.guest'), expired);
});

test('an unavailable server is distinguishable from a missing committed order', async () => {
  const { storage } = memory();
  let status = 503;
  const { fetcher } = transport(call => {
    if (call.url.endsWith('/guest-sessions')) return Response.json(session);
    if (call.url.endsWith('/guest-sessions/refresh')) {
      return Response.json({ ...session, accessToken: 'renewed_' + 'c'.repeat(40) });
    }
    return Response.json({ code: 'not_found' }, { status });
  });
  const api = createLiveApi({ config, storage, journalKey, fetcher, now });
  await assert.rejects(() => api.recoverOrder!('q'), { code: 'service_unavailable' });
  status = 401;
  await assert.rejects(() => api.recoverOrder!('q'), { code: 'unauthenticated' });
  status = 404;
  assert.equal(await api.recoverOrder?.('q'), null);
});

test('a transport response marked as redirected is rejected before reading its body', async () => {
  const { storage } = memory();
  const api = createLiveApi({
    config, storage, journalKey, now,
    fetcher: async (url, options) => {
      assert.equal(options.redirect, 'error');
      return {
        ok: true, status: 200, url, redirected: true,
        headers: new Headers(), body: null,
        async json() { assert.fail('Redirected response bodies must not be read'); },
      };
    },
  });
  await assert.rejects(() => api.getMenu(), { code: 'invalid_response' });
});

test('order phone verification uses the same guest without saving the contact or code', async () => {
  const { data, storage } = memory();
  const challengeId = '85e9eb23-9b52-4905-8c81-7d347d746db9';
  const orderId = '1cf5ba6e-0584-45b5-bbc5-3a5ec90502c9';
  const { calls, fetcher } = transport(call => {
    if (call.url.endsWith('/guest-sessions')) return Response.json(session, { status: 201 });
    if (call.url.endsWith('/order-access/challenges')) return Response.json({ challengeId }, { status: 202 });
    assert.ok(call.url.endsWith(`/order-access/challenges/${challengeId}/verify`));
    if (!call.body || !('code' in (call.body as { code?: string }))) assert.fail('Verification needs the submitted code');
    return (call.body as { code: string }).code === '418263'
      ? Response.json({ orderId }) : Response.json({ code: 'not_found' }, { status: 404 });
  });
  const api = createLiveApi({ config, storage, journalKey, fetcher, now });
  const contact = { orderCode: '502A8EF1', phone: '+250700000000' };

  assert.deepEqual(await api.requestOrderAccess!(contact), { challengeId });
  await assert.rejects(() => api.verifyOrderAccess!(challengeId, '111111'), { code: 'not_found' });
  assert.deepEqual(await api.verifyOrderAccess!(challengeId, '418263'), { orderId });

  const protectedCalls = calls.filter(call => call.url.includes('/order-access/'));
  assert.deepEqual(protectedCalls.map(({ token }) => token), Array(3).fill('Bearer ' + accessToken));
  assert.deepEqual(protectedCalls.map(({ body }) => body), [contact, { code: '111111' }, { code: '418263' }]);
  assert.doesNotMatch(JSON.stringify([...data.values()]), /700000000|418263|502A8EF1/);
});

const recoveryChallengeId = '85e9eb23-9b52-4905-8c81-7d347d746db9';
const recoveryOrderId = '1cf5ba6e-0584-45b5-bbc5-3a5ec90502c9';
const recoveryContact = { orderCode: 'C90502C9', phone: '+250700000000' };
const privacyExport = {
  orderId: recoveryOrderId, storeId: order.storeId, phone: recoveryContact.phone, email: 'export-fixture@example.test',
  lines: order.lines, total: order.total, tax: order.tax, currency: order.currency, status: order.status,
  paymentStatus: order.paymentStatus, receiptStatus: order.receiptStatus, createdAt: order.createdAt,
  pickupStartsAt: order.pickupStartsAt, pickupEndsAt: order.pickupEndsAt,
};
const erasure = { request: { requestId: '9afe0a38-7a13-4425-8ace-2c491efac709', submittedAt: expiresAt,
  status: 'pending', reviewedAt: null } };
const expiredGuest = {
  ...session, expiresAt: '2026-11-25T09:00:00Z', refreshExpiresAt: '2026-11-25T09:30:00Z',
};
const recoveryGuest = {
  ...session, accessToken: 'replacement_' + 'c'.repeat(40), refreshToken: 'replacement_refresh_' + 'd'.repeat(40),
};
const recoveredOrder = {
  ...order, id: recoveryOrderId, status: 'collected', paymentStatus: 'paid', paymentAttempt: null,
};

test('a native checkout with a lost create reply recovers on a fresh guest only after OTP and resumes one payment', async () => {
  for (const primary of [expiredGuest, session]) {
    const { data, storage } = memory();
    const intent = { quoteId: '35ec0f83-629a-45e7-bff4-e445cc1e0739', key: 'saved-create-key' };
    const active = { phase: 'creating', ...intent, cartFingerprint: 'saved-cart' };
    data.set(journalKey, JSON.stringify({ version: 1, active, orderIds: [] }));
    data.set(journalKey + '.guest', JSON.stringify(primary));
    let verified = false;
    let lostReply = true;
    let paymentStarted = false;
    const { calls, fetcher } = transport(call => {
      const path = new URL(call.url).pathname.slice('/api/v1'.length);
      if (path === '/orders/recovery' || path === '/guest-sessions/refresh') {
        assert.notEqual(call.token, 'Bearer ' + recoveryGuest.accessToken);
        return new Response(null, { status: 401 });
      }
      if (path === '/guest-sessions') return Response.json(recoveryGuest);
      if (call.token === 'Bearer ' + primary.accessToken) return new Response(null, { status: 401 });
      assert.equal(call.token, 'Bearer ' + recoveryGuest.accessToken);
      if (path === '/checkout-recovery') {
        assert.deepEqual(call.body, { ...intent, phone: recoveryContact.phone });
        return Response.json({ state: 'verify', challengeId: recoveryChallengeId });
      }
      if (path === `/order-access/challenges/${recoveryChallengeId}/verify`) {
        if ((call.body as { code: string }).code !== '418263') return new Response(null, { status: 404 });
        verified = true;
        if (lostReply) {
          lostReply = false;
          throw new Error('Lost verification reply');
        }
        return Response.json({ orderId: recoveryOrderId });
      }
      assert.ok(verified);
      if (path === `/orders/${recoveryOrderId}/payments`) {
        assert.equal(call.key, 'saved-payment-key');
        assert.equal(paymentStarted, false);
        paymentStarted = true;
        return Response.json(order.paymentAttempt);
      }
      assert.equal(path, `/orders/${recoveryOrderId}`);
      return Response.json({ ...order, id: recoveryOrderId, ...(paymentStarted ? {} : { paymentStatus: 'unpaid', paymentAttempt: null }) });
    });
    const restart = () => {
      const api = createLiveApi({ config, storage, journalKey, fetcher, now });
      const controller = new CheckoutController({ api, storage, storageKey: journalKey, newKey: () => 'saved-payment-key',
        guestSession: { end: api.endGuestSession, hasEndPending: api.hasGuestSessionEndPending }, onOrderCreated: async () => {} });
      return { api, controller };
    };
    const first = restart();
    await assert.rejects(first.controller.resume(), { code: 'unauthenticated' });
    await assert.rejects(first.controller.endGuestSession(), { code: 'active_checkout' });
    await assert.rejects(first.api.startPayment(recoveryOrderId, 'forbidden-before-approval'), { code: 'unauthenticated' });
    assert.deepEqual(await first.controller.requestPendingOrderRecovery(recoveryContact.phone), {
      state: 'verify', challengeId: recoveryChallengeId,
    });
    assert.equal(data.get(journalKey + '.guest'), JSON.stringify(primary));
    const second = restart();
    await assert.rejects(second.controller.confirmPendingOrderRecovery(recoveryChallengeId, '000000'), { code: 'not_found' });
    await assert.rejects(second.controller.confirmPendingOrderRecovery(recoveryChallengeId, '418263'), { code: 'network_unavailable' });
    assert.equal(data.get(journalKey + '.guest'), JSON.stringify(primary));
    assert.equal(second.controller.snapshot.active?.phase, 'creating');
    const third = restart();
    assert.equal((await third.controller.confirmPendingOrderRecovery(recoveryChallengeId, '418263')).id, recoveryOrderId);
    assert.equal(third.controller.snapshot.active?.phase, 'paying');
    assert.equal((await restart().controller.resume()).paymentStatus, 'processing');
    assert.equal((await restart().controller.resume()).id, recoveryOrderId);
    assert.deepEqual(JSON.parse(data.get(journalKey + '.guest')!), recoveryGuest);
    assert.equal(calls.filter(({ url }) => url.endsWith('/guest-sessions')).length, 1);
    assert.equal(calls.filter(({ url, token }) => url.endsWith('/payments') && token === 'Bearer ' + recoveryGuest.accessToken).length, 1);
    assert.equal(calls.filter(({ url, method }) => method === 'POST' && url.endsWith('/orders')).length, 0);
    assert.doesNotMatch(JSON.stringify([...data.values()]), /700000000|418263/);
  }
});

test('native recovery preserves a pending intent on an older API and adopts a replacement after durable not-placed', async () => {
  const { data, storage } = memory();
  const intent = { quoteId: '35ec0f83-629a-45e7-bff4-e445cc1e0739', key: 'unresolved-create' };
  const active = { phase: 'creating', ...intent, cartFingerprint: 'saved-cart' };
  const journal = { version: 1, active, orderIds: [pickupOrderId] };
  data.set(journalKey, JSON.stringify(journal));
  data.set(journalKey + '.guest', JSON.stringify(expiredGuest));
  let response: Response = new Response(null, { status: 404 });
  const { calls, fetcher } = transport(call => {
    if (call.url.endsWith('/guest-sessions')) return Response.json(recoveryGuest);
    assert.equal(call.token, 'Bearer ' + recoveryGuest.accessToken);
    if (call.url.endsWith('/checkout-recovery')) {
      assert.deepEqual(call.body, { ...intent, phone: recoveryContact.phone });
      return response.clone();
    }
    assert.equal(call.url, config.apiBaseUrl + '/orders/' + pickupOrderId);
    return new Response(null, { status: 404 });
  });
  let failJournalWrite = true;
  const protectedStorage = { ...storage, async setItem(key: string, value: string) {
    if (failJournalWrite && key === journalKey) throw new Error('Journal write interrupted');
    await storage.setItem(key, value);
  } };
  const restart = () => {
    const api = createLiveApi({ config, storage: protectedStorage, journalKey, fetcher, now });
    const controller = new CheckoutController({ api, storage: protectedStorage, storageKey: journalKey,
      newKey: () => 'payment-key', onOrderCreated: async () => {} });
    return { api, controller };
  };
  const first = restart();
  await assert.rejects(first.api.requestPendingCheckoutRecovery!({ ...intent, key: 'different-key' }, recoveryContact.phone),
    { code: 'unauthenticated' });
  assert.equal(calls.length, 0);
  await assert.rejects(first.controller.requestPendingOrderRecovery(recoveryContact.phone), { code: 'checkout_recovery_unavailable' });
  assert.equal(data.get(journalKey), JSON.stringify(journal));
  response = Response.json({ state: 'waiting', retryAt: expiresAt });
  assert.deepEqual(await first.controller.requestPendingOrderRecovery(recoveryContact.phone), { state: 'waiting', retryAt: expiresAt });
  assert.equal(data.get(journalKey), JSON.stringify(journal));
  response = Response.json({ state: 'not_placed' });
  await assert.rejects(first.controller.requestPendingOrderRecovery(recoveryContact.phone));
  await assert.rejects(restart().api.getOrder(pickupOrderId), { code: 'unauthenticated' });
  assert.equal(data.get(journalKey + '.guest'), JSON.stringify(expiredGuest));
  failJournalWrite = false;
  assert.deepEqual(await restart().controller.requestPendingOrderRecovery(recoveryContact.phone), { state: 'not_placed' });
  assert.deepEqual(JSON.parse(data.get(journalKey)!), { ...journal, active: null });
  await assert.rejects(restart().api.getOrder(pickupOrderId), { code: 'not_found' });
  assert.deepEqual(JSON.parse(data.get(journalKey + '.guest')!), recoveryGuest);
  assert.equal(calls.filter(({ url }) => url.endsWith('/guest-sessions')).length, 1);
  assert.equal(calls.filter(({ url, method }) => method === 'POST' && url.endsWith('/orders')).length, 0);
});

test('native recovery cannot substitute a still-valid primary checkout identity', async () => {
  const { data, storage } = memory();
  const intent = { quoteId: '35ec0f83-629a-45e7-bff4-e445cc1e0739', key: 'resume-on-original' };
  data.set(journalKey, JSON.stringify({ version: 1, active: { phase: 'creating', ...intent, cartFingerprint: 'saved-cart' }, orderIds: [] }));
  data.set(journalKey + '.guest', JSON.stringify(session));
  const { calls, fetcher } = transport(call => {
    assert.equal(call.url, config.apiBaseUrl + '/orders/recovery');
    assert.equal(call.token, 'Bearer ' + session.accessToken);
    assert.equal(call.key, intent.key);
    return new Response(null, { status: 404 });
  });
  const api = createLiveApi({ config, storage, journalKey, fetcher, now });
  await assert.rejects(api.requestPendingCheckoutRecovery!(intent, recoveryContact.phone), { code: 'conflict' });
  assert.equal(calls.length, 1);
  assert.equal(data.get(journalKey + '.guest'), JSON.stringify(session));
});

test('a proven unplaced checkout can get a new quote when the recovery guest has expired or been revoked', async () => {
  for (const revoked of [false, true]) {
    const { data, storage } = memory();
    const temporary = revoked ? recoveryGuest : {
      ...recoveryGuest, expiresAt: expiredGuest.expiresAt, refreshExpiresAt: expiredGuest.refreshExpiresAt,
    };
    const original = JSON.stringify(expiredGuest);
    const journal = { version: 1, active: null, orderIds: [pickupOrderId] };
    data.set(journalKey, JSON.stringify(journal));
    data.set(journalKey + '.guest', revoked ? JSON.stringify(temporary) : original);
    data.set(journalKey + '.pending-checkout-guest', JSON.stringify({
      state: 'not_placed', quoteId: '35ec0f83-629a-45e7-bff4-e445cc1e0739', key: 'previous-attempt',
      previous: original, guest: temporary,
    }));
    const input = { storeId: config.storeId, slotId: order.slotId, lines: [cartLine] };
    const { calls, fetcher } = transport(call => {
      if (call.url.endsWith('/guest-sessions/refresh')) return new Response(null, { status: 401 });
      if (call.url.endsWith('/guest-sessions')) return Response.json(session);
      assert.equal(call.url, config.apiBaseUrl + '/quotes');
      if (call.token === 'Bearer ' + temporary.accessToken) return new Response(null, { status: 401 });
      assert.equal(call.token, 'Bearer ' + accessToken);
      return Response.json({
        ...input, quoteId: 'fresh-quote', subtotal: order.total, tax: 0, total: order.total, currency: 'RWF',
        expiresAt, pickupStartsAt: order.pickupStartsAt, pickupEndsAt: order.pickupEndsAt, changes: [],
      });
    });
    const options = { config, storage, journalKey, fetcher, now };
    if (revoked) await assert.rejects(createLiveApi(options).createQuote(input), { code: 'unauthenticated' });
    assert.equal((await createLiveApi(options).createQuote(input)).id, 'fresh-quote');
    assert.deepEqual(JSON.parse(data.get(journalKey)!), journal);
    assert.equal(calls.filter(call => call.url.endsWith('/guest-sessions')).length, 1);
  }
});

test('native reads retain the server read-only flag and hide the payment link', async () => {
  const { data, storage } = memory();
  data.set(journalKey + '.guest', JSON.stringify(session));
  const { fetcher } = transport(() => Response.json({ ...order, recoveryReadOnly: true }));
  const observed = await createLiveApi({ config, storage, journalKey, fetcher, now }).getOrder(order.id);
  assert.equal(observed.recoveryReadOnly, true);
  assert.equal(observed.paymentAttempt?.checkoutUrl, null);
});

test('verified recovery of the expired tracked order promotes once and preserves the saved journal', async () => {
  const { data, storage } = memory();
  const oldJournal = JSON.stringify({
    version: 1, active: { phase: 'tracking', orderId: recoveryOrderId, key: 'old-attempt' }, orderIds: [recoveryOrderId],
  });
  data.set(journalKey, oldJournal);
  data.set(journalKey + '.guest', JSON.stringify(expiredGuest));
  const { calls, fetcher } = transport(call => {
    if (call.url.endsWith('/guest-sessions')) return Response.json(recoveryGuest, { status: 201 });
    assert.equal(call.token, 'Bearer ' + recoveryGuest.accessToken);
    if (call.url.endsWith('/order-access/challenges')) return Response.json({ challengeId: recoveryChallengeId }, { status: 202 });
    if (call.url.endsWith('/verify')) {
      return (call.body as { code: string }).code === '418263'
        ? Response.json({ orderId: recoveryOrderId }) : Response.json({}, { status: 404 });
    }
    assert.equal(call.url, config.apiBaseUrl + '/orders/' + recoveryOrderId);
    return Response.json(recoveredOrder);
  });
  const options = { config, storage, journalKey, fetcher, now };
  const first = createLiveApi(options);
  assert.deepEqual(await first.requestOrderAccess!(recoveryContact), { challengeId: recoveryChallengeId });
  assert.equal(data.get(journalKey + '.guest'), JSON.stringify(expiredGuest));
  await assert.rejects(() => first.verifyOrderAccess!(recoveryChallengeId, '000000'), { code: 'not_found' });
  assert.equal(data.get(journalKey + '.guest'), JSON.stringify(expiredGuest));
  await assert.rejects(() => first.getOrder(recoveryOrderId), { code: 'unauthenticated' });

  const restarted = createLiveApi(options);
  assert.deepEqual(await restarted.verifyOrderAccess!(recoveryChallengeId, '418263'), { orderId: recoveryOrderId });
  assert.deepEqual(JSON.parse(data.get(journalKey + '.guest')!), recoveryGuest);
  assert.equal((await restarted.getOrder(recoveryOrderId)).recoveryReadOnly, undefined);
  assert.equal(data.get(journalKey), oldJournal);
  assert.equal(calls.filter(call => call.url.endsWith('/guest-sessions')).length, 1);
  assert.doesNotMatch(JSON.stringify([...data.values()]), /700000000|418263/);
});

test('recovery stays read-only when the saved checkout cannot be transferred', async () => {
  for (const active of [
    { phase: 'creating', quoteId: 'pending-quote', key: 'pending-order', cartFingerprint: 'cart' },
    { phase: 'paying', orderId: recoveryOrderId, key: 'pending-payment' },
    { phase: 'tracking', orderId: recoveryOrderId, key: 'tracked-payment' },
    { phase: 'tracking', orderId: order.id, key: 'different-order' },
  ]) {
    const { data, storage } = memory();
    const oldJournal = JSON.stringify({ version: 1, active, orderIds: [order.id, recoveryOrderId] });
    const pending = { ...order, id: recoveryOrderId };
    data.set(journalKey, oldJournal);
    data.set(journalKey + '.guest', JSON.stringify(expiredGuest));
    const { calls, fetcher } = transport(call => {
      if (call.url.endsWith('/guest-sessions')) return Response.json(recoveryGuest, { status: 201 });
      assert.equal(call.token, 'Bearer ' + recoveryGuest.accessToken);
      if (call.url.endsWith('/order-access/challenges')) return Response.json({ challengeId: recoveryChallengeId }, { status: 202 });
      if (call.url.endsWith('/verify')) return Response.json({ orderId: recoveryOrderId });
      assert.equal(call.url, config.apiBaseUrl + '/orders/' + recoveryOrderId);
      assert.equal(call.method, 'GET');
      return Response.json(pending);
    });
    const options = { config, storage, journalKey, fetcher, now };
    const api = createLiveApi(options);
    await api.requestOrderAccess!(recoveryContact);
    assert.deepEqual(await api.verifyOrderAccess!(recoveryChallengeId, '418263'), { orderId: recoveryOrderId });
    assert.equal(data.get(journalKey + '.guest'), JSON.stringify(expiredGuest));
    assert.equal(data.get(journalKey), oldJournal);
    assert.equal((await createLiveApi(options).getOrder(recoveryOrderId)).recoveryReadOnly, true);
    const delivered = calls.length;
    await assert.rejects(() => api.getOrder(order.id), { code: 'unauthenticated' });
    await assert.rejects(() => api.recoverOrder!('pending-order'), { code: 'unauthenticated' });
    await assert.rejects(() => api.startPayment(recoveryOrderId, 'pending-payment'), { code: 'unauthenticated' });
    assert.equal(calls.length, delivered);
  }
});

for (const settledBeforeVerification of [true, false]) {
  test(`verified recovery resumes saved payment without a repeat after settlement ${settledBeforeVerification ? 'before' : 'after'} phone verification`, async () => {
    const { data, storage } = memory();
    const saved = JSON.stringify({
      version: 1,
      active: { phase: 'paying', orderId: recoveryOrderId, key: 'old-attempt' },
      orderIds: [recoveryOrderId],
    });
    data.set(journalKey, saved);
    data.set(journalKey + '.guest', JSON.stringify(expiredGuest));
    let settled = settledBeforeVerification;
    let allowGuestWrite = true;
    const storeValue = storage.setItem;
    storage.setItem = async (key, value) => {
      if (!allowGuestWrite && key === journalKey + '.guest') throw new Error('Guest storage unavailable');
      await storeValue(key, value);
    };
    const { calls, fetcher } = transport(call => {
      if (call.url.endsWith('/guest-sessions')) return Response.json(recoveryGuest, { status: 201 });
      assert.equal(call.token, 'Bearer ' + recoveryGuest.accessToken);
      if (call.url.endsWith('/order-access/challenges')) return Response.json({ challengeId: recoveryChallengeId }, { status: 202 });
      if (call.url.endsWith('/verify')) return Response.json({ orderId: recoveryOrderId });
      if (call.url.endsWith('/quotes')) return Response.json({
        quoteId: 'fresh-quote', storeId: config.storeId, slotId: order.slotId, lines: [cartLine],
        subtotal: order.total, tax: 0, total: order.total, currency: order.currency, expiresAt, changes: [],
        pickupStartsAt: order.pickupStartsAt, pickupEndsAt: order.pickupEndsAt,
      });
      assert.equal(call.url, config.apiBaseUrl + '/orders/' + recoveryOrderId);
      assert.equal(call.method, 'GET');
      return Response.json(settled ? recoveredOrder : { ...order, id: recoveryOrderId, status: 'cancelled' });
    });
    const options = { config, storage, journalKey, fetcher, now };
    const first = createLiveApi(options);
    await first.requestOrderAccess!(recoveryContact);
    assert.deepEqual(await first.verifyOrderAccess!(recoveryChallengeId, '418263'), { orderId: recoveryOrderId });
    const restarted = createLiveApi(options);
    if (!settledBeforeVerification) {
      assert.equal((await restarted.getOrder(recoveryOrderId)).recoveryReadOnly, true);
      assert.equal(data.get(journalKey + '.guest'), JSON.stringify(expiredGuest));
      settled = true;
      allowGuestWrite = false;
      const readOnly = await restarted.getOrder(recoveryOrderId);
      assert.equal(readOnly.paymentStatus, 'paid');
      assert.equal(readOnly.recoveryReadOnly, true);
      assert.equal(data.get(journalKey + '.guest'), JSON.stringify(expiredGuest));
      allowGuestWrite = true;
    } else {
      assert.equal(data.get(journalKey + '.guest'), JSON.stringify(recoveryGuest));
    }
    assert.equal((await restarted.getOrder(recoveryOrderId)).recoveryReadOnly, undefined);
    assert.equal(data.get(journalKey), saved);
    const controller = new CheckoutController({
      api: restarted, storage, storageKey: journalKey,
      newKey: () => assert.fail('Restoring a settled payment must not allocate a new attempt key'),
      onOrderCreated: async () => {},
    });
    assert.equal((await controller.resume()).paymentStatus, 'paid');
    assert.deepEqual(controller.snapshot.active, { phase: 'tracking', orderId: recoveryOrderId, key: 'old-attempt' });
    assert.equal((await restarted.createQuote({ storeId: config.storeId, slotId: order.slotId, lines: [cartLine] })).id, 'fresh-quote');
    assert.equal(calls.filter(call => call.url.endsWith('/guest-sessions')).length, 1);
    assert.equal(calls.filter(call => call.url.endsWith('/payments')).length, 0);
  });
}

test('promotion write failure allows verification to retry with the same provisional identity', async () => {
  const { data, storage } = memory();
  const oldJournal = JSON.stringify({ version: 1, active: null, orderIds: [recoveryOrderId] });
  data.set(journalKey, oldJournal);
  data.set(journalKey + '.guest', JSON.stringify(expiredGuest));
  let rejectMainWrite = true;
  const unreliableStorage: typeof storage = {
    getItem: storage.getItem,
    removeItem: storage.removeItem,
    async setItem(key, value) {
      if (key === journalKey + '.guest' && rejectMainWrite) throw new Error('fixture write failed');
      await storage.setItem(key, value);
    },
  };
  const { calls, fetcher } = transport(call => {
    if (call.url.endsWith('/guest-sessions')) return Response.json(recoveryGuest, { status: 201 });
    assert.equal(call.token, 'Bearer ' + recoveryGuest.accessToken);
    if (call.url.endsWith('/order-access/challenges')) return Response.json({ challengeId: recoveryChallengeId }, { status: 202 });
    assert.ok(call.url.endsWith('/verify'));
    return Response.json({ orderId: recoveryOrderId });
  });
  const api = createLiveApi({ config, storage: unreliableStorage, journalKey, fetcher, now });
  await api.requestOrderAccess!(recoveryContact);
  await assert.rejects(() => api.verifyOrderAccess!(recoveryChallengeId, '418263'), { code: 'storage_unavailable' });
  assert.equal(data.get(journalKey + '.guest'), JSON.stringify(expiredGuest));
  rejectMainWrite = false;
  assert.deepEqual(await api.verifyOrderAccess!(recoveryChallengeId, '418263'), { orderId: recoveryOrderId });
  assert.deepEqual(JSON.parse(data.get(journalKey + '.guest')!), recoveryGuest);
  assert.equal(data.get(journalKey), oldJournal);
  assert.equal(calls.filter(call => call.url.endsWith('/guest-sessions')).length, 1);
});

test('a newer primary identity stays active when a pending verified recovery can only be read', async () => {
  const { data, storage } = memory();
  const newer = { ...session, refreshToken: 'newer-guest_' + 'z'.repeat(40) };
  const oldJournal = JSON.stringify({
    version: 1, active: { phase: 'tracking', orderId: recoveryOrderId, key: 'paid' }, orderIds: [recoveryOrderId],
  });
  data.set(journalKey, oldJournal);
  data.set(journalKey + '.guest', JSON.stringify(expiredGuest));
  const { fetcher } = transport(call => {
    if (call.url.endsWith('/guest-sessions')) return Response.json(recoveryGuest, { status: 201 });
    if (call.url.endsWith('/order-access/challenges')) return Response.json({ challengeId: recoveryChallengeId }, { status: 202 });
    if (call.url.endsWith('/verify')) return Response.json({ orderId: recoveryOrderId });
    assert.equal(call.url, config.apiBaseUrl + '/orders/' + recoveryOrderId);
    if (call.token === 'Bearer ' + newer.accessToken) return Response.json({}, { status: 404 });
    data.set(journalKey + '.guest', JSON.stringify(newer));
    return Response.json(recoveredOrder);
  });
  const api = createLiveApi({ config, storage, journalKey, fetcher, now });
  await api.requestOrderAccess!(recoveryContact);
  assert.deepEqual(await api.verifyOrderAccess!(recoveryChallengeId, '418263'), { orderId: recoveryOrderId });
  assert.deepEqual(JSON.parse(data.get(journalKey + '.guest')!), newer);
  assert.equal((await api.getOrder(recoveryOrderId)).recoveryReadOnly, true);
  assert.equal(data.get(journalKey), oldJournal);
});

test('a delayed unauthorized payment response is not replayed with the promoted guest', async () => {
  const { data, storage } = memory();
  data.set(journalKey, JSON.stringify({ version: 1, active: null, orderIds: [recoveryOrderId] }));
  data.set(journalKey + '.guest', JSON.stringify(session));
  const sent = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const { calls, fetcher } = transport(call => {
    if (call.url.endsWith('/payments')) {
      assert.equal(call.token, 'Bearer ' + accessToken);
      sent.resolve();
      return response.promise;
    }
    if (call.url.endsWith('/guest-sessions/refresh')) return Response.json({}, { status: 401 });
    if (call.url.endsWith('/guest-sessions')) return Response.json(recoveryGuest, { status: 201 });
    if (call.url.endsWith('/order-access/challenges')) {
      if (call.token === 'Bearer ' + accessToken) return Response.json({}, { status: 401 });
      assert.equal(call.token, 'Bearer ' + recoveryGuest.accessToken);
      return Response.json({ challengeId: recoveryChallengeId }, { status: 202 });
    }
    assert.equal(call.token, 'Bearer ' + recoveryGuest.accessToken);
    assert.ok(call.url.endsWith('/verify'));
    return Response.json({ orderId: recoveryOrderId });
  });
  const api = createLiveApi({ config, storage, journalKey, fetcher, now });
  const payment = assert.rejects(() => api.startPayment(recoveryOrderId, 'old-payment-key'), { code: 'unauthenticated' });
  await sent.promise;
  await api.requestOrderAccess!(recoveryContact);
  await api.verifyOrderAccess!(recoveryChallengeId, '418263');
  response.resolve(Response.json({}, { status: 401 }));
  await payment;
  assert.deepEqual(calls.filter(call => call.url.endsWith('/payments')).map(call => call.key), ['old-payment-key']);
});

test('phone recovery does not refresh or replace a guest when access is forbidden', async () => {
  const { data, storage } = memory();
  data.set(journalKey + '.guest', JSON.stringify(session));
  const { calls, fetcher } = transport(call => {
    assert.ok(call.url.endsWith('/order-access/challenges'));
    return Response.json({}, { status: 403 });
  });
  const api = createLiveApi({ config, storage, journalKey, fetcher, now });
  await assert.rejects(() => api.requestOrderAccess!(recoveryContact), { code: 'unauthenticated' });
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(data.get(journalKey + '.guest')!), session);
  assert.equal(data.has(journalKey + '.recovery-guest'), false);
});

test('invalid challenge and grant identifiers do not pass wire validation', async () => {
  const { storage } = memory();
  const { fetcher } = transport(call => call.url.endsWith('/guest-sessions')
    ? Response.json(session) : Response.json({ challengeId: 'unknown', orderId: 'not-a-uuid' }));
  const api = createLiveApi({ config, storage, journalKey, fetcher, now });

  await assert.rejects(() => api.requestOrderAccess!({ orderCode: '502A8EF1', phone: '+250700000000' }), { code: 'invalid_response' });
  await assert.rejects(() => api.verifyOrderAccess!('85e9eb23-9b52-4905-8c81-7d347d746db9', '418263'), { code: 'invalid_response' });
});

test('checkout links and receipts permit only the configured secure destinations', async () => {
  const { storage } = memory();
  let checkoutUrl = 'https://checkout.example.test.payments-other.test/pay';
  const { fetcher } = transport(call => call.url.endsWith('/guest-sessions')
    ? Response.json(session) : Response.json({
      ...order,
      receiptUrl: 'https://external.test/not-an-owned-receipt',
      paymentAttempt: { ...order.paymentAttempt, checkoutUrl },
    }));
  const api = createLiveApi({ config, storage, journalKey, fetcher, now });
  for (const url of [
    checkoutUrl, 'http://checkout.example.test/pay', 'https://checkout.example.test:444/pay',
    'https://buyer@checkout.example.test/pay', 'https://checkout.example.test\\pay',
  ]) {
    checkoutUrl = url;
    const result = await api.getOrder(order.id);
    assert.equal(result.paymentAttempt?.checkoutUrl, null);
    assert.equal(result.receiptUrl, null);
  }
  checkoutUrl = 'https://checkout.example.test/pay';
  assert.equal((await api.getOrder(order.id)).paymentAttempt?.checkoutUrl, checkoutUrl);
});

const receiptOrderId = '1cf5ba6e-0584-45b5-bbc5-3a5ec90502c9';
const authorizedReceiptPath = '/api/v1/orders/' + receiptOrderId + '/receipt';
const receiptFixture = new TextEncoder().encode('%PDF-1.4\n% test receipt\n%%EOF\n');

test('a receipt indicator accepts only the exact relative path for the issued order', async () => {
  const { storage } = memory();
  let receiptUrl = authorizedReceiptPath;
  let receiptStatus = 'issued';
  const { fetcher } = transport(call => call.url.endsWith('/guest-sessions') ? Response.json(session)
    : Response.json({ ...order, id: receiptOrderId, receiptStatus, receiptUrl }));
  const api = createLiveApi({ config, storage, journalKey, fetcher, now });
  assert.equal((await api.getOrder(receiptOrderId)).receiptUrl, authorizedReceiptPath);

  for (const path of [authorizedReceiptPath + '?source=receipt', '/api/v1/orders/' + order.id + '/receipt', config.apiBaseUrl + '/orders/' + receiptOrderId + '/receipt']) {
    receiptUrl = path;
    assert.equal((await api.getOrder(receiptOrderId)).receiptUrl, null);
  }
  receiptStatus = 'pending';
  receiptUrl = authorizedReceiptPath;
  assert.equal((await api.getOrder(receiptOrderId)).receiptUrl, null);
});

test('the customer receipt uses an authenticated fixed GET without putting credentials in the URL', async () => {
  const { storage, data } = memory();
  const { calls, fetcher } = transport(call => call.url.endsWith('/guest-sessions') ? Response.json(session)
    : new Response(receiptFixture, { headers: { 'Content-Type': PDF_MIME_TYPE, 'Content-Length': String(receiptFixture.length) } }));
  const api = createLiveApi({ config, storage, journalKey, fetcher, now });
  await assert.rejects(() => api.getReceiptPdf!('malformed-order-id'), { code: 'invalid_input' });
  assert.equal(calls.length, 0);
  assert.deepEqual(await api.getReceiptPdf!(receiptOrderId), receiptFixture);
  const request = calls.at(-1);
  assert.equal(request?.url, new URL(authorizedReceiptPath, config.apiBaseUrl).href);
  assert.equal(request?.method, 'GET');
  assert.equal(request?.token, 'Bearer ' + accessToken);
  assert.match(request?.accept ?? '', /^application\/pdf/);
  assert.equal(request?.body, undefined);
  assert.doesNotMatch(JSON.stringify([...data.values()]), /%PDF|test receipt/);
});

test('native order and receipt failures expose only a valid ID from the expected API response', async () => {
  const { data, storage } = memory();
  data.set(journalKey + '.guest', JSON.stringify(session));
  const requestId = 'ba8b8f93-4a07-4711-82d6-189a3cfe5747';
  const spoofedId = '45f49818-3083-480e-89ce-0352cae33337';
  const cases = [
    { status: 500, header: requestId, expected: requestId, code: 'service_unavailable' },
    { status: 503, header: requestId, expected: requestId, code: 'service_unavailable', receipt: true },
    { status: 503, code: 'service_unavailable' },
    { status: 503, header: requestId.toUpperCase(), code: 'service_unavailable' },
    { status: 503, header: `${requestId}, ${spoofedId}`, code: 'service_unavailable' },
    { status: 503, header: 'arbitrary error content', code: 'service_unavailable', receipt: true },
    { status: 429, header: requestId, code: 'rate_limited' },
    { status: 503, header: requestId, code: 'invalid_response', redirected: true },
    { status: 503, header: requestId, code: 'invalid_response', url: config.apiBaseUrl + '/different' },
    { status: 503, header: requestId, code: 'service_unavailable', url: '' },
  ];
  for (const scenario of cases) {
    const { fetcher } = transport(call => {
      const expectedUrl = config.apiBaseUrl + `/orders/${receiptOrderId}` + (scenario.receipt ? '/receipt' : '');
      assert.equal(call.url, expectedUrl);
      assert.equal(call.token, 'Bearer ' + accessToken);
      const body = scenario.receipt ? null : JSON.stringify({ code: 'unavailable', requestId: spoofedId });
      const headers = scenario.header ? { 'X-Request-ID': scenario.header } : undefined;
      const response = new Response(body, { status: scenario.status, headers });
      Object.defineProperties(response, {
        url: { value: scenario.url ?? expectedUrl },
        redirected: { value: scenario.redirected ?? false },
      });
      return response;
    });
    const api = createLiveApi({ config, storage, journalKey, fetcher, now });
    await assert.rejects(
      () => scenario.receipt ? api.getReceiptPdf!(receiptOrderId) : api.getOrder(receiptOrderId),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, scenario.code);
        assert.equal(error.requestId, scenario.expected);
        return true;
      },
    );
  }
  assert.deepEqual([...data.entries()], [[journalKey + '.guest', JSON.stringify(session)]]);
});

test('the receipt reader rejects unexpected media, partial content, truncation and oversized streams', async () => {
  const { storage } = memory();
  let response = () => new Response(receiptFixture, { headers: { 'Content-Type': PDF_MIME_TYPE } });
  const { fetcher } = transport(call => call.url.endsWith('/guest-sessions') ? Response.json(session) : response());
  const api = createLiveApi({ config, storage, journalKey, fetcher, now });
  const pdfHeaders = { 'Content-Type': PDF_MIME_TYPE };

  const rejectPdf = () => assert.rejects(() => api.getReceiptPdf!(receiptOrderId), { code: 'invalid_response' });
  response = () => new Response(receiptFixture, { headers: { 'Content-Type': 'text/html' } });
  await rejectPdf();
  response = () => new Response(receiptFixture, { status: 206, headers: pdfHeaders });
  await rejectPdf();
  response = () => new Response('%PDF-1.4\nTruncated receipt', { headers: pdfHeaders });
  await rejectPdf();
  response = () => new Response(receiptFixture, { headers: { ...pdfHeaders, 'Content-Length': String(receiptFixture.length + 1) } });
  await rejectPdf();
  response = () => new Response(receiptFixture, { headers: { ...pdfHeaders, 'Content-Length': String(MAX_RECEIPT_BYTES + 1) } });
  await rejectPdf();
  response = () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_RECEIPT_BYTES));
      controller.enqueue(new Uint8Array(1));
      controller.close();
    },
  }), { headers: pdfHeaders });
  await rejectPdf();
  response = () => new Response('missing receipt', { status: 404 });
  await assert.rejects(() => api.getReceiptPdf!(receiptOrderId), { code: 'not_found' });
});

test('server quote with changed money, currency or store fails closed', async () => {
  const { storage } = memory();
  let currency = 'RWF';
  let total = 9200;
  let storeId = 'kigali';
  const { fetcher } = transport(call => call.url.endsWith('/guest-sessions')
    ? Response.json(session) : Response.json({
      quoteId: 'q-1', storeId, slotId: 'lunch', lines: [cartLine],
      subtotal: 8100, tax: 1100, total, currency, expiresAt, changes: [],
      pickupStartsAt: order.pickupStartsAt, pickupEndsAt: order.pickupEndsAt,
    }));
  const api = createLiveApi({ config, storage, journalKey, fetcher, now });
  const input = { storeId: config.storeId, slotId: 'lunch', lines: [cartLine] };
  assert.equal((await api.createQuote(input)).id, 'q-1');
  total = 9199;
  await assert.rejects(() => api.createQuote(input), { code: 'invalid_response' });
  total = 9200;
  currency = 'USD';
  await assert.rejects(() => api.createQuote(input), { code: 'invalid_response' });
  currency = 'RWF';
  storeId = 'another-store';
  await assert.rejects(() => api.createQuote(input), { code: 'invalid_response' });
});

test('refresh keeps the old guest and retries an unauthorized write with its original idempotency key', async () => {
  const { storage } = memory();
  const renewed = { ...session, accessToken: 'renewed_' + 'c'.repeat(40) };
  const { fetcher, calls } = transport(call => {
    if (call.url.endsWith('/guest-sessions')) return Response.json(session, { status: 201 });
    if (call.url.endsWith('/guest-sessions/refresh')) {
      assert.deepEqual(call.body, { refreshToken });
      assert.equal(call.token, null);
      return Response.json(renewed);
    }
    if (call.token === 'Bearer ' + accessToken) return Response.json({}, { status: 401 });
    assert.equal(call.token, 'Bearer ' + renewed.accessToken);
    return Response.json(order);
  });
  const api = createLiveApi({ config, storage, journalKey, fetcher, now });
  const contact = { quoteId: 'q-1', phone: '+250700000000', email: 'buyer@example.test' };
  assert.equal((await api.createOrder(contact, 'same-key')).id, order.id);
  assert.deepEqual(calls.filter(call => call.url.endsWith('/orders')).map(call => call.key), ['same-key', 'same-key']);
  assert.equal(JSON.parse((await storage.getItem(journalKey + '.guest')) ?? '{}').accessToken, renewed.accessToken);
});

const sessionKey = journalKey + '.guest';
const rotationId = '3924cf26-6df1-4b2a-8f24-2ea91f0cf94d';
const rotatable = { ...session, sessionId: '1de47e8f-b6a9-457e-aa68-3c79463d12f5' };
const rotated = { ...rotatable, accessToken: 'updated_' + 'c'.repeat(40), refreshToken: 'successor_' + 'd'.repeat(40) };

test('concurrent 401s during a saved guest lookup share one credential rotation', { timeout: 5_000 }, async () => {
  const { storage, data } = memory();
  data.set(sessionKey, JSON.stringify(rotatable));
  const initialRequestsSent = Promise.withResolvers<void>();
  const rejectOldRequests = Promise.withResolvers<void>();
  const lookupStarted = Promise.withResolvers<void>();
  const releaseLookup = Promise.withResolvers<void>();
  const read = storage.getItem;
  let pauseNextLookup = false;
  storage.getItem = async (key) => {
    if (key === sessionKey && pauseNextLookup) {
      pauseNextLookup = false;
      lookupStarted.resolve();
      await releaseLookup.promise;
    }
    return read(key);
  };

  let oldTokenRequests = 0;
  const { calls, fetcher } = transport(async call => {
    if (call.url.endsWith('/guest-sessions/refresh')) {
      assert.deepEqual(call.body, { refreshToken, rotationKey: rotationId });
      return Response.json(rotated);
    }
    assert.equal(call.url, config.apiBaseUrl + '/orders/' + order.id);
    if (call.token === 'Bearer ' + accessToken) {
      if (++oldTokenRequests === 2) initialRequestsSent.resolve();
      await rejectOldRequests.promise;
      return new Response(null, { status: 401 });
    }
    assert.equal(call.token, 'Bearer ' + rotated.accessToken);
    return Response.json(order);
  });
  const api = createLiveApi({ config, storage, journalKey, fetcher, now, newRotationKey: () => rotationId });
  const first = api.getOrder(order.id);
  const second = api.getOrder(order.id);
  await initialRequestsSent.promise;
  pauseNextLookup = true;
  const pending = Promise.all([first, second, api.getOrder(order.id)]);
  await lookupStarted.promise;
  rejectOldRequests.resolve();
  // Drain the 401 continuations while the ordinary storage read is still blocked.
  await new Promise<void>(resolve => setImmediate(resolve));
  releaseLookup.resolve();

  assert.deepEqual((await pending).map(result => result.id), [order.id, order.id, order.id]);
  assert.equal(calls.filter(call => call.url.endsWith('/guest-sessions/refresh')).length, 1);
  assert.equal(oldTokenRequests, 3);
  assert.deepEqual(JSON.parse(data.get(sessionKey)!), rotated);
});

test('a refresh response with the rejected bearer leaves the saved rotation retryable', async () => {
  const { storage, data } = memory();
  data.set(sessionKey, JSON.stringify(rotatable));
  const { calls, fetcher } = transport(call => {
    if (call.url.endsWith('/guest-sessions/refresh')) return Response.json({ ...rotated, accessToken });
    assert.equal(call.url, config.apiBaseUrl + '/orders/' + order.id);
    assert.equal(call.token, 'Bearer ' + accessToken);
    return new Response(null, { status: 401 });
  });
  const api = createLiveApi({ config, storage, journalKey, fetcher, now, newRotationKey: () => rotationId });

  await assert.rejects(api.getOrder(order.id), { code: 'invalid_response' });
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(data.get(sessionKey)!), { ...rotatable, rotationKey: rotationId });
});

for (const failure of ['network', 'storage'] as const) {
  test(`rotating refresh survives a lost ${failure} reply with the saved rotation key and same order`, async () => {
    const { storage, data } = memory();
    const stored = { ...rotatable, expiresAt: '2026-11-25T09:55:00Z' };
    data.set(sessionKey, JSON.stringify(stored));
    let first = true;
    const set = storage.setItem;
    storage.setItem = async (key, value) => {
      if (failure === 'storage' && first && key === sessionKey && JSON.parse(value).refreshToken === rotated.refreshToken) {
        first = false;
        throw new Error('fixture final save failed');
      }
      await set(key, value);
    };
    const { calls, fetcher } = transport(call => {
      if (call.url.endsWith('/guest-sessions/refresh')) {
        assert.deepEqual(call.body, { refreshToken, rotationKey: rotationId });
        assert.deepEqual(JSON.parse(data.get(sessionKey)!), { ...stored, rotationKey: rotationId });
        if (failure === 'network' && first) {
          first = false;
          throw new Error('fixture reply lost');
        }
        return Response.json(rotated);
      }
      assert.ok(call.url.endsWith('/orders/' + order.id));
      assert.equal(call.token, 'Bearer ' + rotated.accessToken);
      return Response.json(order);
    });
    const options = { config, storage, journalKey, fetcher, now };
    await assert.rejects(createLiveApi({ ...options, newRotationKey: () => rotationId }).getOrder(order.id),
      { code: failure === 'network' ? 'network_unavailable' : 'storage_unavailable' });
    const reopened = createLiveApi({ ...options, newRotationKey: () => assert.fail('must reuse the persisted rotation key') });
    assert.equal((await reopened.getOrder(order.id)).id, order.id);
    assert.deepEqual(JSON.parse(data.get(sessionKey)!), rotated);
    assert.equal(calls.filter(call => call.url.endsWith('/guest-sessions/refresh')).length, 2);
  });
}

test('phone verification stays bound to the guest identity across normal credential rotation', async () => {
  const { data, storage } = memory();
  data.set(sessionKey, JSON.stringify(rotatable));
  let time = now();
  const { fetcher } = transport(call => {
    if (call.url.endsWith('/order-access/challenges')) {
      assert.equal(call.token, 'Bearer ' + accessToken);
      return Response.json({ challengeId: recoveryChallengeId });
    }
    if (call.url.endsWith('/guest-sessions/refresh')) {
      assert.deepEqual(call.body, { refreshToken, rotationKey: rotationId });
      return Response.json({ ...rotated, expiresAt: '2026-11-29T10:00:00Z' });
    }
    assert.ok(call.url.endsWith('/verify'));
    assert.equal(call.token, 'Bearer ' + rotated.accessToken);
    return Response.json({ orderId: recoveryOrderId });
  });
  const api = createLiveApi({ config, storage, journalKey, fetcher, now: () => time, newRotationKey: () => rotationId });
  const challenge = await api.requestOrderAccess!(recoveryContact);
  time = Date.parse('2026-11-27T10:00:00Z');
  assert.equal((await api.verifyOrderAccess!(challenge.challengeId, '418263')).orderId, recoveryOrderId);
});

test('privacy reads and bodyless erasure PUT use the verified native bearer without storing private response data', async () => {
  const { storage, data } = memory();
  data.set(journalKey + '.guest', JSON.stringify(rotatable));
  const { fetcher, calls } = transport(call => {
    assert.equal(call.token, 'Bearer ' + rotatable.accessToken);
    if (call.url.endsWith('/order-access/challenges')) return Response.json({ challengeId: recoveryChallengeId });
    if (call.url.endsWith('/verify')) return Response.json({ orderId: recoveryOrderId });
    assert.equal(call.body, undefined);
    assert.equal(call.key, null);
    if (call.url.endsWith('/data-export')) {
      assert.equal(call.method, 'GET');
      return Response.json(privacyExport);
    }
    assert.equal(call.url, config.apiBaseUrl + `/orders/${recoveryOrderId}/erasure-request`);
    return Response.json(call.method === 'PUT' ? erasure : { request: null });
  });
  const options = { config, storage, journalKey, fetcher, now };
  const api = createLiveApi(options);
  await api.requestOrderAccess!(recoveryContact);
  await api.verifyOrderAccess!(recoveryChallengeId, '418263');
  assert.deepEqual(await api.getOrderDataExport!(recoveryOrderId), privacyExport);
  assert.deepEqual(await api.getOrderErasureRequest!(recoveryOrderId), { request: null });
  assert.deepEqual(await api.requestOrderErasure!(recoveryOrderId), erasure);
  assert.deepEqual(await createLiveApi(options).getOrderDataExport!(recoveryOrderId), privacyExport);
  assert.doesNotMatch(JSON.stringify([...data.values()]), /export-fixture|700000000|9afe0a38|418263/);

  data.set(journalKey + '.guest', JSON.stringify(recoveryGuest));
  const previousCalls = calls.length;
  await assert.rejects(api.requestOrderErasure!(recoveryOrderId), { code: 'unauthenticated' });
  assert.equal(calls.length, previousCalls);
});

test('stored native recovery grants take precedence over an unverified primary and do not switch on a 404', async () => {
  const { storage, data } = memory();
  data.set(journalKey + '.guest', JSON.stringify(rotatable));
  data.set(journalKey + '.recovery-guest', JSON.stringify({ guest: recoveryGuest, previous: rotatable.sessionId,
    challengeId: recoveryChallengeId, grants: [recoveryOrderId] }));
  const { fetcher, calls } = transport(call => {
    assert.equal(call.url, config.apiBaseUrl + `/orders/${recoveryOrderId}/data-export`);
    assert.equal(call.token, 'Bearer ' + recoveryGuest.accessToken);
    return calls.length === 1 ? Response.json({ ...privacyExport, email: null }) : new Response(null, { status: 404 });
  });
  const api = createLiveApi({ config, storage, journalKey, fetcher, now });
  assert.equal((await api.getOrderDataExport!(recoveryOrderId)).email, null);
  await assert.rejects(api.getOrderDataExport!(recoveryOrderId), { code: 'not_found' });
  assert.equal(calls.length, 2);
});

test('native privacy endpoints reject wrong-order exports and do not create a new identity', async () => {
  const { storage, data } = memory();
  const { fetcher, calls } = transport(() => Response.json({ ...privacyExport, orderId: pickupOrderId }));
  const api = createLiveApi({ config, storage, journalKey, fetcher, now });
  await assert.rejects(api.getOrderDataExport!(recoveryOrderId), { code: 'unauthenticated' });
  assert.equal(calls.length, 0);
  data.set(journalKey + '.guest', JSON.stringify(rotatable));
  await assert.rejects(api.getOrderDataExport!(recoveryOrderId), { code: 'invalid_response' });
  await assert.rejects(api.requestOrderErasure!('../../orders'), { code: 'invalid_input' });
  assert.equal(calls.length, 1);
});

test('logout retries a lost response, revokes both guests and clears only private checkout state', async () => {
  const { data, storage } = memory();
  data.set(sessionKey, JSON.stringify({ ...rotatable, rotationKey: rotationId }));
  data.set(journalKey + '.recovery-guest', JSON.stringify({
    guest: recoveryGuest, previous: rotatable.sessionId, challengeId: recoveryChallengeId, grants: [recoveryOrderId],
  }));
  data.set(journalKey + '.installation', installationId);
  data.set(journalKey, JSON.stringify({ version: 1, active: null, orderIds: [recoveryOrderId] }));
  data.set('catalog-cache', 'keep');
  const { calls, fetcher } = transport(call => {
    assert.ok(call.url.endsWith('/guest-sessions/revoke'));
    assert.ok(data.get(journalKey + '.end-guest'));
    if (call.body && Reflect.get(call.body as object, 'refreshToken') === refreshToken && calls.length === 1) {
      assert.deepEqual(call.body, { refreshToken, rotationKey: rotationId });
      throw new Error('fixture revoke reply lost');
    }
    return new Response(null, { status: 204 });
  });
  const options = { config, storage, journalKey, fetcher, now };
  await assert.rejects(createLiveApi(options).endGuestSession(), { code: 'network_unavailable' });
  const reopened = createLiveApi(options);
  assert.equal(await reopened.hasGuestSessionEndPending(), true);
  await assert.rejects(reopened.getOrder(order.id), { code: 'unauthenticated' });
  assert.equal(calls.length, 1);
  await reopened.endGuestSession();
  assert.equal(await reopened.hasGuestSessionEndPending(), false);
  assert.deepEqual(calls.map(call => call.body), [
    { refreshToken, rotationKey: rotationId }, { refreshToken, rotationKey: rotationId }, { refreshToken: recoveryGuest.refreshToken },
  ]);
  assert.deepEqual([...data], [['catalog-cache', 'keep']]);
});

test('logout drains authenticated work and suppresses a stale order response', async () => {
  const { data, storage } = memory();
  data.set(sessionKey, JSON.stringify(rotatable));
  const started = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<Response>();
  const { calls, fetcher } = transport(call => {
    if (call.url.endsWith('/guest-sessions/revoke')) return new Response(null, { status: 204 });
    started.resolve();
    return reply.promise;
  });
  const api = createLiveApi({ config, storage, journalKey, fetcher, now });
  const previous = assert.rejects(api.getOrder(order.id), { code: 'unauthenticated' });
  await started.promise;
  const ended = api.endGuestSession();
  await assert.rejects(api.getOrder(order.id), { code: 'unauthenticated' });
  assert.equal(calls.length, 1);
  reply.resolve(Response.json(order));
  await Promise.all([ended, previous]);
  assert.deepEqual(calls[1]?.body, { refreshToken });
  assert.equal(data.has(sessionKey), false);
});

test('logout does not start order verification that was still queued', async () => {
  const { data, storage } = memory();
  data.set(sessionKey, JSON.stringify(rotatable));
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<Response>();
  const { calls, fetcher } = transport(call => {
    if (call.url.endsWith('/guest-sessions/revoke')) return new Response(null, { status: 204 });
    assert.ok(call.url.endsWith('/order-access/challenges'));
    started.resolve();
    return response.promise;
  });
  const api = createLiveApi({ config, storage, journalKey, fetcher, now });
  const challenge = assert.rejects(api.requestOrderAccess!(recoveryContact), { code: 'unauthenticated' });
  await started.promise;
  const queued = assert.rejects(api.verifyOrderAccess!(recoveryChallengeId, '418263'), { code: 'unauthenticated' });
  const ending = api.endGuestSession();
  response.resolve(Response.json({ challengeId: recoveryChallengeId }));
  await Promise.all([challenge, queued, ending]);
  assert.equal(calls.length, 2);
  assert.ok(calls[1]?.url.endsWith('/guest-sessions/revoke'));
});

test('only the local profile can call the integration payment endpoint', () => {
  const { storage } = memory();
  for (const profile of ['stage', 'production'] as const) {
    assert.equal(createLiveApi({ config: { ...config, profile }, storage, journalKey }).settleLocalTestPayment, undefined);
  }
  assert.equal(typeof createLiveApi({ config: { ...config, profile: 'local' }, storage, journalKey }).settleLocalTestPayment, 'function');
});
