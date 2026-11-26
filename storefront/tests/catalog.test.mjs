import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { catalogConfigured, catalogSite, isCatalogSku, isLocale, loadCatalog } from '../lib/catalog.ts';

const publicOrigin = 'https://menu.example.test';
const firstTag = '"menu-revision-1"';
const secondTag = '"menu-revision-2"';
const firstCheckedAt = '2026-11-26T08:45:00Z';
const secondCheckedAt = '2026-11-26T08:45:03Z';

test('checks startup configuration without querying the API', t => {
  useCatalogEnv(t, {
    CRUSTCAPER_CATALOG_API_ORIGIN: 'http://api:8080',
    CRUSTCAPER_STORE_ID: 'kigali',
    CRUSTCAPER_PUBLIC_ORIGIN: publicOrigin,
    CRUSTCAPER_STOREFRONT_PROFILE: 'stage',
  });
  const fetch = t.mock.method(globalThis, 'fetch');
  assert.equal(catalogConfigured(), true);
  process.env.CRUSTCAPER_STOREFRONT_PROFILE = 'stgae';
  assert.equal(catalogConfigured(), false);
  process.env.CRUSTCAPER_STOREFRONT_PROFILE = 'production';
  process.env.CRUSTCAPER_CATALOG_API_ORIGIN = 'http://api:8080/api/v1';
  assert.equal(catalogConfigured(), false);
  process.env.CRUSTCAPER_CATALOG_API_ORIGIN = 'http://api:8080';
  process.env.CRUSTCAPER_STORE_ID = '';
  assert.equal(catalogConfigured(), false);
  process.env.CRUSTCAPER_STORE_ID = 'kigali';
  process.env.CRUSTCAPER_PUBLIC_ORIGIN = 'http://menu.example.test';
  assert.equal(catalogConfigured(), false);
  assert.equal(fetch.mock.callCount(), 0);
});

function catalogPayload() {
  return {
    version: 'opening-1',
    updatedAt: '2026-11-25T11:00:00.123456Z',
    store: {
      id: 'kigali',
      name: { en: 'CrustCaper', rw: 'CrustCaper' },
      area: { en: 'Test pickup location', rw: 'Aho kugeragereza' },
      hours: { en: '11am to 8pm', rw: '11:00 kugeza 20:00' },
      open: true,
      supportUrl: 'https://support.example.test/contact',
      directionsUrl: 'javascript:alert(1)',
    },
    products: [{
      sku: 'double-smash',
      name: { en: 'Double Smash', rw: 'Double Smash' },
      description: { en: 'Two patties', rw: 'Amapati abiri' },
      ingredients: [{ en: 'Bread', rw: 'Umugati' }],
      allergens: [{ en: 'Wheat', rw: 'Ingano' }],
      category: 'burgers',
      price: 9200,
      available: true,
      modifiers: [{ id: 'add-cheese', name: { en: 'Add cheese', rw: 'Ongeramo foromaje' }, price: 500 }],
      photoUrl: publicOrigin + '/assets/menu/double-smash.a1234.jpg',
    }],
    slots: [{ id: 'first-slot', startsAt: '2026-11-26T09:00:00Z', endsAt: '2026-11-26T09:15:00Z', available: true }],
  };
}

function useCatalogEnv(t, config) {
  for (const [name, value] of Object.entries(config)) {
    const prior = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (prior === undefined) delete process.env[name];
      else process.env[name] = prior;
    });
  }
}

async function apiFixture(t, respond) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers, method: request.method });
    respond(request, response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  useCatalogEnv(t, {
    CRUSTCAPER_CATALOG_API_ORIGIN: `http://127.0.0.1:${server.address().port}`,
    CRUSTCAPER_STORE_ID: 'kigali',
    CRUSTCAPER_PUBLIC_ORIGIN: publicOrigin,
    CRUSTCAPER_STOREFRONT_PROFILE: 'stage',
  });
  return requests;
}

function sendJson(response, payload, tag = firstTag) {
  response.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    ETag: tag,
    'X-Availability-Checked-At': firstCheckedAt,
  });
  response.end(JSON.stringify(payload));
}

test('requests the actual public catalog with channel and locale and returns safe data only', async t => {
  const menu = catalogPayload();
  menu.guestAccessToken = 'fixture-only-field';
  menu.products[0].internalReference = 'fixture-only-field';
  menu.products.push(...[
    'https://third-party.example.test/assets/meal.png',
    publicOrigin + '/api/v1/operator/private.png',
    publicOrigin + '/assets/meal.jpg?private=1',
    publicOrigin + '/assets/meal.svg',
  ].map((photoUrl, index) => ({ ...menu.products[0], sku: `unsupported-image-${index}`, photoUrl })));
  const requests = await apiFixture(t, (_, response) => sendJson(response, menu));
  const result = await loadCatalog('rw');

  assert.equal(result.status, 'ok');
  assert.equal(result.site.publicOrigin, publicOrigin);
  assert.equal(result.site.indexable, false);
  assert.equal(result.menu.store.id, 'kigali');
  assert.equal(result.menu.products[0].price, 9200);
  assert.equal(result.menu.products[0].allergens[0].rw, 'Ingano');
  assert.equal(result.menu.products[0].photoUrl, '/assets/menu/double-smash.a1234.jpg');
  assert.deepEqual(result.menu.products.slice(1).map(item => item.photoUrl), [null, null, null, null]);
  assert.equal(result.menu.store.supportUrl, 'https://support.example.test/contact');
  assert.equal(result.menu.store.directionsUrl, null);
  assert.equal(result.menu.availabilityCheckedAt, firstCheckedAt);
  assert.doesNotMatch(JSON.stringify(result), /fixture-only-field|127\.0\.0\.1/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/v1/stores/kigali/menu?channel=web&locale=rw');
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[0].headers.accept, 'application/json');
  assert.equal(requests[0].headers.authorization, undefined);
  assert.equal(requests[0].headers.cookie, undefined);
});

test('revalidates the retained body, observes a live change and refuses stale prices during outage', async t => {
  let state = 'original';
  const requests = await apiFixture(t, (request, response) => {
    if (state === 'unavailable') {
      response.writeHead(503).end();
      return;
    }
    if (state === 'unchanged') {
      assert.equal(request.headers['if-none-match'], firstTag);
      response.writeHead(304, { ETag: firstTag, 'X-Availability-Checked-At': secondCheckedAt }).end();
      return;
    }
    const payload = catalogPayload();
    if (state === 'changed') {
      payload.version = 'opening-2';
      payload.products[0].price = 9500;
      payload.products[0].available = false;
    }
    sendJson(response, payload, state === 'changed' ? secondTag : firstTag);
  });

  assert.equal((await loadCatalog('en')).menu.products[0].price, 9200);
  assert.equal(requests[0].headers['if-none-match'], undefined);
  state = 'unchanged';
  const still = await loadCatalog('en');
  assert.equal(still.status, 'ok');
  assert.equal(still.menu.products[0].price, 9200);
  assert.equal(still.menu.availabilityCheckedAt, secondCheckedAt);
  state = 'changed';
  const changed = await loadCatalog('en');
  assert.equal(changed.status, 'ok');
  assert.equal(changed.menu.version, 'opening-2');
  assert.equal(changed.menu.products[0].price, 9500);
  assert.equal(changed.menu.products[0].available, false);
  state = 'unavailable';
  assert.deepEqual(await loadCatalog('en'), { status: 'unavailable', site: { publicOrigin, indexable: false } });
  assert.equal(requests[3].headers['if-none-match'], secondTag);
});

test('distinguishes a missing store and rejects a redirect, invalid catalog or untrusted 304', async t => {
  let state = 'missing';
  const requests = await apiFixture(t, (_, response) => {
    if (state === 'missing') return response.writeHead(404).end();
    if (state === 'redirect') return response.writeHead(302, { Location: '/unexpected' }).end();
    if (state === 'initial') return sendJson(response, catalogPayload());
    if (state === 'bad-304') return response.writeHead(304, { ETag: secondTag }).end();
    const invalid = catalogPayload();
    invalid.products[0].price = -5;
    sendJson(response, invalid);
  });

  assert.equal((await loadCatalog('en')).status, 'missing');
  state = 'redirect';
  assert.equal((await loadCatalog('en')).status, 'unavailable');
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => !request.url.includes('unexpected')));
  state = 'invalid';
  assert.equal((await loadCatalog('en')).status, 'unavailable');
  state = 'initial';
  assert.equal((await loadCatalog('en')).status, 'ok');
  state = 'bad-304';
  assert.equal((await loadCatalog('en')).status, 'unavailable');
});

test('does not retain a menu for a different store ID or wrong response media type', async t => {
  let wrongStore = true;
  await apiFixture(t, (_, response) => {
    const invalid = catalogPayload();
    if (wrongStore) {
      invalid.store.id = 'other-store';
      return sendJson(response, invalid);
    }
    response.writeHead(200, { 'Content-Type': 'text/html' }).end(JSON.stringify(invalid));
  });
  assert.equal((await loadCatalog('rw')).status, 'unavailable');
  wrongStore = false;
  assert.equal((await loadCatalog('rw')).status, 'unavailable');
});

test('bounds a hanging upstream request', async t => {
  await apiFixture(t, (_, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"store":');
  });
  const started = Date.now();
  assert.equal((await loadCatalog('en')).status, 'unavailable');
  assert.ok(Date.now() - started < 6000);
});

test('requires explicit canonical configuration and indexes only an explicit production profile', async t => {
  useCatalogEnv(t, {
    CRUSTCAPER_CATALOG_API_ORIGIN: 'http://internal.example.test:8080/api/v1',
    CRUSTCAPER_PUBLIC_ORIGIN: publicOrigin,
    CRUSTCAPER_STORE_ID: 'kigali',
    CRUSTCAPER_STOREFRONT_PROFILE: 'production',
  });
  assert.deepEqual(catalogSite(), { publicOrigin, indexable: true });
  assert.equal((await loadCatalog('en')).status, 'unavailable');
  process.env.CRUSTCAPER_STOREFRONT_PROFILE = 'anything-else';
  assert.deepEqual(catalogSite(), { publicOrigin, indexable: false });
  process.env.CRUSTCAPER_PUBLIC_ORIGIN = 'https://user:secret@menu.example.test';
  assert.equal(catalogSite(), null);
  assert.deepEqual(await loadCatalog('en'), { status: 'unavailable', site: null });
  assert.equal(isLocale('rw'), true);
  assert.equal(isLocale('fr'), false);
  assert.equal(isCatalogSku('item.v2:menu'), true);
  assert.equal(isCatalogSku('..'), false);
  assert.equal(isCatalogSku('menu/item'), false);
});
