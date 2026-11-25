const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const expoCli = require.resolve('expo/bin/cli');
const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('CRUSTCAPER_')));
const fixture = {
  CRUSTCAPER_API_BASE_URL: 'https://api-stage.crustcaper.invalid/api/v1',
  CRUSTCAPER_STORE_ID: 'ci-test-store',
  CRUSTCAPER_PSP_HOSTS: 'checkout.crustcaper.invalid',
  CRUSTCAPER_APP_LINK_ORIGIN: 'https://stage.crustcaper.invalid',
  CRUSTCAPER_ANDROID_PACKAGE: 'org.crustcaper.civerification',
  CRUSTCAPER_IOS_BUNDLE_ID: 'org.crustcaper.civerification',
};

function inspect(profile, overrides = {}, json = true) {
  const env = { ...inherited, EXPO_NO_TELEMETRY: '1', EXPO_NO_DOTENV: '1', ...fixture, CRUSTCAPER_BUILD_PROFILE: profile };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  const argumentsList = [expoCli, 'config', '--type', 'introspect'];
  if (json) argumentsList.push('--json');
  const result = spawnSync(process.execPath, argumentsList, {
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  return result;
}

for (const profile of ['stage', 'production']) {
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
  });
  const manifest = native.android.manifest.manifest;
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
}

const rejectedProductionConfigs = [
  [{ CRUSTCAPER_API_BASE_URL: undefined }, 'Set CRUSTCAPER_API_BASE_URL'],
  [{ CRUSTCAPER_API_BASE_URL: 'http://127.0.0.1:18080/api/v1' }, 'must use a domain over HTTPS'],
  [{ CRUSTCAPER_STORE_ID: undefined }, 'Set CRUSTCAPER_STORE_ID'],
  [{ CRUSTCAPER_PSP_HOSTS: '*.crustcaper.invalid' }, 'Supply exact PSP host names'],
  [{ CRUSTCAPER_APP_LINK_ORIGIN: undefined }, 'Set CRUSTCAPER_APP_LINK_ORIGIN'],
  [{ CRUSTCAPER_APP_LINK_ORIGIN: 'https://stage.crustcaper.invalid/a' }, 'Use only the app-link origin'],
  [{ CRUSTCAPER_ANDROID_PACKAGE: undefined }, 'Set CRUSTCAPER_ANDROID_PACKAGE'],
  [{ CRUSTCAPER_ANDROID_PACKAGE: 'com.crustcaper.mobile.stage' }, 'Use a distinct, valid native application identifier'],
  [{ CRUSTCAPER_IOS_BUNDLE_ID: undefined }, 'Set CRUSTCAPER_IOS_BUNDLE_ID'],
];
for (const [overrides, cause] of rejectedProductionConfigs) {
  const result = inspect('production', overrides, false);
  assert.notEqual(result.status, 0, `Expo accepted an invalid production configuration: ${cause}`);
  assert.ok((result.stderr + result.stdout).includes(cause), `Expo failed for a reason other than: ${cause}`);
}
console.log(`Production rejected ${rejectedProductionConfigs.length} invalid configurations`);
