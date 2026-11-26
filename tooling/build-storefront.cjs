const { spawnSync } = require('node:child_process');
const { lstatSync } = require('node:fs');
const { dirname, resolve } = require('node:path');
const { parseArgs } = require('node:util');

const projectRoot = resolve(dirname(module.filename), '..');
const outputName = /^dist-storefront(?:-[a-z0-9]+(?:[._-][a-z0-9]+)*)?$/;
const usage = 'npm run build:storefront -- --origin https://stage.example.test --profile stage --store-id kigali --psp-hosts checkout.flutterwave.com [--output-dir dist-storefront-stage]\n'
  + 'Production requires --android-package and --ios-bundle-id. The default output directory is dist-storefront.';

function parseStorefrontArguments(args) {
  const { values } = parseArgs({ args, options: {
    help: { type: 'boolean' },
    origin: { type: 'string' },
    profile: { type: 'string' },
    'store-id': { type: 'string' },
    'psp-hosts': { type: 'string' },
    'output-dir': { type: 'string', default: 'dist-storefront' },
    'android-package': { type: 'string' },
    'ios-bundle-id': { type: 'string' },
  } });
  if (values.help) return null;
  const { origin, profile, 'store-id': storeId, 'psp-hosts': pspHosts, 'output-dir': outputDir,
    'android-package': androidPackage, 'ios-bundle-id': iosBundleId } = values;
  const url = URL.parse(origin ?? '');
  if (url?.protocol !== 'https:' || url.port || (origin !== url.origin && origin !== url.origin + '/')) {
    throw new Error('Set --origin to a canonical HTTPS origin on its standard port.');
  }
  if (profile !== 'stage' && profile !== 'production') throw new Error('Set --profile to stage or production.');
  if (!storeId?.trim() || !pspHosts?.trim()) throw new Error('Set --store-id and --psp-hosts.');
  if (profile === 'production' && (!androidPackage?.trim() || !iosBundleId?.trim())) {
    throw new Error('Set --android-package and --ios-bundle-id for production.');
  }
  if (profile === 'stage' && (androidPackage !== undefined || iosBundleId !== undefined)) {
    throw new Error('The stage profile uses the staging application identifiers.');
  }
  if (outputDir === 'dist-storefront-test') throw new Error('Use npm run build:storefront-test for the fixture output.');
  return { origin: url.origin, profile, storeId, pspHosts, outputDir, androidPackage, iosBundleId };
}

function storefrontEnvironment({ origin, profile, storeId, pspHosts, androidPackage, iosBundleId }, inherited = process.env) {
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) => !/^(?:CRUSTCAPER_|EXPO_|EAS_)/i.test(key)));
  return {
    ...env,
    EXPO_NO_TELEMETRY: '1',
    EXPO_NO_DOTENV: '1',
    EXPO_NO_CLIENT_ENV_VARS: '1',
    CRUSTCAPER_BUILD_PROFILE: profile,
    CRUSTCAPER_WEB_CHECKOUT: 'true',
    CRUSTCAPER_API_BASE_URL: `${origin}/api/v1`,
    CRUSTCAPER_APP_LINK_ORIGIN: origin,
    CRUSTCAPER_PSP_HOSTS: pspHosts,
    CRUSTCAPER_STORE_ID: storeId,
    ...(androidPackage && { CRUSTCAPER_ANDROID_PACKAGE: androidPackage }),
    ...(iosBundleId && { CRUSTCAPER_IOS_BUNDLE_ID: iosBundleId }),
  };
}

function buildStorefront(options) {
  const { outputDir } = options;
  if (typeof outputDir !== 'string' || outputDir.length > 80 || !outputName.test(outputDir)) {
    throw new Error('Set --output-dir to dist-storefront or dist-storefront-<label> in the repository root.');
  }
  const target = lstatSync(resolve(projectRoot, outputDir), { throwIfNoEntry: false });
  // Expo clears the output directory before exporting.
  if (target && (!target.isDirectory() || target.isSymbolicLink())) {
    throw new Error('The output directory must be a regular directory in the repository root.');
  }
  const build = spawnSync(process.execPath, [
    require.resolve('expo/bin/cli'), 'export', '--platform', 'web', '--output-dir', outputDir,
  ], { cwd: projectRoot, env: storefrontEnvironment(options), stdio: 'inherit' });
  if (build.error) throw new Error(`Could not start the Expo storefront build (${build.error.code}).`);
  return build.status ?? 1;
}

if (require.main === module) {
  try {
    const options = parseStorefrontArguments(process.argv.slice(2));
    if (options) process.exitCode = buildStorefront(options);
    else console.log(usage);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { buildStorefront, parseStorefrontArguments, storefrontEnvironment };
