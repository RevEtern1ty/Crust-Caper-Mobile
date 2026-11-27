import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('package-deployment.mjs', import.meta.url));
const digest = (data) => createHash('sha256').update(data).digest('hex');
const blob = (hash) => `blobs/sha256/${hash.slice(7)}`;

async function deployment(t) {
  const root = await mkdtemp(join(tmpdir(), 'crustcaper-pins-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archiveDir = join(root, 'archive');
  await mkdir(archiveDir);
  const compose = await readFile(new URL('../deploy/compose.https.yml', import.meta.url), 'utf8');
  const caddySource = /^    image: (caddy:\S+)/m.exec(compose)[1];
  const revision = '1'.repeat(40);
  const exportId = '2'.repeat(16);
  const manifest = [];
  const index = { schemaVersion: 2, manifests: [] };
  const images = {};
  const files = {};
  const ids = {};
  const expected = [];
  for (const role of ['api', 'catalog', 'edge']) {
    const tag = `crustcaper-portable/${role}:${revision.slice(0, 12)}-${exportId}`;
    const configContents = JSON.stringify({ os: 'linux', architecture: 'amd64', role });
    const config = `sha256:${digest(configContents)}`;
    const platformContents = JSON.stringify({ config: { digest: config } });
    const platformManifest = `sha256:${digest(platformContents)}`;
    files[blob(config)] = configContents;
    files[blob(platformManifest)] = platformContents;
    manifest.push({ RepoTags: [tag], Config: blob(config) });
    index.manifests.push({ digest: platformManifest, annotations: { 'io.containerd.image.name': `docker.io/${tag}` } });
    images[role] = { tag, config, platformManifest };
    ids[tag] = config;
    ids[config] = config;
    expected.push(`CRUSTCAPER_${role.toUpperCase()}_IMAGE=${config}`);
  }
  files['index.json'] = JSON.stringify(index);
  files['manifest.json'] = JSON.stringify(manifest);
  const name = 'images-linux-amd64.tar';
  const archive = 'synthetic archive bytes';
  await writeFile(join(archiveDir, name), archive);
  await writeFile(join(archiveDir, 'images.lock.json'), JSON.stringify({
    version: 1, revision, exportId, platform: 'linux/amd64', caddySource, images,
    archive: { name, bytes: Buffer.byteLength(archive), sha256: digest(archive) },
  }));
  const preload = join(root, 'fake-commands.cjs');
  await writeFile(preload, `
const childProcess = require('node:child_process');
const { promisify } = require('node:util');
const { syncBuiltinESMExports } = require('node:module');
const files = ${JSON.stringify(files)};
const ids = ${JSON.stringify(ids)};
let archiveLoaded = false;
const fakeExecFile = () => { throw new Error('Use the promisified command'); };
fakeExecFile[promisify.custom] = async (program, args) => {
  let stdout;
  if (program === 'tar' && args[0] === '-xOf') {
    stdout = files[args[2]];
  } else if (program === 'docker' && args[0] === 'image') {
    if (args[1] === 'ls') stdout = '';
    if (args[1] === 'load') {
      if (process.env.CRUSTCAPER_TEST_VERIFY) throw new Error('Unexpected image import');
      archiveLoaded = true;
      stdout = '';
    }
    if (args[1] === 'inspect') {
      const reference = args.at(-1);
      const wrong = archiveLoaded && process.env.CRUSTCAPER_TEST_MISMATCH && reference.includes('/edge:');
      stdout = (wrong ? 'sha256:' + '0'.repeat(64) : ids[reference]) + ' linux/amd64';
    }
  }
  if (stdout === undefined) throw new Error('Unexpected fixture command');
  return { stdout: Buffer.from(stdout) };
};
childProcess.execFile = fakeExecFile;
syncBuiltinESMExports();
`);
  const output = join(root, 'images.env');
  const env = { ...process.env, DOCKER_CONTEXT: '', DOCKER_HOST: 'unix:///crustcaper-test.sock',
    CRUSTCAPER_TEST_VERIFY: '', CRUSTCAPER_TEST_MISMATCH: '' };
  const run = (mode, args = [], options = {}) => execute(process.execPath,
    ['--require', preload, script, mode, archiveDir, ...args],
    { env: { ...env, ...options }, timeout: 10_000 });
  return { root, output, run, expected: expected.join('\n') + '\n' };
}

test('verified load replaces pins as one private file while stdout remains the default', async (t) => {
  const fixture = await deployment(t);
  assert.equal((await fixture.run('load')).stdout, fixture.expected);
  assert.equal((await fixture.run('verify', [], { CRUSTCAPER_TEST_VERIFY: '1' })).stdout, fixture.expected);
  await writeFile(fixture.output, 'previous verified pins\n');
  await assert.rejects(fixture.run('verify', ['--output', fixture.output]), /Usage:/);
  assert.equal(await readFile(fixture.output, 'utf8'), 'previous verified pins\n');
  assert.equal((await fixture.run('load', ['--output', fixture.output])).stdout, '');
  assert.equal(await readFile(fixture.output, 'utf8'), fixture.expected);
  if (process.platform !== 'win32') assert.equal((await stat(fixture.output)).mode & 0o777, 0o600);
});

test('failure verifying the last imported image preserves the previous pin file', async (t) => {
  const fixture = await deployment(t);
  await writeFile(fixture.output, 'previous verified pins\n');
  const contents = await readdir(fixture.root);
  await assert.rejects(fixture.run('load', ['--output', fixture.output], { CRUSTCAPER_TEST_MISMATCH: '1' }),
    /edge image ID does not match the lock/);
  assert.equal(await readFile(fixture.output, 'utf8'), 'previous verified pins\n');
  assert.deepEqual(await readdir(fixture.root), contents);
});

test('failed output promotion removes the scratch file without changing the destination', async (t) => {
  const fixture = await deployment(t);
  await mkdir(fixture.output);
  const contents = await readdir(fixture.root);
  await assert.rejects(fixture.run('load', ['--output', fixture.output]), /rename/);
  assert.deepEqual(await readdir(fixture.output), []);
  assert.deepEqual(await readdir(fixture.root), contents);
});
