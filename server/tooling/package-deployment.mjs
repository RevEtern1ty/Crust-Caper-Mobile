import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const platform = 'linux/amd64';
const archiveName = 'images-linux-amd64.tar';
const lockName = 'images.lock.json';
const roles = ['api', 'catalog', 'edge'];
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const revisionPattern = /^[0-9a-f]{40}$/;
const exportIdPattern = /^[0-9a-f]{16}$/;
const imagePattern = /^[A-Za-z0-9][A-Za-z0-9.:_/@-]{0,299}$/;

function requireMatch(condition, message) {
  if (!condition) throw new Error(message);
}

async function command(action, program, args, timeout = 15_000) {
  try {
    const { stdout } = await execute(program, args, { encoding: 'buffer', timeout, maxBuffer: 1024 * 1024, windowsHide: true });
    return stdout;
  } catch {
    throw new Error(`${action} failed`);
  }
}

async function docker(action, args, timeout) {
  return (await command(action, 'docker', args, timeout)).toString('utf8').trim();
}

async function requireLocalDocker() {
  const endpoint = !process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST
    ? process.env.DOCKER_HOST
    : await docker('Read Docker context', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
  requireMatch(/^unix:\/\/\/[^\r\n]+$/.test(endpoint) || /^npipe:\/\/\/\/\.\/pipe\/[\w.-]+$/i.test(endpoint),
    'An on-host Docker Unix socket or Windows named pipe is required');
}

async function caddySource() {
  const compose = await readFile(new URL('../deploy/compose.https.yml', import.meta.url), 'utf8');
  const pins = [...compose.matchAll(/^    image: (caddy:[A-Za-z0-9.-]+@sha256:[0-9a-f]{64})\r?$/gm)];
  requireMatch(pins.length === 1, 'Expected one pinned Caddy image in the HTTPS Compose file');
  return pins[0][1];
}

const tagFor = (role, revision, exportId) => `crustcaper-portable/${role}:${revision.slice(0, 12)}-${exportId}`;
const digestOf = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const blobPath = digest => `blobs/sha256/${digest.slice('sha256:'.length)}`;

async function archiveDigest(path) {
  const file = await lstat(path);
  requireMatch(file.isFile() && file.size > 0, 'Expected a nonempty ordinary image archive');
  const sha256 = createHash('sha256');
  for await (const chunk of createReadStream(path)) sha256.update(chunk);
  return { bytes: file.size, sha256: sha256.digest('hex') };
}

function tarEntry(archive, entry) {
  return command(`Read archive member ${entry}`, 'tar', ['-xOf', archive, entry], 60_000);
}

async function inspectArchive(archive, revision, exportId) {
  const index = JSON.parse(await tarEntry(archive, 'index.json'));
  const classic = JSON.parse(await tarEntry(archive, 'manifest.json'));
  requireMatch(index.schemaVersion === 2 && Array.isArray(index.manifests) && Array.isArray(classic),
    'Expected Docker save OCI archive metadata');
  const named = index.manifests.filter(item => item.annotations?.['io.containerd.image.name']);
  requireMatch(named.length === roles.length && classic.length === roles.length
    && classic.every(item => Array.isArray(item.RepoTags) && item.RepoTags.length === 1),
  'Expected only the three portable deployment images');

  const images = {};
  for (const role of roles) {
    const tag = tagFor(role, revision, exportId);
    const descriptors = named.filter(item => item.annotations['io.containerd.image.name'] === `docker.io/${tag}`);
    const entries = classic.filter(item => item.RepoTags[0] === tag);
    const descriptor = descriptors[0];
    // Docker can omit platform on the descriptor after saving a loaded single-platform image.
    // Its content-addressed config still has to confirm linux/amd64 below.
    const declaredPlatform = descriptor?.platform;
    requireMatch(descriptors.length === 1 && entries.length === 1 && digestPattern.test(descriptor.digest)
      && (declaredPlatform === undefined
        || (declaredPlatform?.os === 'linux' && declaredPlatform?.architecture === 'amd64')),
    `${role} does not have exactly one linux/amd64 archive manifest`);
    const manifestBytes = await tarEntry(archive, blobPath(descriptor.digest));
    const manifest = JSON.parse(manifestBytes);
    const config = manifest.config?.digest;
    requireMatch(digestOf(manifestBytes) === descriptor.digest && digestPattern.test(config)
      && entries[0].Config === blobPath(config), `${role} platform manifest or config reference differs`);
    const configBytes = await tarEntry(archive, blobPath(config));
    const image = JSON.parse(configBytes);
    requireMatch(digestOf(configBytes) === config && image.os === 'linux' && image.architecture === 'amd64',
      `${role} linux/amd64 image config differs`);
    images[role] = { tag, platformManifest: descriptor.digest, config };
  }
  return images;
}

async function imageId(reference) {
  const details = await docker('Inspect local linux/amd64 image', ['image', 'inspect', '--platform', platform,
    '--format', '{{.Id}} {{.Os}}/{{.Architecture}}', reference]);
  const [id, imagePlatform] = details.split(' ');
  requireMatch(digestPattern.test(id) && imagePlatform === platform, 'Expected one local linux/amd64 image');
  return id;
}

async function hasTag(tag) {
  const existing = await docker('Check portable image tag', ['image', 'ls', '--filter', `reference=${tag}`,
    '--format', '{{.Repository}}:{{.Tag}}']);
  requireMatch(existing === '' || existing === tag, 'Unexpected Docker image tag result');
  return existing === tag;
}

async function requireLockedImage(role, image) {
  const id = await imageId(image.tag);
  requireMatch(id === image.platformManifest || id === image.config, `${role} image ID does not match the lock`);
  requireMatch(await imageId(id) === id, `${role} immutable image ID cannot be resolved locally`);
  return id;
}

async function exportImages(directory, revision, api, catalog) {
  requireMatch(revisionPattern.test(revision) && [api, catalog].every(image => imagePattern.test(image)),
    'The export requires a full source revision and two local image references');
  const sources = { api, catalog, edge: await caddySource() };
  const exportId = randomBytes(8).toString('hex');
  const archive = join(directory, archiveName);
  const created = [];
  const originalIds = {};
  await mkdir(directory);
  let lock;
  try {
    for (const role of roles) {
      originalIds[role] = await imageId(sources[role]);
      const tag = tagFor(role, revision, exportId);
      requireMatch(!await hasTag(tag), `${role} portable image tag already exists`);
      await docker('Assign portable image tag', ['image', 'tag', sources[role], tag]);
      created.push(tag);
    }
    await docker('Save pinned architecture images', ['image', 'save', '--platform', platform, '--output', archive, ...created], 300_000);
    const images = await inspectArchive(archive, revision, exportId);
    for (const role of roles) {
      requireMatch([images[role].platformManifest, images[role].config].includes(originalIds[role]),
        `${role} archive image differs from the selected local source`);
    }
    lock = { version: 1, revision, exportId, platform, caddySource: sources.edge,
      archive: { name: archiveName, ...await archiveDigest(archive) }, images };
  } finally {
    for (const tag of created) await docker('Remove only the export image tag', ['image', 'rm', tag]);
  }
  await writeFile(join(directory, lockName), JSON.stringify(lock, null, 2) + '\n', { flag: 'wx' });
  console.log(`Saved ${archiveName} and ${lockName} for ${revision}`);
}

async function loadImages(directory, importArchive) {
  const lock = JSON.parse(await readFile(join(directory, lockName), 'utf8'));
  requireMatch(lock.version === 1 && revisionPattern.test(lock.revision) && exportIdPattern.test(lock.exportId)
    && lock.platform === platform && lock.caddySource === await caddySource() && lock.archive?.name === archiveName
    && Number.isSafeInteger(lock.archive.bytes) && /^[0-9a-f]{64}$/.test(lock.archive.sha256), 'Invalid deployment image lock');
  const archive = join(directory, archiveName);
  const content = await archiveDigest(archive);
  requireMatch(content.bytes === lock.archive.bytes && content.sha256 === lock.archive.sha256,
    'Image archive length or SHA-256 does not match the lock');
  const images = await inspectArchive(archive, lock.revision, lock.exportId);
  for (const role of roles) {
    const image = images[role];
    requireMatch(Object.entries(image).every(([key, value]) => lock.images?.[role]?.[key] === value),
      `${role} archive image does not match the lock`);
    // Never allow Docker load to replace an existing tag that resolves to a different image.
    if (importArchive && await hasTag(image.tag)) await requireLockedImage(role, image);
  }
  if (importArchive) await docker('Load the locked linux/amd64 images', ['image', 'load', '--platform', platform, '--input', archive], 300_000);
  const ids = {};
  for (const role of roles) ids[role] = await requireLockedImage(role, images[role]);
  for (const role of roles) console.log(`CRUSTCAPER_${role.toUpperCase()}_IMAGE=${ids[role]}`);
}

async function main([mode, directory, ...args]) {
  requireMatch(directory && ((mode === 'export' && args.length === 3)
    || ((mode === 'load' || mode === 'verify') && !args.length)),
  'Usage: node server/tooling/package-deployment.mjs export DIRECTORY REVISION API_IMAGE CATALOG_IMAGE | load DIRECTORY | verify DIRECTORY');
  await requireLocalDocker();
  if (mode === 'export') await exportImages(resolve(directory), ...args);
  else await loadImages(resolve(directory), mode === 'load');
}

main(process.argv.slice(2)).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
