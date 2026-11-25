const assert = require('node:assert/strict');
const { mkdir, readFile } = require('node:fs/promises');
const { createServer } = require('node:http');
const { extname, resolve, sep } = require('node:path');
const { after, before, test } = require('node:test');
const { chromium } = require('playwright-core');

const root = resolve('dist');
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon',
};
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const file = resolve(root, extname(pathname) ? '.' + pathname : 'index.html');
    if (!file.startsWith(root + sep)) return response.writeHead(404).end();
    const data = await readFile(file);
    response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' }).end(data);
  } catch {
    response.writeHead(404).end();
  }
});

let browser;
let base;
before(async () => {
  await readFile(resolve(root, 'index.html'));
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  base = 'http://127.0.0.1:' + server.address().port;
  const executablePath = process.env.CRUST_CHROMIUM_EXECUTABLE;
  browser = await chromium.launch(executablePath ? { executablePath } : { channel: 'chrome' });
});
after(async () => {
  try {
    await browser?.close();
  } finally {
    if (server.listening) await new Promise(done => server.close(done));
  }
});

async function newContext(t, width = 390, height = 844) {
  const context = await browser.newContext({
    viewport: { width, height },
    isMobile: true,
    hasTouch: true,
  });
  t.after(() => context.close());
  return context;
}

async function newPage(context, setClock = true) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', item => { if (item.type() === 'error') errors.push(item.text()); });
  page.setDefaultTimeout(7500);
  if (setClock) await page.clock.setFixedTime(new Date('2026-06-15T10:02:00Z'));
  await page.goto(base);
  await shown(page, 'Double Smash');
  return { page, errors };
}

function button(page, name) {
  return page.getByRole('button', { name, exact: typeof name === 'string' });
}

async function shown(page, name) {
  await page.getByText(name, { exact: typeof name === 'string' }).filter({ visible: true }).first().waitFor();
}

async function fillCart(page) {
  await button(page, /^Double Smash,/).click();
  await button(page, /^Add to cart/).click();
  await button(page, /^View cart/).click();
}

async function reviewCheckout(page, { validatePhone = false, withKeyboard = false } = {}) {
  await button(page, 'Choose pickup time').click();
  const slot = page.getByRole('radiogroup', { name: 'Pickup time' }).getByRole('radio').first();
  if (validatePhone) await slot.press('Space');
  else await slot.click();
  assert.equal(await slot.getAttribute('aria-checked'), 'true');
  if (validatePhone) {
    await button(page, 'Review order').click();
    await shown(page, 'Enter the demo phone number shown here.');
  }
  await button(page, 'Use demo number').click();
  const review = button(page, 'Review order');
  if (withKeyboard) await review.press('Enter');
  else await review.click();
  await shown(page, 'Included tax');
}

async function confirmCheckout(page, validatePhone = false) {
  await reviewCheckout(page, { validatePhone });
  await button(page, /^Confirm 9,200 RWF/).click();
  await button(page, 'Leave payment pending').click();
  await shown(page, /This payment is being checked/);
}

function lastOrderId(page) {
  return page.evaluate(() => JSON.parse(sessionStorage.getItem('crustcaper.checkout.v1')).orderIds[0]);
}

test('guest pickup survives reload, failed payment, retry and reorder', async t => {
  const { page, errors } = await newPage(await newContext(t));
  await capture(page, '390-en-menu');
  await fillCart(page);
  await capture(page, '390-en-cart');
  await button(page, 'Add one Double Smash').click();
  await shown(page, '18,400 RWF');
  await button(page, 'Remove one Double Smash').click();
  await confirmCheckout(page, true);
  const orderId = await lastOrderId(page);
  await page.reload();
  await button(page, 'Open existing demo payment').click();
  await capture(page, '390-en-payment');
  await button(page, 'Simulate payment decline').click();
  await button(page, 'Retry demo payment').click();
  await button(page, 'Simulate successful payment').click();
  await button(page, 'Simulate preparation').click();
  await button(page, 'Simulate ready for pickup').click();
  await shown(page, 'Pickup code');
  await capture(page, '390-en-order-ready');
  await page.reload();
  await shown(page, 'Pickup code');
  assert.equal(await lastOrderId(page), orderId);
  await button(page, 'Review reorder').click();
  await button(page, 'Add these items to cart').click();
  await shown(page, '9,200 RWF');
  assert.deepEqual(errors, []);
});

test('concurrent browser tabs can recover their own orders independently', async t => {
  const context = await newContext(t);
  const first = await newPage(context);
  const second = await newPage(context, false);
  for (const { page } of [first, second]) {
    await page.bringToFront();
    await fillCart(page);
  }
  await button(second.page, 'Add one Double Smash').click();
  await shown(second.page, '18,400 RWF');
  await first.page.bringToFront();
  await first.page.reload();
  await shown(first.page, '9,200 RWF');
  assert.equal(await first.page.getByText('18,400 RWF', { exact: true }).filter({ visible: true }).count(), 0);
  await reviewCheckout(first.page);
  await second.page.bringToFront();
  await second.page.reload();
  await shown(second.page, '18,400 RWF');
  await reviewCheckout(second.page);
  await capture(second.page, '390-en-two-item-review');
  // Start both writes before switching foreground tabs to observe their results.
  await Promise.all([
    button(first.page, /^Confirm 9,200 RWF/).dispatchEvent('click'),
    button(second.page, /^Confirm 18,400 RWF/).dispatchEvent('click'),
  ]);
  for (const { page } of [first, second]) {
    await page.bringToFront();
    await button(page, 'Leave payment pending').click();
    await shown(page, /This payment is being checked/);
  }
  assert.notEqual(await lastOrderId(first.page), await lastOrderId(second.page));

  for (const { page, errors } of [first, second]) {
    await page.bringToFront();
    await page.reload();
    await button(page, 'Open existing demo payment').click();
    await button(page, 'Simulate successful payment').click();
    await shown(page, 'Paid');
    assert.deepEqual(errors, []);
  }
});

test('a legacy browser order survives migration and missing demo data permits a new order', async t => {
  const { page, errors } = await newPage(await newContext(t));
  await fillCart(page);
  await confirmCheckout(page);
  const oldOrder = await lastOrderId(page);
  await page.evaluate(() => {
    const key = 'crustcaper.demo.v1';
    localStorage.setItem(key, sessionStorage.getItem(key));
    sessionStorage.removeItem(key);
  });
  await page.reload();
  await shown(page, /This payment is being checked/);
  assert.equal(await lastOrderId(page), oldOrder);

  await page.evaluate(() => {
    sessionStorage.removeItem('crustcaper.demo.v1');
    localStorage.removeItem('crustcaper.demo.v1');
  });
  await page.goto(base);
  await fillCart(page);
  await confirmCheckout(page);
  assert.notEqual(await lastOrderId(page), oldOrder);
  assert.deepEqual(errors, []);
});

test('keyboard selection exposes its state and changing language updates the document', async t => {
  const { page, errors } = await newPage(await newContext(t, 320));
  await button(page, /^Double Smash,/).click();
  const cheese = button(page, /Extra cheese/);
  await cheese.press('Space');
  assert.equal(await cheese.getAttribute('aria-pressed'), 'true');
  await shown(page, 'Add to cart · 9,700 RWF');
  await page.goto(base + '/settings');
  const kinyarwanda = button(page, 'Kinyarwanda');
  await kinyarwanda.press('Space');
  await shown(page, 'Amagenamiterere');
  assert.equal(await page.getByText('Amagenamiterere', { exact: true }).filter({ visible: true }).count(), 1);
  await capture(page, '320-rw-settings');
  assert.equal(await kinyarwanda.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('html').getAttribute('lang'), 'rw');
  await page.goto(base);
  await shown(page, 'Ifunguro');
  for (const name of ['Burgeri', 'Amafunguro', 'Ibyunganira', 'Ibinyobwa']) {
    const bounds = await button(page, name).boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 320 && bounds.height >= 48,
      `${name} must fit the narrow screen with a touch-sized target`);
  }
  await capture(page, '320-rw-menu');
  await button(page, 'Ibinyobwa').tap();
  await shown(page, 'Ikinyobwa kidasembuye');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 320);
  await page.setViewportSize({ width: 430, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 430);
  assert.deepEqual(errors, []);
});


async function capture(page, name) {
  const directory = process.env.CRUST_SCREENSHOT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, `${name}.png`), animations: 'disabled' });
}

test('checkout displays review above the fold before enabling confirmation on a short screen', async t => {
  const { page, errors } = await newPage(await newContext(t, 320, 640));
  await fillCart(page);
  await reviewCheckout(page, { withKeyboard: true });
  const heading = page.getByText('Review your order', { exact: true });
  const visible = await heading.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom < window.innerHeight;
  });
  assert.equal(visible, true, 'The review heading must be visible without scrolling past the form');
  assert.equal(await heading.evaluate(element => element === document.activeElement), true);
  assert.equal(await page.getByLabel('Demo phone number').filter({ visible: true }).count(), 0);
  await capture(page, '320-en-order-review');
  await button(page, 'Edit pickup or contact').press('Enter');
  await page.getByLabel('Demo phone number').waitFor({ state: 'visible' });
  assert.equal(await page.getByText('Pickup order', { exact: true }).evaluate(element => element === document.activeElement), true);
  assert.match(await page.getByLabel('Demo phone number').inputValue(), /250 700/);
  assert.deepEqual(errors, []);
});

test('pickup time can be selected with arrow keys without adding tab stops', async t => {
  const { page, errors } = await newPage(await newContext(t));
  await fillCart(page);
  await button(page, 'Choose pickup time').click();
  const radios = page.getByRole('radiogroup', { name: 'Pickup time' }).getByRole('radio');
  const first = radios.first();
  await first.press('ArrowDown');
  const second = radios.nth(1);
  assert.equal(await second.getAttribute('aria-checked'), 'true');
  assert.equal(await second.evaluate(element => element === document.activeElement), true);
  assert.equal(await first.getAttribute('tabindex'), '-1');
  assert.deepEqual(errors, []);
});


test('expired review keeps the cart and requires a new quote', async t => {
  const { page, errors } = await newPage(await newContext(t, 320, 640));
  await fillCart(page);
  await reviewCheckout(page);
  await page.clock.setFixedTime(new Date('2026-06-15T10:09:00Z'));
  await button(page, /^Confirm 9,200 RWF/).click();
  await shown(page, 'Your quote changed or expired. Review the order again.');
  assert.equal(await lastOrderId(page), undefined);
  await page.goto(base + '/cart');
  await shown(page, '9,200 RWF');
  assert.deepEqual(errors, []);
});

test('damaged demo journal recovers its pending payment without a new order', async t => {
  const { page, errors } = await newPage(await newContext(t));
  await fillCart(page);
  await confirmCheckout(page);
  const orderId = await lastOrderId(page);
  await page.evaluate(() => sessionStorage.setItem('crustcaper.checkout.v1', '{'));
  await page.reload();
  await shown(page, /This payment is being checked/);
  assert.equal(await lastOrderId(page), orderId);
  await button(page, 'Open existing demo payment').click();
  await button(page, 'Simulate successful payment').click();
  await shown(page, 'Paid');
  assert.equal(await lastOrderId(page), orderId);
  assert.deepEqual(errors, []);
});
