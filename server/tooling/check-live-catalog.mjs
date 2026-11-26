import { Buffer } from 'node:buffer';

const storeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const versionPattern = /^[A-Za-z0-9._:-]{1,100}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const catalogPhotoPath = /^\/catalog-photos\/[a-z0-9][a-z0-9._-]{0,119}\.(?:avif|jpe?g|png|webp)$/;
const existingPhotoPath = /^\/assets\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:avif|gif|jpe?g|png|webp)$/i;
const photoMediaTypes = { avif: 'image/avif', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', webp: 'image/webp' };
const pngSignature = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const pngTrailer = Buffer.from('0000000049454e44ae426082', 'hex');
const timeoutMs = 8000;

function menuUrl(baseUrl, storeId, channel) {
  const url = URL.parse(baseUrl);
  const loopback = url?.hostname === '127.0.0.1' || url?.hostname === '[::1]';
  if (!url || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
      || !/^\/api\/v1\/?$/.test(url.pathname) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTPS API base URL ending in /api/v1. HTTP is allowed only on 127.0.0.1 or [::1].');
  }
  return new URL(`/api/v1/stores/${storeId}/menu?channel=${channel}&locale=en`, url.origin);
}

function mediaType(response) {
  return response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
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
  if (mediaType(response) !== 'application/json') {
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

async function readPublicFile(url, label, accept) {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(url, {
      headers: { Accept: accept, 'Accept-Encoding': 'identity' }, cache: 'no-store', redirect: 'manual', signal,
    });
  } catch {
    throw new Error(`${label}: ${signal.aborted ? 'request timed out' : 'could not connect'}.`);
  }
}

async function checkStorefrontPage(origin, locale, storeId, expectedVersion) {
  const label = `Storefront /menu/${locale}`;
  const response = await readPublicFile(new URL(`/menu/${locale}`, origin), label, 'text/html');
  let problem;
  if (response.status !== 200) problem = `HTTP ${response.status}, expected 200`;
  else if (mediaType(response) !== 'text/html') problem = 'expected HTML';
  else if (response.headers.get('content-language') !== locale) problem = 'incorrect Content-Language';
  else if (response.headers.get('x-crustcaper-store-id') !== storeId
      || response.headers.get('x-crustcaper-catalog-version') !== expectedVersion) {
    problem = 'rendered catalog does not match the requested store and version';
  }
  if (problem) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`${label}: ${problem}.`);
  }
  const html = (await readPublicBody(response, label, 12)).toString('utf8');
  const language = new RegExp(`<html\\b[^>]*\\slang="${locale}"(?=\\s|>)`, 'i');
  if (!language.test(html) || !/<main\b[^>]*\sid="main"(?=\s|>)/i.test(html)
      || !html.includes('</main>') || !html.trimEnd().endsWith('</html>')) {
    throw new Error(`${label}: missing or incomplete localized catalog HTML.`);
  }
}

function photoUrl(value, origin) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\x00-\x1f\x7f?#]/.test(value)) return null;
  const inputPath = /^https?:\/\/[^/@]+(\/.*)$/i.exec(value)?.[1];
  const url = URL.parse(value);
  // The accepted HTTP origin, if any, is already restricted to literal loopback by menuUrl.
  if (url?.origin !== origin || url.pathname !== inputPath || url.username || url.password
      || (!catalogPhotoPath.test(inputPath) && !existingPhotoPath.test(inputPath))) return null;
  return url;
}

function isAvif(bytes) {
  if (bytes.toString('latin1', 4, 8) !== 'ftyp') return false;
  const typeSize = bytes.readUInt32BE(0);
  if (typeSize < 16 || typeSize > bytes.length || typeSize % 4 !== 0) return false;
  let avifBrand = false;
  for (let offset = 8; offset < typeSize; offset += 4) {
    if (offset === 12) continue; // Skip the minor version between the major and compatible brands.
    const brand = bytes.toString('latin1', offset, offset + 4);
    if (brand === 'avif' || brand === 'avis') avifBrand = true;
  }
  if (!avifBrand) return false;
  let hasImageBox = false;
  for (let offset = typeSize; offset < bytes.length;) {
    const remaining = bytes.length - offset;
    if (remaining < 8) return false;
    let size = bytes.readUInt32BE(offset);
    const headerSize = size === 1 ? 16 : 8;
    if (remaining < headerSize) return false;
    if (size === 1) size = Number(bytes.readBigUInt64BE(offset + 8));
    else if (size === 0) size = remaining;
    if (size < headerSize || size > remaining) return false;
    const box = bytes.toString('latin1', offset + 4, offset + 8);
    if ((box === 'meta' || box === 'moov') && size > headerSize) hasImageBox = true;
    offset += size;
  }
  return hasImageBox;
}

function hasRasterSignature(bytes, contentType) {
  if (bytes.length < 16) return false;
  switch (contentType) {
    case 'image/jpeg':
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
        && bytes.readUInt16BE(bytes.length - 2) === 0xffd9;
    case 'image/png':
      return bytes.length >= 57 && bytes.subarray(0, pngSignature.length).equals(pngSignature)
        && bytes.subarray(-pngTrailer.length).equals(pngTrailer);
    case 'image/gif':
      return /^GIF8[79]a$/.test(bytes.toString('latin1', 0, 6)) && bytes.at(-1) === 0x3b;
    case 'image/webp':
      return bytes.length >= 20 && bytes.toString('latin1', 0, 4) === 'RIFF'
        && bytes.readUInt32LE(4) + 8 === bytes.length && bytes.toString('latin1', 8, 12) === 'WEBP'
        && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('latin1', 12, 16));
    case 'image/avif':
      return isAvif(bytes);
    default:
      return false;
  }
}

async function checkPhoto(url, label) {
  const extension = url.pathname.slice(url.pathname.lastIndexOf('.') + 1).toLowerCase();
  const expectedType = photoMediaTypes[extension];
  const response = await readPublicFile(url, label, expectedType);
  let problem;
  if (response.status !== 200) problem = `HTTP ${response.status}, expected 200`;
  else if (mediaType(response) !== expectedType) problem = `expected ${expectedType} media type`;
  if (problem) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`${label}: ${problem}.`);
  }
  const bytes = await readPublicBody(response, label, 8);
  if (!hasRasterSignature(bytes, expectedType)) throw new Error(`${label}: file is invalid or truncated.`);
}

async function readPublicBody(response, label, limitMiB) {
  const limit = limitMiB * 1024 * 1024;
  const length = response.headers.get('content-length');
  const encoding = response.headers.get('content-encoding');
  let problem;
  if (encoding && encoding.toLowerCase() !== 'identity') problem = 'expected an uncompressed HTTP response';
  else if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
    problem = `file exceeds the ${limitMiB} MiB limit or has an invalid Content-Length`;
  }
  if (problem) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`${label}: ${problem}.`);
  }

  // Retain only a bounded file so trailers and declared sizes can also reveal truncation.
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > limit) break;
      chunks.push(chunk);
    }
  } catch {
    throw new Error(`${label}: response body was incomplete or timed out.`);
  }
  if (size > limit) throw new Error(`${label}: file exceeds the ${limitMiB} MiB limit.`);
  if (length !== null && size !== Number(length)) {
    throw new Error(`${label}: file is invalid or truncated.`);
  }
  return Buffer.concat(chunks, size);
}

async function checkStorefront(origin, menu, storeId, expectedVersion) {
  for (const locale of ['en', 'rw']) await checkStorefrontPage(origin, locale, storeId, expectedVersion);
  const verified = new Set();
  for (const [index, product] of menu.products.entries()) {
    if (product?.photoUrl == null) continue;
    const label = typeof product.sku === 'string' && versionPattern.test(product.sku)
      ? `Photo for SKU ${product.sku}` : `Photo for product ${index + 1}`;
    const url = photoUrl(product.photoUrl, origin);
    if (!url) throw new Error(`${label}: expected an allowed same-origin catalog photo URL.`);
    if (!verified.has(url.href)) {
      await checkPhoto(url, label);
      verified.add(url.href);
    }
  }
  console.log(`Storefront EN and RW pages and ${verified.size} catalog photo files verified.`);
}

async function checkCatalog(args) {
  const [baseUrl, storeId, expectedVersion, mode] = args;
  const storefront = mode === '--storefront';
  if ((args.length !== 3 && (args.length !== 4 || !storefront))
      || !storeIdPattern.test(storeId) || !versionPattern.test(expectedVersion)) {
    throw new Error('Usage: node server/tooling/check-live-catalog.mjs <api-base-url> <store-id> <expected-version> [--storefront]');
  }
  const url = menuUrl(baseUrl, storeId, storefront ? 'web' : 'mobile');
  // The menu API returns the same products and photo URLs for both locales.
  const menu = await readMenu(url);
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
  if (storefront) await checkStorefront(url.origin, menu, storeId, expectedVersion);
  console.log(`Orderable catalog verified for ${storeId}, version ${expectedVersion}.`);
}

try {
  await checkCatalog(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
