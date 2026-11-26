import assert from 'node:assert/strict';
import { test } from 'node:test';
import { menuAvailability, saleRefreshDelay } from './menu-availability';

test('a sales change is scheduled relative to a valid server observation', () => {
  const checkedAt = '2026-01-05T11:59:30.123456Z';
  const nextChange = '2026-01-05T12:00:00Z';
  const headers = new Headers({
    'X-Availability-Checked-At': checkedAt, 'X-Next-Sale-Change-At': nextChange,
  });
  const availability = menuAvailability(headers);
  assert.deepEqual(availability, { availabilityCheckedAt: checkedAt, nextSaleChangeAt: nextChange });
  assert.equal(saleRefreshDelay(availability), 29_877);
  for (const invalidChange of ['', 'invalid', checkedAt, '2026-01-01T12:00:00Z', '2026-01-13T12:00:00Z']) {
    headers.set('X-Next-Sale-Change-At', invalidChange);
    assert.deepEqual(menuAvailability(headers), { availabilityCheckedAt: checkedAt });
  }
  headers.set('X-Next-Sale-Change-At', nextChange);
  headers.delete('X-Availability-Checked-At');
  assert.deepEqual(menuAvailability(headers), { availabilityCheckedAt: undefined });
});
