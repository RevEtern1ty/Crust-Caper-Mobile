process.env.NEXT_TELEMETRY_DISABLED = '1';

if (process.argv[2] === 'start') {
  const { cpSync } = require('node:fs');
  const { join } = require('node:path');
  const build = join(__dirname, '../.next');
  const runtime = join(build, 'standalone');

  cpSync(join(build, 'static'), join(runtime, '.next/static'), { recursive: true });
  process.env.HOSTNAME = '0.0.0.0';
  process.env.PORT ||= '3000';
  require(join(runtime, 'server.js'));
} else {
  require('next/dist/bin/next');
}
