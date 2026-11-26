const { Buffer } = require('node:buffer');
const { spawn } = require('node:child_process');
const { randomBytes, randomUUID } = require('node:crypto');
const { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { basename, dirname, join, resolve } = require('node:path');

const root = resolve(dirname(module.filename), '..');
const deploy = join(root, 'server', 'deploy');
const fixtureHost = 'crustcaper.test';
const database = 'storefront_fixture';
const testMain = 'com.crustcaper.api.payment.WebCheckoutFixture';
const scratchPrefix = 'cc-storefront-';
const postgresImage = 'postgres:17.10-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193';

let active;
let interrupted = false;

function interrupt() {
  interrupted = true;
  if (active && !active.cleanup) active.child.kill();
}

function run(action, command, args, { env, input, capture = false, cleanup = false, timeout = 30000 } = {}) {
  if (interrupted && !cleanup) throw new Error('Storefront HTTPS verification interrupted');

  return new Promise((done, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: [input === undefined ? 'ignore' : 'pipe', capture ? 'pipe' : 'inherit',
        capture ? 'ignore' : 'inherit'],
      timeout,
      windowsHide: true,
    });
    active = { child, cleanup };
    let failure;
    let output = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', chunk => { output += chunk; });
    child.stdin?.on('error', error => { failure ??= error; });
    child.on('error', error => { failure ??= error; });
    child.on('close', (code, signal) => {
      active = undefined;
      if (failure || code !== 0) {
        reject(new Error(`${action} failed (${failure?.code ?? signal ?? code})`));
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

async function prepareFixture(directory, testClasses, load) {
  const fixturePassword = randomBytes(24).toString('hex');
  const fixtureMfaKey = randomBytes(32).toString('base64');
  const apiEnvironment = join(directory, 'api.env');
  const composeEnvironment = join(directory, 'compose.env');
  const unusedDatabaseCa = join(directory, 'postgres-ca.crt');
  const caddyfile = join(directory, 'Caddyfile');
  const overlay = join(directory, 'fixture.json');
  await writeFile(apiEnvironment, [
    'SPRING_PROFILES_ACTIVE=stage',
    'CRUSTCAPER_PAYMENT_PROVIDER=fixture',
    'CRUSTCAPER_ORDER_ACCESS_PROVIDER=disabled',
    `CRUSTCAPER_DB_URL=jdbc:postgresql://postgres:5432/${database}`,
    `CRUSTCAPER_DB_USER=${database}`,
    `CRUSTCAPER_DB_PASSWORD=${fixturePassword}`,
    `CRUSTCAPER_OPERATOR_MFA_KEY=${fixtureMfaKey}`,
    '',
  ].join('\n'), { mode: 0o600 });
  // Bind the same CA mount as deployed Compose, using a private fixture network for PostgreSQL.
  await writeFile(unusedDatabaseCa, 'Unused by the isolated browser fixture\n');
  await writeFile(composeEnvironment, '');

  const site = 'https://{$CRUSTCAPER_HTTPS_HOST} {';
  const deployedCaddyfile = await readFile(join(deploy, 'Caddyfile'), 'utf8');
  if (deployedCaddyfile.split(site).length !== 2) throw new Error('Could not locate the deployed Caddy HTTPS site');
  const providerSite = [
    '',
    'https://checkout.flutterwave.com {',
    '\ttls internal',
    '\troute {',
    '\t\treverse_proxy /v3/hosted/pay/* api:18432',
    '\t\trespond 404',
    '\t}',
    '}',
    '',
  ].join('\n');
  await writeFile(caddyfile, deployedCaddyfile.replace(site, site + '\n\ttls internal') + providerSite);

  await writeFile(overlay, JSON.stringify({
    services: {
      api: {
        pull_policy: 'never',
        entrypoint: ['java', '-Dloader.path=/fixture/classes/', `-Dloader.main=${testMain}`,
          '-cp', '/app/app.jar', 'org.springframework.boot.loader.launch.PropertiesLauncher'],
        depends_on: { postgres: { condition: 'service_healthy' } },
        volumes: [mount(testClasses, '/fixture/classes')],
      },
      catalog: { pull_policy: 'never' },
      edge: { volumes: [mount(caddyfile, '/etc/caddy/Caddyfile')] },
      postgres: {
        image: postgresImage,
        environment: { POSTGRES_USER: database, POSTGRES_DB: database, POSTGRES_PASSWORD: fixturePassword },
        healthcheck: {
          test: ['CMD', 'pg_isready', '-U', database, '-d', database],
          interval: '2s', timeout: '3s', retries: 15,
        },
        volumes: [
          mount(join(root, 'server', 'tooling', 'import-catalog.psql'), '/fixture/import-catalog.psql'),
          ...(load ? [mount(join(root, 'server', 'tooling', 'operator-accounts.psql'), '/fixture/operator-accounts.psql')] : []),
        ],
      },
    },
  }, null, 2), { mode: 0o600 });
  return { apiEnvironment, composeEnvironment, unusedDatabaseCa, overlay, fixtureMfaKey };
}

async function importCatalog(compose, load) {
  const catalog = JSON.parse(await readFile(join(root, 'server', 'tooling', 'catalog.example.json'), 'utf8'));
  catalog.store.open = true;
  for (const product of catalog.products) product.available = true;
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
  await compose('Import the synthetic catalog through the production importer', [
    'exec', '-T', 'postgres', 'psql', '-Xq', '--no-password', '-U', database, '-d', database,
    '-v', `catalog_database=${database}`, '-v', 'catalog_apply=true', '-f', '/fixture/import-catalog.psql',
  ], { input: Buffer.from(JSON.stringify(catalog)).toString('base64') + '\n' });
}

async function main() {
  const modes = process.argv.slice(2);
  const [mode] = modes;
  if (modes.length > 1 || (mode !== undefined && mode !== '--load' && mode !== '--load-smoke')) {
    throw new Error('Usage: node tooling/storefront-stack.cjs [--load | --load-smoke]');
  }
  const load = mode !== undefined;
  const scenarios = load
    ? ['tooling/storefront-load.cjs', ...(mode === '--load-smoke' ? ['--smoke'] : [])]
    : ['--test', 'tests/storefront-https.test.cjs'];
  if (load) await access(join(root, 'tooling', 'storefront-load.cjs'));
  const apiImage = candidateImage('CRUSTCAPER_FIXTURE_API_IMAGE', process.env.CRUSTCAPER_FIXTURE_API_IMAGE);
  const catalogImage = candidateImage('CRUSTCAPER_FIXTURE_CATALOG_IMAGE', process.env.CRUSTCAPER_FIXTURE_CATALOG_IMAGE);
  const web = resolve(root, process.env.CRUSTCAPER_FIXTURE_STOREFRONT_DIR ?? 'dist-storefront-test');
  const evidence = process.env.CRUSTCAPER_HTTPS_TEST_EVIDENCE_DIR
    ? resolve(root, process.env.CRUSTCAPER_HTTPS_TEST_EVIDENCE_DIR) : undefined;
  const testClasses = join(root, 'server', 'build', 'classes', 'java', 'test');
  const hostEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(?:CRUSTCAPER_|FLUTTERWAVE_|SPRING_|COMPOSE_)/i.test(name)));
  await Promise.all([access(join(web, 'index.html')), access(join(testClasses, ...testMain.split('.')) + '.class')]);
  await requireLocalDocker(hostEnv);

  // Names and paths here belong only to this invocation.
  const project = scratchPrefix + randomUUID();
  const tempRoot = await realpath(tmpdir());
  const directory = await mkdtemp(join(tempRoot, scratchPrefix));
  const browserCa = join(directory, 'browser-ca.crt');
  let stop;
  try {
    const settings = await prepareFixture(directory, testClasses, load);
    const env = {
      ...hostEnv,
      CRUSTCAPER_API_IMAGE: apiImage,
      CRUSTCAPER_CATALOG_IMAGE: catalogImage,
      CRUSTCAPER_API_ENV_FILE: dockerPath(settings.apiEnvironment),
      CRUSTCAPER_POSTGRES_CA_FILE: dockerPath(settings.unusedDatabaseCa),
      CRUSTCAPER_HTTPS_HOST: fixtureHost,
      CRUSTCAPER_HTTPS_BIND_IP: '127.0.0.1',
      CRUSTCAPER_STOREFRONT_DIR: dockerPath(web),
      CRUSTCAPER_STORE_ID: 'kigali',
      CRUSTCAPER_STOREFRONT_PROFILE: 'stage',
    };
    const command = ['compose', '--project-name', project, '--env-file', dockerPath(settings.composeEnvironment)];
    for (const file of ['compose.yml', 'compose.https.yml', 'compose.storefront.yml', 'compose.catalog.yml']) {
      command.push('-f', dockerPath(join(deploy, file)));
    }
    command.push('-f', dockerPath(settings.overlay));
    const compose = (action, args, options) => run(action, 'docker', [...command, ...args], { env, ...options });
    await compose('Validate the deployed Compose files with the fixture overlay', ['config', '--quiet']);
    stop = () => compose('Stop the isolated storefront fixture', ['down', '--volumes', '--timeout', '15'],
      { cleanup: true, timeout: 45000 });
    await compose('Start the storefront HTTPS fixture', ['up', '-d', '--wait', '--wait-timeout', '90'],
      { timeout: 120000 });
    await importCatalog(compose, load);
    await compose('Copy the storefront fixture TLS root', [
      'cp', 'edge:/data/caddy/pki/authorities/local/root.crt', dockerPath(browserCa),
    ]);
    if (evidence) await mkdir(evidence, { recursive: true });
    await run('Verify the storefront against isolated HTTPS', process.execPath, scenarios, {
      env: {
        ...hostEnv,
        CRUSTCAPER_HTTPS_TEST_CA: browserCa,
        CRUSTCAPER_HTTPS_TEST_DOCKER_PROJECT: project,
        ...(evidence && { CRUSTCAPER_HTTPS_TEST_EVIDENCE_DIR: evidence }),
        ...(load && { CRUSTCAPER_HTTPS_TEST_MFA_FIXTURE_KEY: settings.fixtureMfaKey }),
      },
      timeout: mode === '--load' ? 300000 : 180000,
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
