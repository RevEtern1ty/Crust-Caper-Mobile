const { access } = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { dirname, resolve } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { createPreviewServer } = require('./preview-server.cjs');

const root = resolve(dirname(module.filename), '..');
const compose = ['compose', '--project-name', 'crustcaper-mobile-api-local', '-f', resolve(root, 'server/compose.local.yml')];
const port = 18080;
const browserPort = 47867;
const address = '127.0.0.1';
const web = resolve(root, 'dist-connected');
let composeStartup;
let java;
let preview;
let stopping;

function localDatabase(env) {
  const mode = env.CRUSTCAPER_LOCAL_DB_MODE ?? 'docker';
  if (mode === 'docker') {
    return {
      mode,
      url: 'jdbc:postgresql://127.0.0.1:55432/crustcaper_dev',
      user: 'crustcaper',
      password: 'crustcaper-local',
    };
  }
  if (mode !== 'existing') throw new Error('Set CRUSTCAPER_LOCAL_DB_MODE to docker or existing.');

  const { CRUSTCAPER_DB_URL: url, CRUSTCAPER_DB_USER: user, CRUSTCAPER_DB_PASSWORD: password } = env;
  const jdbc = /^jdbc:postgresql:\/\/127\.0\.0\.1:(\d{1,5})\/([A-Za-z_][A-Za-z0-9_-]{0,62})$/.exec(url ?? '');
  if (!jdbc || Number(jdbc[1]) < 1 || Number(jdbc[1]) > 65535 || /^(?:postgres|template[01])$/i.test(jdbc[2])) {
    throw new Error('Set CRUSTCAPER_DB_URL to jdbc:postgresql://127.0.0.1:<port>/<dedicated-test-database>.');
  }
  if (!user?.trim() || !password) throw new Error('Set CRUSTCAPER_DB_USER and CRUSTCAPER_DB_PASSWORD for the test database.');
  return { mode, url, user, password };
}

function startCompose(env) {
  const cancel = new AbortController();
  const deadline = AbortSignal.timeout(180_000);
  composeStartup = cancel;

  return new Promise((done, reject) => {
    const child = spawn('docker', [...compose, 'up', '-d', '--wait', '--wait-timeout', '60'], {
      cwd: root, env, windowsHide: true, stdio: 'inherit',
      signal: AbortSignal.any([cancel.signal, deadline]), killSignal: 'SIGKILL',
    });
    let spawnError;
    child.once('error', error => { spawnError = error; });
    child.once('close', (code, signal) => {
      if (cancel.signal.aborted || code === 0) done();
      else if (deadline.aborted) reject(new Error('Docker startup timed out. Check Docker Desktop or use an existing local PostgreSQL database.'));
      else reject(spawnError ?? new Error(`Docker Compose ended with ${signal ?? `exit code ${code}`}.`));
    });
  }).finally(() => { composeStartup = null; });
}

function checkPort(number) {
  return new Promise((done, reject) => {
    const socket = createServer();
    socket.once('error', reject);
    socket.listen(number, address, () => socket.close(done));
  });
}

function stop() {
  if (stopping) return stopping;
  stopping = (async () => {
    composeStartup?.abort();
    if (preview?.listening) {
      await new Promise(done => {
        preview.close(done);
        preview.closeAllConnections();
      });
    }
    if (java && java.pid && java.exitCode === null && java.signalCode === null) {
      const exit = new Promise(done => java.once('exit', done));
      java.kill();
      await exit;
    }
  })();
  return stopping;
}

async function main() {
  const database = localDatabase(process.env);
  const localEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(?:SPRING_|CRUSTCAPER_|FLUTTERWAVE_|JAVA_TOOL_OPTIONS$|JDK_JAVA_OPTIONS$|_JAVA_OPTIONS$)/i.test(name)));
  const jar = resolve(root, 'server/build/libs/crustcaper-api.jar');
  await Promise.all([access(jar), access(resolve(web, 'index.html')), checkPort(port), checkPort(browserPort)]);
  if (database.mode === 'docker' && !stopping) await startCompose(localEnv);
  if (stopping) return;

  const executable = process.env.JAVA_HOME
    ? resolve(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
    : 'java';
  java = spawn(executable, ['-jar', jar, '--spring.profiles.active=local', '--spring.config.location=classpath:/'], {
    cwd: root, windowsHide: true, stdio: 'inherit',
    env: {
      ...localEnv,
      CRUSTCAPER_PORT: String(port),
      CRUSTCAPER_DB_URL: database.url,
      CRUSTCAPER_DB_USER: database.user,
      CRUSTCAPER_DB_PASSWORD: database.password,
      CRUSTCAPER_PAYMENT_PROVIDER: 'local',
      CRUSTCAPER_ORDER_ACCESS_PROVIDER: 'local',
      CRUSTCAPER_ORDER_ACCESS_NEGATIVE_DELAY: 'PT0S',
    },
  });
  let javaError;
  java.once('error', error => { javaError = error; });
  let healthy = false;
  for (let attempt = 0; attempt < 45 && !stopping; attempt++) {
    if (javaError) throw javaError;
    if (java.exitCode !== null) throw new Error('The local API stopped during startup.');
    try {
      const response = await fetch(`http://${address}:${port}/actuator/health/readiness`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        healthy = true;
        break;
      }
    } catch {
      // The JVM is still booting.
    }
    await delay(1000);
  }
  if (stopping) return;
  if (!healthy) throw new Error('The local API did not become ready.');

  preview = createPreviewServer(web);
  await new Promise((done, reject) => {
    preview.once('error', reject);
    preview.listen(browserPort, address, done);
  });
  console.log(`\nCustomer app   http://${address}:${browserPort}`);
  console.log(`Kitchen        http://${address}:${port}/operator/index.html`);
  console.log('Press Ctrl+C to close the app and API. PostgreSQL keeps local test data.');
  java.once('exit', () => { void stop(); });
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void stop(); });
main().catch(async error => {
  console.error(error.message);
  await stop();
  process.exitCode = 1;
});
