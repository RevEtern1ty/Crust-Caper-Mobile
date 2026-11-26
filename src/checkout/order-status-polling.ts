import { ApiError, type Order } from '../domain/types';

export type OrderStatusResult = { order: Pick<Order, 'status' | 'paymentStatus'> } | { error: unknown };

export function nextOrderStatusDelay(
  mode: 'demo' | 'connected',
  result: OrderStatusResult,
  attempts: number,
  consecutiveFailures: number,
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
