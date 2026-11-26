const { buildStorefront } = require('./build-storefront.cjs');

process.exitCode = buildStorefront({
  origin: 'https://crustcaper.test',
  profile: 'stage',
  storeId: 'kigali',
  legal: true,
  pspHosts: 'checkout.flutterwave.com',
  outputDir: 'dist-storefront-test',
});
