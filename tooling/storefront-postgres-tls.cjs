const { createPrivateKey, createPublicKey, randomBytes, X509Certificate } = require('node:crypto');
const { mkdir, readFile, rm, writeFile } = require('node:fs/promises');
const { dirname, join } = require('node:path');

const postgresTlsMount = '/fixture/postgres-tls';
const postgresCaMount = '/run/crustcaper/postgres-ca.crt';
const postgresTlsRuntime = '/run/postgres-tls';
const postgresJdbcTlsQuery = `
  SELECT count(*) > 0 AND coalesce(bool_and(tls.ssl), false)
  FROM pg_stat_activity activity JOIN pg_stat_ssl tls USING (pid)
  WHERE activity.datname = current_database() AND activity.usename = current_user
    AND activity.client_addr IS NOT NULL AND activity.application_name = 'PostgreSQL JDBC Driver'
`;
const postgresTlsEntrypoint = `
  chmod 755 ${postgresTlsRuntime}
  cp ${postgresTlsMount}/ca.crt ${postgresTlsMount}/server.crt ${postgresTlsMount}/server.key ${postgresTlsMount}/pg_hba.conf ${postgresTlsRuntime}/
  chmod 644 ${postgresTlsRuntime}/ca.crt ${postgresTlsRuntime}/server.crt ${postgresTlsRuntime}/pg_hba.conf
  chmod 600 ${postgresTlsRuntime}/server.key
  chown postgres:postgres ${postgresTlsRuntime}/server.key
  exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=${postgresTlsRuntime}/server.crt \
    -c ssl_key_file=${postgresTlsRuntime}/server.key -c hba_file=${postgresTlsRuntime}/pg_hba.conf
`;

function fixtureDatabaseUrl(database) {
  return `jdbc:postgresql://postgres:5432/${database}?sslmode=verify-full&sslrootcert=${postgresCaMount}`;
}

async function preparePostgresTls(directory, env, run) {
  const tlsDirectory = join(directory, 'postgres-tls');
  await mkdir(tlsDirectory, { mode: 0o700 });
  const caStore = join(directory, 'postgres-ca.p12');
  const serverStore = join(directory, 'postgres-server.p12');
  const request = join(directory, 'postgres-server.csr');
  const caFile = join(tlsDirectory, 'ca.crt');
  const certificate = join(tlsDirectory, 'server.crt');
  const keyEnvironment = { ...env, CRUSTCAPER_FIXTURE_TLS_KEY_PASSWORD: randomBytes(24).toString('hex') };
  const javaTool = name => env.JAVA_HOME
    ? join(env.JAVA_HOME, 'bin', process.platform === 'win32' ? `${name}.exe` : name) : name;
  const safeOptions = { env: keyEnvironment, capture: true };
  const store = (path, alias) => ['-keystore', path, '-storetype', 'PKCS12', '-alias', alias,
    '-storepass:env', 'CRUSTCAPER_FIXTURE_TLS_KEY_PASSWORD'];
  const ca = store(caStore, 'ca');
  const server = store(serverStore, 'postgres');
  try {
    await run('Generate the PostgreSQL fixture CA', javaTool('keytool'), ['-genkeypair', ...ca,
      '-keyalg', 'RSA', '-keysize', '2048', '-validity', '2', '-dname', 'CN=CrustCaper PostgreSQL fixture CA',
      '-ext', 'bc:c=ca:true', '-ext', 'ku:c=keyCertSign,cRLSign'], safeOptions);
    await run('Generate the PostgreSQL fixture key', javaTool('keytool'), ['-genkeypair', ...server,
      '-keyalg', 'RSA', '-keysize', '2048', '-validity', '2', '-dname', 'CN=postgres'], safeOptions);
    await run('Create the PostgreSQL fixture certificate request', javaTool('keytool'), ['-certreq', ...server, '-file', request], safeOptions);
    await run('Sign the PostgreSQL fixture certificate', javaTool('keytool'), ['-gencert', ...ca,
      '-rfc', '-validity', '2', '-infile', request, '-outfile', certificate,
      '-ext', 'san=dns:postgres', '-ext', 'eku=serverAuth', '-ext', 'ku=digitalSignature,keyEncipherment'], safeOptions);
    await run('Export the PostgreSQL fixture CA', javaTool('keytool'), ['-exportcert', ...ca,
      '-rfc', '-file', caFile], safeOptions);
    const pem = await run('Export the PostgreSQL fixture private key', javaTool('java'), [
      join(dirname(module.filename), 'StorefrontPostgresPrivateKey.java'), serverStore,
    ], safeOptions);
    const root = new X509Certificate(await readFile(caFile));
    const leaf = new X509Certificate(await readFile(certificate));
    const key = createPublicKey(createPrivateKey(pem));
    if (!root.ca || leaf.ca || !leaf.verify(root.publicKey) || leaf.checkHost('postgres', { subject: 'never' }) !== 'postgres'
      || !leaf.publicKey.equals(key)) throw new Error('PostgreSQL fixture certificate validation failed');
    await writeFile(join(tlsDirectory, 'server.key'), pem + '\n', { mode: 0o600 });
    // Administrative commands run on the local socket. Every TCP client must use TLS and a password.
    await writeFile(join(tlsDirectory, 'pg_hba.conf'), 'local all all trust\nhostssl all all all scram-sha-256\n');
    return { tlsDirectory, caFile };
  } finally {
    await Promise.all([caStore, serverStore, request].map(path => rm(path, { force: true })));
  }
}

module.exports = {
  fixtureDatabaseUrl, preparePostgresTls, postgresJdbcTlsQuery, postgresTlsEntrypoint, postgresTlsMount, postgresTlsRuntime,
};
