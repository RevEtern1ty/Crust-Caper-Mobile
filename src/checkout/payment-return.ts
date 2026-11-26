import type { CheckoutJournal } from './controller';

const orderIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function paymentReturnOrderId(value: string | string[] | undefined): string | null {
  return typeof value === 'string' && value.length === 36 && orderIdPattern.test(value) ? value : null;
}

export function savedPaymentReturnOrderId(value: string | string[] | undefined, orderIds: string[]): string | null {
  const requestedId = paymentReturnOrderId(value);
  return requestedId && orderIds.includes(requestedId) ? requestedId : null;
}

export function checkoutPaymentReturnOrderId(value: string | string[] | undefined, journal: CheckoutJournal | null): string | null {
  if (!journal) return null;

  const { active, orderIds } = journal;
  const activeOrderId = active && active.phase !== 'creating' ? active.orderId : undefined;
  return savedPaymentReturnOrderId(value, orderIds) ?? savedPaymentReturnOrderId(activeOrderId, orderIds);
}
