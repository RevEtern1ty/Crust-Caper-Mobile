import { equal } from 'node:assert/strict';
import { test } from 'node:test';
import { canEnablePickupAlert, savedPickupAlertOrderId } from './pickup-alert-rules';

test('notification taps only select already saved canonical order IDs', () => {
  const saved = 'ac90baf9-b328-4bf0-8241-428889305dc5';
  const unknown = 'fb2b35b9-4851-4c06-a8ba-3c8366c7b35a';
  equal(savedPickupAlertOrderId({ type: 'pickup-ready', orderId: saved, url: 'https://example.test' }, [saved]), saved);
  for (const payload of [null, {}, { type: 'pickup_ready', orderId: saved }, { type: 'pickup-ready', orderId: unknown },
    { type: 'pickup-ready', orderId: saved.toUpperCase() }, { type: 'pickup-ready', orderId: [saved] }, { type: 'pickup-ready', url: saved }]) {
    equal(savedPickupAlertOrderId(payload, [saved]), null);
  }
});

test('only paid orders still in the kitchen are eligible for opt-in', () => {
  equal(canEnablePickupAlert({ status: 'accepted', paymentStatus: 'paid' }), true);
  equal(canEnablePickupAlert({ status: 'preparing', paymentStatus: 'paid' }), true);
  equal(canEnablePickupAlert({ status: 'accepted', paymentStatus: 'unpaid' }), false);
  equal(canEnablePickupAlert({ status: 'ready', paymentStatus: 'paid' }), false);
  equal(canEnablePickupAlert({ status: 'cancelled', paymentStatus: 'refunded' }), false);
});
