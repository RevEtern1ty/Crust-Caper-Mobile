const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const { spawnSync } = require('node:child_process');
const { createHash, X509Certificate } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const { setTimeout: delay } = require('node:timers/promises');
const https = require('node:https');
const { dirname, resolve } = require('node:path');
const { test } = require('node:test');
const { connect } = require('node:tls');
const { chromium } = require('playwright-core');
const { provisionStaffCredentials } = require('../tooling/storefront-load-kitchen.cjs');
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
  assert.ok(kinyarwanda.body.includes('/privacy?storefrontLocale=rw'));
  assert.ok(english.body.includes('/privacy?storefrontLocale=en'));
  const privacy = await request(ca, '/privacy');
  assert.equal(privacy.status, 200);
  assert.match(privacy.headers['cache-control'], /no-store/);
  assert.match(privacy.headers['x-robots-tag'], /noindex/);
  assert.equal((await request(ca, '/menu/en/not-on-the-menu')).status, 404);
  assert.equal((await request(ca, '/menu/fr/double-smash')).status, 404);
  assert.match((await request(ca, '/robots.txt')).body, /Disallow: \/\r?\n/);
  assert.equal((await request(ca, '/sitemap.xml')).status, 404);
  assert.equal((await request(ca, '/api/catalog-health')).status, 404);
  assert.equal((await request(ca, '/api/v1/local/orders')).status, 404);
  assert.equal((await request(ca, '/actuator/paymentreconciliation')).status, 404);
}

async function runPublishedCheck(caPath, checker, args, logName) {
  const testDirectory = dirname(module.filename);
  const result = spawnSync(process.execPath, [
    '--require', resolve(testDirectory, 'storefront-loopback.cjs'),
    resolve(testDirectory, '../server/tooling', checker), ...args,
  ], {
    env: { ...(process.platform === 'win32' && { SystemRoot: process.env.SystemRoot }), NODE_EXTRA_CA_CERTS: caPath },
    encoding: 'utf8', timeout: 25000, maxBuffer: 32 * 1024, windowsHide: true,
  });
  assert.ifError(result.error);
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await writeFile(resolve(evidence, logName), result.stdout + result.stderr);
  }
  return result;
}

async function checkCheckoutPreflight(caPath) {
  const result = await runPublishedCheck(caPath, 'check-live-catalog.mjs',
    [origin + '/api/v1', 'kigali', 'catalog-001', '--checkout'], 'storefront-checkout-preflight.log');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Checkout EN and RW handoffs and Expo entry verified\./);
}

async function checkNativeReturnPreflight(caPath) {
  const { androidPackage, androidFingerprint, iosAppId } = JSON.parse(process.env.CRUSTCAPER_HTTPS_TEST_APP_LINKS);
  const check = (fingerprint, logName) => runPublishedCheck(caPath, 'check-app-links.mjs',
    [origin, origin + '/payment-return', androidPackage, fingerprint, iosAppId], logName);
  const result = await check(androidFingerprint, 'storefront-native-return-preflight.log');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verified Android and Apple associations and \/payment-return over HTTPS\./);
  const wrongFingerprint = 'B7:'.repeat(31) + 'B7';
  const mismatch = await check(wrongFingerprint, 'storefront-native-return-mismatch.log');
  assert.equal(mismatch.status, 1);
  assert.match(mismatch.stderr, /Android association does not match the expected package and signing certificate\./);
}

function fixtureDatabase() {
  assert.match(project, /^cc-storefront-[0-9a-f-]{8,36}$/);
  const database = spawnSync('docker', ['ps', '--format', '{{.ID}}',
    '--filter', 'label=com.docker.compose.project=' + project,
    '--filter', 'label=com.docker.compose.service=postgres',
  ], { encoding: 'utf8', timeout: 10000 });
  assert.equal(database.status, 0, 'could not find the Compose PostgreSQL fixture');
  const id = database.stdout.trim();
  assert.match(id, /^[0-9a-f]{12,64}$/, 'expected one PostgreSQL fixture container');
  return id;
}

function verifyPaymentRow(orderId) {
  assert.ok(uuid.test(orderId), 'fixture order requires a UUID');
  const id = fixtureDatabase();
  const query = spawnSync('docker', ['exec', id, 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1',
    '-U', 'storefront_fixture', '-d', 'storefront_fixture', '-c',
    `SELECT count(*), count(*) FILTER (WHERE o.checkout_channel='web' AND o.payment_status='paid' AND p.status='paid')
      FROM orders o JOIN payment_attempts p ON p.order_id = o.id WHERE o.id = '${orderId}'`,
  ], { encoding: 'utf8', timeout: 10000 });
  assert.equal(query.status, 0, 'fixture database query failed');
  assert.equal(query.stdout.trim(), '1|1', 'order must have exactly one verified payment attempt');
}

async function waitForFixturePhoneDispatch(challengeId) {
  assert.ok(uuid.test(challengeId), 'fixture challenge requires a UUID');
  const database = fixtureDatabase();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const query = spawnSync('docker', ['exec', database, 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1',
      '-U', 'storefront_fixture', '-d', 'storefront_fixture', '-c',
      `SELECT state FROM order_access_challenges WHERE id = '${challengeId}'`,
    ], { encoding: 'utf8', timeout: 5000 });
    assert.equal(query.status, 0, 'fixture verification dispatch query failed');
    if (query.stdout.trim() === 'sent') return;
    await delay(150);
  }
  assert.fail('the fixture did not dispatch the SMS challenge');
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
    if (catalogPhotos) await checkOrderPrivacy(browser, ca, order, session.sessionId, cookie);
    else await checkSettledOrderRecovery(page, context, ca, order, session.sessionId);
    assert.deepEqual(failures, []);
  } finally {
    await context.close();
  }
}

async function checkSettledOrderRecovery(page, context, ca, order, oldSessionId) {
  const responseFor = (path, method) => page.waitForResponse(response =>
    response.request().method() === method && new URL(response.url()).pathname === path);
  // Model expiry of only the HttpOnly cookie. Keep the original tab and its checkout journal.
  await context.clearCookies({ name: guestCookie });
  await page.reload();
  await button(page, 'Verify this order by phone').click();
  assert.equal(await page.getByLabel('Order number', { exact: true }).inputValue(), order.id.slice(-8).toUpperCase());
  await page.getByLabel('Phone number', { exact: true }).fill('+250700000000');
  const requested = responseFor('/api/v1/web/order-access/challenges', 'POST');
  await button(page, 'Request verification code').click();
  const challenge = await requested;
  assert.ok(challenge.ok(), 'the returning browser must request its own challenge');
  const { challengeId } = await challenge.json();
  await shown(page, 'Verify your phone');
  await waitForFixturePhoneDispatch(challengeId);
  const codeInput = page.getByLabel('Verification code', { exact: true });
  await codeInput.fill('418263');
  let verified;
  try {
    [verified] = await Promise.all([
      page.waitForResponse(response => response.request().method() === 'POST'
        && new URL(response.url()).pathname === '/api/v1/web/order-access/challenges/' + challengeId + '/verify', { timeout: 20_000 }),
      button(page, 'Verify and open order').click(),
    ]);
  } catch (error) {
    if (evidence) await page.screenshot({ path: resolve(evidence, 'order-recovery-verification-failed.png'),
      mask: [codeInput, page.getByLabel('Phone number', { exact: true })], animations: 'disabled' });
    throw error;
  }
  assert.ok(verified?.ok(), 'the returning browser must recover the paid order by phone');
  assert.equal((await verified.json()).orderId, order.id);
  const recoveredSessionId = (await verified.request().allHeaders())['x-crustcaper-session'];
  assert.ok(uuid.test(recoveredSessionId) && recoveredSessionId !== oldSessionId);
  await page.waitForURL(origin + '/orders');
  await shown(page, 'Paid');
  await checkSettledOrderPresentation(page, context, ca, order.id, recoveredSessionId);

  await page.goto(origin + '/product/double-smash?storefrontLocale=en');
  await button(page, /Add to cart/).click();
  await page.goto(origin + '/cart');
  await button(page, 'Choose pickup time').click();
  await page.getByRole('radiogroup', { name: 'Pickup time' }).getByRole('radio', { disabled: false }).nth(2).click();
  await page.getByLabel('Phone number', { exact: true }).fill('+250700000000');
  await page.getByLabel('Email address', { exact: true }).fill('next-storefront-order@example.test');
  const quote = responseFor('/api/v1/web/quotes', 'POST');
  await button(page, 'Review order').click();
  const quoted = await quote;
  assert.equal(quoted.status(), 200, 'a new quote must use the recovered browser session');
  assert.equal((await quoted.request().allHeaders())['x-crustcaper-session'], recoveredSessionId);
  await shown(page, 'Included tax');
  const placed = responseFor('/api/v1/web/orders', 'POST');
  await button(page, /^Confirm .*RWF/).click();
  const created = await placed;
  assert.equal(created.status(), 200, 'the reviewed new order must be creatable after recovery');
  assert.equal((await created.request().allHeaders())['x-crustcaper-session'], recoveredSessionId);
  const replacement = await created.json();
  assert.ok(uuid.test(replacement.id) && replacement.id !== order.id);
  verifyPaymentRow(order.id);
}

async function checkSettledOrderPresentation(page, context, ca, orderId, recoveredSessionId) {
  const reorder = button(page, 'Review reorder');
  await reorder.waitFor();
  const recoveredCookie = (await context.cookies(origin)).find(cookie => cookie.name === guestCookie);
  assert.ok(recoveredCookie?.httpOnly, 'the recovered order has a browser guest cookie');
  const orderPath = '/api/v1/web/orders/' + orderId;
  await page.route(origin + orderPath, async route => {
    const original = route.request();
    assert.equal(original.method(), 'GET');
    assert.ok((await original.headerValue('x-crustcaper-session')) === recoveredSessionId);
    const loaded = await request(ca, orderPath, { headers: {
      'X-CrustCaper-Session': recoveredSessionId, Cookie: guestCookie + '=' + recoveredCookie.value,
    } });
    assert.equal(loaded.status, 200, 'the original order read must authenticate before cookie loss');
    const previous = JSON.parse(loaded.body);
    assert.ok(previous.id === orderId && previous.paymentStatus === 'paid' && previous.recoveryReadOnly);
    await context.clearCookies({ name: guestCookie });
    await route.fulfill({ status: loaded.status, contentType: 'application/json', body: loaded.body });
  }, { times: 1 });
  const checkedSession = page.waitForResponse(response => response.url() === origin + '/api/v1/web/session'
    && response.request().method() === 'GET');
  void checkedSession.catch(() => undefined);
  try {
    await page.reload();
    await shown(page, 'Paid');
    assert.equal(await reorder.count(), 0, 'a stale read cannot enable reorder after its browser cookie ends');
    assert.equal((await checkedSession).status(), 401);
  } finally {
    await context.addCookies([recoveredCookie]);
  }
}

async function checkOrderPrivacy(browser, ca, order, sessionId, cookie) {
  const orderPath = '/api/v1/web/orders/' + order.id;
  const statusPath = orderPath + '/erasure-request';
  const webHeaders = { 'X-CrustCaper-Session': sessionId, Cookie: guestCookie + '=' + cookie.value };
  assert.equal((await request(ca, orderPath + '/data-export', { headers: webHeaders })).status, 404);
  const context = await newContext(browser, { viewport: { width: 390, height: 844 } }, false);
  try {
    await checkVerifiedOrderPrivacy(browser, await context.newPage(), ca, order, orderPath, statusPath);
  } finally {
    await context.close();
  }
}

async function checkVerifiedOrderPrivacy(browser, page, ca, order, orderPath, statusPath) {
  await page.goto(origin + '/menu/rw');
  await page.locator('a[href="/privacy?storefrontLocale=rw"]').click();
  await page.waitForURL(origin + '/privacy');
  await page.locator('html[lang="rw"]').waitFor({ state: 'attached' });
  await page.getByLabel('Nimero ya komande', { exact: true }).waitFor();
  await checkPrivacyLayout(page, 'rw');
  await page.goto(origin + '/privacy?storefrontLocale=en');
  await page.waitForURL(origin + '/privacy');
  await page.locator('html[lang="en"]').waitFor({ state: 'attached' });
  await page.getByLabel('Order number', { exact: true }).waitFor();
  await checkPrivacyLayout(page, 'en');

  await page.getByLabel('Order number', { exact: true }).fill(order.id.slice(-8).toUpperCase());
  await page.getByLabel('Phone number', { exact: true }).fill('+250700000000');
  await button(page, 'Request verification code').click();
  await shown(page, 'Verify your phone');
  const verificationInput = page.getByLabel('Verification code', { exact: true });
  await verificationInput.fill('123');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await verificationInput.waitFor({ state: 'hidden' });
  await page.evaluate(() => {
    delete document.visibilityState;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await verificationInput.waitFor();
  assert.equal(await verificationInput.inputValue(), '');
  await page.getByLabel('Verification code', { exact: true }).fill('418263');
  let verification;
  for (let attempt = 0; attempt < 3; attempt++) {
    const verified = page.waitForResponse(response => response.request().method() === 'POST'
      && /\/api\/v1\/web\/order-access\/challenges\/[^/]+\/verify$/.test(new URL(response.url()).pathname));
    await button(page, 'Verify and continue').click();
    verification = await verified;
    if (verification.ok()) break;
    assert.equal(verification.status(), 404);
    await delay(500);
  }
  assert.ok(verification?.ok());
  assert.equal((await verification.json()).orderId, order.id);
  assert.equal(new URL(page.url()).search, '');

  const verifiedContext = (await verification.request().allHeaders())['x-crustcaper-session'];
  const freshCookie = (await page.context().cookies(origin)).find(candidate => candidate.name === guestCookie);
  assert.ok(uuid.test(verifiedContext) && freshCookie?.secure && freshCookie.httpOnly);
  const scope = { 'X-CrustCaper-Session': verifiedContext, Cookie: guestCookie + '=' + freshCookie.value };
  assert.equal((await request(ca, statusPath, { method: 'PUT', headers: {
    ...scope, Origin: 'https://other.example.test', 'X-CrustCaper-Web': '1',
  } })).status, 403);
  assert.deepEqual(JSON.parse((await request(ca, statusPath, { headers: scope })).body), { request: null });
  const [download] = await Promise.all([
    page.waitForEvent('download'), button(page, 'Download order data').click(),
  ]);
  try {
    assert.equal(download.suggestedFilename(), 'crustcaper-order-data.json');
    const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
    assert.equal(exported.orderId, order.id);
    assert.equal(exported.paymentStatus, 'paid');
    assert.equal(exported.total, order.total);
    assert.ok(exported.phone === '+250700000000' && exported.email === 'storefront-checkout@example.test');
    assert.deepEqual(Object.keys(exported).sort(), ['createdAt', 'currency', 'email', 'lines', 'orderId', 'paymentStatus',
      'phone', 'pickupEndsAt', 'pickupStartsAt', 'receiptStatus', 'status', 'storeId', 'tax', 'total']);
  } finally {
    await download.delete();
  }
  assert.equal(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage])
    .includes('storefront-checkout@example.test')), false);
  await button(page, 'Request deletion').click();
  const recorded = page.waitForResponse(response => response.request().method() === 'PUT'
    && response.ok() && new URL(response.url()).pathname === statusPath);
  await button(page, 'Submit deletion request').click();
  const { request: accepted } = await (await recorded).json();
  assert.ok(uuid.test(accepted.requestId));
  assert.equal(accepted.status, 'pending');
  await shown(page, 'Pending review');
  await capture(page, 'order-privacy-request-pending');
  const repeat = await request(ca, statusPath, { method: 'PUT', headers: {
    ...scope, Origin: origin, 'X-CrustCaper-Web': '1',
  } });
  assert.deepEqual(JSON.parse(repeat.body), { request: accepted });
  await checkPrivacyStaff(browser, order.id, accepted);
  await page.bringToFront();
  await button(page, 'Check request status').click();
  await shown(page, 'In review');
  const reviewed = await request(ca, statusPath, { headers: scope });
  assert.equal(reviewed.status, 200);
  assert.equal(JSON.parse(reviewed.body).request.status, 'in_review');
  const unchanged = JSON.parse((await request(ca, orderPath, { headers: scope })).body);
  assert.equal(unchanged.paymentStatus, 'paid');
  assert.equal(unchanged.total, order.total);
}

async function checkPrivacyLayout(page, locale) {
  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(scale => { document.documentElement.style.fontSize = scale; }, width === 390 ? '' : '200%');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await capture(page, 'order-privacy-' + locale + '-' + width);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
}

async function checkPrivacyStaff(browser, orderId, accepted) {
  const context = await newContext(browser, { viewport: { width: 390, height: 844 } }, false);
  try {
    const staff = await context.newPage();
    const credentials = provisionStaffCredentials(project, 'manager');
    await staff.goto(origin + '/operator/index.html');
    await staff.getByLabel('Username', { exact: true }).fill(credentials.username);
    await staff.getByLabel('Password', { exact: true }).fill(credentials.password);
    await staff.locator('#authenticator-code').fill(credentials.authenticatorCode);
    await button(staff, 'Sign in').click();
    await button(staff, 'Data requests').click();
    const region = staff.getByRole('region', { name: 'Order data requests' });
    const card = region.getByRole('listitem').filter({ hasText: accepted.requestId });
    await card.getByRole('heading', { name: 'Order #' + orderId.slice(-8).toUpperCase() }).waitFor();
    const result = staff.waitForResponse(response => response.request().method() === 'POST' && response.ok()
      && new URL(response.url()).pathname === '/api/v1/operator/erasure-requests/' + accepted.requestId + '/review');
    await button(card, 'Start review').click();
    const data = await (await result).json();
    assert.deepEqual(Object.keys(data).sort(), ['orderId', 'requestId', 'reviewedAt', 'status', 'submittedAt']);
    assert.equal(data.status, 'in_review');
    assert.equal(data.requestId, accepted.requestId);
    await button(region, 'In review').click();
    await card.getByText(/^Review started /).waitFor();
    await capture(staff, 'order-privacy-manager-review');
    await button(staff, 'Sign out').click();
    await staff.getByLabel('Username', { exact: true }).waitFor();
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
  if (!webPerf) {
    await checkPublicCatalog(ca);
    await checkCheckoutPreflight(caPath);
    await checkNativeReturnPreflight(caPath);
  }
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
