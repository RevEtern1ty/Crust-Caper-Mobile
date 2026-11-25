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
let java;
let preview;
let stopping;

function run(command, args) {
  return new Promise((done, reject) => {
    const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) done();
      else reject(new Error(command + ' exited with code ' + code));
    });
  });
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
  const jar = resolve(root, 'server/build/libs/crustcaper-api.jar');
  await Promise.all([access(jar), access(resolve(web, 'index.html')), checkPort(port), checkPort(browserPort)]);
  await run('docker', [...compose, 'up', '-d', '--wait']);
  if (stopping) return;

  const executable = process.env.JAVA_HOME
    ? resolve(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
    : 'java';
  const localEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(?:SPRING_|CRUSTCAPER_|FLUTTERWAVE_|JAVA_TOOL_OPTIONS$|JDK_JAVA_OPTIONS$|_JAVA_OPTIONS$)/i.test(name)));
  java = spawn(executable, ['-jar', jar, '--spring.profiles.active=local', '--spring.config.location=classpath:/'], {
    cwd: root, windowsHide: true, stdio: 'inherit',
    env: {
      ...localEnv,
      CRUSTCAPER_PORT: String(port),
      CRUSTCAPER_DB_URL: 'jdbc:postgresql://127.0.0.1:55432/crustcaper_dev',
      CRUSTCAPER_DB_USER: 'crustcaper',
      CRUSTCAPER_DB_PASSWORD: 'crustcaper-local',
      CRUSTCAPER_PAYMENT_PROVIDER: 'local',
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
