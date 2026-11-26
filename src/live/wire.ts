import { z } from 'zod';
import { MAX_SHARED_QUANTITY } from '../domain/cart';

const identifier = z.string().min(1).max(128);
const timestamp = z.iso.datetime({ offset: true });
const amount = z.int().min(0);
const localized = z.object({ en: z.string(), rw: z.string() });
const link = z.string().max(2048).nullish().transform(value => value ?? undefined);
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
  modifiers: z.array(z.object({ id: identifier, name: localized, price: amount })),
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

export const orderResponse = z.object({
  id: identifier,
  storeId: identifier,
  slotId: identifier,
  lines: z.array(cartLine),
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
}).refine(value => value.tax <= value.total
  && value.lines.reduce((total, line) => total + line.quantity * line.unitPrice, 0) === value.total
  && Date.parse(value.pickupStartsAt) < Date.parse(value.pickupEndsAt));

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
export const webOrderResponse = orderResponse.safeExtend({ recoveryReadOnly: z.literal(true).optional() });

export const orderAccessChallenge = z.object({ challengeId: z.guid() });
export const orderAccessGrant = z.object({ orderId: z.guid().refine((id) => id === id.toLowerCase()) });
