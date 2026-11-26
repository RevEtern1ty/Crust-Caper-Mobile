import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const preflight = fileURLToPath(new URL('./check-live-catalog.mjs', import.meta.url));
const origin = 'https://stage.example.test';
const imagePath = '/catalog-photos/double-smash-r39.png';
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cAn0AAAAASUVORK5CYII=';

async function mockFetch(requested, options, scenario) {
  const url = new URL(requested);
  process.stdout.write(`REQUEST ${url.pathname}${url.search}\n`);
  if (url.origin !== origin || options.redirect !== 'manual' || options.headers.Authorization || options.headers.Cookie) {
    throw new Error('Unexpected request');
  }
  if (url.pathname === '/api/v1/stores/kigali/menu') {
    const start = new Date(Date.now() + 20 * 60_000).toISOString();
    const end = new Date(Date.now() + 30 * 60_000).toISOString();
    return Response.json({
      store: { id: 'kigali', open: true }, version: 'catalog-r39',
      slots: [{ id: 'fixture-slot', startsAt: start, endsAt: end, available: true }],
      products: [
        { sku: 'double-smash', available: true, photoUrl: scenario.photoUrl },
        { sku: 'fries', available: true },
      ],
    });
  }
  if (url.pathname.startsWith('/menu/')) {
    const locale = url.pathname.slice(-2);
    return new Response('<html></html>', {
      status: locale === 'rw' ? (scenario.rwStatus ?? 200) : 200,
      headers: {
        'content-type': 'text/html; charset=utf-8', 'content-language': locale,
        'x-crustcaper-catalog-version': locale === 'rw' ? (scenario.rwVersion ?? 'catalog-r39') : 'catalog-r39',
        'x-crustcaper-store-id': 'kigali',
      },
    });
  }
  if (url.pathname === imagePath || url.pathname === '/assets/menu/legacy.png') {
    const headers = { 'content-type': scenario.imageType ?? 'image/png', Location: '/never-follow' };
    if (scenario.imageLength) headers['content-length'] = String(scenario.imageLength);
    return new Response(scenario.imageBody ? Buffer.from(scenario.imageBody, 'base64') : Buffer.from(png, 'base64'), {
      status: scenario.imageStatus ?? 200,
      headers,
    });
  }
  throw new Error('Unexpected request destination');
}

function run(scenario, ...flags) {
  const preload = `import { Buffer } from 'node:buffer';
    const origin = ${JSON.stringify(origin)}; const imagePath = ${JSON.stringify(imagePath)};
    const png = ${JSON.stringify(png)}; const scenario = ${JSON.stringify(scenario)};
    globalThis.fetch = (url, options) => (${mockFetch.toString()})(url, options, scenario);`;
  const result = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`,
    preflight, `${origin}/api/v1`, 'kigali', 'catalog-r39', ...flags], { encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  return result;
}

test('the original catalog gate uses the mobile menu only', () => {
  const result = run({ photoUrl: 'https://foreign.example.test/private.png' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /channel=mobile&locale=en/);
  assert.equal(result.stdout.split('REQUEST ').length, 2);
});

test('storefront gate checks both localized pages and available catalog photo paths', () => {
  for (const path of [imagePath, '/assets/menu/legacy.png', undefined]) {
    const result = run({ photoUrl: path ? origin + path : null }, '--storefront');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /channel=web&locale=en/);
    assert.match(result.stdout, /REQUEST \/menu\/en\nREQUEST \/menu\/rw/);
    assert.match(result.stdout, new RegExp(`${path ? 1 : 0} catalog photo files verified`));
  }
});

test('storefront gate reports broken SSR despite a successful API response', () => {
  const failed = run({ rwStatus: 503 }, '--storefront');
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /\/menu\/rw: HTTP 503/);
  const stale = run({ rwVersion: 'old' }, '--storefront');
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /\/menu\/rw: rendered catalog does not match/);
});

test('storefront gate rejects missing, redirected, wrong-format and truncated images', () => {
  const cases = [
    [{ imageStatus: 404 }, /HTTP 404/],
    [{ imageStatus: 302 }, /HTTP 302/],
    [{ imageType: 'text/html' }, /expected image\/png media type/],
    [{ imageBody: Buffer.from('<html>not an image</html>').toString('base64') }, /invalid or truncated/],
    [{ imageBody: Buffer.from(png, 'base64').subarray(0, 44).toString('base64') }, /invalid or truncated/],
    [{ imageLength: 100 }, /invalid or truncated/],
    [{ imageLength: 8 * 1024 * 1024 + 1 }, /exceeds the 8 MiB limit/],
  ];
  for (const [scenario, diagnostic] of cases) {
    const result = run({ ...scenario, photoUrl: origin + imagePath }, '--storefront');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Photo for SKU double-smash/);
    assert.match(result.stderr, diagnostic);
    assert.doesNotMatch(result.stdout, /never-follow/);
  }
});

test('storefront gate rejects foreign or unsafe photo URLs before any image request', () => {
  for (const photoUrl of [
    'https://foreign.example.test/catalog-photos/private.png',
    'https://someone:hiddensecret@stage.example.test/catalog-photos/private.png',
    origin + imagePath + '?auth=hiddensecret', origin + imagePath + '#hiddensecret',
    origin + '/api/v1/operator/private.png', origin + '/assets/menu/../private.png',
    origin + '/catalog-photos/subdir/private.png',
  ]) {
    const result = run({ photoUrl }, '--storefront');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Photo for SKU double-smash: expected an allowed same-origin catalog photo URL/);
    assert.doesNotMatch(result.stderr, /private|hiddensecret/);
    assert.equal(result.stdout.split('REQUEST ').length, 4);
  }
});
