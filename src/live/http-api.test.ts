import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CheckoutController } from '../checkout/controller';
import type { Storage } from '../domain/types';
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
  const storage: Storage = {
    async getItem(key) { return data.get(key) ?? null; },
    async setItem(key, value) { data.set(key, value); },
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
  const { fetcher } = transport(call => /\/guest-sessions(?:\/refresh)?$/.test(call.url)
    ? Response.json(session) : Response.json({ code: 'not_found' }, { status }));
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
const expiredGuest = {
  ...session, expiresAt: '2026-11-25T09:00:00Z', refreshExpiresAt: '2026-11-25T09:30:00Z',
};
const recoveryGuest = {
  ...session, accessToken: 'replacement_' + 'c'.repeat(40), refreshToken: 'replacement_refresh_' + 'd'.repeat(40),
};
const recoveredOrder = {
  ...order, id: recoveryOrderId, status: 'collected', paymentStatus: 'paid', paymentAttempt: null,
};

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
  const unreliableStorage: Storage = {
    getItem: storage.getItem,
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

test('only the local profile can call the integration payment endpoint', () => {
  const { storage } = memory();
  for (const profile of ['stage', 'production'] as const) {
    assert.equal(createLiveApi({ config: { ...config, profile }, storage, journalKey }).settleLocalTestPayment, undefined);
  }
  assert.equal(typeof createLiveApi({ config: { ...config, profile: 'local' }, storage, journalKey }).settleLocalTestPayment, 'function');
});
