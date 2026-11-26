const timeFormat = new Intl.DateTimeFormat('en-GB', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Kigali',
});
const id = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function validRequest(row, status) {
  return !!row && typeof row.requestId === 'string' && id.test(row.requestId)
    && typeof row.orderId === 'string' && id.test(row.orderId) && row.status === status
    && typeof row.submittedAt === 'string' && Number.isFinite(Date.parse(row.submittedAt))
    && (status === 'pending' ? row.reviewedAt === null
      : typeof row.reviewedAt === 'string' && Number.isFinite(Date.parse(row.reviewedAt)));
}

export function mountErasureRequests({ currentSession, request, messageFor, showMessage, closeSession }) {
  const element = suffix => document.getElementById('erasure-requests' + suffix);
  const panel = element('');
  const jump = element('-jump');
  const title = element('-title');
  const pending = element('-pending');
  const inReview = element('-in-review');
  const refresh = element('-refresh');
  const problem = element('-problem');
  const notice = element('-status');
  const list = element('-list');
  let selected = 'pending';
  let operation;

  function render(rows) {
    const entries = rows.map(row => {
      const card = document.createElement('li');
      card.className = 'order-card';
      const number = document.createElement('h3');
      number.textContent = 'Order #' + row.orderId.slice(-8).toUpperCase();
      const reference = document.createElement('p');
      reference.textContent = 'Request ' + row.requestId;
      const date = document.createElement('p');
      date.textContent = 'Submitted ' + timeFormat.format(Date.parse(row.submittedAt)) + ' Kigali time';
      card.append(number, reference, date);
      if (row.status === 'pending') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'button button-secondary';
        button.textContent = 'Start review';
        button.addEventListener('click', () => { void load(row); });
        card.append(button);
      } else {
        const recorded = document.createElement('p');
        recorded.textContent = 'Review started ' + timeFormat.format(Date.parse(row.reviewedAt)) + ' Kigali time';
        card.append(recorded);
      }
      return card;
    });
    list.replaceChildren(...entries);
  }

  function setBusy(value) {
    list.setAttribute('aria-busy', String(value));
    for (const button of [pending, inReview, refresh, ...list.querySelectorAll('button')]) button.disabled = value;
  }

  async function load(row) {
    const session = currentSession();
    if (session?.role !== 'manager' || panel.hidden || operation) return;
    const controller = new AbortController();
    operation = controller;
    const current = () => operation === controller && currentSession() === session;
    const options = { token: session.accessToken, signal: controller.signal };
    showMessage(problem);
    showMessage(notice, row ? 'Saving review status…' : 'Loading requests…');
    setBusy(true);
    let reviewRecorded = false;
    try {
      if (row) {
        const updated = await request('/erasure-requests/' + row.requestId + '/review', { ...options, method: 'POST' });
        if (!current()) return;
        if (!validRequest(updated, 'in_review') || updated.requestId !== row.requestId
          || updated.orderId !== row.orderId) throw new Error('invalid_response');
        reviewRecorded = true;
      }
      const rows = await request('/erasure-requests?status=' + selected, options);
      if (!current()) return;
      if (!Array.isArray(rows) || rows.length > 100 || !rows.every(entry => validRequest(entry, selected))) {
        throw new Error('invalid_response');
      }
      render(rows);
      if (row) title.focus();
      showMessage(notice, reviewRecorded ? 'Review started. Send the request to the person responsible for data retention.'
        : rows.length === 0 ? 'No requests in this view.' : rows.length === 100 ? 'Showing up to 100 requests.' : '');
    } catch (error) {
      if (!current()) return;
      if (error?.status === 401) closeSession('Your staff session expired. Sign in again.');
      else {
        list.replaceChildren();
        showMessage(notice, reviewRecorded ? 'Review started.' : '');
        showMessage(problem, messageFor(error, 'Requests could not be confirmed. Refresh to check their status.'));
      }
    } finally {
      if (current()) {
        operation = undefined;
        setBusy(false);
      }
    }
  }

  function select(status) {
    if (operation || selected === status) return;
    selected = status;
    pending.setAttribute('aria-pressed', String(status === 'pending'));
    inReview.setAttribute('aria-pressed', String(status === 'in_review'));
    list.replaceChildren();
    void load();
  }

  refresh.addEventListener('click', () => { void load(); });
  pending.addEventListener('click', () => select('pending'));
  inReview.addEventListener('click', () => select('in_review'));
  jump.addEventListener('click', () => {
    if (currentSession()?.role !== 'manager') return;
    panel.hidden = false;
    title.focus();
    void load();
  });

  return {
    show() { jump.hidden = false; },
    reset() {
      operation?.abort();
      operation = undefined;
      selected = 'pending';
      pending.setAttribute('aria-pressed', 'true');
      inReview.setAttribute('aria-pressed', 'false');
      list.replaceChildren();
      showMessage(notice);
      showMessage(problem);
      setBusy(false);
      panel.hidden = true;
      jump.hidden = true;
    },
  };
}
