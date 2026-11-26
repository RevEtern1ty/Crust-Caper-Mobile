const { Buffer } = require('node:buffer');
const { execFile } = require('node:child_process');
const { mkdir, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');
const { openStorefrontFixture } = require('./storefront-load.cjs');
const { createRecoveryJourney, createRecoveryOffboarding, recoveryOffboardingScope } = require('./storefront-recovery-journey.cjs');
const { fixtureDatabaseUrl, postgresJdbcTlsQuery, postgresTlsRuntime } = require('./storefront-postgres-tls.cjs');

const execute = promisify(execFile);
const source = 'storefront_fixture';
const recovered = 'storefront_recovered';
const sourceService = 'postgres';
const recoveryService = 'postgres-recovery';
const recoveryMaintenance = 'postgres';
const maxArchiveBytes = 16 * 1024 * 1024;
const fixtureLabel = 'crustcaper.fixture.database-recovery';
const application = '-Dloader.main=com.crustcaper.api.payment.WebCheckoutFixture';
const menuPath = '/api/v1/stores/kigali/menu?channel=web&locale=en';
const archiveDirectory = /^\/tmp\/crustcaper-recovery\.[A-Za-z0-9]{8}$/;
const postgresEnvironment = `
  set -euo pipefail
  [[ "$POSTGRES_USER" == storefront_fixture && -n "$POSTGRES_PASSWORD" ]]
  case "$1" in
    postgres) [[ "$POSTGRES_DB" == storefront_fixture && "$2" == storefront_fixture ]] ;;
    postgres-recovery) [[ "$POSTGRES_DB" == postgres && ( "$2" == postgres || "$2" == storefront_recovered ) ]] ;;
    *) exit 2 ;;
  esac
  unset PGSERVICE PGSERVICEFILE PGHOSTADDR PGOPTIONS
  export PGHOST="$1" PGPORT=5432 PGSSLMODE=verify-full PGSSLROOTCERT=${postgresTlsRuntime}/ca.crt PGGSSENCMODE=disable
  export PGUSER="$POSTGRES_USER" PGPASSWORD="$POSTGRES_PASSWORD"
  export PGDATABASE="$2"
  shift 2
  exec "$@"
`;

class RecoveryFailure extends Error {}

function requireCondition(condition, code) {
  if (!condition) throw new RecoveryFailure(code);
}

async function docker(signal, args, timeout = 9000, input) {
  try {
    const operation = execute('docker', args, {
      signal, encoding: 'utf8', timeout, maxBuffer: 64 * 1024, windowsHide: true,
    });
    if (input !== undefined) {
      operation.child.stdin.on('error', () => {});
      operation.child.stdin.end(input);
    }
    const { stdout } = await operation;
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
    '.HostConfig.PortBindings', '.HostConfig.RestartPolicy.Name', '.Mounts'];
  const output = await docker(signal, ['inspect', '--type', 'container', '--format',
    fields.map(field => `{{json ${field}}}`).join('|'), resolved]);
  const values = output.split('|');
  const mounts = JSON.parse(values.splice(fields.length - 1).join('|'));
  const [fullId, owner, role, marker, status, startedAt, args, ports, restartPolicy] = values.map(JSON.parse);
  requireCondition(/^[a-f0-9]{64}$/.test(fullId) && fullId.startsWith(resolved) && owner === project && role === service
    && Number.isFinite(Date.parse(startedAt)), 'database_recovery_container_scope');
  if (['api', sourceService, recoveryService, 'provider'].includes(service)) {
    requireCondition(marker === '1' && (!ports || Object.keys(ports).length === 0), 'database_recovery_disposable_scope');
  }
  return { id: fullId, service, status, startedAt, args, restartPolicy, mounts };
}

async function apiDatabase(signal, container, database, host, flag) {
  requireCondition(container.status === 'running' && Array.isArray(container.args)
    && container.args.includes(application) && container.args.at(-1) === flag && container.restartPolicy === 'no',
  'database_recovery_api_signature');
  // Select a boolean marker. Other environment values can include credentials.
  const expected = `CRUSTCAPER_DB_URL=${fixtureDatabaseUrl(database, host)}`;
  const format = `{{range .Config.Env}}{{if eq . "${expected}"}}true{{end}}{{end}}`;
  requireCondition(await docker(signal, ['inspect', '--type', 'container', '--format', format, container.id]) === 'true',
    'database_recovery_api_database');
}

function postgres(signal, container, database, command, timeout, input) {
  const host = container.service;
  requireCondition((host === sourceService && database === source)
    || (host === recoveryService && (database === recoveryMaintenance || database === recovered)),
  'database_recovery_unexpected_database');
  return docker(signal, ['exec', ...(input === undefined ? [] : ['-i']), container.id, 'bash', '-c', postgresEnvironment,
    'crustcaper-rehearsal', host, database, ...command], timeout, input);
}

function sql(signal, container, database, query) {
  return postgres(signal, container, database, ['psql', '-XAtq', '--no-password', '-v', 'ON_ERROR_STOP=1', '-c', query]);
}

function requireDatabaseVolume(container, project, volume) {
  const stored = container.mounts.filter(mount => mount.Destination === '/var/lib/postgresql/data');
  requireCondition(stored.length === 1 && stored[0].Type === 'volume' && stored[0].Name === `${project}_${volume}`
    && stored[0].RW === true && container.restartPolicy === 'no', 'database_recovery_cluster_volume_scope');
}

async function clusterIdentity(signal, container, database) {
  const result = await sql(signal, container, database, `
    SELECT system_identifier, current_database(), current_user,
      (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()),
      encode(sha256(pg_read_binary_file('${postgresTlsRuntime}/ca.crt')), 'hex')
    FROM pg_control_system()
  `);
  const [identity, name, user, tls, ca] = result.split('|');
  requireCondition(/^\d{18,20}$/.test(identity) && name === database && user === source && tls === 't'
    && /^[a-f0-9]{64}$/.test(ca),
    'database_recovery_cluster_identity');
  return { identity, ca };
}

async function requireSourceDatabaseStopped(signal, project, database, destination) {
  const current = await inspect(signal, project, sourceService, database.id);
  requireCondition(current.status === 'exited' && current.startedAt === database.startedAt,
    'database_recovery_primary_database_still_running');
  await docker(signal, ['exec', destination.id, 'sh', '-ec',
    'if pg_isready -q -t 2 -h postgres -p 5432; then exit 1; else test "$?" = 2; fi']);
}

async function makeArchiveDirectory(signal, container, database) {
  const path = await postgres(signal, container, database, ['mktemp', '-d', '/tmp/crustcaper-recovery.XXXXXXXX']);
  requireCondition(archiveDirectory.test(path), 'database_recovery_archive_path');
  return path;
}

async function transferArchive(signal, from, originalPath, to, newPath, bytes) {
  let body;
  try {
    ({ stdout: body } = await execute('docker', ['exec', from.id, 'cat', '--', originalPath], {
      signal, encoding: 'buffer', timeout: 15000, maxBuffer: maxArchiveBytes, windowsHide: true,
    }));
  } catch {
    throw new RecoveryFailure('database_recovery_archive_transfer_read');
  }
  requireCondition(Buffer.isBuffer(body) && body.length === bytes, 'database_recovery_archive_transfer_size');
  await postgres(signal, to, recoveryMaintenance, ['bash', '-c',
    'set -euo pipefail; umask 077; set -o noclobber; cat > "$1"', 'crustcaper-archive-transfer', newPath], 15000, body);
}

function removeArchive(signal, container, database, scratch) {
  requireCondition(archiveDirectory.test(scratch), 'database_recovery_archive_path');
  return postgres(signal, container, database, ['bash', '-c',
    'set -euo pipefail; [[ "$(readlink -f -- "$1")" == "$1" && -d "$1" ]]; rm -f -- "$1/backup.dump"; rmdir -- "$1"',
    'crustcaper-archive-cleanup', scratch]);
}

async function applyOffboardingAccount(signal, container, database, command, revokedSessions) {
  const scope = recoveryOffboardingScope;
  requireCondition(Object.keys(scope).every(key => command[key] === scope[key])
    && (command.operation === 'disable' || (database === source && ['create', 'enroll-mfa'].includes(command.operation))),
  'database_recovery_offboarding_scope');
  const result = await postgres(signal, container, database, ['psql', '-XAtq', '--no-password',
    '-v', `operator_database=${database}`, '-f', '/fixture/operator-accounts.psql'], 10000,
  Buffer.from(JSON.stringify(command)).toString('base64') + '\n');
  requireCondition(result === [command.operation, scope.storeId, scope.accountId, scope.username,
    'manager', 't', revokedSessions].join('|'), 'database_recovery_offboarding_apply_failed');
}

async function offboardingSnapshot(signal, container, database) {
  const { accountId, storeId, username } = recoveryOffboardingScope;
  const result = await sql(signal, container, database, `
    SELECT a.enabled, a.mfa_last_counter,
      (SELECT count(*) FROM public.operator_sessions WHERE operator_id = a.id),
      (SELECT count(*) FROM public.operator_sessions WHERE operator_id = a.id AND mfa_verified AND expires_at > now()),
      NOT EXISTS (SELECT FROM pg_stat_activity WHERE datname = current_database()
        AND backend_type = 'client backend' AND pid <> pg_backend_pid()),
      floor(extract(epoch FROM clock_timestamp()) / 30)::bigint
    FROM public.operator_accounts a WHERE a.id = '${accountId}' AND a.username = '${username}'
      AND a.store_id = '${storeId}' AND a.role = 'manager'
  `);
  const [enabled, lastStep, sessions, verified, isolated, currentStep] = result.split('|');
  requireCondition(/^[tf]$/.test(enabled) && /^[tf]$/.test(isolated) && [lastStep, sessions, verified, currentStep]
    .every(value => /^\d+$/.test(value) && Number.isSafeInteger(Number(value))), 'database_recovery_offboarding_snapshot');
  return { enabled: enabled === 't', lastStep: Number(lastStep), sessions: Number(sessions), verified: Number(verified),
    isolated: isolated === 't', currentStep: Number(currentStep) };
}

function requireOffboardingState(state, enabled, lastStep, sessions) {
  requireCondition(state.enabled === enabled && state.lastStep === lastStep
    && state.sessions === sessions && state.verified === sessions, 'database_recovery_offboarding_state');
}

async function freshOffboardingStep(signal, container, lastStep) {
  const deadline = performance.now() + 32000;
  while (performance.now() < deadline) {
    const state = await offboardingSnapshot(signal, container, recovered);
    requireOffboardingState(state, false, lastStep, 0);
    const step = Math.max(lastStep + 1, state.currentStep);
    // A fresh counter must fit the API's ±1 TOTP window and exceed the snapshot's consumed counter.
    if (step <= state.currentStep + 1) return step;
    await delay(500, undefined, { signal });
  }
  throw new RecoveryFailure('database_recovery_offboarding_totp_window');
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

async function paymentReconciliationSnapshot(signal, edge) {
  const response = await docker(signal, [
    'exec', edge.id, 'wget', '-q', '-O', '-', 'http://api:8080/actuator/paymentreconciliation',
  ]);
  const snapshot = JSON.parse(response);
  const totals = ['sweeps', 'confirmed', 'pending', 'providerErrors', 'rejected', 'settlementErrors', 'sweepErrors'];
  requireCondition(Object.keys(snapshot).length === totals.length + 2 && snapshot.enabled === true
    && typeof snapshot.instanceId === 'string' && /^[a-f0-9-]{36}$/.test(snapshot.instanceId)
    && totals.every(key => Number.isSafeInteger(snapshot[key]) && snapshot[key] >= 0), 'database_recovery_payment_metrics');
  return snapshot;
}

async function observeRecoveredReconciliation(signal, edge, sourceSnapshot) {
  const deadline = performance.now() + 25_000;
  while (performance.now() < deadline) {
    const snapshot = await paymentReconciliationSnapshot(signal, edge);
    requireCondition(snapshot.instanceId !== sourceSnapshot.instanceId, 'database_recovery_payment_metrics_instance');
    if (snapshot.sweeps > 0) return snapshot.sweeps;
    await delay(500, undefined, { signal });
  }
  throw new RecoveryFailure('database_recovery_payment_worker_inactive');
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

async function runDatabaseRecovery({ project, caFile, evidence, stopSource, stopSourceDatabase, startRecovered, signal, fixtureMfaKey }) {
  const report = {
    recordedAt: new Date().toISOString(), scope: 'local_disposable_distinct_postgres_instances',
    phase: 'preflight', provider: {}, postgresTls: {}, clusterBoundary: {}, staffOffboarding: {}, errors: [], passed: false,
  };
  const active = AbortSignal.any([signal, AbortSignal.timeout(175000)]);
  let fixture;
  let journey;
  let postgresContainer;
  let recoveredPostgresContainer;
  let sourceScratch;
  let recoveredScratch;
  try {
    fixture = await openStorefrontFixture({ project, caFile, signal: active });
    const [edge, database, destination, provider, api, catalog] = await Promise.all([
      inspect(active, project, 'edge', fixture.edge), inspect(active, project, sourceService),
      inspect(active, project, recoveryService),
      inspect(active, project, 'provider'), inspect(active, project, 'api'), inspect(active, project, 'catalog'),
    ]);
    const containers = [edge, database, destination, provider, api, catalog];
    requireCondition(new Set(containers.map(container => container.id)).size === containers.length
      && containers.every(container => container.status === 'running')
      && Array.isArray(provider.args) && provider.args.includes(application) && provider.args.at(-1) === '--recovery-provider',
    'database_recovery_fixture_scope');
    postgresContainer = database;
    recoveredPostgresContainer = destination;
    const peers = { edge, [recoveryService]: destination, provider, catalog };
    requireDatabaseVolume(database, project, 'source_db');
    requireDatabaseVolume(destination, project, 'recovered_db');
    const [sourceCluster, recoveredCluster] = await Promise.all([
      clusterIdentity(active, database, source), clusterIdentity(active, destination, recoveryMaintenance),
    ]);
    requireCondition(sourceCluster.identity !== recoveredCluster.identity && sourceCluster.ca !== recoveredCluster.ca,
      'database_recovery_clusters_not_independent');
    report.clusterBoundary = { distinctSystems: true, distinctDataVolumes: true, distinctTrustRoots: true };
    report.postgresTls.destinationMaintenance = true;
    await apiDatabase(active, api, source, sourceService, '--restart-api');
    requireCondition(await sql(active, database, source, postgresJdbcTlsQuery) === 't', 'database_recovery_source_tls_unverified');
    report.postgresTls.sourceApi = true;
    const sourcePaymentMetrics = await paymentReconciliationSnapshot(active, edge);
    const initial = await databaseSnapshot(active, database, source);
    verifyOrders(initial, 0, 0, 0, 0, 0, 0);
    requireCondition(await sql(active, destination, recoveryMaintenance,
      `SELECT NOT EXISTS (SELECT FROM pg_database WHERE datname = '${recovered}')`) === 't', 'database_recovery_target_exists');
    report.provider.initial = await providerState(active, edge, 0, 0);
    journey = await createRecoveryJourney({ request: fixture.request, project, signal: active, fixtureMfaKey });
    const offboarding = createRecoveryOffboarding({ request: fixture.request, fixtureMfaKey });

    report.phase = 'backup';
    const seed = witness(await journey.seed(), { paidOrders: 1, paymentAttempts: 2, pendingAttempts: 1,
      attachedReceipts: 1, managerSessionAuthenticated: true, kitchenSessionAuthenticated: true });
    await offboarding.seed(command => applyOffboardingAccount(active, database, source, command, 0));
    const staffAtBackup = await offboardingSnapshot(active, database, source);
    requireOffboardingState(staffAtBackup, true, staffAtBackup.lastStep, 1);
    report.staffOffboarding.snapshotSessionAuthenticated = true;
    const beforeBackup = await databaseSnapshot(active, database, source);
    verifyOrders(beforeBackup, 2, 1, 1, 2, 1, 1);
    report.provider.atBackup = await providerState(active, edge, 2, 1);
    sourceScratch = await makeArchiveDirectory(active, database, source);
    const archive = sourceScratch + '/backup.dump';
    const backupStartedAt = performance.now();
    const checksum = await postgres(active, database, source, ['bash', '/fixture/backup-postgres.sh', archive], 45000);
    const backupCompletedAt = performance.now();
    requireCondition(/^[a-f0-9]{64}$/.test(checksum), 'database_recovery_archive_checksum');
    const bytes = Number(await postgres(active, database, source, ['stat', '-c', '%s', archive]));
    requireCondition(Number.isSafeInteger(bytes) && bytes > 0 && bytes <= maxArchiveBytes, 'database_recovery_archive_size');
    requireCondition(sameSnapshot(await databaseSnapshot(active, database, source), beforeBackup), 'database_recovery_snapshot_changed');
    recoveredScratch = await makeArchiveDirectory(active, destination, recoveryMaintenance);
    const transferredArchive = recoveredScratch + '/backup.dump';
    const transferStartedAt = performance.now();
    await transferArchive(active, database, archive, destination, transferredArchive, bytes);
    await removeArchive(active, database, source, sourceScratch);
    sourceScratch = undefined;
    report.backup = { bytes, elapsedMs: Math.round(backupCompletedAt - backupStartedAt), transferMs: elapsed(transferStartedAt),
      counts: counts(beforeBackup), seed };

    report.phase = 'post_snapshot';
    const later = witness(await journey.commitAfterSnapshot(), { postSnapshotOrders: 1, pendingAttempts: 2, retainedGuestBinding: true });
    const afterSnapshot = await databaseSnapshot(active, database, source);
    verifyOrders(afterSnapshot, 3, 1, 2, 3, 1, 1);
    report.provider.afterSnapshot = await providerState(active, edge, 3, 1);
    report.postSnapshot = { ...later, observedMsAfterBackup: elapsed(backupCompletedAt) };
    const disable = Object.freeze({ operation: 'disable', ...recoveryOffboardingScope });
    await applyOffboardingAccount(active, database, source, disable, 1);
    requireOffboardingState(await offboardingSnapshot(active, database, source), false, staffAtBackup.lastStep, 0);
    await offboarding.verifyOldSessionDenied('recovery_offboarding_source_old_session');
    report.staffOffboarding.sourceOldSessionRejected = true;
    // The simulated operator access record lives outside both databases and contains no credentials.
    const retainedOffboarding = disable;
    report.phase = 'stop_source';
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
    report.sourceWitnessCountsUnchangedAfterApiStop = true;
    report.phase = 'stop_source_database';
    await unchangedPeers(active, project, { [sourceService]: database });
    const sourceDatabaseStopStartedAt = performance.now();
    await stopSourceDatabase(active);
    await requireSourceDatabaseStopped(active, project, database, destination);
    report.sourceDatabaseStoppedMs = elapsed(sourceDatabaseStopStartedAt);
    report.clusterBoundary.sourceEndpointUnavailableBeforeRestore = true;

    report.phase = 'restore';
    const restoreStartedAt = performance.now();
    await postgres(active, destination, recoveryMaintenance, ['env', `TMPDIR=${recoveredScratch}`,
      'bash', '/fixture/restore-postgres.sh', transferredArchive, recovered, checksum], 45000);
    const restoreElapsedMs = elapsed(restoreStartedAt);
    requireCondition(sameSnapshot(await clusterIdentity(active, destination, recovered), recoveredCluster),
      'database_recovery_target_cluster_changed');
    const fromArchive = await databaseSnapshot(active, destination, recovered);
    requireCondition(sameSnapshot(fromArchive, beforeBackup), 'database_recovery_restore_mismatch');
    report.restore = { elapsedMs: restoreElapsedMs, counts: counts(fromArchive), migrationHistoryMatches: true };

    report.phase = 'offboarding_replay';
    const beforeStart = await inspect(active, project, 'api', api.id);
    requireCondition(beforeStart.status === 'exited' && beforeStart.startedAt === api.startedAt, 'database_recovery_source_restarted');
    const restoredStaff = await offboardingSnapshot(active, destination, recovered);
    requireCondition(restoredStaff.isolated, 'database_recovery_offboarding_target_in_use');
    requireOffboardingState(restoredStaff, true, staffAtBackup.lastStep, 1);
    report.staffOffboarding.snapshotContainedPreviouslyActiveSession = true;
    await applyOffboardingAccount(active, destination, recovered, retainedOffboarding, 1);
    const replayed = await offboardingSnapshot(active, destination, recovered);
    requireCondition(replayed.isolated, 'database_recovery_offboarding_target_in_use');
    requireOffboardingState(replayed, false, staffAtBackup.lastStep, 0);
    report.staffOffboarding.replayedBeforeRecoveredApi = true;

    report.phase = 'recovered_api';
    const targetStartedAt = performance.now();
    await startRecovered(active);
    const target = await inspect(active, project, 'api');
    requireCondition(target.id !== api.id && Date.parse(target.startedAt) > Date.parse(api.startedAt),
      'database_recovery_api_not_replaced');
    await apiDatabase(active, target, recovered, recoveryService, '--recovery-api');
    await waitReady(active, edge, fixture.request);
    requireCondition(await sql(active, destination, recovered, postgresJdbcTlsQuery) === 't', 'database_recovery_restored_tls_unverified');
    report.postgresTls.restoredApi = true;
    report.recoveredApi = { readyAfterStartMs: elapsed(targetStartedAt), readyAfterRestoreStartedMs: elapsed(restoreStartedAt),
      readyAfterSourceStopStartedMs: elapsed(sourceStopStartedAt) };
    await offboarding.verifyOldSessionDenied('recovery_offboarding_restored_old_session');
    report.staffOffboarding.restoredOldSessionRejected = true;
    await offboarding.verifyFreshLoginDenied(await freshOffboardingStep(active, destination, staffAtBackup.lastStep));
    report.staffOffboarding.restoredFreshLoginRejected = true;
    const reconcileStartedAt = performance.now();
    const originalJourney = witness(await journey.verifyRecovered(), {
      restoredPaidOrders: 2, restoredGuestSessions: 2, restoredStaffSessions: 2, restoredReceiptByteIdentical: true,
      restoredReceiptAccessScoped: true, originalPaymentAttemptsRetained: true, postSnapshotOrdersAbsent: 1,
      externalPaymentsRequiringReconciliation: 1,
    });
    report.staffOffboarding.otherStaffSessionsRetained = true;
    const reconciled = await databaseSnapshot(active, destination, recovered);
    verifyOrders(reconciled, 2, 2, 0, 2, 2, 1);
    report.provider.afterReconciliation = await providerState(active, edge, 3, 3);
    report.reconciled = { elapsedMs: elapsed(reconcileStartedAt), counts: counts(reconciled), originalJourney,
      unresolvedProviderPayments: report.provider.afterReconciliation.paid - reconciled.paidOrders };
    requireCondition(report.reconciled.unresolvedProviderPayments === 1, 'database_recovery_expected_reconciliation_gap');

    report.phase = 'isolated_new_order';
    const probeStartedAt = performance.now();
    const newOrderJourney = witness(await journey.verifyNewOrder(), { newPaidOrders: 1, paidOrdersInKitchen: 3 });
    const afterProbe = await databaseSnapshot(active, destination, recovered);
    verifyOrders(afterProbe, 3, 3, 0, 3, 3, 1);
    report.provider.afterNewOrder = await providerState(active, edge, 4, 4);
    await unchangedPeers(active, project, peers);
    const current = await inspect(active, project, 'api', target.id);
    requireCondition(current.status === 'running' && current.startedAt === target.startedAt, 'database_recovery_final_scope_changed');
    report.isolatedNewOrder = { elapsedMs: elapsed(probeStartedAt), verifiedAfterSourceStopStartedMs: elapsed(sourceStopStartedAt),
      counts: counts(afterProbe), newOrderJourney };
    report.providerProcessUnchanged = true;
    report.manualReconciliationRequired = true;
    report.phase = 'payment_worker';
    const completedSweeps = await observeRecoveredReconciliation(active, edge, sourcePaymentMetrics);
    report.paymentReconciliation = { privateSnapshots: true, newInstance: true, completedSweeps };
    await requireSourceDatabaseStopped(active, project, database, destination);
    report.clusterBoundary.sourceStayedStoppedThroughVerification = true;
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
    let cleanupSucceeded = !!(sourceScratch ?? recoveredScratch);
    for (const [container, database, scratch] of [[postgresContainer, source, sourceScratch],
      [recoveredPostgresContainer, recoveryMaintenance, recoveredScratch]]) {
      if (scratch === undefined) continue;
      try {
        const cleanupSignal = AbortSignal.timeout(12000);
        const current = await inspect(cleanupSignal, project, container.service, container.id);
        requireCondition(current.status === 'running' && current.startedAt === container.startedAt,
          'database_recovery_cleanup_scope');
        await removeArchive(cleanupSignal, current, database, scratch);
      } catch {
        cleanupSucceeded = false;
        report.errors.push('database_recovery_archive_cleanup_failed');
      }
    }
    if (cleanupSucceeded) report.archiveRemoved = true;
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
