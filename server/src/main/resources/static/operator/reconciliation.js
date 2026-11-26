const timeZone = 'Africa/Kigali';
const todayFormat = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
const checkedAtFormat = new Intl.DateTimeFormat('en-GB', { timeZone, dateStyle: 'medium', timeStyle: 'short' });
const integerFormat = new Intl.NumberFormat('en-GB');
const datePattern = /^(?!0000)\d{4}-\d{2}-\d{2}$/;
const amountPattern = /^(?:0|[1-9]\d*)$/;

function kigaliToday() {
  const parts = Object.fromEntries(todayFormat.formatToParts(new Date()).map(({ type, value }) => [type, value]));
  return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}`;
}

function validDate(value) {
  if (!datePattern.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function timestamp(value) {
  return typeof value === 'string' ? Date.parse(value) : NaN;
}

function validTotal(total) {
  return Number.isSafeInteger(total?.count) && total.count >= 0
    && typeof total.amountRwf === 'string' && amountPattern.test(total.amountRwf);
}

function totalAmount(total) {
  return `${integerFormat.format(BigInt(total.amountRwf))} RWF`;
}

function totalCount(total) {
  return `${integerFormat.format(total.count)} ${total.count === 1 ? 'entry' : 'entries'}`;
}

export function mountReconciliation({ currentSession, request, showMessage, messageFor, closeSession }) {
  const element = id => document.getElementById(id);
  const jump = element('reconciliation-jump');
  const panel = element('reconciliation');
  const title = element('reconciliation-title');
  const form = element('reconciliation-form');
  const date = element('reconciliation-date');
  const refresh = element('reconciliation-refresh');
  const problem = element('reconciliation-problem');
  const status = element('reconciliation-status');
  const results = element('reconciliation-results');
  const asOf = element('reconciliation-as-of');
  const download = element('reconciliation-download');
  const undated = element('reconciliation-undated');
  const metrics = [...panel.querySelectorAll('[data-reconciliation-total]')];
  let revision = 0;
  let reportDate = null;
  let loading = false;
  let downloading = false;

  function sync() {
    form.setAttribute('aria-busy', String(loading));
    refresh.disabled = loading || downloading;
    download.disabled = loading || downloading || reportDate !== date.value;
  }

  function clear() {
    revision++;
    reportDate = null;
    loading = false;
    downloading = false;
    results.hidden = true;
    asOf.textContent = '';
    for (const metric of metrics) metric.replaceChildren();
    showMessage(undated);
    showMessage(problem);
    showMessage(status);
    date.removeAttribute('aria-invalid');
    sync();
  }

  function current(session, version) {
    return currentSession() === session && version === revision;
  }

  function showError(error, fallback) {
    if (error?.status === 401) closeSession('Your staff session expired. Sign in again.');
    else showMessage(problem, messageFor(error, fallback));
  }

  function render(data, selected) {
    const from = timestamp(data?.from);
    const until = timestamp(data?.until);
    const checkedAt = timestamp(data?.asOf);
    if (data?.date !== selected || data.timeZone !== timeZone || data.currency !== 'RWF'
      || ![from, until, checkedAt].every(Number.isFinite) || until <= from
      || !metrics.every(metric => validTotal(data[metric.dataset.reconciliationTotal]))
      || !validTotal(data.undatedAcceptedPayments)) return false;

    for (const metric of metrics) {
      const total = data[metric.dataset.reconciliationTotal];
      const amount = document.createElement('strong');
      const count = document.createElement('span');
      amount.textContent = totalAmount(total);
      count.textContent = totalCount(total);
      metric.replaceChildren(amount, count);
    }
    asOf.textContent = `As of ${checkedAtFormat.format(checkedAt)} Kigali time`;
    const undatedTotal = data.undatedAcceptedPayments;
    showMessage(undated, undatedTotal.count > 0
      ? `Undated accepted payments for this restaurant are excluded from daily totals. ${totalCount(undatedTotal)} · ${totalAmount(undatedTotal)}.`
      : '');
    reportDate = selected;
    results.hidden = false;
    return true;
  }

  async function load() {
    const session = currentSession();
    if (session?.role !== 'manager' || loading || downloading) return;
    const selected = date.value;
    clear();
    if (!validDate(selected)) {
      date.setAttribute('aria-invalid', 'true');
      showMessage(problem, 'Choose a valid activity date.');
      date.focus();
      return;
    }

    const version = revision;
    loading = true;
    sync();
    showMessage(status, 'Loading reconciliation…');
    try {
      const data = await request(`/reconciliation?date=${encodeURIComponent(selected)}`, { token: session.accessToken });
      if (!current(session, version) || date.value !== selected) return;
      if (!render(data, selected)) showMessage(problem, 'The reconciliation response could not be verified. Try again.');
    } catch (error) {
      if (current(session, version)) showError(error, 'Reconciliation could not be loaded. Try again.');
    } finally {
      if (current(session, version)) {
        loading = false;
        showMessage(status);
        sync();
      }
    }
  }

  async function downloadCsv() {
    const session = currentSession();
    const selected = reportDate;
    if (session?.role !== 'manager' || !selected || selected !== date.value || loading || downloading) return;
    const version = revision;
    downloading = true;
    sync();
    showMessage(problem);
    showMessage(status, 'Preparing CSV…');
    try {
      const csv = await request(`/reconciliation/export?date=${encodeURIComponent(selected)}`, {
        token: session.accessToken, csv: true, timeoutMs: 28_000,
      });
      if (!current(session, version) || date.value !== selected) return;
      const url = URL.createObjectURL(csv);
      const link = document.createElement('a');
      link.href = url;
      link.download = `crustcaper-reconciliation-${selected}.csv`;
      try {
        document.body.append(link);
        link.click();
      } finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      showMessage(status, 'CSV download started.');
    } catch (error) {
      if (current(session, version)) {
        showMessage(status);
        showError(error, 'The CSV could not be downloaded. Try again.');
      }
    } finally {
      if (current(session, version)) {
        downloading = false;
        sync();
      }
    }
  }

  jump.addEventListener('click', () => {
    if (currentSession()?.role !== 'manager') return;
    const opening = panel.hidden;
    panel.hidden = false;
    title.focus();
    if (opening) {
      date.value = kigaliToday();
      void load();
    }
  });
  date.addEventListener('input', clear);
  form.addEventListener('submit', event => {
    event.preventDefault();
    void load();
  });
  download.addEventListener('click', () => { void downloadCsv(); });

  return {
    show() { jump.hidden = false; },
    reset() {
      clear();
      form.reset();
      jump.hidden = true;
      panel.hidden = true;
    },
  };
}
