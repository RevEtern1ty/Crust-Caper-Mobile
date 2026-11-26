const { spawnSync } = require('node:child_process');
const { dirname, resolve } = require('node:path');

const root = resolve(dirname(module.filename), '..');
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(?:CRUSTCAPER_|EXPO_PUBLIC_|EAS_)/i.test(key)));
const origin = 'https://crustcaper.test';
Object.assign(env, {
  EXPO_NO_TELEMETRY: '1',
  EXPO_NO_DOTENV: '1',
  EXPO_NO_CLIENT_ENV_VARS: '1',
  CRUSTCAPER_BUILD_PROFILE: 'stage',
  CRUSTCAPER_WEB_CHECKOUT: 'true',
  CRUSTCAPER_API_BASE_URL: origin + '/api/v1',
  CRUSTCAPER_APP_LINK_ORIGIN: origin,
  CRUSTCAPER_PSP_HOSTS: 'checkout.flutterwave.com',
  CRUSTCAPER_STORE_ID: 'kigali',
});

const build = spawnSync(process.execPath, [
  require.resolve('expo/bin/cli'), 'export', '--platform', 'web', '--output-dir', 'dist-storefront-test',
], { cwd: root, env, stdio: 'inherit' });
if (build.error) {
  console.error('Could not build the test checkout bundle:', build.error.code);
}
process.exitCode = build.status ?? 1;
