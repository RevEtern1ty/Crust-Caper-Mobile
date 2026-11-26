const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

const storefront = 'https://crustcaper.test';
const hostedOrigin = 'https://checkout.flutterwave.com';
const web = '/api/v1/web';
const originHeaders = { Origin: storefront, 'X-CrustCaper-Web': '1' };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const guestCookie = /^__Host-crustcaper-web=[A-Za-z0-9_-]+$/;
const loadSlot = /^fixture-load-[0-7]$/;
const capacitySlot = 'fixture-capacity';
const capacity = 4;
const contenders = 12;

function ensure(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}

async function openFixtureWebGuest(request) {
  const session = await request(web + '/session', { method: 'POST', headers: originHeaders });
  const issued = session.headers?.['set-cookie'];
  const parts = Array.isArray(issued) && issued.length === 1 && typeof issued[0] === 'string'
    ? issued[0].split(/;\s*/) : [];
  const [cookie, ...attributes] = parts;
  const cookiePolicy = ['secure', 'httponly', 'samesite=lax', 'path=/'];
  const attributesLower = attributes.map(value => value.toLowerCase());
  ensure(session.status === 200 && uuid.test(session.data?.sessionId)
    && guestCookie.test(cookie) && cookiePolicy.every(value => attributesLower.includes(value))
    && !attributesLower.some(value => value.startsWith('domain=')), 'checkout_session');

  return { ...originHeaders, Cookie: cookie, 'X-CrustCaper-Session': session.data.sessionId };
}

async function prepareOrder(request, menu, slotId, guest) {
  const product = menu.products.find(item => item.available && Number.isSafeInteger(item.price) && item.price > 0);
  ensure(menu.store?.open && product && menu.slots.some(slot => slot.id === slotId && slot.available), 'checkout_catalog');

  const headers = guest ?? await openFixtureWebGuest(request);
  const storeId = menu.store.id;
  const quoteResponse = await request(web + '/quotes', {
    method: 'POST', headers, body: { storeId, slotId, lines: [{
      sku: product.sku, modifierIds: [], quantity: 1, unitPrice: product.price,
    }] },
  });
  const quote = quoteResponse.data;
  ensure(quoteResponse.status === 200 && uuid.test(quote?.quoteId)
    && quote.storeId === storeId && quote.slotId === slotId && quote.total === product.price
    && quote.currency === 'RWF' && Array.isArray(quote.changes) && quote.changes.length === 0, 'checkout_quote');

  const orderHeaders = { ...headers, 'Idempotency-Key': randomUUID() };
  const body = { quoteId: quote.quoteId, phone: '+250700000000', email: 'load-fixture@example.test' };
  return {
    headers,
    quote,
    place: metric => request(web + '/orders', { method: 'POST', headers: orderHeaders, body, metric }),
    recover: () => request(web + '/orders/recovery', { headers: orderHeaders }),
  };
}

function matchesQuote(order, quote) {
  return order?.storeId === quote.storeId && order.slotId === quote.slotId
    && order.total === quote.total && order.tax === quote.tax && order.currency === quote.currency;
}

function placedOrder(response, quote) {
  const order = response.data;
  ensure(response.status === 200 && uuid.test(order?.id) && matchesQuote(order, quote)
    && order.status === 'awaiting_payment' && order.paymentStatus === 'unpaid', 'checkout_order');
  return order;
}

async function readPaidOrder(request, orderPath, headers, orderId, quote, attemptId, { paymentWaitMs, signal }) {
  // The reconciler can claim a verification just before the hosted payment settles.
  const deadline = performance.now() + paymentWaitMs;
  do {
    const { status, data } = await request(orderPath, { headers });
    ensure(status === 200 && data?.id === orderId && matchesQuote(data, quote)
      && data.paymentAttempt?.id === attemptId, 'checkout_payment_read');
    if (data.paymentStatus === 'paid') {
      ensure(data.status === 'accepted' && data.paymentAttempt.status === 'paid'
        && /^\d{6}$/.test(data.pickupCode), 'checkout_paid_state');
      return data;
    }
    ensure(data.status === 'awaiting_payment' && data.paymentStatus === 'processing'
      && data.paymentAttempt.status === 'processing', 'checkout_payment_state');
    await delay(1000, undefined, { signal });
  } while (performance.now() < deadline);
  ensure(false, 'checkout_payment_timeout');
}

async function prepareHostedCheckout({ request, menu, slotId, guest, signal, paymentWaitMs = 20_000 }) {
  const { quote, headers, place, recover } = await prepareOrder(request, menu, slotId, guest);
  const [first, replay] = await Promise.all([place('order_create'), place('order_replay')]);
  const placed = placedOrder(first, quote);
  const { id: orderId } = placed;
  ensure(placedOrder(replay, quote).id === orderId, 'checkout_order_replay');

  const orderPath = web + '/orders/' + orderId;
  const paymentHeaders = { ...headers, 'Idempotency-Key': randomUUID() };
  const startPayment = () => request(orderPath + '/payments', { method: 'POST', headers: paymentHeaders });
  const results = await Promise.all([startPayment(), startPayment()]);
  const attemptId = results[0].data?.id;
  ensure(uuid.test(attemptId) && results.every(({ status, data }) => status === 200
    && data?.id === attemptId && data.status === 'processing'), 'checkout_payment_replay');

  const hostedPath = '/v3/hosted/pay/' + attemptId;
  const links = results.map(({ data }) => data.checkoutUrl).filter(link => link != null);
  ensure(links.length > 0 && links.every(link => link === hostedOrigin + hostedPath), 'checkout_hosted_link');
  return {
    order: { orderId, quoteId: quote.quoteId, attemptId, total: quote.total, slotId },
    placed,
    guest: headers,
    readOrder: () => request(orderPath, { headers }),
    recoverOrder: recover,
    repeatPayment: startPayment,
    async settleHosted() {
      const paid = await request(hostedPath, {
        method: 'POST', route: 'hosted', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'result=pay',
      });
      const returnUrl = storefront + '/web-payment-return?orderId=' + orderId + '&status=successful&transaction_id=1';
      ensure(paid.status === 303 && paid.headers?.location === returnUrl, 'checkout_hosted_return');
    },
    waitForPaid: () => readPaidOrder(request, orderPath, headers, orderId, quote, attemptId, { paymentWaitMs, signal }),
  };
}

async function beginCheckout(options) {
  const { order, settleHosted, waitForPaid } = await prepareHostedCheckout(options);
  await settleHosted();
  return { order, waitForPaid };
}

async function runCheckout({ request, index, menu }) {
  const slotId = 'fixture-load-' + (index % 8);
  const checkout = await beginCheckout({ request, menu, slotId });
  await checkout.waitForPaid();
  return checkout.order;
}

function fixtureRows(project, sql) {
  const prefix = 'cc-storefront-';
  ensure(typeof project === 'string' && project === process.env.CRUSTCAPER_HTTPS_TEST_DOCKER_PROJECT
    && project.startsWith(prefix) && uuid.test(project.slice(prefix.length)), 'checkout_db_project');
  const options = { encoding: 'utf8', timeout: 10000, windowsHide: true };
  const database = spawnSync('docker', ['ps', '--format', '{{.ID}}',
    '--filter', 'label=com.docker.compose.project=' + project,
    '--filter', 'label=com.docker.compose.service=postgres',
  ], options);
  const container = database.stdout?.trim();
  ensure(database.status === 0 && /^[0-9a-f]{12,64}$/.test(container), 'checkout_db_container');
  const result = spawnSync('docker', ['exec', container, 'psql', '-XAt', '-v', 'ON_ERROR_STOP=1',
    '-U', 'storefront_fixture', '-d', 'storefront_fixture', '-c', sql,
  ], options);
  ensure(result.status === 0, 'checkout_db_query');
  const output = result.stdout.trim();
  return output ? output.split(/\r?\n/).map(row => row.split('|')) : [];
}

function verifyPersisted({ project, orders }) {
  const expected = new Map(orders.map(order => [order.orderId, order]));
  ensure(orders.length > 0 && expected.size === orders.length && orders.every(order => loadSlot.test(order.slotId)),
    'checkout_order_distinct');
  const rows = fixtureRows(project, `
    SELECT o.id, o.quote_id, o.slot_id, o.total, o.status, o.payment_status, o.checkout_channel,
      p.id, p.status, (p.provider_transaction_id IS NOT NULL)
    FROM orders o LEFT JOIN payment_attempts p ON p.order_id = o.id
    WHERE o.slot_id ~ '^fixture-load-[0-7]$'`);
  ensure(rows.length === expected.size, 'checkout_db_count');
  for (const [id, quoteId, slotId, total, status, paymentStatus, channel, attemptId, attemptStatus, verified] of rows) {
    const order = expected.get(id);
    ensure(order && quoteId === order.quoteId && slotId === order.slotId && total === String(order.total)
      && status === 'accepted' && paymentStatus === 'paid' && channel === 'web'
      && attemptId === order.attemptId && attemptStatus === 'paid' && verified === 't', 'checkout_db_row');
    expected.delete(id);
  }
  ensure(expected.size === 0, 'checkout_db_missing');
  return { orders: rows.length, paidAttempts: rows.length };
}

async function runCapacityWave({ request, menu, project }) {
  const intents = await Promise.all(Array.from({ length: contenders }, () => prepareOrder(request, menu, capacitySlot)));
  const attempts = await Promise.all(intents.map(async ({ place, quote }) => {
    const response = await place('capacity_order');
    if (response.status === 409 && response.data?.code === 'slot_unavailable') return null;
    const order = placedOrder(response, quote);
    return [order.id, quote.quoteId];
  }));
  const accepted = attempts.filter(Boolean);
  const expected = new Map(accepted);
  ensure(accepted.length === capacity && expected.size === capacity, 'checkout_capacity');
  const rows = fixtureRows(project, `
    SELECT o.id, o.quote_id, o.checkout_channel, o.status, o.payment_status, count(p.id)
    FROM orders o LEFT JOIN payment_attempts p ON p.order_id = o.id
    WHERE o.slot_id = 'fixture-capacity' GROUP BY o.id`);
  ensure(rows.length === capacity, 'checkout_capacity_db_count');
  for (const [id, quoteId, channel, status, paymentStatus, paymentAttempts] of rows) {
    ensure(expected.get(id) === quoteId && channel === 'web' && status === 'awaiting_payment'
      && paymentStatus === 'unpaid' && paymentAttempts === '0', 'checkout_capacity_db_row');
    expected.delete(id);
  }
  ensure(expected.size === 0, 'checkout_capacity_db_missing');
  return { offered: contenders, accepted: accepted.length, rejected: contenders - accepted.length };
}

module.exports = { beginCheckout, prepareHostedCheckout, runCheckout, verifyPersisted, runCapacityWave };
