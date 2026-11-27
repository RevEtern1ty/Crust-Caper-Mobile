const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { lstat, mkdtemp, readFile, rm, rmdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { attachReceiptFixture } = require('./ios-receipt-fixture.cjs');
const { testReceipt } = require('../tests/receipt-fixture.cjs');

const id = '2bba37e8-58db-4563-a4e2-fb197fe59890';
const order = { orderId: id, status: 'accepted', receiptStatus: 'pending', currency: 'RWF', total: 9200 };
const token = 'local-fixture-token';

async function evidence(t) {
  const directory = await mkdtemp(join(tmpdir(), 'crustcaper-ios-receipt-test-'));
  t.after(async () => {
    for (const file of ['receipt-fixture.ready', 'receipt-fixture.json']) await rm(join(directory, file), { force: true });
    await rmdir(directory);
  });
  return directory;
}

function fixture(readQueue) {
  const calls = [];
  async function fetchImpl(url, options) {
    const request = new URL(url);
    const { method, headers, signal } = options;
    assert.equal(request.origin, 'http://127.0.0.1:18080');
    assert.equal(options.redirect, 'error');
    const route = `${method} ${request.pathname}`;
    calls.push(route);
    if (route === 'POST /api/v1/operator/sessions') {
      const login = JSON.parse(options.body);
      assert.equal(login.username, 'demo-manager');
      return Response.json({ role: 'manager', storeId: 'kigali', accessToken: token }, { status: 201 });
    }
    assert.equal(headers.Authorization, 'Bearer ' + token);
    if (route === 'GET /api/v1/operator/receipts') return Response.json(await readQueue(signal));
    if (route === `PUT /api/v1/operator/orders/${id}/receipt`) {
      assert.equal(headers['Content-Type'], 'application/pdf');
      assert.equal(headers['X-Receipt-Reference'], 'IOS-TEST-7FE59890');
      assert.equal(headers['X-Receipt-Total-RWF'], '9200');
      assert.deepEqual(options.body, testReceipt('CrustCaper iOS synthetic receipt'));
      return Response.json({ ...order, receiptStatus: 'issued', receiptReference: 'IOS-TEST-7FE59890' });
    }
    assert.equal(route, 'DELETE /api/v1/operator/sessions/current');
    assert.equal(signal.aborted, false, 'the cleanup request has its own signal');
    return new Response(null, { status: 204 });
  }
  return { calls, fetchImpl };
}

test('attaches one PDF to the single paid fixture and records safe evidence after logout', async t => {
  const directory = await evidence(t);
  let reads = 0;
  const { calls, fetchImpl } = fixture(async () => {
    if (++reads === 1) return [];
    assert.equal(await readFile(join(directory, 'receipt-fixture.ready'), 'utf8'), '');
    return reads === 2 ? [] : [order];
  });
  const result = await attachReceiptFixture(directory, { fetchImpl, intervalMs: 1 });
  assert.deepEqual(result, {
    result: 'passed', orderReference: '#7FE59890', receiptReference: 'IOS-TEST-7FE59890', totalRwf: 9200,
    pdfFilename: 'receipt-7fe59890.pdf',
    pdfSha256: createHash('sha256').update(testReceipt('CrustCaper iOS synthetic receipt')).digest('hex'),
  });
  const resultPath = join(directory, 'receipt-fixture.json');
  assert.deepEqual(JSON.parse(await readFile(resultPath, 'utf8')), result);
  if (process.platform !== 'win32') assert.equal((await lstat(resultPath)).mode & 0o777, 0o600);
  assert.deepEqual(calls.filter(call => call.startsWith('PUT')), [`PUT /api/v1/operator/orders/${id}/receipt`]);
  assert.equal(calls.at(-1), 'DELETE /api/v1/operator/sessions/current');
});

test('refuses a nonempty initial queue and multiple candidates without attaching', async t => {
  for (const initial of [true, false]) {
    await t.test(initial ? 'nonempty initial queue' : 'ambiguous new orders', async t => {
      const directory = await evidence(t);
      let reads = 0;
      const { calls, fetchImpl } = fixture(() => initial ? [order] : ++reads === 1 ? [] :
        [order, { ...order, orderId: '164064f3-2cad-475e-aa6b-67a8403ef030' }]);
      await assert.rejects(attachReceiptFixture(directory, { fetchImpl, intervalMs: 1 }),
        initial ? /empty receipt queue/ : /at most one order/);
      assert.ok(calls.every(call => !call.startsWith('PUT')));
      assert.equal(calls.at(-1), 'DELETE /api/v1/operator/sessions/current');
      await assert.rejects(lstat(join(directory, 'receipt-fixture.json')), { code: 'ENOENT' });
    });
  }
});

test('interruption aborts the poll and releases the manager session', async t => {
  const directory = await evidence(t);
  const interrupt = new AbortController();
  let reads = 0;
  const { calls, fetchImpl } = fixture(signal => {
    if (++reads === 1) return [];
    return new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      interrupt.abort(new Error('Fixture interrupted'));
    });
  });
  await assert.rejects(attachReceiptFixture(directory, { fetchImpl, intervalMs: 1, signal: interrupt.signal }), /Fixture interrupted/);
  assert.equal(calls.at(-1), 'DELETE /api/v1/operator/sessions/current');
  assert.ok(calls.every(call => !call.startsWith('PUT')));
  await assert.rejects(lstat(join(directory, 'receipt-fixture.json')), { code: 'ENOENT' });
});
