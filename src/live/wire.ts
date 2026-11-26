import { z } from 'zod';
import { MAX_SHARED_QUANTITY } from '../domain/cart';

const identifier = z.string().min(1).max(128);
const timestamp = z.iso.datetime({ offset: true });
const amount = z.int().min(0);
const localized = z.object({ en: z.string(), rw: z.string() });
const link = z.string().max(2048).nullish().transform(value => value ?? undefined);
const modifier = z.object({ id: identifier, name: localized, price: amount });
const slot = z.object({ id: identifier, startsAt: timestamp, endsAt: timestamp, available: z.boolean() })
  .refine(value => Date.parse(value.startsAt) < Date.parse(value.endsAt));

const product = z.object({
  sku: identifier,
  category: z.enum(['burgers', 'combos', 'sides', 'drinks']),
  name: localized,
  description: localized,
  ingredients: z.array(localized),
  allergens: z.array(localized),
  price: amount,
  available: z.boolean(),
  modifiers: z.array(modifier),
  photoUrl: link,
});

export const menuResponse = z.object({
  version: identifier,
  updatedAt: timestamp,
  store: z.object({
    id: identifier,
    name: localized,
    area: localized,
    open: z.boolean(),
    hours: localized,
    supportUrl: link,
    directionsUrl: link,
  }),
  products: z.array(product),
  slots: z.array(slot),
  orderingUnavailable: z.literal(true).optional(),
});

const cartLine = z.object({
  sku: identifier,
  modifierIds: z.array(identifier),
  quantity: z.int().min(1).max(MAX_SHARED_QUANTITY),
  unitPrice: amount,
});
const orderLine = cartLine.extend({
  soldItem: z.object({
    catalogVersion: identifier,
    name: localized,
    ingredients: z.array(localized),
    allergens: z.array(localized),
    modifiers: z.array(modifier),
  }).optional(),
}).refine(({ soldItem, modifierIds }) => {
  if (!soldItem) return true;
  const selected = soldItem.modifiers;
  return selected.length === modifierIds.length
    && new Set(selected.map(({ id }) => id)).size === selected.length
    && selected.every(({ id }) => modifierIds.includes(id));
}, { path: ['soldItem', 'modifiers'] });
const change = z.object({
  kind: z.enum(['price', 'unavailable', 'slot']),
  sku: identifier.nullish().transform(value => value ?? undefined),
  previousPrice: amount.nullish().transform(value => value ?? undefined),
  currentPrice: amount.nullish().transform(value => value ?? undefined),
});
const priceChanges = z.object({ lines: z.array(cartLine), changes: z.array(change) });
export const reorderResponse = priceChanges;
export const quoteResponse = priceChanges.extend({
  quoteId: identifier,
  storeId: identifier,
  slotId: identifier,
  subtotal: amount,
  tax: amount,
  total: amount,
  currency: z.literal('RWF'),
  expiresAt: timestamp,
  pickupStartsAt: timestamp,
  pickupEndsAt: timestamp,
}).refine(value => value.subtotal + value.tax === value.total
  && value.lines.reduce((total, line) => total + line.quantity * line.unitPrice, 0) === value.total
  && Date.parse(value.pickupStartsAt) < Date.parse(value.pickupEndsAt));

export const paymentResponse = z.object({
  id: identifier,
  status: z.enum(['processing', 'paid', 'declined']),
  checkoutUrl: z.string().max(2048).nullable(),
});

const orderFields = z.object({
  id: identifier,
  storeId: identifier,
  slotId: identifier,
  lines: z.array(orderLine),
  total: amount,
  tax: amount,
  currency: z.literal('RWF'),
  paymentStatus: z.enum(['unpaid', 'processing', 'paid', 'declined', 'refund_pending', 'refunded']),
  status: z.enum(['awaiting_payment', 'accepted', 'preparing', 'ready', 'collected', 'cancelled']),
  pickupCode: z.string().max(40).nullable(),
  receiptStatus: z.enum(['pending', 'issued', 'corrected']),
  receiptUrl: z.string().max(2048).nullable(),
  paymentAttempt: paymentResponse.nullable(),
  createdAt: timestamp,
  reservationExpiresAt: timestamp,
  pickupStartsAt: timestamp,
  pickupEndsAt: timestamp,
});

function validOrderTotals(value: Pick<z.infer<typeof orderFields>, 'tax' | 'total' | 'lines' | 'pickupStartsAt' | 'pickupEndsAt'>) {
  return value.tax <= value.total
    && value.lines.reduce((total, line) => total + line.quantity * line.unitPrice, 0) === value.total
    && Date.parse(value.pickupStartsAt) < Date.parse(value.pickupEndsAt);
}

export const orderResponse = orderFields.extend({ recoveryReadOnly: z.literal(true).optional() }).refine(validOrderTotals);

const canonicalId = z.guid().refine(value => value === value.toLowerCase());
export const orderDataExportResponse = z.strictObject({
  ...orderFields.pick({ storeId: true, lines: true, total: true, tax: true, currency: true, status: true,
    paymentStatus: true, receiptStatus: true, createdAt: true, pickupStartsAt: true, pickupEndsAt: true }).shape,
  orderId: canonicalId,
  phone: z.string().regex(/^\+[1-9][0-9]{7,14}$/),
  email: z.string().min(1).max(254).nullable(),
}).refine(validOrderTotals);

const erasureRequest = z.strictObject({
  requestId: canonicalId,
  submittedAt: timestamp,
  status: z.enum(['pending', 'in_review']),
  reviewedAt: timestamp.nullable(),
}).refine(value => value.status === 'pending' ? value.reviewedAt === null
  : value.reviewedAt !== null && Date.parse(value.reviewedAt) >= Date.parse(value.submittedAt));

export const orderErasureRequestResponse = z.strictObject({ request: erasureRequest.nullable() });

export const sessionResponse = z.object({
  sessionId: z.guid().optional(),
  accessToken: z.string().min(32).max(512).regex(/^[A-Za-z0-9_-]+$/),
  expiresAt: timestamp,
  refreshToken: z.string().min(32).max(512).regex(/^[A-Za-z0-9_-]+$/),
  refreshExpiresAt: timestamp,
});

export const webSessionResponse = z.strictObject({
  sessionId: z.guid().refine(value => value === value.toLowerCase()),
  expiresAt: timestamp,
});
export const webOrderResponse = orderResponse;

export const orderAccessChallenge = z.object({ challengeId: z.guid() });
export const orderAccessGrant = z.object({ orderId: z.guid().refine((id) => id === id.toLowerCase()) });
export const pendingCheckoutRecovery = z.discriminatedUnion('state', [
  z.object({ state: z.literal('waiting'), retryAt: timestamp }),
  z.object({ state: z.literal('not_placed') }),
  z.object({ state: z.literal('verify'), challengeId: z.guid() }),
]);
