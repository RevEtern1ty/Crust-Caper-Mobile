import { deepEqual, equal, ok, rejects } from 'node:assert/strict';
import { test } from 'node:test';

import { createDemoApi, DEMO_PHONE } from '../domain/demo-api';
import type { CartLine } from '../domain/types';
import { CheckoutController } from './controller';

const line: CartLine = { sku: 'double-smash', modifierIds: [], quantity: 1, unitPrice: 9200 };

function fixture() {
  let id = 0;
  let key = 0;
  let loseOrderResponse = false;
  let losePaymentResponse = false;
  let breakCartClear = false;
  let failJournalWrite = false;
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
    now: () => Date.parse('2026-11-25T10:00:00Z'),
    newId: () => `id-${++id}`,
  });

  const restart = () => new CheckoutController({
    api: {
      ...api,
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
  await f.api.setDemoPaymentResult(savedOrderId, 'paid');
  const restored = f.restart();
  equal((await restored.resume()).paymentStatus, 'paid');
  equal(restored.snapshot.active?.phase, 'tracking');
  const next = await restored.begin(await f.quote(), 'new-cart');
  equal(next.paymentStatus, 'processing');
  deepEqual(f.paymentCalls, ['key-2', 'key-4']);
});

test('the cart is reconciled when an interruption occurs between saving the order and starting payment', async () => {
  const f = fixture();
  f.stopBeforeCartClear();
  await rejects(f.restart().begin(await f.quote(), 'saved-cart'), /Stopped before clearing cart/);
  equal(f.savedJournal().active.phase, 'paying');
  equal(f.savedJournal().active.cartFingerprint, 'saved-cart');
  await f.restart().resume();
  deepEqual(f.cartClears, ['saved-cart']);
  deepEqual(f.paymentCalls, ['key-2']);
});

test('a confirmed decline has one new attempt under simultaneous retry taps', async () => {
  const f = fixture();
  const controller = f.restart();
  const first = await controller.begin(await f.quote(), 'cart');
  await f.api.setDemoPaymentResult(first.id, 'declined');
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
