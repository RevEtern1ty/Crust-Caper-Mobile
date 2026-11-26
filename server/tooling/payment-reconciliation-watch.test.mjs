import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('./api-error-watch.mjs', import.meta.url));
const first = '11223344-5566-4788-9900-112233445566';
const second = '22334455-6677-4899-aa00-223344556677';

function sample(overrides = {}) {
  return {
    instanceId: first, enabled: true, sweeps: 0, confirmed: 0, pending: 0,
    providerErrors: 0, rejected: 0, settlementErrors: 0, sweepErrors: 0, ...overrides,
  };
}

function run(snapshots) {
  const input = snapshots.map(value => JSON.stringify(value)).join('\n') + '\n';
  const result = spawnSync(process.execPath, [cli, '--payment-reconciliation'], { input, encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stderr, '');
  assert.doesNotMatch(result.stdout, /private-fixture-value|11223344/);
  const events = result.stdout.trim().split('\n').map(JSON.parse);
  assert.ok(events.every(event => event.monitor === 'payment_reconciliation'));
  return events;
}

test('repeated verification failures trigger an incident and idle sweeps cannot clear it', () => {
  const events = run([
    sample(), sample({ sweeps: 4, providerErrors: 1 }),
    sample({ sweeps: 8, providerErrors: 2, ignored: 'private-fixture-value' }),
    sample({ sweeps: 12, providerErrors: 2 }),
    sample({ sweeps: 16, providerErrors: 2, pending: 1 }),
    sample({ sweeps: 20, providerErrors: 2, pending: 1, confirmed: 1 }),
  ]);
  assert.deepEqual(events.map(event => event.event), ['ready', 'incident', 'recovered']);
  assert.equal(events[1].providerErrors, 1);
  assert.equal(events[2].confirmed, 1);
});

test('an idle worker reports a stall and recovers when healthy empty sweeps resume', () => {
  const events = run([sample(), sample(), sample(), sample({ sweeps: 4 }), sample({ sweeps: 8 })]);
  assert.deepEqual(events.map(event => event.event), ['ready', 'incident', 'recovered']);
  assert.equal(events[1].sweeps, 0);
  assert.equal(events[2].sweeps, 4);
});

test('a restart and disabled worker preserve an incident until fresh checks prove recovery', () => {
  const events = run([
    sample(),
    sample({ rejected: 1, sweeps: 1 }),
    sample({ rejected: 1, settlementErrors: 1, sweepErrors: 1, sweeps: 1 }),
    sample({ instanceId: second, enabled: false }),
    sample({ instanceId: second, enabled: false }),
    sample({ instanceId: second, enabled: false }),
  ]);
  assert.deepEqual(events.map(event => event.event), ['ready', 'incident', 'telemetry_unavailable', 'telemetry_restored']);
  assert.equal(events[1].settlementErrors, 1);
  assert.equal(events[1].sweepErrors, 1);
  assert.equal(events[2].reason, 'instance_changed');
  assert.equal(events[3].enabled, false);
  assert.equal(events[3].incidentOpen, true);
});

test('invalid snapshots and counter regression are sanitized and start a new baseline', () => {
  const events = run([
    sample({ enabled: false }), sample({ enabled: false, confirmed: 1, ignored: 'private-fixture-value' }),
    sample({ sweeps: 4 }), sample({ sweeps: 3 }), sample({ sweeps: 5 }),
  ]);
  assert.deepEqual(events.map(event => event.event), [
    'reconciliation_disabled', 'telemetry_unavailable', 'telemetry_restored', 'telemetry_unavailable', 'telemetry_restored',
  ]);
  assert.equal(events[1].reason, 'invalid_snapshot');
  assert.equal(events[3].reason, 'counter_regression');
});
