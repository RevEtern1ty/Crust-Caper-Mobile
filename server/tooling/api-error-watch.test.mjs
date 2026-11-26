import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createApiErrorWatch, watchApiErrorSamples } from './api-error-watch.mjs';

const instanceId = '11223344-5566-4788-9900-112233445566';
const nextInstance = '22334455-6677-4899-aa00-223344556677';
const cli = fileURLToPath(new URL('./api-error-watch.mjs', import.meta.url));

function sample(requests, serverErrors, instance = instanceId) {
  return { instanceId: instance, requests, serverErrors };
}

test('opens only after high rates in two consecutive windows and counts the exact boundary', () => {
  const watch = createApiErrorWatch();
  const inputs = [
    sample(20, 0), sample(80, 3), sample(120, 5), sample(180, 8),
    sample(280, 12), sample(340, 15), sample(400, 18), sample(460, 21),
  ];
  assert.deepEqual(inputs.map(snapshot => watch.observe(snapshot)), [
    { event: 'ready' }, null, null, null, null, null,
    { event: 'incident', requests: 60, serverErrors: 3, errorRatePercent: 5 }, null,
  ]);
});

test('low traffic errors and idle windows do not clear a confirmed incident', () => {
  const watch = createApiErrorWatch();
  const inputs = [
    sample(0, 0), sample(4, 3), sample(8, 6), sample(9, 7), sample(11, 7),
    sample(11, 7), sample(31, 8), sample(131, 10), sample(134, 10),
  ];
  assert.deepEqual(inputs.map(snapshot => watch.observe(snapshot)), [
    { event: 'ready' }, null,
    { event: 'incident', requests: 4, serverErrors: 3, errorRatePercent: 75 },
    null, null, null, null, null,
    { event: 'recovered', requests: 3, serverErrors: 0, errorRatePercent: 0 },
  ]);
});

test('an unreadable sample or a process replacement requires a fresh baseline and keeps an open incident', () => {
  const watch = createApiErrorWatch();
  const inputs = [
    sample(0, 0), sample(3, 3), sample(6, 6), sample(10, 6),
    {}, sample(321, 4, nextInstance), sample(41, 5, nextInstance),
    sample(102, 3, nextInstance), sample(102, 4, nextInstance),
    sample(1, 0), sample(4, 0, nextInstance), sample(6, 0, nextInstance),
    sample(10, 0, nextInstance), sample(15, 0, nextInstance),
  ];
  assert.deepEqual(inputs.map(snapshot => watch.observe(snapshot)), [
    { event: 'ready' }, null, { event: 'incident', requests: 3, serverErrors: 3, errorRatePercent: 100 },
    null, { event: 'telemetry_unavailable', reason: 'invalid_snapshot', incidentOpen: true },
    { event: 'telemetry_restored', incidentOpen: true },
    { event: 'telemetry_unavailable', reason: 'counter_regression', incidentOpen: true },
    { event: 'telemetry_restored', incidentOpen: true },
    { event: 'telemetry_unavailable', reason: 'invalid_delta', incidentOpen: true },
    { event: 'telemetry_restored', incidentOpen: true },
    { event: 'telemetry_unavailable', reason: 'instance_changed', incidentOpen: true },
    { event: 'telemetry_restored', incidentOpen: true }, null,
    { event: 'recovered', requests: 5, serverErrors: 0, errorRatePercent: 0 },
  ]);
});

test('ignores invalid and repeated unreadable snapshots without echoing their fields', () => {
  const watch = createApiErrorWatch();
  for (const input of [null, [], sample(-1, 0), sample(1, 2), sample(1.5, 1),
    sample(Number.MAX_SAFE_INTEGER + 1, 0), sample(1, 0, 'private-identifier')]) {
    const event = watch.observe(input);
    if (input === null) {
      assert.deepEqual(event, { event: 'telemetry_unavailable', reason: 'invalid_snapshot', incidentOpen: false });
    } else {
      assert.equal(event, null);
    }
  }
  assert.deepEqual(watch.observe(sample(1, 0)), { event: 'telemetry_restored', incidentOpen: false });
});

test('a silent producer reports missing telemetry and cannot close an incident with the first new sample',
  { timeout: 2000 }, async () => {
    const pause = Promise.withResolvers();
    async function* snapshots() {
      yield sample(0, 0);
      yield sample(3, 3);
      yield sample(6, 6);
      await pause.promise;
      yield sample(50, 6);
      yield sample(56, 6);
      yield sample(62, 6);
    }
    const events = watchApiErrorSamples(snapshots(), 15);
    assert.equal((await events.next()).value.event, 'ready');
    assert.equal((await events.next()).value.event, 'incident');
    assert.deepEqual((await events.next()).value,
      { event: 'telemetry_unavailable', reason: 'sample_timeout', incidentOpen: true });
    pause.resolve();
    assert.deepEqual((await events.next()).value, { event: 'telemetry_restored', incidentOpen: true });
    assert.deepEqual((await events.next()).value, { event: 'recovered', requests: 6, serverErrors: 0, errorRatePercent: 0 });
    assert.equal((await events.next()).done, true);
  });

test('CLI delivers sanitized events, resumes at the next line and reports a closed input stream', () => {
  const input = Buffer.concat([
    Buffer.from(JSON.stringify(sample(0, 0)) + '\n' + 'private-payload'.repeat(20_000) + '\n'),
    Buffer.from([0xff, 0xfe, 10]),
    Buffer.from([sample(3, 3), sample(6, 6), sample(9, 9), sample(15, 9), sample(21, 9)]
      .map(snapshot => JSON.stringify(snapshot)).join('\n') + '\n'),
  ]);
  const output = spawnSync(process.execPath, [cli], { input, encoding: 'utf8', timeout: 7000, windowsHide: true });
  assert.equal(output.error, undefined);
  assert.equal(output.status, 1);
  assert.doesNotMatch(output.stdout + output.stderr, /private-payload|11223344/);
  const events = output.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(events, [
    { event: 'ready' },
    { event: 'telemetry_unavailable', reason: 'invalid_snapshot', incidentOpen: false },
    { event: 'telemetry_restored', incidentOpen: false },
    { event: 'incident', requests: 3, serverErrors: 3, errorRatePercent: 100 },
    { event: 'recovered', requests: 6, serverErrors: 0, errorRatePercent: 0 },
  ]);
});
