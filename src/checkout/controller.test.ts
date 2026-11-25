import { deepEqual, equal, ok, rejects } from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoApi, DEMO_PHONE } from '../domain/demo-api';
import type { CartLine } from '../domain/types';
import { CHECKOUT_JOURNAL_KEY, CheckoutController } from './controller';

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

  const restart = (allowMissingDemoOrders = true) => new CheckoutController({
    allowMissingDemoOrders,
    api: {
      ...api,
      async getOrder(orderId) {
        if (failOrderRead) throw new Error('Temporarily unavailable');
        return api.getOrder(orderId);
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
    resetDemoStorage: () => { data.clear(); },
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
