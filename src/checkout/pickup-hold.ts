import type { Order } from '../domain/types';

type HoldState = Pick<Order, 'status' | 'paymentStatus'>;

function hasUnpaidStatus({ paymentStatus }: HoldState): boolean {
  return paymentStatus === 'unpaid' || paymentStatus === 'declined';
}

export function isAwaitingUnpaidHold(order: HoldState): boolean {
  return order.status === 'awaiting_payment' && hasUnpaidStatus(order);
}

export function isExpiredUnpaidHold(order: HoldState): boolean {
  // The server can end an unpaid hold early. Restaurant cancellations of paid orders have a refund status.
  return order.status === 'cancelled' && hasUnpaidStatus(order);
}
