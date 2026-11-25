import type { Order } from '../domain/types';
import { savedPaymentReturnOrderId } from './payment-return';

export const PICKUP_READY = 'pickup-ready';

export function canEnablePickupAlert(order: Pick<Order, 'status' | 'paymentStatus'>) {
  return order.paymentStatus === 'paid' && (order.status === 'accepted' || order.status === 'preparing');
}

export function savedPickupAlertOrderId(data: unknown, orderIds: string[]): string | null {
  if (!data || typeof data !== 'object' || !('type' in data) || data.type !== PICKUP_READY
    || !('orderId' in data) || typeof data.orderId !== 'string') return null;
  return savedPaymentReturnOrderId(data.orderId, orderIds);
}
