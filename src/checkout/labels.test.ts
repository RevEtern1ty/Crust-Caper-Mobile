import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError, type Menu, type OrderLine } from '../domain/types';
import { checkoutError, orderItemLabels } from './labels';

const id = 'adbea8a5-0bea-4f67-9167-637437432fcf';

test('checkout displays one localized support number for a correlated API error', () => {
  const error = new ApiError('service_unavailable', { requestId: id });
  assert.match(checkoutError(error, 'en'), new RegExp(`\nSupport ID ${id}$`));
  assert.match(checkoutError(error, 'rw'), new RegExp(`\nNomero y’ubufasha ${id}$`));
  assert.equal(checkoutError(error, 'en').split(id).length, 2);
});

test('checkout uses the normal error message when a valid support number is unavailable', () => {
  const untrusted = new ApiError('service_unavailable', { requestId: 'private-data' });
  assert.equal(checkoutError(untrusted, 'en'), checkoutError(new ApiError('service_unavailable'), 'en'));
  assert.equal(checkoutError(Object.assign(new Error('private-data'), { requestId: id }), 'en'),
    'Unable to complete the request. Try again.');
});

test('saved orders show the purchase names while legacy orders keep their existing fallback', () => {
  const line = { sku: 'double-smash', modifierIds: ['extra-cheese'], quantity: 1, unitPrice: 9700 };
  const archived: OrderLine = {
    ...line,
    soldItem: {
      catalogVersion: 'sale-1', name: { en: 'Original burger', rw: 'Burgeri ya mbere' },
      ingredients: [], allergens: [],
      modifiers: [{ id: 'extra-cheese', name: { en: 'Extra cheese', rw: 'Foromaje y’inyongera' }, price: 500 }],
    },
  };
  const menu: Menu = {
    version: 'catalog-2', updatedAt: '2026-11-25T10:00:00Z', slots: [],
    store: {
      id: 'kigali', open: true, name: { en: 'CrustCaper Kigali', rw: 'CrustCaper Kigali' },
      area: { en: 'Kigali', rw: 'Kigali' }, hours: { en: '10:00–18:00', rw: '10:00–18:00' },
    },
    products: [{
      sku: line.sku, name: { en: 'New burger', rw: 'Burgeri nshya' },
      description: { en: 'New recipe', rw: 'Uburyo bushya' },
      category: 'burgers', ingredients: [], allergens: [], price: 9900, available: true,
      modifiers: [],
    }],
  };
  assert.deepEqual(orderItemLabels(archived, 'en', menu), { name: 'Original burger', options: 'Extra cheese' });
  assert.deepEqual(orderItemLabels(archived, 'rw', { ...menu, products: [] }),
    { name: 'Burgeri ya mbere', options: 'Foromaje y’inyongera' });
  assert.deepEqual(orderItemLabels(line, 'en', menu), { name: 'New burger', options: 'extra-cheese' });
  assert.deepEqual(orderItemLabels(line, 'en', null), { name: 'double-smash', options: 'extra-cheese' });
});
