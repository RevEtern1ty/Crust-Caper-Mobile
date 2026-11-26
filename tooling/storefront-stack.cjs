const { Buffer } = require('node:buffer');
const { spawn } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const { access, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { basename, dirname, join, resolve } = require('node:path');
const { openStorefrontFixture } = require('./storefront-load.cjs');
const { openStaffSession } = require('./storefront-load-kitchen.cjs');
const { fixtureDatabaseUrl, preparePostgresTls, postgresCaMount, postgresJdbcTlsQuery, postgresTlsEntrypoint,
  postgresTlsMount, postgresTlsRuntime } = require('./storefront-postgres-tls.cjs');

const root = resolve(dirname(module.filename), '..');
const deploy = join(root, 'server', 'deploy');
const fixtureHost = 'crustcaper.test';
const fixtureAppLinks = Object.freeze({
  androidPackage: 'com.crustcaper.mobile.stage',
  androidFingerprint: '9A:'.repeat(31) + '9A',
  iosAppId: 'ABCDE12345.com.crustcaper.mobile.stage',
});
const database = 'storefront_fixture';
const recoveredDatabase = 'storefront_recovered';
const recoveryHost = 'postgres-recovery';
const testMain = 'com.crustcaper.api.payment.WebCheckoutFixture';
const scratchPrefix = 'cc-storefront-';
const fixturePhoto = { sku: 'double-smash', file: 'double-smash-r39.jpg' };
const fixtureBootstrapVersion = 'catalog-bootstrap';
const legalFixtureVersion = '2026-05-01';
const archivedPrivacyVersion = '2026-04-01';
const errorRehearsalLabel = { 'crustcaper.fixture.error-rehearsal': '1' };
const recoveryLabel = { 'crustcaper.fixture.database-recovery': '1' };
const postgresImage = 'postgres:17.10-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193';
const fixtureEntrypoint = ['java', '-Dloader.path=/fixture/classes/', `-Dloader.main=${testMain}`,
  '-cp', '/app/app.jar', 'org.springframework.boot.loader.launch.PropertiesLauncher'];

let active;
let interrupted = false;
const interruption = new AbortController();

function interrupt() {
  interrupted = true;
  interruption.abort();
  if (active && !active.cleanup) active.child.kill();
}

function run(action, command, args, { env, input, capture = false, cleanup = false, timeout = 30000, signal } = {}) {
  if ((interrupted && !cleanup) || signal?.aborted) throw new Error('Storefront HTTPS verification interrupted');

  return new Promise((done, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: [input === undefined ? 'ignore' : 'pipe', capture ? 'pipe' : 'inherit',
        capture ? 'ignore' : 'inherit'],
      timeout,
      signal,
      windowsHide: true,
    });
    active = { child, cleanup };
    let failure;
    let output = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', chunk => { output += chunk; });
    child.stdin?.on('error', error => { failure ??= error; });
    child.on('error', error => { failure ??= error; });
    child.on('close', (code, exitSignal) => {
      active = undefined;
      if (failure || code !== 0) {
        reject(new Error(`${action} failed (${failure?.code ?? exitSignal ?? code})`));
      } else {
        done(output.trim());
      }
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

function candidateImage(name, value) {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9@.:_/-]{0,299}$/.test(value)) {
    throw new Error(`Set ${name} to the locally built candidate image`);
  }
  return value;
}

async function requireLocalDocker(env) {
  const endpoint = !env.DOCKER_CONTEXT && env.DOCKER_HOST
    ? env.DOCKER_HOST
    : await run('Read Docker context', 'docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
      { env, capture: true });
  if (!/^unix:\/\/\/[^\r\n]+$/.test(endpoint) && !/^npipe:\/\/\/\/\.\/pipe\/[\w.-]+$/i.test(endpoint)) {
    throw new Error('The storefront fixture requires a local Docker Unix socket or Windows named pipe');
  }
}

const dockerPath = path => process.platform === 'win32' ? path.replaceAll('\\', '/') : path;

const mount = (source, target) => ({
  type: 'bind',
  source: dockerPath(source).replaceAll('$', '$$'),
  target,
  read_only: true,
  bind: { create_host_path: false },
});

function postgresService(host, name, password, tlsDirectory, volumes, labels) {
  return {
    image: postgresImage,
    entrypoint: ['/bin/sh', '-ec', postgresTlsEntrypoint],
    command: [],
    restart: 'no',
    tmpfs: [`${postgresTlsRuntime}:rw,noexec,nosuid,nodev,size=1m`],
    ...(labels && { labels }),
    environment: { POSTGRES_USER: database, POSTGRES_DB: name, POSTGRES_PASSWORD: password },
    healthcheck: {
      test: ['CMD-SHELL', 'PGPASSWORD="$${POSTGRES_PASSWORD}" PGSSLMODE=verify-full '
        + `PGSSLROOTCERT=${postgresTlsRuntime}/ca.crt psql -h ${host} -XAtq --no-password -U ${database} -d ${name} -c 'SELECT 1'`],
      interval: '2s', timeout: '3s', retries: 15,
    },
    volumes: [mount(tlsDirectory, postgresTlsMount), ...volumes],
  };
}

async function prepareFixture(directory, testClasses, env, { paymentRestart, errorRehearsal, databaseRecovery }) {
  const fixturePassword = randomBytes(24).toString('hex');
  const fixtureMfaKey = randomBytes(32).toString('base64');
  const apiEnvironment = join(directory, 'api.env');
  const composeEnvironment = join(directory, 'compose.env');
  const { tlsDirectory, caFile: databaseCa, caFingerprint } = await preparePostgresTls(directory, env, run);
  const caddyfile = join(directory, 'Caddyfile');
  const overlay = join(directory, 'fixture.json');
  let recoveryOverlay;
  let recoveryPostgres;
  const recoveryTooling = [];
  const operators = mount(join(root, 'server', 'tooling', 'operator-accounts.psql'), '/fixture/operator-accounts.psql');
  if (databaseRecovery) {
    const recoveredTls = await preparePostgresTls(directory, env, run, recoveryHost);
    if (recoveredTls.caFingerprint === caFingerprint) throw new Error('Recovery requires an independent PostgreSQL CA');
    const recoveredPassword = randomBytes(24).toString('hex');
    const recoveryEnvironment = join(directory, 'recovered-api.env');
    await writeFile(recoveryEnvironment, `CRUSTCAPER_DB_PASSWORD=${recoveredPassword}\n`, { mode: 0o600 });
    recoveryOverlay = join(directory, 'recovery-cutover.json');
    await writeFile(recoveryOverlay, JSON.stringify({ services: { api: {
      env_file: [{ path: dockerPath(recoveryEnvironment).replaceAll('$', '$$'), format: 'raw' }],
      environment: { CRUSTCAPER_DB_URL: fixtureDatabaseUrl(recoveredDatabase, recoveryHost) },
      command: ['--recovery-api'],
      volumes: [mount(recoveredTls.caFile, postgresCaMount)],
    } } }));
    for (const name of ['backup-postgres.sh', 'restore-postgres.sh', 'postgres-connection.sh']) {
      const source = join(root, 'server', 'tooling', name);
      const copy = join(directory, name);
      await writeFile(copy, (await readFile(source, 'utf8')).replaceAll('\r\n', '\n'));
      recoveryTooling.push(mount(copy, '/fixture/' + name));
    }
    recoveryPostgres = postgresService(recoveryHost, 'postgres', recoveredPassword, recoveredTls.tlsDirectory, [
      operators, ...recoveryTooling, 'recovered_db:/var/lib/postgresql/data',
    ], recoveryLabel);
  }
  await writeFile(apiEnvironment, [
    'SPRING_PROFILES_ACTIVE=stage',
    `CRUSTCAPER_PAYMENT_PROVIDER=${paymentRestart ? 'flutterwave' : 'fixture'}`,
    'CRUSTCAPER_ORDER_ACCESS_PROVIDER=disabled',
    `CRUSTCAPER_DB_URL=${fixtureDatabaseUrl(database)}`,
    `CRUSTCAPER_DB_USER=${database}`,
    `CRUSTCAPER_DB_PASSWORD=${fixturePassword}`,
    `CRUSTCAPER_OPERATOR_MFA_KEY=${fixtureMfaKey}`,
    `CRUSTCAPER_APP_LINK_ANDROID_PACKAGE=${fixtureAppLinks.androidPackage}`,
    `CRUSTCAPER_APP_LINK_ANDROID_FINGERPRINTS=${fixtureAppLinks.androidFingerprint}`,
    `CRUSTCAPER_APP_LINK_IOS_APP_ID=${fixtureAppLinks.iosAppId}`,
    ...(paymentRestart ? [
      'FLUTTERWAVE_WEBHOOK_SECRET=fixture-restart-webhook-v1',
      `CRUST_PAYMENT_RETURN_URL=https://${fixtureHost}/payment-return`,
    ] : []),
    '',
  ].join('\n'), { mode: 0o600 });
  await writeFile(composeEnvironment, '');

  const site = 'https://{$CRUSTCAPER_HTTPS_HOST} {';
  const deployedCaddyfile = await readFile(join(deploy, 'Caddyfile'), 'utf8');
  if (deployedCaddyfile.split(site).length !== 2) throw new Error('Could not locate the deployed Caddy HTTPS site');
  const hostedUpstream = paymentRestart ? 'provider' : 'api';
  const providerSite = [
    '',
    'https://checkout.flutterwave.com {',
    '\ttls internal',
    '\troute {',
    `\t\treverse_proxy /v3/hosted/pay/* ${hostedUpstream}:18432`,
    '\t\trespond 404',
    '\t}',
    '}',
    '',
  ].join('\n');
  await writeFile(caddyfile, deployedCaddyfile.replace(site, site + '\n\ttls internal') + providerSite);

  const fixtureClasses = mount(testClasses, '/fixture/classes');
  await writeFile(overlay, JSON.stringify({
    services: {
      api: {
        pull_policy: 'never',
        ...(errorRehearsal && { labels: errorRehearsalLabel }),
        ...(databaseRecovery && { labels: recoveryLabel }),
        entrypoint: fixtureEntrypoint,
        depends_on: {
          postgres: { condition: 'service_healthy' },
          ...(paymentRestart && { provider: { condition: 'service_started' } }),
        },
        volumes: [fixtureClasses],
        ...(paymentRestart && { command: ['--restart-api'], restart: 'no' }),
      },
      ...(paymentRestart && { provider: {
        image: '${CRUSTCAPER_API_IMAGE:?Set the verified API image or digest}',
        pull_policy: 'never',
        entrypoint: fixtureEntrypoint,
        command: [databaseRecovery ? '--recovery-provider' : '--provider'],
        ...(databaseRecovery && { labels: recoveryLabel }),
        environment: { CRUSTCAPER_STOREFRONT_RESTART_PROVIDER: '1' },
        networks: ['default'],
        volumes: [fixtureClasses],
        read_only: true,
        tmpfs: ['/tmp:rw,noexec,nosuid,size=16m'],
        cap_drop: ['ALL'],
        security_opt: ['no-new-privileges:true'],
        init: true,
        restart: 'no',
      } }),
      catalog: { pull_policy: 'never' },
      edge: { volumes: [mount(caddyfile, '/etc/caddy/Caddyfile')] },
      postgres: postgresService('postgres', database, fixturePassword, tlsDirectory, [
        mount(join(root, 'server', 'tooling', 'import-catalog.psql'), '/fixture/import-catalog.psql'),
        operators,
        ...recoveryTooling,
        ...(databaseRecovery ? ['source_db:/var/lib/postgresql/data'] : []),
      ], databaseRecovery ? recoveryLabel : errorRehearsal ? errorRehearsalLabel : undefined),
      ...(databaseRecovery && { [recoveryHost]: recoveryPostgres }),
    },
    ...(databaseRecovery && { volumes: { source_db: {}, recovered_db: {} } }),
  }, null, 2), { mode: 0o600 });
  return { apiEnvironment, composeEnvironment, databaseCa, overlay, recoveryOverlay, fixtureMfaKey };
}

async function confirmPostgresTls(compose) {
  const verified = await compose('Check the fixture API PostgreSQL TLS connections', [
    'exec', '-T', 'postgres', 'psql', '-XAtq', '--no-password', '-U', database, '-d', database, '-c', postgresJdbcTlsQuery,
  ], { capture: true });
  if (verified !== 't') {
    throw new Error('The fixture API did not establish verified PostgreSQL TLS connections');
  }
  console.log(`Verified PostgreSQL TLS for the isolated ${database} API`);
}

async function importCatalog(compose, { load, catalogPhotos, availability, project, browserCa, fixtureMfaKey }) {
  const catalog = JSON.parse(await readFile(join(root, 'server', 'tooling', 'catalog.example.json'), 'utf8'));
  catalog.store.open = !availability;
  for (const product of catalog.products) product.available = true;
  if (catalogPhotos) {
    const product = catalog.products.find(({ sku }) => sku === fixturePhoto.sku);
    if (!product) throw new Error('Could not locate the product for the catalog photo fixture');
    product.photoUrl = `https://${fixtureHost}/catalog-photos/${fixturePhoto.file}`;
  }
  const pickupStarts = Date.now() + 3600000;
  const windows = load
    ? [
      ...Array.from({ length: 8 }, (_, index) => ({ id: `fixture-load-${index}`, capacity: 12 })),
      { id: 'fixture-capacity', capacity: 4 },
    ]
    : Array.from({ length: 4 }, (_, index) => ({ id: `fixture-slot-${index}`, capacity: 10 }));
  catalog.slots = windows.map((window, index) => {
    const startsAt = pickupStarts + index * 600000;
    return {
      ...window,
      startsAt: new Date(startsAt).toISOString(),
      endsAt: new Date(startsAt + 600000).toISOString(),
    };
  });
  const publish = (action, manifest) => compose(action, [
    'exec', '-T', 'postgres', 'psql', '-Xq', '--no-password', '-U', database, '-d', database,
    '-v', `catalog_database=${database}`, '-v', 'catalog_apply=true', '-f', '/fixture/import-catalog.psql',
  ], { input: Buffer.from(JSON.stringify(manifest)).toString('base64') + '\n' });
  await publish('Create the closed storefront fixture store', {
    expectedVersion: null,
    store: { ...catalog.store, open: false, version: fixtureBootstrapVersion },
    products: [],
    slots: [],
  });

  catalog.expectedVersion = fixtureBootstrapVersion;
  const fixture = await openStorefrontFixture({ project, caFile: browserCa, signal: interruption.signal });
  try {
    const manager = await openStaffSession({ request: fixture.request, project, role: 'manager', fixtureMfaKey });
    try {
      for (const product of catalog.products) {
        product.recipeVersion = 'fixture-recipe-001';
        product.allergenVersion = 'fixture-allergens-001';
        const { recipeVersion, allergenVersion, ingredients, allergens } = product;
        const approval = await manager.request('/api/v1/operator/catalog/recipe-approvals', {
          method: 'POST',
          body: {
            storeId: catalog.store.id,
            expectedVersion: catalog.expectedVersion,
            catalogVersion: catalog.store.version,
            sku: product.sku,
            crossContactConfirmed: true,
            facts: { recipeVersion, allergenVersion, ingredients, allergens },
          },
        });
        if (approval.status !== 200) throw new Error('Synthetic recipe approval failed (HTTP ' + approval.status + ')');
      }
    } finally {
      await manager.close();
    }
  } finally {
    fixture.close();
  }
  await publish('Import the approved synthetic catalog through the production importer', catalog);
}

async function main() {
  const modes = process.argv.slice(2);
  const [mode] = modes;
  const load = mode === '--load' || mode === '--load-smoke';
  const webPerf = mode === '--web-perf';
  const catalogPhotos = mode === '--catalog-photos';
  const availability = mode === '--availability';
  const errorRehearsal = mode === '--error-rehearsal';
  const databaseRecovery = mode === '--database-recovery';
  const kitchenRestart = mode === '--kitchen-restart';
  const paymentRestart = mode === '--payment-restart' || kitchenRestart || databaseRecovery;
  if (modes.length > 1 || (mode !== undefined && !load && !webPerf && !catalogPhotos && !paymentRestart && !availability && !errorRehearsal)) {
    throw new Error('Usage: node tooling/storefront-stack.cjs [--load | --load-smoke | --web-perf | --catalog-photos | --payment-restart | --kitchen-restart | --availability | --error-rehearsal | --database-recovery]');
  }
  const script = databaseRecovery ? 'tooling/storefront-database-recovery.cjs'
    : errorRehearsal ? 'tooling/storefront-error-rehearsal.cjs'
    : availability ? 'tooling/storefront-availability-rehearsal.cjs'
    : paymentRestart ? 'tooling/storefront-payment-restart.cjs' : load ? 'tooling/storefront-load.cjs' : null;
  const scenarios = script
    ? [script, ...(mode === '--load-smoke' ? ['--smoke'] : [])]
    : ['--test', 'tests/storefront-https.test.cjs'];
  if (script) await access(join(root, script));
  const apiImage = candidateImage('CRUSTCAPER_FIXTURE_API_IMAGE', process.env.CRUSTCAPER_FIXTURE_API_IMAGE);
  const catalogImage = candidateImage('CRUSTCAPER_FIXTURE_CATALOG_IMAGE', process.env.CRUSTCAPER_FIXTURE_CATALOG_IMAGE);
  const web = resolve(root, process.env.CRUSTCAPER_FIXTURE_STOREFRONT_DIR ?? 'dist-storefront-test');
  const evidence = process.env.CRUSTCAPER_HTTPS_TEST_EVIDENCE_DIR
    ? resolve(root, process.env.CRUSTCAPER_HTTPS_TEST_EVIDENCE_DIR) : undefined;
  const testClasses = join(root, 'server', 'build', 'classes', 'java', 'test');
  const hostEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(?:CRUSTCAPER_|FLUTTERWAVE_|SPRING_|COMPOSE_|CRUST_PAYMENT_RETURN_URL$)/i.test(name)));
  await Promise.all([access(join(web, 'index.html')), access(join(testClasses, ...testMain.split('.')) + '.class')]);
  await requireLocalDocker(hostEnv);

  // Names and paths here belong only to this invocation.
  const project = scratchPrefix + randomUUID();
  const tempRoot = await realpath(tmpdir());
  const directory = await mkdtemp(join(tempRoot, scratchPrefix));
  const browserCa = join(directory, 'browser-ca.crt');
  let stop;
  try {
    const photos = join(directory, 'catalog-photos');
    const legalFile = join(directory, 'legal-fixture.json');
    const edition = (en, rw) => Object.fromEntries(Object.entries({ en, rw }).map(([locale, title]) => [
      locale, { title, sections: [{ paragraphs: ['Synthetic fixture text <example> for ' + title + '.'] }] },
    ]));
    await writeFile(legalFile, JSON.stringify({
      current: { privacy: legalFixtureVersion, terms: legalFixtureVersion },
      privacy: {
        [legalFixtureVersion]: edition('Fixture privacy policy', 'Politiki y’amakuru bwite y’igerageza'),
        [archivedPrivacyVersion]: edition('Archived fixture privacy policy', 'Politiki y’amakuru bwite yabitswe'),
      },
      terms: { [legalFixtureVersion]: edition('Fixture ordering terms', 'Amabwiriza yo gutumiza y’igerageza') },
    }));
    if (catalogPhotos) {
      await mkdir(photos);
      await copyFile(join(root, 'assets', 'menu', `${fixturePhoto.sku}.jpg`), join(photos, fixturePhoto.file));
      await writeFile(join(photos, 'double-smash-r39.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>\n');
    }
    const settings = await prepareFixture(directory, testClasses, hostEnv, { paymentRestart, errorRehearsal, databaseRecovery });
    const env = {
      ...hostEnv,
      CRUSTCAPER_API_IMAGE: apiImage,
      CRUSTCAPER_CATALOG_IMAGE: catalogImage,
      CRUSTCAPER_API_ENV_FILE: dockerPath(settings.apiEnvironment),
      CRUSTCAPER_POSTGRES_CA_FILE: dockerPath(settings.databaseCa),
      CRUSTCAPER_HTTPS_HOST: fixtureHost,
      CRUSTCAPER_HTTPS_BIND_IP: '127.0.0.1',
      CRUSTCAPER_STOREFRONT_DIR: dockerPath(web),
      CRUSTCAPER_STORE_ID: 'kigali',
      CRUSTCAPER_STOREFRONT_PROFILE: 'stage',
      CRUSTCAPER_LEGAL_PUBLICATION_FILE: dockerPath(legalFile),
      ...(catalogPhotos && { CRUSTCAPER_CATALOG_PHOTOS_DIR: dockerPath(photos) }),
    };
    const command = ['compose', '--project-name', project, '--env-file', dockerPath(settings.composeEnvironment)];
    const files = ['compose.yml', 'compose.https.yml', 'compose.storefront.yml', 'compose.catalog.yml', 'compose.legal.yml'];
    if (catalogPhotos) files.push('compose.catalog-photos.yml');
    for (const file of files) {
      command.push('-f', dockerPath(join(deploy, file)));
    }
    command.push('-f', dockerPath(settings.overlay));
    const compose = (action, args, options) => run(action, 'docker', [...command, ...args], { env, ...options });
    await compose('Validate the deployed Compose files with the fixture overlay', ['config', '--quiet']);
    if (databaseRecovery) await compose('Validate the recovery API cutover overlay', [
      '-f', dockerPath(settings.recoveryOverlay), 'config', '--quiet',
    ]);
    stop = () => compose('Stop the isolated storefront fixture', ['down', '--volumes', '--timeout', '15'],
      { cleanup: true, timeout: 45000 });
    await compose('Start the storefront HTTPS fixture', ['up', '-d', '--wait', '--wait-timeout', '90'],
      { timeout: 120000 });
    await confirmPostgresTls(compose);
    await compose('Copy the storefront fixture TLS root', [
      'cp', 'edge:/data/caddy/pki/authorities/local/root.crt', dockerPath(browserCa),
    ]);
    await importCatalog(compose, { load, catalogPhotos, availability, project, browserCa, fixtureMfaKey: settings.fixtureMfaKey });
    if (evidence) await mkdir(evidence, { recursive: true });
    if (databaseRecovery) {
      const { runDatabaseRecovery } = require('./storefront-database-recovery.cjs');
      const recoverySignal = AbortSignal.any([interruption.signal, AbortSignal.timeout(240000)]);
      await runDatabaseRecovery({
        project, caFile: browserCa, evidence, fixtureMfaKey: settings.fixtureMfaKey,
        signal: recoverySignal,
        stopSource: (signal = recoverySignal) => compose('Stop only the primary fixture API',
          ['stop', '--timeout', '10', 'api'], { timeout: 20000, signal }),
        stopSourceDatabase: (signal = recoverySignal) => compose('Stop only the primary fixture PostgreSQL server',
          ['stop', '--timeout', '10', 'postgres'], { timeout: 20000, signal }),
        startRecovered: (signal = recoverySignal) => run('Start the restored fixture API', 'docker', [
          ...command, '-f', dockerPath(settings.recoveryOverlay),
          'up', '-d', '--no-deps', '--force-recreate', '--wait', '--wait-timeout', '35', 'api',
        ], { env, timeout: 45000, signal }),
      });
      return;
    }
    const childEnv = availability ? Object.fromEntries(Object.entries(hostEnv).filter(([name]) =>
      !/^(?:NODE_OPTIONS|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_USE_ENV_PROXY|(?:HTTP|HTTPS|ALL|NO)_PROXY)$/i.test(name)))
      : hostEnv;
    await run('Verify the storefront against isolated HTTPS', process.execPath, scenarios, {
      env: {
        ...childEnv,
        CRUSTCAPER_HTTPS_TEST_CA: browserCa,
        CRUSTCAPER_HTTPS_TEST_DOCKER_PROJECT: project,
        CRUSTCAPER_HTTPS_TEST_APP_LINKS: JSON.stringify(fixtureAppLinks),
        ...(evidence && { CRUSTCAPER_HTTPS_TEST_EVIDENCE_DIR: evidence }),
        ...((load || paymentRestart || catalogPhotos) && { CRUSTCAPER_HTTPS_TEST_MFA_FIXTURE_KEY: settings.fixtureMfaKey }),
        ...(webPerf && { CRUSTCAPER_HTTPS_TEST_WEB_PERF: '1' }),
        ...(catalogPhotos && { CRUSTCAPER_HTTPS_TEST_CATALOG_PHOTOS: '1' }),
        ...(paymentRestart && { CRUSTCAPER_HTTPS_TEST_PAYMENT_RESTART: '1' }),
        ...(kitchenRestart && { CRUSTCAPER_HTTPS_TEST_KITCHEN_RESTART: '1' }),
        ...(availability && { CRUSTCAPER_HTTPS_TEST_AVAILABILITY: '1', NODE_EXTRA_CA_CERTS: browserCa }),
        ...(errorRehearsal && { CRUSTCAPER_HTTPS_TEST_ERROR_REHEARSAL: '1' }),
      },
      timeout: { '--load': 300000, '--payment-restart': 160000, '--kitchen-restart': 190000 }[mode] ?? 180000,
    });
  } finally {
    if (stop) await stop();
    const target = await realpath(directory);
    if (dirname(target) !== tempRoot || !basename(target).startsWith(scratchPrefix)) {
      throw new Error('Unexpected fixture directory, leaving it in place');
    }
    await rm(target, { recursive: true, force: true });
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, interrupt);
main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
}).finally(() => {
  if (interrupted) process.exitCode = 1;
  for (const signal of ['SIGINT', 'SIGTERM']) process.off(signal, interrupt);
});
