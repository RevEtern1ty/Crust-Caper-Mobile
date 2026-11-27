import type { Locale, Order } from '../domain/types';
import { kitchenLabel, paymentLabel } from './labels';
import { hasInconsistentPayment } from './pickup-hold';

export type OrderStatusSnapshot = Pick<Order, 'id' | 'status' | 'paymentStatus'>;
type ObservedOrder = OrderStatusSnapshot & Pick<Order, 'paymentAttempt'>;
export type OrderStatusSurface = 'orders' | 'payment';

export function observeOrderStatus(
  previous: OrderStatusSnapshot | null,
  order: ObservedOrder | null,
  locale: Locale,
  surface: OrderStatusSurface,
): { snapshot: OrderStatusSnapshot | null; announcement: string | null } {
  if (!order) return { snapshot: null, announcement: null };
  if (hasInconsistentPayment(order)) {
    return { snapshot: previous?.id === order.id ? previous : null, announcement: null };
  }

  const { id, status, paymentStatus } = order;
  const snapshot = { id, status, paymentStatus };
  if (previous?.id !== id) return { snapshot, announcement: null };

  const changes: string[] = [];
  if (surface === 'orders' && previous.status !== status) changes.push(kitchenLabel(status, locale));
  if (previous.paymentStatus !== paymentStatus) changes.push(paymentLabel(paymentStatus, locale));
  return { snapshot, announcement: changes.length ? changes.join('. ') : null };
}
