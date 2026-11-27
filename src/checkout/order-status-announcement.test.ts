import { deepEqual, equal } from 'node:assert/strict';
import { test } from 'node:test';

import { observeOrderStatus } from './order-status-announcement';

const pending = { id: 'order-a', status: 'awaiting_payment', paymentStatus: 'processing', paymentAttempt: null } as const;
const accepted = { ...pending, status: 'accepted', paymentStatus: 'paid' } as const;

test('the first or another order is silent, and same-order status changes speak only once', () => {
  const first = observeOrderStatus(null, pending, 'en', 'orders');
  equal(first.announcement, null);
  const paid = observeOrderStatus(first.snapshot, accepted, 'en', 'orders');
  equal(paid.announcement, 'Order accepted. Paid');
  equal(observeOrderStatus(paid.snapshot, { ...accepted }, 'en', 'orders').announcement, null);
  equal(observeOrderStatus(paid.snapshot, { ...accepted, status: 'ready' }, 'en', 'orders').announcement, 'Ready for pickup');
  const other = observeOrderStatus(paid.snapshot, { ...pending, id: 'order-b' }, 'en', 'orders');
  equal(other.announcement, null);
  equal(observeOrderStatus(other.snapshot, accepted, 'en', 'orders').announcement, null);
});

test('the Payment screen announces only a changed payment status in the current language', () => {
  const first = observeOrderStatus(null, pending, 'en', 'payment');
  const paid = observeOrderStatus(first.snapshot, accepted, 'rw', 'payment');
  equal(paid.announcement, 'Yishyuwe');
  equal(observeOrderStatus(paid.snapshot, { ...accepted, status: 'ready' }, 'en', 'payment').announcement, null);
});

test('an interim inconsistent read never announces or replaces the previous confirmed status', () => {
  const first = observeOrderStatus(null, pending, 'en', 'orders');
  const inconsistent = {
    ...pending,
    paymentStatus: 'unpaid',
    paymentAttempt: { id: 'attempt-a', status: 'paid', checkoutUrl: null },
  } as const;
  const uncertain = observeOrderStatus(first.snapshot, inconsistent, 'en', 'orders');
  deepEqual(uncertain, { snapshot: first.snapshot, announcement: null });
  equal(observeOrderStatus(uncertain.snapshot, accepted, 'en', 'orders').announcement, 'Order accepted. Paid');
  const cleared = observeOrderStatus(uncertain.snapshot, null, 'en', 'orders');
  deepEqual(cleared, { snapshot: null, announcement: null });
  equal(observeOrderStatus(cleared.snapshot, accepted, 'en', 'orders').announcement, null);
});
