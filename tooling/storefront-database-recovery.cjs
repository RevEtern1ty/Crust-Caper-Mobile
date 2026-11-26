const { execFile } = require('node:child_process');
const { mkdir, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');
const { openStorefrontFixture } = require('./storefront-load.cjs');
const { createRecoveryJourney } = require('./storefront-recovery-journey.cjs');

const execute = promisify(execFile);
const source = 'storefront_fixture';
const recovered = 'storefront_recovered';
const fixtureLabel = 'crustcaper.fixture.database-recovery';
const application = '-Dloader.main=com.crustcaper.api.payment.WebCheckoutFixture';
const menuPath = '/api/v1/stores/kigali/menu?channel=web&locale=en';
const archiveDirectory = /^\/tmp\/crustcaper-recovery\.[A-Za-z0-9]{8}$/;
const postgresEnvironment = `
  set -euo pipefail
  [[ "$POSTGRES_DB" == storefront_fixture && "$POSTGRES_USER" == storefront_fixture && -n "$POSTGRES_PASSWORD" ]]
  unset PGSERVICE PGSERVICEFILE PGHOSTADDR PGOPTIONS
  export PGHOST=127.0.0.1 PGPORT=5432 PGSSLMODE=disable PGUSER="$POSTGRES_USER" PGPASSWORD="$POSTGRES_PASSWORD"
  export PGDATABASE="$1"
  shift
  exec "$@"
`;

class RecoveryFailure extends Error {}

function requireCondition(condition, code) {
  if (!condition) throw new RecoveryFailure(code);
}

async function docker(signal, args, timeout = 9000) {
  try {
    const { stdout } = await execute('docker', args, {
      signal, encoding: 'utf8', timeout, maxBuffer: 64 * 1024, windowsHide: true,
    });
    return stdout.trim();
  } catch {
    throw new RecoveryFailure('database_recovery_docker_failed');
  }
}

async function inspect(signal, project, service, id) {
  const resolved = id ?? await docker(signal, ['ps', '--no-trunc', '--filter', `label=com.docker.compose.project=${project}`,
    '--filter', `label=com.docker.compose.service=${service}`, '--format', '{{.ID}}']);
  requireCondition(/^[a-f0-9]{12,64}$/.test(resolved), 'database_recovery_container_identity');
  const fields = ['.Id', '(index .Config.Labels "com.docker.compose.project")', '(index .Config.Labels "com.docker.compose.service")',
    `(index .Config.Labels "${fixtureLabel}")`, '.State.Status', '.State.StartedAt', '.Args',
    '.HostConfig.PortBindings', '.HostConfig.RestartPolicy.Name'];
  const output = await docker(signal, ['inspect', '--type', 'container', '--format',
    fields.map(field => `{{json ${field}}}`).join('|'), resolved]);
  const [fullId, owner, role, marker, status, startedAt, args, ports, restartPolicy] = output.split('|').map(JSON.parse);
  requireCondition(/^[a-f0-9]{64}$/.test(fullId) && fullId.startsWith(resolved) && owner === project && role === service
    && Number.isFinite(Date.parse(startedAt)), 'database_recovery_container_scope');
  if (['api', 'postgres', 'provider'].includes(service)) {
    requireCondition(marker === '1' && (!ports || Object.keys(ports).length === 0), 'database_recovery_disposable_scope');
  }
  return { id: fullId, status, startedAt, args, restartPolicy };
}

async function apiDatabase(signal, container, database, flag) {
  requireCondition(container.status === 'running' && Array.isArray(container.args)
    && container.args.includes(application) && container.args.at(-1) === flag && container.restartPolicy === 'no',
  'database_recovery_api_signature');
  // Select a boolean marker. Other environment values can include credentials.
  const expected = `CRUSTCAPER_DB_URL=jdbc:postgresql://postgres:5432/${database}`;
  const format = `{{range .Config.Env}}{{if eq . "${expected}"}}true{{end}}{{end}}`;
  requireCondition(await docker(signal, ['inspect', '--type', 'container', '--format', format, container.id]) === 'true',
    'database_recovery_api_database');
}

function postgres(signal, container, database, command, timeout) {
  requireCondition(database === source || database === recovered, 'database_recovery_unexpected_database');
  return docker(signal, ['exec', container.id, 'bash', '-c', postgresEnvironment, 'crustcaper-rehearsal', database, ...command], timeout);
}

function sql(signal, container, database, query) {
  return postgres(signal, container, database, ['psql', '-XAtq', '--no-password', '-v', 'ON_ERROR_STOP=1', '-c', query]);
}

async function databaseSnapshot(signal, container, database) {
  const output = await sql(signal, container, database, `
    SELECT current_database(), current_user, current_setting('server_version_num'),
      (SELECT count(*) FROM orders),
      (SELECT count(*) FROM orders WHERE payment_status = 'paid'),
      (SELECT count(*) FROM orders WHERE payment_status = 'processing'),
      (SELECT count(*) FROM payment_attempts),
      (SELECT count(*) FROM payment_attempts WHERE status = 'paid'),
      (SELECT count(*) FROM fiscal_receipts),
      (SELECT count(*) FROM fiscal_receipts WHERE sha256 = sha256(document)),
      (SELECT count(*) FROM payment_exceptions),
      (SELECT count(*) FROM flyway_schema_history WHERE success),
      (SELECT count(*) FROM flyway_schema_history WHERE NOT success),
      (SELECT encode(sha256(convert_to(string_agg(concat_ws(':', installed_rank, version, script, checksum, success),
         E'\\n' ORDER BY installed_rank), 'UTF8')), 'hex') FROM flyway_schema_history),
      (SELECT count(*) = 1 FROM stores WHERE id = 'kigali' AND open),
      (SELECT count(*) = 1 FROM pickup_slots WHERE store_id = 'kigali' AND id = 'fixture-slot-0')
    `);
  const values = output.split('|');
  const [name, user, version, ...data] = values;
  const [orders, paidOrders, processingOrders, attempts, paidAttempts, receipts, intactReceipts,
    paymentExceptions, migrations, failedMigrations] = data.slice(0, 10).map(Number);
  const [schemaStamp, store, slot] = data.slice(10);
  requireCondition(values.length === 16 && name === database && user === source && /^17[0-9]{4}$/.test(version)
    && data.slice(0, 10).every(value => /^[0-9]+$/.test(value) && Number.isSafeInteger(Number(value)))
    && /^[a-f0-9]{64}$/.test(schemaStamp) && failedMigrations === 0 && migrations > 0
    && store === 't' && slot === 't', 'database_recovery_database_identity');
  return { schemaStamp, version: Number(version), orders, paidOrders, processingOrders, attempts, paidAttempts,
    receipts, intactReceipts, paymentExceptions, migrations };
}

const counts = ({ schemaStamp, ...snapshot }) => snapshot;

function sameSnapshot(left, right) {
  return Object.keys(left).every(key => left[key] === right[key]);
}

function verifyOrders(snapshot, orders, paidOrders, processingOrders, attempts, paidAttempts, receipts) {
  requireCondition(snapshot.orders === orders && snapshot.paidOrders === paidOrders && snapshot.processingOrders === processingOrders
    && snapshot.attempts === attempts && snapshot.paidAttempts === paidAttempts && snapshot.receipts === receipts
    && snapshot.intactReceipts === receipts && snapshot.paymentExceptions === 0, 'database_recovery_unexpected_persisted_counts');
}

function witness(observed, expected) {
  requireCondition(Object.entries(expected).every(([name, value]) => observed?.[name] === value),
    'database_recovery_unexpected_journey_evidence');
  return expected;
}

async function providerState(signal, edge, open, paid) {
  const text = await docker(signal, ['exec', edge.id, 'wget', '-q', '-O', '-', 'http://provider:18432/fixture/state']);
  const { openCalls, paidCharges, verifyCalls, firstPaidVerificationHeld } = JSON.parse(text);
  requireCondition(openCalls === open && paidCharges === paid && Number.isSafeInteger(verifyCalls)
    && verifyCalls >= 0 && firstPaidVerificationHeld === false, 'database_recovery_provider_state');
  return { opened: openCalls, paid: paidCharges, verificationCalls: verifyCalls };
}

async function unchangedPeers(signal, project, peers) {
  for (const [service, original] of Object.entries(peers)) {
    const current = await inspect(signal, project, service, original.id);
    requireCondition(current.status === 'running' && current.startedAt === original.startedAt, 'database_recovery_peer_restarted');
  }
}

async function waitReady(signal, edge, request) {
  const deadline = performance.now() + 40000;
  while (!signal.aborted && performance.now() < deadline) {
    try {
      const readiness = await docker(signal, ['exec', edge.id, 'wget', '-q', '-O', '-', 'http://api:8080/actuator/health/readiness']);
      if (JSON.parse(readiness).status === 'UP') {
        const menu = await request(menuPath);
        if (menu.status === 200 && menu.data?.store?.id === 'kigali') return;
      }
    } catch {
      // Caddy and Spring need separate readiness checks after changing the API service.
    }
    await delay(500, undefined, { signal });
  }
  throw new RecoveryFailure('database_recovery_api_readiness_timeout');
}

function elapsed(startedAt) {
  return Math.round(performance.now() - startedAt);
}

async function runDatabaseRecovery({ project, caFile, evidence, stopSource, startRecovered, signal, fixtureMfaKey }) {
  const report = {
    recordedAt: new Date().toISOString(), scope: 'local_disposable_cluster_separate_recovery_database',
    phase: 'preflight', provider: {}, errors: [], passed: false,
  };
  const active = AbortSignal.any([signal, AbortSignal.timeout(175000)]);
  let fixture;
  let journey;
  let postgresContainer;
  let scratch;
  try {
    fixture = await openStorefrontFixture({ project, caFile, signal: active });
    const [edge, database, provider, api, catalog] = await Promise.all([
      inspect(active, project, 'edge', fixture.edge), inspect(active, project, 'postgres'),
      inspect(active, project, 'provider'), inspect(active, project, 'api'), inspect(active, project, 'catalog'),
    ]);
    requireCondition(new Set([edge.id, database.id, provider.id, api.id, catalog.id]).size === 5
      && [edge, database, provider, api, catalog].every(container => container.status === 'running')
      && Array.isArray(provider.args) && provider.args.includes(application) && provider.args.at(-1) === '--recovery-provider',
    'database_recovery_fixture_scope');
    postgresContainer = database;
    const peers = { edge, postgres: database, provider, catalog };
    await apiDatabase(active, api, source, '--restart-api');
    const initial = await databaseSnapshot(active, database, source);
    verifyOrders(initial, 0, 0, 0, 0, 0, 0);
    requireCondition(await sql(active, database, source,
      `SELECT NOT EXISTS (SELECT FROM pg_database WHERE datname = '${recovered}')`) === 't', 'database_recovery_target_exists');
    report.provider.initial = await providerState(active, edge, 0, 0);
    journey = await createRecoveryJourney({ request: fixture.request, project, signal: active, fixtureMfaKey });

    report.phase = 'backup';
    const seed = witness(await journey.seed(), { paidOrders: 1, paymentAttempts: 2, pendingAttempts: 1,
      attachedReceipts: 1, managerSessionAuthenticated: true, kitchenSessionAuthenticated: true });
    const beforeBackup = await databaseSnapshot(active, database, source);
    verifyOrders(beforeBackup, 2, 1, 1, 2, 1, 1);
    report.provider.atBackup = await providerState(active, edge, 2, 1);
    scratch = await postgres(active, database, source, ['mktemp', '-d', '/tmp/crustcaper-recovery.XXXXXXXX']);
    requireCondition(archiveDirectory.test(scratch), 'database_recovery_archive_path');
    const archive = scratch + '/backup.dump';
    const backupStartedAt = performance.now();
    const checksum = await postgres(active, database, source, ['bash', '/fixture/backup-postgres.sh', archive], 45000);
    const backupCompletedAt = performance.now();
    requireCondition(/^[a-f0-9]{64}$/.test(checksum), 'database_recovery_archive_checksum');
    const bytes = Number(await postgres(active, database, source, ['stat', '-c', '%s', archive]));
    requireCondition(Number.isSafeInteger(bytes) && bytes > 0, 'database_recovery_archive_size');
    requireCondition(sameSnapshot(await databaseSnapshot(active, database, source), beforeBackup), 'database_recovery_snapshot_changed');
    report.backup = { bytes, elapsedMs: Math.round(backupCompletedAt - backupStartedAt), counts: counts(beforeBackup), seed };

    report.phase = 'stop_source';
    const later = witness(await journey.commitAfterSnapshot(), { postSnapshotOrders: 1, pendingAttempts: 2, retainedGuestBinding: true });
    const afterSnapshot = await databaseSnapshot(active, database, source);
    verifyOrders(afterSnapshot, 3, 1, 2, 3, 1, 1);
    report.provider.afterSnapshot = await providerState(active, edge, 3, 1);
    report.postSnapshot = { ...later, observedMsAfterBackup: elapsed(backupCompletedAt) };
    const beforeStop = await inspect(active, project, 'api');
    requireCondition(beforeStop.id === api.id && beforeStop.startedAt === api.startedAt && beforeStop.status === 'running',
      'database_recovery_source_changed_before_stop');
    const sourceStopStartedAt = performance.now();
    await stopSource(active);
    const stopped = await inspect(active, project, 'api', api.id);
    requireCondition(stopped.status === 'exited' && stopped.startedAt === api.startedAt, 'database_recovery_source_still_running');
    report.sourceStoppedMs = elapsed(sourceStopStartedAt);
    await unchangedPeers(active, project, peers);
    report.paymentsWhileSourceStopped = witness(await journey.markPendingPaid(),
      { settledWithoutApi: 2, postSnapshotProviderPayments: 1 });
    report.provider.sourceStopped = await providerState(active, edge, 3, 3);
    requireCondition(sameSnapshot(await databaseSnapshot(active, database, source), afterSnapshot),
      'database_recovery_source_changed_while_stopped');

    report.phase = 'restore';
    const restoreStartedAt = performance.now();
    await postgres(active, database, source, ['env', `TMPDIR=${scratch}`, 'bash', '/fixture/restore-postgres.sh', archive,
      recovered, checksum], 45000);
    const restoreElapsedMs = elapsed(restoreStartedAt);
    const fromArchive = await databaseSnapshot(active, database, recovered);
    requireCondition(sameSnapshot(fromArchive, beforeBackup), 'database_recovery_restore_mismatch');
    report.restore = { elapsedMs: restoreElapsedMs, counts: counts(fromArchive), migrationHistoryMatches: true };

    report.phase = 'recovered_api';
    const beforeStart = await inspect(active, project, 'api', api.id);
    requireCondition(beforeStart.status === 'exited' && beforeStart.startedAt === api.startedAt, 'database_recovery_source_restarted');
    const targetStartedAt = performance.now();
    await startRecovered(active);
    const target = await inspect(active, project, 'api');
    requireCondition(target.id !== api.id && Date.parse(target.startedAt) > Date.parse(api.startedAt),
      'database_recovery_api_not_replaced');
    await apiDatabase(active, target, recovered, '--recovery-api');
    await waitReady(active, edge, fixture.request);
    report.recoveredApi = { readyAfterStartMs: elapsed(targetStartedAt), readyAfterRestoreStartedMs: elapsed(restoreStartedAt),
      readyAfterSourceStopStartedMs: elapsed(sourceStopStartedAt) };
    const reconcileStartedAt = performance.now();
    const originalJourney = witness(await journey.verifyRecovered(), {
      restoredPaidOrders: 2, restoredGuestSessions: 2, restoredStaffSessions: 2, restoredReceiptByteIdentical: true,
      restoredReceiptAccessScoped: true, originalPaymentAttemptsRetained: true, postSnapshotOrdersAbsent: 1,
      externalPaymentsRequiringReconciliation: 1,
    });
    const reconciled = await databaseSnapshot(active, database, recovered);
    verifyOrders(reconciled, 2, 2, 0, 2, 2, 1);
    report.provider.afterReconciliation = await providerState(active, edge, 3, 3);
    report.reconciled = { elapsedMs: elapsed(reconcileStartedAt), counts: counts(reconciled), originalJourney,
      unresolvedProviderPayments: report.provider.afterReconciliation.paid - reconciled.paidOrders };
    requireCondition(report.reconciled.unresolvedProviderPayments === 1, 'database_recovery_expected_reconciliation_gap');

    report.phase = 'isolated_new_order';
    const probeStartedAt = performance.now();
    const newOrderJourney = witness(await journey.verifyNewOrder(), { newPaidOrders: 1, paidOrdersInKitchen: 3 });
    const afterProbe = await databaseSnapshot(active, database, recovered);
    verifyOrders(afterProbe, 3, 3, 0, 3, 3, 1);
    report.provider.afterNewOrder = await providerState(active, edge, 4, 4);
    await unchangedPeers(active, project, peers);
    const current = await inspect(active, project, 'api', target.id);
    requireCondition(current.status === 'running' && current.startedAt === target.startedAt
      && sameSnapshot(await databaseSnapshot(active, database, source), afterSnapshot), 'database_recovery_final_scope_changed');
    report.isolatedNewOrder = { elapsedMs: elapsed(probeStartedAt), verifiedAfterSourceStopStartedMs: elapsed(sourceStopStartedAt),
      counts: counts(afterProbe), newOrderJourney };
    report.providerProcessUnchanged = true;
    report.sourceWitnessCountsUnchangedAfterStop = true;
    report.manualReconciliationRequired = true;
    report.phase = 'complete';
  } catch (error) {
    const code = typeof error?.code === 'string' && /^(?:recovery|checkout)_[a-z_]{2,48}$/.test(error.code)
      ? error.code : 'database_recovery_journey_failed';
    report.errors.push(active.aborted ? 'database_recovery_interrupted'
      : error instanceof RecoveryFailure ? error.message : code);
  } finally {
    try {
      await journey?.close();
    } catch {
      report.errors.push('database_recovery_session_cleanup_failed');
    }
    if (archiveDirectory.test(scratch ?? '')) {
      try {
        const cleanupSignal = AbortSignal.timeout(12000);
        const current = await inspect(cleanupSignal, project, 'postgres', postgresContainer.id);
        requireCondition(current.status === 'running' && current.startedAt === postgresContainer.startedAt,
          'database_recovery_cleanup_scope');
        await postgres(cleanupSignal, current, source, ['bash', '-c',
          'set -euo pipefail; [[ "$(readlink -f -- "$1")" == "$1" && -d "$1" ]]; rm -f -- "$1/backup.dump"; rmdir -- "$1"',
          'crustcaper-archive-cleanup', scratch]);
        report.archiveRemoved = true;
      } catch {
        report.errors.push('database_recovery_archive_cleanup_failed');
      }
    }
    fixture?.close();
  }
  report.passed = report.errors.length === 0;
  const output = JSON.stringify(report, null, 2) + '\n';
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await writeFile(join(evidence, 'storefront-database-recovery.json'), output);
  }
  process.stdout.write(output);
  requireCondition(report.passed, 'database_recovery_rehearsal_failed');
  return report;
}

module.exports = { runDatabaseRecovery };
