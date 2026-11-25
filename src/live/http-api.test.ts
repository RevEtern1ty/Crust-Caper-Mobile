import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Storage } from '../domain/types';
import { createLiveApi, type ConnectedConfig } from './http-api';

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

type Call = { url: string; method?: string; key: string | null; token: string | null; body: unknown };
function transport(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const call = {
      url: String(input),
      method: init?.method,
      key: headers.get('Idempotency-Key'),
      token: headers.get('Authorization'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.credentials, 'omit');
    calls.push(call);
    return handler(call);
  };
  return { calls, fetcher };
}

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
        async json() { assert.fail('Redirected response bodies must not be read'); },
      };
    },
  });
  await assert.rejects(() => api.getMenu(), { code: 'invalid_response' });
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
