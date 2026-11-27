const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } = require('node:fs');
const { basename, dirname, join, resolve } = require('node:path');

const [simulator, directory] = process.argv.slice(2);
assert.match(simulator ?? '', /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i);
assert.ok(directory, 'Set the receipt evidence directory');
const evidence = resolve(directory);
const fixture = JSON.parse(readFileSync(join(evidence, 'receipt-fixture.json'), 'utf8'));
assert.equal(fixture.result, 'passed');
assert.match(fixture.orderReference, /^#[0-9A-F]{8}$/);
assert.equal(fixture.pdfFilename, 'receipt-' + fixture.orderReference.slice(1).toLowerCase() + '.pdf');
assert.match(fixture.pdfSha256, /^[\da-f]{64}$/);

const appData = realpathSync(execFileSync('xcrun', [
  'simctl', 'get_app_container', simulator, 'com.crustcaper.mobile.local', 'data',
], { encoding: 'utf8', timeout: 10_000 }).trim());
const containers = dirname(dirname(dirname(appData)));
const data = dirname(containers);
assert.equal(dirname(dirname(appData)), join(containers, 'Data'));
assert.equal(basename(containers), 'Containers');
assert.equal(basename(data), 'data');
assert.equal(basename(dirname(data)).toLowerCase(), simulator.toLowerCase());

function findDocument(folder, filename, depth) {
  if (depth === 0 || !existsSync(folder) || realpathSync(folder) !== folder) return;
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const candidate = join(folder, entry.name);
    if (entry.isFile() && entry.name === filename) return candidate;
    if (entry.isDirectory()) {
      const nested = findDocument(candidate, filename, depth - 1);
      if (nested) return nested;
    }
  }
}

const documents = [
  join(containers, 'Data', 'Application'),
  join(containers, 'Shared', 'AppGroup'),
].flatMap(folder => existsSync(folder) ? readdirSync(folder, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => join(folder, entry.name))
  .filter(container => container !== appData)
  .flatMap(container => [
    join(container, 'Documents'),
    join(container, 'File Provider Storage'),
    join(container, 'Library', 'Application Support', 'FileProvider'),
  ]) : []);
// The activity's input in the app cache is not a copy saved by Files.
function readSavedDocument(filename) {
  const path = documents.map(folder => findDocument(folder, filename, 8)).find(Boolean);
  assert.ok(path, `Files did not retain ${filename} outside the CrustCaper container`);
  assert.ok(statSync(path).size <= 1024 * 1024, 'The saved synthetic file must be at most one MiB');
  return readFileSync(path);
}

const pdf = readSavedDocument(fixture.pdfFilename);
const pdfSha256 = createHash('sha256').update(pdf).digest('hex');
assert.equal(pdfSha256, fixture.pdfSha256, 'The saved PDF must match the receipt attached by the fixture');
writeFileSync(join(evidence, 'saved-receipt.pdf'), pdf, { flag: 'wx', mode: 0o600 });
writeFileSync(join(evidence, 'saved-receipt.json'), JSON.stringify({
  simulator, filename: fixture.pdfFilename, pdfSha256, bytes: pdf.length,
  matchedOriginal: true, savedOutsideAppContainer: true,
}, null, 2) + '\n', { flag: 'wx', mode: 0o600 });

const exportFilename = 'crustcaper-order-data.json';
const exported = readSavedDocument(exportFilename);
const order = JSON.parse(exported);
assert.match(order.orderId, /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/);
assert.equal('#' + order.orderId.slice(-8).toUpperCase(), fixture.orderReference);
assert.equal(order.storeId, 'kigali');
assert.equal(order.currency, 'RWF');
assert.equal(order.total, fixture.totalRwf);
assert.equal(order.status, 'accepted');
assert.equal(order.paymentStatus, 'paid');
assert.equal(order.receiptStatus, 'issued');
assert.ok(order.lines.some(line => line.sku === 'double-smash'));

writeFileSync(join(evidence, 'saved-order-export.json'), JSON.stringify({
  simulator, filename: exportFilename, sha256: createHash('sha256').update(exported).digest('hex'),
  bytes: exported.length, sameOrder: true, savedOutsideAppContainer: true,
}, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
