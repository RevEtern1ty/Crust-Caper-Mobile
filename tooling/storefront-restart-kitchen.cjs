const { createHash, X509Certificate } = require('node:crypto');
const { mkdir, readFile } = require('node:fs/promises');
const { join } = require('node:path');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const { connect } = require('node:tls');
const { chromium } = require('playwright-core');

const host = 'crustcaper.test';
const origin = 'https://' + host;
const consoleUrl = origin + '/operator/index.html';
const consoleApi = origin + '/api/v1/operator';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const uiTimeoutMs = 9000;
const kitchenVisibilityTargetMs = 10000;
const subsequentPolls = 2;

class KitchenFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function ensure(condition, code) {
  if (!condition) throw new KitchenFailure(code);
}

async function bounded(code, operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof KitchenFailure) throw error;
    throw new KitchenFailure(code);
  }
}

async function storefrontPin(caFile) {
  const ca = await readFile(caFile);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: 443, servername: host, ca, rejectUnauthorized: true, timeout: 5000 });
    socket.once('error', reject);
    socket.once('timeout', () => socket.destroy(new KitchenFailure('kitchen_ui_tls_timeout')));
    socket.once('secureConnect', () => {
      try {
        const key = new X509Certificate(socket.getPeerCertificate().raw).publicKey;
        resolve(createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('base64'));
      } catch (error) {
        reject(error);
      } finally {
        socket.destroy();
      }
    });
  });
}

function installProbe() {
  const oscillatorStart = OscillatorNode.prototype.start;
  let audioAlerts = 0;
  let visualAlerts = 0;
  let browserPollToDomMs = null;
  OscillatorNode.prototype.start = function (...args) {
    Reflect.apply(oscillatorStart, this, args);
    audioAlerts++;
  };
  document.addEventListener('DOMContentLoaded', () => {
    const banner = document.getElementById('kitchen-new-orders');
    if (banner) {
      new MutationObserver(() => {
        if (banner.textContent !== '1 order awaiting preparation.') return;
        visualAlerts++;
        if (visualAlerts === 1) {
          const queueUrl = location.origin + '/api/v1/operator/orders';
          const lastPoll = performance.getEntriesByName(queueUrl, 'resource').at(-1);
          if (lastPoll?.responseEnd > 0) browserPollToDomMs = Math.round(performance.now() - lastPoll.responseEnd);
        }
      }).observe(banner, { childList: true, characterData: true, subtree: true });
    }
  }, { once: true });
  window.__crustcaperKitchenProbe = () => {
    const byId = id => document.getElementById(id);
    const cards = [...byId('order-list').children];
    return {
      audioAlerts, visualAlerts, browserPollToDomMs, hidden: document.hidden, stale: !byId('queue-stale').hidden,
      degraded: !byId('queue-problem').hidden, empty: !byId('empty-state').hidden,
      waiting: byId('kitchen-signal').dataset.waiting === 'true',
      message: byId('kitchen-new-orders').textContent,
      sound: byId('kitchen-sound-status').textContent,
      cards: cards.map(card => ({
        title: card.querySelector('.order-title')?.textContent,
        canStart: card.querySelector('[data-kitchen-action]')?.disabled === false,
      })),
    };
  };
}

function isOperatorResponse(response, method, path) {
  return response.url() === consoleApi + path && response.request().method() === method;
}

function watchQueue(page) {
  const paidReads = [];
  let failed = 0;
  let invalid = 0;
  let empty = 0;
  page.on('requestfailed', request => {
    if (request.url() === consoleApi + '/orders' && request.method() === 'GET') failed++;
  });
  page.on('response', async response => {
    if (!isOperatorResponse(response, 'GET', '/orders')) return;
    if (response.status() >= 500) {
      failed++;
      return;
    }
    try {
      ensure(response.status() === 200, 'kitchen_ui_queue_response');
      // A successful response from this controller requires the operator session. Read its data, without headers.
      const body = await response.json();
      ensure(Array.isArray(body?.orders)
        && (!body.externalOrders || body.externalOrders.length === 0), 'kitchen_ui_queue_response');
      if (!body.orders.length) empty++;
      else paidReads.push({
        serverTime: Date.parse(body.serverTime),
        orders: body.orders.map(({ id, paymentStatus, status, acceptedAt }) => ({
          id, paymentStatus, status, acceptedAt: Date.parse(acceptedAt),
        })),
      });
    } catch {
      invalid++;
    }
  });
  return { get empty() { return empty; }, get failed() { return failed; }, get invalid() { return invalid; }, paidReads };
}

async function waitFor(signal, timeoutMs, code, read) {
  const stopAt = performance.now() + timeoutMs;
  while (!signal.aborted && performance.now() < stopAt) {
    const found = await read();
    if (found) return found;
    await delay(100, undefined, { signal });
  }
  throw new KitchenFailure(code);
}

function verifyFresh(state, orderTitle) {
  ensure(!state.hidden && !state.stale && !state.degraded && !state.empty
    && state.waiting && state.message === '1 order awaiting preparation.' && state.sound === 'Order sound is on.'
    && state.cards.length === 1 && state.cards[0].title === orderTitle && state.cards[0].canStart,
  'kitchen_ui_order_not_fresh');
  ensure(state.audioAlerts === 1 && state.visualAlerts === 1, 'kitchen_ui_duplicate_alert');
}

async function openKitchenBoard({ caFile, evidence, credentials, signal }) {
  return bounded('kitchen_ui_launch_failed', async () => {
    ensure(process.env.CRUSTCAPER_HTTPS_TEST_PAYMENT_RESTART === '1' && !signal.aborted, 'kitchen_ui_fixture_required');
    const pin = await storefrontPin(caFile);
    const browser = await chromium.launch({ channel: 'chrome', timeout: 15000, args: [
      '--host-resolver-rules=MAP ' + host + ' 127.0.0.1, MAP * ~NOTFOUND',
      '--no-proxy-server',
      '--ignore-certificate-errors-spki-list=' + pin,
    ] });
    const abort = () => { void browser.close().catch(() => undefined); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      ensure(!signal.aborted, 'kitchen_ui_interrupted');
      const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      await context.addInitScript(installProbe);
      const page = await context.newPage();
      page.setDefaultTimeout(uiTimeoutMs);
      const queue = watchQueue(page);
      const snapshot = () => page.evaluate(() => window.__crustcaperKitchenProbe());
      const capture = async name => {
        if (!evidence) return;
        await mkdir(evidence, { recursive: true });
        await page.screenshot({ path: join(evidence, `kitchen-restart-${name}.png`), timeout: 3000, animations: 'disabled' });
      };

      await bounded('kitchen_ui_sign_in_failed', async () => {
        const response = await page.goto(consoleUrl, { timeout: uiTimeoutMs });
        ensure(response?.status() === 200 && page.url() === consoleUrl, 'kitchen_ui_wire_url');
        const auth = await credentials();
        ensure(typeof auth.username === 'string' && typeof auth.password === 'string'
          && /^\d{6}$/.test(auth.authenticatorCode), 'kitchen_ui_mfa_required');
        await page.getByLabel('Username', { exact: true }).fill(auth.username);
        await page.getByLabel('Password', { exact: true }).fill(auth.password);
        await page.getByLabel('Authenticator code', { exact: true }).fill(auth.authenticatorCode);
        const [signedIn] = await Promise.all([
          page.waitForResponse(res => isOperatorResponse(res, 'POST', '/sessions')),
          page.getByRole('button', { name: 'Sign in', exact: true }).click(),
        ]);
        ensure(signedIn.status() === 201, 'kitchen_ui_mfa_rejected');
        await page.getByRole('heading', { name: 'Kitchen queue', exact: true }).waitFor();
        await page.getByText('No paid orders are waiting.', { exact: true }).waitFor();
        await page.getByRole('button', { name: 'Enable order sound', exact: true }).click();
        await page.getByText('Order sound is on.', { exact: true }).waitFor();
        await waitFor(signal, uiTimeoutMs, 'kitchen_ui_initial_queue_failed', () => queue.empty > 0);
        const initial = await snapshot();
        ensure(!initial.hidden && !initial.stale && initial.empty && !initial.waiting
          && initial.cards.length === 0 && initial.audioAlerts === 0 && initial.visualAlerts === 0
          && queue.invalid === 0 && queue.failed === 0, 'kitchen_ui_initial_queue_failed');
        await capture('before-outage');
      });

      return {
        observeOutage: () => bounded('kitchen_ui_outage_timeout', async () => {
          const state = await waitFor(signal, 11000, 'kitchen_ui_outage_timeout', async () => {
            const candidate = await snapshot();
            return candidate.stale && candidate.degraded && queue.failed > 0 ? candidate : null;
          });
          ensure(!state.hidden && !state.empty && !state.waiting && state.cards.length === 0 && queue.paidReads.length === 0
            && state.message === 'Waiting orders could not be confirmed.'
            && state.sound === 'Order sound is paused until the queue is refreshed.'
            && state.audioAlerts === 0 && state.visualAlerts === 0, 'kitchen_ui_outage_alert');
          await capture('outage');
          return { stale: true, degraded: true, failedPolls: queue.failed, paidOrderCount: 0, audioAlerts: 0, visualAlerts: 0 };
        }),
        observeRecovery: ({ orderId }) => bounded('kitchen_ui_recovery_timeout', async () => {
          ensure(uuid.test(orderId), 'kitchen_ui_order_reference');
          const orderTitle = 'Order #' + orderId.slice(-8).toUpperCase();
          const started = performance.now();
          const first = await waitFor(signal, 9000, 'kitchen_ui_recovery_timeout', async () => {
            const candidate = await snapshot();
            return queue.paidReads.length && candidate.cards.length && candidate.audioAlerts > 0 ? candidate : null;
          });
          verifyFresh(first, orderTitle);
          const domObservationWaitMs = Math.round(performance.now() - started);
          await capture('recovered');
          await waitFor(signal, 14000, 'kitchen_ui_followup_polls_timeout',
            () => queue.paidReads.length >= 1 + subsequentPolls);
          const after = await snapshot();
          verifyFresh(after, orderTitle);
          ensure(queue.invalid === 0 && queue.paidReads.every(({ serverTime, orders }) =>
            orders.length === 1 && orders[0].id === orderId && orders[0].paymentStatus === 'paid'
              && orders[0].status === 'accepted' && Number.isFinite(orders[0].acceptedAt) && serverTime >= orders[0].acceptedAt),
          'kitchen_ui_paid_order_mismatch');
          const firstRead = queue.paidReads[0];
          const acceptedToBrowserPollMs = firstRead.serverTime - firstRead.orders[0].acceptedAt;
          ensure(acceptedToBrowserPollMs <= kitchenVisibilityTargetMs, 'kitchen_ui_visibility_target_missed');
          await capture('stable');
          return {
            acceptedToBrowserPollMs,
            browserPollToDomMs: first.browserPollToDomMs, domObservationWaitMs, paidOrderCount: after.cards.length,
            audioObservation: 'native_oscillator_starts',
            authenticatedPaidPolls: queue.paidReads.length, audioAlerts: after.audioAlerts, visualAlerts: after.visualAlerts,
          };
        }),
        close: async () => {
          signal.removeEventListener('abort', abort);
          try {
            if (!signal.aborted) await bounded('kitchen_ui_revoke_failed', async () => {
              const [revoked] = await Promise.all([
                page.waitForResponse(res => isOperatorResponse(res, 'DELETE', '/sessions/current'), { timeout: 4000 }),
                page.getByRole('button', { name: 'Sign out', exact: true }).click({ timeout: 4000 }),
              ]);
              ensure(revoked.status() === 204, 'kitchen_ui_revoke_failed');
            });
          } finally {
            await browser.close();
          }
        },
      };
    } catch (error) {
      signal.removeEventListener('abort', abort);
      await browser.close().catch(() => undefined);
      throw error;
    }
  });
}

module.exports = { openKitchenBoard };
