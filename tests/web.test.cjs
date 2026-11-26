const assert = require('node:assert/strict');
const { mkdir, readFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const { after, before, test } = require('node:test');
const { chromium } = require('playwright-core');
const { createPreviewServer } = require('../tooling/preview-server.cjs');

const root = resolve('dist');
const server = createPreviewServer(root);

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

async function newPage(context, clock = 'fixed') {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push({ kind: 'page', message: error.message }));
  page.on('console', item => {
    if (item.type() === 'error') errors.push({ kind: 'console', message: item.text(), url: item.location().url });
  });
  page.setDefaultTimeout(7500);
  const demoTime = new Date('2026-06-15T10:02:00Z');
  if (clock === 'fixed') await page.clock.setFixedTime(demoTime);
  if (clock === 'installed') await page.clock.install({ time: demoTime });
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

const draftStorageKey = 'crustcaper.draft.v1';

function savedCartQuantity(page) {
  return page.evaluate(key => JSON.parse(sessionStorage[key]).cart[0].quantity, draftStorageKey);
}

test('rapid quantity changes accumulate while respecting the cart limit', async t => {
  const { page, errors } = await newPage(await newContext(t));
  await fillCart(page);
  const add = button(page, 'Add one Double Smash');
  const remove = button(page, 'Remove one Double Smash');
  await add.evaluate(element => { element.click(); element.click(); });
  await shown(page, '27,600 RWF');
  assert.equal(await savedCartQuantity(page), 3);
  await add.evaluate(element => { for (let press = 0; press < 12; press++) element.click(); });
  await shown(page, '82,800 RWF');
  assert.equal(await add.isDisabled(), true);
  await remove.evaluate(element => { element.click(); element.click(); });
  await shown(page, '64,400 RWF');
  assert.equal(await savedCartQuantity(page), 7);
  assert.deepEqual(errors, []);
});

test('a failed cart read keeps saved data and can recover without reloading', async t => {
  const { page, errors } = await newPage(await newContext(t, 320, 568));
  await fillCart(page);
  assert.equal(await savedCartQuantity(page), 1);
  await page.addInitScript(key => {
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (name) {
      if (this === sessionStorage && name === key && !window.allowDraftRead) {
        throw new DOMException('Injected cart read failure', 'SecurityError');
      }
      return getItem.call(this, name);
    };
  }, draftStorageKey);
  await page.reload();
  await shown(page, 'Your saved cart could not be opened.');
  assert.equal(await page.getByText('Your cart is empty', { exact: true }).count(), 0);
  assert.equal(await page.getByText('Opening cart…', { exact: true }).count(), 0);
  assert.equal(await savedCartQuantity(page), 1);
  await capture(page, '320-en-cart-read-failure');

  await page.evaluate(() => localStorage.setItem('crustcaper.locale.v1', 'rw'));
  await page.reload();
  await shown(page, 'Agatebo kawe kabitswe ntikashoboye gufunguka.');
  assert.equal(await savedCartQuantity(page), 1);
  await capture(page, '320-rw-cart-read-failure');

  await page.evaluate(() => { window.allowDraftRead = true; });
  await button(page, 'Ongera ugerageze kubika agatebo').click();
  await button(page, 'Ongeramo imwe muri Double Smash').waitFor();
  await page.getByRole('alert').filter({ hasText: 'Agatebo kawe kabitswe ntikashoboye gufunguka.' }).waitFor({ state: 'hidden' });
  assert.equal(await savedCartQuantity(page), 1);
  assert.deepEqual(errors, []);
});

test('an unsaved cart write is shown and retry persists the latest cart', async t => {
  const { page, errors } = await newPage(await newContext(t));
  await fillCart(page);
  await page.evaluate(key => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (this === sessionStorage && name === key && !window.allowDraftWrite) {
        throw new DOMException('Injected cart write failure', 'QuotaExceededError');
      }
      return setItem.call(this, name, value);
    };
  }, draftStorageKey);
  await button(page, 'Add one Double Smash').click();
  await shown(page, 'Your cart changes are unsaved. Keep this screen open and retry.');
  assert.equal(await button(page, 'Choose pickup time').isDisabled(), true);
  await button(page, 'Add one Double Smash').click();
  await shown(page, '27,600 RWF');
  assert.equal(await savedCartQuantity(page), 1);
  await capture(page, '390-en-cart-write-failure');

  await page.evaluate(() => { window.allowDraftWrite = true; });
  await button(page, 'Retry cart storage').click();
  await page.getByRole('alert').filter({ hasText: 'Your cart changes are unsaved.' }).waitFor({ state: 'hidden' });
  assert.equal(await button(page, 'Choose pickup time').isEnabled(), true);
  assert.equal(await savedCartQuantity(page), 3);
  await page.reload();
  await shown(page, '27,600 RWF');
  assert.deepEqual(errors, []);
});

function lastOrderId(page) {
  return page.evaluate(() => JSON.parse(sessionStorage.getItem('crustcaper.checkout.v1'))?.orderIds[0]);
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
  await shown(page, 'Order accepted');
  assert.equal(await page.getByText('Pickup code', { exact: true }).count(), 0);
  await button(page, 'Simulate preparation').click();
  await button(page, 'Simulate ready for pickup').click();
  await shown(page, 'Pickup code');
  await capture(page, '390-en-order-ready');
  await page.reload();
  await shown(page, 'Pickup code');
  assert.equal(await lastOrderId(page), orderId);
  await button(page, 'Simulate pickup').click();
  await shown(page, 'Picked up');
  assert.equal(await page.getByText('Pickup code', { exact: true }).count(), 0);
  await button(page, 'Review reorder').click();
  await button(page, 'Add these items to cart').click();
  await shown(page, '9,200 RWF');
  assert.deepEqual(errors, []);
});

test('concurrent browser tabs can recover their own orders independently', async t => {
  const context = await newContext(t);
  const first = await newPage(context);
  const second = await newPage(context, 'system');
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

async function isInViewport(locator) {
  return locator.evaluate(element => {
    const { left, right, top, bottom } = element.getBoundingClientRect();
    if (left < 0 || top < 0 || right > window.innerWidth || bottom > window.innerHeight) return false;
    return element.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2));
  });
}

async function doubleVisibleText(page) {
  await page.evaluate(() => {
    const textElements = [...document.querySelectorAll('div, span, p, h1, h2, h3')].flatMap(element => {
      if (element.children.length || !element.textContent.trim() || element.closest('[aria-hidden=true], [hidden]')) return [];
      const { fontSize, lineHeight } = getComputedStyle(element);
      return [{ element, fontSize: parseFloat(fontSize), lineHeight: parseFloat(lineHeight) }];
    });
    for (const { element, fontSize, lineHeight } of textElements) {
      element.style.fontSize = `${fontSize * 2}px`;
      if (Number.isFinite(lineHeight)) element.style.lineHeight = `${lineHeight * 2}px`;
    }
  });
}

test('opening settings directly still provides a path back to the menu', async t => {
  const context = await newContext(t, 320);
  const page = await context.newPage();
  await page.goto(base + '/settings');
  await shown(page, 'Settings');
  await page.getByRole('link', { name: 'Menu, back', exact: true }).click();
  await shown(page, 'Double Smash');
});

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

test('checkout amounts fit the narrow Kinyarwanda screen at 200% text size', async t => {
  const { page, errors } = await newPage(await newContext(t, 320, 568));
  await button(page, /^Double Smash,/).click();
  await button(page, /Extra cheese/).click();
  await button(page, 'Add to cart · 9,700 RWF').click();
  await page.goto(base + '/settings');
  await button(page, 'Kinyarwanda').click();
  await shown(page, 'Amagenamiterere');
  await page.goto(base + '/checkout');
  await shown(page, 'Igiteranyo cy’agateganyo');
  await doubleVisibleText(page);
  const amounts = page.getByText('9,700 RWF', { exact: true }).filter({ visible: true });
  assert.equal(await amounts.count(), 2);
  const allFit = await amounts.evaluateAll(elements => elements.every(element => {
    const text = document.createRange();
    text.selectNodeContents(element);
    const { left, right } = text.getBoundingClientRect();
    return parseFloat(getComputedStyle(element).fontSize) >= 32
      && left >= 0 && right <= document.documentElement.clientWidth;
  }));
  assert.equal(allFit, true);
  assert.deepEqual(errors, []);
});

test('menu header controls and tab labels remain usable at 200% text size', async t => {
  const { page, errors } = await newPage(await newContext(t, 320, 568));
  await page.goto(base + '/settings');
  await button(page, 'Kinyarwanda').click();
  await shown(page, 'Amagenamiterere');
  await page.goto(base);
  await shown(page, 'Ifunguro');
  await doubleVisibleText(page);
  const wordmark = page.getByText('CrustCaper', { exact: true });
  assert.equal(await wordmark.evaluate(element => getComputedStyle(element).fontSize), '42px');
  const wordmarkBox = await wordmark.boundingBox();
  const languageBox = await button(page, 'Guhitamo ururimi').boundingBox();
  assert.ok(wordmarkBox && languageBox && wordmarkBox.x + wordmarkBox.width <= languageBox.x);
  for (const name of ['Ifunguro', 'Komande', 'Kwakira']) {
    const label = page.getByRole('tab', { name, exact: true }).getByText(name, { exact: true });
    const fits = await label.evaluate(element => {
      const text = document.createRange();
      text.selectNodeContents(element);
      const tabBottom = element.closest('[role=tab]').getBoundingClientRect().bottom;
      const limit = Math.min(tabBottom, document.documentElement.clientHeight);
      return getComputedStyle(element).fontSize === '24px' && text.getBoundingClientRect().bottom <= limit + 1;
    });
    assert.ok(fits, name);
  }
  await capture(page, '320-rw-menu-enlarged');
  assert.deepEqual(errors, []);
});


test('an expired quote keeps the selected future pickup window and requires a new review', async t => {
  const { page, errors } = await newPage(await newContext(t, 320, 568), 'installed');
  await fillCart(page);
  await reviewCheckout(page);
  const ledger = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('crustcaper.demo.v1')));
  const before = await ledger();
  const [originalQuote] = before.quotes;
  const afterQuoteExpiry = Date.parse(originalQuote.expiresAt) + 1_000;
  assert.ok(afterQuoteExpiry < Date.parse(originalQuote.pickupStartsAt), 'Only the quote must reach its deadline');
  const jump = afterQuoteExpiry - await page.evaluate(() => Date.now());
  assert.ok(jump > 0);
  await page.clock.fastForward(jump);

  const alert = page.getByRole('alert').filter({ hasText: 'Your quote changed or expired. Review the order again.' });
  await alert.waitFor({ state: 'visible' });
  assert.equal(await isInViewport(alert), true, 'Checkout must surface expiration without scrolling');
  assert.equal(await button(page, /^Confirm 9,200 RWF/).count(), 0);
  const selection = page.getByRole('radiogroup', { name: 'Pickup time' }).getByRole('radio', { checked: true });
  assert.equal(await selection.count(), 1);
  assert.equal(await selection.isEnabled(), true);
  assert.equal(await page.getByLabel('Demo phone number', { exact: true }).inputValue(), '+250 700 000 000');
  assert.equal(await savedCartQuantity(page), 1);
  assert.equal(await lastOrderId(page), undefined);
  assert.deepEqual(await ledger(), before);

  await button(page, 'Review order').click();
  await shown(page, 'Included tax');
  const renewed = await ledger();
  assert.deepEqual(renewed.orders, []);
  assert.equal(renewed.quotes.length, 1);
  assert.notEqual(renewed.quotes[0].id, originalQuote.id);
  assert.equal(renewed.quotes[0].slotId, originalQuote.slotId);
  assert.deepEqual(renewed.quotes[0].lines, originalQuote.lines);
  assert.deepEqual(errors, []);
});

test('a failed quote write shows an actionable error, retains the cart and allows a retry', async t => {
  const { page, errors } = await newPage(await newContext(t, 320, 568));
  await fillCart(page);
  await button(page, 'Choose pickup time').click();
  await page.getByRole('radiogroup', { name: 'Pickup time' }).getByRole('radio').first().click();
  await button(page, 'Use demo number').click();
  await page.evaluate(() => {
    const setItem = Storage.prototype.setItem;
    window.restoreStorageForTest = () => { Storage.prototype.setItem = setItem; };
    Storage.prototype.setItem = function (key, value) {
      if (this === sessionStorage && key === 'crustcaper.demo.v1') throw new DOMException('Fixture quota', 'QuotaExceededError');
      return setItem.call(this, key, value);
    };
  });
  await button(page, 'Review order').click();
  const alert = page.getByRole('alert');
  await alert.waitFor();
  assert.equal(await isInViewport(alert), true, 'A customer needs to see why checkout stayed on the form');
  assert.equal(await alert.textContent(), 'Saved checkout data is unavailable. Try again.');
  assert.equal(await lastOrderId(page), undefined);
  await page.evaluate(() => window.restoreStorageForTest());
  await button(page, 'Review order').click();
  await button(page, /^Confirm 9,200 RWF/).click();
  await button(page, 'Simulate successful payment').click();
  await shown(page, 'Paid');
  assert.deepEqual(errors, []);
});

test('offline demo keeps the same amount through cart, quote, payment and the persisted order after repeated confirmation', async t => {
  const context = await newContext(t, 430, 820);
  const { page, errors } = await newPage(context);
  await button(page, /^Double Smash,/).click();
  await button(page, /Extra cheese/).click();
  await button(page, 'Add to cart · 9,700 RWF').click();
  await button(page, /^View cart/).click();
  await button(page, 'Add one Double Smash').click();
  await shown(page, '19,400 RWF');
  const failedRequests = [];
  page.on('requestfailed', request => failedRequests.push(request));
  await context.setOffline(true);
  try {
    await page.evaluate(() => new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => reject(new Error('The uncached offline fixture unexpectedly loaded'));
      image.onerror = resolve;
      image.src = '/favicon.ico?offline-fixture';
    }));
    await reviewCheckout(page);
    const confirm = button(page, /^Confirm 19,400 RWF/);
    await confirm.evaluate(element => { element.click(); element.click(); });
    await shown(page, '19,400 RWF');
    await button(page, 'Simulate successful payment').click();
    await shown(page, 'Paid');
    await shown(page, '19,400 RWF');
    const ledger = await page.evaluate(() => JSON.parse(sessionStorage.getItem('crustcaper.demo.v1')));
    assert.equal(ledger.orders.length, 1);
    assert.equal(ledger.orders[0].attempts.length, 1);
    assert.equal(ledger.orders[0].order.total, 19400);
    assert.deepEqual(ledger.orders[0].order.lines, [{ sku: 'double-smash', modifierIds: ['extra-cheese'], quantity: 2, unitPrice: 9700 }]);
    // An uncached image or font can fail offline, but ordering must not need a network request.
    const optionalAssetUrls = new Set(failedRequests.filter(request =>
      new URL(request.url()).origin === base
      && ['image', 'font'].includes(request.resourceType())
      && request.failure()?.errorText === 'net::ERR_INTERNET_DISCONNECTED').map(request => request.url()));
    assert.ok(optionalAssetUrls.has(`${base}/favicon.ico?offline-fixture`));
    assert.deepEqual(failedRequests.filter(request => !optionalAssetUrls.has(request.url())).map(request => request.url()), []);
    // Chromium can fetch the browser tab icon without emitting a Playwright page request.
    optionalAssetUrls.add(`${base}/favicon.ico`);
    assert.deepEqual(errors.filter(error => error.kind !== 'console'
      || error.message !== 'Failed to load resource: net::ERR_INTERNET_DISCONNECTED'
      || !optionalAssetUrls.has(error.url)), []);
  } finally {
    await context.setOffline(false);
  }
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
  await page.evaluate(() => sessionStorage.removeItem('crustcaper.checkout.v1'));
  await page.reload();
  await shown(page, /This payment is being checked/);
  assert.equal(await lastOrderId(page), orderId);
  const orderCount = await page.evaluate(() => JSON.parse(sessionStorage.getItem('crustcaper.demo.v1')).orders.length);
  assert.equal(orderCount, 1);
  await button(page, 'Open existing demo payment').click();
  await button(page, 'Simulate successful payment').click();
  await shown(page, 'Paid');
  assert.equal(await lastOrderId(page), orderId);
  assert.deepEqual(errors, []);
});

test('a late payment requires a refund and does not produce a pickup code after reload', async t => {
  const { page, errors } = await newPage(await newContext(t));
  await fillCart(page);
  await confirmCheckout(page);
  const orderId = await lastOrderId(page);
  await page.clock.setFixedTime(new Date('2026-06-15T10:11:00Z'));
  await page.reload();
  await shown(page, 'Order cancelled');
  await button(page, 'Open existing demo payment').click();
  await button(page, 'Simulate successful payment').click();
  await shown(page, 'Refund pending');
  await page.reload();
  await shown(page, 'Refund pending');
  assert.equal(await lastOrderId(page), orderId);
  assert.equal(await page.getByText('Pickup code', { exact: true }).count(), 0);
  assert.equal(await button(page, 'Simulate preparation').count(), 0);
  assert.deepEqual(errors, []);
});
