const refreshIntervalMs = 30_000;
const checkedAtFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Africa/Kigali', dateStyle: 'medium', timeStyle: 'short',
});
const integerFormat = new Intl.NumberFormat('en-GB');
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function count(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function mountOperationsSignals({ currentSession, request, showMessage, messageFor, closeSession, canRefresh }) {
  const element = suffix => document.getElementById('operations-signals' + suffix);
  const panel = element('');
  const jump = element('-jump');
  const title = element('-title');
  const refresh = element('-refresh');
  const checked = element('-checked');
  const observedAt = element('-observed-at');
  const status = element('-status');
  const problem = element('-problem');
  const counts = element('-counts');
  const payment = element('-payment');
  const receipt = element('-receipt');
  const receiptThreshold = element('-receipt-threshold');
  let pending;
  let timer;

  function showCount(target, value) {
    const label = value === undefined ? 'Unknown' : integerFormat.format(value);
    if (target.textContent !== label) target.textContent = label;
    target.dataset.attention = String(value > 0);
  }

  function clearSnapshot() {
    showCount(payment);
    showCount(receipt);
    checked.hidden = true;
    observedAt.textContent = '';
    observedAt.removeAttribute('datetime');
    showMessage(receiptThreshold);
  }

  function setBusy(active) {
    counts.setAttribute('aria-busy', String(active));
    refresh.disabled = active;
    showMessage(status, active && checked.hidden ? 'Checking operations signals…' : '');
  }

  function showProblem(message = '') {
    if (problem.textContent !== message) showMessage(problem, message);
  }

  function render(data) {
    if (typeof data?.observedAt !== 'string' || !instant.test(data.observedAt)
      || !Number.isFinite(Date.parse(data.observedAt)) || !count(data.paymentWithoutKitchen)
      || !count(data.fiscalReceiptsOverdue) || !count(data.fiscalReceiptOverdueAfterMinutes)) return false;

    showCount(payment, data.paymentWithoutKitchen);
    showCount(receipt, data.fiscalReceiptsOverdue);
    const minutes = data.fiscalReceiptOverdueAfterMinutes;
    showMessage(receiptThreshold, 'Due ' + integerFormat.format(minutes) + (minutes === 1 ? ' minute' : ' minutes')
      + ' after pickup');
    observedAt.dateTime = data.observedAt;
    observedAt.textContent = checkedAtFormat.format(Date.parse(data.observedAt));
    checked.hidden = false;
    return true;
  }

  async function load() {
    const session = currentSession();
    if (session?.role !== 'manager' || panel.hidden || !canRefresh() || pending) return;
    const operation = new AbortController();
    pending = operation;
    const current = () => pending === operation && currentSession() === session;
    setBusy(true);
    try {
      const data = await request('/operations/signals', { token: session.accessToken, signal: operation.signal });
      if (!current()) return;
      if (!render(data)) {
        clearSnapshot();
        showProblem('The operations signals response could not be verified. Try again.');
      } else showProblem();
    } catch (error) {
      if (!current()) return;
      if (error?.status === 401) closeSession('Your staff session expired. Sign in again.');
      else {
        clearSnapshot();
        showProblem(messageFor(error, 'Operations signals could not be loaded. Try again.'));
      }
    } finally {
      if (current()) {
        pending = undefined;
        setBusy(false);
      }
    }
  }

  function clear() {
    pending?.abort();
    pending = undefined;
    clearSnapshot();
    setBusy(false);
    showProblem();
  }

  function recheck() {
    if (panel.hidden || currentSession()?.role !== 'manager') return;
    if (canRefresh()) void load();
    else {
      clear();
      if (!navigator.onLine) showProblem('Operations signals are unavailable while offline.');
    }
  }

  jump.addEventListener('click', () => {
    if (currentSession()?.role === 'manager') title.focus();
  });
  refresh.addEventListener('click', () => { void load(); });

  return {
    show() {
      jump.hidden = false;
      panel.hidden = false;
      timer = setInterval(() => { void load(); }, refreshIntervalMs);
      recheck();
    },
    recheck,
    reset() {
      clearInterval(timer);
      clear();
      jump.hidden = true;
      panel.hidden = true;
    },
  };
}
