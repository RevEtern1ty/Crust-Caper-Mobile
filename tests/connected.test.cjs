const assert = require('node:assert/strict');
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

async function send(path, { method = 'GET', token, data, key } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (data) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
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

test('connected checkout, pickup, cross-device recovery and payment return', { timeout: 70_000 }, async t => {
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

  const kitchen = await operator('demo-kitchen');
  const pickup = await operator('demo-pickup');
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
  assert.deepEqual(errors, []);
});
