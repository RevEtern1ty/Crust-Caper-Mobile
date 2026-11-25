import { deepEqual, equal } from 'node:assert/strict';
import { test } from 'node:test';
import type { CartLine } from '../domain/types';
import { compareReorder } from './reorder-review';

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
