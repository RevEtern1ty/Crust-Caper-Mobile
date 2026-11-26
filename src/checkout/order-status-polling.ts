import { ApiError, type Order } from '../domain/types';
import { isAwaitingUnpaidHold } from './pickup-hold';

type PolledOrder = Pick<Order, 'status' | 'paymentStatus'> & Partial<Pick<Order, 'reservationExpiresAt'>>;
export type OrderStatusResult = { order: PolledOrder } | { error: unknown };

const unpaidHoldCheckIntervalMs = 60_000;
const overdueHoldCheckIntervalMs = 15_000;
const holdDeadlineGraceMs = 1000;

export function nextOrderStatusDelay(
  mode: 'demo' | 'connected',
  result: OrderStatusResult,
  attempts: number,
  consecutiveFailures: number,
  now = Date.now(),
): number | null {
  if ('error' in result) {
    const code = result.error instanceof ApiError ? result.error.code : null;
    if (code === 'unauthenticated' || code === 'not_found') return null;
    if (mode === 'demo') return attempts < 9 ? 3000 : null;
    if (code === 'rate_limited') return 15_000;
    if (code === 'network_unavailable' || code === 'service_unavailable') {
      return 5000 * Math.min(consecutiveFailures, 3);
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
  if (mode === 'demo') {
    return attempts < 9 && (inKitchen || paymentStatus === 'processing') ? 3000 : null;
  }
  if (inKitchen || status === 'ready') return 5000;
  if (paymentStatus === 'processing') return 3000;
  if (paymentStatus === 'refund_pending') return 15_000;
  return null;
}
