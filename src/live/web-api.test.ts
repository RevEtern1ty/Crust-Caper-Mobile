import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWebLiveApi } from './web-api';

const config = {
  profile: 'stage' as const,
  apiBaseUrl: 'https://crustcaper.example.test/api/v1',
  storeId: 'kigali',
  pspHosts: ['checkout.example.test'],
};
const journalKey = 'checkout.stage.web';
const first = 'c0f2ed22-0d67-485f-8ae6-0b93f95fe62a';
const second = '147c16a6-12a9-4c9f-9e3f-c689dfaeb95f';
const orderId = 'ab83bbb6-fd3c-4fad-99c7-4538319add23';
const unknownOrderId = 'ba24282f-9505-46d1-a957-a53461417f66';
const challengeId = 'aa123f64-53d3-4f27-ae2f-503232860861';
const sessionPath = '/web/session';
const expiresAt = '2026-11-26T10:00:00Z';
const lines = [{ sku: 'double-smash', quantity: 1, unitPrice: 9200, modifierIds: [] }];
const quoteInput = { storeId: 'kigali', slotId: 'lunch', lines };
const quote = {
  ...quoteInput, quoteId: 'quote-1', subtotal: 9200, tax: 0, total: 9200, currency: 'RWF', expiresAt, changes: [],
  pickupStartsAt: '2026-11-26T10:15:00Z', pickupEndsAt: '2026-11-26T10:25:00Z',
};
const attempt = { id: 'attempt-1', status: 'processing', checkoutUrl: 'https://checkout.example.test/pay/one' };
const order = {
  ...quote, id: orderId, paymentStatus: 'processing', status: 'awaiting_payment',
  pickupCode: null, receiptStatus: 'pending', receiptUrl: null, paymentAttempt: attempt,
  createdAt: '2026-11-26T09:00:00Z', reservationExpiresAt: '2026-11-26T09:10:00Z',
};
const pendingJournal = JSON.stringify({
  version: 1, active: { phase: 'paying', orderId, key: 'pay-key' }, orderIds: [orderId],
});

function memory(entries: [string, string][] = []) {
  const saved = new Map(entries);
  const storage = {
    async getItem(key: string) { return saved.get(key) ?? null; },
    async setItem(key: string, value: string) { saved.set(key, value); },
    async removeItem(key: string) { saved.delete(key); },
  };
  return { saved, storage };
}

type Call = { path: string; method: string; context: string | null; key: string | null; body: unknown };
function fixture(active: string | null = null, handler?: (call: Call) => Response) {
  let cookie = active;
  let acceptCookies = true;
  const calls: Call[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname.slice('/api/v1'.length) + url.search;
    const headers = new Headers(init?.headers);
    const method = init?.method ?? 'GET';
    const privatePath = path.startsWith('/web/');
    assert.equal(url.origin, new URL(config.apiBaseUrl).origin);
    assert.equal(headers.get('authorization'), null);
    assert.equal(headers.get('cookie'), null);
    assert.equal(headers.get('x-crustcaper-web'), privatePath && method !== 'GET' ? '1' : null);
    assert.equal(init?.credentials, privatePath ? 'same-origin' : 'omit');
    assert.equal(init?.mode, privatePath ? 'same-origin' : 'cors');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.cache, 'no-store');
    const call = {
      path, method, context: headers.get('x-crustcaper-session'), key: headers.get('idempotency-key'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    if (path === sessionPath) {
      if (method === 'GET') return cookie ? Response.json({ sessionId: cookie, expiresAt }) : new Response(null, { status: 401 });
      if (method === 'DELETE') {
        if (cookie !== call.context) return new Response(null, { status: 401 });
        cookie = null;
        return new Response(null, { status: 204 });
      }
      assert.equal(call.body, undefined);
      assert.equal(call.context, null);
      const sessionId = cookie ?? first;
      if (acceptCookies) cookie = sessionId;
      return Response.json({ sessionId, expiresAt });
    }
    if (privatePath && (!call.context || call.context !== cookie)) return new Response(null, { status: 401 });
    if (path === '/web/quotes') return Response.json(call.context === second ? { ...quote, quoteId: 'quote-2' } : quote);
    return handler?.(call) ?? new Response(null, { status: 404 });
  };
  return {
    calls, fetcher,
    setCookie: (context: string | null) => { cookie = context; },
    denyCookies: () => { acceptCookies = false; },
  };
}

const browser = { available: () => true, locks: () => navigator.locks };

test('first quotes in independent tabs attach the same confirmed cookie and save only tab context metadata', async () => {
  const transport = fixture();
  const tabs = [memory(), memory()];
  const apis = tabs.map(({ storage }) => createWebLiveApi({ config, storage, journalKey, browser, fetcher: transport.fetcher }));
  assert.deepEqual(await Promise.all(apis.map(api => api.createQuote(quoteInput))).then(quotes => quotes.map(item => item.id)),
    ['quote-1', 'quote-1']);
  assert.equal(transport.calls.filter(call => call.path === sessionPath && call.method === 'POST').length, 1);
  assert.deepEqual(transport.calls.filter(call => call.path === '/web/quotes').map(call => call.context), [first, first]);
  for (const { saved } of tabs) {
    assert.deepEqual([...saved.entries()], [
      [journalKey + '.context', first], [journalKey + '.quote', JSON.stringify({ quoteId: 'quote-1', sessionId: first })],
    ]);
  }
});

test('pending journal and denied cookies block guest startup and checkout calls', async () => {
  const transport = fixture();
  const { storage, saved } = memory([[journalKey, pendingJournal]]);
  const api = createWebLiveApi({ config, storage, journalKey, browser, fetcher: transport.fetcher });
  await assert.rejects(api.createQuote(quoteInput), { code: 'unauthenticated' });
  await assert.rejects(api.createOrder({ quoteId: 'quote-1', phone: '+250780000001' }, 'order-key'), { code: 'unauthenticated' });
  await assert.rejects(api.recoverOrder!('order-key'), { code: 'unauthenticated' });
  await assert.rejects(api.startPayment(orderId, 'pay-key'), { code: 'unauthenticated' });
  await assert.rejects(api.getOrder(orderId), { code: 'unauthenticated' });
  assert.equal(transport.calls.length, 0);
  assert.deepEqual([...saved.entries()], [[journalKey, pendingJournal]]);

  const empty = memory();
  transport.denyCookies();
  const other = createWebLiveApi({ config, storage: empty.storage, journalKey, browser, fetcher: transport.fetcher });
  await assert.rejects(other.createQuote(quoteInput), { code: 'unauthenticated' });
  assert.deepEqual(transport.calls.map(call => [call.method, call.path]), [['GET', sessionPath], ['POST', sessionPath], ['GET', sessionPath]]);
  assert.equal(empty.saved.size, 0);
});

test('stale checkout stays bound to the original context while explicit OTP only reads its verified order', async () => {
  const { storage, saved } = memory([[journalKey + '.context', first], [journalKey, pendingJournal]]);
  const transport = fixture(second, ({ path }) => {
    if (path === '/web/order-access/challenges') return Response.json({ challengeId });
    if (path === '/web/order-access/challenges/' + challengeId + '/verify') return Response.json({ orderId });
    if (path === '/web/orders/' + orderId) return Response.json({ ...order, recoveryReadOnly: true });
    return new Response(null, { status: 404 });
  });
  const options = { config, storage, journalKey, browser, fetcher: transport.fetcher };
  const api = createWebLiveApi(options);
  await assert.rejects(api.createQuote(quoteInput), { code: 'unauthenticated' });
  await assert.rejects(api.getOrder(orderId), { code: 'unauthenticated' });
  await assert.rejects(api.verifyOrderAccess!(challengeId, '010101'), { code: 'unauthenticated' });
  await api.requestOrderAccess!({ orderCode: '193A002B', phone: '+250780000001' });
  await api.verifyOrderAccess!(challengeId, '010101');
  const observed = await createWebLiveApi(options).getOrder(orderId);
  assert.equal(observed.recoveryReadOnly, true);
  assert.equal(observed.paymentAttempt?.checkoutUrl, null);
  await assert.rejects(api.getOrder(unknownOrderId), { code: 'unauthenticated' });
  await assert.rejects(api.startPayment(orderId, 'pay-key'), { code: 'unauthenticated' });
  await assert.rejects(api.reorder(orderId), { code: 'unauthenticated' });
  assert.equal(saved.get(journalKey), pendingJournal);
  assert.equal(saved.get(journalKey + '.context'), first);
  assert.deepEqual(JSON.parse(saved.get(journalKey + '.verified')!), { sessionId: second, orderIds: [orderId], owned: false });
  assert.equal(transport.calls.find(call => call.path.endsWith('/payments'))?.context, first);
  assert.equal(transport.calls.find(call => call.path.endsWith('/payments'))?.key, 'pay-key');
  assert.equal(transport.calls.some(call => call.context === second && call.path.includes(unknownOrderId)), false);
  assert.equal(transport.calls.some(call => call.path === sessionPath && call.method === 'POST'), false);
});

test('ending a stale tab clears its own access without revoking the current cookie in another tab', async () => {
  const { storage, saved } = memory([[journalKey + '.context', first], [journalKey, pendingJournal]]);
  const transport = fixture(second);
  const api = createWebLiveApi({ config, storage, journalKey, browser, fetcher: transport.fetcher });
  await api.endGuestSession();
  assert.equal(saved.size, 0);
  assert.deepEqual(transport.calls.map(call => [call.method, call.path]), [['GET', sessionPath]]);
  const next = await api.createQuote(quoteInput);
  assert.equal(next.id, 'quote-2');
  assert.equal(saved.get(journalKey + '.context'), second);
});

test('private operations reject unavailable browsers and unsafe checkout URLs; the menu stays public', async () => {
  const { storage } = memory([[journalKey + '.context', first]]);
  const transport = fixture(first, ({ path }) => {
    if (path.startsWith('/stores/')) {
      return Response.json({
        version: 'v1', updatedAt: expiresAt, slots: [], products: [],
        store: { id: 'kigali', open: true, name: { en: 'Kigali', rw: 'Kigali' }, area: { en: '', rw: '' }, hours: { en: '', rw: '' } },
      });
    }
    return Response.json({ ...order, paymentAttempt: { ...attempt, checkoutUrl: 'https://checkout.example.test.attacker.test/page' } });
  });
  const options = { config, storage, journalKey, browser, fetcher: transport.fetcher };
  const unavailable = createWebLiveApi({ ...options, browser: { ...browser, available: () => false } });
  await assert.rejects(unavailable.getOrder(orderId), { code: 'service_unavailable' });
  await assert.rejects(unavailable.createQuote(quoteInput), { code: 'service_unavailable' });
  assert.equal(transport.calls.length, 0);
  assert.equal((await unavailable.getMenu()).store.id, 'kigali');
  assert.equal(transport.calls[0]?.path, '/stores/kigali/menu?channel=web');

  const api = createWebLiveApi(options);
  assert.equal((await api.getOrder(orderId)).paymentAttempt?.checkoutUrl, null);
  await assert.rejects(api.getOrder('../quotes'), { code: 'invalid_input' });
});

test('fresh quotes can replace an expired tab context with no journal without rebinding an earlier quote', async () => {
  const { storage, saved } = memory();
  const transport = fixture(first, ({ path }) => path === '/web/orders' ? Response.json(order) : new Response(null, { status: 404 }));
  const api = createWebLiveApi({ config, storage, journalKey, browser, fetcher: transport.fetcher });
  const before = await api.createQuote(quoteInput);
  transport.setCookie(second);
  const after = await api.createQuote(quoteInput);
  assert.equal(after.id, 'quote-2');
  assert.equal(saved.get(journalKey + '.context'), second);
  await assert.rejects(api.createOrder({ quoteId: before.id, phone: '+250780000001' }, 'key-before'), { code: 'unauthenticated' });
  const started = await api.createOrder({ quoteId: after.id, phone: '+250780000001' }, 'key-after');
  assert.equal(started.id, orderId);
  assert.deepEqual(transport.calls.filter(call => call.path === '/web/orders').map(call => [call.context, call.key]), [[second, 'key-after']]);
});

test('an uncertain order creation keeps its durable intent after a cookie change', async () => {
  const { storage, saved } = memory();
  const transport = fixture(first);
  const api = createWebLiveApi({ config, storage, journalKey, browser, fetcher: transport.fetcher });
  const prepared = await api.createQuote(quoteInput);
  const journal = JSON.stringify({
    version: 1, active: { phase: 'creating', quoteId: prepared.id, key: 'create-key', cartFingerprint: 'hash' }, orderIds: [],
  });
  saved.set(journalKey, journal);
  transport.setCookie(second);
  await assert.rejects(api.recoverOrder!('create-key'), { code: 'unauthenticated' });
  await assert.rejects(api.createOrder({ quoteId: prepared.id, phone: '+250780000001' }, 'create-key'), { code: 'unauthenticated' });
  assert.equal(saved.get(journalKey), journal);
  assert.equal(saved.get(journalKey + '.context'), first);
  assert.deepEqual(transport.calls.filter(call => call.key === 'create-key').map(call => call.context), [first, first]);
});

test('phone recovery can create a separate read context for an expired pending checkout and only revoke what it created', async () => {
  const { storage, saved } = memory([[journalKey + '.context', second], [journalKey, pendingJournal]]);
  const transport = fixture(null, ({ path }) => {
    if (path === '/web/order-access/challenges') return Response.json({ challengeId });
    if (path.endsWith('/verify')) return Response.json({ orderId });
    return new Response(null, { status: 404 });
  });
  const api = createWebLiveApi({ config, storage, journalKey, browser, fetcher: transport.fetcher });
  await api.requestOrderAccess!({ orderCode: '193A002B', phone: '+250780000001' });
  await api.verifyOrderAccess!(challengeId, '010101');
  assert.deepEqual(JSON.parse(saved.get(journalKey + '.verified')!), { sessionId: first, orderIds: [orderId], owned: true });
  assert.equal(saved.get(journalKey), pendingJournal);
  await api.endGuestSession();
  assert.equal(saved.size, 0);
  assert.equal(transport.calls.find(call => call.method === 'DELETE')?.context, first);
});
