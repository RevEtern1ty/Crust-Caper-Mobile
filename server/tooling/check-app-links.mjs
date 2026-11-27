const packagePattern = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;
const fingerprintPattern = /^[0-9A-F]{2}(?::[0-9A-F]{2}){31}$/i;
const paymentReturn = '/payment-return';
const androidRelation = 'delegate_permission/common.handle_all_urls';
const maxResponseBytes = 1024 * 1024;
const callbackProbe = {
  orderId: 'c0de0000-1111-4222-8333-444444444444',
  tx_ref: 'cc-app-link-fixture-reference',
  transaction_id: '987654321098765432',
  status: 'cc-app-link-fixture-status',
};

async function readPublished(origin, path, mediaType, query) {
  const url = new URL(path, origin);
  if (query) url.search = new URLSearchParams(query);
  const signal = AbortSignal.timeout(8000);
  let response;
  try {
    response = await fetch(url, {
      headers: { Accept: mediaType }, cache: 'no-store', credentials: 'omit', redirect: 'manual', signal,
    });
  } catch {
    throw new Error(`${path} could not be reached over verified HTTPS.`);
  }
  if (response.status !== 200 || response.redirected) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`${path} returned HTTP ${response.status}. Expected 200 without a redirect.`);
  }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== mediaType) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`${path} did not return ${mediaType}.`);
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let length = 0;
  let text = '';
  try {
    for await (const chunk of response.body ?? []) {
      length += chunk.byteLength;
      if (length > maxResponseBytes) break;
      text += decoder.decode(chunk, { stream: true });
    }
    if (length <= maxResponseBytes) {
      text += decoder.decode();
      return { headers: response.headers, content: mediaType === 'application/json' ? JSON.parse(text) : text };
    }
  } catch {
    throw new Error(`${path} could not be read as ${mediaType} before the request ended.`);
  }
  throw new Error(`${path} exceeded the 1 MiB response size limit.`);
}

function matchesAndroid(links, androidPackage, fingerprint) {
  return Array.isArray(links) && links.some(link => {
    const target = link?.target;
    return target?.namespace === 'android_app' && target.package_name === androidPackage
      && Array.isArray(link.relation) && link.relation.includes(androidRelation)
      && link.relation_extensions?.[androidRelation]?.dynamic_app_link_components === undefined
      && Array.isArray(target.sha256_cert_fingerprints)
      && target.sha256_cert_fingerprints.some(value => typeof value === 'string' && value.toUpperCase() === fingerprint);
  });
}

function matchesApple(association, iosAppId) {
  const details = association?.applinks?.details;
  if (!Array.isArray(details)) return false;
  const entries = details.filter(entry => Array.isArray(entry?.appIDs) && entry.appIDs.includes(iosAppId));
  if (entries.length !== 1) return false;
  const components = entries[0].components;
  return Array.isArray(components) && components.length === 1 && components[0]?.['/'] === paymentReturn
    && Object.keys(components[0]).every(key => key === '/' || key === 'comment');
}

function headerValues(headers, name) {
  return (headers.get(name) ?? '').split(',').map(value => value.trim().toLowerCase());
}

function verifyPaymentReturn({ headers, content }) {
  if (!headerValues(headers, 'Cache-Control').includes('no-store')) {
    throw new Error(`${paymentReturn} must set Cache-Control: no-store.`);
  }
  if (!headerValues(headers, 'Referrer-Policy').every(value => value === 'no-referrer')) {
    throw new Error(`${paymentReturn} must set Referrer-Policy: no-referrer.`);
  }
  const output = [content, ...headers.values()];
  if (Object.values(callbackProbe).some(value => output.some(part => part.includes(value)))) {
    throw new Error(`${paymentReturn} reflected a callback parameter.`);
  }
  if (!content.includes('<title>Return to CrustCaper</title>')) {
    throw new Error(`${paymentReturn} did not serve the CrustCaper return page.`);
  }
}

async function checkAppLinks(rawArgs) {
  const associationsOnly = rawArgs[0] === '--associations-only';
  const args = associationsOnly ? rawArgs.slice(1) : rawArgs;
  const [base, deployedReturn, androidPackage, fingerprint, iosAppId] = args;
  if (args.length !== 5 || !packagePattern.test(androidPackage) || !fingerprintPattern.test(fingerprint)
      || !/^[A-Z0-9]{10}\./.test(iosAppId) || !packagePattern.test(iosAppId.slice(11))) {
    throw new Error('Usage: node server/tooling/check-app-links.mjs [--associations-only] <https-origin> <payment-return-url> <android-package> <cert-sha256> <ios-app-id>');
  }
  const origin = URL.parse(base);
  if (origin?.protocol !== 'https:' || origin.pathname !== '/' || origin.username || origin.password || origin.search
      || origin.hash || (origin.port && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) {
    throw new Error('Use an HTTPS origin without a path, query or credentials. A custom port is allowed only on loopback.');
  }
  if (!/^https:\/\/[^/?#]+\/payment-return$/i.test(deployedReturn)
      || URL.parse(deployedReturn)?.href !== new URL(paymentReturn, origin).href) {
    throw new Error(`The deployed payment return URL must use ${paymentReturn} on the app-link origin.`);
  }
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw new Error('Enable TLS certificate verification before checking the published links.');
  }
  const [assetLinks, appleAssociation, returnPage] = await Promise.all([
    readPublished(origin, '/.well-known/assetlinks.json', 'application/json'),
    readPublished(origin, '/.well-known/apple-app-site-association', 'application/json'),
    associationsOnly ? undefined : readPublished(origin, paymentReturn, 'text/html', callbackProbe),
  ]);
  if (!matchesAndroid(assetLinks.content, androidPackage, fingerprint.toUpperCase())) {
    throw new Error('Android association does not match the expected package and signing certificate.');
  }
  if (!matchesApple(appleAssociation.content, iosAppId)) {
    throw new Error(`Apple association does not map the expected application ID to ${paymentReturn}.`);
  }
  if (associationsOnly) {
    console.log('Verified Android and Apple associations over HTTPS.');
  } else {
    verifyPaymentReturn(returnPage);
    console.log(`Verified Android and Apple associations and ${paymentReturn} over HTTPS.`);
  }
}

try {
  await checkAppLinks(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
