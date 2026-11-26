import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  const expoConfig = { extra: { ...scenario.expoExtra, restaurant: {
    profile: 'stage', apiBaseUrl: `${origin}/api/v1`, storeId: 'kigali', webCheckout: true, ...scenario.expoConfig,
  } } };
  const constants = `{get deviceYearClass(){return null},get manifest(){return${JSON.stringify(JSON.stringify(expoConfig))}},get manifest2(){return null}}`;
  const bundle = scenario.bundle ?? `throw new Error('Published code must not run during preflight');
    globalThis.expoConstants = ${constants};
    ${scenario.duplicateManifest ? `globalThis.otherConstants = ${constants};` : ''}`;
  const script = '/_expo/static/js/web/entry-' + createHash('md5').update(bundle).digest('hex') + '.js';
  if (url.pathname === '/menu/en/double-smash' || url.pathname === '/menu/rw/double-smash') {
    const locale = url.pathname.split('/')[2];
    const link = locale === 'rw' ? (scenario.purchaseHref ?? `/product/double-smash?storefrontLocale=${locale}`)
      : `/product/double-smash?storefrontLocale=${locale}`;
    const anchor = `<a class="primary-action" href="${link}">Choose</a>`;
    const html = `<html lang="${locale}"><body><main id="main">${scenario.hiddenPurchase && locale === 'rw'
      ? `<!-- ${anchor} -->` : anchor}</main></body></html>`;
    return new Response(html, { headers: { 'content-type': 'text/html', 'content-language': locale } });
  }
  if (url.pathname.startsWith('/menu/')) {
    const locale = url.pathname.slice(-2);
    const detail = scenario.missingDetail && locale === 'rw' ? '' : `<a href='/menu/${locale}/double-smash'>Item</a>`;
    const html = `<html lang="${locale}"><body><main id="main">Menu${detail}</main></body></html>`;
    return new Response(locale === 'rw' ? (scenario.rwHtml ?? html) : html, {
      status: locale === 'rw' ? (scenario.rwStatus ?? 200) : 200,
      headers: {
        'content-type': 'text/html; charset=utf-8', 'content-language': locale,
        'x-crustcaper-catalog-version': locale === 'rw' ? (scenario.rwVersion ?? 'catalog-r39') : 'catalog-r39',
        'x-crustcaper-store-id': 'kigali',
      },
    });
  }
  if (url.pathname === '/product/double-smash' && /^\?storefrontLocale=(en|rw)$/.test(url.search)) {
    const html = `<html lang="en">${scenario.checkoutHead ?? ''}<body><div id="root"></div>
      <script src="${scenario.entrySrc ?? script}" ${scenario.entryAttributes ?? 'defer'}></script></body></html>`;
    return new Response(scenario.checkoutHtml ?? html, { status: scenario.checkoutStatus ?? 200, headers: {
      'content-type': scenario.checkoutType ?? 'text/html', Location: '/never-follow',
    } });
  }
  if (url.pathname === script) {
    const headers = { 'content-type': scenario.bundleType ?? 'text/javascript', Location: '/never-follow' };
    if (scenario.bundleLength !== undefined) headers['content-length'] = String(scenario.bundleLength);
    return new Response(scenario.bundleBody ?? bundle, { status: scenario.bundleStatus ?? 200, headers });
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
    import { createHash } from 'node:crypto';
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
  const truncated = run({ rwHtml: '<html lang="rw"><body><main id="main">' }, '--storefront');
  assert.equal(truncated.status, 1);
  assert.match(truncated.stderr, /\/menu\/rw: missing or incomplete localized catalog HTML/);
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

test('checkout gate reveals an unmounted checkout despite successful catalog preflight', () => {
  const scenario = { checkoutStatus: 404 };
  const catalog = run(scenario, '--storefront');
  assert.equal(catalog.status, 0, catalog.stderr);
  assert.doesNotMatch(catalog.stdout, /REQUEST \/product\//);
  const checkout = run(scenario, '--checkout');
  assert.equal(checkout.status, 1);
  assert.match(checkout.stderr, /Checkout EN: HTTP 404/);
  assert.doesNotMatch(checkout.stdout, /never-follow/);
});

test('checkout gate requests the same available item via both localized catalog handoffs', () => {
  const result = run({}, '--checkout');
  assert.equal(result.status, 0, result.stderr);
  for (const locale of ['en', 'rw']) {
    assert.match(result.stdout, new RegExp(`REQUEST /menu/${locale}/double-smash\\nREQUEST /product/double-smash\\?storefrontLocale=${locale}`));
  }
  assert.equal(result.stdout.match(/REQUEST \/_expo\/static\/js\/web\/entry-/g)?.length, 1);
  assert.match(result.stdout, /Checkout EN and RW handoffs and Expo entry verified/);
});

test('checkout gate reads the Expo manifest when EAS and nested settings precede the restaurant', () => {
  const result = run({
    expoExtra: {
      eas: { projectId: '2f90168f-b697-4b39-9e72-e80c092d32c2' },
      other: { restaurant: { storeId: 'elsewhere', metadata: ['quoted "text"', 'a closing brace }'] } },
    },
    expoConfig: { nested: { message: 'escaped slash \\ and "quoted text" }' } },
  }, '--checkout');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Checkout EN and RW handoffs and Expo entry verified/);
});

test('checkout gate rejects changed or hidden catalog links and unsafe script addresses', () => {
  const cases = [
    [{ missingDetail: true }, /Storefront \/menu\/rw: missing the selected item link/],
    [{ purchaseHref: '/product/double-smash?storefrontLocale=en' }, /Storefront product RW: missing the expected purchase link/],
    [{ purchaseHref: 'https://foreign.example.test/product/double-smash?storefrontLocale=rw' }, /missing the expected purchase link/],
    [{ hiddenPurchase: true }, /missing the expected purchase link/],
    [{ entrySrc: 'https://foreign.example.test/_expo/static/js/web/entry-' + 'a'.repeat(32) + '.js' }, /expected one same-origin Expo entry script/],
    [{ entrySrc: '/_expo/static/js/web/entry-' + 'a'.repeat(32) + '.js?token=private' }, /expected one same-origin Expo entry script/],
    [{ entryAttributes: 'type="application/json"' }, /expected one same-origin Expo entry script/],
    [{ entryAttributes: 'nomodule' }, /expected one same-origin Expo entry script/],
    [{ checkoutHead: '<head><base href="https://foreign.example.test/"></head>' }, /missing or incomplete Expo HTML/],
  ];
  for (const [scenario, diagnostic] of cases) {
    const result = run(scenario, '--checkout');
    assert.equal(result.status, 1);
    assert.match(result.stderr, diagnostic);
    assert.doesNotMatch(result.stderr, /private|foreign\.example/);
    assert.doesNotMatch(result.stdout, /REQUEST \/_expo.*private|REQUEST .*foreign\.example/);
  }
});

test('checkout gate rejects an invalid shell, missing, truncated and invalid bundles, and incompatible build config', () => {
  const cases = [
    [{ checkoutHtml: '<html lang="en"><body><div id="root">' }, /missing or incomplete Expo HTML/],
    [{ checkoutType: 'text/plain' }, /Checkout EN: expected HTML/],
    [{ bundleStatus: 404 }, /Expo checkout entry: HTTP 404/],
    [{ bundleStatus: 302 }, /Expo checkout entry: HTTP 302/],
    [{ bundleType: 'text/html' }, /expected JavaScript/],
    [{ bundleLength: 4096 }, /invalid or truncated/],
    [{ bundleLength: 12 * 1024 * 1024 + 1 }, /exceeds the 12 MiB limit/],
    [{ bundleBody: 'truncated copy' }, /content does not match its published filename/],
    [{ bundle: 'function {' }, /invalid JavaScript/],
    [{ duplicateManifest: true }, /not configured for this same-origin store/],
    [{ expoExtra: { nested: { restaurant: {
      webCheckout: true, profile: 'stage', apiBaseUrl: origin + '/api/v1', storeId: 'kigali',
    } } }, expoConfig: { storeId: 'other-store' } }, /not configured for this same-origin store/],
    [{ expoConfig: { webCheckout: false } }, /not configured for this same-origin store/],
    [{ expoConfig: { profile: 'local' } }, /not configured for this same-origin store/],
    [{ expoConfig: { storeId: 'other-store' } }, /not configured for this same-origin store/],
    [{ expoConfig: { apiBaseUrl: 'https://foreign.example.test/api/v1' } }, /not configured for this same-origin store/],
  ];
  for (const [scenario, diagnostic] of cases) {
    const result = run(scenario, '--checkout');
    assert.equal(result.status, 1);
    assert.match(result.stderr, diagnostic);
    assert.doesNotMatch(result.stderr, /foreign\.example/);
    assert.doesNotMatch(result.stdout, /never-follow/);
  }
});
