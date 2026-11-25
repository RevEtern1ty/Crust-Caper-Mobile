import { deepEqual, equal } from 'node:assert/strict';
import { test } from 'node:test';
import type { CartLine, Product } from '../domain/types';
import { cartLineUnavailable, reviewCheckoutCart } from './cart-review';

const title = { en: 'Double Smash', rw: 'Double Smash' };
const cheese = { id: 'extra-cheese', name: { en: 'Extra cheese', rw: 'Foromaje y’inyongera' }, price: 500 };
const product: Product = {
  sku: 'double-smash', category: 'burgers', name: title, description: title,
  ingredients: [], allergens: [], price: 9200, available: true, modifiers: [cheese],
};
const original: CartLine = { sku: product.sku, modifierIds: [], quantity: 1, unitPrice: 9200 };
const withCheese: CartLine = { ...original, modifierIds: [cheese.id], quantity: 2, unitPrice: 9700 };

test('a price-only change keeps the configured basket and can be reviewed for confirmation', () => {
  const current = { ...withCheese, unitPrice: 10_200 };
  const result = reviewCheckoutCart([original, withCheese], { lines: [current, original], changes: [{ kind: 'price', sku: product.sku }] });
  deepEqual(result.available[0], { previous: withCheese, current });
  equal(result.requiresCartEdit, false);
});

test('a missing configuration or quantity change cannot confirm a smaller basket', () => {
  const reducedBasket = reviewCheckoutCart([original, withCheese], { lines: [original], changes: [] });
  deepEqual(reducedBasket.removed, [withCheese]);
  equal(reducedBasket.requiresCartEdit, true);
  for (const lines of [[], [original, { ...withCheese, quantity: 1 }], [original, { ...withCheese, modifierIds: [] }]]) {
    equal(reviewCheckoutCart([original, withCheese], { lines, changes: [] }).requiresCartEdit, true);
  }
  equal(reviewCheckoutCart([original], { lines: [original], changes: [{ kind: 'unavailable' }] }).requiresCartEdit, true);
});

test('cart distinguishes unavailable products from fixable options without removing either', () => {
  equal(cartLineUnavailable(withCheese, undefined), 'item');
  equal(cartLineUnavailable(withCheese, { ...product, available: false }), 'item');
  equal(cartLineUnavailable(withCheese, { ...product, modifiers: [] }), 'options');
  equal(cartLineUnavailable(withCheese, product), null);
  deepEqual(withCheese.modifierIds, [cheese.id]);
});
