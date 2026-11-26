import assert from 'node:assert/strict';
import test from 'node:test';
import type { CheckoutJournal } from './controller';
import { checkoutPaymentReturnOrderId, paymentReturnOrderId, savedPaymentReturnOrderId } from './payment-return';

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

test('a return with an unavailable order ID selects the active checkout rather than a historical selection', () => {
  const journal: CheckoutJournal = {
    version: 1, active: { phase: 'paying', orderId: latest, key: 'payment-attempt' }, orderIds: [first, latest],
  };
  for (const input of [undefined, other, 'malformed', [latest, first]]) {
    assert.equal(checkoutPaymentReturnOrderId(input, journal), latest);
  }
  assert.equal(checkoutPaymentReturnOrderId(first, journal), first);
});

test('a return with no confirmed active order never selects an unsaved ID', () => {
  const journal: CheckoutJournal = {
    version: 1, active: { phase: 'creating', quoteId: 'quote', key: 'intent', cartFingerprint: 'cart' },
    orderIds: [first],
  };
  assert.equal(checkoutPaymentReturnOrderId(other, journal), null);
  assert.equal(checkoutPaymentReturnOrderId(first, null), null);
  assert.equal(checkoutPaymentReturnOrderId(other, { ...journal, active: null }), null);
});
