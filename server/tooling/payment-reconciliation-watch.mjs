const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const counters = ['sweeps', 'confirmed', 'pending', 'providerErrors', 'rejected', 'settlementErrors', 'sweepErrors'];
const requiredWindows = 2;

function readSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.instanceId !== 'string' || value.instanceId.length !== 36 || !uuid.test(value.instanceId)
    || typeof value.enabled !== 'boolean'
    || counters.some(key => !Number.isSafeInteger(value[key]) || value[key] < 0 || (!value.enabled && value[key] !== 0))) {
    return null;
  }
  const totals = Object.fromEntries(counters.map(key => [key, value[key]]));
  return { instanceId: value.instanceId.toLowerCase(), enabled: value.enabled, totals };
}

export function createPaymentReconciliationWatch() {
  let baseline = null;
  let telemetryMissing = false;
  let incidentOpen = false;
  let verificationIncident = false;
  let streak = 0;
  let verificationFailureInStreak = false;

  function event(name, details = {}) {
    return { event: name, monitor: 'payment_reconciliation', ...details };
  }

  function resetStreak() {
    streak = 0;
    verificationFailureInStreak = false;
  }

  function recordGap(reason) {
    baseline = null;
    resetStreak();
    if (telemetryMissing) return null;
    telemetryMissing = true;
    return event('telemetry_unavailable', { reason, incidentOpen });
  }

  function observe(value) {
    const next = readSnapshot(value);
    if (!next) return recordGap('invalid_snapshot');
    if (!baseline) {
      baseline = next;
      if (telemetryMissing) {
        telemetryMissing = false;
        return event('telemetry_restored', { enabled: next.enabled, incidentOpen });
      }
      return event(next.enabled ? 'ready' : 'reconciliation_disabled');
    }
    if (next.instanceId !== baseline.instanceId) return recordGap('instance_changed');
    if (next.enabled !== baseline.enabled) return recordGap('enablement_changed');
    const delta = Object.fromEntries(counters.map(key => [key, next.totals[key] - baseline.totals[key]]));
    if (counters.some(key => delta[key] < 0)) return recordGap('counter_regression');
    baseline = next;
    if (!next.enabled) return null;

    const verificationFailed = delta.providerErrors > 0 || delta.rejected > 0 || delta.settlementErrors > 0;
    const workerHealthy = delta.sweeps > 0 && delta.sweepErrors === 0;
    const verified = delta.confirmed > 0 || delta.pending > 0;
    if (incidentOpen && verificationFailed) verificationIncident = true;
    const canTransition = incidentOpen
      ? workerHealthy && !verificationFailed && (!verificationIncident || verified)
      : !workerHealthy || verificationFailed;
    if (!canTransition) {
      resetStreak();
      return null;
    }

    streak++;
    verificationFailureInStreak ||= verificationFailed;
    if (streak < requiredWindows) return null;
    incidentOpen = !incidentOpen;
    verificationIncident = incidentOpen && verificationFailureInStreak;
    resetStreak();
    return event(incidentOpen ? 'incident' : 'recovered', delta);
  }

  return { observe, timeout: () => recordGap('sample_timeout') };
}
