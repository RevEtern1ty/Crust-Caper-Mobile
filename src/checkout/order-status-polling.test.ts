import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiError, type Order } from '../domain/types';
import { nextOrderStatusDelay } from './order-status-polling';

test('connected orders keep checking once ready and stop once picked up', () => {
  const check = (status: Order['status']) =>
    nextOrderStatusDelay('connected', { order: { status, paymentStatus: 'paid' } }, 12, 0);

  assert.equal(check('accepted'), 5000);
  assert.equal(check('preparing'), 5000);
  assert.equal(check('ready'), 5000);
  assert.equal(check('collected'), null);
});

test('connected status checks recover from repeated temporary failures without busy retrying', () => {
  const delay = (failureCount: number) =>
    nextOrderStatusDelay('connected', { error: new ApiError('network_unavailable') }, 20, failureCount);

  assert.deepEqual([delay(1), delay(2), delay(3), delay(20)], [5000, 10_000, 15_000, 15_000]);
  assert.equal(nextOrderStatusDelay('connected', { error: new ApiError('rate_limited') }, 1, 1), 15_000);
  assert.equal(nextOrderStatusDelay('connected', { error: new ApiError('not_found') }, 1, 1), null);
  assert.equal(nextOrderStatusDelay('connected', { error: new ApiError('unauthenticated') }, 1, 1), null);
});

test('connected pending payments and refunds remain open to updates', () => {
  const check = (paymentStatus: Order['paymentStatus']) => nextOrderStatusDelay(
    'connected', { order: { status: 'cancelled', paymentStatus } }, 12, 0,
  );

  assert.equal(check('processing'), 3000);
  assert.equal(check('refund_pending'), 15_000);
  assert.equal(check('refunded'), null);
});

test('awaiting unpaid and declined holds refresh infrequently and check again just after the deadline', () => {
  const now = Date.parse('2026-11-25T10:00:00Z');
  for (const mode of ['connected', 'demo'] as const) {
    for (const paymentStatus of ['unpaid', 'declined'] as const) {
      const order = { status: 'awaiting_payment' as const, paymentStatus };
      const future = (delay: number) => ({ order: { ...order, reservationExpiresAt: new Date(now + delay).toISOString() } });
      assert.equal(nextOrderStatusDelay(mode, future(5 * 60_000), 12, 0, now), 60_000);
      assert.equal(nextOrderStatusDelay(mode, future(3200), 12, 0, now), 4200);
      assert.equal(nextOrderStatusDelay(mode, future(0), 12, 0, now), 15_000);
      assert.equal(nextOrderStatusDelay(mode, future(-1000), 12, 0, now), 15_000);
      assert.equal(nextOrderStatusDelay(mode, { order: { ...order, reservationExpiresAt: 'invalid' } }, 12, 0, now), 15_000);
      assert.equal(nextOrderStatusDelay(mode, future(3000), 12, 0, NaN), 15_000);
      assert.equal(nextOrderStatusDelay(mode, { order: { ...order, status: 'cancelled' } }, 12, 0, now), null);
    }
  }
});

test('the demo retains its bounded polling window', () => {
  const result = { order: { status: 'awaiting_payment', paymentStatus: 'processing' } } as const;
  assert.equal(nextOrderStatusDelay('demo', result, 8, 0), 3000);
  assert.equal(nextOrderStatusDelay('demo', result, 9, 0), null);
});
