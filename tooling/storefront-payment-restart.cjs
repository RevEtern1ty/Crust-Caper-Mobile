const { execFile } = require('node:child_process');
const { mkdir, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');
const { openStorefrontFixture } = require('./storefront-load.cjs');
const { openKitchenSession, provisionKitchenCredentials } = require('./storefront-load-kitchen.cjs');
const { beginCheckout } = require('./storefront-load-journey.cjs');

const execute = promisify(execFile);
const menuPath = '/api/v1/stores/kigali/menu?channel=web&locale=en';
const slotId = 'fixture-slot-0';
const database = 'storefront_fixture';
const containerId = /^[a-f0-9]{64}$/;
const apiEntrypoint = '-Dloader.main=com.crustcaper.api.payment.WebCheckoutFixture';
const firstProviderTransaction = '7001';

class RestartFailure extends Error {}

function ensure(condition, code) {
  if (!condition) throw new RestartFailure(code);
}

function failureCode(error) {
  if (error instanceof RestartFailure) return error.message;
  if (typeof error?.code === 'string' && /^(?:checkout|kitchen_ui)_[a-z_]{2,48}$/.test(error.code)) return error.code;
  return 'fixture_operation_failed';
}

async function docker(signal, ...args) {
  try {
    const { stdout } = await execute('docker', args, {
      signal, encoding: 'utf8', windowsHide: true, timeout: 8000, maxBuffer: 64 * 1024,
    });
    return stdout.trim();
  } catch {
    throw new RestartFailure(signal.aborted ? 'fixture_interrupted' : 'fixture_docker_command_failed');
  }
}

async function inspect(signal, project, service, id) {
  ensure(/^[a-f0-9]{12,64}$/.test(id), 'fixture_container_id');
  // Select only fields needed to establish scope and lifecycle. Container environment contains fixture credentials.
  const template = [
    '.Id', '(index .Config.Labels "com.docker.compose.project")', '(index .Config.Labels "com.docker.compose.service")',
    '.State.Status', '.State.StartedAt', '.State.ExitCode', '.HostConfig.RestartPolicy.Name', '.Args',
  ].map(field => `{{json ${field}}}`).join('|');
  const result = await docker(signal, 'inspect', '--type', 'container', '--format', template, id);
  const [fullId, owner, role, status, startedAt, exitCode, restartPolicy, args] = result.split('|').map(JSON.parse);
  ensure(containerId.test(fullId) && fullId.startsWith(id) && owner === project && role === service
    && Number.isFinite(Date.parse(startedAt)), 'fixture_container_scope');
  return { id: fullId, status, startedAt, exitCode, restartPolicy, args };
}

async function serviceContainer(signal, project, service, verifiedId) {
  const id = verifiedId ?? await docker(signal, 'ps', '--no-trunc', '--filter', `label=com.docker.compose.project=${project}`,
    '--filter', `label=com.docker.compose.service=${service}`, '--format', '{{.ID}}');
  const container = await inspect(signal, project, service, id);
  ensure(container.status === 'running', 'fixture_container_not_running');
  return container;
}

function ensureRestartApi(api) {
  ensure(api.restartPolicy === 'no' && Array.isArray(api.args)
    && api.args.includes(apiEntrypoint) && api.args.at(-1) === '--restart-api', 'fixture_api_restart_scope');
}

async function ensureUnchanged(signal, project, fixtures) {
  const observations = await Promise.all(Object.entries(fixtures).map(async ([service, original]) => {
    const current = await serviceContainer(signal, project, service);
    return current.id === original.id && current.startedAt === original.startedAt;
  }));
  ensure(observations.every(Boolean), 'fixture_support_service_restarted');
}

function restrictRequest(request) {
  return (path, options = {}) => {
    const method = options.method ?? 'GET';
    const allowed = options.route === 'hosted' ? method === 'POST'
      : method === 'GET' && [menuPath, '/api/v1/operator/orders'].includes(path)
        || method === 'DELETE' && path === '/api/v1/operator/sessions/current'
        || method === 'POST' && (/^\/api\/v1\/web\/(?:session|quotes|orders|orders\/[a-f0-9-]{36}\/payments)$/.test(path)
          || path === '/api/v1/operator/sessions');
    ensure(allowed, 'fixture_unexpected_request');
    return request(path, options);
  };
}

async function providerState(signal, edge) {
  const text = await docker(signal, 'exec', edge, 'wget', '-q', '-O', '-', 'http://provider:18432/fixture/state');
  const { openCalls, paidCharges, verifyCalls, firstPaidVerificationHeld } = JSON.parse(text);
  ensure(openCalls === 1 && paidCharges === 1 && Number.isSafeInteger(verifyCalls) && verifyCalls >= 0
    && typeof firstPaidVerificationHeld === 'boolean', 'fixture_provider_state');
  return { openCalls, paidCharges, verifyCalls, firstPaidVerificationHeld };
}

async function paymentRow(signal, postgres, order) {
  const sql = `
    SELECT o.id, o.quote_id, o.slot_id, o.total, o.status, o.payment_status, o.checkout_channel,
      p.id, p.status, p.provider_transaction_id, floor(extract(epoch FROM p.last_checked_at) * 1000),
      floor(extract(epoch FROM o.accepted_at) * 1000), (SELECT count(*) FROM payment_exceptions)
    FROM orders o LEFT JOIN payment_attempts p ON p.order_id = o.id`;
  const output = await docker(signal, 'exec', postgres, 'psql', '-XAt', '--no-password', '-v', 'ON_ERROR_STOP=1',
    '-U', database, '-d', database, '-c', sql);
  const [id, quoteId, storedSlot, total, orderStatus, paymentStatus, channel, attemptId, attemptStatus,
    transaction, lastChecked, accepted, exceptions] = output.split('|');
  ensure(!output.includes('\n') && id === order.orderId && quoteId === order.quoteId && storedSlot === order.slotId
    && total === String(order.total) && channel === 'web' && attemptId === order.attemptId && exceptions === '0',
  'fixture_database_identity');
  return { orderStatus, paymentStatus, attemptStatus, transaction, lastChecked: Number(lastChecked), accepted: Number(accepted) };
}

function ensureProcessing(row) {
  ensure(row.orderStatus === 'awaiting_payment' && row.paymentStatus === 'processing' && row.attemptStatus === 'processing'
    && row.transaction === '' && row.accepted === 0, 'fixture_payment_completed_before_restart');
}

async function waitFor(signal, timeoutMs, failure, observe) {
  const deadline = performance.now() + timeoutMs;
  while (!signal.aborted && performance.now() < deadline) {
    const result = await observe();
    if (result) return result;
    await delay(500, undefined, { signal });
  }
  ensure(false, signal.aborted ? 'fixture_interrupted' : failure);
}

async function waitReady(signal, edge, request) {
  await waitFor(signal, 30000, 'fixture_api_readiness_timeout', async () => {
    try {
      const readiness = await docker(signal, 'exec', edge, 'wget', '-q', '-O', '-', 'http://api:8080/actuator/health/readiness');
      if (JSON.parse(readiness).status !== 'UP') return false;
      return (await request(menuPath)).status === 200;
    } catch {
      return false;
    }
  });
}

async function restartContainers(signal, project, fixture) {
  const [api, edge, postgres, provider] = await Promise.all([
    serviceContainer(signal, project, 'api'), serviceContainer(signal, project, 'edge', fixture.edge),
    serviceContainer(signal, project, 'postgres'), serviceContainer(signal, project, 'provider'),
  ]);
  ensure(new Set([api.id, edge.id, postgres.id, provider.id]).size === 4, 'fixture_services_not_separate');
  ensureRestartApi(api);
  return { api, edge, postgres, provider };
}

async function exercise({ signal, project, request, kitchen, board, containers, report }) {
  const { api, ...services } = containers;
  const { edge, postgres } = services;
  report.phase = 'checkout';
  ensure((await kitchen.readQueue()).length === 0, 'fixture_kitchen_not_empty');
  const menu = await request(menuPath);
  ensure(menu.status === 200 && menu.data?.store?.id === 'kigali', 'fixture_menu_unavailable');
  const { order } = await beginCheckout({ request, menu: menu.data, slotId });
  const hostedSettledAt = performance.now();
  const readRow = () => paymentRow(signal, postgres.id, order);
  ensureProcessing(await readRow());

  report.phase = 'scheduled_verification';
  const claim = await waitFor(signal, 60000, 'fixture_first_scheduled_verification_timeout', async () => {
    const [payment, state] = await Promise.all([readRow(), providerState(signal, edge.id)]);
    ensureProcessing(payment);
    if (payment.lastChecked > 0 && state.firstPaidVerificationHeld) {
      ensure(state.verifyCalls === 1, 'fixture_provider_verified_before_pause');
      return { lastChecked: payment.lastChecked, state };
    }
    return null;
  });
  report.beforeRestart = { orderStatus: 'awaiting_payment', paymentStatus: 'processing',
    scheduledClaimMsAfterHostedSettlement: Math.round(performance.now() - hostedSettledAt), provider: claim.state };

  report.phase = 'kill_and_restart';
  const stillRunning = await inspect(signal, project, 'api', api.id);
  ensureRestartApi(stillRunning);
  ensure(stillRunning.status === 'running' && stillRunning.startedAt === api.startedAt, 'fixture_api_changed_before_kill');
  const paused = await providerState(signal, edge.id);
  ensure(paused.firstPaidVerificationHeld && paused.verifyCalls === 1, 'fixture_provider_hold_ended_before_kill');
  const stoppedAt = performance.now();
  await docker(signal, 'kill', '--signal=KILL', api.id);
  const holdAfterKill = await providerState(signal, edge.id);
  ensure(holdAfterKill.firstPaidVerificationHeld && holdAfterKill.verifyCalls === 1, 'fixture_provider_hold_ended_during_kill');
  report.heldAfterKill = true;
  const stopped = await inspect(signal, project, 'api', api.id);
  ensureRestartApi(stopped);
  ensure(stopped.status === 'exited' && stopped.exitCode === 137 && stopped.startedAt === api.startedAt,
    'fixture_api_did_not_exit_on_kill');
  report.apiKillExitCode = stopped.exitCode;
  const whileDown = await readRow();
  ensureProcessing(whileDown);
  ensure(whileDown.lastChecked === claim.lastChecked, 'fixture_claim_not_preserved');
  await ensureUnchanged(signal, project, services);
  if (board) {
    report.phase = 'kitchen_browser_outage';
    report.browser = { outage: await board.observeOutage() };
  }

  await docker(signal, 'start', api.id);
  const restarted = await serviceContainer(signal, project, 'api', api.id);
  ensureRestartApi(restarted);
  const restartedAt = Date.parse(restarted.startedAt);
  ensure(restartedAt > Date.parse(api.startedAt), 'fixture_api_did_not_restart');
  await waitReady(signal, edge.id, request);
  report.apiRestartReadyMs = Math.round(performance.now() - stoppedAt);

  report.phase = 'reconciled_after_restart';
  const paid = await waitFor(signal, 55000, 'fixture_post_restart_payment_timeout', async () => {
    const row = await readRow();
    if (row.paymentStatus === 'processing') {
      ensureProcessing(row);
      return null;
    }
    ensure(row.orderStatus === 'accepted' && row.paymentStatus === 'paid' && row.attemptStatus === 'paid'
      && row.transaction === firstProviderTransaction && row.lastChecked > claim.lastChecked
      && row.accepted >= restartedAt, 'fixture_payment_reconciliation_failed');
    return row;
  });
  const verifiedReadAt = performance.now();
  const providerAfter = await providerState(signal, edge.id);
  ensure(providerAfter.verifyCalls >= 2 && !providerAfter.firstPaidVerificationHeld, 'fixture_provider_did_not_reverify');
  await ensureUnchanged(signal, project, services);
  const current = await inspect(signal, project, 'api', api.id);
  ensure(current.status === 'running' && current.startedAt === restarted.startedAt, 'fixture_api_restarted_again');
  report.afterRestart = { orderStatus: paid.orderStatus, paymentStatus: paid.paymentStatus,
    attempts: 1, paymentExceptions: 0, matchedProviderTransaction: true, provider: providerAfter, supportServiceRestarts: 0,
    acceptedMsAfterApiStart: paid.accepted - restartedAt };

  report.phase = 'kitchen_visibility';
  const queue = await waitFor(signal, 10000, 'fixture_kitchen_visibility_timeout', async () => {
    const orders = await kitchen.readQueue();
    return orders.length ? orders : null;
  });
  ensure(queue.length === 1 && queue[0].id === order.orderId && queue[0].paymentStatus === 'paid'
    && queue[0].status === 'accepted' && Number.isFinite(Date.parse(queue[0].acceptedAt)), 'fixture_kitchen_order_mismatch');
  report.kitchen = { paidOrderCount: queue.length, visibleMsAfterVerifiedRead: Math.round(performance.now() - verifiedReadAt) };
  if (board) {
    report.phase = 'kitchen_browser_recovery';
    report.browser.recovery = await board.observeRecovery({ orderId: order.orderId });
  }
  report.phase = 'complete';
}

async function main() {
  const startedAt = performance.now();
  const browserCheck = process.env.CRUSTCAPER_HTTPS_TEST_KITCHEN_RESTART === '1';
  const directory = process.env.CRUSTCAPER_HTTPS_TEST_EVIDENCE_DIR;
  const report = { recordedAt: new Date().toISOString(), phase: 'preflight', passed: false, errors: [] };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), browserCheck ? 175000 : 145000).unref();
  const interrupt = () => controller.abort();
  for (const event of ['SIGINT', 'SIGTERM']) process.on(event, interrupt);
  const { signal } = controller;
  let fixture;
  let kitchen;
  let board;
  try {
    ensure(process.argv.length === 2 && process.env.CRUSTCAPER_HTTPS_TEST_PAYMENT_RESTART === '1', 'fixture_restart_mode_required');
    const project = process.env.CRUSTCAPER_HTTPS_TEST_DOCKER_PROJECT;
    const caFile = process.env.CRUSTCAPER_HTTPS_TEST_CA;
    fixture = await openStorefrontFixture({ project, caFile, signal });
    const containers = await restartContainers(signal, project, fixture);
    const request = restrictRequest(fixture.request);
    kitchen = await openKitchenSession({ request, project });
    if (browserCheck) {
      report.phase = 'kitchen_browser_sign_in';
      const { openKitchenBoard } = require('./storefront-restart-kitchen.cjs');
      board = await openKitchenBoard({ caFile, evidence: directory, signal,
        credentials: () => provisionKitchenCredentials(project) });
    }
    await exercise({ signal, project, request, kitchen, board, containers, report });
  } catch (error) {
    report.errors.push(signal.aborted ? 'fixture_interrupted' : failureCode(error));
  } finally {
    try {
      await board?.close();
    } catch {
      report.errors.push('fixture_kitchen_board_close_failed');
    }
    try {
      await kitchen?.close();
    } catch {
      report.errors.push('fixture_kitchen_session_revoke_failed');
    }
    fixture?.close();
    clearTimeout(timeout);
    for (const event of ['SIGINT', 'SIGTERM']) process.off(event, interrupt);
  }

  report.elapsedMs = Math.round(performance.now() - startedAt);
  report.passed = report.errors.length === 0;
  const json = JSON.stringify(report, null, 2) + '\n';
  if (directory) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'storefront-payment-restart.json'), json);
  }
  process.stdout.write(json);
  if (!report.passed) process.exitCode = 1;
}

main().catch(() => {
  console.error('storefront_payment_restart_failed');
  process.exitCode = 1;
});
