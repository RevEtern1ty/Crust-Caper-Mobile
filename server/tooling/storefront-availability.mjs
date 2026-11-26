import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { TextDecoder } from 'node:util';
import { hasRenderedCatalogDocument, isMainModule, storeIdPattern, versionPattern } from './check-live-catalog.mjs';

const requestTimeoutMs = 8000;
const maxCatalogBytes = 12 * 1024 * 1024;
const maxOperatorShellBytes = 256 * 1024;
const maxProblemBytes = 16 * 1024;
const maxIntervalMs = 2 ** 31 - 1;

class ProbeFailure extends Error {}

function requireCondition(condition, code) {
  if (!condition) throw new ProbeFailure(code);
}

function storefrontOrigin(apiBaseUrl, storeId) {
  requireCondition(typeof apiBaseUrl === 'string' && apiBaseUrl.length <= 2048
    && !/[\s\\\x00-\x1f\x7f]/.test(apiBaseUrl) && typeof storeId === 'string'
    && storeIdPattern.test(storeId), 'invalid_config');
  const authority = /^https?:\/\/([^/?#@]+)\/api\/v1\/?$/i.exec(apiBaseUrl)?.[1];
  const url = URL.parse(apiBaseUrl);
  const loopback = /^(?:127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/.test(authority ?? '');
  requireCondition(authority && url?.hostname && !url.username && !url.password && /^\/api\/v1\/?$/.test(url.pathname)
    && (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)), 'invalid_config');
  return url.origin;
}

async function withSignal(signal, operation) {
  signal.throwIfAborted();
  let onAbort;
  const interrupted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([interrupted, operation()]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function readText(response, limit, signal) {
  const length = response.headers.get('content-length');
  requireCondition(length === null || /^[0-9]+$/.test(length), 'invalid_body');
  requireCondition(length === null || Number(length) <= limit, 'body_too_large');
  const reader = response.body?.getReader();
  requireCondition(reader, 'invalid_body');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const parts = [];
  let consumed = false;
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await withSignal(signal, () => reader.read());
      if (done) break;
      bytes += value.byteLength;
      requireCondition(bytes <= limit, 'body_too_large');
      parts.push(decoder.decode(value, { stream: true }));
    }
    consumed = true;
    const encoding = response.headers.get('content-encoding')?.trim().toLowerCase();
    // Node fetch decodes compressed bodies and retains the wire Content-Length header.
    if (length !== null && (!encoding || encoding === 'identity')) {
      requireCondition(bytes === Number(length), 'invalid_body');
    }
    parts.push(decoder.decode());
    return parts.join('');
  } finally {
    if (!consumed) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function validateMenu(text, storeId) {
  const menu = JSON.parse(text);
  requireCondition(typeof menu?.store?.open === 'boolean' && Array.isArray(menu.products)
    && Array.isArray(menu.slots), 'menu_shape');
  requireCondition(menu.store.id === storeId, 'store_mismatch');
  requireCondition(typeof menu.version === 'string' && versionPattern.test(menu.version), 'catalog_version');
  return menu.store.open;
}

function validateMenuPage(text, headers, locale, storeId) {
  requireCondition(headers.get('content-language') === locale, 'locale_mismatch');
  requireCondition(headers.get('x-crustcaper-store-id') === storeId, 'store_mismatch');
  requireCondition(versionPattern.test(headers.get('x-crustcaper-catalog-version') ?? ''), 'catalog_version');
  requireCondition(hasRenderedCatalogDocument(text, locale), 'invalid_body');
}

function validateOperatorShell(text) {
  const login = /<form\b[^>]*\sid=["']login-form["'][^>]*>([\s\S]*?)<\/form>/i.exec(text)?.[1] ?? '';
  requireCondition(/<html\b/i.test(text) && text.trimEnd().endsWith('</html>')
    && /<input\b[^>]*\sname=["']username["']/i.test(login)
    && /<input\b[^>]*\sname=["']password["']/i.test(login)
    && /<input\b[^>]*\sname=["']authenticatorCode["']/i.test(login), 'operator_shell');
}

function validateOperatorAuth(text, headers) {
  requireCondition(/^Bearer(?:\s|$)/i.test(headers.get('www-authenticate')?.trim() ?? ''), 'auth_challenge');
  const problem = JSON.parse(text);
  requireCondition(problem?.status === 401 && problem.code === 'unauthenticated', 'auth_problem');
}

async function probeEndpoint(origin, endpoint, fetchImpl, signal) {
  const start = performance.now();
  const timeout = new AbortController();
  const deadline = setTimeout(() => timeout.abort(), requestTimeoutMs);
  const active = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  let response;
  let status = null;
  let value = null;
  let code = 'ok';
  try {
    response = await withSignal(active, async () => {
      const result = await fetchImpl(new URL(endpoint.path, origin), {
        method: 'GET',
        headers: { Accept: endpoint.media, 'Accept-Encoding': 'identity' },
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'manual',
        signal: active,
      });
      if (active.aborted) void result.body?.cancel().catch(() => {});
      return result;
    });
    requireCondition(Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599, 'invalid_body');
    status = response.status;
    requireCondition(!response.redirected && !(status >= 300 && status < 400 && status !== 304), 'redirect');
    requireCondition(status === endpoint.status, 'http_status');
    const media = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    requireCondition(media === endpoint.media, 'media_type');
    const text = await readText(response, endpoint.limit, active);
    value = endpoint.validate(text, response.headers) ?? null;
  } catch (error) {
    if (signal?.aborted) code = 'aborted';
    else if (timeout.signal.aborted) code = 'timeout';
    else if (error instanceof ProbeFailure) code = error.message;
    else code = response ? 'invalid_body' : 'network_error';
  } finally {
    clearTimeout(deadline);
    if (response?.body && !response.bodyUsed) void response.body.cancel().catch(() => {});
  }
  return { check: endpoint.check, ok: code === 'ok', status, code,
    elapsedMs: Math.round(performance.now() - start), value };
}

export async function checkAvailability({ apiBaseUrl, storeId, fetchImpl = fetch, signal } = {}) {
  const origin = storefrontOrigin(apiBaseUrl, storeId);
  requireCondition(typeof fetchImpl === 'function', 'invalid_config');
  const menuPages = ['en', 'rw'].map(locale => ({
    check: 'menu_' + locale, path: '/menu/' + locale, status: 200, media: 'text/html', limit: maxCatalogBytes,
    validate: (text, headers) => validateMenuPage(text, headers, locale, storeId),
  }));
  const endpoints = [
    { check: 'menu_api', path: '/api/v1/stores/' + encodeURIComponent(storeId) + '/menu?channel=web&locale=en',
      status: 200, media: 'application/json', limit: maxCatalogBytes, validate: text => validateMenu(text, storeId) },
    ...menuPages,
    { check: 'operator_shell', path: '/operator/index.html', status: 200,
      media: 'text/html', limit: maxOperatorShellBytes, validate: validateOperatorShell },
    { check: 'operator_auth', path: '/api/v1/operator/orders', status: 401,
      media: 'application/problem+json', limit: maxProblemBytes, validate: validateOperatorAuth },
  ];
  const results = await Promise.all(endpoints.map(endpoint => probeEndpoint(origin, endpoint, fetchImpl, signal)));
  return {
    ok: results.every(check => check.ok),
    orderingOpen: results[0].value,
    checks: results.map(({ value, ...check }) => check),
  };
}

export async function watchAvailability({ probe, emit, intervalMs = 10000, signal } = {}) {
  requireCondition(typeof probe === 'function' && typeof emit === 'function' && Number.isInteger(intervalMs)
    && intervalMs >= 1 && intervalMs <= maxIntervalMs, 'invalid_config');
  const stop = signal ?? new AbortController().signal;
  let announced = false;
  let incident = false;
  let failures = 0;
  let successes = 0;
  try {
    while (!stop.aborted) {
      const result = await withSignal(stop, () => probe(stop));
      requireCondition(typeof result?.ok === 'boolean', 'probe_failed');
      let event;
      if (result.ok) {
        failures = 0;
        successes++;
        if (incident && successes >= 2) {
          incident = false;
          event = 'recovered';
        } else if (!incident && !announced) {
          event = 'ready';
        }
      } else {
        successes = 0;
        failures++;
        if (!incident && failures >= 2) {
          incident = true;
          event = 'incident';
        }
      }
      if (event && !stop.aborted) {
        announced = true;
        await emit({ event, at: new Date().toISOString(), orderingOpen: result.orderingOpen, checks: result.checks });
      }
      if (!stop.aborted) await delay(intervalMs, undefined, { signal: stop });
    }
  } catch (error) {
    if (!stop.aborted || (error !== stop.reason && error?.cause !== stop.reason)) throw error;
  }
}

function writeJson(output) {
  return new Promise((resolve, reject) => {
    process.stdout.write(JSON.stringify(output) + '\n', error => error ? reject(error) : resolve());
  });
}

async function main(args) {
  const [apiBaseUrl, storeId, mode] = args;
  try {
    requireCondition(args.length === 2 || (args.length === 3 && mode === '--watch'), 'invalid_config');
    storefrontOrigin(apiBaseUrl, storeId);
  } catch {
    process.exitCode = 2;
    await writeJson({ ok: false, code: 'invalid_config' });
    return;
  }

  const controller = new AbortController();
  const stop = () => controller.abort();
  const probe = signal => checkAvailability({ apiBaseUrl, storeId, signal });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    if (mode === '--watch') {
      await watchAvailability({ probe, emit: writeJson, signal: controller.signal });
    } else {
      const result = await probe(controller.signal);
      await writeJson(result);
      process.exitCode = result.ok ? 0 : 1;
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }
}

if (isMainModule(import.meta)) {
  try {
    await main(process.argv.slice(2));
  } catch {
    process.exitCode = 1;
    console.error('storefront_availability_failed');
  }
}
