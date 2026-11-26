import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../domain/types';
import { checkoutError } from './labels';

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
