const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const { randomUUID } = require('node:crypto');
const { mkdir } = require('node:fs/promises');
const { resolve } = require('node:path');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { chromium } = require('playwright-core');
const { createPreviewServer } = require('../tooling/preview-server.cjs');

const api = process.env.CRUSTCAPER_API_BASE_URL || 'http://127.0.0.1:18080/api/v1';
const dist = process.env.CRUSTCAPER_CONNECTED_DIST || 'dist-connected';
const contact = { phone: '+250700000000', email: 'integration@example.test' };

function button(page, name) {
  return page.getByRole('button', { name, exact: typeof name === 'string' });
}

async function shown(page, phrase) {
  await page.getByText(phrase, { exact: typeof phrase === 'string' }).filter({ visible: true }).first().waitFor();
}

async function capture(page, name) {
  const directory = process.env.CRUST_SCREENSHOT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, name + '.png'), animations: 'disabled' });
}

async function send(path, { method = 'GET', token, data, key, installationId } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (data) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  if (installationId) headers['X-Installation-Id'] = installationId;
  return fetch(api + path, {
    method, headers, body: data ? JSON.stringify(data) : undefined,
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
}

async function operator(username) {
  const response = await send('/operator/sessions', {
    method: 'POST', data: { username, password: 'local-demo-passphrase' },
  });
  assert.ok(response.ok, 'Local operator must be able to sign in');
  return (await response.json()).accessToken;
}

function testReceipt() {
  const text = 'BT /F1 15 Tf 36 72 Td (CrustCaper synthetic test document) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 120] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ];
  let pdf = '%PDF-1.7\n';
  const offsets = objects.map((value, index) => {
    const offset = pdf.length;
    pdf += `${index + 1} 0 obj\n${value}\nendobj\n`;
    return String(offset).padStart(10, '0') + ' 00000 n \n';
  });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

async function downloadedReceipt(page) {
  const download = page.waitForEvent('download');
  await button(page, 'Download receipt').click();
  const file = await download;
  assert.match(file.suggestedFilename(), /\.pdf$/i);
  const stream = await file.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('connected checkout, receipt, pickup, recovery, payment return and restaurant cancellation', { timeout: 70_000 }, async t => {
  assert.match(api, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/v1$/, 'Run only against a local integration API');
  const server = createPreviewServer(dist);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(9000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));

  const watch = (pattern, method = 'POST') => page.waitForResponse(response =>
    pattern.test(response.url()) && response.request().method() === method && response.ok());
  const opened = 'http://127.0.0.1:' + server.address().port;
  async function openCheckout(screenshot) {
    await page.goto(opened);
    await shown(page, 'Double Smash');
    if (screenshot) {
      await page.evaluate(() => document.fonts.ready);
      await capture(page, screenshot);
    }
    await button(page, /^Double Smash,/).click();
    await button(page, /^Add to cart/).click();
    await button(page, /^View cart/).click();
    await button(page, 'Choose pickup time').click();
    await page.getByRole('radiogroup', { name: 'Pickup time' }).getByRole('radio', { disabled: false }).nth(2).click();
    await page.getByLabel('Phone number', { exact: true }).fill(contact.phone);
    await page.getByLabel('Email address', { exact: true }).fill(contact.email);
    await button(page, 'Review order').click();
    await shown(page, 'Included tax');
    const orderResponse = watch(/\/api\/v1\/orders$/);
    const attemptResponse = watch(/\/api\/v1\/orders\/[^/]+\/payments$/);
    await button(page, /^Confirm .*RWF/).click();
    const order = await (await orderResponse).json();
    const attempt = await (await attemptResponse).json();
    await shown(page, 'Checking payment');
    return { order, attempt };
  }

  const { order, attempt } = await openCheckout('connected-menu');
  assert.equal(order.total, 9200);
  assert.equal(attempt.status, 'processing');
  assert.equal(await button(page, 'Simulate successful payment').count(), 0);

  await page.reload();
  await shown(page, 'Checking payment');
  const token = await page.evaluate(() => {
    const key = Object.keys(sessionStorage).find(key => key.endsWith('.guest'));
    return key ? JSON.parse(sessionStorage.getItem(key)).accessToken : null;
  });
  assert.ok(token, 'Guest session must survive reload');
  const foreign = await send('/guest-sessions', { method: 'POST' }).then(response => response.json());
  const denied = await send('/orders/' + order.id, { token: foreign.accessToken });
  assert.equal(denied.status, 404);
  const settled = watch(/\/api\/v1\/local\/orders\/[^/]+\/payments\/[^/]+\/result$/);
  await button(page, 'Confirm local test payment').click();
  assert.equal((await (await settled).json()).paymentStatus, 'paid');
  await shown(page, 'Order accepted');

  const alertPath = '/orders/' + order.id + '/pickup-alert';
  const installationId = randomUUID();
  assert.equal((await send(alertPath, { installationId })).status, 401);
  assert.equal((await send(alertPath, { token: foreign.accessToken, installationId })).status, 404);
  const alert = await send(alertPath, { token, installationId });
  assert.equal(alert.status, 200);
  assert.equal(alert.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await alert.json(), { available: false, enabled: false });
  assert.equal((await send(alertPath, {
    method: 'PUT', token, installationId, data: { token: 'ExpoPushToken[integration_only]', locale: 'en' },
  })).status, 503);
  assert.equal((await send(alertPath, { method: 'DELETE', token, installationId })).status, 204);

  const kitchen = await operator('demo-kitchen');
  const pickup = await operator('demo-pickup');
  assert.equal((await send('/operator/receipts', { token: kitchen })).status, 403);
  const queue = await send('/operator/orders', { token: kitchen });
  assert.equal(queue.status, 200);
  const visible = (await queue.json()).orders.find(item => item.id === order.id);
  assert.equal(visible.status, 'accepted');
  assert.doesNotMatch(JSON.stringify(visible), /phone|email|pickupCode/);

  const path = '/operator/orders/' + order.id + '/status';
  const advance = (actor, status, pickupCode) => send(path, {
    method: 'POST', token: actor, data: { status, pickupCode },
  });
  assert.equal((await advance(pickup, 'preparing')).status, 403);
  assert.equal((await advance(kitchen, 'preparing')).status, 200);
  assert.equal((await advance(kitchen, 'ready')).status, 200);
  await button(page, 'Refresh order status').click();
  await shown(page, 'Ready for pickup');
  await shown(page, 'Pickup code');
  await capture(page, 'connected-ready');
  const { pickupCode } = await send('/orders/' + order.id, { token }).then(response => response.json());
  assert.match(pickupCode, /^[0-9]{6}$/);

  const manager = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  manager.setDefaultTimeout(9000);
  manager.on('pageerror', error => errors.push(error.message));
  await manager.goto(new URL('/operator/index.html', api).href);
  await manager.getByLabel('Username', { exact: true }).fill('demo-manager');
  await manager.getByLabel('Password', { exact: true }).fill('local-demo-passphrase');
  await button(manager, 'Sign in').click();
  await button(manager, 'Fiscal receipts').click();
  const shortId = order.id.slice(-8).toUpperCase();
  const reference = `FIXTURE-${shortId}`;
  await manager.getByLabel('Filter by order number').fill(shortId);
  const receiptCard = manager.getByRole('list', { name: 'Orders for fiscal receipts' }).getByRole('listitem')
    .filter({ has: manager.getByRole('heading', { name: `Order #${shortId}`, exact: true }) });
  const pdf = testReceipt();
  await receiptCard.getByLabel('EBM receipt reference').fill(reference);
  await receiptCard.getByLabel('Total printed on receipt (RWF)').fill(String(order.total));
  await receiptCard.getByLabel('EBM receipt PDF').setInputFiles({
    name: 'synthetic-ebm-fixture.pdf', mimeType: 'application/pdf', buffer: pdf,
  });
  const attached = manager.waitForResponse(response =>
    response.request().method() === 'PUT' && response.url() === api + `/operator/orders/${order.id}/receipt`);
  await receiptCard.getByRole('button', { name: 'Attach receipt' }).click();
  assert.equal((await attached).status(), 200);
  await receiptCard.getByText(`EBM reference ${reference}`, { exact: true }).waitFor();
  await capture(manager, 'connected-fiscal-receipt');

  assert.equal((await send(`/orders/${order.id}/receipt`)).status, 401);
  assert.equal((await send(`/orders/${order.id}/receipt`, { token: foreign.accessToken })).status, 404);
  await button(page, 'Refresh order status').click();
  assert.ok((await downloadedReceipt(page)).equals(pdf));

  const secondDevice = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  secondDevice.setDefaultTimeout(9000);
  secondDevice.on('pageerror', error => errors.push(error.message));
  await secondDevice.goto(opened + '/orders');
  await shown(secondDevice, 'No orders yet');
  await button(secondDevice, 'Find an order from another device').click();
  await secondDevice.getByLabel('Order number', { exact: true }).fill('#' + order.id.slice(-8).toUpperCase());
  await secondDevice.getByLabel('Phone number', { exact: true }).fill(contact.phone);
  await button(secondDevice, 'Request verification code').click();
  await shown(secondDevice, 'Verify your phone');
  await capture(secondDevice, 'connected-order-recovery');
  await secondDevice.getByLabel('Verification code', { exact: true }).fill('418263');
  let recovery;
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = secondDevice.waitForResponse(response =>
      /\/api\/v1\/order-access\/challenges\/[^/]+\/verify$/.test(response.url()) && response.request().method() === 'POST');
    await button(secondDevice, 'Verify and open order').click();
    recovery = await result;
    if (recovery.ok()) break;
    assert.equal(recovery.status(), 404);
    await delay(500);
  }
  assert.ok(recovery?.ok(), 'The local fixture must complete phone verification');
  assert.deepEqual(await recovery.json(), { orderId: order.id });
  await shown(secondDevice, 'Ready for pickup');
  await shown(secondDevice, pickupCode);
  const recoveredAuthorization = (await recovery.request().allHeaders()).authorization;
  assert.ok(recoveredAuthorization?.startsWith('Bearer '));
  const recoveredToken = recoveredAuthorization.slice(7);
  assert.ok(recoveredToken !== token, 'The second device must retain its own guest identity');
  const disallowedPayment = await send(`/orders/${order.id}/payments`, {
    method: 'POST', token: recoveredToken, key: 'recovered-device-payment',
  });
  assert.equal(disallowedPayment.status, 404);
  assert.ok((await downloadedReceipt(secondDevice)).equals(pdf));
  await secondDevice.close();

  assert.equal((await advance(pickup, 'collected', pickupCode === '000000' ? '999999' : '000000')).status, 409);
  assert.equal((await advance(pickup, 'collected', pickupCode)).status, 200);
  await page.reload();
  await shown(page, 'Picked up');
  assert.equal(await page.getByText('Pickup code', { exact: true }).count(), 0);

  const { order: newerOrder } = await openCheckout();
  const views = [];
  page.on('request', request => {
    if (request.method() === 'GET' && request.url().startsWith(api + '/orders/')) views.push(request.url());
  });
  await page.goto(`${opened}/payment-return?orderId=${order.id}&status=failed`);
  await shown(page, 'Picked up');
  await page.waitForURL(url => url.pathname === '/orders' && url.search === '');
  assert.ok(views.includes(api + '/orders/' + order.id));

  const unknown = randomUUID();
  await page.goto(`${opened}/payment-return?orderId=${unknown}&status=successful`);
  await shown(page, 'Checking payment');
  await page.waitForURL(url => url.pathname === '/orders' && url.search === '');
  assert.ok(views.includes(api + '/orders/' + newerOrder.id));
  assert.ok(!views.includes(api + '/orders/' + unknown));

  await button(page, 'Open payment').click();
  await button(page, 'Confirm local test payment').click();
  await shown(page, 'Order accepted');
  await manager.setViewportSize({ width: 320, height: 844 });
  await button(manager, 'Refresh').click();
  const cancelledShortId = newerOrder.id.slice(-8).toUpperCase();
  const paidCard = manager.getByRole('list', { name: 'Paid orders' }).getByRole('listitem')
    .filter({ has: manager.getByRole('heading', { name: `Order #${cancelledShortId}`, exact: true }) });
  const modal = manager.getByRole('dialog', { name: `Cancel order #${cancelledShortId}?` });
  const cancelPath = `/operator/orders/${newerOrder.id}/cancel`;
  const dispatched = [];
  await manager.route(api + cancelPath, async route => {
    const upstream = await route.fetch();
    dispatched.push({ method: route.request().method(), status: upstream.status(), body: await upstream.json() });
    // Lose the first browser response after the real database transaction commits.
    await route.abort('connectionreset');
  });
  await button(paidCard, 'Cancel order').click();
  await button(modal, 'Keep order').waitFor();
  assert.equal(await button(modal, 'Keep order').evaluate(element => element === document.activeElement), true);
  await capture(manager, 'operator-cancel-confirm-320');
  await button(modal, 'Keep order').click();
  await modal.waitFor({ state: 'hidden' });
  assert.deepEqual(dispatched, []);
  await button(paidCard, 'Cancel order').click();
  await button(modal, 'Confirm cancellation').click();
  await shown(manager, new RegExp('^Order #' + cancelledShortId + ' was cancelled\\.'));
  await paidCard.waitFor({ state: 'detached' });
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].method, 'POST');
  assert.equal(dispatched[0].status, 200);
  assert.equal(dispatched[0].body.status, 'cancelled');
  assert.equal(dispatched[0].body.paymentStatus, 'refund_pending');
  await button(manager, 'Payment review').click();
  const exception = manager.getByRole('list', { name: 'Payment exceptions' }).getByRole('listitem')
    .filter({ hasText: newerOrder.id });
  await exception.getByRole('heading', { name: 'Restaurant cancelled' }).waitFor();

  await button(page, 'Refresh order status').click();
  await shown(page, 'Order cancelled');
  await shown(page, 'Refund pending');
  assert.equal(await page.getByText('Pickup code', { exact: true }).count(), 0);
  await capture(page, 'connected-restaurant-cancelled');
  assert.deepEqual(errors, []);
});

test('payment review displays a verified refund only after the API confirms it', { timeout: 30_000 }, async t => {
  assert.match(api, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/v1$/);
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 320, height: 800 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(6500);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const payment = {
    orderId: '84e40bb7-09b4-4a87-9027-f51487fcaf66', merchantReference: '98fd88b0-01a4-4df4-97fd-e61d7c8aa7c5',
    providerTransactionId: '1011001', reason: 'unavailable_reservation', createdAt: '2026-01-01T12:00:00Z',
  };
  const refund = {
    providerRefundId: '2022002', refundStatus: 'completed-momo', amount: 9200, currency: 'RWF',
    recordedAt: '2026-01-01T12:20:00Z',
  };
  let recorded = false;
  const requested = [];
  await page.route('**/api/v1/operator/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/sessions')) {
      return route.fulfill({ json: { accessToken: 'fixture-session', role: 'manager', storeId: 'kigali',
        expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    }
    if (path.endsWith('/sessions/current')) return route.fulfill({ status: 204, body: '' });
    if (path.endsWith('/orders')) return route.fulfill({ json: { orders: [], serverTime: new Date().toISOString() } });
    if (path.endsWith('/receipts')) return route.fulfill({ json: [] });
    if (path.endsWith('/availability')) return route.fulfill({ json: { version: 'finance-fixture', open: true, products: [] } });
    if (path.endsWith('/payment-exceptions')) {
      return route.fulfill({ json: { exceptions: [recorded ? { ...payment, refund } : payment] } });
    }
    if (path.endsWith(`/payment-exceptions/${payment.merchantReference}/${payment.providerTransactionId}/refund`)) {
      requested.push(request.postDataJSON().providerRefundId);
      assert.equal(request.method(), 'POST');
      if (requested.at(-1) === refund.providerRefundId) {
        recorded = true;
        return route.fulfill({ json: refund });
      }
      return route.fulfill({ status: 409, json: { code: 'refund_unconfirmed' } });
    }
    await route.abort();
  });
  await page.goto(new URL('/operator/index.html', api).href);
  await page.getByLabel('Username', { exact: true }).fill('fixture-manager');
  await page.getByLabel('Password', { exact: true }).fill('fixture-only');
  await button(page, 'Sign in').click();
  await button(page, 'Payment review').click();
  await page.getByLabel('Provider refund ID').fill('2022001');
  await button(page, 'Verify refund').click();
  await shown(page, 'Flutterwave did not confirm a completed full refund for this payment.');
  assert.equal(await page.getByText(/^Refund verified/).count(), 0);
  await page.getByLabel('Provider refund ID').fill(refund.providerRefundId);
  await button(page, 'Verify refund').click();
  await shown(page, 'Refund verified · 9,200 RWF · #2022002');
  await button(page, 'Refresh payment review').click();
  await shown(page, 'Refund verified · 9,200 RWF · #2022002');
  assert.equal(await button(page, 'Verify refund').count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 320);
  assert.deepEqual(requested, ['2022001', '2022002']);
  await capture(page, 'operator-refund-review');
  await button(page, 'Sign out').click();
  await shown(page, 'Staff sign in');
  assert.equal(await page.getByText(/^Refund verified/).count(), 0);
  assert.deepEqual(errors, []);
});

test('a paid order appears on the kitchen screen within ten seconds and is acknowledged by preparation', { timeout: 35_000 }, async t => {
  assert.match(api, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/v1$/);
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(9000);
  await page.goto(new URL('/operator/index.html', api).href);
  await page.getByLabel('Username', { exact: true }).fill('demo-kitchen');
  await page.getByLabel('Password', { exact: true }).fill('local-demo-passphrase');
  const initialQueue = page.waitForResponse(response =>
    response.url() === api + '/operator/orders' && response.request().method() === 'GET' && response.ok());
  await button(page, 'Sign in').click();
  assert.ok(Number.isFinite(Date.parse((await (await initialQueue).json()).serverTime)));

  const menu = await send('/stores/kigali/menu').then(response => response.json());
  const product = menu.products.find(item => item.name.en === 'Double Smash' && item.available);
  const slot = menu.slots.filter(item => item.available).at(-1);
  assert.ok(product && slot, 'The local integration restaurant needs a free pickup slot and an available burger');
  const { accessToken } = await send('/guest-sessions', { method: 'POST' }).then(response => response.json());
  const quote = await send('/quotes', { method: 'POST', token: accessToken, data: {
    storeId: 'kigali', slotId: slot.id, lines: [{ sku: product.sku, modifierIds: [], quantity: 1, unitPrice: product.price }],
  } });
  assert.equal(quote.status, 200);
  const { quoteId } = await quote.json();
  const placed = await send('/orders', { method: 'POST', token: accessToken, key: randomUUID(), data: { quoteId, ...contact } });
  assert.equal(placed.status, 200);
  const { id: orderId } = await placed.json();
  const started = await send('/orders/' + orderId + '/payments', { method: 'POST', token: accessToken, key: randomUUID() });
  assert.equal(started.status, 200);
  const { id: attemptId } = await started.json();
  const card = page.getByRole('list', { name: 'Paid orders' }).getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name: 'Order #' + orderId.slice(-8).toUpperCase(), exact: true }) });
  assert.equal(await card.count(), 0);
  const observed = page.waitForResponse(async response => {
    if (response.url() !== api + '/operator/orders' || !response.ok()) return false;
    return (await response.json()).orders.some(order => order.id === orderId);
  });
  const start = performance.now();
  const settlement = await send('/local/orders/' + orderId + '/payments/' + attemptId + '/result', {
    method: 'POST', token: accessToken, data: { status: 'paid' },
  });
  assert.equal(settlement.status, 200);
  await card.getByText('New', { exact: true }).waitFor({ timeout: 10_000 });
  const elapsed = Math.round(performance.now() - start);
  assert.ok(elapsed <= 10_000, 'Payment request to visible kitchen card took ' + elapsed + ' ms');
  const queue = await (await observed).json();
  const admitted = queue.orders.find(order => order.id === orderId);
  assert.ok(Number.isFinite(Date.parse(admitted.acceptedAt)));
  assert.ok(Date.parse(admitted.acceptedAt) <= Date.parse(queue.serverTime));
  await shown(page, 'New paid orders');
  await capture(page, 'operator-new-paid-order');
  t.diagnostic('Payment request to visible kitchen card: ' + elapsed + ' ms on loopback with a foreground Chrome tab');

  const path = '/operator/orders/' + orderId + '/status';
  const committed = Promise.withResolvers();
  const release = Promise.withResolvers();
  await page.route(api + path, async route => {
    const result = await route.fetch();
    committed.resolve({ status: result.status(), order: await result.json() });
    await release.promise;
    await route.fulfill({ response: result });
  });
  try {
    await button(card, 'Start preparing').click();
    const accepted = await committed.promise;
    assert.equal(accepted.status, 200);
    assert.equal(accepted.order.status, 'preparing');
    assert.equal(accepted.order.acceptedAt, admitted.acceptedAt);

    const ready = await send(path, { method: 'POST', token: await operator('demo-kitchen'), data: { status: 'ready' } });
    assert.equal(ready.status, 200);
    await card.getByText('Ready for pickup', { exact: true }).waitFor();
    await page.evaluate(shortId => {
      const list = document.querySelector('#order-list');
      window.kitchenStates = [];
      new MutationObserver(() => {
        const order = [...list.children].find(item => item.querySelector('.order-title')?.textContent === 'Order #' + shortId);
        if (order) window.kitchenStates.push(order.querySelector('.order-status')?.textContent);
      }).observe(list, { subtree: true, childList: true });
    }, orderId.slice(-8).toUpperCase());
    const refreshed = page.waitForResponse(response => response.url() === api + '/operator/orders' && response.ok());
    release.resolve();
    await refreshed;
    await card.getByText('Ready for pickup', { exact: true }).waitFor();
    assert.ok((await page.evaluate(() => window.kitchenStates)).every(state => state === 'Ready for pickup'));
  } finally {
    release.resolve();
  }
});

test('kitchen sound follows a fresh paid queue, stops offline and clears after server acknowledgment', { timeout: 30_000 }, async t => {
  assert.match(api, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/v1$/);
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 320, height: 800 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(6500);
  await page.clock.install();
  await page.addInitScript(() => {
    window.orderSoundStarts = 0;
    const parameter = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} });
    window.AudioContext = class extends EventTarget {
      state = 'suspended';
      destination = {};
      get currentTime() { return performance.now() / 1000; }
      changeState(state) {
        this.state = state;
        this.dispatchEvent(new Event('statechange'));
        return Promise.resolve();
      }
      resume() { return this.changeState('running'); }
      suspend() { return this.changeState('suspended'); }
      close() { return this.changeState('closed'); }
      createOscillator() {
        return { frequency: parameter(), connect() {}, stop() {}, disconnect() {}, addEventListener() {},
          start() { window.orderSoundStarts++; } };
      }
      createGain() { return { gain: parameter(), connect() {}, disconnect() {} }; }
    };
  });
  const order = {
    id: 'b6be5c82-c61d-4b70-8f5a-43214cab6005', status: 'accepted', paymentStatus: 'paid',
    acceptedAt: '2031-01-01T12:00:00Z', pickupStartsAt: '2031-01-01T12:10:00Z', pickupEndsAt: '2031-01-01T12:20:00Z',
    lines: [{ sku: 'double-smash', modifierIds: [], quantity: 1 }],
  };
  let failReads = false;
  let preparations = 0;
  await page.route('**/api/v1/operator/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/sessions')) {
      return route.fulfill({ json: { accessToken: 'fixture-kitchen-session', role: 'kitchen', storeId: 'kigali',
        expiresAt: new Date(Date.now() + 240_000).toISOString() } });
    }
    if (path.endsWith('/orders')) {
      if (failReads) return route.fulfill({ status: 503, json: { code: 'service_unavailable' } });
      return route.fulfill({ json: { orders: [order], serverTime: '2031-01-01T12:01:05Z' } });
    }
    if (path.endsWith('/orders/' + order.id + '/status') && request.method() === 'POST') {
      preparations++;
      order.status = 'preparing';
      return route.fulfill({ json: order });
    }
    await route.abort();
  });
  await page.goto(new URL('/operator/index.html', api).href);
  await page.getByLabel('Username', { exact: true }).fill('fixture-kitchen');
  await page.getByLabel('Password', { exact: true }).fill('fixture-only');
  await button(page, 'Sign in').click();
  await shown(page, '1 order awaiting preparation.');
  await shown(page, 'Check this order');
  const tones = () => page.evaluate(() => window.orderSoundStarts);
  assert.equal(await tones(), 0);
  await button(page, 'Enable order sound').click();
  await button(page, 'Mute order sound').waitFor();
  await page.waitForFunction(() => window.orderSoundStarts === 1);
  for (let count = 0; count < 4; count++) {
    const refreshed = page.waitForResponse(response => response.url() === api + '/operator/orders' && response.ok());
    await page.clock.runFor(5_100);
    await refreshed;
  }
  await page.waitForFunction(() => window.orderSoundStarts >= 2);
  await capture(page, 'operator-unacknowledged-kitchen-order');

  await page.context().setOffline(true);
  await shown(page, 'You are offline. Reconnect to refresh the kitchen queue.');
  assert.equal(await button(page, 'Start preparing').isDisabled(), true);
  const offlineTones = await tones();
  await page.clock.runFor(25_000);
  assert.equal(await tones(), offlineTones);
  assert.equal(preparations, 0);
  await capture(page, 'operator-kitchen-offline');

  failReads = true;
  await page.context().setOffline(false);
  await shown(page, 'The kitchen queue may be out of date. Refresh before starting an order.');
  assert.equal(await button(page, 'Start preparing').isDisabled(), true);
  failReads = false;
  await button(page, 'Refresh').click();
  await shown(page, '1 order awaiting preparation.');
  await button(page, 'Start preparing').click();
  await shown(page, 'Preparing');
  assert.equal(preparations, 1);
  await page.getByText('1 order awaiting preparation.', { exact: true }).waitFor({ state: 'hidden' });
  const preparedTones = await tones();
  await page.clock.runFor(25_000);
  assert.equal(await tones(), preparedTones);
});

test('manager stop list and pause apply to new orders and preserve the paid kitchen queue', { timeout: 50_000 }, async t => {
  assert.match(api, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/v1$/);
  const staff = await operator('demo-manager');
  const kitchen = await operator('demo-kitchen');
  const availabilityPath = '/operator/availability';
  assert.equal((await send(availabilityPath, { token: kitchen })).status, 403);
  const original = await send(availabilityPath, { token: staff }).then(response => response.json());
  const initialItem = original.products.find(item => item.name.en === 'Double Smash');
  assert.ok(original.open && initialItem?.available, 'Integration restaurant must start open with Double Smash available');

  const snapshot = () => send(availabilityPath, { token: staff }).then(response => response.json());
  const change = (version, update) => send(availabilityPath, { method: 'PATCH', token: staff,
    data: { expectedVersion: version, ...update } });
  t.after(async () => {
    let current = await snapshot();
    if (current.open !== original.open) {
      const restored = await change(current.version, { open: original.open });
      assert.ok(restored.ok, 'Restore the integration store after this test');
      current = await restored.json();
    }
    if (current.products.find(item => item.sku === initialItem.sku)?.available !== initialItem.available) {
      const restored = await change(current.version, { sku: initialItem.sku, available: initialItem.available });
      assert.ok(restored.ok, 'Restore the integration product after this test');
    }
  });

  const menuUrl = '/stores/kigali/menu';
  const menu = await send(menuUrl).then(response => response.json());
  const slotId = menu.slots.filter(slot => slot.available).at(4).id;
  const product = menu.products.find(item => item.sku === initialItem.sku);
  const purchase = { storeId: 'kigali', slotId, lines: [{ sku: initialItem.sku, modifierIds: [], quantity: 1, unitPrice: product.price }] };
  const { accessToken } = await send('/guest-sessions', { method: 'POST' }).then(response => response.json());
  const quote = () => send('/quotes', { token: accessToken, method: 'POST', data: purchase });
  const create = (quoteId) => send('/orders', { token: accessToken, method: 'POST', key: randomUUID(), data: { quoteId, ...contact } });
  const { quoteId } = await quote().then(response => response.json());
  const placed = await create(quoteId).then(response => response.json());
  const payment = await send(`/orders/${placed.id}/payments`, { token: accessToken, method: 'POST', key: randomUUID() })
    .then(response => response.json());
  const settled = await send(`/local/orders/${placed.id}/payments/${payment.id}/result`, {
    token: accessToken, method: 'POST', data: { status: 'paid' },
  });
  assert.ok(settled.ok);
  const staleQuote = await quote().then(response => response.json());

  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(6500);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(new URL('/operator/index.html', api).href);
  await page.getByLabel('Username', { exact: true }).fill('demo-manager');
  await page.getByLabel('Password', { exact: true }).fill('local-demo-passphrase');
  await button(page, 'Sign in').click();
  await button(page, 'Menu availability').click();
  await button(page, 'Put on stop list: Double Smash').click();
  await shown(page, 'Double Smash is on the stop list.');
  const stoppedMenu = await send(menuUrl).then(response => response.json());
  assert.notEqual(stoppedMenu.version, menu.version);
  assert.equal(stoppedMenu.products.find(item => item.sku === initialItem.sku).available, false);
  const rejected = await create(staleQuote.quoteId);
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).code, 'quote_changed');

  const current = await snapshot();
  const paused = await change(current.version, { open: false });
  assert.ok(paused.ok, 'A second manager may pause new orders');
  await button(page, 'Pause new orders').click();
  await shown(page, 'Availability changed. Refresh the menu and review it before trying again.');
  assert.ok(await button(page, 'Pause new orders').isDisabled());
  await button(page, 'Refresh availability').click();
  await shown(page, 'New orders paused');
  const closedQuote = await quote();
  assert.equal(closedQuote.status, 409);
  assert.equal((await closedQuote.json()).code, 'slot_unavailable');
  const queue = await send('/operator/orders', { token: kitchen }).then(response => response.json());
  assert.ok(queue.orders.some(order => order.id === placed.id && order.status === 'accepted' && order.paymentStatus === 'paid'));
  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    await shown(page, 'New orders paused');
  }
  await page.setViewportSize({ width: 320, height: 844 });
  await page.getByRole('heading', { name: 'Menu availability' }).scrollIntoViewIfNeeded();
  await capture(page, 'operator-menu-availability');

  await button(page, 'Accept new orders').click();
  await shown(page, 'The restaurant is accepting new orders.');
  await button(page, 'Resume item: Double Smash').click();
  await shown(page, 'Double Smash is available.');
  const reopened = await send(menuUrl).then(response => response.json());
  assert.equal(reopened.store.open, true);
  assert.equal(reopened.products.find(item => item.sku === initialItem.sku).available, true);
  assert.deepEqual(errors, []);
});

test('pickup limits protect existing holds, block additional checkout and open the window again', { timeout: 45_000 }, async t => {
  assert.match(api, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/v1$/);
  const path = '/operator/availability';
  const staff = await operator('demo-manager');
  const menu = () => send('/stores/kigali/menu').then(response => response.json());
  const getLimits = () => send(path, { token: staff }).then(response => response.json());
  const patch = (version, slotId, capacity, token = staff) => send(path, { method: 'PATCH', token,
    data: { expectedVersion: version, slotId, capacity } });
  const liveMenu = await menu();
  const original = await getLimits();
  const product = liveMenu.products.find(item => item.name.en === 'Double Smash' && item.available);
  const publicSlots = new Set(liveMenu.slots.filter(slot => slot.available).map(slot => slot.id));
  const slot = original.slots.findLast(item => publicSlots.has(item.id) && item.capacity >= 2 && item.reserved === 0);
  assert.ok(product && slot, 'The integration restaurant needs a future empty window with at least two places');

  t.after(async () => {
    const current = await getLimits();
    if (current.slots.find(item => item.id === slot.id)?.capacity !== slot.capacity) {
      const restored = await patch(current.version, slot.id, slot.capacity);
      assert.ok(restored.ok, 'Restore the fixture window limit');
    }
  });
  const denied = await patch(original.version, slot.id, 0, await operator('demo-kitchen'));
  assert.equal(denied.status, 403);

  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 320, height: 844 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(8500);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(new URL('/operator/index.html', api).href);
  await page.getByLabel('Username', { exact: true }).fill('demo-manager');
  await page.getByLabel('Password', { exact: true }).fill('local-demo-passphrase');
  await button(page, 'Sign in').click();
  await button(page, 'Menu availability').click();
  const windowInput = page.getByLabel('Pickup window', { exact: true });
  const limit = page.getByLabel('Pickup limit', { exact: true });
  await windowInput.selectOption(slot.id);
  await shown(page, 'Active reservations: 0');

  const selection = { storeId: 'kigali', slotId: slot.id,
    lines: [{ sku: product.sku, modifierIds: [], quantity: 1, unitPrice: product.price }] };
  const prepare = async () => {
    const { accessToken: token } = await send('/guest-sessions', { method: 'POST' }).then(response => response.json());
    const quote = await send('/quotes', { method: 'POST', token, data: selection });
    assert.equal(quote.status, 200);
    const { quoteId } = await quote.json();
    return { token, place: () => send('/orders', { method: 'POST', token, key: randomUUID(), data: { quoteId, ...contact } }) };
  };
  const first = await prepare();
  const second = await prepare();
  const held = await first.place();
  assert.equal(held.status, 200);
  const pending = await held.json();

  async function save(value) {
    const response = page.waitForResponse(reply => reply.url() === api + path && reply.request().method() === 'PATCH');
    await limit.fill(String(value));
    await button(page, 'Save pickup limit').click();
    return response;
  }
  const rejected = await save(0);
  assert.equal(rejected.status(), 409);
  assert.equal((await rejected.json()).code, 'slot_capacity_below_reserved');
  await shown(page, 'Active reservations: 1');

  const accepted = await save(1);
  assert.equal(accepted.status(), 200);
  const reduced = await accepted.json();
  assert.notEqual(reduced.version, original.version);
  assert.deepEqual(reduced.slots.find(item => item.id === slot.id), { ...slot, capacity: 1, reserved: 1 });
  await shown(page, 'Pickup limit saved.');
  await shown(page, 'Current limit: 1');
  assert.equal(await windowInput.inputValue(), slot.id);
  await capture(page, 'operator-pickup-limit');

  assert.equal((await menu()).slots.find(item => item.id === slot.id).available, false);
  const blocked = await second.place();
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).code, 'slot_unavailable');
  const start = await send('/orders/' + pending.id + '/payments', { method: 'POST', token: first.token, key: randomUUID() });
  assert.equal(start.status, 200);
  const attempt = await start.json();
  const settled = await send('/local/orders/' + pending.id + '/payments/' + attempt.id + '/result', {
    method: 'POST', token: first.token, data: { status: 'paid' },
  });
  assert.equal(settled.status, 200);
  assert.equal((await settled.json()).paymentStatus, 'paid');

  const reopenedWrites = [];
  await page.route(api + path, async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    const result = await route.fetch();
    reopenedWrites.push(result.status());
    // The restaurant saved the new limit, but the manager did not receive the response.
    await route.abort('connectionreset');
  });
  await limit.fill(String(slot.capacity));
  await button(page, 'Save pickup limit').click();
  await shown(page, 'The current pickup limit matches your request.');
  assert.deepEqual(reopenedWrites, [200]);
  await shown(page, 'Current limit: ' + slot.capacity);
  assert.equal((await menu()).slots.find(item => item.id === slot.id).available, true);
  assert.equal((await second.place()).status, 200);
  assert.deepEqual(errors, []);
});
