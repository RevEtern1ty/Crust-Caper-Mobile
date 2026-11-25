import assert from 'node:assert/strict';
import test from 'node:test';
import { paymentReturnOrderId, savedPaymentReturnOrderId } from './payment-return';

const first = '07f3f2a1-4a76-40a1-923d-30c01321be50';
const latest = '4212aa0c-9be3-4fc6-9dc9-b79c651da531';
const other = '19cca684-ab19-41a7-890b-a1f298a3f997';

test('a payment return selects the referenced saved order even when a newer order exists', () => {
  assert.equal(savedPaymentReturnOrderId(first, [latest, first]), first);
  assert.equal(savedPaymentReturnOrderId(other, [latest, first]), null);
  assert.equal(savedPaymentReturnOrderId(first, []), null);
});

test('a payment return rejects missing, duplicate or malformed order IDs', () => {
  for (const value of [undefined, [first, other], [first], first + '\n', first + '/reorder', 'order-1']) {
    assert.equal(paymentReturnOrderId(value), null);
  }
  assert.equal(paymentReturnOrderId(first), first);
});
