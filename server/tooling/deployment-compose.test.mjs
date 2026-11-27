import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, normalize } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const deploy = fileURLToPath(new URL('../deploy/', import.meta.url));
const wrapper = fileURLToPath(new URL('deployment-compose.sh', import.meta.url));

test('deployment loads the selected stage configuration and verified image pins', async t => {
  const temp = await realpath(tmpdir());
  const scratch = await realpath(await mkdtemp(join(temp, 'crustcaper-compose-')));
  assert.equal(dirname(scratch), temp);
  assert.match(basename(scratch), /^crustcaper-compose-/);
  t.after(() => rm(scratch, { recursive: true, force: true }));

  const stageEnv = join(scratch, 'stage.env');
  const imagesEnv = join(scratch, 'images.env');
  const apiEnv = join(scratch, 'api.env');
  const alternateApiEnv = join(scratch, 'alternate-api.env');
  const edgeEnv = join(scratch, 'edge.env');
  const ca = join(scratch, 'stage-ca.crt');
  const legal = join(scratch, 'publication.json');
  const storefront = join(scratch, 'checkout');
  const asComposePath = file => file.replaceAll('\\', '/');

  await Promise.all([
    writeFile(stageEnv, [
      'CRUSTCAPER_API_IMAGE=crustcaper-api:unpinned',
      'CRUSTCAPER_HTTPS_HOST=stage.example.test',
      'CRUSTCAPER_HTTPS_BIND_IP=127.0.0.1',
      'CRUSTCAPER_STORE_ID=${DEPLOYMENT_COMPOSE_FIXTURE_STORE}',
      `CRUSTCAPER_API_ENV_FILE=${asComposePath(apiEnv)}`,
      `CRUSTCAPER_EDGE_RATE_ENV_FILE=${asComposePath(edgeEnv)}`,
      `CRUSTCAPER_POSTGRES_CA_FILE=${asComposePath(ca)}`,
      `CRUSTCAPER_LEGAL_PUBLICATION_FILE=${asComposePath(legal)}`,
      `CRUSTCAPER_STOREFRONT_DIR=${asComposePath(storefront)}`,
      '',
    ].join('\n')),
    writeFile(imagesEnv, 'CRUSTCAPER_API_IMAGE=crustcaper-api:verified\n'
      + 'CRUSTCAPER_CATALOG_IMAGE=crustcaper-catalog:verified\nCRUSTCAPER_EDGE_IMAGE=crustcaper-edge:verified\n'),
    writeFile(apiEnv, 'SPRING_PROFILES_ACTIVE=stage\n'),
    writeFile(alternateApiEnv, 'SPRING_PROFILES_ACTIVE=production\n'),
    writeFile(edgeEnv, ''),
    writeFile(ca, ''),
    writeFile(legal, '{}'),
    mkdir(storefront),
  ]);

  const env = {
    ...process.env,
    MSYS2_ARG_CONV_EXCL: '*',
    DEPLOYMENT_COMPOSE_FIXTURE_STORE: 'kigali',
    CRUSTCAPER_HTTPS_HOST: 'previous.example.test',
    CRUSTCAPER_API_ENV_FILE: asComposePath(alternateApiEnv),
    CRUSTCAPER_API_IMAGE: 'crustcaper-api:previous',
    CRUSTCAPER_POSTGRES_CA_FILE: asComposePath(legal),
    CRUSTCAPER_LEGAL_PUBLICATION_FILE: asComposePath(ca),
    CRUSTCAPER_STORE_ID: 'previous-store',
  };
  const files = ['compose.yml', 'compose.https.yml', 'compose.storefront.yml', 'compose.catalog.yml',
    'compose.legal.yml', 'compose.portable.yml'];
  const args = ['--env-file', stageEnv, '--env-file', imagesEnv, '--project-name', 'crustcaper-config-fixture',
    ...files.flatMap(file => ['-f', join(deploy, file)]), 'config', '--format', 'json'];
  const { stdout } = await execute('bash', [wrapper, ...args], { env, timeout: 15_000 });
  const { api, catalog, edge } = JSON.parse(stdout).services;

  assert.equal(api.environment.SPRING_PROFILES_ACTIVE, 'stage');
  assert.equal(api.environment.CRUSTCAPER_WEB_ORIGIN, 'https://stage.example.test');
  assert.equal(api.image, 'crustcaper-api:verified');
  assert.equal(catalog.environment.CRUSTCAPER_STORE_ID, 'kigali');
  assert.equal(edge.environment.CRUSTCAPER_HTTPS_HOST, 'stage.example.test');
  assert.equal(normalize(api.volumes.find(volume => volume.target === '/run/crustcaper/postgres-ca.crt').source), ca);
  assert.equal(normalize(catalog.volumes.find(volume => volume.target === '/srv/crustcaper-legal/publication.json').source), legal);
});
