import { deepEqual, equal, ok, rejects } from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoApi, DEMO_PHONE } from '../domain/demo-api';
import { ApiError, type CartLine, type OrderInput } from '../domain/types';
import { CHECKOUT_JOURNAL_KEY, CheckoutController, type CheckoutContact } from './controller';

const line: CartLine = { sku: 'double-smash', modifierIds: [], quantity: 1, unitPrice: 9200 };

function fixture() {
  let id = 0;
  let key = 0;
  let now = Date.parse('2026-11-25T10:00:00Z');
  let delayedPaymentMs = 0;
  let loseOrderResponse = false;
  let losePaymentResponse = false;
  let breakCartClear = false;
  let failJournalWrite = false;
  let failOrderRead = false;
  let readOnlyRecovery = false;
  const data = new Map<string, string>();
  const journal = new Map<string, string>();
  const orderCalls: string[] = [];
  const paymentCalls: string[] = [];
  const cartClears: string[] = [];
  const api = createDemoApi({
    storage: {
      async getItem(name) { return data.get(name) ?? null; },
      async setItem(name, value) { data.set(name, value); },
    },
    now: () => now,
    newId: () => `id-${++id}`,
  });

  const restart = (allowMissingDemoOrders = true, recoverFromLedger = false) => new CheckoutController({
    demoContact: { phone: DEMO_PHONE },
    allowMissingDemoOrders,
    listDemoOrderRefs: recoverFromLedger ? api.listDemoOrderRefs : undefined,
    api: {
      ...api,
      async getOrder(orderId) {
        if (failOrderRead) throw new Error('Temporarily unavailable');
        const order = await api.getOrder(orderId);
        return readOnlyRecovery ? { ...order, recoveryReadOnly: true } : order;
      },
      async createOrder(input, idempotencyKey) {
        equal(input.phone, DEMO_PHONE);
        equal(savedJournal()?.active.phase, 'creating');
        equal(savedJournal()?.active.key, idempotencyKey);
        orderCalls.push(idempotencyKey);
        const result = await api.createOrder(input, idempotencyKey);
        if (loseOrderResponse) {
          loseOrderResponse = false;
          throw new Error('Order response lost after commit');
        }
        return result;
      },
      async startPayment(orderId, idempotencyKey) {
        equal(savedJournal()?.active.phase, 'paying');
        equal(savedJournal()?.active.orderId, orderId);
        equal(savedJournal()?.active.key, idempotencyKey);
        paymentCalls.push(idempotencyKey);
        now += delayedPaymentMs;
        const result = await api.startPayment(orderId, idempotencyKey);
        if (losePaymentResponse) {
          losePaymentResponse = false;
          throw new Error('Payment response lost after commit');
        }
        return result;
      },
    },
    storage: {
      async getItem(name) { return journal.get(name) ?? null; },
      async setItem(name, value) {
        if (failJournalWrite) throw new Error('Journal write failed');
        journal.set(name, value);
      },
    },
    newKey: () => `key-${++key}`,
    onOrderCreated: async (fingerprint) => {
      if (breakCartClear) {
        breakCartClear = false;
        throw new Error('Stopped before clearing cart');
      }
      cartClears.push(fingerprint);
    },
  });

  function savedJournal() {
    const raw = journal.values().next().value;
    return raw ? JSON.parse(raw) : null;
  }

  async function quote() {
    const { store, slots } = await api.getMenu();
    const slot = slots.find((item) => item.available);
    ok(slot);
    return api.createQuote({ storeId: store.id, slotId: slot.id, lines: [line] });
  }

  return {
    api, quote, restart, orderCalls, paymentCalls, cartClears, savedJournal,
    dropOrderResponse: () => { loseOrderResponse = true; },
    dropPaymentResponse: () => { losePaymentResponse = true; },
    stopBeforeCartClear: () => { breakCartClear = true; },
    blockJournal: () => { failJournalWrite = true; },
    blockOrderReads: () => { failOrderRead = true; },
    readOrderAsRecoveryGuest: () => { readOnlyRecovery = true; },
    resetDemoStorage: () => { data.clear(); },
    removeJournal: () => { journal.clear(); },
    corruptDemoStorage: () => { data.set('crustcaper.demo.v1', 'invalid-demo-data'); },
    setTime: (time: string) => { now = Date.parse(time); },
    delayPayment: (ms: number) => { delayedPaymentMs = ms; },
    restoreLegacyJournal: (value: unknown) => { journal.set(CHECKOUT_JOURNAL_KEY, JSON.stringify(value)); },
  };
}

test('the saved checkout intent recovers an order after a lost create response', async () => {
  const f = fixture();
  f.dropOrderResponse();
  await rejects(f.restart().begin(await f.quote(), 'same-cart'), /Order response lost/);
  deepEqual(f.paymentCalls, []);
  const recovered = await f.restart().resume();
  equal(recovered.paymentStatus, 'processing');
  deepEqual(f.orderCalls, ['key-1', 'key-1']);
  deepEqual(f.paymentCalls, ['key-2']);
  deepEqual(f.cartClears, ['same-cart']);
  deepEqual(f.savedJournal().orderIds, [recovered.id]);
});

test('a lost payment response recovers the existing attempt and prevents another order while pending', async () => {
  const f = fixture();
  f.dropPaymentResponse();
  await rejects(f.restart().begin(await f.quote(), 'cart'), /Payment response lost/);
  const resumed = f.restart();
  const existing = await resumed.resume();
  equal(existing.paymentStatus, 'processing');
  await rejects(resumed.begin(await f.quote(), 'new-cart'), { code: 'active_checkout' });
  const next = await resumed.resume(true);
  equal(next.paymentAttempt?.id, existing.paymentAttempt?.id);
  deepEqual(f.paymentCalls, ['key-2']);
  deepEqual(f.orderCalls, ['key-1']);
});

test('a cancelled hold lets a guest start a separate order while the old payment is still checked', async () => {
  const f = fixture();
  f.dropPaymentResponse();
  await rejects(f.restart().begin(await f.quote(), 'first-cart'), /Payment response lost/);
  const originalId = f.savedJournal().active.orderId;
  const original = await f.api.getOrder(originalId);
  f.setTime('2026-11-25T10:11:00Z');

  const controller = f.restart();
  const expired = await controller.resume();
  equal(expired.id, originalId);
  equal(expired.status, 'cancelled');
  equal(expired.paymentStatus, 'processing');
  equal(controller.snapshot.active?.phase, 'tracking');
  deepEqual(f.paymentCalls, ['key-2']);

  const replacement = await controller.begin(await f.quote(), 'second-cart');
  equal(replacement.id === originalId, false);
  equal(replacement.paymentStatus, 'processing');
  deepEqual(controller.snapshot.orderIds, [replacement.id, originalId]);
  deepEqual(f.orderCalls, ['key-1', 'key-3']);
  deepEqual(f.paymentCalls, ['key-2', 'key-4']);
  const unchanged = await f.api.getOrder(originalId);
  equal(unchanged.paymentAttempt?.id, original.paymentAttempt?.id);
  equal(unchanged.reservationExpiresAt, original.reservationExpiresAt);
});

test('a terminal payment can be reconciled after restart and the next order can start', async () => {
  const f = fixture();
  f.dropPaymentResponse();
  await rejects(f.restart().begin(await f.quote(), 'cart'), /Payment response lost/);
  const savedOrderId = f.savedJournal().active.orderId;
  const saved = await f.api.getOrder(savedOrderId);
  ok(saved.paymentAttempt);
  await f.api.setDemoPaymentResult(savedOrderId, saved.paymentAttempt.id, 'paid');
  const restored = f.restart();
  equal((await restored.resume()).paymentStatus, 'paid');
  equal(restored.snapshot.active?.phase, 'tracking');
  const next = await restored.begin(await f.quote(), 'new-cart');
  equal(next.paymentStatus, 'processing');
  deepEqual(f.paymentCalls, ['key-2', 'key-4']);
});

test('the cart is reconciled when an interruption occurs after the attempt starts', async () => {
  const f = fixture();
  f.stopBeforeCartClear();
  await rejects(f.restart().begin(await f.quote(), 'saved-cart'), /Stopped before clearing cart/);
  equal(f.savedJournal().active.phase, 'paying');
  equal(f.savedJournal().active.cartFingerprint, 'saved-cart');
  deepEqual(f.paymentCalls, ['key-2']);
  await f.restart().resume();
  deepEqual(f.cartClears, ['saved-cart']);
  deepEqual(f.paymentCalls, ['key-2']);
});

test('a confirmed decline has one new attempt under simultaneous retry taps', async () => {
  const f = fixture();
  const controller = f.restart();
  const first = await controller.begin(await f.quote(), 'cart');
  ok(first.paymentAttempt);
  await f.api.setDemoPaymentResult(first.id, first.paymentAttempt.id, 'declined');
  equal((await controller.resume()).paymentStatus, 'declined');
  const retry = controller.resume(true);
  await rejects(controller.resume(true), { code: 'active_checkout' });
  const second = await retry;
  equal(second.id, first.id);
  equal(second.paymentStatus, 'processing');
  deepEqual(f.paymentCalls, ['key-2', 'key-3']);
});

test('storage failure stops the checkout before the critical write', async () => {
  const f = fixture();
  f.blockJournal();
  await rejects(f.restart().begin(await f.quote(), 'cart'), /Journal write failed/);
  deepEqual(f.orderCalls, []);
  deepEqual(f.paymentCalls, []);
});

test('an expired reservation leaves the cart intact and permits a new quote', async () => {
  const f = fixture();
  f.setTime('2026-11-25T10:09:59.999Z');
  f.delayPayment(5);
  const controller = f.restart();
  await rejects(controller.begin(await f.quote(), 'cart'), { code: 'reservation_expired' });
  deepEqual(f.cartClears, []);
  equal(controller.snapshot.active?.phase, 'tracking');
  const fresh = await controller.begin(await f.quote(), 'cart');
  equal(fresh.paymentStatus, 'processing');
  deepEqual(f.cartClears, ['cart']);
});

test('a missing demo record is removed from the journal after a fixture reset', async () => {
  const f = fixture();
  f.dropPaymentResponse();
  await rejects(f.restart().begin(await f.quote(), 'cart'), /Payment response lost/);
  f.resetDemoStorage();

  const restored = f.restart();
  await rejects(restored.resume(), { code: 'not_found' });
  equal(restored.snapshot.active, null);
  deepEqual(restored.snapshot.orderIds, []);
  equal((await restored.begin(await f.quote(), 'fresh-cart')).paymentStatus, 'processing');
});

test('a new demo checkout can recover when the previously tracked order is missing', async () => {
  const f = fixture();
  const first = await f.restart().begin(await f.quote(), 'cart');
  f.resetDemoStorage();

  const restored = f.restart();
  const second = await restored.begin(await f.quote(), 'fresh-cart');
  ok(first.id !== second.id);
  deepEqual(restored.snapshot.orderIds, [second.id]);
});

test('a read failure or a missing non-demo order preserves the existing journal', async () => {
  const f = fixture();
  const first = await f.restart().begin(await f.quote(), 'cart');
  f.resetDemoStorage();

  const nonDemo = f.restart(false);
  await rejects(nonDemo.begin(await f.quote(), 'fresh-cart'), { code: 'not_found' });
  deepEqual(nonDemo.snapshot.orderIds, [first.id]);

  f.blockOrderReads();
  const offline = f.restart();
  await rejects(offline.resume(), /Temporarily unavailable/);
  deepEqual(offline.snapshot.active, nonDemo.snapshot.active);
  deepEqual(offline.snapshot.orderIds, [first.id]);
});

test('the previous journal format without a cart fingerprint resumes the existing attempt', async () => {
  const f = fixture();
  f.dropPaymentResponse();
  await rejects(f.restart().begin(await f.quote(), 'cart'), /Payment response lost/);
  const { active, orderIds } = f.savedJournal();
  f.restoreLegacyJournal({ version: 1, orderIds, active: { phase: 'paying', orderId: active.orderId, key: active.key } });

  const restored = await f.restart().resume();
  equal(restored.paymentStatus, 'processing');
  deepEqual(f.paymentCalls, ['key-2']);
  deepEqual(f.cartClears, []);
});

test('a read-only recovered payment preserves its intent and never retries it', async () => {
  const f = fixture();
  f.dropPaymentResponse();
  await rejects(f.restart().begin(await f.quote(), 'cart'), /Payment response lost/);
  const intent = f.savedJournal();
  const attempt = (await f.api.getOrder(intent.active.orderId)).paymentAttempt;
  ok(attempt);
  await f.api.setDemoPaymentResult(intent.active.orderId, attempt.id, 'declined');
  f.readOrderAsRecoveryGuest();

  const restored = f.restart(false);
  equal((await restored.resume(true)).paymentStatus, 'declined');
  deepEqual(f.savedJournal(), intent);
  deepEqual(f.paymentCalls, ['key-2']);
  deepEqual(f.cartClears, []);
  await rejects(restored.begin(await f.quote(), 'another-cart'), { code: 'active_checkout' });
});


test('a malformed demo journal is recovered from committed orders without another payment', async () => {
  const f = fixture();
  const order = await f.restart().begin(await f.quote(), 'cart');
  f.restoreLegacyJournal({ version: 1, orderIds: null, active: 'damaged' });

  const recovered = f.restart(true, true);
  const [firstRestore, secondRestore] = await Promise.all([recovered.restore(), recovered.restore()]);
  deepEqual(firstRestore, secondRestore);
  deepEqual(firstRestore.orderIds, [order.id]);
  equal(firstRestore.active?.phase, 'tracking');
  equal((await recovered.resume()).paymentAttempt?.id, order.paymentAttempt?.id);
  equal(f.paymentCalls.length, 1);
});

test('a broken ledger or connected mode cannot discard a damaged journal', async () => {
  const f = fixture();
  const original = { version: 1, orderIds: null, active: 'damaged' };
  f.restoreLegacyJournal(original);
  await rejects(f.restart(false, true).restore(), { code: 'invalid_journal' });
  deepEqual(f.savedJournal(), original);

  f.corruptDemoStorage();
  await rejects(f.restart(true, true).restore(), { code: 'storage_unavailable' });
  deepEqual(f.savedJournal(), original);
});


test('a missing demo journal is reconstructed from the ledger and transparently resumes', async () => {
  const f = fixture();
  const order = await f.restart().begin(await f.quote(), 'cart');
  f.removeJournal();

  const restored = f.restart(true, true);
  deepEqual((await restored.restore()).orderIds, [order.id]);
  equal((await restored.resume()).paymentAttempt?.id, order.paymentAttempt?.id);
  deepEqual(f.paymentCalls, ['key-2']);
});

test('explicit retry reconciles a decline after a lost response and starts exactly one new attempt', async () => {
  const f = fixture();
  f.dropPaymentResponse();
  await rejects(f.restart().begin(await f.quote(), 'cart'), /Payment response lost/);

  const { orderId } = f.savedJournal().active;
  const saved = await f.api.getOrder(orderId);
  ok(saved.paymentAttempt);
  await f.api.setDemoPaymentResult(orderId, saved.paymentAttempt.id, 'declined');

  const restored = f.restart();
  const retried = await restored.resume(true);
  equal(retried.id, orderId);
  equal(retried.paymentStatus, 'processing');
  ok(retried.paymentAttempt?.id !== saved.paymentAttempt.id);
  deepEqual(f.paymentCalls, ['key-2', 'key-2', 'key-3']);
});

const connectedContact: CheckoutContact = { phone: '+12025550100', email: 'guest@example.invalid' };

function connectedFixture(failCreate: 'before_commit' | 'after_commit') {
  const { api, quote } = fixture();
  const merchantJournalKey = 'checkout.connected.test';
  const oldDemoState = JSON.stringify({ version: 1, orderIds: ['demo-previous-order'], active: null });
  const journal = new Map([[CHECKOUT_JOURNAL_KEY, oldDemoState]]);
  const serverOrders = new Map<string, string>();
  const createCalls: { key: string; input: OrderInput }[] = [];
  const recoveryKeys: string[] = [];
  let key = 0;
  let recoveryDenied = false;

  const restart = () => new CheckoutController({
    storageKey: merchantJournalKey,
    storage: {
      async getItem(name) { return journal.get(name) ?? null; },
      async setItem(name, value) { journal.set(name, value); },
    },
    api: {
      async createOrder(input, orderKey) {
        createCalls.push({ key: orderKey, input });
        if (createCalls.length === 1 && failCreate === 'before_commit') throw new ApiError('network_unavailable');
        // The in-memory fixture stands in for an authorized server with a separate demo contact policy.
        const committed = await api.createOrder({ quoteId: input.quoteId, phone: DEMO_PHONE }, orderKey);
        serverOrders.set(orderKey, committed.id);
        if (createCalls.length === 1 && failCreate === 'after_commit') throw new ApiError('network_unavailable');
        return committed;
      },
      async recoverOrder(orderKey) {
        recoveryKeys.push(orderKey);
        if (recoveryDenied) throw new ApiError('unauthenticated');
        const orderId = serverOrders.get(orderKey);
        return orderId ? api.getOrder(orderId) : null;
      },
      getOrder: api.getOrder,
      startPayment: api.startPayment,
    },
    newKey: () => `connected-key-${++key}`,
    onOrderCreated: async () => {},
  });

  return {
    quote, restart, createCalls, recoveryKeys, journal, merchantJournalKey, oldDemoState,
    denyRecovery: () => { recoveryDenied = true; },
  };
}

test('connected checkout recovers a committed order by key without persisting or resending guest contact', async () => {
  const f = connectedFixture('after_commit');
  await rejects(f.restart().begin(await f.quote(), 'cart', connectedContact), { code: 'network_unavailable' });
  const saved = f.journal.get(f.merchantJournalKey);
  ok(saved);
  equal(saved.includes(connectedContact.phone), false);
  ok(connectedContact.email);
  equal(saved.includes(connectedContact.email), false);

  const recovered = await f.restart().resume();
  equal(recovered.paymentStatus, 'processing');
  deepEqual(f.recoveryKeys, ['connected-key-1']);
  equal(f.createCalls.length, 1);
  equal(f.createCalls[0]?.input.email, connectedContact.email);
  equal(f.journal.get(CHECKOUT_JOURNAL_KEY), f.oldDemoState);
});

test('an uncommitted connected checkout asks for contact again and reuses the confirmed request key', async () => {
  const f = connectedFixture('before_commit');
  await rejects(f.restart().begin(await f.quote(), 'cart', connectedContact), { code: 'network_unavailable' });

  const restored = f.restart();
  await rejects(restored.resume(), { code: 'contact_required' });
  equal(f.createCalls.length, 1);
  equal(restored.snapshot.active?.phase, 'creating');

  const resumed = await restored.resume(false, connectedContact);
  equal(resumed.paymentStatus, 'processing');
  deepEqual(f.createCalls[0], f.createCalls[1]);
  deepEqual(f.recoveryKeys, ['connected-key-1', 'connected-key-1']);
});

test('unauthorized connected recovery preserves the pending journal without posting another order', async () => {
  const f = connectedFixture('after_commit');
  await rejects(f.restart().begin(await f.quote(), 'cart', connectedContact), { code: 'network_unavailable' });
  const saved = f.journal.get(f.merchantJournalKey);
  f.denyRecovery();

  await rejects(f.restart().resume(false, connectedContact), { code: 'unauthenticated' });
  equal(f.createCalls.length, 1);
  equal(f.journal.get(f.merchantJournalKey), saved);
});

const recoveredOrderId = '1cf5ba6e-0584-45b5-bbc5-3a5ec90502c9';

test('a proven order is appended once without replacing a pending checkout', async () => {
  const f = fixture();
  const active = { phase: 'creating', quoteId: 'old-quote', key: 'old-key', cartFingerprint: 'old-cart' };
  f.restoreLegacyJournal({ version: 1, active, orderIds: ['earlier-order'] });

  const restored = f.restart(false);
  await restored.rememberRecoveredOrder(recoveredOrderId);
  await restored.rememberRecoveredOrder(recoveredOrderId);
  const coldStart = await f.restart(false).restore();

  deepEqual(coldStart, { version: 1, active, orderIds: ['earlier-order', recoveredOrderId] });
  deepEqual(f.orderCalls, []);
  deepEqual(f.paymentCalls, []);
});

test('adding a recovered order at the history limit keeps the active payment reference', async () => {
  const f = fixture();
  const active = { phase: 'paying', orderId: 'active-order', key: 'payment-key' };
  const previous = Array.from({ length: 9 }, (_, index) => `order-${index}`);
  f.restoreLegacyJournal({ version: 1, active, orderIds: [...previous, active.orderId] });

  await f.restart(false).rememberRecoveredOrder(recoveredOrderId);

  deepEqual(await f.restart(false).restore(), {
    version: 1, active, orderIds: [...previous.slice(0, 8), active.orderId, recoveredOrderId],
  });
});

test('an invalid grant or a failed history write leaves the saved orders intact', async () => {
  const f = fixture();
  const saved = { version: 1, active: null, orderIds: ['earlier-order'] };
  f.restoreLegacyJournal(saved);
  const restored = f.restart(false);

  await rejects(restored.rememberRecoveredOrder('not-an-order-id'), { code: 'invalid_response' });
  f.blockJournal();
  await rejects(restored.rememberRecoveredOrder(recoveredOrderId), /Journal write failed/);

  deepEqual(restored.snapshot, saved);
  deepEqual(f.savedJournal(), saved);
});
