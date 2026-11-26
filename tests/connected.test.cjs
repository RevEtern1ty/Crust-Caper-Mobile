const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const { randomUUID } = require('node:crypto');
const { mkdir } = require('node:fs/promises');
const { dirname, resolve } = require('node:path');
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

async function restrictToOperatorAssets(page) {
  const origin = new URL(api).origin;
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.origin === origin && url.pathname.startsWith('/operator/') ? route.continue() : route.abort();
  });
}

async function send(path, { method = 'GET', token, data, key, installationId, baseUrl = api } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (data) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  if (installationId) headers['X-Installation-Id'] = installationId;
  return fetch(baseUrl + path, {
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

async function readyForPickup(kitchen, { buyer = contact, guestToken, quantity = 1 } = {}) {
  const { products, slots, store } = await send('/stores/kigali/menu').then(response => response.json());
  const product = products.find(item => item.name.en === 'Double Smash' && item.available);
  const slot = slots.findLast(item => item.available);
  assert.ok(product && slot);
  const token = guestToken ?? (await send('/guest-sessions', { method: 'POST' }).then(response => response.json())).accessToken;
  const quote = await send('/quotes', { method: 'POST', token, data: {
    storeId: store.id, slotId: slot.id, lines: [{ sku: product.sku, modifierIds: [], quantity, unitPrice: product.price }],
  } });
  assert.equal(quote.status, 200);
  const { quoteId } = await quote.json();
  const placed = await send('/orders', { method: 'POST', token, key: randomUUID(), data: { quoteId, ...buyer } });
  assert.equal(placed.status, 200);
  const { id } = await placed.json();
  const started = await send(`/orders/${id}/payments`, { method: 'POST', token, key: randomUUID() });
  assert.equal(started.status, 200);
  const { id: attemptId } = await started.json();
  const settled = await send(`/local/orders/${id}/payments/${attemptId}/result`, { method: 'POST', token, data: { status: 'paid' } });
  assert.equal(settled.status, 200);
  for (const status of ['preparing', 'ready']) {
    assert.equal((await send(`/operator/orders/${id}/status`, { method: 'POST', token: kitchen, data: { status } })).status, 200);
  }
  const { pickupCode, total, currency } = await send(`/orders/${id}`, { token }).then(response => response.json());
  assert.match(pickupCode, /^[0-9]{6}$/);
  return { id, token, pickupCode, total, currency, number: '#' + id.slice(-8).toUpperCase() };
}

test('delivery intake and handoff recover lost replies alongside a paid direct order', { timeout: 35_000 }, async t => {
  const kitchen = await operator('demo-kitchen');
  const pickup = await operator('demo-pickup');
  const manager = await operator('demo-manager');
  const direct = await readyForPickup(kitchen);
  t.after(async () => {
    await send(`/operator/orders/${direct.id}/status`, {
      method: 'POST', token: pickup, data: { status: 'collected', pickupCode: direct.pickupCode },
    });
    for (const token of [kitchen, pickup, manager]) await send('/operator/sessions/current', { method: 'DELETE', token });
  });
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const reference = `00A-${randomUUID().slice(0, 8)}`;
  const orderUrl = api + '/operator/external-orders';
  const card = page => page.locator('#order-list > li').filter({ hasText: reference });
  async function signIn(page, username) {
    page.setDefaultTimeout(8_000);
    await page.goto(new URL('/operator/index.html', api).href);
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill('local-demo-passphrase');
    await button(page, 'Sign in').click();
    await page.locator('#workstation-title').waitFor();
  }
  const staffPage = await browser.newPage({ viewport: { width: 390, height: 844 }, timezoneId: 'Pacific/Honolulu' });
  await signIn(staffPage, 'demo-pickup');
  const directCard = page => page.locator('#order-list > li').filter({
    has: page.getByRole('heading', { name: `Order ${direct.number}`, exact: true }),
  });
  assert.equal(direct.currency, 'RWF');
  const paidTotal = `Paid total ${direct.total.toLocaleString('en-GB')} RWF`;
  await shown(directCard(staffPage), paidTotal);
  await button(staffPage, 'Add delivery order').click();
  const platform = staffPage.getByLabel('Delivery platform', { exact: true });
  await platform.selectOption('test-platform');
  await staffPage.getByLabel('External order reference', { exact: true }).fill(reference);
  await staffPage.getByLabel('Scheduled time (Kigali)', { exact: true }).fill('2026-11-26T12:40');
  await staffPage.getByLabel('Item name', { exact: true }).first().fill('Platform sandwich');
  await staffPage.getByLabel('Quantity', { exact: true }).first().fill('2');
  await button(staffPage, 'Add modifier').first().click();
  await staffPage.getByLabel('Modifier name', { exact: true }).first().fill('No onion');
  const intake = staffPage.getByRole('region', { name: 'Delivery order intake' });
  for (const width of [320, 390, 430]) {
    await staffPage.setViewportSize({ width, height: 844 });
    for (const scale of [100, 200]) {
      await staffPage.evaluate(value => { document.documentElement.style.fontSize = `${value}%`; }, scale);
      await intake.getByRole('heading').evaluate(element => element.scrollIntoView({ block: 'start' }));
      assert.equal(await staffPage.evaluate(() => document.documentElement.scrollWidth), width);
      await capture(staffPage, `delivery-intake-${width}-${scale}`);
    }
  }
  await staffPage.evaluate(() => document.documentElement.style.removeProperty('font-size'));
  await staffPage.setViewportSize({ width: 390, height: 844 });

  const registrations = [];
  let registered;
  await staffPage.route(orderUrl, async route => {
    const request = route.request();
    if (request.method() !== 'POST') return route.continue();
    registrations.push(request.postDataJSON());
    const result = await route.fetch();
    if (registrations.length === 1) {
      assert.equal(result.status(), 201);
      registered = await result.json();
      return route.abort();
    }
    assert.equal(result.status(), 200);
    assert.equal((await result.json()).id, registered.id);
    return route.fulfill({ response: result });
  });

  const save = button(staffPage, 'Save delivery order');
  await save.click();
  await button(staffPage, 'Retry delivery order').click();
  await card(staffPage).waitFor();
  assert.deepEqual(registrations[0], registrations[1], 'retry must submit the same intake');
  assert.equal(registered.scheduledAt, '2026-11-26T10:40:00Z');
  assert.equal(registered.lines[0].quantity, 2);
  assert.deepEqual(registered.lines[0].modifiers, ['No onion']);

  const kitchenPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await signIn(kitchenPage, 'demo-kitchen');
  const external = card(kitchenPage);
  await external.waitFor();
  await shown(kitchenPage, `Order ${direct.number}`);
  await shown(directCard(kitchenPage), paidTotal);
  assert.equal(await external.getByText(/Paid total/).count(), 0);
  assert.equal(Object.hasOwn(registered, 'total'), false);
  for (const width of [320, 390, 430]) {
    await kitchenPage.setViewportSize({ width, height: 844 });
    for (const scale of [100, 200]) {
      await kitchenPage.evaluate(value => { document.documentElement.style.fontSize = `${value}%`; }, scale);
      await shown(directCard(kitchenPage), paidTotal);
      assert.equal(await kitchenPage.evaluate(() => document.documentElement.scrollWidth), width);
    }
  }
  await kitchenPage.evaluate(() => document.documentElement.style.removeProperty('font-size'));
  await kitchenPage.setViewportSize({ width: 390, height: 844 });
  assert.equal(await button(kitchenPage, 'Add delivery order').isVisible(), false);
  assert.match(await external.innerText(), /Test delivery/);
  assert.match(await external.innerText(), /Platform sandwich/);
  assert.match(await external.innerText(), /No onion/);
  await capture(kitchenPage, 'delivery-kitchen-mixed-390');
  await button(external, 'Start preparing').click();
  await button(external, 'Mark ready').click();

  const staffCard = card(staffPage);
  await button(staffPage, 'Refresh').click();
  const handedOff = button(staffCard, 'Confirm handoff');
  const externalReference = staffCard.getByLabel('External reference', { exact: true });
  await externalReference.fill(`1${reference}`);
  const change = orderUrl + `/${registered.id}/status`;
  const rejected = staffPage.waitForResponse(response => response.url() === change && response.status() === 409);
  await handedOff.click();
  await rejected;
  await externalReference.fill(reference);

  const consumed = [];
  await staffPage.route(change, async route => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    consumed.push(await response.json());
    await route.abort();
  });
  const checked = staffPage.waitForResponse(response => response.url() === `${orderUrl}/${registered.id}` && response.status() === 200);
  await handedOff.click();
  const recovered = await (await checked).json();
  assert.equal(recovered.status, 'collected');
  assert.equal(recovered.confirmedByCurrentOperator, true);
  assert.deepEqual(consumed, [recovered]);
  await staffCard.waitFor({ state: 'hidden' });

  const queue = await send('/operator/orders', { token: kitchen }).then(response => response.json());
  assert.ok(queue.orders.some(order => order.id === direct.id && order.paymentStatus === 'paid'));
  assert.ok(!queue.externalOrders?.some(order => order.id === registered.id));
  assert.equal((await send(`/orders/${registered.id}`, { token: direct.token })).status, 404);
  assert.equal((await send(`/operator/orders/${registered.id}/pickup-status`, { token: pickup })).status, 404);

  const nonBmpName = '🥗'.repeat(61);
  const unicodeOrder = await send('/operator/external-orders', { method: 'POST', token: pickup, data: {
    ...registrations[0], externalReference: `U-${reference}`, lines: [{ name: nonBmpName, quantity: 1 }],
  } });
  assert.equal(unicodeOrder.status, 201);
  const unicodeId = (await unicodeOrder.json()).id;
  try {
    await button(kitchenPage, 'Refresh').click();
    await shown(kitchenPage, nonBmpName);
    await shown(kitchenPage, `Order ${direct.number}`);
    assert.equal(await kitchenPage.evaluate(() => document.documentElement.scrollWidth), 390);
  } finally {
    assert.equal((await send(`/operator/external-orders/${unicodeId}/status`, {
      method: 'POST', token: manager, data: { status: 'cancelled' },
    })).status, 200);
  }

  await staffPage.unroute(orderUrl);
  const unavailableReference = staffPage.getByLabel('External order reference', { exact: true });
  await platform.selectOption('test-platform');
  await unavailableReference.fill('UNAVAILABLE-' + reference);
  await staffPage.getByLabel('Scheduled time (Kigali)', { exact: true }).fill('2026-11-26T12:45');
  await staffPage.getByLabel('Item name', { exact: true }).first().fill('Saved delivery draft');
  let attempts = 0;
  await staffPage.route(orderUrl, route => ++attempts === 1 ? route.abort() : route.fulfill({
    status: 409,
    json: { status: 409, code: 'external_channel_unavailable' },
  }));
  await save.click();
  await button(staffPage, 'Retry delivery order').click();
  await button(staffPage, 'Reload delivery platforms').waitFor();
  assert.equal(await unavailableReference.isEditable(), true);
  assert.equal(await unavailableReference.inputValue(), 'UNAVAILABLE-' + reference);
});

test('a delayed delivery preparation response preserves the newer queue through an outage', { timeout: 25_000 }, async t => {
  let origin;
  if (process.env.CRUSTCAPER_API_BASE_URL) {
    assert.match(api, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/v1$/);
    origin = new URL(api).origin;
  } else {
    const server = createPreviewServer(resolve(dirname(module.filename), '../server/src/main/resources/static'));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    origin = `http://127.0.0.1:${server.address().port}`;
  }
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const order = {
    id: 'c6d94914-6a8d-4f7b-8353-8772685a9b65', channel: 'test-platform', channelLabel: 'Test delivery',
    externalReference: 'KITCHEN-41', status: 'accepted', confirmedByCurrentOperator: false,
    acceptedAt: '2031-01-01T12:00:00Z', scheduledAt: '2031-01-01T12:10:00Z',
    lines: [{ name: 'Fixture sandwich', quantity: 1, modifiers: [] }],
  };
  const ordersUrl = origin + '/api/v1/operator/orders';
  const orderUrl = origin + '/api/v1/operator/external-orders/' + order.id;
  const transitionUrl = orderUrl + '/status';
  for (const removed of [false, true]) {
    const delayedUrl = removed ? orderUrl : transitionUrl;
    await t.test(removed ? 'terminal order and delayed recovery read' : 'ready order and delayed write reply', async t => {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      t.after(() => page.close());
      page.setDefaultTimeout(6500);
      const releasePreparation = Promise.withResolvers();
      let queueUnavailable = false;
      let externalOrders = [order];
      await page.route(origin + '/api/v1/operator/**', async route => {
        const request = route.request();
        if (request.url() === origin + '/api/v1/operator/sessions') {
          return route.fulfill({ status: 201, json: { accessToken: 'fixture-token', role: 'kitchen', storeId: 'kigali',
            expiresAt: new Date(Date.now() + 120_000).toISOString() } });
        }
        if (request.url() === ordersUrl) {
          return queueUnavailable ? route.fulfill({ status: 503, json: { code: 'service_unavailable' } })
            : route.fulfill({ json: { orders: [], externalOrders, serverTime: '2031-01-01T12:00:05Z' } });
        }
        if (request.url() === delayedUrl) {
          await releasePreparation.promise;
          return route.fulfill({ json: { ...order, status: 'preparing' } });
        }
        return route.abort();
      });

      try {
        await page.goto(origin + '/operator/index.html');
        await page.getByLabel('Username', { exact: true }).fill('fixture-kitchen');
        await page.getByLabel('Password', { exact: true }).fill('fixture-only');
        await button(page, 'Sign in').click();
        const card = page.getByRole('list', { name: 'Orders', exact: true }).getByRole('listitem')
          .filter({ hasText: order.externalReference });
        const preparation = page.waitForRequest(request => request.url() === transitionUrl && request.method() === 'POST');
        const pending = page.waitForRequest(request => request.url() === delayedUrl);
        await button(card, 'Start preparing').click();
        assert.deepEqual((await preparation).postDataJSON(), { status: 'preparing' });
        await pending;

        // A second operator advances or hands off the order while the first response is in flight.
        externalOrders = removed ? [] : [{ ...order, status: 'ready' }];
        await button(page, 'Refresh').click();
        if (removed) await shown(page, 'No orders are waiting.');
        else await shown(card, 'Ready for handoff');

        queueUnavailable = true;
        releasePreparation.resolve();
        await shown(page, 'The order queue could not be refreshed. Try again.');
        if (removed) assert.equal(await card.count(), 0);
        else assert.equal(await card.locator('.order-status').textContent(), 'Ready for handoff');
        assert.equal(await button(card, 'Mark ready').count(), 0);
        const expectedNotice = removed ? 'no longer in the active queue' : 'ready for handoff';
        assert.equal(await page.locator('#external-queue-notice').textContent(), `Delivery order KITCHEN-41 is ${expectedNotice}.`);
      } finally {
        releasePreparation.resolve();
      }
    });
  }
});

test('pickup is checked against the server after a lost reply or a concurrent cancellation', { timeout: 35_000 }, async t => {
  assert.match(api, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/v1$/);
  const kitchen = await operator('demo-kitchen');
  const manager = await operator('demo-manager');
  const handedOut = await readyForPickup(kitchen);
  const cancelled = await readyForPickup(kitchen);
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(6500);
  await page.goto(new URL('/operator/index.html', api).href);
  await page.getByLabel('Username', { exact: true }).fill('demo-pickup');
  await page.getByLabel('Password', { exact: true }).fill('local-demo-passphrase');
  await button(page, 'Sign in').click();
  await shown(page, 'Pickup queue');

  const card = order => page.getByRole('list', { name: 'Orders', exact: true }).getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name: 'Order ' + order.number, exact: true }) });
  const notice = page.locator('#queue-notice');
  const pickupStatus = order => api + `/operator/orders/${order.id}/pickup-status`;
  const attempts = [];
  await page.route(api + `/operator/orders/${handedOut.id}/status`, async route => {
    const response = await route.fetch();
    attempts.push(response.status());
    await route.abort('connectionreset');
  });
  await page.route(pickupStatus(handedOut), route => route.abort('connectionreset'), { times: 1 });
  await card(handedOut).getByLabel('Pickup code').fill(handedOut.pickupCode);
  await button(card(handedOut), 'Confirm pickup').click();
  await shown(page, `Pickup for order ${handedOut.number} could not be confirmed. Select Refresh to check the server before handing it out.`);
  await capture(page, 'operator-pickup-unconfirmed');
  const checked = page.waitForResponse(response => response.url() === pickupStatus(handedOut) && response.ok());
  await button(page, 'Refresh').click();
  assert.deepEqual(await (await checked).json(), {
    id: handedOut.id, status: 'collected', confirmedByCurrentOperator: true,
  });
  assert.equal((await checked).headers()['cache-control'], 'no-store');
  await shown(page, `Pickup for order ${handedOut.number} was confirmed by this account.`);
  assert.ok((await notice.textContent()).includes(handedOut.number));
  await card(handedOut).waitFor({ state: 'detached' });
  assert.deepEqual(attempts, [200]);

  await page.route(api + `/operator/orders/${cancelled.id}/status`, async route => {
    const result = await send(`/operator/orders/${cancelled.id}/cancel`, { method: 'POST', token: manager });
    assert.equal(result.status, 200);
    await route.continue();
  }, { times: 1 });
  await card(cancelled).getByLabel('Pickup code').fill(cancelled.pickupCode);
  const cancellationRead = page.waitForResponse(response => response.url() === pickupStatus(cancelled) && response.ok());
  await button(card(cancelled), 'Confirm pickup').click();
  assert.deepEqual(await (await cancellationRead).json(), {
    id: cancelled.id, status: 'cancelled', confirmedByCurrentOperator: false,
  });
  await shown(page, `Order ${cancelled.number} was cancelled. Do not hand it out.`);
  await card(cancelled).waitFor({ state: 'detached' });
  assert.equal((await (await send(`/orders/${handedOut.id}`, { token: handedOut.token })).json()).status, 'collected');
  assert.equal((await (await send(`/orders/${cancelled.id}`, { token: cancelled.token })).json()).paymentStatus, 'refund_pending');
});

test('pickup staff locate a paid order without the buyer screen and verify the existing code once', { timeout: 35_000 }, async t => {
  assert.match(api, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/v1$/);
  const kitchen = await operator('demo-kitchen');
  const pickup = await operator('demo-pickup');
  const manager = await operator('demo-manager');
  const order = await readyForPickup(kitchen);
  const fixtures = [order];
  t.after(async () => {
    for (const item of fixtures) {
      const stored = await send(`/orders/${item.id}`, { token: item.token }).then(response => response.json());
      if (stored.status === 'ready') {
        await send(`/operator/orders/${item.id}/status`, {
          method: 'POST', token: pickup, data: { status: 'collected', pickupCode: item.pickupCode },
        });
      }
    }
    for (const token of [kitchen, pickup, manager]) await send('/operator/sessions/current', { method: 'DELETE', token });
  });

  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(6500);
  const origin = new URL(api).origin;
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(new URL('/operator/index.html', api).href);
  await page.getByLabel('Username', { exact: true }).fill('demo-pickup');
  await page.getByLabel('Password', { exact: true }).fill('local-demo-passphrase');
  await button(page, 'Sign in').click();
  await shown(page, 'Pickup queue');

  const lookup = page.getByRole('region', { name: 'Pickup order lookup', exact: true });
  const reference = lookup.getByRole('searchbox', { name: 'Order number or ID', exact: true });
  await reference.fill(order.number);
  const lookupUrl = new URL(api + '/operator/orders/lookup');
  const lookFor = code => page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === lookupUrl.pathname && url.searchParams.get('orderCode')?.toLowerCase() === code.toLowerCase();
  });
  const ready = lookFor(order.number.slice(1));
  await button(lookup, 'Find pickup order').click();
  const found = await ready;
  assert.equal(found.status(), 200);
  assert.equal(found.headers()['cache-control'], 'no-store');
  const view = await found.json();
  assert.deepEqual(Object.keys(view).sort(), ['orderId', 'pickupEndsAt', 'pickupStartsAt', 'status']);
  assert.equal(view.orderId, order.id);
  assert.equal(view.status, 'ready');
  assert.ok(Date.parse(view.pickupStartsAt) < Date.parse(view.pickupEndsAt));
  const result = lookup.locator('#pickup-lookup-result');
  await result.getByText('Ready for pickup', { exact: true }).waitFor();
  await result.getByRole('heading', { name: `Order ${order.number}`, exact: true }).waitFor();
  assert.equal(await result.getByLabel('Pickup code').count(), 0);
  assert.equal((await send(`/operator/orders/lookup?orderCode=${order.id}`, { token: kitchen })).status, 403);

  const cardHeading = page.getByRole('list', { name: 'Orders', exact: true })
    .getByRole('heading', { name: `Order ${order.number}`, exact: true });
  const card = page.getByRole('list', { name: 'Orders', exact: true }).getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name: `Order ${order.number}`, exact: true }) });
  await button(lookup, 'Open order in queue').click();
  assert.equal(await cardHeading.evaluate(heading => document.activeElement === heading), true);
  const confirm = button(card, 'Confirm pickup');
  const statusPath = api + `/operator/orders/${order.id}/status`;
  const attempted = [];
  page.on('response', response => {
    if (response.url() === statusPath && response.request().method() === 'POST') attempted.push(response.status());
  });
  await confirm.click();
  assert.deepEqual(attempted, []);
  assert.equal((await send(`/orders/${order.id}`, { token: order.token }).then(response => response.json())).status, 'ready');

  const code = card.getByLabel('Pickup code');
  await code.fill(order.pickupCode === '000000' ? '999999' : '000000');
  const denied = page.waitForResponse(response => response.url() === statusPath && response.request().method() === 'POST');
  await confirm.click();
  assert.equal((await denied).status(), 409);
  await result.getByText('Ready for pickup', { exact: true }).waitFor();
  await code.fill(order.pickupCode);
  const handedOut = page.waitForResponse(response => response.url() === statusPath && response.request().method() === 'POST');
  await confirm.click();
  assert.equal((await handedOut).status(), 200);
  await card.waitFor({ state: 'detached' });
  await result.getByText('Collected', { exact: true }).waitFor();
  assert.deepEqual(attempted, [409, 200]);

  await reference.fill(order.id);
  const terminal = lookFor(order.id);
  await reference.press('Enter');
  assert.equal((await (await terminal).json()).status, 'collected');
  await result.getByText('Collected', { exact: true }).waitFor();
  const stored = await send(`/orders/${order.id}`, { token: order.token }).then(response => response.json());
  assert.equal(stored.status, 'collected');
  assert.equal(stored.pickupCode, null);
  await capture(page, 'operator-counter-order-lookup');

  const atOtherCounter = await readyForPickup(kitchen);
  fixtures.push(atOtherCounter);
  const readyAtOtherCounter = lookFor(atOtherCounter.number.slice(1));
  await reference.fill(atOtherCounter.number);
  await reference.press('Enter');
  assert.equal((await (await readyAtOtherCounter).json()).status, 'ready');
  await result.getByText('Ready for pickup', { exact: true }).waitFor();
  await button(lookup, 'Open order in queue').waitFor();
  const refreshed = lookFor(atOtherCounter.id);
  assert.equal((await send(`/operator/orders/${atOtherCounter.id}/status`, {
    method: 'POST', token: manager, data: { status: 'collected', pickupCode: atOtherCounter.pickupCode },
  })).status, 200);
  await button(page, 'Refresh').click();
  assert.equal((await (await refreshed).json()).status, 'collected');
  await result.getByText('Collected', { exact: true }).waitFor();
  assert.equal(await button(lookup, 'Open order in queue').isVisible(), false);
});

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

async function placeBrowserOrder(page, origin, buyer, screenshot) {
  await page.goto(origin);
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
  await page.getByLabel('Phone number', { exact: true }).fill(buyer.phone);
  await page.getByLabel('Email address', { exact: true }).fill(buyer.email);
  await button(page, 'Review order').click();
  await shown(page, 'Included tax');
  const successfulPost = url => page.waitForResponse(response =>
    url.test(response.url()) && response.request().method() === 'POST' && response.ok());
  const orderResponse = successfulPost(/\/api\/v1\/orders$/);
  const attemptResponse = successfulPost(/\/api\/v1\/orders\/[^/]+\/payments$/);
  await button(page, /^Confirm .*RWF/).click();
  const order = await (await orderResponse).json();
  const attempt = await (await attemptResponse).json();
  await shown(page, 'Checking payment');
  return { order, attempt };
}

test('waiting for payment slows status checks while manual refresh and kitchen updates stay responsive', { timeout: 30_000 }, async t => {
  const server = createPreviewServer(dist);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(7500);
  await page.clock.install();
  const reads = [];
  const writes = [];
  page.on('request', request => {
    if (!request.url().startsWith(`${api}/`)) return;
    if (request.method() === 'GET') reads.push(request.url());
    if (request.method() === 'POST' && /\/api\/v1\/orders(?:\/[^/]+\/payments)?$/.test(request.url())) writes.push(request.url());
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const { order } = await placeBrowserOrder(page, origin, { ...contact, email: 'payment-wait-fixture@example.test' });
  const orderUrl = `${api}/orders/${order.id}`;
  const readCount = () => reads.filter(url => url === orderUrl).length;
  const waitForRead = () => page.waitForResponse(response => response.url() === orderUrl && response.request().method() === 'GET' && response.ok());
  const advanceAndRead = async interval => {
    const reply = waitForRead();
    await page.clock.fastForward(interval);
    return (await reply).json();
  };
  const note = 'Payment confirmation is taking longer than usual. You can check again now.';

  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 500);
  assert.equal((await advanceAndRead(3200)).paymentStatus, 'processing');
  assert.equal(await page.getByText(note, { exact: true }).count(), 0);
  assert.equal((await advanceAndRead(20_000)).paymentStatus, 'processing');
  await shown(page, note);
  await capture(page, 'payment-delayed-390');
  const slowed = readCount();
  await page.clock.fastForward(10_000);
  assert.equal(readCount(), slowed, 'the short payment interval must stop once confirmation is delayed');

  const manual = waitForRead();
  await button(page, 'Refresh payment status').click();
  assert.equal((await (await manual).json()).paymentStatus, 'processing');
  await shown(page, note);
  assert.equal(readCount(), slowed + 1);

  assert.equal((await advanceAndRead(125_000)).paymentStatus, 'processing');
  const extended = readCount();
  await page.clock.fastForward(30_000);
  assert.equal(readCount(), extended, 'the long wait must not renew the fast interval');
  assert.deepEqual(writes, [`${api}/orders`, `${orderUrl}/payments`]);

  await button(page, 'Confirm local test payment').click();
  await shown(page, 'Order accepted');
  assert.equal(await page.getByText(note, { exact: true }).count(), 0);
  const kitchen = await operator('demo-kitchen');
  const pickup = await operator('demo-pickup');
  t.after(async () => {
    for (const token of [kitchen, pickup]) await send('/operator/sessions/current', { method: 'DELETE', token });
  });
  for (const status of ['preparing', 'ready']) {
    assert.equal((await send(`/operator/orders/${order.id}/status`, { method: 'POST', token: kitchen, data: { status } })).status, 200);
  }
  const ready = await advanceAndRead(5200);
  assert.equal(ready.status, 'ready');
  await shown(page, 'Ready for pickup');
  assert.equal((await send(`/operator/orders/${order.id}/status`, {
    method: 'POST', token: pickup, data: { status: 'collected', pickupCode: ready.pickupCode },
  })).status, 200);
});

test('a delayed payment keeps its polling window through Orders and Settings', { timeout: 35_000 }, async t => {
  assert.match(api, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/v1$/);
  const server = createPreviewServer(dist);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true,
    hasTouch: true, serviceWorkers: 'block' });
  page.setDefaultTimeout(7500);
  await page.clock.install();
  const origin = 'http://127.0.0.1:' + server.address().port;
  const apiUrl = new URL(api);
  const journalKey = 'crustcaper.checkout.v1.local.' + apiUrl.hostname + '.' + apiUrl.port + '.kigali';
  const orderId = '4c2ef814-5990-4cfa-b445-0b74cb7b3a0d';
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const guest = { accessToken: 'fixture_payment_window_access_token_01', refreshToken: 'fixture_payment_window_refresh_token_01',
    expiresAt, refreshExpiresAt: expiresAt };
  await page.addInitScript(({ origin, journalKey, orderId, guest }) => {
    if (location.origin !== origin) return;
    const active = { phase: 'tracking', orderId, key: 'fixture-payment-window' };
    sessionStorage.setItem(journalKey, JSON.stringify({ version: 1, active, orderIds: [orderId] }));
    sessionStorage.setItem(journalKey + '.guest', JSON.stringify(guest));
  }, { origin, journalKey, orderId, guest });

  const orderUrl = api + '/orders/' + orderId;
  const menuUrl = api + '/stores/kigali/menu';
  const attempt = { id: 'e2ca043f-0397-490a-8d17-60cd81440bb9', status: 'processing', checkoutUrl: null };
  const order = {
    id: orderId, storeId: 'kigali', slotId: 'fixture-slot',
    lines: [{ sku: 'double-smash', modifierIds: [], quantity: 1, unitPrice: 9200 }],
    total: 9200, tax: 1400, currency: 'RWF', status: 'awaiting_payment', paymentStatus: 'processing',
    pickupCode: null, receiptStatus: 'pending', receiptUrl: null, paymentAttempt: attempt,
    createdAt: '2026-11-24T10:00:00Z', reservationExpiresAt: '2026-11-24T10:10:00Z',
    pickupStartsAt: '2026-11-24T10:10:00Z', pickupEndsAt: '2026-11-24T10:20:00Z',
  };
  const cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS' };
  const storeLabel = { en: 'Fixture store', rw: 'Fixture store' };
  const unexpectedWrites = [];
  let reads = 0;
  await page.route('**/*', route => {
    const request = route.request();
    const url = request.url();
    const requestOrigin = new URL(url).origin;
    const method = request.method();
    if (requestOrigin === origin) return route.continue();
    if (requestOrigin !== apiUrl.origin) return route.abort();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (method !== 'GET') {
      unexpectedWrites.push(method);
      return route.abort();
    }
    if (url === orderUrl) {
      reads++;
      return route.fulfill({ headers: cors, json: order });
    }
    if (url === menuUrl || url.startsWith(menuUrl + '?')) {
      return route.fulfill({ headers: cors, json: { version: 'fixture', updatedAt: new Date().toISOString(),
        store: { id: 'kigali', name: storeLabel, area: storeLabel, open: true, hours: storeLabel }, products: [], slots: [] } });
    }
    return route.abort();
  });

  const nextRead = () => page.waitForResponse(response =>
    response.url() === orderUrl && response.request().method() === 'GET' && response.ok());
  const english = 'Payment confirmation is taking longer than usual. You can check again now.';
  const kinyarwanda = 'Kwemeza ubwishyu biratinda kurusha uko bisanzwe. Ushobora kongera kugenzura ubu.';
  let observed = nextRead();
  await page.goto(origin + '/payment');
  assert.equal((await (await observed).json()).paymentAttempt.id, attempt.id);
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 500);
  observed = nextRead();
  await page.clock.fastForward(125_000);
  await observed;
  await shown(page, english);

  // The customer leaves Payment and opens the same order through the app's normal navigation.
  observed = nextRead();
  await button(page, 'Go to Orders').click();
  await page.waitForURL(origin + '/orders');
  await observed;
  await shown(page, english);
  let before = reads;
  await page.clock.fastForward(30_000);
  assert.equal(reads, before, 'Returning to the same payment keeps the slow polling interval');

  await button(page, 'Settings').click();
  await button(page, 'Kinyarwanda').click();
  await shown(page, 'Amagenamiterere');
  before = reads;
  await page.clock.fastForward(65_000);
  assert.equal(reads, before, 'The order pauses its polling while Settings has focus');
  await page.clock.resume();
  observed = nextRead();
  await page.getByLabel(/(?:, back|Go back)$/i).click();
  await page.waitForURL(origin + '/orders');
  await observed;
  await shown(page, kinyarwanda);
  assert.equal(reads, before + 1, 'Returning to the order immediately checks its status');
  await capture(page, 'payment-window-on-return-rw');

  attempt.id = 'cb6bec87-0d2f-4170-875d-07e8520b6c26';
  observed = nextRead();
  await button(page, 'Vugurura uko komande ihagaze').click();
  assert.equal((await (await observed).json()).paymentAttempt.id, attempt.id);
  await page.getByText(kinyarwanda, { exact: true }).waitFor({ state: 'hidden' });
  observed = nextRead();
  await page.clock.fastForward(3200);
  await observed;
  assert.deepEqual(unexpectedWrites, []);
});

test('open Orders reconciles a declined checkout after its pickup hold expires', { timeout: 50_000 }, async t => {
  assert.match(api, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/v1$/);
  const fixturePath = process.env.CRUSTCAPER_EXPIRE_ORDER_FIXTURE;
  const expireOrder = fixturePath ? require(resolve(fixturePath)) : null;
  if (fixturePath) assert.equal(typeof expireOrder, 'function', 'The isolated expiry fixture must export one callback');

  const server = createPreviewServer(dist);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 320, height: 800 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(7500);
  await page.clock.install();

  const writes = [];
  page.on('request', request => {
    if (request.method() !== 'POST' || !request.url().startsWith(api + '/')) return;
    const path = request.url().slice(api.length);
    if (/^\/(?:quotes|orders(?:\/[^/]+\/(?:payments|reorder))?)$/.test(path)) writes.push(path);
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const { order, attempt } = await placeBrowserOrder(page, origin, { ...contact, email: 'hold-expiry-fixture@example.test' });
  const orderPath = `/orders/${order.id}`;
  const initialWrites = ['/quotes', '/orders', orderPath + '/payments'];
  const settlement = page.waitForResponse(response =>
    response.url() === `${api}/local${orderPath}/payments/${attempt.id}/result`
    && response.request().method() === 'POST' && response.ok());
  await button(page, 'Decline local test payment').click();
  const declined = await (await settlement).json();
  assert.equal(declined.id, order.id);
  assert.equal(declined.status, 'awaiting_payment');
  assert.equal(declined.paymentStatus, 'declined');
  assert.equal(declined.paymentAttempt.id, attempt.id);
  assert.ok(Date.parse(declined.reservationExpiresAt) > Date.now());
  await shown(page, 'Payment declined');
  await button(page, 'Retry payment').waitFor();
  assert.equal(await button(page, 'Review reorder').count(), 0);
  assert.deepEqual(writes, initialWrites);

  const orderUrl = api + orderPath;
  const openOrdersUrl = page.url();
  const readCancelledWithAttempt = attemptStatus => page.waitForResponse(async response => {
    if (response.url() !== orderUrl || response.request().method() !== 'GET' || !response.ok()) return false;
    const record = await response.json();
    return record.status === 'cancelled' && record.paymentAttempt?.status === attemptStatus;
  });
  let expiredOrder;
  if (expireOrder) {
    await expireOrder({ orderId: order.id, expectedReservationExpiresAt: declined.reservationExpiresAt });
    const automatedRead = readCancelledWithAttempt('declined');
    await page.clock.fastForward(65_000);
    expiredOrder = await (await automatedRead).json();
  } else {
    // The standard browser suite has no database admin access. Project only this declined order past its hold.
    const reservationExpiresAt = new Date(Date.now() - 1000).toISOString();
    let projectedReads = 0;
    await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 2000);
    await page.route(orderUrl, async route => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      const record = await response.json();
      assert.equal(response.status(), 200);
      assert.equal(record.id, order.id);
      assert.equal(record.paymentStatus, 'declined');
      assert.equal(record.paymentAttempt.id, attempt.id);
      const paymentAttempt = projectedReads++ === 0
        ? { ...record.paymentAttempt, status: 'processing' }
        : record.paymentAttempt;
      await route.fulfill({ response, json: { ...record, status: 'cancelled', reservationExpiresAt, paymentAttempt } });
    });
    const mixedRead = readCancelledWithAttempt('processing');
    await page.clock.fastForward(65_000);
    const mixed = await (await mixedRead).json();
    assert.equal(mixed.id, order.id);
    assert.equal(mixed.paymentStatus, 'declined');
    assert.equal(mixed.paymentAttempt.id, attempt.id);
    await page.clock.runFor(100);
    await shown(page, 'Checking payment status…');
    assert.equal(page.url(), openOrdersUrl);
    assert.equal(projectedReads, 1);
    assert.equal(await button(page, 'Retry payment').count(), 0);
    assert.equal(await button(page, 'Restore saved checkout').count(), 0);
    assert.equal(await button(page, 'Review reorder').count(), 0);
    assert.equal(await page.getByText('Payment declined', { exact: true }).filter({ visible: true }).count(), 0);
    assert.deepEqual(writes, initialWrites);

    const coherentRead = readCancelledWithAttempt('declined');
    await page.clock.fastForward(3100);
    expiredOrder = await (await coherentRead).json();
    assert.equal(projectedReads, 2);
    await page.clock.resume();
  }
  assert.equal(page.url(), openOrdersUrl, 'The order screen should reconcile in place');
  assert.equal(expiredOrder.id, order.id);
  assert.equal(expiredOrder.status, 'cancelled');
  assert.equal(expiredOrder.paymentStatus, 'declined');
  assert.equal(expiredOrder.paymentAttempt.id, attempt.id);
  assert.ok(Date.parse(expiredOrder.reservationExpiresAt) <= Date.now());
  if (expireOrder) {
    const token = await page.evaluate(() => {
      const key = Object.keys(sessionStorage).find(name => name.endsWith('.guest'));
      return key ? JSON.parse(sessionStorage.getItem(key)).accessToken : null;
    });
    assert.ok(token, 'The browser should retain the original guest session');
    const retained = await send(orderPath, { token });
    assert.equal(retained.status, 200);
    assert.deepEqual(await retained.json(), expiredOrder, 'The optional fixture must return authoritative API state without browser projection');
  }

  const checkRecovery = async ({ locale, heading, notice, retry, reorder }) => {
    await shown(page, heading);
    await shown(page, notice);
    assert.equal(await button(page, retry).count(), 0);
    await withLargeText(page, async () => {
      const message = page.getByText(notice, { exact: true });
      await message.scrollIntoViewIfNeeded();
      assert.equal(await message.evaluate(element => {
        const { left, right } = element.getBoundingClientRect();
        return left >= 0 && right <= window.innerWidth && element.scrollWidth <= element.clientWidth + 1;
      }), true);
      await button(page, reorder).click({ trial: true });
      await capture(page, `connected-hold-expired-${locale}-320-large-text`);
    });
  };
  await checkRecovery({
    locale: 'en', heading: 'Order cancelled', retry: 'Retry payment', reorder: 'Review reorder',
    notice: 'Your pickup hold ended. Review a new order to choose another time.',
  });
  assert.deepEqual(writes, initialWrites);

  const preview = page.waitForResponse(response =>
    response.url() === orderUrl + '/reorder' && response.request().method() === 'POST' && response.ok());
  await button(page, 'Review reorder').click();
  assert.deepEqual((await (await preview).json()).lines, expiredOrder.lines);
  await shown(page, 'Available items today');
  await button(page, 'Add these items to cart').waitFor();
  assert.deepEqual(writes, [...initialWrites, orderPath + '/reorder']);

  await page.goto(origin + '/settings');
  await button(page, 'Kinyarwanda').click();
  await shown(page, 'Amagenamiterere');
  await page.goto(origin + '/orders');
  await checkRecovery({
    locale: 'rw', heading: 'Komande yahagaritswe', retry: 'Ongera ugerageze ubwishyu', reorder: 'Reba komande nshya isa n’iyi',
    notice: 'Igihe cyabikiwe komande cyarangiye. Reba komande nshya uhitemo ikindi gihe.',
  });
  assert.deepEqual(writes, [...initialWrites, orderPath + '/reorder']);
});

test('a late payment refund offers localized help beside its status', { timeout: 35_000 }, async t => {
  assert.match(api, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/v1$/);
  const server = createPreviewServer(dist);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 320, height: 800 }, isMobile: true,
    hasTouch: true, serviceWorkers: 'block' });
  page.setDefaultTimeout(6500);
  const origin = 'http://127.0.0.1:' + server.address().port;
  const apiUrl = new URL(api);
  const journalKey = 'crustcaper.checkout.v1.local.' + apiUrl.hostname + '.' + apiUrl.port + '.kigali';
  const orderId = 'b19f7ab9-0e04-490f-94c5-948cb1587f2d';
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const guest = { accessToken: 'refund_help_fixture_access_token_01', refreshToken: 'refund_help_fixture_refresh_token_01',
    expiresAt, refreshExpiresAt: expiresAt };
  await page.addInitScript(({ origin, journalKey, orderId, guest }) => {
    if (location.origin !== origin) return;
    sessionStorage.setItem(journalKey, JSON.stringify({ version: 1, active: null, orderIds: [orderId] }));
    sessionStorage.setItem(journalKey + '.guest', JSON.stringify(guest));
  }, { origin, journalKey, orderId, guest });

  const label = { en: 'Fixture store', rw: 'Fixture store' };
  const menuUrl = api + '/stores/kigali/menu';
  const orderUrl = api + '/orders/' + orderId;
  const order = {
    id: orderId, storeId: 'kigali', slotId: 'fixture-slot',
    lines: [{ sku: 'double-smash', modifierIds: [], quantity: 1, unitPrice: 9_200 }],
    total: 9_200, tax: 1_400, currency: 'RWF', status: 'cancelled', paymentStatus: 'refund_pending',
    pickupCode: null, receiptStatus: 'pending', receiptUrl: null,
    paymentAttempt: { id: '08b3862b-db3d-48c3-90e0-5d8636399f8d', status: 'paid', checkoutUrl: null },
    createdAt: '2026-11-24T10:00:00Z', reservationExpiresAt: '2026-11-24T10:10:00Z',
    pickupStartsAt: '2026-11-24T10:10:00Z', pickupEndsAt: '2026-11-24T10:20:00Z',
  };
  const cors = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
  const writes = [];
  await page.route('**/*', route => {
    const request = route.request();
    const url = request.url();
    const requestOrigin = new URL(url).origin;
    const method = request.method();
    if (requestOrigin === origin) return route.continue();
    if (requestOrigin !== apiUrl.origin) return route.abort();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (method !== 'GET') {
      writes.push(method);
      return route.abort();
    }
    if (url === orderUrl) return route.fulfill({ headers: cors, json: order });
    if (url === menuUrl || url.startsWith(menuUrl + '?')) {
      return route.fulfill({ headers: cors, json: { version: 'fixture', updatedAt: new Date().toISOString(),
        store: { id: 'kigali', name: label, area: label, open: true, hours: label, supportUrl: 'https://support.example.test/help' },
        products: [], slots: [] } });
    }
    return route.abort();
  });

  async function checkHelp({ notice, help, genericHelp, pickupHelp, contactSupport, widths, screenshot }) {
    const copy = page.getByText(notice, { exact: true });
    await copy.waitFor();
    const action = copy.locator('..').getByRole('button', { name: help, exact: true });
    await action.waitFor();
    assert.equal(await button(page, help).count(), 1);
    assert.equal(await button(page, genericHelp).count(), 0);
    const actionText = action.getByText(help, { exact: true });
    for (const text of [copy, actionText]) {
      await text.evaluate(element => {
        const style = getComputedStyle(element);
        element.style.fontSize = (2 * parseFloat(style.fontSize)) + 'px';
        element.style.lineHeight = (2 * parseFloat(style.lineHeight)) + 'px';
      });
    }
    for (const width of widths) {
      await page.setViewportSize({ width, height: 800 });
      await action.scrollIntoViewIfNeeded();
      const bounds = await action.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1, 'Refund help stays within the viewport');
      const label = await actionText.boundingBox();
      assert.ok(label && label.x >= bounds.x && label.x + label.width <= bounds.x + bounds.width
        && label.y >= bounds.y && label.y + label.height <= bounds.y + bounds.height, 'Enlarged label fits its button');
    }
    await capture(page, screenshot);
    await action.click();
    await page.waitForURL(origin + '/pickup');
    const heading = page.getByRole('heading', { name: pickupHelp, exact: true });
    await heading.locator('..').getByRole('button', { name: contactSupport, exact: true }).waitFor();
  }

  await page.goto(origin + '/orders');
  await checkHelp({
    notice: 'Your refund is being checked. Refresh this order later for an update.',
    help: 'Get help with this refund', genericHelp: 'Pickup & help',
    pickupHelp: 'Order help', contactSupport: 'Contact support',
    widths: [390, 430, 320], screenshot: 'refund-help-en',
  });
  order.paymentStatus = 'refunded';
  await button(page, 'Settings').click();
  await button(page, 'Kinyarwanda').click();
  await shown(page, 'Amagenamiterere');
  await page.goto(origin + '/orders');
  await checkHelp({
    notice: 'Gusubizwa amafaranga byemejwe.',
    help: 'Saba ubufasha ku gusubizwa amafaranga', genericHelp: 'Gufata komande n’ubufasha',
    pickupHelp: 'Ubufasha kuri komande', contactSupport: 'Saba ubufasha',
    widths: [390, 430, 320], screenshot: 'refund-help-rw',
  });
  assert.deepEqual(writes, []);
});

test('a fiscal receipt export is canceled when the selected order or app visibility changes', { timeout: 35_000 }, async t => {
  assert.match(api, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/v1$/);
  const server = createPreviewServer(dist);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  page.setDefaultTimeout(6500);
  const origin = 'http://127.0.0.1:' + server.address().port;
  const apiUrl = new URL(api);
  const journalKey = 'crustcaper.checkout.v1.local.' + apiUrl.hostname + '.' + apiUrl.port + '.kigali';
  const first = '2bba37e8-58db-4563-a4e2-fb197fe59890';
  const second = '164064f3-2cad-475e-aa6b-67a8403ef030';
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const guest = { accessToken: 'fixture_receipt_export_access_token_01', refreshToken: 'fixture_receipt_export_refresh_token_01',
    expiresAt, refreshExpiresAt: expiresAt };
  await page.addInitScript(({ origin, journalKey, orderIds, guest }) => {
    if (location.origin !== origin) return;
    sessionStorage.setItem(journalKey, JSON.stringify({ version: 1, active: null, orderIds }));
    sessionStorage.setItem(journalKey + '.guest', JSON.stringify(guest));
    window.receiptDownloadNames = [];
    document.addEventListener('click', event => {
      if (event.target instanceof HTMLAnchorElement && event.target.download) {
        window.receiptDownloadNames.push(event.target.download);
      }
    }, true);
  }, { origin, journalKey, orderIds: [first, second], guest });

  const firstPdf = testReceipt();
  const secondPdf = Buffer.concat([firstPdf, Buffer.from('\n')]);
  const label = { en: 'Fixture store', rw: 'Fixture store' };
  const menuUrl = api + '/stores/kigali/menu';
  const cors = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS' };
  const writes = [];
  let deferred;
  await page.route('**/*', async route => {
    const request = route.request();
    const url = request.url();
    if (new URL(url).origin === origin) return route.continue();
    if (!url.startsWith(api + '/')) return route.abort();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (request.method() !== 'GET') {
      writes.push(request.method());
      return route.abort();
    }
    if (url === menuUrl || url.startsWith(menuUrl + '?')) {
      return route.fulfill({ headers: cors, json: { version: 'fixture', updatedAt: new Date().toISOString(),
        store: { id: 'kigali', name: label, area: label, open: true, hours: label }, products: [], slots: [] } });
    }
    const [section, id, receipt] = url.slice(api.length + 1).split('/');
    if (section !== 'orders' || (id !== first && id !== second)) return route.abort();
    if (receipt === 'receipt') {
      if (deferred?.id === id) {
        const pending = deferred;
        deferred = undefined;
        await pending.release.promise;
      }
      return route.fulfill({ headers: cors, contentType: 'application/pdf', body: id === first ? firstPdf : secondPdf });
    }
    const total = id === first ? 9200 : 9400;
    return route.fulfill({ headers: cors, json: {
      id, storeId: 'kigali', slotId: 'fixture-slot',
      lines: [{ sku: 'double-smash', modifierIds: [], quantity: 1, unitPrice: total }],
      total, tax: 1400, currency: 'RWF', status: 'collected', paymentStatus: 'paid',
      pickupCode: null, receiptStatus: 'issued', receiptUrl: '/api/v1/orders/' + id + '/receipt', paymentAttempt: null,
      createdAt: '2026-11-24T10:00:00Z', reservationExpiresAt: '2026-11-24T10:10:00Z',
      pickupStartsAt: '2026-11-24T10:10:00Z', pickupEndsAt: '2026-11-24T10:20:00Z',
    } });
  });

  const receiptButton = button(page, 'Download receipt');
  const downloadNames = () => page.evaluate(() => window.receiptDownloadNames.slice());
  async function deferExport(id, interrupt) {
    const delayed = { id, release: Promise.withResolvers() };
    deferred = delayed;
    await receiptButton.waitFor();
    const requested = page.waitForRequest(api + '/orders/' + id + '/receipt');
    try {
      await receiptButton.click();
      await requested;
      await interrupt();
    } finally {
      delayed.release.resolve();
    }
    const resumedButton = page.getByRole('button', { name: 'Download receipt', exact: true, disabled: false });
    await resumedButton.waitFor();
  }

  await page.goto(origin + '/orders');
  await shown(page, '9,200 RWF');
  await deferExport(first, async () => {
    await button(page, '#' + second.slice(-8).toUpperCase()).click();
    await shown(page, '9,400 RWF');
  });
  assert.deepEqual(await downloadNames(), [], 'A late receipt must not download on another order');

  await deferExport(second, () => page.evaluate(() => {
    for (const state of ['hidden', 'visible']) {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
      document.dispatchEvent(new Event('visibilitychange'));
    }
    delete document.visibilityState;
  }));
  assert.deepEqual(await downloadNames(), [], 'Returning to the foreground does not renew the old export');

  assert.ok((await downloadedReceipt(page)).equals(secondPdf));
  assert.deepEqual(await downloadNames(), ['receipt-' + second.slice(-8) + '.pdf']);
  assert.deepEqual(writes, []);
});

test('an open picked-up order shows a later fiscal receipt without manual refresh', { timeout: 35_000 }, async t => {
  assert.match(api, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/v1$/);
  const server = createPreviewServer(dist);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  page.setDefaultTimeout(7500);
  await page.clock.install();
  const reads = [];
  page.on('request', request => {
    if (request.method() === 'GET') reads.push(request.url());
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const { order } = await placeBrowserOrder(page, origin, { ...contact, email: 'receipt-after-pickup@example.test' });
  await button(page, 'Confirm local test payment').click();
  await shown(page, 'Order accepted');

  const [kitchen, pickup, manager] = await Promise.all(['demo-kitchen', 'demo-pickup', 'demo-manager'].map(operator));
  t.after(() => Promise.all([kitchen, pickup, manager].map(token => send('/operator/sessions/current', { method: 'DELETE', token }))));
  const orderPath = `/orders/${order.id}`;
  const orderUrl = api + orderPath;
  const readCount = () => reads.filter(url => url === orderUrl).length;
  const waitForRead = () => page.waitForResponse(response =>
    response.url() === orderUrl && response.request().method() === 'GET' && response.ok());
  const advance = (token, status, pickupCode) => send('/operator' + orderPath + '/status', {
    method: 'POST', token, data: { status, pickupCode },
  });
  await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 500);
  for (const status of ['preparing', 'ready']) assert.equal((await advance(kitchen, status)).status, 200);
  const ready = waitForRead();
  await page.clock.fastForward(5200);
  await shown(page, 'Ready for pickup');
  const { pickupCode } = await (await ready).json();
  assert.match(pickupCode, /^[0-9]{6}$/);

  assert.equal((await advance(pickup, 'collected', pickupCode)).status, 200);
  await page.clock.fastForward(5200);
  await shown(page, 'Picked up');
  await shown(page, 'The receipt is pending.');
  const waitingReads = readCount();
  await page.clock.fastForward(9000);
  assert.equal(readCount(), waitingReads, 'receipt checks use a slower cadence than pickup status');

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.fastForward(31_000);
  assert.equal(readCount(), waitingReads, 'there is no receipt polling while the app is hidden');
  const resumed = waitForRead();
  await page.evaluate(() => {
    Reflect.deleteProperty(document, 'visibilityState');
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal((await (await resumed).json()).receiptStatus, 'pending');
  await page.getByRole('button', { name: 'Refresh order status', exact: true, disabled: false }).waitFor();

  const pdf = testReceipt();
  const attached = await fetch(api + '/operator' + orderPath + '/receipt', {
    method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(10_000), body: pdf,
    headers: { Authorization: 'Bearer ' + manager, 'Content-Type': 'application/pdf',
      'X-Receipt-Reference': 'AFTER-PICKUP-' + order.id.slice(-8).toUpperCase(), 'X-Receipt-Total-RWF': String(order.total) },
  });
  assert.equal(attached.status, 200);
  assert.equal((await attached.json()).receiptStatus, 'issued');
  const beforeReceipt = readCount();
  await page.clock.fastForward(15_100);
  await button(page, 'Download receipt').waitFor();
  assert.equal(readCount(), beforeReceipt + 1);
  await capture(page, 'receipt-after-pickup-issued');
  assert.ok((await downloadedReceipt(page)).equals(pdf));
  await page.clock.fastForward(31_000);
  assert.equal(readCount(), beforeReceipt + 1, 'issued receipts do not need further status reads');
});

test('a saved Orders action error follows the chosen language and keeps its support ID', { timeout: 25_000 }, async t => {
  assert.match(api, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/v1$/);
  const server = createPreviewServer(dist);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  page.setDefaultTimeout(6500);
  const origin = 'http://127.0.0.1:' + server.address().port;
  const apiUrl = new URL(api);
  const journalKey = `crustcaper.checkout.v1.local.${apiUrl.hostname}.${apiUrl.port}.kigali`;
  const orderId = '3099a83d-a8ae-4632-9306-32ebea343135';
  const requestId = 'ba8b8f93-4a07-4711-82d6-189a3cfe5747';
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const guest = { accessToken: 'orders_locale_fixture_access_token', refreshToken: 'orders_locale_fixture_refresh_token',
    expiresAt, refreshExpiresAt: expiresAt };
  await page.addInitScript(({ origin, journalKey, orderId, guest }) => {
    if (location.origin !== origin) return;
    sessionStorage.setItem(journalKey, JSON.stringify({ version: 1, active: null, orderIds: [orderId] }));
    sessionStorage.setItem(journalKey + '.guest', JSON.stringify(guest));
  }, { origin, journalKey, orderId, guest });

  const orderUrl = api + '/orders/' + orderId;
  const menuUrl = api + '/stores/kigali/menu';
  const label = { en: 'Fixture store', rw: 'Fixture store' };
  const order = {
    id: orderId, storeId: 'kigali', slotId: 'fixture-slot',
    lines: [{ sku: 'double-smash', modifierIds: [], quantity: 1, unitPrice: 9_200 }],
    total: 9_200, tax: 1_400, currency: 'RWF', status: 'collected', paymentStatus: 'paid',
    pickupCode: null, receiptStatus: 'pending', receiptUrl: null, paymentAttempt: null,
    createdAt: '2026-11-24T10:00:00Z', reservationExpiresAt: '2026-11-24T10:10:00Z',
    pickupStartsAt: '2026-11-24T10:10:00Z', pickupEndsAt: '2026-11-24T10:20:00Z',
  };
  const cors = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Expose-Headers': 'X-Request-ID',
  };
  let reorderCalls = 0;
  await page.route('**/*', route => {
    const { origin: requestOrigin } = new URL(route.request().url());
    if (requestOrigin === origin) return route.continue();
    if (requestOrigin !== apiUrl.origin) return route.abort();
    const url = route.request().url();
    const method = route.request().method();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (method === 'GET' && url === orderUrl) return route.fulfill({ headers: cors, json: order });
    if (method === 'GET' && (url === menuUrl || url.startsWith(menuUrl + '?'))) {
      return route.fulfill({ headers: cors, json: { version: 'fixture', updatedAt: new Date().toISOString(),
        store: { id: 'kigali', name: label, area: label, open: true, hours: label }, products: [], slots: [] } });
    }
    if (method === 'POST' && url === orderUrl + '/reorder') {
      reorderCalls++;
      return route.fulfill({ status: 503, headers: { ...cors, 'X-Request-ID': requestId },
        json: { code: 'service_unavailable', detail: 'fixture error details' } });
    }
    return route.abort();
  });

  await page.goto(origin);
  await page.getByRole('tab', { name: /^Orders(?:,|$)/ }).click();
  await page.waitForURL(origin + '/orders');
  const documentStartedAt = await page.evaluate(() => performance.timeOrigin);
  await button(page, 'Review reorder').click();
  const previous = page.getByRole('alert').filter({ hasText: requestId, visible: true });
  await previous.waitFor();
  assert.equal(await previous.textContent(), `The order service is temporarily unavailable. Try again shortly.\nSupport ID ${requestId}`);
  await button(page, 'Settings').click();
  await button(page, 'Kinyarwanda').click();
  await shown(page, 'Amagenamiterere');
  await page.getByLabel(/(?:, back|Go back)$/i).click();
  await page.waitForURL(origin + '/orders');
  const reorder = button(page, 'Reba komande nshya isa n’iyi');
  await reorder.waitFor();
  assert.equal(await page.evaluate(() => performance.timeOrigin), documentStartedAt, 'Settings must preserve the Orders document');
  assert.equal(await page.locator('html').getAttribute('lang'), 'rw');
  assert.equal(reorderCalls, 1, 'Changing the language must preserve the action failure without replaying it');
  assert.equal(await previous.count(), 1, 'Orders must retain one visible support ID after returning from Settings');
  await reorder.focus();
  assert.equal(await reorder.evaluate(element => element === document.activeElement), true);
  assert.equal(await previous.textContent(),
    `Serivisi ya komande ntiboneka by’akanya gato. Ongera ugerageze nyuma.\nNomero y’ubufasha ${requestId}`);
  await capture(page, 'connected-orders-error-language');
});

test('a shared order previews the mobile cart limit before saving it', { timeout: 40_000 }, async t => {
  assert.match(api, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/v1$/);
  const buyer = { ...contact, email: 'reorder-fixture@example.test' };
  const kitchen = await operator('demo-kitchen');
  const pickup = await operator('demo-pickup');
  const server = createPreviewServer(dist);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 320, height: 800 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(6500);
  const origin = 'http://127.0.0.1:' + server.address().port;
  await page.goto(origin);
  await button(page, /^Double Smash,/).click();
  await button(page, /^Add to cart/).click();
  await button(page, /^View cart/).click();
  await button(page, 'Choose pickup time').click();
  await page.getByRole('radiogroup', { name: 'Pickup time' }).getByRole('radio', { disabled: false }).first().click();
  await page.getByLabel('Phone number', { exact: true }).fill(buyer.phone);
  await page.getByLabel('Email address', { exact: true }).fill(buyer.email);
  const openedGuest = page.waitForResponse(response =>
    response.url() === api + '/guest-sessions' && response.request().method() === 'POST' && response.ok());
  await button(page, 'Review order').click();
  const { accessToken: guestToken } = await (await openedGuest).json();
  await shown(page, 'Included tax');

  const { id, pickupCode } = await readyForPickup(kitchen, { buyer, guestToken, quantity: 12 });
  t.after(async () => {
    const collected = await send(`/operator/orders/${id}/status`, {
      method: 'POST', token: pickup, data: { status: 'collected', pickupCode },
    });
    assert.equal(collected.status, 200);
  });
  const order = await send(`/orders/${id}`, { token: guestToken }).then(response => response.json());
  const [originalLine] = order.lines;
  assert.equal(originalLine.quantity, 12);
  await page.evaluate(orderId => {
    const guestKey = Object.keys(sessionStorage).find(key => key.startsWith('crustcaper.checkout.v1.') && key.endsWith('.guest'));
    if (!guestKey) throw new Error('Expected the live browser guest session');
    sessionStorage.setItem(guestKey.slice(0, -'.guest'.length), JSON.stringify({
      version: 1, active: null, orderIds: [orderId],
    }));
  }, id);
  await page.goto(origin + '/orders');
  const savedLines = () => page.evaluate(() => {
    const key = Object.keys(sessionStorage).find(key => key.startsWith('crustcaper.draft.v1.'));
    return key ? JSON.parse(sessionStorage.getItem(key)).cart : [];
  });

  const reorderResponse = page.waitForResponse(response =>
    response.url() === api + `/orders/${order.id}/reorder` && response.ok());
  await button(page, 'Review reorder').click();
  assert.equal((await (await reorderResponse).json()).lines[0].quantity, 12);
  await shown(page, 'Quantity · 12 → 9');
  const format = value => new Intl.NumberFormat('en-RW', { maximumFractionDigits: 0 }).format(value) + ' RWF';
  await shown(page, format(9 * originalLine.unitPrice));
  assert.deepEqual(await savedLines(), [{ ...originalLine, quantity: 1 }]);
  await inspectReorderLimit(page, 'en', 'Quantity · 12 → 9', 'Replace cart with these items');

  await page.goto(origin + '/settings');
  await button(page, 'Kinyarwanda').click();
  await shown(page, 'Amagenamiterere');
  await page.goto(origin + '/orders');
  await button(page, 'Reba komande nshya isa n’iyi').click();
  await shown(page, 'Umubare · 12 → 9');
  assert.deepEqual(await savedLines(), [{ ...originalLine, quantity: 1 }]);
  await inspectReorderLimit(page, 'rw', 'Umubare · 12 → 9', 'Simbuza ibiri mu gatebo ibi biribwa');
  await button(page, 'Simbuza ibiri mu gatebo ibi biribwa').click();
  await shown(page, 'Igitebo cyawe');
  const expected = [{ ...originalLine, quantity: 9 }];
  assert.deepEqual(await savedLines(), expected);
  await page.reload();
  await shown(page, 'Double Smash');
  await shown(page, format(9 * originalLine.unitPrice));
  assert.deepEqual(await savedLines(), expected);
  const removeOne = button(page, 'Kuramo imwe muri Double Smash');
  await removeOne.click();
  await shown(page, format(8 * originalLine.unitPrice));
  assert.deepEqual(await savedLines(), [{ ...expected[0], quantity: 8 }]);

  await page.evaluate(line => {
    const key = Object.keys(sessionStorage).find(key => key.startsWith('crustcaper.draft.v1.'));
    const previousDraft = JSON.parse(sessionStorage.getItem(key));
    sessionStorage.setItem(key, JSON.stringify({ ...previousDraft, cart: [line] }));
  }, originalLine);
  await page.reload();
  await shown(page, format(12 * originalLine.unitPrice));
  assert.deepEqual(await savedLines(), [originalLine]);
  assert.equal(await button(page, 'Ongeramo imwe muri Double Smash').isDisabled(), true);
  await removeOne.click();
  await shown(page, format(11 * originalLine.unitPrice));
  assert.deepEqual(await savedLines(), [{ ...originalLine, quantity: 11 }]);
});

async function withLargeText(page, inspect, selector = 'div, span, p, h1, h2, h3') {
  await page.evaluate(selector => {
    for (const node of document.querySelectorAll(selector)) {
      if (node.children.length || !node.textContent.trim() || node.closest('[aria-hidden=true], [hidden]')) continue;
      const { fontSize, lineHeight } = getComputedStyle(node);
      node.dataset.testZoomStyles = JSON.stringify([node.style.fontSize, node.style.lineHeight]);
      node.style.fontSize = `${parseFloat(fontSize) * 2}px`;
      if (Number.isFinite(parseFloat(lineHeight))) node.style.lineHeight = `${parseFloat(lineHeight) * 2}px`;
    }
  }, selector);
  try {
    await inspect();
  } finally {
    await page.evaluate(() => {
      for (const node of document.querySelectorAll('[data-test-zoom-styles]')) {
        const [fontSize, lineHeight] = JSON.parse(node.dataset.testZoomStyles);
        node.style.fontSize = fontSize;
        node.style.lineHeight = lineHeight;
        delete node.dataset.testZoomStyles;
      }
    });
  }
}

async function inspectReorderLimit(page, locale, changeLabel, approveLabel) {
  const change = page.getByText(changeLabel, { exact: true }).filter({ visible: true });
  const approve = button(page, approveLabel);
  const reachable = async locator => {
    await locator.scrollIntoViewIfNeeded();
    return locator.evaluate(element => {
      const { left, right, top, bottom } = element.getBoundingClientRect();
      const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
      return left >= 0 && top >= 0 && right <= window.innerWidth && bottom <= window.innerHeight
        && element.contains(hit);
    });
  };
  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 800 });
    const inspect = async size => {
      assert.ok(await reachable(change), `Quantity change must be visible at ${width}px in ${locale}, ${size}`);
      await capture(page, `connected-reorder-limit-${locale}-${width}-${size}`);
      assert.ok(await reachable(approve), `Approval must be reachable at ${width}px in ${locale}, ${size}`);
    };
    await inspect('normal');
    await withLargeText(page, () => inspect('large-text'));
  }
}

async function inspectCartHeader(page, cart, locale) {
  const fits = () => cart.evaluate(element => {
    const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
    const hit = document.elementFromPoint(left + width / 2, top + height / 2);
    return width >= 48 && height >= 48 && left >= 0 && top >= 0
      && right <= window.innerWidth && bottom <= window.innerHeight && element.contains(hit);
  });
  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 800 });
    assert.ok(await fits(), `Cart control must fit at ${width}px in ${locale}`);
    await capture(page, `connected-product-cart-${locale}-${width}`);
    await withLargeText(page, async () => {
      assert.ok(await fits(), `Cart control must fit at ${width}px in ${locale} with 200% text`);
      await capture(page, `connected-product-cart-${locale}-${width}-large-text`);
    });
  }
}

test('the buyer can open the cart from product details and return to their selected options', { timeout: 30_000 }, async t => {
  assert.match(api, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/v1$/);
  const server = createPreviewServer(dist);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 320, height: 800 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(6500);

  const origin = 'http://127.0.0.1:' + server.address().port;
  await page.goto(origin);
  await button(page, /^Double Smash,/).click();
  await button(page, /^Add to cart/).click();
  await button(page, /^Classic Smash,/).click();
  const cheese = button(page, /Extra cheese/);
  await cheese.click();
  assert.equal(await cheese.getAttribute('aria-pressed'), 'true');

  const cart = button(page, 'Cart, 1 item');
  await cart.waitFor();
  await inspectCartHeader(page, cart, 'en');
  await page.setViewportSize({ width: 320, height: 800 });
  await cart.focus();
  assert.equal(await cart.evaluate(el => document.activeElement === el), true);
  await page.keyboard.press('Enter');
  await shown(page, 'Your cart');
  await shown(page, 'Double Smash');
  assert.equal(await page.getByText('Classic Smash', { exact: true }).filter({ visible: true }).count(), 0);

  await page.goBack();
  await button(page, 'Add to cart · 7,400 RWF').waitFor();
  assert.equal(await cheese.getAttribute('aria-pressed'), 'true');
  assert.equal(await cart.isVisible(), true);

  await cart.tap();
  await button(page, 'Edit options').click();
  const save = button(page, /^Save item/);
  await save.waitFor();
  assert.equal(await cart.isVisible(), false);
  await button(page, /No pickles/).click();
  await save.click();
  await shown(page, 'Your cart');
  await shown(page, 'No pickles');

  await page.goto(origin + '/settings');
  await button(page, 'Kinyarwanda').click();
  await shown(page, 'Amagenamiterere');
  await page.goto(origin);
  await button(page, /^Classic Smash,/).click();
  const igitebo = button(page, 'Igitebo, ibintu 1');
  await igitebo.waitFor();
  await inspectCartHeader(page, igitebo, 'rw');
  await igitebo.tap();
  await shown(page, 'Igitebo cyawe');
  await shown(page, 'Double Smash');
});

test('the menu and Pickup show the checkout window when the device clock is a day ahead', { timeout: 35_000 }, async t => {
  assert.match(api, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/v1$/);
  const server = createPreviewServer(dist);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const serverTime = '2026-11-25T10:00:00Z';
  const deviceTime = new Date(Date.parse(serverTime) + 24 * 60 * 60 * 1000);
  const menuPath = '/stores/kigali/menu?channel=mobile';
  const menu = {
    version: 'pickup-clock-fixture', updatedAt: serverTime,
    store: {
      id: 'kigali', open: true, name: { en: 'Fixture Kigali', rw: 'Fixture Kigali' },
      area: { en: 'Fixture district', rw: 'Fixture district' }, hours: { en: '10:00–18:00', rw: '10:00–18:00' },
    },
    products: [{
      sku: 'double-smash', category: 'burgers', available: true, price: 9200,
      name: { en: 'Double Smash', rw: 'Double Smash' }, description: { en: 'Test burger', rw: 'Test burger' },
      ingredients: [], allergens: [], modifiers: [],
    }],
    slots: [{ id: 'pickup-clock-window', startsAt: '2026-11-25T10:30:00Z', endsAt: '2026-11-25T10:40:00Z', available: true }],
  };
  const copies = [
    { locale: 'en', slot: '25 Nov · 12:30–12:40', unavailable: 'No slots available', next: 'Next pickup time',
      menu: /^Menu(?:,|$)/, add: /^Add to cart/, cart: /^View cart/, choose: 'Choose pickup time', pickup: 'Pickup time' },
    { locale: 'rw', slot: 'Ugu. 25 · 12:30–12:40', unavailable: 'Nta mwanya uhari', next: 'Igihe gikurikira cyo kwakira',
      menu: /^Ifunguro(?:,|$)/, add: /^Shyira mu gitebo/, cart: /^Reba igitebo/, choose: 'Hitamo igihe cyo kwakira', pickup: 'Igihe cyo gufata' },
  ];

  for (const copy of copies) {
    const page = await browser.newPage({ viewport: { width: 320, height: 800 }, isMobile: true, hasTouch: true });
    try {
      page.setDefaultTimeout(6500);
      await page.clock.setFixedTime(deviceTime);
      const unexpectedRequests = [];
      await page.route('**/*', route => {
        const request = route.request();
        if (new URL(request.url()).origin === origin) return route.continue();
        if (request.method() === 'GET' && request.url() === api + menuPath) {
          return route.fulfill({ json: menu, headers: {
            'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'X-Availability-Checked-At',
            'X-Availability-Checked-At': serverTime,
          } });
        }
        unexpectedRequests.push(request.method());
        return route.abort('blockedbyclient');
      });

      if (copy.locale === 'rw') {
        await page.goto(origin + '/settings');
        await button(page, 'Kinyarwanda').click();
        await shown(page, 'Amagenamiterere');
      }
      await page.goto(origin);
      assert.equal(await page.evaluate(() => Date.now()), deviceTime.valueOf());
      const banner = button(page, /Fixture Kigali/);
      const availability = banner.getByText(/^Fixture district · /);
      const available = banner.getByText('Fixture district · ' + copy.slot, { exact: true });
      const unavailable = banner.getByText('Fixture district · ' + copy.unavailable, { exact: true });
      const pickup = page.getByText(copy.next + ' · ' + copy.slot, { exact: true });
      for (const width of [320, 390, 430]) {
        await page.setViewportSize({ width, height: 800 });
        await available.or(unavailable).waitFor();
        assert.equal(await availability.textContent(), 'Fixture district · ' + copy.slot,
          'The menu must use the same clock as Checkout');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
        await capture(page, 'connected-pickup-clock-menu-' + copy.locale + '-' + width);
        await banner.click();
        await pickup.waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
        await capture(page, 'connected-pickup-clock-pickup-' + copy.locale + '-' + width);
        await page.getByRole('tab', { name: copy.menu }).click();
      }

      await button(page, /^Double Smash,/).click();
      await button(page, copy.add).click();
      await button(page, copy.cart).click();
      await button(page, copy.choose).click();
      const option = page.getByRole('radiogroup', { name: copy.pickup }).getByRole('radio', { name: copy.slot, exact: true });
      await option.click();
      assert.equal(await option.getAttribute('aria-checked'), 'true');
      assert.deepEqual(unexpectedRequests, []);
    } finally {
      await page.close();
    }
  }
});

test('open Menu and Pickup advance past expired windows without polling hidden tabs or empty menus', { timeout: 35_000 }, async t => {
  assert.match(api, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/v1$/);
  const server = createPreviewServer(dist);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const checkedAt = '2026-11-25T10:29:50Z';
  const deviceTime = new Date(Date.parse(checkedAt) + 24 * 60 * 60 * 1000);
  const menuUrl = api + '/stores/kigali/menu?channel=mobile';
  const fixtureSlots = [
    { id: 'first', startsAt: '2026-11-25T10:30:00Z', endsAt: '2026-11-25T10:40:00Z', available: true },
    { id: 'second', startsAt: '2026-11-25T10:40:00Z', endsAt: '2026-11-25T10:50:00Z', available: true },
    { id: 'third', startsAt: '2026-11-25T10:50:00Z', endsAt: '2026-11-25T11:00:00Z', available: true },
  ];
  const localized = value => ({ en: value, rw: value });
  const copies = [
    { locale: 'en', date: '25 Nov', next: 'Next pickup time', unavailable: 'No slots available',
      pickup: /^Pickup(?:,|$)/, orders: /^Orders(?:,|$)/, width: 320 },
    { locale: 'rw', date: 'Ugu. 25', next: 'Igihe gikurikira cyo kwakira', unavailable: 'Nta mwanya uhari',
      pickup: /^Kwakira(?:,|$)/, orders: /^Komande(?:,|$)/, width: 430 },
  ];

  for (const copy of copies) {
    const page = await browser.newPage({ viewport: { width: copy.width, height: 800 }, isMobile: true, hasTouch: true });
    try {
      page.setDefaultTimeout(6500);
      await page.clock.install({ time: deviceTime });
      let offeredSlots = fixtureSlots.slice(0, 2);
      let reads = 0;
      await page.route('**/*', route => {
        const request = route.request();
        if (new URL(request.url()).origin === origin) return route.continue();
        if (request.method() !== 'GET' || request.url() !== menuUrl) return route.abort('blockedbyclient');
        reads++;
        return route.fulfill({
          json: {
            version: 'pickup-deadline-fixture', updatedAt: checkedAt, products: [], slots: offeredSlots,
            store: { id: 'kigali', open: true, name: localized('Fixture Kigali'),
              area: localized('Fixture district'), hours: localized('10:00–18:00') },
          },
          headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'X-Availability-Checked-At',
            'X-Availability-Checked-At': checkedAt },
        });
      });
      if (copy.locale === 'rw') {
        await page.goto(origin + '/settings');
        await button(page, 'Kinyarwanda').click();
        await shown(page, 'Amagenamiterere');
      }
      await page.goto(origin);
      const tab = name => page.getByRole('tab', { name });
      const banner = button(page, /Fixture Kigali/);
      const first = 'Fixture district · ' + copy.date + ' · 12:30–12:40';
      const second = 'Fixture district · ' + copy.date + ' · 12:40–12:50';
      const availability = banner.getByText(/^Fixture district · /);
      await shown(page, first);
      const initialReads = reads;

      await page.clock.fastForward(20_000);
      await page.clock.runFor(50);
      assert.equal(await availability.textContent(), second,
        'The open menu must replace the elapsed pickup window without refreshing the menu');
      assert.equal(reads, initialReads);
      await banner.click();
      await shown(page, copy.next + ' · ' + copy.date + ' · 12:40–12:50');
      offeredSlots = [fixtureSlots[2]];
      await page.clock.fastForward(10 * 60_000);
      await shown(page, copy.next + ' · ' + copy.date + ' · 12:50–13:00');
      assert.equal(reads, initialReads + 1);
      await capture(page, 'connected-pickup-deadline-next-' + copy.locale);

      if (copy.locale === 'en') {
        await tab(copy.orders).click();
        offeredSlots = [];
      } else {
        await page.evaluate(() => {
          Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
          document.dispatchEvent(new Event('visibilitychange'));
        });
      }
      await page.clock.fastForward(10 * 60_000);
      await delay(150);
      assert.equal(reads, initialReads + 1, 'A hidden pickup screen must not request another menu');
      if (copy.locale === 'en') {
        await tab(copy.pickup).click();
      } else {
        // This response still lists only the elapsed third window.
        await page.evaluate(() => {
          Reflect.deleteProperty(document, 'visibilityState');
          document.dispatchEvent(new Event('visibilitychange'));
        });
      }
      await shown(page, copy.unavailable);
      await page.waitForFunction(expected => !document.body.innerText.includes(expected), copy.date + ' · 12:50–13:00');
      await page.clock.fastForward(30 * 60_000);
      await delay(150);
      assert.equal(reads, initialReads + 2, 'The empty or elapsed horizon must be checked once on return');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), copy.width);
    } finally {
      await page.close();
    }
  }
});

test('an open checkout clears an expired pickup window and waits for an explicit replacement', { timeout: 35_000 }, async t => {
  assert.match(api, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/v1$/);
  const menuPath = '/stores/kigali/menu?channel=mobile';
  const menu = await send(menuPath).then(response => response.json());
  const burger = menu.products.find(item => item.sku === 'double-smash' && item.available);
  const windows = menu.slots.filter(slot => slot.available && Date.parse(slot.startsAt) > Date.now() + 60_000);
  const [selected, replacement] = windows.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  assert.ok(burger && selected && replacement, 'The local menu must offer Double Smash and two future pickup windows');
  const expiredAt = Date.parse(selected.startsAt) + 2_000;
  assert.ok(Date.parse(replacement.startsAt) > expiredAt);

  const server = createPreviewServer(dist);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(6500);
  await page.clock.install();

  let clockAdvanced = false;
  let refreshedMenus = 0;
  await page.route(api + menuPath, async route => {
    if (!clockAdvanced) return route.continue();
    const response = await route.fetch();
    // The real server clock has not advanced, as with a pre-cutoff snapshot arriving late.
    refreshedMenus++;
    await route.fulfill({ response });
  });
  const quoteInputs = [];
  const orderWrites = [];
  page.on('request', request => {
    if (request.method() !== 'POST' || !request.url().startsWith(api + '/')) return;
    const path = request.url().slice(api.length);
    if (path === '/quotes') quoteInputs.push(request.postDataJSON());
    if (/^\/orders(?:\/[^/]+\/payments)?$/.test(path)) orderWrites.push(path);
  });

  const date = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kigali', day: 'numeric', month: 'short' });
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kigali', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const slotName = slot => {
    const start = new Date(slot.startsAt);
    return `${date.format(start)} · ${time.format(start)}–${time.format(new Date(slot.endsAt))}`;
  };
  const pickupTimes = page.getByRole('radiogroup', { name: 'Pickup time' });
  const option = slot => pickupTimes.getByRole('radio', { name: slotName(slot), exact: true });
  const review = button(page, 'Review order');
  const quoteResponse = () => page.waitForResponse(response =>
    response.url() === api + '/quotes' && response.request().method() === 'POST' && response.ok());

  await page.goto('http://127.0.0.1:' + server.address().port);
  await button(page, /^Double Smash,/).click();
  await button(page, /^Add to cart/).click();
  await button(page, /^View cart/).click();
  await button(page, 'Choose pickup time').click();
  await option(selected).click();
  await page.getByLabel('Phone number', { exact: true }).fill(contact.phone);
  await page.getByLabel('Email address', { exact: true }).fill(contact.email);
  const firstQuote = quoteResponse();
  await review.click();
  assert.equal((await (await firstQuote).json()).slotId, selected.id);
  await shown(page, 'Included tax');
  assert.equal(quoteInputs.length, 1);

  const jump = expiredAt - await page.evaluate(() => Date.now());
  assert.ok(jump > 0, 'The window must expire as the test advances the browser clock');
  clockAdvanced = true;
  const refreshed = page.waitForResponse(response => response.url() === api + menuPath && response.ok());
  await page.clock.fastForward(jump);
  await Promise.all([shown(page, 'Your selected pickup time has passed. Choose another time.'), refreshed]);
  assert.ok(refreshedMenus >= 1);
  assert.equal(await button(page, /^Confirm .*RWF/).count(), 0);
  assert.equal(await pickupTimes.getByRole('radio', { checked: true }).count(), 0);
  const expiredOption = pickupTimes.getByRole('radio', { disabled: false }).filter({ hasText: slotName(selected) });
  assert.equal(await expiredOption.count(), 0);
  await option(replacement).waitFor();
  assert.equal(await review.isDisabled(), true);
  assert.equal(await page.getByLabel('Phone number', { exact: true }).inputValue(), contact.phone);
  assert.equal(await page.getByLabel('Email address', { exact: true }).inputValue(), contact.email);
  await shown(page, '1 × Double Smash');
  await capture(page, 'connected-slot-expired-en-390');
  assert.equal(quoteInputs.length, 1);
  assert.deepEqual(orderWrites, []);

  await option(replacement).click();
  assert.equal(await option(replacement).getAttribute('aria-checked'), 'true');
  const secondQuote = quoteResponse();
  await review.click();
  assert.equal((await (await secondQuote).json()).slotId, replacement.id);
  const lines = [{ sku: burger.sku, modifierIds: [], quantity: 1, unitPrice: burger.price }];
  assert.deepEqual(quoteInputs, [
    { storeId: menu.store.id, slotId: selected.id, lines },
    { storeId: menu.store.id, slotId: replacement.id, lines },
  ]);
  assert.deepEqual(orderWrites, []);
});

test('guest rotation and logout recover from committed responses lost by the browser', { timeout: 65_000 }, async t => {
  assert.match(api, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/v1$/);
  const server = createPreviewServer(dist);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(9500);
  const origin = 'http://127.0.0.1:' + server.address().port;
  const readGuest = () => page.evaluate(() => {
    const key = Object.keys(sessionStorage).find(name => name.endsWith('.guest'));
    return key ? JSON.parse(sessionStorage.getItem(key)) : null;
  });
  const { order, attempt } = await placeBrowserOrder(page, origin, { ...contact, email: 'session-lifecycle@example.test' });
  const original = await readGuest();
  assert.ok(original?.sessionId);

  await page.goto(origin + '/settings');
  await button(page, 'End guest session').click();
  await button(page, 'Confirm end session').click();
  await shown(page, 'Finish or collect your open orders before ending this session.');
  assert.equal((await send(`/orders/${order.id}`, { token: original.accessToken })).status, 200);

  const kitchen = await operator('demo-kitchen');
  const pickup = await operator('demo-pickup');
  const paid = await send(`/local/orders/${order.id}/payments/${attempt.id}/result`, {
    method: 'POST', token: original.accessToken, data: { status: 'paid' },
  });
  assert.equal(paid.status, 200);
  const statusPath = `/operator/orders/${order.id}/status`;
  for (const status of ['preparing', 'ready']) {
    assert.equal((await send(statusPath, { method: 'POST', token: kitchen, data: { status } })).status, 200);
  }
  const { pickupCode } = await send(`/orders/${order.id}`, { token: original.accessToken }).then(response => response.json());
  const collected = await send(statusPath, { method: 'POST', token: pickup, data: { status: 'collected', pickupCode } });
  assert.equal(collected.status, 200);

  const refreshPath = api + '/guest-sessions/refresh';
  const refreshKeys = [];
  page.on('request', request => {
    if (request.url() === refreshPath && request.method() === 'POST') refreshKeys.push(request.postDataJSON().rotationKey);
  });
  const rotation = Promise.withResolvers();
  await page.route(refreshPath, async route => {
    try {
      const response = await route.fetch();
      const update = await response.json();
      await route.abort('connectionreset');
      rotation.resolve({ status: response.status(), update });
    } catch (error) { rotation.reject(error); }
  }, { times: 1 });
  // Advance the saved access deadline so the normal adapter refreshes on the next order read.
  await page.evaluate(() => {
    const key = Object.keys(sessionStorage).find(name => name.endsWith('.guest'));
    const session = JSON.parse(sessionStorage.getItem(key));
    session.expiresAt = '2000-01-01T00:00:00Z';
    sessionStorage.setItem(key, JSON.stringify(session));
  });
  await page.goto(origin + '/orders');
  const { status, update } = await rotation.promise;
  assert.equal(status, 200);
  assert.equal(update.sessionId, original.sessionId);
  assert.notEqual(update.refreshToken, original.refreshToken);
  await page.reload();
  await shown(page, 'Picked up');
  const resumed = await readGuest();
  assert.ok(refreshKeys.length >= 2 && refreshKeys.every(key => key === refreshKeys[0]));
  assert.equal(resumed.refreshToken, update.refreshToken);
  assert.equal((await send('/guest-sessions/refresh', { method: 'POST', data: { refreshToken: original.refreshToken } })).status, 401);

  const revoked = Promise.withResolvers();
  await page.route(api + '/guest-sessions/revoke', async route => {
    try {
      const response = await route.fetch();
      await route.abort('connectionreset');
      revoked.resolve(response.status());
    } catch (error) { revoked.reject(error); }
  }, { times: 1 });
  await page.goto(origin + '/settings');
  await button(page, 'End guest session').click();
  await button(page, 'Confirm end session').click();
  assert.equal(await revoked.promise, 204);
  await shown(page, 'Finish ending this session to clear saved order access.');
  for (const bearer of [original.accessToken, resumed.accessToken]) {
    assert.equal((await send(`/orders/${order.id}`, { token: bearer })).status, 401);
  }
  await page.reload();
  await button(page, 'Retry ending the session').click();
  await shown(page, 'Order access was cleared on this device.');
  assert.equal(await readGuest(), null);
  await page.goto(origin + '/orders');
  await shown(page, 'No orders yet');
});

test('fiscal receipt attachment survives a filter change and an older list response', { timeout: 40_000 }, async t => {
  assert.match(api, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/v1$/);
  const kitchen = await operator('demo-kitchen');
  const pickup = await operator('demo-pickup');
  const managerToken = await operator('demo-manager');
  const order = await readyForPickup(kitchen);
  t.after(async () => {
    await send(`/operator/orders/${order.id}/status`, {
      method: 'POST', token: pickup, data: { status: 'collected', pickupCode: order.pickupCode },
    });
    for (const token of [kitchen, pickup, managerToken]) await send('/operator/sessions/current', { method: 'DELETE', token });
  });

  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  page.setDefaultTimeout(6500);
  const origin = new URL(api).origin;
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(new URL('/operator/index.html', api).href);
  await page.getByLabel('Username', { exact: true }).fill('demo-manager');
  await page.getByLabel('Password', { exact: true }).fill('local-demo-passphrase');
  await button(page, 'Sign in').click();
  await button(page, 'Fiscal receipts').click();

  const shortId = order.number.slice(1);
  const search = page.getByLabel('Filter by order number');
  const refresh = button(page, 'Refresh fiscal receipts');
  await search.fill(shortId);
  const card = page.getByRole('list', { name: 'Orders for fiscal receipts' }).getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name: `Order ${order.number}`, exact: true }) });
  await card.getByText('Awaiting receipt', { exact: true }).waitFor();
  const receiptQuote = await send(`/orders/${order.id}`, { token: order.token });
  assert.equal(receiptQuote.status, 200);
  const { total } = await receiptQuote.json();
  const reference = `RACE-${shortId}`;
  const pdf = testReceipt();
  const referenceInput = card.getByLabel('EBM receipt reference');
  const totalInput = card.getByLabel('Total printed on receipt (RWF)');
  const document = card.getByLabel('EBM receipt PDF');
  const attach = button(card, 'Attach receipt');
  await referenceInput.fill(reference);
  await totalInput.fill(String(total));
  await document.setInputFiles({ name: 'synthetic-ebm-fixture.pdf', mimeType: 'application/pdf', buffer: pdf });

  const listUrl = api + '/operator/receipts';
  const writeUrl = api + `/operator/orders/${order.id}/receipt`;
  const readSnapshot = Promise.withResolvers();
  const committed = Promise.withResolvers();
  const releaseRead = Promise.withResolvers();
  const releaseWrite = Promise.withResolvers();
  const visibleRecord = entries => entries.filter(entry => entry.orderId === order.id);
  let listRequests = 0;
  let writeAttempts = 0;
  let forwardedWrites = 0;
  await page.route(listUrl, async route => {
    if (route.request().method() !== 'GET' || ++listRequests !== 1) return route.continue();
    const response = await route.fetch({ timeout: 8_000 });
    readSnapshot.resolve({ status: response.status(), entries: visibleRecord(await response.json()) });
    await releaseRead.promise;
    await route.fulfill({ response });
  });
  await page.route(writeUrl, async route => {
    const request = route.request();
    if (request.method() !== 'PUT') return route.continue();
    writeAttempts++;
    assert.equal(await request.headerValue('x-receipt-reference'), reference);
    assert.equal(await request.headerValue('x-receipt-total-rwf'), String(total));
    assert.ok(request.postDataBuffer()?.equals(pdf));
    if (writeAttempts === 1) return route.fulfill({ status: 503, json: { code: 'service_unavailable' } });
    forwardedWrites++;
    const response = await route.fetch({ timeout: 8_000 });
    committed.resolve({ status: response.status(), record: await response.json() });
    await releaseWrite.promise;
    await route.fulfill({ response });
  });

  const attached = card.getByText('Attached', { exact: true });
  const issuedReference = card.getByText(`EBM reference ${reference}`, { exact: true });
  try {
    await attach.click();
    await card.getByRole('alert').filter({ hasText: 'The server could not complete this request. Try again.' }).waitFor();
    assert.equal(await referenceInput.inputValue(), reference);
    assert.equal(await totalInput.inputValue(), String(total));
    assert.equal(await document.evaluate(input => input.files.length), 1);
    assert.equal(forwardedWrites, 0);

    await refresh.click();
    const stale = await readSnapshot.promise;
    assert.equal(stale.status, 200);
    assert.deepEqual(stale.entries.map(entry => entry.receiptStatus), ['pending']);
    await attach.click();
    const result = await committed.promise;
    assert.equal(result.status, 200);
    assert.equal(result.record.orderId, order.id);
    assert.equal(result.record.receiptStatus, 'issued');
    assert.equal(result.record.receiptReference, reference);

    await search.fill('Z');
    assert.equal(await card.count(), 0);
    await search.fill(order.number);
    const disabledDuringWrite = await attach.isDisabled();
    releaseWrite.resolve();
    await attached.waitFor();
    await issuedReference.waitFor();
    assert.equal(disabledDuringWrite, true, 'Refiltering a pending upload must keep its submit button disabled');
    assert.equal(await search.evaluate(input => input === document.activeElement), true);

    releaseRead.resolve();
    await refresh.click({ trial: true });
    assert.equal(await attached.isVisible(), true, 'The earlier list response must not roll back the attached receipt');
    assert.equal(await issuedReference.isVisible(), true);
    assert.equal(await search.evaluate(input => input === document.activeElement), true);
  } finally {
    releaseRead.resolve();
    releaseWrite.resolve();
  }

  const fresh = page.waitForResponse(response => response.url() === listUrl && response.request().method() === 'GET' && response.ok());
  await refresh.click();
  const [freshRecord] = visibleRecord(await (await fresh).json());
  assert.equal(freshRecord?.receiptReference, reference);
  assert.equal(await attached.isVisible(), true);
  assert.equal(await issuedReference.isVisible(), true);
  assert.equal(writeAttempts, 2, 'One fixture failure and one retry should be the only browser uploads');
  assert.equal(forwardedWrites, 1, 'Only one logical upload should reach the real API');

  const authoritative = await send('/operator/receipts', { token: managerToken });
  assert.equal(authoritative.status, 200);
  const records = visibleRecord(await authoritative.json());
  assert.deepEqual(records.map(entry => [entry.receiptStatus, entry.receiptReference]), [['issued', reference]]);
  const stored = await send(`/orders/${order.id}/receipt`, { token: order.token });
  assert.equal(stored.status, 200);
  assert.ok(Buffer.from(await stored.arrayBuffer()).equals(pdf));
  await capture(page, 'connected-fiscal-receipt-race');
});

test('manager finds and attaches a fiscal receipt beyond the rolling queue', { timeout: 35_000 }, async t => {
  assert.match(api, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/v1$/);
  const kitchen = await operator('demo-kitchen');
  const pickup = await operator('demo-pickup');
  const order = await readyForPickup(kitchen);
  t.after(async () => {
    await send(`/operator/orders/${order.id}/status`, {
      method: 'POST', token: pickup, data: { status: 'collected', pickupCode: order.pickupCode },
    });
    for (const token of [kitchen, pickup]) await send('/operator/sessions/current', { method: 'DELETE', token });
  });

  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(6500);
  const listUrl = api + '/operator/receipts';
  const origin = new URL(api).origin;
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.route(listUrl, async route => {
    const response = await route.fetch({ timeout: 8_000 });
    if (!response.ok()) return route.fulfill({ response });
    // Only the browser's rolling list omits the target. Exact queries and writes still use the real API.
    const rows = (await response.json()).filter(row => row.orderId !== order.id);
    await route.fulfill({ response, json: rows });
  });
  const lookups = [];
  const uploads = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === new URL(listUrl).pathname && url.searchParams.has('orderCode')) {
      lookups.push(url.searchParams.get('orderCode'));
    }
    if (request.method() === 'PUT' && request.url() === api + `/operator/orders/${order.id}/receipt`) uploads.push(request);
  });
  await page.goto(new URL('/operator/index.html', api).href);
  await page.getByLabel('Username', { exact: true }).fill('demo-manager');
  await page.getByLabel('Password', { exact: true }).fill('local-demo-passphrase');
  const rolling = page.waitForResponse(response => response.url() === listUrl && response.ok());
  await button(page, 'Sign in').click();
  await button(page, 'Fiscal receipts').click();
  assert.ok((await (await rolling).json()).every(row => row.orderId !== order.id));

  const search = page.getByLabel('Filter by order number');
  const card = page.getByRole('list', { name: 'Orders for fiscal receipts' }).getByRole('listitem')
    .filter({ has: page.getByRole('heading', { name: `Order ${order.number}`, exact: true }) });
  await search.fill(order.number);
  assert.equal(await card.count(), 0);
  assert.deepEqual(lookups, []);
  const match = reference => page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === new URL(listUrl).pathname && url.searchParams.get('orderCode')?.toLowerCase() === reference;
  });
  const find = button(page, 'Find order');
  await find.waitFor();
  const exact = match(order.number.slice(1).toLowerCase());
  await find.click();
  const found = await exact;
  assert.equal(found.status(), 200);
  assert.deepEqual((await found.json()).map(row => row.orderId), [order.id]);
  await card.getByText('Awaiting receipt', { exact: true }).waitFor();

  const refresh = button(page, 'Refresh fiscal receipts');
  const rechecked = match(order.number.slice(1).toLowerCase());
  await refresh.click();
  assert.deepEqual((await (await rechecked).json()).map(row => row.orderId), [order.id]);
  await card.getByText('Awaiting receipt', { exact: true }).waitFor();
  const { total } = await send(`/orders/${order.id}`, { token: order.token }).then(response => response.json());
  const reference = `LOOKUP-${order.number.slice(1)}`;
  const pdf = testReceipt();
  await card.getByLabel('EBM receipt reference').fill(reference);
  await card.getByLabel('Total printed on receipt (RWF)').fill(String(total));
  await card.getByLabel('EBM receipt PDF').setInputFiles({
    name: 'unreadable-receipt.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nNo pages\n%%EOF\n'),
  });
  const rejected = page.waitForResponse(response => response.request().method() === 'PUT'
    && response.url() === api + `/operator/orders/${order.id}/receipt`);
  await button(card, 'Attach receipt').click();
  const rejectedUpload = await rejected;
  assert.equal(rejectedUpload.status(), 400);
  assert.equal((await rejectedUpload.json()).code, 'invalid_receipt_pdf');
  await card.getByText('This PDF could not be opened. Choose the original PDF exported by the EBM.', { exact: true }).waitFor();
  await card.getByText('Awaiting receipt', { exact: true }).waitFor();
  await capture(page, 'connected-fiscal-invalid-document');
  await card.getByLabel('EBM receipt PDF').setInputFiles({ name: 'synthetic-ebm-lookup.pdf', mimeType: 'application/pdf', buffer: pdf });
  await button(card, 'Attach receipt').click();
  await card.getByText('Attached', { exact: true }).waitFor();
  await card.getByText(`EBM reference ${reference}`, { exact: true }).waitFor();

  await search.fill(order.id);
  assert.equal(lookups.length, 2, 'Editing the input must not submit another exact query');
  const full = match(order.id);
  await search.press('Enter');
  assert.deepEqual((await (await full).json()).map(row => row.receiptReference), [reference]);
  await card.getByText('Attached', { exact: true }).waitFor();
  assert.equal(lookups.length, 3, 'Exact requests belong to two submits and one explicit refresh');
  assert.equal(uploads.length, 2);
  const persisted = await send(`/orders/${order.id}/receipt`, { token: order.token });
  assert.equal(persisted.status, 200);
  assert.ok(Buffer.from(await persisted.arrayBuffer()).equals(pdf));
  await capture(page, 'connected-fiscal-exact-lookup');
});

test('a saved order denied with a private 404 offers phone verification for its own number', { timeout: 45_000 }, async t => {
  const isolatedFixture = process.env.CRUSTCAPER_SAVED_ORDER_FIXTURE_API;
  const upstream = isolatedFixture || api;
  for (const url of [api, upstream]) assert.match(url, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/v1$/);
  if (isolatedFixture) assert.notEqual(upstream, api, 'Use a dedicated fixture endpoint for the one-off OTP rehearsal');
  const fixture = (path, options) => send(path, { ...options, baseUrl: upstream });
  const menu = await fixture('/stores/kigali/menu').then(response => response.json());
  const product = menu.products.find(item => item.name.en === 'Double Smash' && item.available);
  const slots = menu.slots.filter(item => item.available).slice(-2);
  assert.ok(product && slots.length === 2);

  async function createOrder(slot, buyer) {
    const guestResponse = await fixture('/guest-sessions', { method: 'POST' });
    assert.ok(guestResponse.ok);
    const session = await guestResponse.json();
    const token = session.accessToken;
    const quote = await fixture('/quotes', { method: 'POST', token, data: { storeId: menu.store.id, slotId: slot.id,
      lines: [{ sku: product.sku, modifierIds: [], quantity: 1, unitPrice: product.price }] } });
    assert.ok(quote.ok);
    const { quoteId } = await quote.json();
    const placed = await fixture('/orders', { method: 'POST', token, key: randomUUID(), data: { quoteId, ...buyer } });
    assert.ok(placed.ok);
    const { id } = await placed.json();
    return { id, session, number: id.slice(-8).toUpperCase() };
  }

  const earlier = await createOrder(slots[0], contact);
  const latest = await createOrder(slots[1], { ...contact, phone: '+250700000001' });
  const previousRead = await fixture('/orders/' + earlier.id, { token: latest.session.accessToken });
  assert.equal(previousRead.status, 404);
  assert.equal((await previousRead.json()).code, 'not_found');
  assert.equal((await fixture('/orders/' + latest.id, { token: latest.session.accessToken })).status, 200);

  const server = createPreviewServer(dist);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  page.setDefaultTimeout(6500);
  const origin = 'http://127.0.0.1:' + server.address().port;
  const apiUrl = new URL(api);
  const journalKey = 'crustcaper.checkout.v1.local.' + apiUrl.hostname + '.' + apiUrl.port + '.kigali';
  const orderIds = [latest.id, earlier.id];
  await page.addInitScript(({ origin, journalKey, orderIds, session }) => {
    if (location.origin !== origin) return;
    sessionStorage.setItem(journalKey, JSON.stringify({ version: 1, active: null, orderIds }));
    sessionStorage.setItem(journalKey + '.guest', JSON.stringify(session));
  }, { origin, journalKey, orderIds, session: latest.session });
  const writes = [];
  await page.route('**/*', async route => {
    const request = route.request();
    const url = request.url();
    if (new URL(url).origin === origin) return route.continue();
    if (!url.startsWith(api + '/')) return route.abort();
    const method = request.method();
    if (method !== 'GET' && method !== 'OPTIONS') writes.push([method, new URL(url).pathname]);
    if (upstream === api) return route.continue();
    const response = await route.fetch({ url: upstream + url.slice(api.length), maxRedirects: 0 });
    return route.fulfill({ response });
  });

  async function checkContext(actionLabel, notice, field, screenshot) {
    const action = button(page, actionLabel);
    await action.waitFor();
    await shown(page, notice);
    const texts = [action.getByText(actionLabel, { exact: true }), page.getByText(notice, { exact: true })];
    const before = await Promise.all(texts.map(text =>
      text.evaluate(element => {
        const style = getComputedStyle(element);
        const original = { fontSize: element.style.fontSize, lineHeight: element.style.lineHeight };
        element.style.fontSize = (2 * parseFloat(style.fontSize)) + 'px';
        element.style.lineHeight = (2 * parseFloat(style.lineHeight)) + 'px';
        return original;
      })));
    for (const width of [390, 430, 320]) {
      await page.setViewportSize({ width, height: 840 });
      await action.scrollIntoViewIfNeeded();
      const bounds = await action.boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1, 'Contextual recovery stays within the viewport');
      for (const text of texts) {
        assert.ok(await text.evaluate(element => element.scrollWidth <= element.clientWidth + 1),
          'Enlarged recovery copy fits its container');
      }
    }
    await capture(page, screenshot);
    await Promise.all(texts.map((text, index) => text.evaluate((element, original) => {
      element.style.fontSize = original.fontSize;
      element.style.lineHeight = original.lineHeight;
    }, before[index])));
    await action.click();
    await page.waitForURL(/\/order-recovery(?:\?|$)/);
    assert.equal(await page.getByLabel(field, { exact: true }).inputValue(), earlier.number);
  }

  const orderUrl = api + '/orders/' + earlier.id;
  const missing = page.waitForResponse(response => response.url() === orderUrl && response.status() === 404);
  await page.goto(origin + '/orders');
  await button(page, 'Find an order from another device').waitFor();
  await page.getByRole('button', { name: '#' + earlier.number, exact: true }).click();
  await missing;
  await checkContext('Verify this order by phone', 'Verify your phone number to open this saved order.', 'Order number', 'saved-order-404-en');
  await page.getByLabel(/(?:, back|Go back)$/i).click();
  await page.waitForURL(origin + '/orders');
  await button(page, 'Settings').click();
  await button(page, 'Kinyarwanda').click();
  await shown(page, 'Amagenamiterere');
  await page.getByLabel(/(?:, back|Go back)$/i).click();
  await page.waitForURL(origin + '/orders');
  await checkContext('Emeza iyi komande ukoresheje telefoni', 'Emeza nimero ya telefoni kugira ngo ufungure iyi komande yabitswe.',
    'Nimero ya komande', 'saved-order-404-rw');
  assert.deepEqual(writes, []);

  // The standard suite already verifies an SMS on the one synthetic phone under the shared cooldown.
  // A dedicated database also exercises granting the selected historical order in this scenario.
  if (isolatedFixture) {
    await page.getByLabel('Nimero ya telefoni', { exact: true }).fill(contact.phone);
    await button(page, 'Saba kode yo kwemeza').click();
    const code = page.getByLabel('Kode yo kwemeza', { exact: true });
    await code.fill('418263');
    let verified;
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = page.waitForResponse(item =>
        /\/api\/v1\/order-access\/challenges\/[^/]+\/verify$/.test(item.url()) && item.request().method() === 'POST');
      await button(page, 'Emeza kode ufungure komande').click();
      verified = await response;
      if (verified.ok()) break;
      assert.equal(verified.status(), 404);
      await delay(500);
    }
    assert.ok(verified?.ok(), 'The isolated fixture must confirm the received OTP');
    assert.deepEqual(await verified.json(), { orderId: earlier.id });
    await page.waitForURL(origin + '/orders');
    assert.equal((await fixture('/orders/' + earlier.id, { token: latest.session.accessToken })).status, 200);
    await shown(page, 'Gutegereza ubwishyu');
    assert.ok(writes.every(([method, path]) => method === 'POST' && path.startsWith('/api/v1/order-access/challenges')));
  }
});

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
  const { order, attempt } = await placeBrowserOrder(page, opened, contact, 'connected-menu');
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

  const afterExpiry = await page.evaluate(() => {
    const guestKey = Object.keys(sessionStorage).find(key => key.endsWith('.guest'));
    const journalKey = guestKey.slice(0, -'.guest'.length);
    const session = JSON.parse(sessionStorage.getItem(guestKey));
    session.expiresAt = session.refreshExpiresAt = '2020-01-01T00:00:00Z';
    const journal = JSON.parse(sessionStorage.getItem(journalKey));
    if (journal.active?.phase !== 'tracking') throw new Error('Expected a paid fixture saved for tracking');
    // Model a previous launch that lost the write from paying to tracking after the API accepted payment.
    journal.active.phase = 'paying';
    return { guestKey, session, journalKey, journal: JSON.stringify(journal) };
  });
  await secondDevice.evaluate(({ guestKey, session, journalKey, journal }) => {
    sessionStorage.setItem(guestKey, JSON.stringify(session));
    sessionStorage.setItem(journalKey, journal);
  }, afterExpiry);
  let freshGuests = 0;
  const recoveryPaymentWrites = [];
  secondDevice.on('request', request => {
    if (request.method() !== 'POST') return;
    if (request.url() === api + '/guest-sessions') freshGuests++;
    if (request.url().includes('/payments')) recoveryPaymentWrites.push(request.url());
  });
  await secondDevice.reload();
  await shown(secondDevice, 'Verify your phone number to open this saved order.');
  assert.equal(freshGuests, 0, 'Opening saved orders must not replace an expired identity');
  await capture(secondDevice, 'expired-guest-order');
  await button(secondDevice, 'Verify this order by phone').click();
  assert.equal(await secondDevice.getByLabel('Order number', { exact: true }).inputValue(), order.id.slice(-8).toUpperCase());
  await secondDevice.getByLabel('Phone number', { exact: true }).fill(contact.phone);
  await button(secondDevice, 'Request verification code').click();
  await shown(secondDevice, 'Verify your phone');
  await capture(secondDevice, 'connected-order-recovery');
  assert.equal(freshGuests, 1);
  assert.equal(await secondDevice.evaluate(key => JSON.parse(sessionStorage.getItem(key)).expiresAt, afterExpiry.guestKey),
    '2020-01-01T00:00:00Z', 'The original session remains installed until verification succeeds');
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
  assert.deepEqual(recoveryPaymentWrites, []);
  const recoveredAuthorization = (await recovery.request().allHeaders()).authorization;
  assert.ok(recoveredAuthorization?.startsWith('Bearer '));
  const recoveredToken = recoveredAuthorization.slice(7);
  assert.ok(recoveredToken !== token, 'The second device must retain its own guest identity');
  const disallowedPayment = await send(`/orders/${order.id}/payments`, {
    method: 'POST', token: recoveredToken, key: 'recovered-device-payment',
  });
  assert.equal(disallowedPayment.status, 404);
  const localPrivacy = await secondDevice.evaluate(async ({ endpoint, proof }) => {
    const response = await fetch(endpoint, { method: 'PUT', headers: { Authorization: proof } });
    const payload = await response.json();
    return { status: response.status, requestState: payload.request?.status };
  }, { endpoint: api + '/orders/' + order.id + '/erasure-request', proof: recoveredAuthorization });
  assert.deepEqual(localPrivacy, { status: 200, requestState: 'pending' });
  assert.ok((await downloadedReceipt(secondDevice)).equals(pdf));
  await button(secondDevice, 'Restore saved checkout').click();
  await button(secondDevice, 'Restore saved checkout').waitFor({ state: 'detached' });
  assert.deepEqual(recoveryPaymentWrites, []);
  const { order: followUp } = await placeBrowserOrder(secondDevice, opened, contact);
  assert.notEqual(followUp.id, order.id);
  assert.deepEqual(recoveryPaymentWrites, [api + '/orders/' + followUp.id + '/payments']);
  await secondDevice.close();

  assert.equal((await advance(pickup, 'collected', pickupCode === '000000' ? '999999' : '000000')).status, 409);
  await page.bringToFront();
  const statusUrl = `${api}/orders/${order.id}`;
  const lastReady = page.waitForResponse(response => response.url() === statusUrl && response.ok());
  await button(page, 'Refresh order status').click();
  assert.equal((await (await lastReady).json()).status, 'ready');
  assert.equal(await page.evaluate(() => document.visibilityState), 'visible');
  await shown(page, 'Ready for pickup');
  let failedStatusPolls = 0;
  await page.route(statusUrl, route => {
    failedStatusPolls++;
    return route.abort('connectionfailed');
  }, { times: 1 });
  await shown(page, 'Unable to connect. Check your connection and try again.');
  let malformedStatusPolls = 0;
  await page.route(statusUrl, async route => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    assert.equal((await response.json()).status, 'ready');
    malformedStatusPolls++;
    await route.fulfill({ response, json: { status: 'ready' } });
  }, { times: 1 });
  await page.getByText('We couldn’t verify the latest order status. Check again in Orders.', { exact: true })
    .first().waitFor({ timeout: 12_000 });
  await shown(page, 'Pickup code');
  assert.equal((await advance(pickup, 'collected', pickupCode)).status, 200);
  const collectedAt = Date.now();
  await page.getByText('Picked up', { exact: true }).first().waitFor({ timeout: 14_000 });
  t.diagnostic(`Open order showed the collected status ${Date.now() - collectedAt} ms after API confirmation`);
  assert.equal(failedStatusPolls, 1, 'Foreground status must recover from a failed connection');
  assert.equal(malformedStatusPolls, 1, 'Foreground status must recover from an invalid successful response');
  assert.equal(await page.getByText('Pickup code', { exact: true }).count(), 0);
  await capture(page, 'connected-order-collected');

  const { order: newerOrder } = await placeBrowserOrder(page, opened, contact);
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
  await button(manager, 'Payment review').click();
  await button(manager, 'Verified history').click();
  await button(manager, 'Refresh').click();
  const cancelledShortId = newerOrder.id.slice(-8).toUpperCase();
  const paidCard = manager.getByRole('list', { name: 'Orders', exact: true }).getByRole('listitem')
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
  assert.equal(await button(manager, 'Verified history').getAttribute('aria-pressed'), 'true');
  await button(manager, 'Open exceptions').click();
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

test('staff sign-in submits a private authenticator code and permits blank local demo login', { timeout: 35_000 }, async t => {
  assert.match(api, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/v1$/);
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 320, height: 720 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(6500);
  const submissions = [];
  const authorizedReads = [];
  const sessionUrl = api + '/operator/sessions';
  const code = page.getByLabel('Authenticator code', { exact: true });
  const username = page.getByLabel('Username', { exact: true });
  const password = page.getByLabel('Password', { exact: true });
  const login = button(page, 'Sign in');
  const deniedMessage = 'The username, password or authenticator code was not accepted.';
  let releaseWrong;
  const pendingWrong = new Promise(resolve => { releaseWrong = resolve; });
  t.after(releaseWrong);
  await restrictToOperatorAssets(page);
  await page.route('**/api/v1/operator/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith('/sessions')) {
      assert.equal(request.method(), 'POST');
      assert.equal(url.search, '');
      const credentials = request.postDataJSON();
      submissions.push(credentials);
      if (credentials.authenticatorCode === '123456') await pendingWrong;
      const demo = credentials.username === 'fixture-demo' && !Object.hasOwn(credentials, 'authenticatorCode');
      const approved = credentials.username === 'fixture-enrolled' && credentials.authenticatorCode === '012345';
      if (credentials.password !== 'fixture-only' || (!demo && !approved)) {
        return route.fulfill({ status: 401, json: { code: 'unauthenticated' } });
      }
      return route.fulfill({ status: 201, headers: { 'Cache-Control': 'no-store' }, json: {
        accessToken: demo ? 'fixture-local-session' : 'fixture-mfa-session', role: 'kitchen', storeId: 'kigali',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      } });
    }
    if (url.pathname.endsWith('/sessions/current')) return route.fulfill({ status: 204, body: '' });
    if (url.pathname.endsWith('/orders')) {
      authorizedReads.push((await request.allHeaders()).authorization);
      return route.fulfill({ json: { orders: [], serverTime: new Date().toISOString() } });
    }
    return route.abort();
  });
  await page.goto(new URL('/operator/index.html', api).href);
  assert.equal(await code.getAttribute('autocomplete'), 'one-time-code');
  assert.equal(await code.getAttribute('inputmode'), 'numeric');
  assert.equal(await code.getAttribute('maxlength'), '6');
  assert.equal(await code.getAttribute('required'), null);
  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 720 });
    const inspect = async size => {
      await code.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      assert.ok(await code.evaluate(element => {
        const { left, right, height } = element.getBoundingClientRect();
        return left >= 0 && right <= innerWidth && height >= 48;
      }));
      await capture(page, `operator-staff-mfa-${width}-${size}`);
    };
    await inspect('normal');
    await withLargeText(page, () => inspect('large'), 'div, span, p, h1, label, button');
  }
  await page.setViewportSize({ width: 320, height: 720 });

  const fillEnrolled = async () => {
    await username.fill('fixture-enrolled');
    await password.fill('fixture-only');
  };
  await fillEnrolled();
  await password.press('Tab');
  assert.equal(await code.evaluate(element => element === document.activeElement), true);
  const missing = page.waitForResponse(response => response.url() === sessionUrl);
  await code.press('Enter');
  const missingReply = await missing;
  assert.equal(missingReply.status(), 401);
  assert.deepEqual(await missingReply.json(), { code: 'unauthenticated' });
  await shown(page, deniedMessage);
  assert.deepEqual(submissions[0], { username: 'fixture-enrolled', password: 'fixture-only' });
  assert.equal(await code.inputValue(), '');
  assert.deepEqual(authorizedReads, []);

  await fillEnrolled();
  await code.fill('123456');
  const sentWrong = page.waitForRequest(request => request.url() === sessionUrl);
  const denied = page.waitForResponse(response => response.url() === sessionUrl);
  await code.press('Enter');
  await sentWrong;
  assert.equal(await code.inputValue(), '');
  assert.equal(await code.isDisabled(), true);
  releaseWrong();
  const deniedReply = await denied;
  assert.equal(deniedReply.status(), 401);
  assert.deepEqual(await deniedReply.json(), { code: 'unauthenticated' });
  await shown(page, deniedMessage);
  assert.equal(await code.inputValue(), '');
  assert.equal(await code.isEnabled(), true);
  assert.deepEqual(authorizedReads, []);

  await fillEnrolled();
  await code.fill('012345');
  const accepted = page.waitForResponse(response => response.url() === sessionUrl);
  await code.press('Enter');
  const acceptedReply = await accepted;
  assert.equal(acceptedReply.status(), 201);
  assert.equal(acceptedReply.headers()['cache-control'], 'no-store');
  await shown(page, 'Kitchen queue');
  assert.deepEqual(submissions[2], { username: 'fixture-enrolled', password: 'fixture-only', authenticatorCode: '012345' });
  assert.equal(new URL(page.url()).search, '');
  assert.equal(await code.inputValue(), '');
  assert.ok(await page.evaluate(() => ![...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => value.includes('012345'))));
  await button(page, 'Sign out').click();
  await shown(page, 'Staff sign in');
  assert.equal(await code.inputValue(), '');

  await username.fill('fixture-demo');
  await password.fill('fixture-only');
  await login.click();
  await shown(page, 'Kitchen queue');
  await shown(page, 'No paid orders are waiting.');
  assert.deepEqual(submissions[3], { username: 'fixture-demo', password: 'fixture-only' });
  assert.ok(authorizedReads.includes('Bearer fixture-mfa-session'));
  assert.ok(authorizedReads.includes('Bearer fixture-local-session'));
});

test('manager can reconcile a Kigali date and download its CSV without leaking stale requests', { timeout: 40_000 }, async t => {
  assert.match(api, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/v1$/);
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 320, height: 800 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(6500);
  await page.clock.setFixedTime(new Date('2026-06-15T22:30:00Z'));
  const reads = [];
  const exports = [];
  const downloads = [];
  page.on('download', download => downloads.push(download));
  const csv = 'type,count,amountRwf\r\naccepted,2,9007199254740999\r\n';
  const day = '2026-06-16';
  const slowDate = '2026-06-14';
  const fastDate = '2026-06-15';
  const total = (count, amountRwf) => ({ count, amountRwf });
  const report = date => ({
    date, timeZone: 'Africa/Kigali', currency: 'RWF',
    from: new Date(`${date}T00:00:00+02:00`).toISOString(),
    until: new Date(Date.parse(`${date}T00:00:00+02:00`) + 86_400_000).toISOString(),
    asOf: '2026-06-15T22:30:00Z',
    acceptedPayments: total(2, date === slowDate ? '99' : date === fastDate ? '42' : '9007199254740999'),
    exceptionPayments: total(1, '9200'),
    verifiedRefunds: total(1, '9200'),
    attachedReceipts: total(1, '4600'),
    unattachedReceipts: total(1, '4600'),
    openExceptions: total(1, '4600'),
    undatedAcceptedPayments: date === fastDate ? total(0, '0') : total(1, '3200'),
  });
  let releaseSlow;
  let releaseStaleExport;
  const delayedRead = new Promise(resolve => { releaseSlow = resolve; });
  const delayedExport = new Promise(resolve => { releaseStaleExport = resolve; });
  t.after(() => { releaseSlow(); releaseStaleExport(); });
  await restrictToOperatorAssets(page);
  await page.route('**/api/v1/operator/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path.endsWith('/sessions')) {
      const role = request.postDataJSON().username === 'fixture-manager' ? 'manager' : 'kitchen';
      return route.fulfill({ json: { accessToken: `fixture-${role}`, role, storeId: 'kigali',
        expiresAt: '2026-06-16T01:00:00Z' } });
    }
    if (path.endsWith('/sessions/current')) return route.fulfill({ status: 204, body: '' });
    if (path.endsWith('/orders')) return route.fulfill({ json: { orders: [], serverTime: '2026-06-15T22:30:00Z' } });
    if (path.endsWith('/receipts')) return route.fulfill({ json: [] });
    if (path.endsWith('/operations/signals')) return route.fulfill({ json: {
      observedAt: '2026-06-15T22:30:00Z', paymentWithoutKitchen: 0, fiscalReceiptsOverdue: 0,
      fiscalReceiptOverdueAfterMinutes: 30,
    } });
    if (path.endsWith('/availability')) return route.fulfill({ json: { version: 'reconciliation-fixture', open: true, products: [] } });
    if (path.endsWith('/payment-attempts/pending')) return route.fulfill({ json: { attempts: [], hasMore: false } });
    if (path.endsWith('/payment-exceptions')) return route.fulfill({ json: { exceptions: [], nextCursor: null } });
    const date = url.searchParams.get('date');
    assert.deepEqual([...url.searchParams], [['date', date]]);
    assert.equal((await request.allHeaders()).authorization, 'Bearer fixture-manager');
    assert.equal(request.method(), 'GET');
    if (path.endsWith('/reconciliation')) {
      reads.push(date);
      if (date === slowDate) await delayedRead;
      return route.fulfill({ json: report(date) });
    }
    if (path.endsWith('/reconciliation/export')) {
      exports.push(date);
      if (exports.length === 1) return route.fulfill({ json: { wrong: 'content type' } });
      if (exports.length === 3) await delayedExport;
      return route.fulfill({ contentType: 'text/csv;charset=UTF-8', body: csv });
    }
    return route.abort();
  });

  const signIn = async username => {
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill('fixture-only');
    await button(page, 'Sign in').click();
  };
  const jump = button(page, 'Daily reconciliation');
  const panel = page.getByRole('region', { name: 'Daily reconciliation' });
  const date = panel.getByLabel('Activity date (Kigali)', { exact: true });
  const view = button(panel, 'View reconciliation');
  const download = button(panel, 'Download CSV');
  const acceptedAmount = panel.locator('[data-reconciliation-total=acceptedPayments] strong');
  await page.goto(new URL('/operator/index.html', api).href);
  await signIn('fixture-kitchen');
  await shown(page, 'Kitchen queue');
  assert.equal(await jump.isVisible(), false);
  assert.deepEqual(reads, []);
  await button(page, 'Sign out').click();
  await signIn('fixture-manager');
  await jump.click();
  assert.equal(await date.inputValue(), day);
  await shown(page, '9,007,199,254,740,999 RWF');
  await shown(page, /Undated accepted payments for this restaurant/);
  assert.deepEqual(reads, [day]);

  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 800 });
    const inspect = async size => {
      await acceptedAmount.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      assert.ok(await acceptedAmount.evaluate(element => {
        const { left, right } = element.getBoundingClientRect();
        return left >= 0 && right <= innerWidth && element.scrollWidth <= element.clientWidth;
      }));
      await capture(page, `operator-daily-reconciliation-${width}-${size}`);
    };
    await inspect('normal');
    await withLargeText(page, () => inspect('large'), 'div, span, p, h1, h2, h3, button, label, dt, strong');
  }

  await download.click();
  await shown(page, 'The CSV could not be downloaded. Try again.');
  assert.equal(downloads.length, 0);
  const incoming = page.waitForEvent('download');
  await download.click();
  const file = await incoming;
  assert.equal(file.suggestedFilename(), `crustcaper-reconciliation-${day}.csv`);
  const chunks = [];
  for await (const chunk of await file.createReadStream()) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), csv);

  await date.fill(slowDate);
  assert.equal(await download.isVisible(), false);
  const started = page.waitForRequest(request => request.url() === api + `/operator/reconciliation?date=${slowDate}`);
  await view.click();
  await started;
  await date.fill(fastDate);
  await view.click();
  await shown(page, '42 RWF');
  const staleRead = page.waitForResponse(response => response.url() === api + `/operator/reconciliation?date=${slowDate}`);
  releaseSlow();
  await (await staleRead).finished();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await acceptedAmount.textContent(), '42 RWF');
  assert.equal(await panel.getByText(/Undated accepted payments/).filter({ visible: true }).count(), 0);
  assert.deepEqual(reads, [day, slowDate, fastDate]);

  await date.fill('');
  await view.click();
  await shown(page, 'Choose a valid activity date.');
  assert.equal(await date.getAttribute('aria-invalid'), 'true');
  assert.equal(await download.isVisible(), false);
  assert.deepEqual(reads, [day, slowDate, fastDate]);
  await date.fill(fastDate);
  await view.click();
  await shown(page, '42 RWF');
  const exportUrl = api + `/operator/reconciliation/export?date=${fastDate}`;
  const beganExport = page.waitForRequest(request => request.url() === exportUrl);
  await download.click();
  await beganExport;
  await button(page, 'Sign out').click();
  await shown(page, 'Staff sign in');
  const staleExport = page.waitForResponse(response => response.url() === exportUrl);
  releaseStaleExport();
  await (await staleExport).finished();
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(downloads.length, 1);
  assert.equal(await panel.isVisible(), false);
  assert.deepEqual(exports, [day, day, fastDate]);
});

test('manager operations signals keep failures unknown and discard the previous session', { timeout: 25_000 }, async t => {
  let origin;
  if (process.env.CRUSTCAPER_API_BASE_URL) {
    assert.match(api, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/v1$/);
    origin = new URL(api).origin;
  } else {
    const server = createPreviewServer(resolve(dirname(module.filename), '../server/src/main/resources/static'));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    t.after(() => new Promise(resolve => server.close(resolve)));
    origin = 'http://127.0.0.1:' + server.address().port;
  }
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(6500);
  await page.clock.install();
  const prefix = origin + '/api/v1/operator';
  const signalsUrl = prefix + '/operations/signals';
  const observedAt = '2031-01-01T12:00:00Z';
  const data = (payments, receipts) => ({ observedAt, paymentWithoutKitchen: payments, fiscalReceiptsOverdue: receipts,
    fiscalReceiptOverdueAfterMinutes: 30 });
  const reads = [];
  const delayed = Promise.withResolvers();
  const delayedFinished = Promise.withResolvers();
  let next = { status: 200, json: data(2, 4) };
  let holding = false;
  await page.route(prefix + '/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/sessions/current')) return route.fulfill({ status: 204 });
    if (path.endsWith('/sessions')) {
      const { username } = request.postDataJSON();
      return route.fulfill({ status: 201, json: {
        accessToken: username, role: username.startsWith('manager') ? 'manager' : username, storeId: 'kigali',
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      } });
    }
    if (request.url() === signalsUrl) {
      reads.push(request.headers().authorization);
      if (holding) {
        await delayed.promise;
        await route.fulfill({ status: 401, json: { code: 'unauthenticated' } }).catch(() => {});
        delayedFinished.resolve();
        return;
      }
      return route.fulfill(next);
    }
    if (path.endsWith('/orders')) return route.fulfill({ json: { orders: [], serverTime: observedAt } });
    if (path.endsWith('/payment-exceptions')) return route.fulfill({ json: { exceptions: [], nextCursor: null } });
    if (path.endsWith('/payment-attempts/pending')) return route.fulfill({ json: { attempts: [], hasMore: false } });
    if (path.endsWith('/external-order-channels')) return route.fulfill({ json: { channels: [] } });
    if (path.endsWith('/receipts')) return route.fulfill({ json: [] });
    return route.abort();
  });

  const panel = page.getByRole('region', { name: 'Operations signals' });
  const jump = button(page, 'Operations signals');
  const refresh = button(panel, 'Refresh signals');
  const payments = page.locator('#operations-signals-payment');
  const receipts = page.locator('#operations-signals-receipt');
  const checked = page.locator('#operations-signals-checked');
  const threshold = page.locator('#operations-signals-receipt-threshold');
  const signOut = async () => {
    await button(page, 'Sign out').click();
    await shown(page, 'Staff sign in');
  };
  const signIn = async (username, heading) => {
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill('fixture-only');
    await button(page, 'Sign in').click();
    await page.getByRole('heading', { name: heading, exact: true }).waitFor();
  };

  try {
    await page.goto(origin + '/operator/index.html');
    await signIn('kitchen', 'Kitchen queue');
    assert.equal(await panel.isVisible(), false);
    assert.equal(await jump.isVisible(), false);
    assert.deepEqual(reads, []);
    await signOut();

    await signIn('manager-first', 'Order queue');
    await shown(payments, '2');
    assert.equal(await receipts.textContent(), '4');
    assert.equal(await panel.getByText('Confirmed more than 60 seconds ago').count(), 1);
    await shown(threshold, 'Due 30 minutes after pickup');
    assert.equal(await checked.locator('time').getAttribute('datetime'), observedAt);
    await jump.click();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'operations-signals-title');
    for (const width of [320, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      for (const scale of [100, 200]) {
        await page.evaluate(value => { document.documentElement.style.fontSize = value + '%'; }, scale);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
        await panel.getByRole('heading').scrollIntoViewIfNeeded();
        await capture(page, 'manager-operations-signals-' + width + '-' + scale);
      }
    }
    await page.evaluate(() => { document.documentElement.style.removeProperty('font-size'); });
    await page.setViewportSize({ width: 390, height: 844 });

    next = { status: 503, json: { detail: 'private service detail' } };
    await refresh.click();
    await shown(panel, 'Operations signals could not be loaded. Try again.');
    assert.equal(await payments.textContent(), 'Unknown');
    assert.equal(await receipts.textContent(), 'Unknown');
    assert.equal(await threshold.isVisible(), false);
    assert.equal(await checked.isVisible(), false);
    assert.doesNotMatch(await panel.innerText(), /private service detail/);
    await panel.getByRole('heading').scrollIntoViewIfNeeded();
    await capture(page, 'manager-operations-signals-unknown');

    next = { status: 200, json: data(-1, 8) };
    await refresh.click();
    await shown(panel, 'The operations signals response could not be verified. Try again.');
    assert.equal(await receipts.textContent(), 'Unknown');

    next = { status: 200, json: data(0, 0) };
    await page.clock.runFor(30_100);
    await shown(payments, '0');
    assert.equal(await receipts.textContent(), '0');
    assert.equal(await checked.isVisible(), true);

    await page.clock.runFor(28_300);
    holding = true;
    const before = reads.length;
    const oldRead = page.waitForRequest(request => request.url() === signalsUrl);
    await refresh.click();
    await oldRead;
    assert.equal(await refresh.isDisabled(), true);
    await page.clock.runFor(2000);
    assert.equal(reads.length, before + 1, 'background poll must not overlap manual refresh');
    await signOut();
    assert.equal(await panel.isVisible(), false);
    assert.equal(await payments.textContent(), 'Unknown');

    holding = false;
    next = { status: 200, json: data(7, 1) };
    await signIn('manager-next', 'Order queue');
    await shown(payments, '7');
    delayed.resolve();
    await delayedFinished.promise;
    assert.equal(await panel.isVisible(), true);
    assert.equal(await receipts.textContent(), '1');
    assert.equal(reads.at(-1), 'Bearer manager-next');

    await signOut();
    const afterManagers = reads.length;
    await signIn('pickup', 'Pickup queue');
    await page.clock.runFor(31_000);
    assert.equal(await panel.isVisible(), false);
    assert.equal(await jump.isVisible(), false);
    assert.equal(reads.length, afterManagers);
  } finally {
    delayed.resolve();
  }
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
  const open = Array.from({ length: 50 }, (_, index) => ({
    orderId: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
    merchantReference: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`,
    providerTransactionId: String(1300000 + index),
    reason: 'duplicate_transaction',
    createdAt: '2024-01-01T12:00:00Z',
  }));
  const verified = open.map((entry, index) => ({
    ...entry,
    merchantReference: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`,
    providerTransactionId: String(1400000 + index),
    createdAt: '2026-02-01T12:00:00Z',
    refund: { ...refund, providerRefundId: String(2000000 + index) },
  }));
  const openCursor = 'open-cursor-fixture';
  const verifiedCursor = 'verified-cursor-fixture';
  let recorded = false;
  let openPages = 0;
  const requested = [];
  await restrictToOperatorAssets(page);
  await page.route('**/api/v1/operator/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path.endsWith('/sessions')) {
      return route.fulfill({ json: { accessToken: 'fixture-session', role: 'manager', storeId: 'kigali',
        expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    }
    if (path.endsWith('/sessions/current')) return route.fulfill({ status: 204, body: '' });
    if (path.endsWith('/orders')) return route.fulfill({ json: { orders: [], serverTime: new Date().toISOString() } });
    if (path.endsWith('/receipts')) return route.fulfill({ json: [] });
    if (path.endsWith('/availability')) return route.fulfill({ json: { version: 'finance-fixture', open: true, products: [] } });
    if (path.endsWith('/payment-attempts/pending')) return route.fulfill({ json: { attempts: [], hasMore: false } });
    if (path.endsWith('/payment-exceptions')) {
      const state = url.searchParams.get('state');
      const after = url.searchParams.get('after');
      if (state === 'open') {
        if (after === null) return route.fulfill({ json: { exceptions: open, nextCursor: openCursor } });
        assert.equal(after, openCursor);
        openPages++;
        if (openPages === 1) return route.fulfill({ status: 503, json: { code: 'service_unavailable' } });
        const remaining = recorded ? [] : [payment];
        return route.fulfill({ json: { exceptions: [open.at(-1), ...remaining], nextCursor: null } });
      }
      if (state === 'verified') {
        if (after === null) return route.fulfill({ json: { exceptions: verified, nextCursor: verifiedCursor } });
        assert.equal(after, verifiedCursor);
        return route.fulfill({ json: { exceptions: recorded ? [{ ...payment, refund }] : [], nextCursor: null } });
      }
      assert.equal(state, null);
      return route.fulfill({ json: { exceptions: verified } });
    }
    if (path.endsWith(`/payment-exceptions/${payment.merchantReference}/${payment.providerTransactionId}/refund`)) {
      requested.push(request.postDataJSON().providerRefundId);
      assert.equal(request.method(), 'POST');
      if (requested.at(-1) === refund.providerRefundId) {
        if (recorded) return route.fulfill({ json: refund });
        recorded = true;
        return route.abort('connectionreset');
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
  await page.getByRole('link', { name: 'Go to payment exceptions' }).click();
  const list = page.getByRole('list', { name: 'Payment exceptions' });
  const rows = list.getByRole('listitem');
  const more = button(page, 'Load more exceptions');
  const target = rows.filter({ hasText: payment.orderId });
  const refundInput = () => target.getByLabel('Provider refund ID');
  await more.waitFor();
  assert.equal(await button(page, 'Open exceptions').getAttribute('aria-pressed'), 'true');
  assert.equal(await rows.count(), 50);
  assert.equal(await page.getByText(/^Refund verified/).count(), 0);
  await more.click();
  await shown(page, 'Payment exceptions could not be loaded. Try again.');
  assert.equal(await rows.count(), 50);
  await more.click();
  await target.waitFor();
  assert.equal(await rows.count(), 51, 'An overlapping page does not render duplicate exceptions');
  await refundInput().fill('2022001');
  await button(target, 'Verify refund').click();
  await shown(page, 'Flutterwave did not confirm a completed full refund for this payment.');
  assert.equal(await page.getByText(/^Refund verified/).count(), 0);
  await refundInput().fill(refund.providerRefundId);
  await button(target, 'Verify refund').click();
  await shown(page, 'Verification could not be confirmed. Retry with the same refund ID or check verified history.');
  assert.deepEqual(requested, ['2022001', '2022002']);
  await button(page, 'Refresh payment review').click();
  await more.waitFor();
  assert.equal(await refundInput().inputValue(), refund.providerRefundId);
  assert.equal(await refundInput().getAttribute('readonly'), '');
  await button(page, 'Verified history').click();
  await more.waitFor();
  assert.equal(await button(page, 'Verified history').getAttribute('aria-pressed'), 'true');
  assert.equal(await button(page, 'Verify refund').count(), 0);
  assert.equal(await target.count(), 0, 'The committed old refund is on the next history page');
  await button(page, 'Open exceptions').click();
  await button(target, 'Retry verification').waitFor();
  assert.equal(await refundInput().inputValue(), refund.providerRefundId);
  assert.deepEqual(requested, ['2022001', '2022002']);
  await button(target, 'Retry verification').click();
  await shown(page, 'Refund verified · 9,200 RWF · #2022002');
  assert.equal(await target.count(), 0);
  assert.deepEqual(requested, ['2022001', '2022002', '2022002']);
  await button(page, 'Verified history').click();
  await more.waitFor();
  await more.click();
  await target.getByText('Refund verified · 9,200 RWF · #2022002', { exact: true }).waitFor();
  assert.equal(await button(page, 'Verify refund').count(), 0);
  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 800 });
    await target.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    await capture(page, `operator-refund-history-${width}`);
    await withLargeText(page, async () => {
      await target.scrollIntoViewIfNeeded();
      assert.equal(await target.evaluate(el => el.scrollWidth), await target.evaluate(el => el.clientWidth));
      await capture(page, `operator-refund-history-${width}-large-text`);
    }, 'div, span, p, h1, h2, h3, h4, button');
  }
  await button(page, 'Sign out').click();
  await shown(page, 'Staff sign in');
  assert.equal(await page.getByText(/^Refund verified/).count(), 0);
  await page.getByLabel('Username', { exact: true }).fill('fixture-manager');
  await page.getByLabel('Password', { exact: true }).fill('fixture-only');
  await button(page, 'Sign in').click();
  await more.waitFor();
  assert.equal(await button(page, 'Open exceptions').getAttribute('aria-pressed'), 'true');
  assert.equal(await rows.count(), 50);
  assert.equal(await button(page, 'Retry verification').count(), 0);
  assert.deepEqual(errors, []);
});

test('manager rechecks overdue payments explicitly and reloads payment records after a lost reply', { timeout: 30_000 }, async t => {
  assert.match(api, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/v1$/);
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 320, height: 800 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(6500);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const attempt = {
    orderId: '84e40bb7-09b4-4a87-9027-f51487fcaf66',
    merchantReference: '98fd88b0-01a4-4df4-97fd-e61d7c8aa7c5',
    reservationExpiresAt: '2026-01-01T12:00:00Z',
    lastCheckedAt: null,
  };
  const firstPage = [attempt, ...Array.from({ length: 49 }, (_, index) => ({
    ...attempt,
    orderId: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
    merchantReference: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`,
  }))];
  const last = firstPage.at(-1).merchantReference;
  const later = {
    ...attempt,
    orderId: '7643a790-ef8b-43bd-8867-bf72a227b93e',
    merchantReference: '49851290-bdb8-4c9c-86b6-2449822092de',
  };
  const paymentExceptions = [{
    orderId: '8e7b4721-c0c5-48c1-b3ad-e788388c6dfa',
    merchantReference: 'cb9d9c54-0638-4361-adf0-4fe7abbb0195',
    providerTransactionId: '1011001',
    reason: 'duplicate_transaction',
    createdAt: '2026-01-01T12:30:00Z',
  }];
  const checkPath = `/api/v1/operator/payment-attempts/${attempt.merchantReference}/recheck`;
  const pendingReads = [];
  let exceptionReads = 0;
  let checks = 0;
  let completeFirstCheck;
  const firstCheck = new Promise(resolve => { completeFirstCheck = resolve; });
  t.after(completeFirstCheck);
  await restrictToOperatorAssets(page);
  await page.route('**/api/v1/operator/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path.endsWith('/sessions')) {
      const role = request.postDataJSON().username === 'fixture-manager' ? 'manager' : 'kitchen';
      return route.fulfill({ json: { accessToken: 'fixture-session', role, storeId: 'kigali',
        expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    }
    if (path.endsWith('/sessions/current')) return route.fulfill({ status: 204, body: '' });
    if (path.endsWith('/orders')) return route.fulfill({ json: { orders: [], serverTime: new Date().toISOString() } });
    if (path.endsWith('/receipts')) return route.fulfill({ json: [] });
    if (path.endsWith('/availability')) return route.fulfill({ json: { version: 'finance-fixture', open: true, products: [] } });
    if (path.endsWith('/payment-exceptions')) {
      exceptionReads++;
      assert.equal(url.searchParams.get('state'), 'open');
      return route.fulfill({ json: { exceptions: paymentExceptions, nextCursor: null } });
    }
    if (path.endsWith('/payment-attempts/pending')) {
      const after = url.searchParams.get('after');
      pendingReads.push(after);
      if (pendingReads.length === 1) return route.fulfill({ status: 503, json: { code: 'unavailable' } });
      if (after === last) return route.fulfill({ json: { attempts: [later], hasMore: false } });
      assert.equal(after, null);
      return route.fulfill({ json: { attempts: checks === 3 ? [] : firstPage, hasMore: checks < 3 } });
    }
    if (path === checkPath) {
      assert.equal(request.method(), 'POST');
      assert.equal(request.postData(), null);
      checks++;
      if (checks === 1) {
        await firstCheck;
        attempt.lastCheckedAt = '2026-01-01T12:35:00Z';
        return route.fulfill({ json: { status: 'pending' } });
      }
      if (checks === 2) return route.fulfill({ status: 409, json: { code: 'payment_check_cooldown' } });
      paymentExceptions.push({
        orderId: attempt.orderId, merchantReference: attempt.merchantReference,
        providerTransactionId: '2022002', reason: 'unavailable_reservation', createdAt: '2026-01-01T12:40:00Z',
      });
      return route.abort('connectionreset');
    }
    return route.abort();
  });

  const signIn = async username => {
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill('fixture-only');
    await button(page, 'Sign in').click();
  };
  await page.goto(new URL('/operator/index.html', api).href);
  await signIn('fixture-kitchen');
  await shown(page, 'Kitchen queue');
  assert.equal(await button(page, 'Payment review').isVisible(), false);
  assert.equal(await page.locator('#payment-review').isVisible(), false);
  await button(page, 'Sign out').click();
  await signIn('fixture-manager');
  await button(page, 'Payment review').click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'payment-review-title');
  await shown(page, 'Unresolved payments could not be loaded. Select Refresh unresolved payments.');
  await shown(page, 'Duplicate payment');
  assert.equal(exceptionReads, 1);
  assert.equal(checks, 0);

  const pending = page.getByRole('list', { name: 'Unresolved payments' });
  const recheck = button(pending, 'Recheck payment for order #87FCAF66');
  const card = pending.getByRole('listitem').filter({ has: button(page, 'Recheck payment for order #87FCAF66') });
  await button(page, 'Refresh unresolved payments').click();
  await recheck.waitFor();
  assert.equal(await card.locator('.pending-payment-reference').textContent(), attempt.merchantReference);
  assert.equal(await card.locator('.pending-payment-order').textContent(), attempt.orderId);
  await shown(page, 'Awaiting first check');
  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    await card.scrollIntoViewIfNeeded();
    await capture(page, `operator-pending-payment-review-${width}`);
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    assert.equal(await card.evaluate(el => el.scrollWidth), await card.evaluate(el => el.clientWidth));
    assert.equal(await pending.evaluate(el => el.scrollWidth), await pending.evaluate(el => el.clientWidth));
    await recheck.scrollIntoViewIfNeeded();
    await capture(page, `operator-pending-payment-review-${width}-large-text`);
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  }
  await page.setViewportSize({ width: 320, height: 800 });
  await page.getByRole('link', { name: 'Go to payment exceptions' }).click();
  assert.equal(await page.evaluate(() => document.activeElement.id), 'payment-exceptions-title');
  await shown(page, 'Duplicate payment');

  await button(page, 'Next 50 payments').click();
  await shown(page, 'Order #A227B93E');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'pending-payments-title');
  assert.equal(await recheck.count(), 0);
  const pageReloaded = page.waitForResponse(response => new URL(response.url()).searchParams.get('after') === last);
  await button(page, 'Refresh unresolved payments').click();
  await pageReloaded;
  await button(page, 'First page').click();
  await recheck.waitFor();
  assert.deepEqual(pendingReads, [null, null, last, last, null]);

  const posted = page.waitForRequest(request => new URL(request.url()).pathname === checkPath && request.method() === 'POST');
  await recheck.click();
  await posted;
  await shown(page, 'Checking payment for order #87FCAF66…');
  assert.equal(await recheck.isDisabled(), true);
  assert.equal(await page.getByText(/Payment check completed/).count(), 0);
  assert.equal(pendingReads.length, 5);
  assert.equal(exceptionReads, 1);
  completeFirstCheck();
  await shown(page, 'Payment for order #87FCAF66 is still unresolved.');
  assert.equal(await card.getByText('Awaiting first check').count(), 0);
  assert.match(await card.locator('.pending-payment-checked').textContent(), /14:35/);
  assert.deepEqual([pendingReads.length, exceptionReads, checks], [6, 2, 1]);

  await recheck.click();
  await shown(page, 'This payment was checked recently. Wait before rechecking.');
  assert.deepEqual([pendingReads.length, exceptionReads, checks], [7, 3, 2]);

  await recheck.click();
  await shown(page, 'The payment check could not be confirmed. Review the payment lists before trying again.');
  await shown(page, 'No unresolved payments with an expired reservation.');
  await shown(page, 'Payment after reservation ended');
  assert.equal(await page.getByText(/Payment check completed/).count(), 0);
  assert.equal(await recheck.count(), 0);
  assert.deepEqual([pendingReads.length, exceptionReads, checks], [8, 4, 3]);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'pending-payments-notice');
  await button(page, 'Refresh unresolved payments').click();
  await shown(page, 'No unresolved payments with an expired reservation.');
  assert.deepEqual([pendingReads.length, exceptionReads, checks], [9, 4, 3]);
  await button(page, 'Sign out').click();
  await shown(page, 'Staff sign in');
  assert.equal(await pending.getByText(attempt.merchantReference).count(), 0);
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
  const card = page.getByRole('list', { name: 'Orders', exact: true }).getByRole('listitem')
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

test('a queue refresh failure hides stale emptiness and only shows a valid support ID', { timeout: 25_000 }, async t => {
  assert.match(api, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/v1$/);
  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(6500);

  const supportId = 'ba8b8f93-4a07-4711-82d6-189a3cfe5747';
  const problem = 'The order queue could not be refreshed. Try again.';
  let unavailable = false;
  let responseId = supportId;
  const order = {
    id: '7868ff38-8501-4ea7-a7cb-4d2d52e4fe7a', status: 'accepted', paymentStatus: 'paid',
    acceptedAt: '2031-01-01T12:00:00Z', pickupStartsAt: '2031-01-01T12:10:00Z', pickupEndsAt: '2031-01-01T12:20:00Z',
    lines: [{ sku: 'double-smash', modifierIds: [], quantity: 1 }],
  };
  let orders = [];
  await page.route(api + '/operator/orders', route => unavailable
    ? route.fulfill({ status: 503, headers: { 'X-Request-ID': responseId }, json: { detail: 'private fixture detail' } })
    : route.fulfill({ json: { orders, serverTime: '2031-01-01T12:00:05Z' } }));
  await page.goto(new URL('/operator/index.html', api).href);
  await page.getByLabel('Username', { exact: true }).fill('demo-kitchen');
  await page.getByLabel('Password', { exact: true }).fill('local-demo-passphrase');
  await button(page, 'Sign in').click();
  await shown(page, 'No paid orders are waiting.');

  unavailable = true;
  await button(page, 'Refresh').click();
  await shown(page, `${problem} Support ID ${supportId}.`);
  assert.equal(await page.locator('#empty-state').isVisible(), false);
  assert.equal(await page.locator('#queue-stale').isVisible(), true);
  assert.doesNotMatch(await page.locator('#queue-problem').textContent(), /private fixture detail/);
  await capture(page, 'operator-queue-refresh-failure');

  unavailable = false;
  orders = [order];
  await button(page, 'Refresh').click();
  await button(page, 'Start preparing').waitFor();
  assert.equal(await page.locator('#queue-problem').isVisible(), false);
  assert.equal(await button(page, 'Start preparing').isEnabled(), true);

  unavailable = true;
  responseId = 'fixture-not-a-request-id';
  await button(page, 'Refresh').click();
  await shown(page, problem);
  assert.equal(await button(page, 'Start preparing').isDisabled(), true);
  assert.equal(await page.locator('#queue-problem').textContent(), problem);

  unavailable = false;
  orders = [];
  await button(page, 'Refresh').click();
  await shown(page, 'No paid orders are waiting.');
  assert.equal(await page.locator('#queue-problem').isVisible(), false);
  assert.equal(await page.locator('#queue-stale').isVisible(), false);
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

test('manager reconciles an uncertain pause or stock change once and marks an unreadable snapshot unknown', { timeout: 45_000 }, async t => {
  const manager = await operator('demo-manager');
  const path = '/operator/availability';
  const snapshot = () => send(path, { token: manager }).then(response => {
    assert.equal(response.status, 200);
    return response.json();
  });
  const original = await snapshot();
  const item = original.products.find(product => product.name.en === 'Double Smash');
  assert.ok(original.open && item?.available, 'The synthetic store and product must start open');
  t.after(async () => {
    let current = await snapshot();
    async function restore(change) {
      const response = await send(path, { token: manager, method: 'PATCH', data: { expectedVersion: current.version, ...change } });
      assert.equal(response.status, 200);
      current = await response.json();
    }
    if (current.open !== original.open) await restore({ open: original.open });
    if (!current.products.find(product => product.sku === item.sku)?.available) await restore({ sku: item.sku, available: true });
    assert.equal((await send('/operator/sessions/current', { token: manager, method: 'DELETE' })).status, 204);
  });

  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(6500);
  const writes = [];
  const reads = [];
  const pauseCommitted = Promise.withResolvers();
  let fault;
  await page.route(api + path, async route => {
    if (!fault) return route.continue();
    if (route.request().method() === 'PATCH') {
      writes.push(route.request().postDataJSON());
      const result = await route.fetch();
      assert.equal(result.status(), 200, 'Forward one authorized change to the synthetic API');
      if (fault.label === 'pause') pauseCommitted.resolve();
      if (fault.wrongSnapshot) return route.fulfill({ status: 200, json: fault.wrongSnapshot });
      return route.abort('connectionreset');
    }
    reads.push(fault.label);
    if (fault.failRead) return route.fulfill({ status: 503, json: { code: 'unavailable' } });
    return route.continue();
  });
  await page.goto(new URL('/operator/index.html', api).href);
  await page.getByLabel('Username', { exact: true }).fill('demo-manager');
  await page.getByLabel('Password', { exact: true }).fill('local-demo-passphrase');
  await button(page, 'Sign in').click();
  await shown(page, 'Accepting new orders');
  const row = page.locator('#availability-list > li').filter({ hasText: 'Double Smash' });

  fault = { label: 'pause' };
  await button(page, 'Pause new orders').click();
  await pauseCommitted.promise;
  const paused = await snapshot();
  assert.equal(paused.open, false);
  assert.notEqual(paused.version, original.version);
  await shown(page, 'New orders are paused.');
  assert.deepEqual(reads, ['pause']);

  fault = { label: 'stop list', wrongSnapshot: paused };
  await button(page, 'Put on stop list: Double Smash').click();
  await shown(page, 'Double Smash is on the stop list.');
  await shown(row, 'On stop list');
  const stopped = await snapshot();
  assert.equal(stopped.products.find(product => product.sku === item.sku).available, false);
  assert.notEqual(stopped.version, paused.version);
  assert.deepEqual(reads, ['pause', 'stop list']);

  fault = { label: 'reopen', failRead: true };
  await button(page, 'Accept new orders').click();
  await shown(page, 'Order intake status unknown');
  await shown(row, 'Availability unknown');
  await shown(page, 'The current availability could not be verified. Refresh availability before trying again.');
  assert.equal(await button(page, 'Accept new orders').isDisabled(), true);
  assert.equal(await page.getByText('New orders paused', { exact: true }).isVisible(), false);
  const reopened = await snapshot();
  assert.equal(reopened.open, true);
  assert.notEqual(reopened.version, stopped.version);
  assert.deepEqual(reads, ['pause', 'stop list', 'reopen']);
  assert.deepEqual(writes, [
    { expectedVersion: original.version, open: false },
    { expectedVersion: paused.version, sku: item.sku, available: false },
    { expectedVersion: stopped.version, open: true },
  ]);

  await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
  for (const width of [430, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await shown(page, 'Order intake status unknown');
    assert.ok(await page.locator('#availability').evaluate(panel => panel.scrollWidth <= panel.clientWidth));
  }
  await page.locator('#availability-store').scrollIntoViewIfNeeded();
  await capture(page, 'operator-availability-unknown');
  await page.evaluate(() => { document.documentElement.style.removeProperty('font-size'); });
  await page.setViewportSize({ width: 390, height: 844 });

  fault = null;
  await button(page, 'Refresh availability').click();
  await shown(page, 'Accepting new orders');
  await shown(row, 'On stop list');
  assert.equal(await button(page, 'Pause new orders').isEnabled(), true);
  assert.equal(writes.length, 3);
  await capture(page, 'operator-availability-reconciled');
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

test('manager reviews and publishes pickup windows once after a lost reply', { timeout: 50_000 }, async t => {
  assert.match(api, /^http:\/\/(?:127\.0\.0\.1|localhost):\d+\/api\/v1$/);
  const path = '/operator/availability';
  const menuPath = '/stores/kigali/menu';
  const manager = await operator('demo-manager');
  const getMenu = async () => {
    const response = await send(menuPath);
    assert.equal(response.status, 200);
    return response.json();
  };
  const getAvailability = async () => {
    const response = await send(path, { token: manager });
    assert.equal(response.status, 200);
    return response.json();
  };
  const initial = await getAvailability();
  const menuBefore = await getMenu();
  const product = menuBefore.products.find(item => item.sku === 'double-smash' && item.available);
  assert.ok(initial.open && menuBefore.store.open && product, 'The local fixture must offer Double Smash for pickup');
  const firstShift = initial.slots.length === 0 && menuBefore.slots.length === 0;
  // The shared local fixture seeds a dense seven-day schedule. An empty fixture can exercise the first shift in the public menu.
  const day = new Date(Date.now() + ((firstShift ? 1 : 9) * 24 + 2) * 60 * 60 * 1000).toISOString().slice(0, 10);
  const date = process.env.CRUSTCAPER_TEST_PICKUP_SCHEDULE_DATE ?? day;
  const start = '17:00';
  const end = '17:20';
  const capacity = 1;
  const startsAt = Date.parse(`${date}T${start}:00+02:00`);
  assert.ok(Number.isFinite(startsAt) && startsAt > Date.now());
  const endsAt = startsAt + 20 * 60 * 1000;
  assert.equal(initial.slots.some(slot => Date.parse(slot.startsAt) < endsAt && Date.parse(slot.endsAt) > startsAt), false);

  const browser = await chromium.launch({ channel: 'chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 320, height: 844 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(8500);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const submissions = [];
  const replies = [];
  const operatorPage = new URL('/operator/index.html', api);
  await restrictToOperatorAssets(page);
  await page.route(api + '/operator/**', async route => {
    if (route.request().url() !== api + path || route.request().method() !== 'PATCH') return route.continue();
    submissions.push(route.request().postDataJSON());
    const response = await route.fetch();
    replies.push({ status: response.status(), snapshot: await response.json() });
    if (replies.length === 1 && response.ok()) return route.abort('connectionreset');
    return route.fulfill({ response });
  });
  await page.goto(operatorPage.href);
  await page.getByLabel('Username', { exact: true }).fill('demo-manager');
  await page.getByLabel('Password', { exact: true }).fill('local-demo-passphrase');
  await button(page, 'Sign in').click();
  await button(page, 'Menu availability').click();
  const schedule = page.getByRole('region', { name: 'Publish pickup windows' });
  await schedule.waitFor();
  await schedule.getByLabel('Pickup date (Kigali)', { exact: true }).fill(date);
  await schedule.getByLabel('Start time (Kigali)', { exact: true }).fill(start);
  await schedule.getByLabel('End time (Kigali)', { exact: true }).fill(end);
  await schedule.getByLabel('Orders per window', { exact: true }).fill(String(capacity));
  assert.equal((await getAvailability()).version, initial.version);

  const review = button(schedule, 'Review pickup schedule');
  const dialog = page.getByRole('dialog', { name: 'Review pickup schedule' });
  const summary = `${date}, ${start}–${end} Kigali time. 2 pickup windows, 1 order per window.`;
  await review.click();
  await dialog.waitFor();
  await dialog.getByText(summary, { exact: true }).waitFor();
  const publish = button(dialog, 'Publish windows');
  const edit = button(dialog, 'Edit schedule');
  assert.equal(submissions.length, 0, 'Review must not submit a publication');
  await edit.click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(submissions.length, 0, 'Returning to editing must not submit a publication');
  assert.equal(await schedule.getByLabel('Pickup date (Kigali)', { exact: true }).inputValue(), date);
  await review.click();
  await dialog.waitFor();
  for (const width of [320, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    const inspect = async size => {
      await publish.scrollIntoViewIfNeeded();
      const reachable = await publish.evaluate(element => {
        const { left, top, right, bottom, width, height } = element.getBoundingClientRect();
        const hit = document.elementFromPoint(left + width / 2, top + height / 2);
        return width >= 44 && height >= 44 && left >= 0 && top >= 0
          && right <= window.innerWidth && bottom <= window.innerHeight && element.contains(hit);
      });
      assert.ok(reachable, `Publish must be reachable at ${width}px with ${size} text`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
      await capture(page, `operator-pickup-schedule-review-${width}-${size}`);
    };
    await inspect('normal');
    await withLargeText(page, () => inspect('large'), 'div, span, p, h1, h2, h3, button');
  }

  assert.equal(submissions.length, 0, 'Only confirmation may send a publication');
  assert.equal((await getAvailability()).version, initial.version);
  assert.equal((await getMenu()).version, menuBefore.version);
  await publish.click();
  await shown(page, 'Publication could not be confirmed. Retry the same schedule before making changes.');
  assert.equal(submissions.length, 1);
  assert.equal(replies[0].status, 200, 'The first request committed before Chrome lost its reply');
  const request = submissions[0];
  assert.match(request.pickupSchedule.id, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
  assert.deepEqual(request, { expectedVersion: initial.version, pickupSchedule: {
    id: request.pickupSchedule.id, date, start, end, capacity,
  } });
  const committed = replies[0].snapshot;
  assert.notEqual(committed.version, initial.version);
  const slotIds = [1, 2].map(index => `shift-${request.pickupSchedule.id}-${index}`);
  const afterLost = await getMenu();
  assert.equal(afterLost.version, committed.version, 'The publication reached the public catalog before the retry');
  await capture(page, 'operator-pickup-schedule-unconfirmed');

  await button(dialog, 'Close review').click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await schedule.getByLabel('Pickup date (Kigali)', { exact: true }).isDisabled(), true);
  assert.equal(submissions.length, 1, 'Closing review must leave the uncertain publication pending');
  await button(schedule, 'Review pending publication').click();
  await dialog.getByText(summary, { exact: true }).waitFor();
  await button(page, 'Retry publication').click();
  await shown(page, 'Published 2 pickup windows.');
  await capture(page, 'operator-pickup-schedule-published');
  assert.deepEqual(submissions, [request, request], 'A lost reply must reuse the exact request and publication id');
  assert.deepEqual(replies.map(reply => reply.status), [200, 200]);
  assert.equal(replies[1].snapshot.version, committed.version);
  assert.equal((await getAvailability()).version, committed.version);
  const publishedMenu = await getMenu();
  assert.equal(publishedMenu.version, committed.version);

  const windowTimes = slotIds.map((id, index) => ({
    id, startsAt: new Date(startsAt + index * 10 * 60 * 1000).toISOString(),
    endsAt: new Date(startsAt + (index + 1) * 10 * 60 * 1000).toISOString(),
  }));
  if (firstShift) {
    assert.deepEqual(publishedMenu.slots.map(slot => ({
      ...slot, startsAt: new Date(slot.startsAt).toISOString(), endsAt: new Date(slot.endsAt).toISOString(),
    })), windowTimes.map(slot => ({ ...slot, available: true })));
  }

  const { accessToken: token } = await send('/guest-sessions', { method: 'POST' }).then(response => response.json());
  const quote = async slotId => send('/quotes', { method: 'POST', token, data: {
    storeId: menuBefore.store.id, slotId, lines: [{ sku: product.sku, modifierIds: [], quantity: 1, unitPrice: product.price }],
  } });
  const quotes = [];
  for (const slot of windowTimes) {
    const offered = await quote(slot.id);
    assert.equal(offered.status, 200);
    const selected = await offered.json();
    assert.equal(selected.slotId, slot.id);
    assert.equal(new Date(selected.pickupStartsAt).toISOString(), slot.startsAt);
    assert.equal(new Date(selected.pickupEndsAt).toISOString(), slot.endsAt);
    quotes.push(selected.quoteId);
  }
  const placed = await send('/orders', { method: 'POST', token, key: randomUUID(), data: { quoteId: quotes[0], ...contact } });
  assert.equal(placed.status, 200);
  const order = await placed.json();
  assert.equal(order.slotId, slotIds[0]);
  assert.equal(order.status, 'awaiting_payment');
  assert.equal(order.paymentStatus, 'unpaid');
  const occupied = await quote(slotIds[0]);
  assert.equal(occupied.status, 409);
  assert.equal((await occupied.json()).code, 'slot_unavailable');
  if (firstShift) {
    assert.deepEqual((await getMenu()).slots.map(slot => [slot.id, slot.available]), [
      [slotIds[0], false],
      [slotIds[1], true],
    ]);
  }
  assert.deepEqual(errors, []);
});
