import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiError, type Order } from '../domain/types';
import { delayedPaymentThresholdMs, nextOrderStatusDelay, nextUncertainPayment, receiptChecksPerVisit } from './order-status-polling';

test('connected orders keep checking once ready and stop once picked up', () => {
  const check = (status: Order['status']) =>
    nextOrderStatusDelay('connected', { order: { status, paymentStatus: 'paid' } }, 12, 0);

  assert.equal(check('accepted'), 5000);
  assert.equal(check('preparing'), 5000);
  assert.equal(check('ready'), 5000);
  assert.equal(check('collected'), null);
});

test('an open collected order checks for its outstanding receipt at low frequency', () => {
  const collected = { status: 'collected', paymentStatus: 'paid', receiptStatus: 'pending' } as const;
  const absent = { order: collected };
  assert.equal(nextOrderStatusDelay('connected', absent, 110, 0, 0, null, receiptChecksPerVisit), 15_000);
  assert.equal(nextOrderStatusDelay('connected', absent, 110, 0, 0, null, 0), null);
  assert.equal(nextOrderStatusDelay('connected', absent, 110, 0), null);
  for (const receiptStatus of ['issued', 'corrected'] as const) {
    const available = { order: { ...collected, receiptStatus } };
    assert.equal(nextOrderStatusDelay('connected', available, 110, 0, 0, null, receiptChecksPerVisit), null);
  }
  assert.equal(nextOrderStatusDelay('demo', absent, 1, 0), null);

  const offline = { error: new ApiError('network_unavailable') };
  assert.equal(nextOrderStatusDelay('connected', offline, 110, 1, 0, null, 1), 15_000);
  assert.equal(nextOrderStatusDelay('connected', offline, 110, 2, 0, null, 0), null);
  const denied = { error: new ApiError('unauthenticated') };
  assert.equal(nextOrderStatusDelay('connected', denied, 110, 1, 0, null, 1), null);
});

test('connected status checks recover from repeated temporary failures without busy retrying', () => {
  for (const code of ['network_unavailable', 'invalid_response'] as const) {
    const retryDelays = [1, 2, 3, 20].map(failures =>
      nextOrderStatusDelay('connected', { error: new ApiError(code) }, 20, failures));
    assert.deepEqual(retryDelays, [5000, 10_000, 15_000, 15_000], code);
  }
  assert.equal(nextOrderStatusDelay('connected', { error: new ApiError('rate_limited') }, 1, 1), 15_000);
  assert.equal(nextOrderStatusDelay('connected', { error: new ApiError('not_found') }, 1, 1), null);
  assert.equal(nextOrderStatusDelay('connected', { error: new ApiError('unauthenticated') }, 1, 1), null);
});

test('connected pending payments and refunds remain open to updates', () => {
  const check = (paymentStatus: Order['paymentStatus']) => nextOrderStatusDelay(
    'connected', { order: { status: 'cancelled', paymentStatus } }, 12, 0, 0, 120_000,
  );

  assert.equal(check('processing'), 60_000);
  assert.equal(check('refund_pending'), 15_000);
  assert.equal(check('refunded'), null);
});

test('connected payment checks slow down based on elapsed uncertainty rather than request count', () => {
  const result = { order: { status: 'awaiting_payment', paymentStatus: 'processing' } } as const;
  const interval = (elapsedMs: number, attempts = 12) =>
    nextOrderStatusDelay('connected', result, attempts, 0, 0, elapsedMs);

  assert.equal(interval(0, 250), 3000);
  assert.equal(interval(delayedPaymentThresholdMs - 1), 3000);
  assert.equal(interval(delayedPaymentThresholdMs), 15_000);
  assert.equal(interval(119_999), 15_000);
  assert.equal(interval(120_000), 60_000);

  let elapsed = 0;
  let checks = 0;
  while (elapsed < 60 * 60_000) {
    const delay = interval(elapsed, ++checks);
    assert.ok(delay);
    elapsed += delay;
  }
  assert.ok(checks < 80, `expected fewer than 80 checks in the first hour, got ${checks}`);
});

test('temporary errors and unreadable attempt identity preserve the observed payment window', () => {
  const processing = { order: { status: 'awaiting_payment', paymentStatus: 'processing',
    paymentAttempt: { status: 'processing', id: 'initial-attempt' } } } as const;
  const inconsistent = { order: { status: 'cancelled', paymentStatus: 'unpaid', paymentAttempt: { status: 'processing' } } } as const;
  const offline = { error: new ApiError('network_unavailable') };
  const rateLimited = { error: new ApiError('rate_limited') };
  const paid = { order: { status: 'accepted', paymentStatus: 'paid' } } as const;
  const declined = { order: { status: 'awaiting_payment', paymentStatus: 'declined' } } as const;

  const observed = nextUncertainPayment(processing, null, 50_000);
  assert.deepEqual(observed, { since: 50_000, attemptId: 'initial-attempt' });
  assert.equal(nextUncertainPayment(offline, observed, 195_000), observed);
  assert.equal(nextOrderStatusDelay('connected', offline, 12, 1, 0, 145_000), 60_000);
  assert.equal(nextUncertainPayment(rateLimited, observed, 240_000), observed);
  assert.equal(nextOrderStatusDelay('connected', rateLimited, 13, 2, 0, 190_000), 60_000);
  assert.deepEqual(nextUncertainPayment(inconsistent, observed, 260_000), observed);
  assert.equal(nextOrderStatusDelay('connected', inconsistent, 14, 0, 0, 210_000), 60_000);
  assert.equal(nextUncertainPayment(paid, observed, 320_000), null);
  assert.equal(nextOrderStatusDelay('connected', paid, 15, 0, 0, 270_000), 5000);
  assert.equal(nextUncertainPayment(declined, observed, 320_000), null);
  assert.equal(nextUncertainPayment({ error: new ApiError('not_found') }, observed, 320_000), null);
  assert.equal(nextUncertainPayment({ error: new ApiError('unauthenticated') }, observed, 320_000), null);
});

test('only a known different attempt starts a new payment polling window', () => {
  const order = { status: 'awaiting_payment', paymentStatus: 'processing' } as const;
  const waiting = (id: string) => ({ order: { ...order, paymentAttempt: { status: 'processing' as const, id } } });
  const unknown = nextUncertainPayment({ order }, null, 10_000);
  assert.deepEqual(unknown, { since: 10_000, attemptId: null });

  const first = nextUncertainPayment(waiting('first-attempt'), unknown, 170_000);
  assert.deepEqual(first, { since: 10_000, attemptId: 'first-attempt' });
  assert.deepEqual(nextUncertainPayment(waiting('first-attempt'), first, 180_000), first);
  const second = waiting('second-attempt');
  const renewed = nextUncertainPayment(second, first, 180_000);
  assert.deepEqual(renewed, { since: 180_000, attemptId: 'second-attempt' });
  assert.ok(renewed);
  assert.equal(nextOrderStatusDelay('connected', second, 10, 0, 0, 180_000 - renewed.since), 3000);
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

test('an order contradicting its latest payment attempt keeps the processing read cadence', () => {
  for (const status of ['awaiting_payment', 'cancelled'] as const) {
    for (const paymentStatus of ['unpaid', 'declined'] as const) {
      for (const attemptStatus of ['processing', 'paid'] as const) {
        const result = { order: { status, paymentStatus, paymentAttempt: { status: attemptStatus } } };
        assert.equal(nextOrderStatusDelay('connected', result, 12, 0), 3000);
        assert.equal(nextOrderStatusDelay('demo', result, 8, 0), 3000);
        assert.equal(nextOrderStatusDelay('demo', result, 9, 0), null);
      }
    }
  }
  const coherent = { order: { status: 'cancelled', paymentStatus: 'declined', paymentAttempt: { status: 'declined' } } } as const;
  assert.equal(nextOrderStatusDelay('connected', coherent, 12, 0), null);
});

test('the demo retains its bounded polling window', () => {
  const result = { order: { status: 'awaiting_payment', paymentStatus: 'processing' } } as const;
  assert.equal(nextOrderStatusDelay('demo', result, 8, 0), 3000);
  assert.equal(nextOrderStatusDelay('demo', result, 9, 0), null);
});
