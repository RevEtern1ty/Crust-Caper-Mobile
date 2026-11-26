const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const { cli, build } = require('../eas.json');
const stageStore = build['stage-store'];
assert.ok(stageStore, 'A store-distributed stage profile is required for Play Internal and TestFlight');
assert.equal(stageStore.extends, 'stage');
assert.equal(cli.appVersionSource, 'remote');
const nodeVersion = readFileSync(require.resolve('../.nvmrc'), 'utf8').trim();
const resolvedStageStore = { ...build.stage, ...stageStore };
const distributionProfiles = [
  { name: 'stage', config: build.stage, environment: 'preview', appProfile: 'stage', distribution: 'internal', androidBuildType: 'apk' },
  { name: 'stage-store', config: resolvedStageStore, environment: 'preview', appProfile: 'stage',
    distribution: 'store', androidBuildType: 'app-bundle' },
  { name: 'production', config: build.production, environment: 'production', appProfile: 'production',
    distribution: 'store', androidBuildType: 'app-bundle' },
];
for (const { name, config, environment, appProfile, distribution, androidBuildType } of distributionProfiles) {
  assert.equal(config.android.buildType, androidBuildType, name);
  for (const platform of ['android', 'ios']) {
    const platformConfig = { ...config, ...config[platform] };
    const env = { ...config.env, ...config[platform]?.env };
    const label = `${name} ${platform}`;
    assert.equal(platformConfig.node, nodeVersion, label);
    assert.equal(platformConfig.environment, environment, label);
    assert.equal(platformConfig.distribution, distribution, label);
    assert.equal(env.CRUSTCAPER_BUILD_PROFILE, appProfile, label);
    assert.notEqual(platformConfig.withoutCredentials, true, label);
    assert.notEqual(platformConfig.developmentClient, true, label);
    if (distribution === 'store') {
      assert.equal(platformConfig.autoIncrement, true, label);
      assert.notEqual(platformConfig.simulator, true, label);
    }
  }
}
console.log('EAS build distributions, stage isolation, remote versions and Node runtime match the mobile release configuration');

const expoCli = require.resolve('expo/bin/cli');
const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('CRUSTCAPER_')));
const fixture = {
  CRUSTCAPER_API_BASE_URL: 'https://api-stage.crustcaper.invalid/api/v1',
  CRUSTCAPER_STORE_ID: 'ci-test-store',
  CRUSTCAPER_PSP_HOSTS: 'checkout.crustcaper.invalid',
  CRUSTCAPER_APP_LINK_ORIGIN: 'https://stage.crustcaper.invalid',
  CRUSTCAPER_LEGAL_ORIGIN: 'https://public.crustcaper.invalid',
  CRUSTCAPER_ANDROID_PACKAGE: 'org.crustcaper.civerification',
  CRUSTCAPER_IOS_BUNDLE_ID: 'org.crustcaper.civerification',
};
const pushProjectId = '9afd8de1-0758-4bfe-9ccc-12589d6a62dc';
const fixtureApiKey = 'A' + 'x'.repeat(38);

function environment(profile, overrides) {
  const env = { ...inherited, EXPO_NO_TELEMETRY: '1', EXPO_NO_DOTENV: '1', ...fixture, CRUSTCAPER_BUILD_PROFILE: profile };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  return env;
}

function inspect(profile, overrides = {}, json = true) {
  const argumentsList = [expoCli, 'config', '--type', 'introspect'];
  if (json) argumentsList.push('--json');
  const result = spawnSync(process.execPath, argumentsList, {
    env: environment(profile, overrides),
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  return result;
}

function inspectIosOnly(profile) {
  const script = `
    const { createRequire } = require('node:module');
    const { dirname } = require('node:path');
    const sdk = createRequire(require.resolve('@expo/cli', { paths: [dirname(require.resolve('expo/bin/cli'))] }));
    const { getPrebuildConfigAsync } = sdk('@expo/prebuild-config');
    const { compileModsAsync } = sdk('@expo/config-plugins/build/plugins/mod-compiler.js');
    (async () => {
      const projectRoot = process.cwd();
      const platforms = ['ios'];
      const { exp } = await getPrebuildConfigAsync(projectRoot, { platforms });
      await compileModsAsync(exp, { projectRoot, platforms, introspect: true, assertMissingModProviders: false });
      const entitlement = exp._internal.modResults.ios.entitlements['aps-environment'];
      if (entitlement !== 'production') throw new Error('APNs entitlement was not configured');
    })().catch(error => { console.error(error); process.exitCode = 1; });`;
  const result = spawnSync(process.execPath, ['-e', script], {
    env: environment(profile, { CRUSTCAPER_PUSH_PROJECT_ID: pushProjectId }),
    encoding: 'utf8', timeout: 30_000,
  });
  if (result.error) throw result.error;
  return result;
}

function inspectPushWithFixture(profile, clients, json = true, keys = [fixtureApiKey]) {
  const directory = mkdtempSync(join(tmpdir(), 'crustcaper-firebase-fixture-'));
  const file = join(directory, 'google-services.json');
  try {
    const data = clients === null ? 'invalid JSON fixture' : JSON.stringify({
      project_info: { project_number: '123456', project_id: 'crustcaper-fixture' },
      client: clients.map(packageId => ({
        client_info: { mobilesdk_app_id: '1:123456:android:00112233', android_client_info: { package_name: packageId } },
        api_key: keys.map(current_key => ({ current_key })),
      })),
    });
    writeFileSync(file, data);
    return inspect(profile, { CRUSTCAPER_PUSH_PROJECT_ID: pushProjectId, CRUSTCAPER_ANDROID_GOOGLE_SERVICES_FILE: file }, json);
  } finally {
    unlinkSync(file);
    rmdirSync(directory);
  }
}

for (const profile of [resolvedStageStore.env.CRUSTCAPER_BUILD_PROFILE, build.production.env.CRUSTCAPER_BUILD_PROFILE]) {
  const result = inspect(profile);
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  const native = config._internal.modResults;
  const packageId = profile === 'stage' ? 'com.crustcaper.mobile.stage' : fixture.CRUSTCAPER_ANDROID_PACKAGE;
  const scheme = profile === 'stage' ? 'crustcaper-stage' : 'crustcaper';
  const appLinkHost = new URL(fixture.CRUSTCAPER_APP_LINK_ORIGIN).host;
  assert.equal(config.android.package, packageId);
  assert.equal(config.ios.bundleIdentifier, profile === 'stage' ? packageId : fixture.CRUSTCAPER_IOS_BUNDLE_ID);
  assert.equal(config.scheme, scheme);
  assert.deepEqual(config.extra.restaurant, {
    profile,
    apiBaseUrl: fixture.CRUSTCAPER_API_BASE_URL,
    storeId: fixture.CRUSTCAPER_STORE_ID,
    pspHosts: [fixture.CRUSTCAPER_PSP_HOSTS],
    legalOrigin: fixture.CRUSTCAPER_LEGAL_ORIGIN,
  });
  const manifest = native.android.manifest.manifest;
  const permissions = manifest['uses-permission'] ?? [];
  assert.ok(permissions.some(permission => permission.$['android:name'] === 'android.permission.POST_NOTIFICATIONS'
    && permission.$['tools:node'] === 'remove'));
  assert.equal(native.ios.entitlements['aps-environment'], undefined);
  const application = manifest.application[0];
  assert.equal(application.$['android:allowBackup'], 'false');
  assert.equal(application.$['android:usesCleartextTraffic'], 'false');
  assert.ok(native.android.gradleProperties.some(entry => entry.key === 'android.minSdkVersion' && entry.value === '28'));
  const activities = application.activity.flatMap(activity => activity['intent-filter'] ?? []);
  const verifiedLinks = activities.filter(filter => filter.$?.['android:autoVerify'] === 'true');
  assert.equal(verifiedLinks.length, 1);
  assert.deepEqual(verifiedLinks[0].data, [{
    $: { 'android:scheme': 'https', 'android:host': appLinkHost, 'android:path': '/payment-return' },
  }]);
  assert.deepEqual(verifiedLinks[0].action.map(action => action.$['android:name']), ['android.intent.action.VIEW']);
  assert.deepEqual(verifiedLinks[0].category.map(category => category.$['android:name']).sort(),
    ['android.intent.category.BROWSABLE', 'android.intent.category.DEFAULT']);
  assert.deepEqual(native.ios.entitlements['com.apple.developer.associated-domains'], [`applinks:${appLinkHost}`]);
  assert.equal(native.ios.podfileProperties['ios.deploymentTarget'], '16.0');
  assert.deepEqual(native.ios.infoPlist.NSAppTransportSecurity, {
    NSAllowsArbitraryLoads: false,
    NSAllowsLocalNetworking: false,
  });
  console.log(`${profile} Android manifest and iOS entitlements match the connected configuration`);

  const iosOnly = inspectIosOnly(profile);
  assert.equal(iosOnly.status, 0, iosOnly.stderr);
  const noFirebase = inspect(profile, { CRUSTCAPER_PUSH_PROJECT_ID: pushProjectId }, false);
  assert.notEqual(noFirebase.status, 0);
  assert.match(noFirebase.stderr + noFirebase.stdout, /Set CRUSTCAPER_ANDROID_GOOGLE_SERVICES_FILE/);

  const pushResult = inspectPushWithFixture(profile, [packageId]);
  assert.equal(pushResult.status, 0, pushResult.stderr);
  const pushConfig = JSON.parse(pushResult.stdout);
  assert.equal(pushConfig.extra.restaurant.pushProjectId, pushProjectId);
  assert.equal(pushConfig.extra.eas.projectId, pushProjectId);
  const pushNative = pushConfig._internal.modResults;
  assert.equal(pushNative.ios.entitlements['aps-environment'], 'production');
  const pushManifest = pushNative.android.manifest.manifest;
  const pushPermissions = pushManifest['uses-permission'] ?? [];
  assert.ok(!pushPermissions.some(permission => permission.$['android:name'] === 'android.permission.POST_NOTIFICATIONS'
    && permission.$['tools:node'] === 'remove'));
  const androidApp = pushManifest.application[0];
  const defaultChannel = androidApp['meta-data']?.find(entry =>
    entry.$['android:name'] === 'com.google.firebase.messaging.default_notification_channel_id');
  assert.equal(defaultChannel?.$['android:value'], 'pickup-ready');
  console.log(`${profile} Expo Push project, Android channel and APNs entitlement match the opt-in configuration`);
}

const demoResult = inspect('demo', { CRUSTCAPER_PUSH_PROJECT_ID: pushProjectId });
assert.equal(demoResult.status, 0, demoResult.stderr);
assert.deepEqual(JSON.parse(demoResult.stdout).extra.restaurant, { profile: 'demo' });

const webResult = inspect('stage', { CRUSTCAPER_WEB_CHECKOUT: 'true' });
assert.equal(webResult.status, 0, webResult.stderr);
assert.equal(JSON.parse(webResult.stdout).extra.restaurant.webCheckout, true);

const rejectedProductionConfigs = [
  [{ CRUSTCAPER_API_BASE_URL: undefined }, 'Set CRUSTCAPER_API_BASE_URL'],
  [{ CRUSTCAPER_API_BASE_URL: 'http://127.0.0.1:18080/api/v1' }, 'must use a domain over HTTPS'],
  [{ CRUSTCAPER_STORE_ID: undefined }, 'Set CRUSTCAPER_STORE_ID'],
  [{ CRUSTCAPER_PSP_HOSTS: '*.crustcaper.invalid' }, 'Supply exact PSP host names'],
  [{ CRUSTCAPER_APP_LINK_ORIGIN: undefined }, 'Set CRUSTCAPER_APP_LINK_ORIGIN'],
  [{ CRUSTCAPER_APP_LINK_ORIGIN: 'https://stage.crustcaper.invalid/a' }, 'Use only the app-link origin'],
  [{ CRUSTCAPER_LEGAL_ORIGIN: undefined }, 'Set CRUSTCAPER_LEGAL_ORIGIN'],
  [{ CRUSTCAPER_LEGAL_ORIGIN: 'http://public.crustcaper.invalid' }, 'must use a domain over HTTPS'],
  [{ CRUSTCAPER_LEGAL_ORIGIN: 'https://public.crustcaper.invalid/privacy' }, 'Use only the public legal site origin'],
  [{ CRUSTCAPER_ANDROID_PACKAGE: undefined }, 'Set CRUSTCAPER_ANDROID_PACKAGE'],
  [{ CRUSTCAPER_ANDROID_PACKAGE: 'com.crustcaper.mobile.stage' }, 'Use a distinct, valid native application identifier'],
  [{ CRUSTCAPER_IOS_BUNDLE_ID: undefined }, 'Set CRUSTCAPER_IOS_BUNDLE_ID'],
  [{ CRUSTCAPER_PUSH_PROJECT_ID: 'invalid' }, 'CRUSTCAPER_PUSH_PROJECT_ID must be a UUID'],
];
for (const [overrides, cause] of rejectedProductionConfigs) {
  const result = inspect('production', overrides, false);
  assert.notEqual(result.status, 0, `Expo accepted an invalid production configuration: ${cause}`);
  assert.ok((result.stderr + result.stdout).includes(cause), `Expo failed for a reason other than: ${cause}`);
}
console.log(`Production rejected ${rejectedProductionConfigs.length} invalid configurations`);

for (const [clients, reason, keys] of [
  [['org.crustcaper.different'], /exactly one Firebase client/],
  [[fixture.CRUSTCAPER_ANDROID_PACKAGE, fixture.CRUSTCAPER_ANDROID_PACKAGE], /exactly one Firebase client/],
  [null, /readable google-services\.json/],
  [[fixture.CRUSTCAPER_ANDROID_PACKAGE], /missing or invalid Firebase project or Android client/, ['invalid-key', fixtureApiKey]],
]) {
  const result = inspectPushWithFixture('production', clients, false, keys);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, reason);
}
console.log('Android push rejects missing, mismatched, duplicate, unreadable and malformed Firebase client configuration; iOS-only introspection works independently.');
