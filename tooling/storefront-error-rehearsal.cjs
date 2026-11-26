const { execFile, spawnSync } = require('node:child_process');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const { request: httpsRequest } = require('node:https');
const { dirname, join } = require('node:path');
const { promisify } = require('node:util');
const { openStorefrontFixture } = require('./storefront-load.cjs');

const execute = promisify(execFile);
const database = 'storefront_fixture';
const detachedQuotes = 'crustcaper_fixture_r44_quotes';
const fixtureLabel = 'crustcaper.fixture.error-rehearsal';
const apiArgs = ['-Dloader.path=/fixture/classes/', '-Dloader.main=com.crustcaper.api.payment.WebCheckoutFixture',
  '-cp', '/app/app.jar', 'org.springframework.boot.loader.launch.PropertiesLauncher'];
const host = 'crustcaper.test';
const meterPath = '/actuator/commerceerrors';
const readinessPath = '/actuator/health/readiness';
const menuPath = '/api/v1/stores/kigali/menu?channel=web&locale=en';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const quoteRequestsPerWindow = 3;

class RehearsalFailure extends Error {}

function ensure(condition, code) {
  if (!condition) throw new RehearsalFailure(code);
}

async function docker(signal, ...args) {
  try {
    const { stdout } = await execute('docker', args, {
      signal, encoding: 'utf8', timeout: 10000, windowsHide: true, maxBuffer: 64 * 1024,
    });
    return stdout.trim();
  } catch {
    throw new RehearsalFailure('error_fixture_docker_failed');
  }
}

async function scopedContainer(signal, project, service, expectedId) {
  const id = expectedId ?? await docker(signal, 'ps', '--no-trunc', '--filter', `label=com.docker.compose.project=${project}`,
    '--filter', `label=com.docker.compose.service=${service}`, '--format', '{{.ID}}');
  ensure(/^[a-f0-9]{12,64}$/.test(id), 'error_fixture_container_id');
  const fields = ['.Id', '(index .Config.Labels "com.docker.compose.project")', '(index .Config.Labels "com.docker.compose.service")',
    `(index .Config.Labels "${fixtureLabel}")`, '.State.Status', '.Path', '.Args', '.HostConfig.PortBindings'];
  const format = fields.map(field => `{{json ${field}}}`).join('|');
  const output = await docker(signal, 'inspect', '--type', 'container', '--format', format, id);
  const [fullId, owner, role, marker, status, path, args, ports] = output.split('|').map(JSON.parse);
  ensure(/^[a-f0-9]{64}$/.test(fullId) && fullId.startsWith(id) && owner === project && role === service
    && status === 'running', 'error_fixture_container_scope');
  if (service !== 'edge') {
    ensure(marker === '1' && (!ports || Object.keys(ports).length === 0), 'error_fixture_disposable_scope');
  }
  if (service === 'api') {
    ensure(path === 'java' && Array.isArray(args) && args.length === apiArgs.length
      && apiArgs.every((value, index) => value === args[index]), 'error_fixture_api_signature');
  }
  return fullId;
}

function databaseCommand(signal, postgres, sql) {
  return docker(signal, 'exec', postgres, 'psql', '-XAtq', '--no-password', '-v', 'ON_ERROR_STOP=1',
    '-U', database, '-d', database, '-c', sql);
}

async function initialRelation(signal, postgres) {
  const row = await databaseCommand(signal, postgres, `
    SELECT current_database(), current_user, to_regclass('public.quotes')::oid,
      to_regclass('public.${detachedQuotes}') IS NULL,
      NOT EXISTS (SELECT 1 FROM public.orders),
      (SELECT count(*) = 1 FROM public.stores WHERE id = 'kigali' AND open),
      (SELECT count(*) = 1 FROM public.pickup_slots WHERE store_id = 'kigali' AND id = 'fixture-slot-0')
    `);
  const [name, user, oid, noDetached, noOrders, fixtureStore, fixtureSlot] = row.split('|');
  ensure(name === database && user === database && /^[1-9][0-9]{0,9}$/.test(oid ?? '')
    && [noDetached, noOrders, fixtureStore, fixtureSlot].every(value => value === 't'), 'error_fixture_database_scope');
  return oid;
}

function changeQuoteRelation(signal, postgres, oid, restore) {
  ensure(/^[1-9][0-9]{0,9}$/.test(oid), 'error_fixture_quote_relation');
  const change = restore ? `
    IF to_regclass('public.quotes')::oid = '${oid}'::oid AND to_regclass('public.${detachedQuotes}') IS NULL THEN
      RETURN;
    END IF;
    IF to_regclass('public.quotes') IS NOT NULL OR to_regclass('public.${detachedQuotes}')::oid IS DISTINCT FROM '${oid}'::oid THEN
      RAISE EXCEPTION 'Fixture quote relation changed';
    END IF;
    ALTER TABLE public.${detachedQuotes} RENAME TO quotes;
  ` : `
    IF to_regclass('public.quotes')::oid IS DISTINCT FROM '${oid}'::oid OR to_regclass('public.${detachedQuotes}') IS NOT NULL THEN
      RAISE EXCEPTION 'Fixture quote relation changed';
    END IF;
    ALTER TABLE public.quotes RENAME TO ${detachedQuotes};
  `;
  return databaseCommand(signal, postgres, `
    BEGIN;
    SET LOCAL lock_timeout = '3s';
    SET LOCAL statement_timeout = '6s';
    DO $fixture$
    BEGIN
      IF current_database() <> '${database}' OR current_user <> '${database}' THEN
        RAISE EXCEPTION 'Fixture database identity changed';
      END IF;
      ${change}
    END $fixture$;
    COMMIT;
  `);
}

async function publicMeterStatus(signal, caFile) {
  const ca = await readFile(caFile);
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      hostname: '127.0.0.1', port: 443, servername: host, path: meterPath, ca, rejectUnauthorized: true,
      headers: { host }, agent: false, signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
    }, response => {
      response.on('error', reject);
      response.on('end', () => resolve(response.statusCode));
      response.resume();
    });
    request.on('error', reject);
    request.end();
  });
}

async function privateJson(signal, edge, path) {
  return JSON.parse(await docker(signal, 'exec', edge, 'wget', '-q', '-O', '-', 'http://api:8080' + path));
}

async function snapshot(signal, edge) {
  const { instanceId, requests, serverErrors } = await privateJson(signal, edge, meterPath);
  ensure(uuid.test(instanceId) && Number.isSafeInteger(requests) && requests >= 0
    && Number.isSafeInteger(serverErrors) && serverErrors >= 0 && serverErrors <= requests, 'error_fixture_counter_shape');
  return { instanceId, requests, serverErrors };
}

async function checkHealth(signal, edge, request) {
  const readiness = await privateJson(signal, edge, readinessPath);
  const menu = await request(menuPath);
  ensure(readiness.status === 'UP' && menu.status === 200 && menu.data?.store?.id === 'kigali'
    && menu.data.store.open === true, 'error_fixture_health_changed');
  return menu.data;
}

function checkMonitor(report, snapshots) {
  const script = join(dirname(module.filename), '..', 'server', 'tooling', 'api-error-watch.mjs');
  const monitor = spawnSync(process.execPath, [script], {
    input: snapshots.map(value => JSON.stringify(value)).join('\n') + '\n', encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'], timeout: 8000, windowsHide: true, maxBuffer: 64 * 1024,
  });
  // A finite rehearsal closes the producer stream. The CLI treats producer EOF as unhealthy for supervisors.
  ensure(!monitor.error && monitor.status === 1, 'error_fixture_monitor_cli_failed');
  const events = monitor.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line));
  ensure(events.map(({ event }) => event).join(',') === 'ready,incident,recovered', 'error_fixture_unexpected_transitions');
  report.events = events.map(({ event, requests, serverErrors, errorRatePercent }, index) => {
    if (index === 0) return { event };
    const window = report.windows[index === 1 ? 1 : 3];
    ensure(requests === window.requests && serverErrors === window.serverErrors
      && errorRatePercent === 100 * serverErrors / requests, 'error_fixture_event_counter_mismatch');
    return { event, requests, serverErrors, errorRatePercent };
  });
}

async function rehearse(signal, project, caFile, fixture, report) {
  const [edge, api, postgres] = await Promise.all([
    scopedContainer(signal, project, 'edge', fixture.edge), scopedContainer(signal, project, 'api'),
    scopedContainer(signal, project, 'postgres'),
  ]);
  ensure(new Set([edge, api, postgres]).size === 3, 'error_fixture_services_not_separate');
  const oid = await initialRelation(signal, postgres);
  const request = fixture.request;
  report.publicMeterBefore = await publicMeterStatus(signal, caFile);
  ensure(report.publicMeterBefore === 404, 'error_fixture_meter_exposed');
  const menu = await checkHealth(signal, edge, request);
  const sku = menu.products.find(product => product.sku === 'double-smash' && product.available === true);
  ensure(Number.isSafeInteger(sku?.price) && menu.slots.some(slot => slot.id === 'fixture-slot-0' && slot.available),
    'error_fixture_quote_catalog');
  const guest = await request('/api/v1/guest-sessions', { method: 'POST' });
  ensure(guest.status === 200 && typeof guest.data?.accessToken === 'string', 'error_fixture_guest_unavailable');
  async function quote() {
    return request('/api/v1/quotes', {
      method: 'POST', headers: { Authorization: 'Bearer ' + guest.data.accessToken },
      body: { storeId: 'kigali', slotId: 'fixture-slot-0', lines: [
        { sku: sku.sku, modifierIds: [], quantity: 1, unitPrice: sku.price },
      ] },
    });
  }
  ensure((await quote()).status === 200, 'error_fixture_quote_baseline');
  const samples = [await snapshot(signal, edge)];
  async function sampleWindow(failing) {
    const statuses = [];
    for (let i = 0; i < quoteRequestsPerWindow; i++) {
      const response = await quote();
      ensure(failing ? response.status === 503 && response.data?.code === 'service_unavailable'
        && uuid.test(response.headers['x-request-id']) : response.status === 200 && uuid.test(response.data?.quoteId),
      'error_fixture_unexpected_quote_result');
      statuses.push(response.status);
    }
    await checkHealth(signal, edge, request);
    const previous = samples.at(-1);
    const current = await snapshot(signal, edge);
    ensure(current.instanceId === previous.instanceId, 'error_fixture_instance_changed');
    const requests = current.requests - previous.requests;
    const serverErrors = current.serverErrors - previous.serverErrors;
    ensure(requests === quoteRequestsPerWindow + 1 && serverErrors === (failing ? quoteRequestsPerWindow : 0),
      'error_fixture_counter_delta');
    samples.push(current);
    report.windows.push({ phase: failing ? 'fault' : 'healthy', requests, serverErrors, quoteStatuses: statuses, menuStatus: 200, readinessUp: true });
  }

  const restore = async restorationSignal => {
    await scopedContainer(restorationSignal, project, 'postgres', postgres);
    await changeQuoteRelation(restorationSignal, postgres, oid, true);
    ensure(await initialRelation(restorationSignal, postgres) === oid, 'error_fixture_restore_identity');
    report.tableRestored = true;
  };
  let renameStarted = false;
  try {
    renameStarted = true;
    await changeQuoteRelation(signal, postgres, oid, false);
    await sampleWindow(true);
    await sampleWindow(true);
    await restore(signal);
    renameStarted = false;
    await sampleWindow(false);
    await sampleWindow(false);
    report.publicMeterAfter = await publicMeterStatus(signal, caFile);
    ensure(report.publicMeterAfter === 404, 'error_fixture_meter_exposed');
    checkMonitor(report, samples);
  } finally {
    if (renameStarted) {
      try {
        await restore(AbortSignal.timeout(15000));
      } catch {
        report.errors.push('error_fixture_restore_failed');
      }
    }
  }
}

async function main() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 105000).unref();
  const interrupt = () => controller.abort();
  for (const event of ['SIGINT', 'SIGTERM']) process.on(event, interrupt);
  const { signal } = controller;
  const report = { recordedAt: new Date().toISOString(), windows: [], events: [], errors: [], passed: false };
  let fixture;
  try {
    ensure(process.argv.length === 2 && process.env.CRUSTCAPER_HTTPS_TEST_ERROR_REHEARSAL === '1',
      'error_fixture_mode_required');
    const project = process.env.CRUSTCAPER_HTTPS_TEST_DOCKER_PROJECT;
    const caFile = process.env.CRUSTCAPER_HTTPS_TEST_CA;
    fixture = await openStorefrontFixture({ project, caFile, signal });
    await rehearse(signal, project, caFile, fixture, report);
  } catch (error) {
    report.errors.push(signal.aborted ? 'error_fixture_interrupted'
      : error instanceof RehearsalFailure ? error.message : 'error_fixture_rehearsal_failed');
  } finally {
    fixture?.close();
    clearTimeout(timeout);
    for (const event of ['SIGINT', 'SIGTERM']) process.off(event, interrupt);
  }
  report.passed = report.errors.length === 0;
  const output = JSON.stringify(report, null, 2) + '\n';
  const directory = process.env.CRUSTCAPER_HTTPS_TEST_EVIDENCE_DIR;
  if (directory) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'storefront-error-rehearsal.json'), output);
  }
  process.stdout.write(output);
  if (!report.passed) process.exitCode = 1;
}

main().catch(() => {
  console.error('storefront_error_rehearsal_failed');
  process.exitCode = 1;
});
