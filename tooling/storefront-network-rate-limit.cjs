const assert = require('node:assert/strict');
const { readFile, writeFile } = require('node:fs/promises');
const { isIPv4 } = require('node:net');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const networkRateSessionLimit = 2;
const peerNames = ['rate-client-a', 'rate-client-b'];
const menuPath = '/api/v1/stores/kigali/menu?channel=mobile';
const sessionPath = '/api/v1/guest-sessions';

function httpsWitnesses() {
  return Object.fromEntries(peerNames.map(name => [name, {
    image: '${CRUSTCAPER_CATALOG_IMAGE:?Set the verified catalog image or digest}',
    pull_policy: 'never',
    entrypoint: ['node', '-e', 'setInterval(() => {}, 3600000)'],
    command: [],
    networks: ['network_rate_clients'],
    read_only: true,
    cap_drop: ['ALL'],
    security_opt: ['no-new-privileges:true'],
    init: true,
    restart: 'no',
  }]));
}

// This function runs inside the witness container, on the same isolated bridge as the edge.
function requestFromWitness({ fixtureHost, method, path, headers, ca, payload }) {
  const { request } = require('node:https');
  return new Promise((resolve, reject) => {
    const call = request({
      hostname: 'edge', port: 443, servername: fixtureHost, family: 4,
      ca, rejectUnauthorized: true, agent: false, method, path,
      headers: { Host: fixtureHost, ...headers },
      signal: AbortSignal.timeout(6_000),
    }, response => {
      const { localAddress, remoteAddress } = response.socket;
      response.setEncoding('utf8');
      let body = '';
      response.on('data', chunk => {
        body += chunk;
        if (body.length > 64 * 1024) response.destroy(new Error('Unexpected fixture response size'));
      });
      response.on('error', reject);
      response.on('end', () => {
        const mediaType = response.headers['content-type']?.split(';', 1)[0].trim();
        let data;
        if (body && /^application\/(?:[a-z0-9.-]+\+)?json$/i.test(mediaType ?? '')) {
          try {
            data = JSON.parse(body);
          } catch (error) {
            reject(error);
            return;
          }
        }
        resolve({
          localAddress, remoteAddress, status: response.statusCode,
          cacheControl: response.headers['cache-control'], retryAfter: response.headers['retry-after'],
          code: data?.code, mediaType, location: response.headers.location, emptyBody: body.length === 0,
          guestIssued: typeof data?.accessToken === 'string', storeId: data?.store?.id,
          webGuestIssued: typeof data?.sessionId === 'string'
            && (response.headers['set-cookie'] ?? []).some(value => value.startsWith('__Host-crustcaper-web=')),
          ...(path.startsWith('/.well-known/') && { association: data }),
        });
      });
    });
    call.on('error', reject);
    call.end(payload);
  });
}

const witnessProgram = [
  "const { readFileSync } = require('node:fs');",
  'const requestFromWitness = ' + requestFromWitness.toString() + ';',
  "requestFromWitness(JSON.parse(readFileSync(0, 'utf8')))",
  '.then(result => process.stdout.write(JSON.stringify(result)))',
  '.catch(() => { process.exitCode = 1; });',
].join('\n');

function retryDelay(response) {
  assert.equal(response.status, 429, 'The exhausted network must receive HTTP 429');
  assert.equal(response.code, 'rate_limited');
  assert.equal(response.guestIssued, false);
  assert.match(response.cacheControl ?? '', /(?:^|,\s*)no-store(?:,|$)/);
  assert.match(response.retryAfter ?? '', /^(?:[1-9]|[1-5][0-9]|60)$/);
  return Number(response.retryAfter);
}

async function openHttpsWitnesses({ compose, fixtureHost, browserCa, signal }) {
  const ca = await readFile(browserCa, 'utf8');
  return async (peer, method, path, headers = {}, payload) => {
    const result = JSON.parse(await compose('Request HTTPS from an isolated network witness',
      ['exec', '-T', peerNames[peer], 'node', '-e', witnessProgram], {
        signal, capture: true, timeout: 8_000, input: JSON.stringify({ fixtureHost, method, path, headers, ca, payload }),
      }));
    assert.ok(isIPv4(result.localAddress) && isIPv4(result.remoteAddress), 'Expected direct IPv4 connections to the fixture edge');
    return result;
  };
}

async function runNetworkRateLimit({ evidence, signal, ...fixture }) {
  const probe = await openHttpsWitnesses({ ...fixture, signal });

  const menuB = await probe(1, 'GET', menuPath);
  assert.equal(menuB.status, 200);
  assert.equal(menuB.storeId, 'kigali');

  let addressA;
  async function exhaustNetwork() {
    for (let accepted = 0; accepted <= networkRateSessionLimit * 2; accepted++) {
      const response = await probe(0, 'POST', sessionPath);
      addressA ??= response.localAddress;
      assert.equal(response.localAddress, addressA);
      assert.notEqual(addressA, menuB.localAddress, 'The witnesses must have distinct source addresses');
      assert.equal(response.remoteAddress, menuB.remoteAddress, 'The witnesses must use the same edge');
      if (response.status === 429) return { accepted, response, retryAfterSeconds: retryDelay(response) };
      assert.equal(response.status, 200);
      assert.equal(response.guestIssued, true);
    }
    assert.fail('The configured network limit did not reject session creation');
  }

  let exhaustion = await exhaustNetwork();
  // Retry once at the API's next window if the first sequence straddled its clock boundary.
  if (exhaustion.accepted !== networkRateSessionLimit || exhaustion.retryAfterSeconds < 8) {
    await delay(exhaustion.retryAfterSeconds * 1000 + 100, undefined, { signal });
    exhaustion = await exhaustNetwork();
  }
  assert.equal(exhaustion.accepted, networkRateSessionLimit);
  const suppliedIdentity = {
    Forwarded: 'for=' + menuB.localAddress,
    'X-Forwarded-For': menuB.localAddress,
    'X-CrustCaper-Client-IP': menuB.localAddress,
    'X-CrustCaper-Edge-Proof': '0'.repeat(64),
  };
  const stillExhausted = await probe(0, 'POST', sessionPath, suppliedIdentity);
  const retryAfterWithSuppliedIdentitySeconds = retryDelay(stillExhausted);
  assert.equal(stillExhausted.localAddress, addressA);

  const acceptedB = await probe(1, 'POST', sessionPath, suppliedIdentity);
  assert.equal(acceptedB.localAddress, menuB.localAddress);
  assert.equal(acceptedB.remoteAddress, menuB.remoteAddress);
  assert.equal(acceptedB.status, 200, 'The second network must keep its own session budget');
  assert.equal(acceptedB.guestIssued, true);
  const menuA = await probe(0, 'GET', menuPath);
  assert.equal(menuA.localAddress, addressA);
  assert.equal(menuA.status, 200);
  assert.equal(menuA.storeId, 'kigali');

  const report = {
    passed: true, sessionLimit: networkRateSessionLimit, distinctIpv4Peers: true, verifiedHttps: true,
    exhaustedStatus: exhaustion.response.status, retryAfterSeconds: exhaustion.retryAfterSeconds, suppliedIdentityIgnored: true,
    retryAfterWithSuppliedIdentitySeconds, independentStatus: acceptedB.status, menuStatus: menuA.status,
  };
  const output = JSON.stringify(report, null, 2) + '\n';
  if (evidence) await writeFile(join(evidence, 'storefront-network-rate-limit.json'), output);
  process.stdout.write(output);
}

module.exports = { networkRateSessionLimit, httpsWitnesses, openHttpsWitnesses, runNetworkRateLimit };
