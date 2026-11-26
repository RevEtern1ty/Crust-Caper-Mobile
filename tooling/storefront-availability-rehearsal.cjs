const { execFile } = require('node:child_process');
const dns = require('node:dns');
const { mkdir, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');
const { openStorefrontFixture } = require('./storefront-load.cjs');

const execute = promisify(execFile);
const host = 'crustcaper.test';
const apiBaseUrl = 'https://' + host + '/api/v1';
const storeId = 'kigali';
const menuPath = '/api/v1/stores/kigali/menu?channel=web&locale=en';
const surfaces = ['menu_api', 'menu_en', 'menu_rw', 'operator_shell', 'operator_auth'];
const apiArgs = ['-Dloader.path=/fixture/classes/', '-Dloader.main=com.crustcaper.api.payment.WebCheckoutFixture',
  '-cp', '/app/app.jar', 'org.springframework.boot.loader.launch.PropertiesLauncher'];
const containerPattern = /^[a-f0-9]{64}$/;
const intervalMs = 1000;

class RehearsalFailure extends Error {}

function ensure(condition, code) {
  if (!condition) throw new RehearsalFailure(code);
}

async function docker(signal, ...args) {
  try {
    const { stdout } = await execute('docker', args, {
      signal, encoding: 'utf8', timeout: 16000, windowsHide: true, maxBuffer: 64 * 1024,
    });
    return stdout.trim();
  } catch {
    throw new RehearsalFailure('availability_docker_operation_failed');
  }
}

async function inspect(signal, project, service, id) {
  ensure(/^[a-f0-9]{12,64}$/.test(id), 'availability_container_id');
  // Select lifecycle and identity fields only. Inspection of complete environments would include credentials.
  const fields = [
    '.Id', '(index .Config.Labels "com.docker.compose.project")', '(index .Config.Labels "com.docker.compose.service")',
    '.State.Status', '.State.StartedAt', '.Path', '.Args', '.HostConfig.PortBindings',
  ].map(value => `{{json ${value}}}`).join('|');
  const output = await docker(signal, 'inspect', '--type', 'container', '--format', fields, id);
  const [fullId, owner, role, status, startedAt, path, args, ports] = output.split('|').map(JSON.parse);
  ensure(containerPattern.test(fullId) && fullId.startsWith(id) && owner === project && role === service
    && Number.isFinite(Date.parse(startedAt)), 'availability_container_scope');
  return { id: fullId, status, startedAt, path, args, ports };
}

async function running(signal, project, service, id) {
  const candidate = id ?? await docker(signal, 'ps', '--no-trunc', '--filter', `label=com.docker.compose.project=${project}`,
    '--filter', `label=com.docker.compose.service=${service}`, '--format', '{{.ID}}');
  const value = await inspect(signal, project, service, candidate);
  ensure(value.status === 'running', 'availability_container_not_running');
  return value;
}

function ensureStoppable(container, service) {
  ensure(!container.ports || Object.keys(container.ports).length === 0, 'availability_target_published');
  if (service === 'api') {
    ensure(container.path === 'java' && Array.isArray(container.args) && container.args.length === apiArgs.length
      && apiArgs.every((value, index) => value === container.args[index]), 'availability_api_fixture_signature');
  }
}

async function unchangedPeers(signal, project, originals, stoppedService) {
  for (const [service, original] of Object.entries(originals)) {
    if (service === stoppedService) continue;
    const current = await running(signal, project, service, original.id);
    ensure(current.startedAt === original.startedAt, 'availability_peer_restarted');
  }
}

function fixtureLookup(hostname, options, callback) {
  const done = typeof options === 'function' ? options : callback;
  if (hostname !== host) {
    const error = Object.assign(new Error('Unexpected fixture DNS name'), { code: 'ENOTFOUND' });
    process.nextTick(done, error);
  } else if (options?.all) {
    process.nextTick(done, null, [{ address: '127.0.0.1', family: 4 }]);
  } else {
    process.nextTick(done, null, '127.0.0.1', 4);
  }
}

function eventRecord(phase, { event, at, orderingOpen, checks }) {
  ensure(['ready', 'incident', 'recovered'].includes(event) && Number.isFinite(Date.parse(at))
    && Array.isArray(checks) && checks.length === surfaces.length
    && (orderingOpen == null || typeof orderingOpen === 'boolean'), 'availability_event_shape');
  const details = checks.map(({ check, ok, status, code, elapsedMs }, index) => {
    ensure(check === surfaces[index] && typeof ok === 'boolean' && (status == null || (Number.isInteger(status)
      && status >= 100 && status <= 599)) && typeof code === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(code)
      && Number.isFinite(elapsedMs) && elapsedMs >= 0, 'availability_check_shape');
    return { check, ok, status: status ?? null, code, elapsedMs };
  });
  return { phase, event, at, orderingOpen: orderingOpen ?? null, checks: details };
}

function verifyChecks(event, failed) {
  ensure(event.checks.every(({ check, ok }) => ok === !failed.includes(check)), 'availability_unexpected_failed_surfaces');
  if (!failed.includes('menu_api')) ensure(event.orderingOpen === false, 'availability_planned_pause_mismatch');
}

async function rehearse(signal, project, fixture, watchLibrary, report) {
  const originals = {};
  for (const service of ['edge', 'postgres', 'api', 'catalog']) {
    originals[service] = await running(signal, project, service, service === 'edge' ? fixture.edge : undefined);
  }
  ensure(new Set(Object.values(originals).map(({ id }) => id)).size === 4, 'availability_services_not_separate');
  for (const service of ['api', 'catalog']) ensureStoppable(originals[service], service);
  const pausedMenu = await fixture.request(menuPath);
  ensure(pausedMenu.status === 200 && pausedMenu.data?.store?.id === storeId
    && pausedMenu.data.store.open === false, 'availability_planned_pause_mismatch');

  let phase = 'planned_pause';
  let watchEnded = false;
  let watchError;
  const stopWatch = new AbortController();
  const watchSignal = AbortSignal.any([signal, stopWatch.signal]);
  const watcher = watchLibrary.watchAvailability({
    probe: probeSignal => watchLibrary.checkAvailability({ apiBaseUrl, storeId, signal: probeSignal ?? watchSignal }),
    emit: event => { report.events.push(eventRecord(phase, event)); },
    intervalMs, signal: watchSignal,
  }).catch(error => {
    if (!watchSignal.aborted) watchError = error;
  }).finally(() => { watchEnded = true; });

  async function waitForEvent(event, timeoutMs) {
    const deadline = performance.now() + timeoutMs;
    while (!signal.aborted && performance.now() < deadline) {
      if (watchError instanceof RehearsalFailure) throw watchError;
      ensure(!watchEnded, 'availability_monitor_stopped');
      const match = report.events.find(record => record.phase === phase && record.event === event);
      if (match) return match;
      await delay(100, undefined, { signal });
    }
    throw new RehearsalFailure('availability_event_timeout');
  }

  try {
    verifyChecks(await waitForEvent('ready', 15000), []);
    for (const [service, failed] of [['catalog', ['menu_en', 'menu_rw']], ['api', surfaces]]) {
      phase = `${service}_outage`;
      const target = originals[service];
      const before = await running(signal, project, service, target.id);
      ensureStoppable(before, service);
      ensure(before.startedAt === target.startedAt, 'availability_target_restarted_early');
      await docker(signal, 'stop', '--time', '10', before.id);
      const stopped = await inspect(signal, project, service, before.id);
      ensure(stopped.status === 'exited' && stopped.startedAt === before.startedAt, 'availability_target_not_stopped');
      verifyChecks(await waitForEvent('incident', 15000), failed);
      await unchangedPeers(signal, project, originals, service);

      const stillStopped = await inspect(signal, project, service, before.id);
      ensureStoppable(stillStopped, service);
      ensure(stillStopped.status === 'exited' && stillStopped.startedAt === before.startedAt, 'availability_target_changed');
      await docker(signal, 'start', stillStopped.id);
      const restarted = await running(signal, project, service, before.id);
      ensure(Date.parse(restarted.startedAt) > Date.parse(before.startedAt), 'availability_target_not_restarted');
      verifyChecks(await waitForEvent('recovered', 45000), []);
      await unchangedPeers(signal, project, originals, service);
      originals[service] = restarted;
      report.services.push({ service, stopped: true, restarted: true, peersUnchanged: true });
    }
    ensure(report.events.map(({ phase: step, event }) => `${step}:${event}`).join(',') ===
      'planned_pause:ready,catalog_outage:incident,catalog_outage:recovered,api_outage:incident,api_outage:recovered',
    'availability_unexpected_transitions');
  } finally {
    stopWatch.abort();
    await watcher;
  }
}

async function main() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 150000).unref();
  const interrupt = () => controller.abort();
  for (const event of ['SIGINT', 'SIGTERM']) process.on(event, interrupt);
  const { signal } = controller;
  const report = { recordedAt: new Date().toISOString(), intervalMs, events: [], services: [], errors: [], passed: false };
  const lookup = dns.lookup;
  let fixture;
  try {
    ensure(process.argv.length === 2 && process.env.CRUSTCAPER_HTTPS_TEST_AVAILABILITY === '1', 'availability_fixture_mode_required');
    const project = process.env.CRUSTCAPER_HTTPS_TEST_DOCKER_PROJECT;
    const caFile = process.env.CRUSTCAPER_HTTPS_TEST_CA;
    ensure(caFile && process.env.NODE_EXTRA_CA_CERTS === caFile && process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0',
      'availability_fixture_ca_required');
    fixture = await openStorefrontFixture({ project, caFile, signal });
    dns.lookup = fixtureLookup;
    const watchLibrary = await import('../server/tooling/storefront-availability.mjs');
    await rehearse(signal, project, fixture, watchLibrary, report);
  } catch (error) {
    report.errors.push(signal.aborted ? 'availability_interrupted'
      : error instanceof RehearsalFailure ? error.message : 'availability_rehearsal_failed');
  } finally {
    fixture?.close();
    dns.lookup = lookup;
    clearTimeout(timeout);
    for (const event of ['SIGINT', 'SIGTERM']) process.off(event, interrupt);
  }
  report.passed = report.errors.length === 0;
  const output = JSON.stringify(report, null, 2) + '\n';
  const directory = process.env.CRUSTCAPER_HTTPS_TEST_EVIDENCE_DIR;
  if (directory) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'storefront-availability-rehearsal.json'), output);
  }
  process.stdout.write(output);
  if (!report.passed) process.exitCode = 1;
}

main().catch(() => {
  console.error('storefront_availability_rehearsal_failed');
  process.exitCode = 1;
});
