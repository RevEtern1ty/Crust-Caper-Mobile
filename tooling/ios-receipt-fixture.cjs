const { createHash } = require('node:crypto');
const { lstat, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { testReceipt } = require('../tests/receipt-fixture.cjs');

const operatorApi = 'http://127.0.0.1:18080/api/v1/operator';
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

async function attachReceiptFixture(evidenceDirectory, {
  signal, fetchImpl = fetch, timeoutMs = 270_000, intervalMs = 2_000,
} = {}) {
  const ready = join(evidenceDirectory, 'receipt-fixture.ready');
  const result = join(evidenceDirectory, 'receipt-fixture.json');
  const fileOptions = { flag: 'wx', mode: 0o600 };
  for (const path of [ready, result]) {
    const existing = await lstat(path).catch(error => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (existing) throw new Error('Receipt fixture evidence already exists. Use an empty evidence directory.');
  }
  if (!(await lstat(evidenceDirectory)).isDirectory()) throw new Error('Expected an existing evidence directory.');

  let token;
  let proof;
  async function request(method, path, expectedStatus, label, { headers, body, abort } = {}) {
    const requestTimeout = AbortSignal.timeout(8_000);
    const response = await fetchImpl(operatorApi + path, {
      method, body, redirect: 'error',
      headers: {
        Accept: 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...headers,
      },
      signal: abort ? AbortSignal.any([abort, requestTimeout]) : requestTimeout,
    }).catch(() => {
      abort?.throwIfAborted();
      throw new Error(`${label} failed to reach the local API.`);
    });
    if (response.status !== expectedStatus) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`${label} returned HTTP ${response.status} (expected ${expectedStatus}).`);
    }
    if (expectedStatus === 204) return;
    return response.json().catch(() => {
      abort?.throwIfAborted();
      throw new Error(`${label} did not return valid JSON.`);
    });
  }

  signal?.throwIfAborted();
  try {
    const session = await request('POST', '/sessions', 201, 'Manager sign-in', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'demo-manager', password: 'local-demo-passphrase' }),
    });
    if (typeof session?.accessToken === 'string' && session.accessToken && !/[\r\n]/.test(session.accessToken)) {
      token = session.accessToken;
    }
    if (!token || session.role !== 'manager' || session.storeId !== 'kigali') {
      throw new Error('Expected the local Kigali manager fixture account.');
    }
    signal?.throwIfAborted();
    const before = await request('GET', '/receipts', 200, 'Initial receipt queue read', { abort: signal });
    if (!Array.isArray(before) || before.length !== 0) throw new Error('Expected an empty receipt queue before the native checkout.');
    await writeFile(ready, '', fileOptions);

    const deadline = AbortSignal.timeout(timeoutMs);
    const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let order;
    try {
      while (!order) {
        await delay(intervalMs, undefined, { signal: abort });
        const receipts = await request('GET', '/receipts', 200, 'Receipt queue read', { abort });
        if (!Array.isArray(receipts) || receipts.length > 1) {
          throw new Error('Expected at most one order in the disposable receipt queue.');
        }
        if (receipts.length === 1) {
          const [candidate] = receipts;
          // An accepted order with a pending receipt is only in this queue once its payment is paid.
          if (!candidate || typeof candidate.orderId !== 'string' || !uuid.test(candidate.orderId)
            || candidate.status !== 'accepted' || candidate.receiptStatus !== 'pending' || candidate.receiptReference != null
            || candidate.currency !== 'RWF' || !Number.isSafeInteger(candidate.total) || candidate.total < 1) {
            throw new Error('The only receipt queue entry was not an eligible accepted fixture order.');
          }
          order = candidate;
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (deadline.aborted) throw new Error('Timed out waiting for the paid iOS fixture order.');
      throw error;
    }
    signal?.throwIfAborted();
    const suffix = order.orderId.slice(-8);
    const receiptReference = 'IOS-TEST-' + suffix.toUpperCase();
    const pdf = testReceipt('CrustCaper iOS synthetic receipt');
    const receipt = await request('PUT', `/orders/${order.orderId}/receipt`, 200, 'Attach synthetic receipt', {
      body: pdf,
      headers: { 'Content-Type': 'application/pdf', 'X-Receipt-Reference': receiptReference,
        'X-Receipt-Total-RWF': String(order.total) },
    });
    if (receipt?.orderId !== order.orderId || receipt.status !== 'accepted' || receipt.receiptStatus !== 'issued'
      || receipt.receiptReference !== receiptReference || receipt.total !== order.total || receipt.currency !== 'RWF') {
      throw new Error('The API did not confirm the synthetic receipt for the accepted order.');
    }
    proof = {
      result: 'passed', orderReference: '#' + suffix.toUpperCase(), receiptReference, totalRwf: order.total,
      pdfFilename: `receipt-${suffix}.pdf`, pdfSha256: createHash('sha256').update(pdf).digest('hex'),
    };
  } finally {
    if (token) await request('DELETE', '/sessions/current', 204, 'Manager sign-out');
  }
  signal?.throwIfAborted();
  await writeFile(result, JSON.stringify(proof, null, 2) + '\n', fileOptions);
  return proof;
}

if (require.main === module) {
  const [directory, ...extra] = process.argv.slice(2);
  const interrupt = new AbortController();
  const stop = name => {
    process.exitCode = name === 'SIGINT' ? 130 : 143;
    interrupt.abort(new Error(`Receipt fixture interrupted by ${name}.`));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  (async () => {
    if (!directory || extra.length) throw new Error('Usage: node tooling/ios-receipt-fixture.cjs EVIDENCE_DIR');
    await attachReceiptFixture(directory, { signal: interrupt.signal });
    console.log('Attached the synthetic receipt and signed out.');
  })().catch(error => {
    if (!process.exitCode) process.exitCode = 1;
    console.error(error.message);
  });
}

module.exports = { attachReceiptFixture };
