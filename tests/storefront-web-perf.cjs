const assert = require('node:assert/strict');
const { mkdir, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');

const localeList = ['en', 'rw'];
const samplesPerLocale = 5;
const mobile = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const network = { latency: 150, downloadThroughput: 200000, uploadThroughput: 93750 };
const navigationTimeoutMs = 10000;
const minimumTtfbMs = 120;
const postLoadWaitMs = 1000;
const stabilityIntervalMs = 250;
const stabilityDeadlineMs = 2000;
const labTargets = { lcpMs: 2500, cls: 0.1 };

class InvalidSample extends Error {}

function requireSample(condition, code) {
  if (!condition) throw new InvalidSample(code);
}

function observePage() {
  const supported = PerformanceObserver.supportedEntryTypes;
  if (!supported.includes('largest-contentful-paint') || !supported.includes('layout-shift')) return;

  let paint = null;
  const shifts = [];
  function takePaint(entries) {
    for (const entry of entries) {
      paint = { startTime: entry.startTime, url: entry.url, element: entry.element?.tagName ?? null };
    }
  }
  function takeShifts(entries) {
    for (const entry of entries) {
      if (!entry.hadRecentInput) shifts.push({ startTime: entry.startTime, value: entry.value });
    }
  }
  const paints = new PerformanceObserver(list => takePaint(list.getEntries()));
  const layouts = new PerformanceObserver(list => takeShifts(list.getEntries()));
  paints.observe({ type: 'largest-contentful-paint', buffered: true });
  layouts.observe({ type: 'layout-shift', buffered: true });

  window.__crustcaperReadVitals = () => {
    takePaint(paints.takeRecords());
    takeShifts(layouts.takeRecords());
    const navigation = performance.getEntriesByType('navigation')[0];
    const resource = paint?.url && performance.getEntriesByName(paint.url, 'resource')[0];
    const unavailableImage = [...document.images].some(image => {
      const rect = image.getBoundingClientRect();
      return rect.width && rect.height && rect.bottom > 0 && rect.top < window.innerHeight
        && rect.right > 0 && rect.left < window.innerWidth && (!image.complete || !image.naturalWidth);
    });
    return {
      paint, shifts, unavailableImage, ttfbMs: navigation?.responseStart,
      loadEventEndMs: navigation?.loadEventEnd,
      resource: resource ? {
        requestStartMs: resource.requestStart, responseEndMs: resource.responseEnd, transferBytes: resource.transferSize,
      } : null,
      viewport: { width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio },
      locale: document.documentElement.lang,
      catalogVisible: Boolean(document.querySelector('main#main .hero h1')),
    };
  };
}

function clsOf(shifts) {
  let start = -Infinity;
  let previous = -Infinity;
  let current = 0;
  let maximum = 0;
  for (const { startTime, value } of shifts) {
    // A session includes consecutive shifts less than one second apart, for up to five seconds.
    if (startTime - previous >= 1000 || startTime - start >= 5000) {
      start = startTime;
      current = 0;
    }
    current += value;
    maximum = Math.max(maximum, current);
    previous = startTime;
  }
  return maximum;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? null;
}

function sameObservation(previous, current) {
  return previous?.paint?.startTime === current?.paint?.startTime
    && previous?.shifts.length === current?.shifts.length
    && previous?.unavailableImage === current?.unavailableImage;
}

async function stableMetrics(page) {
  const read = () => page.evaluate(() => window.__crustcaperReadVitals?.());
  await delay(postLoadWaitMs);
  let previous = await read();
  const deadline = performance.now() + stabilityDeadlineMs;
  do {
    await delay(stabilityIntervalMs);
    const current = await read();
    if (sameObservation(previous, current)) return current;
    previous = current;
  } while (performance.now() < deadline);
  throw new InvalidSample('unstable_paint_or_layout');
}

function normalize(metrics, origin, locale) {
  requireSample(metrics, 'missing_browser_observers');
  const { paint, shifts, unavailableImage, ttfbMs, loadEventEndMs, resource, viewport } = metrics;
  requireSample(metrics.locale === locale && metrics.catalogVisible, 'unexpected_catalog_document');
  requireSample(viewport.width === mobile.viewport.width && viewport.height === mobile.viewport.height
    && viewport.deviceScaleFactor === mobile.deviceScaleFactor, 'unexpected_mobile_viewport');
  requireSample(!unavailableImage, 'viewport_image_unavailable');
  requireSample(Number.isFinite(ttfbMs) && ttfbMs >= minimumTtfbMs, 'throttled_ttfb_unconfirmed');
  requireSample(Number.isFinite(loadEventEndMs) && loadEventEndMs >= ttfbMs, 'invalid_navigation_timing');
  requireSample(Number.isFinite(paint?.startTime) && paint.startTime >= ttfbMs, 'missing_largest_contentful_paint');
  let resourcePath = null;
  if (paint.url) {
    const image = new URL(paint.url);
    requireSample(image.origin === origin && resource?.responseEndMs > 0, 'unverified_lcp_image');
    resourcePath = image.pathname;
  }
  const cls = clsOf(shifts);
  requireSample(Number.isFinite(cls), 'invalid_layout_shift');
  return {
    lcpMs: paint.startTime, cls, ttfbMs, loadEventEndMs, lcpElement: paint.element,
    lcpResource: resourcePath ? { path: resourcePath, ...resource } : null,
  };
}

async function sample({ createContext, origin, locale }) {
  const context = await createContext(mobile);
  try {
    await context.addInitScript(observePage);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.setBypassServiceWorker', { bypass: true });
    const rules = await cdp.send('Network.emulateNetworkConditionsByRule', {
      matchedNetworkConditions: [{ urlPattern: '', ...network }],
    });
    requireSample(rules.ruleIds?.length === 1 && typeof rules.ruleIds[0] === 'string'
      && rules.ruleIds[0].length > 0, 'network_rule_unconfirmed');

    const expected = origin + '/menu/' + locale;
    const documentRequests = new Set();
    const throttledRequests = new Set();
    cdp.on('Network.requestWillBeSent', ({ type, request, requestId }) => {
      if (type === 'Document' && request.url === expected) documentRequests.add(requestId);
    });
    cdp.on('Network.requestWillBeSentExtraInfo', ({ requestId, appliedNetworkConditionsId }) => {
      if (appliedNetworkConditionsId === rules.ruleIds[0]) throttledRequests.add(requestId);
    });
    const assetFailures = new Set();
    page.on('requestfailed', () => assetFailures.add('request_failed'));
    page.on('response', response => {
      if (response.status() >= 400) assetFailures.add('http_error');
    });
    page.on('pageerror', () => assetFailures.add('page_error'));
    const document = await page.goto(expected, { waitUntil: 'load', timeout: navigationTimeoutMs });
    requireSample(document?.status() === 200 && page.url() === expected, 'invalid_catalog_navigation');
    const metrics = await stableMetrics(page);
    requireSample([...documentRequests].some(id => throttledRequests.has(id)), 'navigation_network_rule_unconfirmed');
    requireSample(assetFailures.size === 0, 'catalog_resource_failure');
    return { ...normalize(metrics, origin, locale), navigationThrottled: true };
  } finally {
    await context.close();
  }
}

function summarize(samples) {
  const validSamples = samples.filter(record => !record.error);
  const lcpP75Ms = percentile(validSamples.map(record => record.lcpMs), 0.75);
  const clsP75 = percentile(validSamples.map(record => record.cls), 0.75);
  const ttfbP75Ms = percentile(validSamples.map(record => record.ttfbMs), 0.75);
  const valid = validSamples.length === samplesPerLocale;
  return {
    samples, attemptedSamples: samples.length, validSamples: validSamples.length, valid,
    lcpP75Ms, clsP75, ttfbP75Ms,
    withinLabTargets: valid ? lcpP75Ms <= labTargets.lcpMs && clsP75 <= labTargets.cls : null,
  };
}

async function checkWebPerformance({ browser, createContext, origin, evidence }) {
  const results = Object.fromEntries(localeList.map(locale => [locale, []]));
  for (let run = 1; run <= samplesPerLocale; run++) {
    for (const locale of localeList) {
      try {
        results[locale].push({ run, ...await sample({ createContext, origin, locale }) });
      } catch (error) {
        results[locale].push({ run, error: error instanceof InvalidSample ? error.message : 'browser_sample_failed' });
      }
    }
  }
  const catalog = Object.fromEntries(localeList.map(locale => [locale, {
    path: '/menu/' + locale, ...summarize(results[locale]),
  }]));
  const valid = Object.values(catalog).every(result => result.valid);
  const report = {
    scope: 'local_https_synthetic_catalog', recordedAt: new Date().toISOString(), browserVersion: browser.version(),
    settings: {
      samplesPerLocale, mobile, cacheDisabled: true, serviceWorkers: 'blocked', waitUntil: 'load',
      network: { latencyMs: network.latency, downloadBytesPerSecond: network.downloadThroughput,
        uploadBytesPerSecond: network.uploadThroughput, minimumTtfbMs },
      navigationTimeoutMs, postLoadWaitMs, stabilityIntervalMs, stabilityDeadlineMs,
    },
    labTargets, valid, withinLabTargets: valid ? Object.values(catalog).every(result => result.withinLabTargets) : null,
    catalog,
  };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await writeFile(join(evidence, 'storefront-web-perf.json'), json);
  }
  console.log(json.trimEnd());
  assert.ok(valid, 'Invalid catalog performance samples, see storefront-web-perf evidence');
}

module.exports = { checkWebPerformance };
