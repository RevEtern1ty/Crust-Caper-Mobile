import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { checkAvailability, watchAvailability } from './storefront-availability.mjs';

const origin = 'https://storefront.fixture.test';
const apiBaseUrl = origin + '/api/v1';
const menuPath = '/api/v1/stores/kigali/menu';
const queuePath = '/api/v1/operator/orders';
const operatorPath = '/operator/index.html';
const privateFixture = 'private-fixture-contents';
const routes = [menuPath, '/menu/en', '/menu/rw', operatorPath, queuePath];
const checkNames = ['menu_api', 'menu_en', 'menu_rw', 'operator_shell', 'operator_auth'];

function menu(overrides = {}) {
  return Response.json({ version: 'catalog-1', store: { id: 'kigali', open: true },
    products: [], slots: [], ...overrides });
}

function document(locale, content, headers = {}, status = 200) {
  return new Response(`<!doctype html><html lang="${locale}"><head><title>CrustCaper</title></head><body>${content}</body></html>`, {
    status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  });
}

function renderedMenu(locale, headers = {}, status = 200) {
  return document(locale, '<main id="main"><h1>Catalog</h1></main>', {
    'content-language': locale, 'x-crustcaper-store-id': 'kigali', 'x-crustcaper-catalog-version': 'catalog-1', ...headers,
  }, status);
}

function operatorShell() {
  return document('en', '<main><form id="login-form"><input name="username">'
    + '<input name="password" type="password"><input name="authenticatorCode"></form></main>');
}

function authProblem(body = { status: 401, code: 'unauthenticated' }, challenge = 'Bearer') {
  return new Response(JSON.stringify(body), { status: 401,
    headers: { 'content-type': 'application/problem+json', 'www-authenticate': challenge } });
}

function fixture(overrides = {}) {
  const handlers = { [menuPath]: menu, '/menu/en': () => renderedMenu('en'), '/menu/rw': () => renderedMenu('rw'),
    [operatorPath]: operatorShell, [queuePath]: authProblem, ...overrides };
  const requests = [];
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    requests.push({ url, options });
    assert.equal(url.origin, origin);
    assert.ok(Object.hasOwn(handlers, url.pathname), `unexpected request ${url.pathname}`);
    return handlers[url.pathname]();
  };
  return { requests, run: () => checkAvailability({ apiBaseUrl, storeId: 'kigali', fetchImpl }) };
}

function byCheck(report, name) {
  const check = report.checks.find(item => item.check === name);
  assert.ok(check, `missing ${name}`);
  return check;
}

function failed(report, name, status, code) {
  assert.equal(report.ok, false);
  const check = byCheck(report, name);
  assert.equal(check.ok, false);
  assert.equal(check.status, status);
  if (code) assert.equal(check.code, code);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(privateFixture));
}

test('healthy probe checks the actual public and unauthenticated operator routes with read-only requests', async () => {
  const subject = fixture();
  const report = await subject.run();
  assert.equal(report.ok, true);
  assert.equal(report.orderingOpen, true);
  assert.deepEqual(report.checks.map(item => item.check), checkNames);
  assert.deepEqual(report.checks.map(item => item.status), [200, 200, 200, 200, 401]);
  for (const item of report.checks) {
    assert.equal(item.ok, true);
    assert.equal(item.code, 'ok');
    assert.ok(Number.isFinite(item.elapsedMs) && item.elapsedMs >= 0);
  }
  assert.deepEqual(subject.requests.map(({ url }) => url.pathname).sort(), [...routes].sort());
  for (const { url, options } of subject.requests) {
    assert.equal(options.method ?? 'GET', 'GET');
    assert.equal(options.body, undefined);
    assert.ok(['manual', 'error'].includes(options.redirect));
    const headers = new Headers(options.headers);
    assert.equal(headers.has('authorization'), false);
    assert.equal(headers.has('cookie'), false);
    assert.equal(headers.has('idempotency-key'), false);
    assert.equal(url.username + url.password, '');
  }
  const menuRequest = subject.requests.find(({ url }) => url.pathname === menuPath).url;
  assert.equal(menuRequest.searchParams.get('channel'), 'web');
});

test('a paused catalog with no available products or slots is healthy across a version change', async () => {
  const subject = fixture({
    [menuPath]: () => menu({ store: { id: 'kigali', open: false }, products: [], slots: [] }),
    '/menu/en': () => renderedMenu('en', { 'x-crustcaper-catalog-version': 'catalog-2' }),
    '/menu/rw': () => renderedMenu('rw', { 'x-crustcaper-catalog-version': 'catalog-3' }),
  });
  const report = await subject.run();
  assert.equal(report.ok, true);
  assert.equal(report.orderingOpen, false);
  assert.ok(report.checks.every(item => item.ok));
});

test('a live menu API does not hide unavailable or incorrect localized pages', async () => {
  const subject = fixture({
    '/menu/en': () => renderedMenu('en', {}, 503),
    '/menu/rw': () => renderedMenu('rw', { 'content-language': 'en' }),
  });
  const report = await subject.run();
  assert.equal(report.orderingOpen, true);
  assert.equal(byCheck(report, 'menu_api').ok, true);
  failed(report, 'menu_en', 503, 'http_status');
  failed(report, 'menu_rw', 200, 'locale_mismatch');
  assert.equal(byCheck(report, 'operator_auth').ok, true);
});

test('malformed or wrong-store API data leaves ordering state unknown', async t => {
  for (const [name, response, code] of [
    ['incorrect store', () => menu({ store: { id: 'wrong-store', open: true } }), 'store_mismatch'],
    ['invalid ordering flag', () => menu({ store: { id: 'kigali', open: 'true' } }), 'menu_shape'],
    ['invalid catalog list', () => menu({ products: {} }), 'menu_shape'],
    ['invalid JSON', () => new Response(`{${privateFixture}`, { headers: { 'content-type': 'application/json' } }), 'invalid_body'],
    ['HTML impostor', () => document('en', `<main>${privateFixture}</main>`), 'media_type'],
  ]) {
    await t.test(name, async () => {
      const report = await fixture({ [menuPath]: response }).run();
      failed(report, 'menu_api', 200, code);
      assert.equal(report.orderingOpen, null);
    });
  }
});

test('HTML 200 cannot stand in for a catalog or the real staff sign-in shell', async () => {
  const report = await fixture({
    '/menu/en': () => renderedMenu('en', { 'x-crustcaper-store-id': 'wrong-store' }),
    '/menu/rw': () => renderedMenu('rw', { 'x-crustcaper-catalog-version': '' }),
    [operatorPath]: () => document('en', `<main>${privateFixture}</main>`),
  }).run();
  failed(report, 'menu_en', 200, 'store_mismatch');
  failed(report, 'menu_rw', 200, 'catalog_version');
  failed(report, 'operator_shell', 200, 'operator_shell');
  const brandedError = await fixture({ '/menu/en': () => document('en', '<div>Proxy error</div>', {
    'content-language': 'en', 'x-crustcaper-store-id': 'kigali', 'x-crustcaper-catalog-version': 'catalog-1',
  }) }).run();
  failed(brandedError, 'menu_en', 200);
});

test('operator API health requires refusal with a genuine Bearer challenge', async t => {
  for (const [name, response, status, code] of [
    ['unauthenticated 200', () => Response.json({ orders: [{ id: privateFixture }] }), 200, 'http_status'],
    ['wrong challenge', () => authProblem({ status: 401, code: 'unauthenticated' }, 'Basic realm="login"'), 401, 'auth_challenge'],
    ['fake 401 problem', () => authProblem({ status: 401, code: privateFixture }), 401, 'auth_problem'],
    ['wrong problem status', () => authProblem({ status: 403, code: 'unauthenticated' }), 401, 'auth_problem'],
    ['HTML 401', () => document('en', '<main>Sign in</main>', { 'www-authenticate': 'Bearer' }, 401), 401, 'media_type'],
  ]) {
    await t.test(name, async () => {
      const report = await fixture({ [queuePath]: response }).run();
      failed(report, 'operator_auth', status, code);
      assert.equal(byCheck(report, 'operator_shell').ok, true);
    });
  }
});

test('redirects and fetch errors are failures without following or logging their content', async () => {
  const subject = fixture({
    '/menu/en': () => new Response(null, { status: 302, headers: { location: `${origin}/${privateFixture}` } }),
    '/menu/rw': () => { throw new Error(privateFixture); },
  });
  const report = await subject.run();
  failed(report, 'menu_en', 302, 'redirect');
  failed(report, 'menu_rw', null, 'network_error');
  assert.equal(subject.requests.length, 5);
  assert.ok(subject.requests.every(({ url }) => !url.pathname.includes(privateFixture)));
});

test('oversized payloads are rejected from headers and stopped mid-stream without a response body leak', async () => {
  let canceled = false;
  let pulls = 0;
  const chunk = new Uint8Array(64 * 1024).fill(65);
  const stream = new ReadableStream({
    pull(controller) {
      if (pulls >= 512) controller.close();
      else {
        pulls += 1;
        controller.enqueue(chunk);
      }
    },
    cancel() { canceled = true; },
  });
  const report = await fixture({
    [menuPath]: () => new Response(privateFixture, {
      headers: { 'content-type': 'application/json', 'content-length': '999999999' },
    }),
    [operatorPath]: () => new Response(stream, { headers: { 'content-type': 'text/html' } }),
  }).run();
  failed(report, 'menu_api', 200, 'body_too_large');
  failed(report, 'operator_shell', 200, 'body_too_large');
  assert.equal(canceled, true);
  assert.ok(pulls < 512, 'the oversized stream should stop before EOF');
});

test('invalid API origins never dispatch a request or expose supplied credentials', async () => {
  let requests = 0;
  for (const url of ['http://storefront.fixture.test/api/v1', `https://staff:${privateFixture}@storefront.fixture.test/api/v1`,
    `${apiBaseUrl}?debug=${privateFixture}`, `${apiBaseUrl}#${privateFixture}`, `${origin}/api/v2`]) {
    await assert.rejects(() => checkAvailability({ apiBaseUrl: url, storeId: 'kigali', fetchImpl: async () => { requests += 1; } }),
      error => error instanceof Error && !error.message.includes(privateFixture));
  }
  assert.equal(requests, 0);
});

async function watchSamples(samples) {
  const controller = new AbortController();
  const events = [];
  let observed = 0;
  await watchAvailability({
    intervalMs: 1,
    signal: controller.signal,
    async probe(signal) {
      assert.equal(signal, controller.signal);
      if (observed === samples.length) {
        controller.abort();
        return { ok: false, orderingOpen: null, checks: [] };
      }
      const ok = samples[observed++];
      return { ok, orderingOpen: ok ? false : null, checks: [{ check: 'menu_api', ok,
        status: ok ? 200 : 503, code: ok ? 'ok' : 'http_status', elapsedMs: 1 }] };
    },
    async emit(event) {
      assert.ok(Number.isFinite(Date.parse(event.at)));
      events.push([event.event, observed, event.orderingOpen, event.checks[0].code]);
    },
  });
  assert.equal(observed, samples.length);
  return events;
}

test('watcher debounces transient failures and recoveries and emits once per transition', { timeout: 5000 }, async () => {
  const events = await watchSamples([true, false, true, false, false, false, true, false, true, true, true, false, false, true, true]);
  assert.deepEqual(events, [
    ['ready', 1, false, 'ok'], ['incident', 5, null, 'http_status'], ['recovered', 10, false, 'ok'],
    ['incident', 13, null, 'http_status'], ['recovered', 15, false, 'ok'],
  ]);
});

test('watcher starting with an outage emits an incident followed by recovery', { timeout: 5000 }, async () => {
  assert.deepEqual(await watchSamples([false, false, true, true]), [
    ['incident', 2, null, 'http_status'], ['recovered', 4, false, 'ok'],
  ]);
});

test('watch cancels a stalled notification sink', { timeout: 2000 }, async () => {
  const controller = new AbortController();
  const enteredSink = Promise.withResolvers();
  const flushed = Promise.withResolvers();
  const watcher = watchAvailability({
    signal: controller.signal,
    probe: () => ({ ok: true, orderingOpen: true, checks: [] }),
    emit() {
      enteredSink.resolve();
      return flushed.promise;
    },
  });
  await enteredSink.promise;
  controller.abort();
  try {
    const stopped = await Promise.race([watcher.then(() => true), delay(200, false, { ref: false })]);
    assert.equal(stopped, true, 'watcher must terminate before the stalled sink flushes');
  } finally {
    flushed.resolve();
    await watcher;
  }
});
