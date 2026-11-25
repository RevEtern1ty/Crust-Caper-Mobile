import { ApiError, type CartLine, type KitchenStatus, type Locale, type Menu, type PaymentStatus, type QuoteChange } from '../domain/types';
import { copy, money } from '../ui/format';
import { CheckoutError } from './controller';

const kitchenStatus: Record<KitchenStatus, [string, string]> = {
  awaiting_payment: ['Awaiting payment', 'Gutegereza ubwishyu'],
  accepted: ['Order accepted', 'Komande yemejwe'],
  preparing: ['In the kitchen', 'Iri gutegurwa'],
  ready: ['Ready for pickup', 'Yiteguye gufatwa'],
  collected: ['Picked up', 'Yafashwe'],
  cancelled: ['Order cancelled', 'Komande yahagaritswe'],
};

const paymentStatus: Record<PaymentStatus, [string, string]> = {
  unpaid: ['Unpaid', 'Ntiyishyuwe'],
  processing: ['Checking payment', 'Kugenzura ubwishyu'],
  paid: ['Paid', 'Yishyuwe'],
  declined: ['Payment declined', 'Ubwishyu bwanzwe'],
  refund_pending: ['Refund pending', 'Gutegereza gusubizwa amafaranga'],
  refunded: ['Refunded', 'Amafaranga yasubijwe'],
};

export function kitchenLabel(status: KitchenStatus, locale: Locale) {
  return copy(locale, ...kitchenStatus[status]);
}

export function paymentLabel(status: PaymentStatus, locale: Locale) {
  return copy(locale, ...paymentStatus[status]);
}

export function itemName(sku: string, locale: Locale, menu: Menu | null) {
  return menu?.products.find((product) => product.sku === sku)?.name[locale] ?? sku;
}

export function itemOptions(line: CartLine, locale: Locale, menu: Menu | null) {
  const modifiers = menu?.products.find((product) => product.sku === line.sku)?.modifiers;
  return line.modifierIds.map((id) => modifiers?.find((modifier) => modifier.id === id)?.name[locale] ?? id).join(' · ');
}

export function displayOrderId(id: string) {
  return `#${id.slice(-8).toUpperCase()}`;
}

export function changeLabel(change: QuoteChange, locale: Locale, menu: Menu | null) {
  const name = change.sku ? itemName(change.sku, locale, menu) : copy(locale, 'Item', 'Ibiribwa');
  if (change.kind === 'price' && change.previousPrice !== undefined && change.currentPrice !== undefined) {
    return `${name} · ${money(change.previousPrice)} → ${money(change.currentPrice)}`;
  }
  if (change.kind === 'unavailable') {
    return copy(locale, `${name} is unavailable.`, `${name} ntiboneka.`);
  }
  return copy(locale, 'Pickup availability changed.', 'Igihe cyo gufata komande cyahindutse.');
}

export function checkoutError(error: unknown, locale: Locale) {
  if (error instanceof CheckoutError && error.code === 'active_checkout') {
    return copy(locale, 'Continue the current order from Orders.', 'Komeza komande yawe muri Komande.');
  }
  if (error instanceof CheckoutError && error.code === 'invalid_journal') {
    return copy(locale, 'The saved order could not be opened.', 'Komande yabitswe ntishobora gufungurwa.');
  }
  if (error instanceof ApiError) {
    switch (error.code) {
      case 'quote_expired':
      case 'quote_changed':
        return copy(locale, 'Your quote changed or expired. Review the order again.', 'Igiciro cyahindutse cyangwa igihe cyacyo cyarangiye. Ongera urebe komande.');
      case 'slot_unavailable':
        return copy(locale, 'This pickup time is unavailable. Choose a different time.', 'Iki gihe cyo gufata komande ntikiboneka. Hitamo ikindi.');
      case 'invalid_input':
        return copy(locale, 'Check the demo phone number and the items in your cart.', 'Genzura nimero y’igerageza n’ibiri mu gatebo kawe.');
      case 'reservation_expired':
        return copy(locale, 'Your pickup hold expired. Choose a new time.', 'Igihe cyabikiwe komande cyarangiye. Hitamo ikindi.');
      case 'payment_pending':
        return copy(locale, 'The payment is still being checked. Check Orders for updates.', 'Ubwishyu buracyagenzurwa. Reba muri Komande.');
      case 'not_found':
        return copy(locale, 'This order is unavailable on this device.', 'Iyi komande ntiboneka kuri iki gikoresho.');
      case 'storage_unavailable':
        return copy(locale, 'Saved checkout data is unavailable. Try again.', 'Amakuru y’ubwishyu yabitswe ntaboneka. Ongera ugerageze.');
      case 'conflict':
        return copy(locale, 'Your last request is unresolved. Check its status in Orders.', 'Icyifuzo cya nyuma ntikirarangira. Reba uko gihagaze muri Komande.');
    }
  }
  return copy(locale, 'Unable to complete the request. Try again.', 'Icyifuzo nticyarangiye. Ongera ugerageze.');
}
