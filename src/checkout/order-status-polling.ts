import { ApiError, type Order } from '../domain/types';
import { hasInconsistentPayment, isAwaitingUnpaidHold, type HoldState } from './pickup-hold';

type PolledOrder = HoldState & Partial<Pick<Order, 'reservationExpiresAt'>> & {
  paymentAttempt?: { id?: string } | null;
};
export type OrderStatusResult = { order: PolledOrder } | { error: unknown };
export type UncertainPayment = { since: number; attemptId: string | null };

const unpaidHoldCheckIntervalMs = 60_000;
const overdueHoldCheckIntervalMs = 15_000;
const holdDeadlineGraceMs = 1000;
export const delayedPaymentThresholdMs = 18_000;

function isPaymentUncertain(order: PolledOrder): boolean {
  return order.paymentStatus === 'processing' || hasInconsistentPayment(order);
}

function paymentCheckDelay(elapsedMs: number): number {
  if (elapsedMs < delayedPaymentThresholdMs) return 3000;
  if (elapsedMs < 120_000) return 15_000;
  return 60_000;
}

export function nextUncertainPayment(
  result: OrderStatusResult,
  previous: UncertainPayment | null,
  observedAt: number,
): UncertainPayment | null {
  if ('order' in result) {
    if (!isPaymentUncertain(result.order)) return null;
    const attemptId = result.order.paymentAttempt?.id ?? null;
    const sameAttempt = previous && (!previous.attemptId || !attemptId || previous.attemptId === attemptId);
    return { since: sameAttempt ? previous.since : observedAt, attemptId: attemptId ?? previous?.attemptId ?? null };
  }
  // A temporary failure does not establish a new payment state or renew the fast polling window.
  if (result.error instanceof ApiError && (result.error.code === 'unauthenticated' || result.error.code === 'not_found')) {
    return null;
  }
  return previous;
}

export function nextOrderStatusDelay(
  mode: 'demo' | 'connected',
  result: OrderStatusResult,
  attempts: number,
  consecutiveFailures: number,
  now = Date.now(),
  uncertainForMs: number | null = null,
): number | null {
  if ('error' in result) {
    const code = result.error instanceof ApiError ? result.error.code : null;
    if (code === 'unauthenticated' || code === 'not_found') return null;
    if (mode === 'demo') return attempts < 9 ? 3000 : null;
    const paymentDelay = uncertainForMs === null ? 0 : paymentCheckDelay(uncertainForMs);
    if (code === 'rate_limited') return Math.max(15_000, paymentDelay);
    if (code === 'network_unavailable' || code === 'service_unavailable' || code === 'invalid_response') {
      return Math.max(5000 * Math.min(consecutiveFailures, 3), paymentDelay);
    }
    return null;
  }

  if (isAwaitingUnpaidHold(result.order)) {
    const remainingMs = Date.parse(result.order.reservationExpiresAt ?? '') - now;
    // Only a new server read can close the hold. An elapsed or unknown client clock must not cause a rapid read loop.
    return remainingMs > 0 && Number.isFinite(remainingMs)
      ? Math.min(Math.ceil(remainingMs) + holdDeadlineGraceMs, unpaidHoldCheckIntervalMs)
      : overdueHoldCheckIntervalMs;
  }

  const { status, paymentStatus } = result.order;
  const inKitchen = status === 'accepted' || status === 'preparing';
  const uncertain = isPaymentUncertain(result.order);
  if (mode === 'demo') {
    return attempts < 9 && (inKitchen || uncertain) ? 3000 : null;
  }
  if (uncertain) return paymentCheckDelay(uncertainForMs ?? 0);
  if (inKitchen || status === 'ready') return 5000;
  if (paymentStatus === 'refund_pending') return 15_000;
  return null;
}
