import assert from 'node:assert/strict';
import test from 'node:test';

import { kigaliTime, slotLabel } from './format';

test('pickup dates use the chosen month language on the Kigali calendar day', () => {
  const slot = { startsAt: '2026-11-25T22:54:00Z', endsAt: '2026-11-25T23:04:00Z' };
  assert.equal(slotLabel(slot, 'rw'), 'Ugu. 26 · 00:54–01:04');
  assert.equal(kigaliTime(slot.startsAt, 'rw'), 'Ugu. 26 00:54');
  assert.equal(slotLabel(slot, 'en'), '26 Nov · 00:54–01:04');
});
