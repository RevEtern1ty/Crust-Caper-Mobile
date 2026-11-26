import { deepEqual, equal } from 'node:assert/strict';
import { test } from 'node:test';
import type { CartLine } from '../domain/types';
import { readDraft } from '../state/draft-storage';
import { compareReorder, reorderOfferForCart } from './reorder-review';

const original: CartLine = { sku: 'double-smash', modifierIds: [], quantity: 1, unitPrice: 9200 };
const withoutPickles: CartLine = { ...original, modifierIds: ['no-pickles'] };

test('equal-price variants are paired with their own options, independent of response order', () => {
  const extraCheese: CartLine = { ...original, modifierIds: ['extra-cheese', 'no-pickles'], unitPrice: 9700 };
  const reorderedOptions = { ...extraCheese, modifierIds: ['no-pickles', 'extra-cheese'] };
  const review = compareReorder([original, withoutPickles, extraCheese], [withoutPickles, reorderedOptions, original]);

  deepEqual(review.available, [
    { current: withoutPickles, previous: withoutPickles },
    { current: reorderedOptions, previous: extraCheese },
    { current: original, previous: original },
  ]);
  deepEqual(review.removed, []);
  equal(review.originalTotal, review.estimate);
});

test('reorder exposes a changed price and an unavailable configuration of the same SKU', () => {
  const doubled = { ...withoutPickles, quantity: 2 };
  const newPrice = { ...original, unitPrice: 9600 };
  const review = compareReorder([doubled, original], [newPrice]);

  deepEqual(review.available, [{ current: newPrice, previous: original }]);
  deepEqual(review.removed, [doubled]);
  equal(review.originalTotal, 27_600);
  equal(review.estimate, 9600);
});

test('an empty offer leaves all original configurations out of the proposed cart', () => {
  const orderLines = [original, withoutPickles];
  const review = compareReorder(orderLines, []);

  deepEqual(review.available, []);
  deepEqual(review.removed, orderLines);
  equal(review.estimate, 0);
  equal(orderLines.length, 2);
});

test('reorder previews a quantity change before placing persistable lines in the cart', () => {
  const largeOrder = { ...original, quantity: 12 };
  const repricedLargeOrder = { ...largeOrder, unitPrice: 9500 };
  const offer = {
    lines: [repricedLargeOrder, withoutPickles],
    changes: [{ kind: 'price' as const, sku: original.sku, previousPrice: 9200, currentPrice: 9500 }],
  };
  const proposal = reorderOfferForCart(offer);
  const preview = compareReorder([largeOrder, withoutPickles], proposal.lines);
  const capped = { ...repricedLargeOrder, quantity: 9 };
  deepEqual(preview.available, [
    { previous: largeOrder, current: capped },
    { previous: withoutPickles, current: withoutPickles },
  ]);
  equal(preview.estimate, 9 * 9500 + 9200);
  equal(repricedLargeOrder.quantity, 12);
  deepEqual(proposal.changes, offer.changes);
  deepEqual(readDraft(JSON.stringify({ locale: 'rw', cart: proposal.lines })).cart, [capped, withoutPickles]);
});
