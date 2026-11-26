import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';
import { isMainModule } from './check-live-catalog.mjs';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const maxLineBytes = 1024;
const requiredWindows = 2;
const minimumErrors = 3;
const rateDivisor = 20n; // Five percent is exactly one in twenty requests.

function readSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { instanceId, requests, serverErrors } = value;
  if (typeof instanceId !== 'string' || instanceId.length !== 36 || !uuid.test(instanceId)
    || !Number.isSafeInteger(requests) || requests < 0
    || !Number.isSafeInteger(serverErrors) || serverErrors < 0 || serverErrors > requests) return null;
  return { instanceId: instanceId.toLowerCase(), requests, serverErrors };
}

export function createApiErrorWatch() {
  let baseline = null;
  let telemetryMissing = false;
  let incidentOpen = false;
  let streak = 0;

  function recordGap(reason) {
    baseline = null;
    streak = 0;
    if (telemetryMissing) return null;
    telemetryMissing = true;
    return { event: 'telemetry_unavailable', reason, incidentOpen };
  }

  function observe(value) {
    const next = readSnapshot(value);
    if (!next) return recordGap('invalid_snapshot');
    if (!baseline) {
      baseline = next;
      if (telemetryMissing) {
        telemetryMissing = false;
        return { event: 'telemetry_restored', incidentOpen };
      }
      return { event: 'ready' };
    }
    if (next.instanceId !== baseline.instanceId) return recordGap('instance_changed');

    const requests = next.requests - baseline.requests;
    const serverErrors = next.serverErrors - baseline.serverErrors;
    if (requests < 0 || serverErrors < 0) return recordGap('counter_regression');
    if (serverErrors > requests) return recordGap('invalid_delta');
    baseline = next;

    const highRate = BigInt(serverErrors) * rateDivisor >= BigInt(requests);
    const canTransition = requests > 0 && (incidentOpen ? !highRate : highRate && serverErrors >= minimumErrors);
    if (!canTransition) {
      streak = 0;
      return null;
    }
    streak++;
    if (streak < requiredWindows) return null;

    streak = 0;
    incidentOpen = !incidentOpen;
    return {
      event: incidentOpen ? 'incident' : 'recovered',
      requests,
      serverErrors,
      errorRatePercent: Math.round((serverErrors / requests) * 10_000) / 100,
    };
  }

  return { observe };
}

async function* readSnapshots(input) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  // Keep only the bounded current line. One extra byte allows a trailing CR before LF.
  const line = Buffer.alloc(maxLineBytes + 1);
  let length = 0;
  let oversized = false;

  function append(bytes) {
    if (oversized) return;
    if (length + bytes.length > line.length) oversized = true;
    else {
      bytes.copy(line, length);
      length += bytes.length;
    }
  }

  function finishLine() {
    const contentLength = length > 0 && line[length - 1] === 13 ? length - 1 : length;
    const validLength = !oversized && contentLength <= maxLineBytes;
    length = 0;
    oversized = false;
    if (!validLength) return null;
    try {
      return JSON.parse(decoder.decode(line.subarray(0, contentLength)));
    } catch {
      return null;
    }
  }

  for await (const chunk of input) {
    let start = 0;
    let end;
    while ((end = chunk.indexOf(10, start)) !== -1) {
      append(chunk.subarray(start, end));
      yield finishLine();
      start = end + 1;
    }
    append(chunk.subarray(start));
  }
  if (length || oversized) yield finishLine();
}

function writeEvent(event) {
  return new Promise((resolve, reject) => {
    process.stdout.write(JSON.stringify(event) + '\n', error => error ? reject(error) : resolve());
  });
}

async function main() {
  if (process.argv.length !== 2) {
    console.error('Usage: node server/tooling/api-error-watch.mjs');
    process.exitCode = 2;
    return;
  }
  const watch = createApiErrorWatch();
  let stopping = false;
  const stop = () => {
    stopping = true;
    process.stdin.destroy();
    // An unattended pipe may stop draining. Bound only the explicit shutdown.
    if (process.stdout.writableLength > 0) setTimeout(() => process.exit(0), 1000).unref();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.stdout.on('error', () => process.stdin.destroy());
  try {
    for await (const snapshot of readSnapshots(process.stdin)) {
      if (stopping) break;
      const event = watch.observe(snapshot);
      if (event) await writeEvent(event);
    }
  } catch (error) {
    if (!stopping) throw error;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
  // Unexpected EOF ends observation even when the last snapshot was healthy.
  process.exitCode = stopping ? 0 : 1;
}

if (isMainModule(import.meta)) {
  try {
    await main();
  } catch {
    console.error('api_error_watch_failed');
    process.exitCode = 1;
  }
}
