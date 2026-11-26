import type { Order, PaymentAttempt } from '../domain/types';

export type HoldState = Pick<Order, 'status' | 'paymentStatus'> & { paymentAttempt?: Pick<PaymentAttempt, 'status'> | null };

function hasUnpaidStatus({ paymentStatus }: HoldState): boolean {
  return paymentStatus === 'unpaid' || paymentStatus === 'declined';
}

export function hasInconsistentPayment(order: HoldState): boolean {
  // The order and its latest attempt can be read on opposite sides of a payment update.
  const attempt = order.paymentAttempt?.status;
  return hasUnpaidStatus(order) && (attempt === 'processing' || attempt === 'paid');
}

export function isAwaitingUnpaidHold(order: HoldState): boolean {
  return order.status === 'awaiting_payment' && hasUnpaidStatus(order) && !hasInconsistentPayment(order);
}

export function isExpiredUnpaidHold(order: HoldState): boolean {
  // The server can end an unpaid hold early. Restaurant cancellations of paid orders have a refund status.
  return order.status === 'cancelled' && hasUnpaidStatus(order) && !hasInconsistentPayment(order);
}
