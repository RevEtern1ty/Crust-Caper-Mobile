const element = (id) => document.getElementById(id);
const signIn = element('sign-in');
const loginForm = element('login-form');
const loginButton = element('login-button');
const loginProblem = element('login-problem');
const workstation = element('workstation');
const workstationTitle = element('workstation-title');
const refreshButton = element('refresh-button');
const queueProblem = element('queue-problem');
const updateTime = element('update-time');
const orderList = element('order-list');
const emptyState = element('empty-state');
const orderTemplate = element('order-template');
const paymentReview = element('payment-review');
const paymentReviewJump = element('payment-review-jump');
const paymentReviewRefresh = element('payment-review-refresh');
const paymentReviewProblem = element('payment-review-problem');
const paymentReviewEmpty = element('payment-review-empty');
const paymentReviewList = element('payment-review-list');
const paymentExceptionTemplate = element('payment-exception-template');

const roles = {
  kitchen: { name: 'Kitchen', heading: 'Kitchen queue' },
  pickup: { name: 'Pickup', heading: 'Pickup queue' },
  manager: { name: 'Manager', heading: 'Order queue' },
};
const statuses = { accepted: 'New', preparing: 'Preparing', ready: 'Ready for pickup' };
const paymentReasons = {
  duplicate_transaction: 'Duplicate payment',
  unavailable_reservation: 'Payment after reservation ended',
  superseded_attempt: 'Payment from a replaced attempt',
};
const actions = {
  accepted: { status: 'preparing', label: 'Start preparing' },
  preparing: { status: 'ready', label: 'Mark ready' },
  ready: { status: 'collected', label: 'Confirm pickup' },
};
const dayFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kigali', day: 'numeric', month: 'short' });
const timeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kigali', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const reviewTimeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Kigali', dateStyle: 'medium', timeStyle: 'short' });
const cards = new Map();

let session = null;
let orders = [];
let timer;
let refreshVersion = 0;
let refreshing = false;
let authVersion = 0;

class ApiError extends Error {
  constructor(status, code) {
    super('An operator request failed');
    this.status = status;
    this.code = code;
  }
}

async function request(path, { method = 'GET', token, body } = {}) {
  const headers = { Accept: 'application/json, application/problem+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), 12_000);
  try {
    const response = await fetch(`/api/v1/operator${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: abort.signal,
    });
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) throw new ApiError(response.status, data?.code);
    return data;
  } finally {
    clearTimeout(deadline);
  }
}

function showMessage(target, message = '') {
  target.textContent = message;
  target.hidden = !message;
}

function messageFor(error) {
  if (!(error instanceof ApiError)) return 'The server could not be reached. Try again.';
  if (error.code === 'pickup_code_mismatch') return 'The pickup code did not match. Ask the guest for the code shown in their order.';
  if (error.code === 'invalid_transition' || error.status === 404 || error.status === 409) {
    return 'This order has changed. Refresh the queue before trying again.';
  }
  if (error.status === 403) return 'Your staff role does not allow this action.';
  if (error.status === 429) return 'Too many requests. Wait a moment and try again.';
  if (error.status === 400) return 'Check the information you entered and try again.';
  return 'The server could not complete this request. Try again.';
}

function label(value) {
  return value.replace(/[_-]+/g, ' ').replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function pickupWindow(start, end) {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const day = dayFormat.format(startDate);
  const endDay = dayFormat.format(endDate);
  const endLabel = day === endDay ? timeFormat.format(endDate) : `${endDay}, ${timeFormat.format(endDate)}`;
  return `Pickup ${day}, ${timeFormat.format(startDate)}–${endLabel}`;
}

function checkedOrder(order, completed = false) {
  if (!order || typeof order.id !== 'string' || !order.id || order.paymentStatus !== 'paid'
    || (!Object.hasOwn(statuses, order.status) && !(completed && order.status === 'collected'))
    || !Number.isFinite(Date.parse(order.pickupStartsAt)) || !Number.isFinite(Date.parse(order.pickupEndsAt))
    || !Array.isArray(order.lines) || !order.lines.every((line) => line && typeof line.sku === 'string'
      && Number.isInteger(line.quantity) && line.quantity > 0 && Array.isArray(line.modifierIds)
      && line.modifierIds.every((modifier) => typeof modifier === 'string'))) {
    throw new ApiError(502, 'invalid_response');
  }
  return {
    id: order.id,
    status: order.status,
    paymentStatus: order.paymentStatus,
    pickupStartsAt: order.pickupStartsAt,
    pickupEndsAt: order.pickupEndsAt,
    lines: order.lines.map(({ sku, modifierIds, quantity }) => ({ sku, modifierIds, quantity })),
  };
}

function renderedLine(line) {
  const row = document.createElement('li');
  row.className = 'order-line';
  const quantity = document.createElement('span');
  quantity.className = 'quantity';
  quantity.textContent = `${line.quantity} ×`;
  const details = document.createElement('div');
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = label(line.sku);
  details.append(name);
  if (line.modifierIds.length) {
    const modifiers = document.createElement('span');
    modifiers.className = 'modifiers';
    modifiers.textContent = line.modifierIds.map(label).join(' · ');
    details.append(modifiers);
  }
  row.append(quantity, details);
  return row;
}

function addAction(card, order) {
  const action = actions[order.status];
  const isCollection = action.status === 'collected';
  if (isCollection ? session.role === 'kitchen' : session.role === 'pickup') return;

  const container = card.querySelector('.order-actions');
  const problem = card.querySelector('.order-problem');
  const button = document.createElement('button');
  button.className = 'button button-primary';
  button.textContent = action.label;

  if (!isCollection) {
    button.type = 'button';
    button.addEventListener('click', () => { void submitTransition(order, action, button, problem); });
    container.append(button);
    return;
  }

  const form = document.createElement('form');
  form.method = 'post';
  form.className = 'pickup-form';
  form.noValidate = true;
  const field = document.createElement('div');
  const input = document.createElement('input');
  const caption = document.createElement('label');
  input.id = `pickup-${order.id}`;
  problem.id = `${input.id}-problem`;
  input.name = 'pickupCode';
  input.inputMode = 'numeric';
  input.autoComplete = 'off';
  input.maxLength = 6;
  input.required = true;
  input.pattern = '[0-9]{6}';
  input.setAttribute('aria-describedby', problem.id);
  caption.htmlFor = input.id;
  caption.textContent = 'Pickup code';
  input.addEventListener('input', () => {
    input.removeAttribute('aria-invalid');
    showMessage(problem);
  });
  button.type = 'submit';
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitTransition(order, action, button, problem, input);
  });
  field.append(caption, input);
  form.append(field, button);
  container.append(form);
}

function renderOrders() {
  const display = [...orders].sort((left, right) => Date.parse(left.pickupStartsAt) - Date.parse(right.pickupStartsAt)
    || left.id.localeCompare(right.id));
  const visible = new Set(display.map(({ id }) => id));
  for (const [id, { card }] of cards) {
    if (!visible.has(id)) {
      card.remove();
      cards.delete(id);
    }
  }
  display.forEach((order, index) => {
    const signature = JSON.stringify(order);
    const current = cards.get(order.id);
    let card = current?.card;
    if (current?.signature !== signature) {
      card = orderTemplate.content.firstElementChild.cloneNode(true);
      card.querySelector('.order-title').textContent = `Order #${order.id.slice(-8).toUpperCase()}`;
      const badge = card.querySelector('.order-status');
      badge.dataset.status = order.status;
      badge.textContent = statuses[order.status];
      card.querySelector('.pickup-window').textContent = pickupWindow(order.pickupStartsAt, order.pickupEndsAt);
      card.querySelector('.order-lines').append(...order.lines.map(renderedLine));
      addAction(card, order);
      cards.set(order.id, { card, signature });
      current?.card.replaceWith(card);
    }
    if (orderList.children[index] !== card) orderList.insertBefore(card, orderList.children[index] ?? null);
  });
  emptyState.hidden = display.length !== 0;
}

function renderedPaymentException(entry) {
  if (!entry || ![entry.orderId, entry.merchantReference, entry.providerTransactionId, entry.reason]
    .every((value) => typeof value === 'string' && value.length > 0) || !Number.isFinite(Date.parse(entry.createdAt))) {
    throw new ApiError(502, 'invalid_response');
  }
  const card = paymentExceptionTemplate.content.firstElementChild.cloneNode(true);
  card.querySelector('.payment-exception-reason').textContent = Object.hasOwn(paymentReasons, entry.reason)
    ? paymentReasons[entry.reason] : 'Payment exception';
  card.querySelector('.payment-exception-time').textContent = `${reviewTimeFormat.format(new Date(entry.createdAt))} Kigali time`;
  card.querySelector('.payment-exception-order').textContent = entry.orderId;
  card.querySelector('.payment-exception-reference').textContent = entry.merchantReference;
  card.querySelector('.payment-exception-transaction').textContent = entry.providerTransactionId;
  return card;
}

function closeSession(message = '') {
  authVersion++;
  refreshVersion++;
  clearInterval(timer);
  session = null;
  refreshing = false;
  orders = [];
  cards.clear();
  orderList.replaceChildren();
  paymentReview.hidden = true;
  paymentReviewJump.hidden = true;
  paymentReviewList.replaceChildren();
  paymentReviewRefresh.disabled = false;
  showMessage(paymentReviewProblem);
  showMessage(paymentReviewEmpty);
  workstation.hidden = true;
  signIn.hidden = false;
  loginForm.reset();
  showMessage(loginProblem, message);
  element('username').focus();
}

function availableSession() {
  if (session && session.expiresAt <= Date.now()) closeSession('Your staff session expired. Sign in again.');
  return session;
}

async function refreshQueue(force = false) {
  const current = availableSession();
  if (!current || (refreshing && !force)) return;

  const version = ++refreshVersion;
  refreshing = true;
  refreshButton.disabled = true;
  try {
    const data = await request('/orders', { token: current.accessToken });
    if (session !== current || refreshVersion !== version) return;
    if (!Array.isArray(data?.orders)) throw new ApiError(502, 'invalid_response');
    orders = data.orders.map((order) => checkedOrder(order));
    renderOrders();
    showMessage(queueProblem);
    updateTime.textContent = `Updated at ${timeFormat.format(new Date())} Kigali time`;
  } catch (error) {
    if (session !== current || refreshVersion !== version) return;
    if (error instanceof ApiError && error.status === 401) closeSession('Your staff session expired. Sign in again.');
    else showMessage(queueProblem, messageFor(error));
  } finally {
    if (session === current && refreshVersion === version) {
      refreshing = false;
      refreshButton.disabled = false;
    }
  }
}

async function refreshPaymentReview() {
  const current = availableSession();
  if (current?.role !== 'manager' || paymentReviewRefresh.disabled) return;

  paymentReviewRefresh.disabled = true;
  showMessage(paymentReviewProblem);
  showMessage(paymentReviewEmpty, paymentReviewList.childElementCount ? '' : 'Loading payment exceptions…');
  try {
    const data = await request('/payment-exceptions', { token: current.accessToken });
    if (session !== current) return;
    if (!Array.isArray(data?.exceptions) || data.exceptions.length > 50) throw new ApiError(502, 'invalid_response');
    paymentReviewList.replaceChildren(...data.exceptions.map(renderedPaymentException));
    showMessage(paymentReviewEmpty, data.exceptions.length ? '' : 'No recent payment exceptions.');
  } catch (error) {
    if (session !== current) return;
    if (error instanceof ApiError && error.status === 401) {
      closeSession('Your staff session expired. Sign in again.');
    } else {
      paymentReviewList.replaceChildren();
      showMessage(paymentReviewEmpty);
      showMessage(paymentReviewProblem, messageFor(error));
    }
  } finally {
    if (session === current) paymentReviewRefresh.disabled = false;
  }
}

async function submitTransition(order, action, button, problem, input) {
  const current = availableSession();
  if (!current || button.disabled) return;

  const body = { status: action.status };
  if (input) {
    if (!/^[0-9]{6}$/.test(input.value)) {
      input.setAttribute('aria-invalid', 'true');
      showMessage(problem, 'Enter the six-digit pickup code.');
      input.focus();
      return;
    }
    body.pickupCode = input.value;
    input.disabled = true;
  }
  button.disabled = true;
  showMessage(problem);
  try {
    const data = await request(`/orders/${encodeURIComponent(order.id)}/status`, { method: 'POST', token: current.accessToken, body });
    if (session !== current) return;
    const updated = checkedOrder(data, true);
    if (updated.id !== order.id) throw new ApiError(502, 'invalid_response');

    if (input) input.value = '';
    orders = orders.flatMap((item) => {
      if (item.id !== updated.id) return [item];
      return updated.status === 'collected' ? [] : [updated];
    });
    renderOrders();
    await refreshQueue(true);
  } catch (error) {
    if (session !== current) return;
    if (error instanceof ApiError && error.status === 401) closeSession('Your staff session expired. Sign in again.');
    else {
      showMessage(problem, messageFor(error));
      if (input && error instanceof ApiError && error.code === 'pickup_code_mismatch') {
        input.value = '';
        input.disabled = false;
        input.setAttribute('aria-invalid', 'true');
        input.focus();
      }
    }
  } finally {
    if (session === current) {
      button.disabled = false;
      if (input) input.disabled = false;
    }
  }
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (loginButton.disabled) return;

  const credentials = new FormData(loginForm);
  element('password').value = '';
  showMessage(loginProblem);
  const version = ++authVersion;
  loginButton.disabled = true;
  loginButton.textContent = 'Signing in…';
  try {
    const data = await request('/sessions', { method: 'POST', body: {
      username: String(credentials.get('username') ?? '').trim(),
      password: String(credentials.get('password') ?? ''),
    } });
    if (authVersion !== version) return;
    const expiresAt = Date.parse(data?.expiresAt);
    if (typeof data?.accessToken !== 'string' || !data.accessToken || typeof data.storeId !== 'string'
      || !Object.hasOwn(roles, data.role) || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new ApiError(502, 'invalid_response');
    }
    session = { accessToken: data.accessToken, expiresAt, role: data.role };
    element('session-label').textContent = `${label(data.storeId)} · ${roles[data.role].name}`;
    workstationTitle.textContent = roles[data.role].heading;
    updateTime.textContent = 'Loading paid orders…';
    showMessage(queueProblem);
    emptyState.hidden = true;
    signIn.hidden = true;
    workstation.hidden = false;
    paymentReview.hidden = data.role !== 'manager';
    paymentReviewJump.hidden = paymentReview.hidden;
    workstationTitle.focus();
    timer = setInterval(() => { if (!document.hidden) void refreshQueue(); }, 8000);
    void refreshQueue();
    if (data.role === 'manager') void refreshPaymentReview();
  } catch (error) {
    if (authVersion !== version) return;
    showMessage(loginProblem, error instanceof ApiError && error.status === 401
      ? 'The username or password was not accepted.' : messageFor(error));
    element('password').focus();
  } finally {
    loginButton.disabled = false;
    loginButton.textContent = 'Sign in';
  }
});

refreshButton.addEventListener('click', () => { void refreshQueue(); });
paymentReviewJump.addEventListener('click', () => { element('payment-review-title').focus(); });
paymentReviewRefresh.addEventListener('click', () => { void refreshPaymentReview(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshQueue(); });
element('logout-button').addEventListener('click', async () => {
  const current = session;
  if (!current) return;
  closeSession();
  const version = authVersion;
  try {
    await request('/sessions/current', { method: 'DELETE', token: current.accessToken });
  } catch (error) {
    if (authVersion === version && !(error instanceof ApiError && error.status === 401)) {
      showMessage(loginProblem, 'This device signed out. The server could not confirm session revocation.');
    }
  }
});
