import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const check = fileURLToPath(new URL('./check-app-links.mjs', import.meta.url));
const origin = 'https://stage.example.test';
const androidPackage = 'com.crustcaper.mobile.stage';
const fingerprint = '9A:'.repeat(31) + '9A';
const iosAppId = 'ABCDE12345.' + androidPackage;
const callback = {
  orderId: 'c0de0000-1111-4222-8333-444444444444',
  tx_ref: 'cc-app-link-fixture-reference',
  transaction_id: '987654321098765432',
  status: 'cc-app-link-fixture-status',
};

async function fixtureFetch(requested, options) {
  const url = new URL(requested);
  if (url.origin !== origin || options.redirect !== 'manual') throw new Error('Unexpected fixture request');
  if (url.pathname === '/.well-known/assetlinks.json') {
    return Response.json([{
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app', package_name: androidPackage,
        sha256_cert_fingerprints: [scenario.wrongFingerprint ? 'B7:'.repeat(31) + 'B7' : fingerprint],
      },
    }]);
  }
  if (url.pathname === '/.well-known/apple-app-site-association') {
    return Response.json({ applinks: { details: [{ appIDs: [iosAppId], components: [{ '/': '/payment-return' }] }] } });
  }
  if (url.pathname !== '/payment-return') throw new Error('Unexpected fixture destination');
  const sent = Object.fromEntries(url.searchParams);
  const expectedQuery = url.searchParams.size === Object.keys(callback).length
    && Object.entries(callback).every(([key, value]) => sent[key] === value);
  console.log('Callback query is complete:', expectedQuery);
  const headers = {
    'Content-Type': 'text/html; charset=UTF-8',
    'Cache-Control': scenario.cacheControl ?? 'no-store',
    'Referrer-Policy': scenario.referrerPolicy ?? 'no-referrer',
  };
  if (scenario.redirect) headers.Location = '/never-follow';
  if (scenario.reflectHeader) headers['X-Callback'] = sent[scenario.reflectHeader] ?? '';
  const detail = scenario.reflectBody ? sent[scenario.reflectBody] ?? '' : '';
  const padding = scenario.oversized ? 'x'.repeat(1024 * 1024) : '';
  return new Response('<title>Return to CrustCaper</title>' + detail + padding, {
    headers, status: scenario.redirect ? 302 : 200,
  });
}

function run(scenario = {}) {
  const data = { origin, androidPackage, fingerprint, iosAppId, callback, scenario };
  const fixture = Object.entries(data).map(([name, value]) => 'const ' + name + '=' + JSON.stringify(value) + ';').join('')
    + 'globalThis.fetch = (' + fixtureFetch.toString() + ');';
  const result = spawnSync(process.execPath, [
    '--import', 'data:text/javascript,' + encodeURIComponent(fixture),
    check, origin, origin + '/payment-return', androidPackage, fingerprint, iosAppId,
  ], { encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  return result;
}

test('verifies both association documents and the complete synthetic callback query', () => {
  const result = run({ cacheControl: 'private, no-store', referrerPolicy: 'no-referrer, no-referrer' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Callback query is complete: true/);
  assert.match(result.stdout, /Verified Android and Apple associations and \/payment-return over HTTPS/);
});

test('rejects a payment return without the expected cache and referrer policies', () => {
  for (const [scenario, diagnostic] of [
    [{ cacheControl: 'public, max-age=3600' }, /Cache-Control.*no-store/],
    [{ referrerPolicy: 'unsafe-url' }, /Referrer-Policy.*no-referrer/],
  ]) {
    const result = run(scenario);
    assert.equal(result.status, 1);
    assert.match(result.stderr, diagnostic);
  }
});

test('rejects callback reflection in the HTML and response headers without exposing the fields', () => {
  for (const scenario of [...Object.keys(callback).map(reflectBody => ({ reflectBody })), { reflectHeader: 'tx_ref' }]) {
    const result = run(scenario);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\/payment-return reflected a callback parameter/);
    for (const value of Object.values(callback)) assert.ok(!result.stderr.includes(value) && !result.stdout.includes(value));
  }
});

test('rejects an oversized page, a redirect, and a wrong Android signing fingerprint', () => {
  for (const [scenario, diagnostic] of [
    [{ oversized: true }, /\/payment-return.*size limit/],
    [{ redirect: true }, /\/payment-return returned HTTP 302/],
    [{ wrongFingerprint: true }, /Android association does not match/],
  ]) {
    const result = run(scenario);
    assert.equal(result.status, 1);
    assert.match(result.stderr, diagnostic);
    assert.doesNotMatch(result.stderr, /never-follow/);
  }
});
