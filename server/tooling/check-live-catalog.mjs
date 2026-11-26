const storeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const versionPattern = /^[A-Za-z0-9._:-]{1,100}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const timeoutMs = 8000;

function menuUrl(baseUrl, storeId) {
  const url = URL.parse(baseUrl);
  const loopback = url?.hostname === '127.0.0.1' || url?.hostname === '[::1]';
  if (!url || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
      || !/^\/api\/v1\/?$/.test(url.pathname) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTPS API base URL ending in /api/v1. HTTP is allowed only on 127.0.0.1 or [::1].');
  }
  return new URL(`/api/v1/stores/${storeId}/menu?channel=mobile&locale=en`, url.origin);
}

async function readMenu(url) {
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      redirect: 'manual',
      signal,
    });
  } catch {
    throw new Error(signal.aborted ? 'Timed out waiting for the menu API.' : 'Could not connect to the menu API.');
  }
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`Menu API returned HTTP ${response.status}. Expected 200.`);
  }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    await response.body?.cancel();
    throw new Error('Menu API response is missing the application/json media type.');
  }
  try {
    return await response.json();
  } catch {
    throw new Error(signal.aborted ? 'Timed out reading the menu response.' : 'Menu API returned invalid JSON.');
  }
}

function timestamp(value) {
  return typeof value === 'string' && timestampPattern.test(value) ? Date.parse(value) : NaN;
}

async function checkCatalog(args) {
  const [baseUrl, storeId, expectedVersion] = args;
  if (args.length !== 3 || !storeIdPattern.test(storeId) || !versionPattern.test(expectedVersion)) {
    throw new Error('Usage: node server/tooling/check-live-catalog.mjs <api-base-url> <store-id> <expected-version>');
  }
  const menu = await readMenu(menuUrl(baseUrl, storeId));
  if (menu?.store?.id !== storeId) throw new Error(`Menu does not match the requested store ${storeId}.`);
  if (menu.version !== expectedVersion) throw new Error(`Menu does not match the expected version ${expectedVersion}.`);
  if (menu.store.open !== true) throw new Error('Store is not accepting orders.');
  if (!Array.isArray(menu.products) || !menu.products.some(product =>
    product?.available === true && typeof product.sku === 'string' && product.sku.trim())) {
    throw new Error('Menu has no available product with a valid SKU.');
  }
  const now = Date.now();
  if (!Array.isArray(menu.slots) || !menu.slots.some(slot => {
    if (slot?.available !== true || typeof slot.id !== 'string' || !slot.id.trim()) return false;
    const startsAt = timestamp(slot.startsAt);
    return startsAt > now && timestamp(slot.endsAt) > startsAt;
  })) {
    throw new Error('Menu has no available future pickup window.');
  }
  console.log(`Orderable catalog verified for ${storeId}, version ${expectedVersion}.`);
}

try {
  await checkCatalog(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
