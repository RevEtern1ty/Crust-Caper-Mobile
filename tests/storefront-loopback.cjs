const dns = require('node:dns');

const host = 'crustcaper.test';
const origin = 'https://' + host;
if (!process.env.NODE_EXTRA_CA_CERTS) throw new Error('The loopback preflight requires the fixture CA');

// Installed only in the preflight child. Socket destination changes without altering SNI or HTTPS validation.
dns.lookup = (hostname, options, callback) => {
  const done = typeof options === 'function' ? options : callback;
  if (hostname !== host) {
    process.nextTick(done, Object.assign(new Error('Unexpected fixture DNS name'), { code: 'ENOTFOUND' }));
  } else if (options?.all) {
    process.nextTick(done, null, [{ address: '127.0.0.1', family: 4 }]);
  } else {
    process.nextTick(done, null, '127.0.0.1', 4);
  }
};

const fetchFixture = globalThis.fetch;
globalThis.fetch = (resource, options) => {
  if (new URL(resource).origin !== origin || options?.redirect !== 'manual') {
    throw new Error('Unexpected fixture request destination or redirect policy');
  }
  return fetchFixture(resource, options);
};
