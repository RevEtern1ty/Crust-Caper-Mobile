const { Buffer } = require('node:buffer');
const { execFileSync } = require('node:child_process');
const { mkdir, readFile, writeFile } = require('node:fs/promises');
const { Agent, request: httpsRequest } = require('node:https');
const { join } = require('node:path');
const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');

const menuPath = '/api/v1/stores/kigali/menu?channel=web&locale=en';
const readerCount = 50;
const readIntervalMs = 5000;
const checkoutIntervalMs = 3000;
const checkoutLimit = 8;
const maximumLatenessMs = 1000;
const requestTimeoutMs = 8000;
const responseLimit = 1024 * 1024;
const targets = { menu: 500, order_create: 1000, kitchen: 10000 };
const projectPattern = /^cc-storefront-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const providerPath = /^\/v3\/hosted\/pay\/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

class LoadFailure extends Error {}

function requireCondition(condition, code) {
  if (!condition) throw new LoadFailure(code);
}

function docker(args) {
  try {
    return execFileSync('docker', args, {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000, windowsHide: true,
    }).trim();
  } catch {
    throw new LoadFailure('docker_fixture_unavailable');
  }
}

function requireFixture(project) {
  requireCondition(projectPattern.test(project ?? ''), 'fixture_project_required');
  const endpoint = !process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST
    ? process.env.DOCKER_HOST : docker(['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']);
  requireCondition(/^unix:\/\/\/[^\r\n]+$/.test(endpoint) || /^npipe:\/\/\/\/\.\/pipe\/[\w.-]+$/i.test(endpoint),
    'local_docker_required');
  const edge = docker(['ps', '--filter', `label=com.docker.compose.project=${project}`, '--filter',
    'label=com.docker.compose.service=edge', '--format', '{{.ID}}']);
  requireCondition(/^[a-f0-9]{12,64}$/.test(edge), 'fixture_edge_unavailable');
  const binding = JSON.parse(docker(['inspect', '--format', '{{json (index .NetworkSettings.Ports "443/tcp")}}', edge]));
  requireCondition(Array.isArray(binding) && binding.length === 1
    && binding[0].HostIp === '127.0.0.1' && binding[0].HostPort === '443', 'fixture_edge_not_loopback');
}

function target(path, route) {
  requireCondition(typeof path === 'string' && path.startsWith('/') && !/[\\#\u0000-\u0020]/.test(path),
    'invalid_fixture_path');
  if (route === 'hosted') {
    requireCondition(providerPath.test(path), 'invalid_hosted_path');
    return 'checkout.flutterwave.com';
  }
  const host = 'crustcaper.test';
  const url = new URL(path, `https://${host}`);
  requireCondition(route === 'api' && url.origin === `https://${host}` && url.pathname.startsWith('/api/v1/'),
    'invalid_api_path');
  return host;
}

function increment(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function errorCode(error, fallback) {
  if (error instanceof LoadFailure) return error.message;
  if (typeof error?.code === 'string' && /^checkout_[a-z_]{2,32}$/.test(error.code)) return error.code;
  return fallback;
}

function transport(ca, agent, signal, metrics) {
  return async (path, { method = 'GET', body, headers = {}, route = 'api', metric } = {}) => {
    const host = target(path, route);
    const outgoing = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
    outgoing.host = host;
    const payload = body === undefined ? undefined
      : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    if (payload) {
      outgoing['content-type'] ??= typeof body === 'string'
        ? 'application/x-www-form-urlencoded' : 'application/json';
      outgoing['content-length'] = payload.length;
    }

    const start = performance.now();
    const timeout = AbortSignal.timeout(requestTimeoutMs);
    let response;
    try {
      response = await new Promise((resolve, reject) => {
        const call = httpsRequest({
          hostname: '127.0.0.1', port: 443, servername: host, path, method,
          ca, rejectUnauthorized: true, agent, headers: outgoing, signal: AbortSignal.any([signal, timeout]),
        }, incoming => {
          const chunks = [];
          let bytes = 0;
          incoming.on('data', chunk => {
            bytes += chunk.length;
            if (bytes > responseLimit) {
              incoming.destroy(new LoadFailure('response_too_large'));
              return;
            }
            chunks.push(chunk);
          });
          incoming.on('error', reject);
          incoming.on('end', () => {
            const contentType = (incoming.headers['content-type'] ?? '').split(';')[0].trim();
            let data = null;
            if (bytes && /^application\/(?:[a-z0-9.-]+\+)?json$/i.test(contentType)) {
              try {
                data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              } catch {
                reject(new LoadFailure('invalid_response_json'));
                return;
              }
            }
            resolve({ status: incoming.statusCode, headers: incoming.headers, data });
          });
        });
        call.on('error', reject);
        call.end(payload);
      });
    } catch (error) {
      if (error instanceof LoadFailure) throw error;
      if (signal.aborted) throw new LoadFailure('interrupted');
      if (timeout.aborted) throw new LoadFailure('request_timeout');
      if (/^(?:ERR_TLS_|CERT_|UNABLE_TO_VERIFY_|UNABLE_TO_GET_|SELF_SIGNED_|DEPTH_ZERO_)/.test(error.code ?? '')) {
        throw new LoadFailure('tls_rejected');
      }
      throw new LoadFailure('https_transport_failure');
    }

    const durationMs = performance.now() - start;
    if (metric === 'order_create') {
      increment(metrics.order_create.statuses, response.status);
      if (response.status === 200) metrics.order_create.latencies.push(durationMs);
    }
    return { ...response, durationMs };
  };
}

function validMenu(response) {
  return response.status === 200 && response.data?.store?.id === 'kigali'
    && response.data.store.open === true && Array.isArray(response.data.slots)
    && Array.isArray(response.data.products) && response.data.products.length > 0;
}

async function readMenu(request, reader, metrics) {
  const cache = reader.etag ? { 'if-none-match': reader.etag } : {};
  const response = await request(menuPath, { headers: cache });
  increment(metrics.statuses, response.status);
  const etag = response.headers.etag;
  if (response.status === 304) {
    requireCondition(reader.etag && etag === reader.etag, 'menu_conditional_mismatch');
  } else {
    requireCondition(response.status === 200, 'menu_http_status');
    requireCondition(validMenu(response), 'menu_invalid_response');
    requireCondition(typeof etag === 'string' && /^"[\x21\x23-\x7E]{1,256}"$/.test(etag), 'menu_missing_etag');
    reader.etag = etag;
  }
  metrics.latencies.push(response.durationMs);
  metrics.statusLatencies[response.status].push(response.durationMs);
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = q => sorted.length ? round(sorted[Math.ceil(sorted.length * q) - 1]) : null;
  return { samples: sorted.length, p50Ms: at(0.50), p95Ms: at(0.95), p99Ms: at(0.99), maxMs: at(1) };
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function totals() {
  return { scheduled: 0, started: 0, completed: 0, failed: 0, missed: 0, misses: {}, errors: {} };
}

function timeline(durationMs) {
  const schedule = [];
  for (let offset = 0; offset < durationMs; offset += readIntervalMs / readerCount) {
    schedule.push({ kind: 'menu', offset, reader: (offset / (readIntervalMs / readerCount)) % readerCount });
  }
  for (let offset = 0; offset < durationMs; offset += checkoutIntervalMs) {
    schedule.push({ kind: 'checkout', offset, index: offset / checkoutIntervalMs });
  }
  return schedule.sort((a, b) => a.offset - b.offset);
}

async function waitUntil(deadline, signal) {
  const remaining = deadline - performance.now();
  if (remaining <= 0 || signal.aborted) return;
  try {
    await delay(Math.ceil(remaining), undefined, { signal });
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}

async function measure({ durationMs, request, metrics, menu, runCheckout, kitchen, signal }) {
  const activity = { menu: totals(), checkout: totals() };
  const readers = Array.from({ length: readerCount }, () => ({ busy: false }));
  const lateness = [];
  const orders = [];
  const pending = new Set();
  const loop = monitorEventLoopDelay({ resolution: 20 });
  const schedule = timeline(durationMs);
  let activeCheckouts = 0;
  for (const event of schedule) activity[event.kind].scheduled++;

  loop.enable();
  const start = performance.now();
  const end = start + durationMs;
  let actualWindowMs;
  let drainMs;
  try {
    for (const event of schedule) {
      const due = start + event.offset;
      await waitUntil(due, signal);
      const now = performance.now();
      const late = now - due;
      const counts = activity[event.kind];
      const reader = readers[event.reader];
      let missed;
      if (signal.aborted) missed = 'interrupted';
      else if (now >= end || late > maximumLatenessMs) missed = 'scheduler_late';
      else if (reader?.busy) missed = 'reader_busy';
      else if (event.kind === 'checkout' && activeCheckouts >= checkoutLimit) missed = 'checkout_limit';
      if (!signal.aborted) lateness.push(Math.max(0, late));
      if (missed) {
        counts.missed++;
        increment(counts.misses, missed);
        continue;
      }

      counts.started++;
      if (reader) reader.busy = true;
      else activeCheckouts++;
      const job = (async () => {
        try {
          if (reader) {
            await readMenu(request, reader, metrics.menu);
          } else {
            const order = await runCheckout({ request, index: event.index, menu });
            kitchen.observe(order.orderId);
            orders.push(order);
          }
        } catch (error) {
          counts.failed++;
          increment(counts.errors, errorCode(error, `${event.kind}_validation_failed`));
        }
      })().finally(() => {
        counts.completed++;
        if (reader) reader.busy = false;
        else activeCheckouts--;
        pending.delete(job);
      });
      pending.add(job);
    }
    await waitUntil(end, signal);
    const drainStarted = performance.now();
    actualWindowMs = drainStarted - start;
    await Promise.all(pending);
    drainMs = performance.now() - drainStarted;
  } finally {
    loop.disable();
  }

  return {
    orders, activity, actualWindowMs: round(actualWindowMs), drainMs: round(drainMs),
    schedulingLateness: stats(lateness),
    eventLoopDelay: loop.count ? {
      p50Ms: round(loop.percentile(50) / 1e6),
      p95Ms: round(loop.percentile(95) / 1e6),
      p99Ms: round(loop.percentile(99) / 1e6),
      maxMs: round(loop.max / 1e6),
    } : null,
  };
}

async function evidence(directory, report) {
  if (directory) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'storefront-load.json'), JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report, null, 2));
}

async function main() {
  const args = process.argv.slice(2);
  const smoke = args.length === 1 && args[0] === '--smoke';
  requireCondition(!args.length || smoke, 'usage_storefront_load_optional_smoke_flag');
  const durationMs = smoke ? 15000 : 180000;
  const project = process.env.CRUSTCAPER_HTTPS_TEST_DOCKER_PROJECT;
  const caFile = process.env.CRUSTCAPER_HTTPS_TEST_CA;
  const directory = process.env.CRUSTCAPER_HTTPS_TEST_EVIDENCE_DIR;
  requireCondition(caFile, 'fixture_ca_required');
  requireFixture(project);
  const ca = await readFile(caFile).catch(() => { throw new LoadFailure('fixture_ca_unreadable'); });
  requireCondition(ca.includes('-----BEGIN CERTIFICATE-----'), 'fixture_ca_invalid');

  const { runCheckout, verifyPersisted, runCapacityWave } = require('./storefront-load-journey.cjs');
  const { openKitchenMonitor } = require('./storefront-load-kitchen.cjs');
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  for (const event of ['SIGINT', 'SIGTERM']) process.on(event, interrupt);
  const agent = new Agent({ keepAlive: true, maxSockets: 64 });
  const metrics = {
    menu: { latencies: [], statuses: {}, statusLatencies: { 200: [], 304: [] } },
    order_create: { latencies: [], statuses: {} },
  };
  const request = transport(ca, agent, controller.signal, metrics);
  const report = {
    mode: smoke ? 'smoke' : 'full', recordedAt: new Date().toISOString(), plannedWindowMs: durationMs,
    workload: { menuReaders: readerCount, menuReadIntervalMs: readIntervalMs, checkoutArrivalsPerMinute: 20 },
    p95TargetsMs: { menu: targets.menu, order_create: targets.order_create }, kitchenMaximumMs: targets.kitchen,
    errors: [], passed: false,
  };
  let kitchen;
  try {
    const warm = await request(menuPath);
    const slotIds = ['fixture-capacity', ...Array.from({ length: 8 }, (_, i) => `fixture-load-${i}`)];
    requireCondition(validMenu(warm)
      && slotIds.every(id => warm.data.slots.some(slot => slot.id === id && slot.available === true)),
    'fixture_menu_or_slots_unavailable');
    try {
      kitchen = await openKitchenMonitor({ request, project });
    } catch {
      throw new LoadFailure('kitchen_monitor_start_failed');
    }

    const { orders, ...measurement } = await measure({
      durationMs, request, metrics, menu: warm.data, runCheckout, kitchen, signal: controller.signal,
    });
    Object.assign(report, measurement);
    report.requests = Object.fromEntries(Object.entries(metrics).map(([name, value]) =>
      [name, { ...stats(value.latencies), statuses: value.statuses }]));
    report.requests.menu.byStatus = Object.fromEntries(Object.entries(metrics.menu.statusLatencies)
      .map(([status, values]) => [status, stats(values)]));
    if (controller.signal.aborted) throw new LoadFailure('interrupted');
    try {
      report.kitchen = await kitchen.finish();
    } catch {
      report.errors.push('kitchen_monitor_failed');
    }
    if (orders.length) {
      try {
        report.persistence = await verifyPersisted({ project, orders });
      } catch (error) {
        report.errors.push(errorCode(error, 'postgres_verification_failed'));
      }
    }
    if (controller.signal.aborted) throw new LoadFailure('interrupted');
    try {
      report.capacity = await runCapacityWave({ request, menu: warm.data, project });
    } catch (error) {
      report.errors.push(errorCode(error, 'capacity_wave_failed'));
    }
    for (const counts of Object.values(report.activity)) {
      if (counts.failed || counts.missed || counts.completed !== counts.scheduled) {
        report.errors.push('incomplete_workload');
        break;
      }
    }
    const checks = { menu: report.activity.menu.scheduled, order_create: report.activity.checkout.scheduled };
    for (const [name, expected] of Object.entries(checks)) {
      const observed = report.requests[name];
      if (observed.samples !== expected || observed.p95Ms > targets[name]) report.errors.push(`${name}_target_failed`);
    }
    const freshMenu = report.requests.menu.byStatus[200];
    if (freshMenu.samples < readerCount || freshMenu.p95Ms > targets.menu) report.errors.push('menu_fresh_target_failed');
    if (report.kitchen?.samples !== orders.length || report.kitchen.missed || report.kitchen.errors
      || !Number.isFinite(report.kitchen.maxMs) || report.kitchen.maxMs > targets.kitchen) {
      report.errors.push('kitchen_visibility_target_failed');
    }
    if (controller.signal.aborted) throw new LoadFailure('interrupted');
  } catch (error) {
    report.errors.push(error instanceof LoadFailure ? error.message : 'load_verification_failed');
  } finally {
    try {
      await kitchen?.close();
    } catch {
      report.errors.push('kitchen_monitor_close_failed');
    }
    agent.destroy();
    for (const event of ['SIGINT', 'SIGTERM']) process.off(event, interrupt);
  }
  report.passed = report.errors.length === 0;
  await evidence(directory, report);
  if (!report.passed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error instanceof LoadFailure ? error.message : 'storefront_load_failed');
  process.exitCode = 1;
});
