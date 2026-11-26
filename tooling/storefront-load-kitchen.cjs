const assert = require('node:assert/strict');
const { Buffer } = require('node:buffer');
const { execFileSync } = require('node:child_process');
const { createCipheriv, createHmac, pbkdf2Sync, randomBytes, randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');

const database = 'storefront_fixture';
const projectPattern = /^cc-storefront-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const queueIntervalMs = 1000;
const visibilityDeadlineMs = 10000;

function fixturePostgres(project) {
  assert.match(project, projectPattern, 'Expected an isolated storefront Compose project');
  const container = execFileSync('docker', ['ps', '-q', '--filter', 'label=com.docker.compose.project=' + project,
    '--filter', 'label=com.docker.compose.service=postgres'], { encoding: 'utf8', timeout: 5000 }).trim();
  assert.match(container, /^[0-9a-f]{12,64}$/, 'Expected one fixture PostgreSQL container');
  return container;
}

function provisionKitchenCredentials(project) {
  const encodedKey = process.env.CRUSTCAPER_HTTPS_TEST_MFA_FIXTURE_KEY ?? '';
  const key = Buffer.from(encodedKey, 'base64');
  assert.ok(key.length === 32 && key.toString('base64') === encodedKey, 'Missing isolated fixture MFA key');
  const container = fixturePostgres(project);
  const accountId = randomUUID();
  const username = 'load-kitchen-' + accountId.slice(0, 8);
  const password = randomBytes(24).toString('base64url');
  const salt = randomBytes(16);
  const passwordHash = ['', 'pbkdf2-sha256', '600000', salt.toString('base64url'),
    pbkdf2Sync(password, salt, 600000, 32, 'sha256').toString('base64url')].join('$');
  const identity = { storeId: 'kigali', accountId, username };
  function apply(payload) {
    const input = Buffer.from(JSON.stringify({ ...identity, ...payload })).toString('base64') + '\n';
    try {
      execFileSync('docker', ['exec', '-i', container, 'psql', '-XAtq', '--no-password', '-U', database,
        '-d', database, '-v', 'operator_database=' + database, '-f', '/fixture/operator-accounts.psql'],
      { input, timeout: 10000, stdio: ['pipe', 'ignore', 'ignore'] });
    } catch {
      throw new Error('Could not provision the synthetic kitchen account');
    }
  }
  const secret = randomBytes(20);
  const nonce = randomBytes(12);
  const version = Buffer.from([1]);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.concat([
    Buffer.from('crustcaper/operator-totp', 'ascii'), version, Buffer.from(accountId.replaceAll('-', ''), 'hex'),
  ]));
  const encryptedSecret = Buffer.concat([
    version, nonce, cipher.update(secret), cipher.final(), cipher.getAuthTag(),
  ]).toString('base64');
  apply({ operation: 'create', role: 'kitchen', passwordHash });
  apply({ operation: 'enroll-mfa', encryptedSecret });

  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac('sha1', secret).update(counter).digest();
  const authenticatorCode = ((digest.readUInt32BE(digest.at(-1) & 15) & 0x7fffffff) % 1000000)
    .toString().padStart(6, '0');
  return { username, password, authenticatorCode };
}

async function openKitchenSession({ request, project }) {
  const signedIn = await request('/api/v1/operator/sessions', { method: 'POST', body: provisionKitchenCredentials(project) });
  assert.equal(signedIn.status, 201, 'Could not authenticate the synthetic kitchen');
  assert.ok(signedIn.data?.storeId === 'kigali' && signedIn.data.role === 'kitchen'
    && typeof signedIn.data.accessToken === 'string', 'Unexpected kitchen session metadata');

  const headers = { Authorization: 'Bearer ' + signedIn.data.accessToken };
  return {
    async readQueue() {
      const response = await request('/api/v1/operator/orders', { headers });
      if (response.status !== 200 || !Array.isArray(response.data?.orders)) throw new Error('Kitchen queue unavailable');
      return response.data.orders;
    },
    async close() {
      const response = await request('/api/v1/operator/sessions/current', { method: 'DELETE', headers });
      assert.equal(response.status, 204, 'Could not revoke the synthetic kitchen session');
    },
  };
}

async function openKitchenMonitor(options) {
  const kitchen = await openKitchenSession(options);
  const paid = new Map();
  const visible = new Map();
  let inFlight;
  let errors = 0;
  async function readQueue() {
    const orders = await kitchen.readQueue();
    const receivedAt = performance.now();
    for (const order of orders) {
      if (order.paymentStatus === 'paid' && typeof order.id === 'string' && !visible.has(order.id)) {
        visible.set(order.id, receivedAt);
      }
    }
  }
  function poll() {
    if (!inFlight) {
      inFlight = readQueue().catch(() => { errors++; }).finally(() => { inFlight = undefined; });
    }
    return inFlight;
  }

  const timer = setInterval(() => { void poll(); }, queueIntervalMs);
  return {
    observe(orderId) { paid.set(orderId, performance.now()); },
    async finish() {
      const deadline = performance.now() + visibilityDeadlineMs;
      while (Array.from(paid.keys()).some(id => !visible.has(id)) && performance.now() < deadline) {
        await delay(100);
      }
      clearInterval(timer);
      await inFlight;
      const samples = Array.from(paid, ([id, confirmedAt]) => visible.has(id)
        ? Math.max(0, visible.get(id) - confirmedAt) : null)
        .filter(value => value !== null).sort((a, b) => a - b);
      return {
        samples: samples.length,
        p95Ms: samples.length ? Math.ceil(samples[Math.ceil(samples.length * 0.95) - 1]) : null,
        maxMs: samples.length ? Math.ceil(samples.at(-1)) : null,
        missed: paid.size - samples.length,
        errors,
      };
    },
    async close() {
      clearInterval(timer);
      await inFlight;
      await kitchen.close();
    },
  };
}

module.exports = { openKitchenSession, openKitchenMonitor, provisionKitchenCredentials };
