const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdtempSync, rmdirSync, symlinkSync, unlinkSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const { test } = require('node:test');
const { buildStorefront, parseStorefrontArguments, storefrontEnvironment } = require('../tooling/build-storefront.cjs');

const origin = 'https://stage.example.test';
const stage = ['--origin', origin, '--profile', 'stage', '--store-id', 'kigali', '--psp-hosts', 'checkout.flutterwave.com'];

test('a storefront build binds API and payment return origin to one explicit host', () => {
  const options = parseStorefrontArguments(stage);
  assert.equal(options.outputDir, 'dist-storefront');
  const env = storefrontEnvironment(options, {
    PATH: 'fixture-path', EXPO_PUBLIC_OLD_HOST: 'ignored', EXPO_ROUTER_APP_ROOT: 'ignored', EAS_PROJECT_ID: 'ignored',
    CRUSTCAPER_BUILD_PROFILE: 'demo', CRUSTCAPER_API_BASE_URL: 'https://unused.test/api/v1',
    CRUSTCAPER_PUSH_PROJECT_ID: 'ignored', CRUSTCAPER_ANDROID_GOOGLE_SERVICES_FILE: 'ignored',
  });
  assert.deepEqual(env, {
    PATH: 'fixture-path', EXPO_NO_TELEMETRY: '1', EXPO_NO_DOTENV: '1', EXPO_NO_CLIENT_ENV_VARS: '1',
    CRUSTCAPER_BUILD_PROFILE: 'stage', CRUSTCAPER_WEB_CHECKOUT: 'true', CRUSTCAPER_API_BASE_URL: `${origin}/api/v1`,
    CRUSTCAPER_APP_LINK_ORIGIN: origin, CRUSTCAPER_PSP_HOSTS: 'checkout.flutterwave.com', CRUSTCAPER_STORE_ID: 'kigali',
  });
});

test('production passes its own native identities and supports a separate output directory', () => {
  const production = [...stage];
  production[3] = 'production';
  assert.throws(() => parseStorefrontArguments(production), /android-package and --ios-bundle-id/);
  const options = parseStorefrontArguments([...production, '--android-package', 'com.crustcaper.mobile',
    '--ios-bundle-id', 'com.crustcaper.ios', '--output-dir', 'dist-storefront-production']);
  assert.equal(options.outputDir, 'dist-storefront-production');
  const env = storefrontEnvironment(options, {});
  assert.equal(env.CRUSTCAPER_BUILD_PROFILE, 'production');
  assert.equal(env.CRUSTCAPER_ANDROID_PACKAGE, 'com.crustcaper.mobile');
  assert.equal(env.CRUSTCAPER_IOS_BUNDLE_ID, 'com.crustcaper.ios');
  assert.equal(env.CRUSTCAPER_LEGAL_ORIGIN, origin);
});

test('stage enables legal links only when the public documents have been configured', () => {
  const inherited = { CRUSTCAPER_LEGAL_ORIGIN: 'https://old.example.test' };
  assert.equal(storefrontEnvironment(parseStorefrontArguments(stage), inherited).CRUSTCAPER_LEGAL_ORIGIN, undefined);
  assert.equal(storefrontEnvironment(parseStorefrontArguments([...stage, '--legal']), inherited).CRUSTCAPER_LEGAL_ORIGIN, origin);
});

test('host-bound export rejects noncanonical URLs and reserved fixture output', () => {
  for (const wrongOrigin of ['http://stage.example.test', `${origin}:8443`, `${origin}/api/v1`, `${origin}/?x=1`,
    'https://example-user@stage.example.test', 'https://STAGE.example.test']) {
    assert.throws(() => parseStorefrontArguments(['--origin', wrongOrigin, ...stage.slice(2)]), /canonical HTTPS origin/);
  }
  assert.equal(parseStorefrontArguments(['--origin', `${origin}/`, ...stage.slice(2)]).origin, origin);
  assert.throws(() => parseStorefrontArguments([...stage, '--output-dir', 'dist-storefront-test']), /build:storefront-test/);
  const options = parseStorefrontArguments(stage);
  for (const outputDir of ['.', 'app', 'dist-storefront/..', '../dist-storefront', '/tmp/dist-storefront']) {
    assert.throws(() => buildStorefront({ ...options, outputDir }), /repository root/);
  }
});

test('storefront export refuses an output that is linked outside the repository', t => {
  const outside = mkdtempSync(join(tmpdir(), 'crustcaper-storefront-output-'));
  t.after(() => rmdirSync(outside));
  const outputDir = `dist-storefront-output-${randomUUID()}`;
  const linked = resolve(dirname(module.filename), '..', outputDir);
  symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    assert.throws(() => buildStorefront({ ...parseStorefrontArguments(stage), outputDir }), /regular directory/);
  } finally {
    unlinkSync(linked);
  }
});
