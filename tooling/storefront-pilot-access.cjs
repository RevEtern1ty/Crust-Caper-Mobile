const assert = require('node:assert/strict');
const { writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { openHttpsWitnesses } = require('./storefront-network-rate-limit.cjs');

const menuPath = '/api/v1/stores/kigali/menu?channel=mobile';
const guestPath = '/api/v1/guest-sessions';
const webGuestPath = '/api/v1/web/session';
const webhookPath = '/api/v1/webhooks/flutterwave';
const applePath = '/.well-known/apple-app-site-association';
const androidPath = '/.well-known/assetlinks.json';
const paymentReturnPaths = ['/payment-return', '/web-payment-return'];

async function runPilotAccess({ activate, appLinks, evidence, webhookSecret, ...fixture }) {
  const request = await openHttpsWitnesses(fixture);
  const baselineA = await request(0, 'GET', menuPath);
  const baselineB = await request(1, 'GET', menuPath);
  for (const baseline of [baselineA, baselineB]) {
    assert.equal(baseline.status, 200);
    assert.equal(baseline.storeId, 'kigali');
  }
  assert.notEqual(baselineA.localAddress, baselineB.localAddress, 'Expected distinct fixture addresses');
  assert.equal(baselineA.remoteAddress, baselineB.remoteAddress, 'Expected one HTTPS ingress');

  await activate(baselineA.localAddress + '/32');
  const memberMenu = await request(0, 'GET', menuPath);
  assert.equal(memberMenu.localAddress, baselineA.localAddress);
  assert.equal(memberMenu.status, 200);
  assert.equal(memberMenu.storeId, 'kigali');

  async function outside(method, path, headers, payload) {
    const response = await request(1, method, path, headers, payload);
    assert.equal(response.localAddress, baselineB.localAddress);
    assert.equal(response.remoteAddress, memberMenu.remoteAddress);
    return response;
  }

  async function denied(method, path, headers) {
    const response = await outside(method, path, headers);
    assert.equal(response.status, 403, method + ' ' + path);
    assert.match(response.cacheControl ?? '', /(?:^|,\s*)no-store(?:,|$)/);
    assert.equal(response.location, undefined);
    assert.equal(response.guestIssued, false);
    assert.equal(response.webGuestIssued, false);
  }

  const memberPages = ['/menu/en', '/cart', '/favicon.ico', '/operator/index.html', ...paymentReturnPaths];
  for (const path of memberPages) {
    const response = await request(0, 'GET', path);
    assert.equal(response.status, 200, path);
  }
  const memberGuest = await request(0, 'POST', guestPath);
  assert.equal(memberGuest.status, 200);
  assert.equal(memberGuest.guestIssued, true);
  const webHeaders = { Origin: 'https://' + fixture.fixtureHost, 'X-CrustCaper-Web': '1' };
  const memberWebGuest = await request(0, 'POST', webGuestPath, webHeaders);
  assert.equal(memberWebGuest.status, 200);
  assert.equal(memberWebGuest.webGuestIssued, true);

  for (const path of ['/', ...memberPages, menuPath, '/order/00000000-0000-4000-8000-000000000001',
    '/api/v1/operator/orders', '/.well-known/other.json', webhookPath]) {
    await denied('GET', path);
  }
  await denied('HEAD', '/menu/en');
  await denied('POST', webGuestPath, webHeaders);
  await denied('POST', guestPath);
  await denied('POST', applePath);
  await denied('POST', androidPath);
  await denied('POST', webhookPath + '/other');
  await denied('POST', guestPath, {
    Forwarded: 'for=' + baselineA.localAddress,
    'X-Forwarded-For': baselineA.localAddress,
    'X-CrustCaper-Client-IP': baselineA.localAddress,
    'X-CrustCaper-Edge-Proof': '0'.repeat(64),
  });

  for (const path of ['/actuator/health/readiness', '/api/v1/local', '/api/v1/local/other']) {
    assert.equal((await request(0, 'GET', path)).status, 404);
    assert.equal((await outside('GET', path)).status, 404);
  }

  const apple = await outside('GET', applePath);
  const android = await outside('GET', androidPath);
  for (const association of [apple, android]) {
    assert.equal(association.status, 200);
    assert.equal(association.mediaType, 'application/json');
    assert.equal(association.location, undefined);
  }
  assert.deepEqual(apple.association.applinks.details, [{
    appIDs: [appLinks.iosAppId], components: [{ '/': '/payment-return' }],
  }]);
  assert.deepEqual(android.association, [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
      namespace: 'android_app', package_name: appLinks.androidPackage,
      sha256_cert_fingerprints: [appLinks.androidFingerprint],
    },
  }]);
  for (const path of [applePath, androidPath]) {
    const head = await outside('HEAD', path);
    assert.equal(head.status, 200);
    assert.equal(head.emptyBody, true);
  }

  async function webhook(event, signature) {
    const payload = JSON.stringify(event);
    return outside('POST', webhookPath, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      ...(signature !== undefined && { 'verif-hash': signature }),
    }, payload);
  }
  const event = { event: 'charge.completed', data: { id: 'invalid' } };
  for (const signature of [undefined, 'incorrect-isolated-fixture-signature']) {
    const unauthorized = await webhook(event, signature);
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorized.code, 'unauthenticated');
  }
  const malformedCharge = await webhook(event, webhookSecret);
  assert.equal(malformedCharge.status, 400);
  assert.equal(malformedCharge.code, 'invalid_input');
  const ignoredEvent = await webhook({ event: 'fixture.ignored' }, webhookSecret);
  assert.equal(ignoredEvent.status, 200);
  assert.equal(ignoredEvent.emptyBody, true);

  const report = {
    passed: true, verifiedHttps: true, distinctIpv4Peers: true, bothReachableBeforePolicy: true, invalidInputsRejected: true,
    member: { menu: memberMenu.status, nativeGuest: memberGuest.status, webGuest: memberWebGuest.status,
      storefrontAndOperatorPages: 200, paymentReturns: 200 },
    outside: { gatedRoutes: 403, spoofedIdentity: 403, internalRoutes: 404, associationGetAndHead: 200,
      webhookMissingAndIncorrectSignature: 401, authorizedMalformedCharge: 400, authorizedIgnoredEvent: 200 },
  };
  const output = JSON.stringify(report, null, 2) + '\n';
  if (evidence) await writeFile(join(evidence, 'storefront-pilot-access.json'), output);
  process.stdout.write(output);
}

module.exports = { runPilotAccess };
