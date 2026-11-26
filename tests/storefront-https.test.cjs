const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const { spawnSync } = require('node:child_process');
const { createHash, X509Certificate } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { mkdir } = require('node:fs/promises');
const https = require('node:https');
const { dirname, resolve } = require('node:path');
const { test } = require('node:test');
const { connect } = require('node:tls');
const { chromium } = require('playwright-core');
const { checkWebPerformance } = require('./storefront-web-perf.cjs');

const storefront = 'crustcaper.test';
const provider = 'checkout.flutterwave.com';
const origin = 'https://' + storefront;
const hostedOrigin = 'https://' + provider;
const product = '/menu/en/double-smash';
const translatedProduct = '/menu/rw/double-smash';
const guestCookie = '__Host-crustcaper-web';
const evidence = process.env.CRUSTCAPER_HTTPS_TEST_EVIDENCE_DIR;
const project = process.env.CRUSTCAPER_HTTPS_TEST_DOCKER_PROJECT;
const webPerf = process.env.CRUSTCAPER_HTTPS_TEST_WEB_PERF === '1';
const catalogPhotos = process.env.CRUSTCAPER_HTTPS_TEST_CATALOG_PHOTOS === '1';
const approvedPhotoPath = '/catalog-photos/double-smash-r39.jpg';
const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function request(ca, path, { method = 'GET', headers, binary = false } = {}) {
  return new Promise((done, reject) => {
    const outbound = https.request({
      hostname: '127.0.0.1', port: 443, servername: storefront, ca, method, path,
      headers: { ...headers, host: storefront }, timeout: 9000,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        done({ status: response.statusCode, headers: response.headers, body: binary ? body : body.toString('utf8') });
      });
    });
    outbound.on('error', reject);
    outbound.on('timeout', () => outbound.destroy(new Error('HTTPS fixture request timed out')));
    outbound.end();
  });
}

function fixturePin(ca, servername) {
  return new Promise((done, reject) => {
    const socket = connect({ host: '127.0.0.1', port: 443, servername, ca, timeout: 5000 });
    socket.once('error', reject);
    socket.once('timeout', () => socket.destroy(new Error('HTTPS fixture certificate handshake timed out')));
    socket.once('secureConnect', () => {
      try {
        // Node validates the hostname and CA. Chrome trusts only these two fixture leaf keys.
        const publicKey = new X509Certificate(socket.getPeerCertificate().raw).publicKey;
        done(createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('base64'));
      } catch (error) {
        reject(error);
      } finally {
        socket.destroy();
      }
    });
  });
}

function button(page, name) {
  return page.getByRole('button', { name, exact: typeof name === 'string' });
}

function shown(page, phrase, timeout) {
  return page.getByText(phrase, { exact: true }).filter({ visible: true }).first().waitFor({ timeout });
}

async function capture(page, name) {
  if (!evidence) return;
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: resolve(evidence, name + '.png'), animations: 'disabled' });
}

async function checkPublicCatalog(ca) {
  const landing = await request(ca, '/');
  assert.equal(landing.status, 308);
  assert.equal(landing.headers.location, '/menu/en');
  const english = await request(ca, product, { headers: { 'X-Forwarded-Host': 'spoofed.example.test' } });
  assert.equal(english.status, 200);
  assert.ok(!english.headers['set-cookie'], 'catalog must not issue a guest cookie');
  assert.match(english.headers['cache-control'], /no-store/);
  assert.match(english.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(english.headers['x-robots-tag'], /noindex/);
  assert.match(english.body, /<h1[^>]*>Double Smash<\/h1>/);
  assert.match(english.body, /Wheat/);
  assert.doesNotMatch(english.body, /<script\b|spoofed\.example\.test/i);
  assert.ok(english.body.includes(origin + product));
  assert.ok(english.body.includes(origin + translatedProduct));

  const kinyarwanda = await request(ca, translatedProduct);
  assert.equal(kinyarwanda.status, 200);
  assert.match(kinyarwanda.body, /<html[^>]*lang="rw"/);
  assert.match(kinyarwanda.body, /Ingano/);
  assert.equal((await request(ca, '/menu/en/not-on-the-menu')).status, 404);
  assert.equal((await request(ca, '/menu/fr/double-smash')).status, 404);
  assert.match((await request(ca, '/robots.txt')).body, /Disallow: \/\r?\n/);
  assert.equal((await request(ca, '/sitemap.xml')).status, 404);
  assert.equal((await request(ca, '/api/catalog-health')).status, 404);
  assert.equal((await request(ca, '/api/v1/local/orders')).status, 404);
}

function verifyPaymentRow(orderId) {
  assert.ok(uuid.test(orderId), 'fixture order requires a UUID');
  assert.match(project, /^cc-storefront-[0-9a-f-]{8,36}$/);
  const database = spawnSync('docker', ['ps', '--format', '{{.ID}}',
    '--filter', 'label=com.docker.compose.project=' + project,
    '--filter', 'label=com.docker.compose.service=postgres',
  ], { encoding: 'utf8', timeout: 10000 });
  assert.equal(database.status, 0, 'could not find the Compose PostgreSQL fixture');
  const id = database.stdout.trim();
  assert.match(id, /^[0-9a-f]{12,64}$/, 'expected one PostgreSQL fixture container');
  const query = spawnSync('docker', ['exec', id, 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1',
    '-U', 'storefront_fixture', '-d', 'storefront_fixture', '-c',
    `SELECT count(*), count(*) FILTER (WHERE o.checkout_channel='web' AND o.payment_status='paid' AND p.status='paid')
      FROM orders o JOIN payment_attempts p ON p.order_id = o.id WHERE o.id = '${orderId}'`,
  ], { encoding: 'utf8', timeout: 10000 });
  assert.equal(query.status, 0, 'fixture database query failed');
  assert.equal(query.stdout.trim(), '1|1', 'order must have exactly one verified payment attempt');
}

async function newContext(browser, options, allowHostedPayment = true) {
  const context = await browser.newContext({ serviceWorkers: 'block', ...options });
  await context.route('**/*', route => {
    const site = new URL(route.request().url()).origin;
    return site === origin || (allowHostedPayment && site === hostedOrigin) ? route.continue() : route.abort();
  });
  return context;
}

async function checkNoJavaScript(browser) {
  const context = await newContext(browser, { javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    await page.goto(origin + '/rw');
    assert.equal(new URL(page.url()).pathname, '/menu/rw');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('href')), '#main');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'main');
    const details = page.locator('a[href="' + translatedProduct + '"]').first();
    await details.click();
    await shown(page, 'Ingano');
    await page.locator('a[href="/product/double-smash?storefrontLocale=rw"]').waitFor();
    assert.equal((await context.cookies(origin)).length, 0, 'browsing the catalog must not start a session');
    await capture(page, 'catalog-rw');
  } finally {
    await context.close();
  }
}

async function checkPhotoTransport(ca) {
  const source = readFileSync(resolve(dirname(module.filename), '..', 'assets', 'menu', 'double-smash.jpg'));
  const [get, head, absent, nonRaster] = await Promise.all([
    request(ca, approvedPhotoPath, { binary: true }),
    request(ca, approvedPhotoPath, { method: 'HEAD', binary: true }),
    request(ca, '/catalog-photos/not-in-fixture.jpg'),
    request(ca, '/catalog-photos/double-smash-r39.svg'),
  ]);
  for (const photo of [get, head]) {
    assert.equal(photo.status, 200);
    assert.equal(photo.headers['content-type'], 'image/jpeg');
    assert.equal(Number(photo.headers['content-length']), source.length);
    assert.equal(photo.headers['x-content-type-options'], 'nosniff');
  }
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest(get.body), digest(source), 'GET must serve the exact approved image');
  assert.equal(head.body.length, 0);
  assert.equal(absent.status, 404);
  assert.equal(nonRaster.status, 404);
}

async function checkPhotoRendering(browser) {
  const url = origin + approvedPhotoPath;
  const viewport = { width: 390, height: 844 };
  const catalog = await newContext(browser, { javaScriptEnabled: false, viewport }, false);
  try {
    const page = await catalog.newPage();
    for (const locale of ['en', 'rw']) {
      for (const [path, selector] of [
        ['/menu/' + locale, 'img.hero-photo'],
        ['/menu/' + locale + '/double-smash', 'img.product-photo'],
      ]) {
        const response = await page.goto(origin + path);
        assert.equal(response.status(), 200);
        assert.equal(page.url(), origin + path);
        assert.equal(await page.locator('html').getAttribute('lang'), locale);
        if (path === '/menu/' + locale) {
          assert.equal(response.headers()['x-crustcaper-store-id'], 'kigali');
          assert.equal(response.headers()['x-crustcaper-catalog-version'], 'catalog-001');
        }
        const photo = page.locator(selector);
        await photo.waitFor({ state: 'visible' });
        const decoded = await photo.evaluate(image => ({ url: image.currentSrc, width: image.naturalWidth }));
        assert.equal(decoded.url, url);
        assert.ok(decoded.width > 0, 'SSR approved image must decode with JavaScript disabled');
        for (const width of [320, 430, 390]) {
          await page.setViewportSize({ width, height: viewport.height });
          await page.evaluate(size => { document.documentElement.style.fontSize = size; }, width === 390 ? '' : '200%');
          const fits = await photo.evaluate(image => {
            const bounds = image.getBoundingClientRect();
            return bounds.width > 0 && bounds.left >= 0 && bounds.right <= window.innerWidth
              && document.documentElement.scrollWidth <= window.innerWidth;
          });
          assert.ok(fits, 'Catalog content and approved photo must fit at ' + width + ' px');
        }
      }
      await capture(page, 'catalog-photo-ssr-' + locale);
    }
  } finally {
    await catalog.close();
  }

  const storefront = await newContext(browser, { viewport }, false);
  try {
    const page = await storefront.newPage();
    const response = await page.goto(origin + '/product/double-smash');
    assert.equal(response.status(), 200);
    await page.getByRole('heading', { name: 'Double Smash', exact: true }).first().waitFor();
    await page.waitForFunction(expected => [...document.images].some(image =>
      image.currentSrc === expected && image.naturalWidth > 0 && [...image.parentElement.children].some(layer =>
        getComputedStyle(layer).backgroundImage === 'url("' + expected + '")'
        && layer.getBoundingClientRect().width > 0 && layer.getBoundingClientRect().height > 0)), url,
    { timeout: 12000 });
    await capture(page, 'catalog-photo-expo');
  } finally {
    await storefront.close();
  }
}

async function checkGuestCheckout(browser, ca) {
  const context = await newContext(browser, { viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const failures = [];
    page.on('pageerror', () => failures.push('page error'));
    page.on('console', message => {
      if (message.type() === 'error' && /content security policy/i.test(message.text())) failures.push('CSP violation');
    });
    await page.goto(origin + translatedProduct);
    await page.locator('a[href="/product/double-smash?storefrontLocale=rw"]').click();
    await page.waitForURL(url => url.pathname === '/product/double-smash' && !url.searchParams.has('storefrontLocale'));
    await page.locator('html[lang="rw"]').waitFor({ state: 'attached' });
    await button(page, /Shyira mu gitebo/).click();
    await page.goto(origin + '/cart?storefrontLocale=en');
    await page.locator('html[lang="en"]').waitFor({ state: 'attached' });
    await button(page, 'Choose pickup time').click();
    await page.getByRole('radiogroup', { name: 'Pickup time' }).getByRole('radio', { disabled: false }).nth(2).click();
    await page.getByLabel('Phone number', { exact: true }).fill('+250700000000');
    await page.getByLabel('Email address', { exact: true }).fill('storefront-checkout@example.test');

    const sessionPath = '/api/v1/web/session';
    const [sessionResponse] = await Promise.all([
      page.waitForResponse(response => response.url() === origin + sessionPath
        && response.request().method() === 'POST' && response.ok()),
      button(page, 'Review order').click(),
    ]);
    await shown(page, 'Included tax');
    const session = await sessionResponse.json();
    assert.deepEqual(Object.keys(session).sort(), ['expiresAt', 'sessionId']);
    assert.ok(uuid.test(session.sessionId), 'web session must have an opaque context id');
    const cookie = (await context.cookies(origin)).find(candidate => candidate.name === guestCookie);
    assert.ok(cookie?.secure && cookie.httpOnly && cookie.sameSite === 'Lax' && cookie.path === '/',
      'web session must use the secure host-only cookie policy');
    assert.equal(await page.evaluate(name => document.cookie.includes(name + '='), guestCookie), false);
    assert.equal(await page.evaluate(value => Object.values(localStorage).concat(Object.values(sessionStorage))
      .some(entry => entry.includes(value)), cookie.value), false, 'web credential leaked into script-readable storage');

    for (const [site, marker] of [['https://spoofed.example.test', '1'], [origin, '0']]) {
      const denied = await request(ca, sessionPath, { method: 'POST', headers: {
        Origin: site, 'X-CrustCaper-Web': marker, 'X-CrustCaper-Session': session.sessionId,
        Cookie: guestCookie + '=' + cookie.value,
      } });
      assert.equal(denied.status, 403);
      assert.ok(!denied.headers['set-cookie'], 'rejected request must not issue a cookie');
    }

    const [orderResponse] = await Promise.all([
      page.waitForResponse(response => response.url() === origin + '/api/v1/web/orders'
        && response.request().method() === 'POST' && response.ok()),
      button(page, /^Confirm .*RWF/).click(),
    ]);
    const order = await orderResponse.json();
    assert.ok(uuid.test(order.id), 'fixture order requires a UUID');
    await button(page, 'Open payment page').click();
    await page.waitForURL(url => url.origin === hostedOrigin && url.pathname.startsWith('/v3/hosted/pay/'));
    const [falseSuccess] = await Promise.all([
      page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.origin === origin && url.pathname === '/web-payment-return' && url.searchParams.get('status') === 'successful';
      }),
      button(page, 'Return without settlement').click(),
    ]);
    assert.equal(falseSuccess.status(), 200);
    await page.waitForURL(origin + '/orders');
    await shown(page, 'Checking payment');
    assert.equal(await page.getByText('Paid', { exact: true }).count(), 0);

    await button(page, 'Open payment').click();
    await button(page, 'Open payment page').click();
    await page.waitForURL(url => url.origin === hostedOrigin && url.pathname.startsWith('/v3/hosted/pay/'));
    await button(page, 'Settle fixture payment').click();
    await page.waitForURL(origin + '/orders');
    await shown(page, 'Order accepted', 42000);
    await shown(page, 'Paid');
    if (project) verifyPaymentRow(order.id);
    await capture(page, 'catalog-to-paid');
    assert.deepEqual(failures, []);
  } finally {
    await context.close();
  }
}

const scenario = webPerf ? 'HTTPS catalog captures cold mobile web performance'
  : catalogPhotos ? 'HTTPS storefront renders the approved photo and preserves a single verified guest payment'
    : 'HTTPS storefront renders public pages and preserves a single verified guest payment';

test(scenario, { timeout: webPerf ? 155000 : 90000 }, async t => {
  const caPath = process.env.CRUSTCAPER_HTTPS_TEST_CA;
  assert.ok(caPath, 'the HTTPS storefront launcher must provide a fixture CA');
  const ca = readFileSync(caPath);
  if (!webPerf) await checkPublicCatalog(ca);
  if (catalogPhotos) await checkPhotoTransport(ca);
  const pins = await Promise.all([fixturePin(ca, storefront), fixturePin(ca, provider)]);
  const browser = await chromium.launch({
    channel: 'chrome',
    args: [
      '--host-resolver-rules=MAP ' + storefront + ' 127.0.0.1, MAP ' + provider + ' 127.0.0.1, MAP * ~NOTFOUND',
      '--no-proxy-server',
      '--ignore-certificate-errors-spki-list=' + pins.join(','),
    ],
  });
  t.after(() => browser.close());
  if (webPerf) {
    await checkWebPerformance({
      browser, createContext: options => newContext(browser, options, false), origin, evidence,
    });
    return;
  }
  if (catalogPhotos) await checkPhotoRendering(browser);
  await checkNoJavaScript(browser);
  await checkGuestCheckout(browser, ca);
});
