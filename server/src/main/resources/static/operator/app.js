import { mountAvailability } from './availability.js';
import { createOrderSound } from './order-sound.js';

const element = (id) => document.getElementById(id);
const signIn = element('sign-in');
const loginForm = element('login-form');
const loginButton = element('login-button');
const loginProblem = element('login-problem');
const workstation = element('workstation');
const workstationTitle = element('workstation-title');
const refreshButton = element('refresh-button');
const queueProblem = element('queue-problem');
const queueStale = element('queue-stale');
const kitchenSignal = element('kitchen-signal');
const kitchenNewOrders = element('kitchen-new-orders');
const kitchenSoundToggle = element('kitchen-sound-toggle');
const kitchenSoundStatus = element('kitchen-sound-status');
const queueNotice = element('queue-notice');
const updateTime = element('update-time');
const orderList = element('order-list');
const emptyState = element('empty-state');
const orderTemplate = element('order-template');
const cancellationDialog = element('cancellation-dialog');
const cancellationTitle = element('cancellation-title');
const cancellationProblem = element('cancellation-problem');
const cancellationProgress = element('cancellation-progress');
const keepOrderButton = element('keep-order');
const confirmCancellationButton = element('confirm-cancellation');
const paymentReview = element('payment-review');
const paymentReviewJump = element('payment-review-jump');
const paymentReviewRefresh = element('payment-review-refresh');
const paymentReviewProblem = element('payment-review-problem');
const paymentReviewEmpty = element('payment-review-empty');
const paymentReviewList = element('payment-review-list');
const paymentExceptionTemplate = element('payment-exception-template');
const fiscalReceipts = element('fiscal-receipts');
const fiscalReceiptsJump = element('fiscal-receipts-jump');
const fiscalReceiptsRefresh = element('fiscal-receipts-refresh');
const fiscalReceiptsFilter = element('fiscal-receipts-filter');
const fiscalReceiptsProblem = element('fiscal-receipts-problem');
const fiscalReceiptsEmpty = element('fiscal-receipts-empty');
const fiscalReceiptsList = element('fiscal-receipts-list');
const fiscalReceiptTemplate = element('fiscal-receipt-template');

const roles = {
  kitchen: { name: 'Kitchen', heading: 'Kitchen queue' },
  pickup: { name: 'Pickup', heading: 'Pickup queue' },
  manager: { name: 'Manager', heading: 'Order queue' },
};
const statuses = { accepted: 'New', preparing: 'Preparing', ready: 'Ready for pickup' };
const paymentReasons = {
  duplicate_transaction: 'Duplicate payment',
  restaurant_cancelled: 'Restaurant cancelled',
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
const integerFormat = new Intl.NumberFormat('en-GB');
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const providerId = /^[1-9][0-9]{0,18}$/;
const receiptReference = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/;
const maxReceiptBytes = 1024 * 1024;
const queuePollMs = 5000;
const queueFreshMs = 12_000;
const overdueMs = 60_000;
const cards = new Map();
const kitchenTransitions = new Set();

let session = null;
let orders = [];
let receipts = [];
let timer;
let kitchenTimer;
let refreshVersion = 0;
let queueEpoch = 0;
let queueSnapshot = null;
let needsQueueRefresh = false;
let pagePaused = false;
let refreshing = false;
let paymentReviewVersion = 0;
let authVersion = 0;
let cancellation = null;
const availability = mountAvailability({ currentSession: availableSession, request, messageFor, showMessage, closeSession });
let kitchenSoundState = 'off';
const orderSound = createOrderSound((state) => {
  kitchenSoundState = state;
  syncKitchenSignal();
});

class ApiError extends Error {
  constructor(status, code) {
    super('An operator request failed');
    this.status = status;
    this.code = code;
  }
}

async function request(path, { method = 'GET', token, body, receipt, timeoutMs = 12_000 } = {}) {
  const headers = { Accept: 'application/json, application/problem+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (receipt) {
    headers['Content-Type'] = 'application/pdf';
    headers['X-Receipt-Reference'] = receipt.reference;
    headers['X-Receipt-Total-RWF'] = receipt.total;
  }

  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetch(`/api/v1/operator${path}`, {
      method,
      headers,
      body: receipt?.file ?? (body === undefined ? undefined : JSON.stringify(body)),
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
  if (error.code === 'refund_unconfirmed') return 'Flutterwave did not confirm a completed full refund for this payment.';
  if (error.code === 'payment_reference_unavailable') return 'The paid transaction could not be identified. Check Payment review before cancelling this order.';
  if (error.code === 'refund_already_recorded') return 'This payment already has a recorded refund. Refresh payment review.';
  if (error.code === 'refund_verification_unavailable') return 'Refund verification is temporarily unavailable.';
  if (error.code === 'receipt_already_issued') return 'A receipt is already attached to this order. Refresh fiscal receipts.';
  if (error.code === 'receipt_reference_in_use') return 'This receipt reference is already attached to another order.';
  if (error.code === 'receipt_total_mismatch') return 'The total printed on the receipt must match the paid order.';
  if (error.status === 413) return 'Choose a PDF file up to 1 MB.';
  if (error.status === 415) return 'Choose a PDF file issued by the EBM.';
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

function orderNumber(id) {
  return `#${id.slice(-8).toUpperCase()}`;
}

function staffKitchen(current) {
  return current?.role === 'kitchen' || current?.role === 'manager';
}

function queueVisible() {
  return !document.hidden && !pagePaused && navigator.onLine;
}

function queueFresh(now = performance.now()) {
  return queueVisible() && !needsQueueRefresh && queueSnapshot !== null && now - queueSnapshot.receivedAt < queueFreshMs;
}

function changeText(target, value) {
  if (target.textContent !== value) target.textContent = value;
}

function syncKitchenSignal() {
  const now = performance.now();
  const kitchen = staffKitchen(session);
  const fresh = queueFresh(now);
  const cached = queueSnapshot !== null;
  const offline = !!session && !navigator.onLine;
  const stale = !!session && !fresh && (cached || needsQueueRefresh);
  changeText(queueStale, offline ? 'You are offline. Reconnect to refresh the kitchen queue.'
    : 'The kitchen queue may be out of date. Refresh before starting an order.');
  queueStale.hidden = !offline && !stale;
  kitchenSignal.hidden = !kitchen;
  let waiting = 0;
  for (const { card, order } of cards.values()) {
    const action = card.querySelector('[data-kitchen-action]');
    if (action) action.disabled = !fresh || kitchenTransitions.has(order.id);
    if (!kitchen || order.status !== 'accepted') continue;
    waiting++;
    const wait = card.querySelector('.kitchen-wait');
    const acceptedAt = order.acceptedAt === null ? null : Date.parse(order.acceptedAt);
    const server = queueSnapshot?.serverTime;
    const elapsed = server == null || acceptedAt === null ? null : Math.max(0, server + now - queueSnapshot.receivedAt - acceptedAt);
    const overdue = elapsed !== null && elapsed >= overdueMs;
    wait.hidden = false;
    wait.dataset.overdue = String(overdue);
    wait.querySelector('.kitchen-overdue').hidden = !overdue;
    changeText(wait.querySelector('.kitchen-age'), elapsed === null ? 'Awaiting preparation'
      : `${overdue ? ' · ' : 'Awaiting preparation · '}${Math.floor(elapsed / 1000)} s`);
  }

  if (kitchen) {
    kitchenSignal.dataset.waiting = String(waiting > 0);
    changeText(kitchenNewOrders, waiting === 1 ? '1 order awaiting preparation.' : `${waiting} orders awaiting preparation.`);
    changeText(kitchenSoundToggle, kitchenSoundState === 'on' ? 'Mute order sound' : 'Enable order sound');
    kitchenSoundToggle.disabled = kitchenSoundState === 'starting';
    changeText(kitchenSoundStatus, kitchenSoundState === 'on' ? (fresh ? 'Order sound is on.' : 'Order sound is paused until the queue is refreshed.')
      : kitchenSoundState === 'failed' ? 'Order sound could not be started. Select Enable order sound to try again.' : 'Order sound is off.');
  }
  const active = session && session.expiresAt > Date.now();
  void orderSound.update(active && kitchen && fresh && waiting > 0, now);
}

function invalidateQueue() {
  queueEpoch++;
  refreshVersion++;
  refreshing = false;
  needsQueueRefresh = true;
  refreshButton.disabled = false;
  syncKitchenSignal();
}

function recheckQueue() {
  if (!session) return;
  invalidateQueue();
  if (queueVisible()) void refreshQueue(true);
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
    || (order.acceptedAt != null && (typeof order.acceptedAt !== 'string' || !Number.isFinite(Date.parse(order.acceptedAt))))
    || !Array.isArray(order.lines) || !order.lines.every((line) => line && typeof line.sku === 'string'
      && Number.isInteger(line.quantity) && line.quantity > 0 && Array.isArray(line.modifierIds)
      && line.modifierIds.every((modifier) => typeof modifier === 'string'))) {
    throw new ApiError(502, 'invalid_response');
  }
  return {
    id: order.id,
    status: order.status,
    paymentStatus: order.paymentStatus,
    acceptedAt: order.acceptedAt ?? null,
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
    button.dataset.kitchenAction = 'true';
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

function addCancellation(card, order) {
  if (session.role !== 'manager' || !uuid.test(order.id)) return;

  const button = document.createElement('button');
  button.className = 'button button-secondary cancel-order';
  button.type = 'button';
  button.textContent = 'Cancel order';
  button.setAttribute('aria-haspopup', 'dialog');
  button.addEventListener('click', () => openCancellation(order.id));
  card.querySelector('.order-actions').append(button);
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
      card.querySelector('.order-title').textContent = `Order ${orderNumber(order.id)}`;
      const badge = card.querySelector('.order-status');
      badge.dataset.status = order.status;
      badge.textContent = statuses[order.status];
      card.querySelector('.pickup-window').textContent = pickupWindow(order.pickupStartsAt, order.pickupEndsAt);
      card.querySelector('.order-lines').append(...order.lines.map(renderedLine));
      addAction(card, order);
      addCancellation(card, order);
      cards.set(order.id, { card, signature, order });
      current?.card.replaceWith(card);
    }
    if (orderList.children[index] !== card) orderList.insertBefore(card, orderList.children[index] ?? null);
  });
  emptyState.hidden = display.length !== 0;
  syncKitchenSignal();
  if (cancellation && !cancellation.submitting && !isCurrentCancellation(cancellation)) {
    closeCancellation(`Order ${orderNumber(cancellation.id)} changed. Review the updated queue.`);
  }
}

function isCurrentCancellation(selection) {
  return session === selection.session && orders.some((order) => order.id === selection.id && order.status === selection.status);
}

function openCancellation(id) {
  const current = availableSession();
  const order = orders.find((item) => item.id === id);
  if (current?.role !== 'manager' || !order || !uuid.test(id) || cancellation) return;

  cancellation = { session: current, id, status: order.status, submitting: false };
  cancellationTitle.textContent = `Cancel order ${orderNumber(id)}?`;
  showMessage(queueNotice);
  showMessage(cancellationProblem);
  showMessage(cancellationProgress);
  keepOrderButton.disabled = false;
  confirmCancellationButton.disabled = false;
  cancellationDialog.showModal();
  keepOrderButton.focus();
}

function closeCancellation(message = '', restoreFocus = true) {
  const closed = cancellation;
  cancellation = null;
  if (cancellationDialog.open) cancellationDialog.close();
  cancellationTitle.textContent = '';
  showMessage(cancellationProblem);
  showMessage(cancellationProgress);
  if (!restoreFocus || !closed) return;
  if (message) {
    showMessage(queueNotice, message);
    queueNotice.focus();
  } else {
    (cards.get(closed.id)?.card.querySelector('.cancel-order') ?? workstationTitle).focus();
  }
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
  if (entry.refund != null) {
    const refund = entry.refund;
    if (typeof refund.providerRefundId !== 'string' || !providerId.test(refund.providerRefundId)
      || !Number.isSafeInteger(refund.amount) || refund.amount <= 0 || refund.currency !== 'RWF') {
      throw new ApiError(502, 'invalid_response');
    }
    showMessage(card.querySelector('.fiscal-result'),
      `Refund verified · ${integerFormat.format(refund.amount)} RWF · #${refund.providerRefundId}`);
  } else if (uuid.test(entry.merchantReference) && providerId.test(entry.providerTransactionId)) {
    const form = card.querySelector('.refund-form');
    form.hidden = false;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void verifyRefund(entry, card, form);
    });
  }
  return card;
}

async function verifyRefund(entry, card, form) {
  const current = availableSession();
  const submit = form.querySelector('button');
  if (current?.role !== 'manager' || submit.disabled) return;
  const input = form.elements.namedItem('refundId');
  const refundId = input.value.trim();
  if (!providerId.test(refundId)) return;
  const problem = form.querySelector('.manager-problem');
  submit.disabled = true;
  input.disabled = true;
  showMessage(problem);
  try {
    const data = await request(`/payment-exceptions/${entry.merchantReference}/${entry.providerTransactionId}/refund`, {
      method: 'POST', token: current.accessToken, body: { providerRefundId: refundId }, timeoutMs: 28_000,
    });
    if (session !== current) return;
    if (data?.providerRefundId !== refundId) throw new ApiError(502, 'invalid_response');
    const updated = renderedPaymentException({ ...entry, refund: data });
    card.replaceWith(updated);
    const status = updated.querySelector('.fiscal-result');
    status.tabIndex = -1;
    status.focus();
  } catch (error) {
    if (session !== current) return;
    if (error instanceof ApiError && error.status === 401) closeSession('Your staff session expired. Sign in again.');
    else showMessage(problem, messageFor(error));
  } finally {
    if (session === current) {
      submit.disabled = false;
      input.disabled = false;
    }
  }
}

function checkedReceipt(entry) {
  if (!entry || typeof entry.orderId !== 'string' || !uuid.test(entry.orderId) || entry.currency !== 'RWF'
    || !Number.isSafeInteger(entry.total) || entry.total <= 0
    || !['pending', 'issued', 'corrected'].includes(entry.receiptStatus)
    || (entry.receiptReference != null && (typeof entry.receiptReference !== 'string'
      || !receiptReference.test(entry.receiptReference)))) {
    throw new ApiError(502, 'invalid_response');
  }
  return entry;
}

function renderedReceipt(entry) {
  const card = fiscalReceiptTemplate.content.firstElementChild.cloneNode(true);
  card.querySelector('.order-title').textContent = `Order #${entry.orderId.slice(-8).toUpperCase()}`;
  const badge = card.querySelector('.order-status');
  badge.dataset.status = entry.receiptStatus === 'pending' ? 'accepted' : 'ready';
  badge.textContent = entry.receiptStatus === 'pending' ? 'Awaiting receipt'
    : entry.receiptStatus === 'corrected' ? 'Corrected' : 'Attached';
  card.querySelector('.receipt-total').textContent = `Paid total ${integerFormat.format(entry.total)} RWF`;
  if (entry.receiptStatus === 'pending') {
    const form = card.querySelector('.receipt-form');
    form.hidden = false;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void attachReceipt(entry, card, form);
    });
  } else if (entry.receiptReference) {
    showMessage(card.querySelector('.fiscal-result'), `EBM reference ${entry.receiptReference}`);
  }
  return card;
}

function renderReceipts() {
  const orderCode = fiscalReceiptsFilter.value.trim().replace(/^#/, '').toLowerCase();
  const visible = receipts.filter((entry) => entry.orderId.slice(-8).includes(orderCode));
  fiscalReceiptsList.replaceChildren(...visible.map(renderedReceipt));
  showMessage(fiscalReceiptsEmpty, visible.length ? ''
    : orderCode ? 'No matching order in this list.' : 'No paid orders for fiscal receipts.');
}

async function attachReceipt(entry, card, form) {
  const current = availableSession();
  const submit = form.querySelector('button');
  if (current?.role !== 'manager' || submit.disabled) return;
  const reference = form.elements.namedItem('reference').value.trim();
  const total = form.elements.namedItem('total').value.trim();
  const file = form.elements.namedItem('document').files[0];
  const problem = form.querySelector('.manager-problem');
  if (!receiptReference.test(reference)) {
    showMessage(problem, 'Enter the receipt reference printed by the EBM.');
    return;
  }
  if (!/^[1-9][0-9]{0,9}$/.test(total) || Number(total) !== entry.total) {
    showMessage(problem, 'The total printed on the receipt must match the paid order.');
    return;
  }
  if (!file || (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf'))
    || file.size === 0 || file.size > maxReceiptBytes) {
    showMessage(problem, 'Choose a PDF file up to 1 MB.');
    return;
  }

  const inputs = form.querySelectorAll('input');
  inputs.forEach((input) => { input.disabled = true; });
  submit.disabled = true;
  showMessage(problem);
  try {
    const data = checkedReceipt(await request(`/orders/${entry.orderId}/receipt`, {
      method: 'PUT', token: current.accessToken, receipt: { file, reference, total }, timeoutMs: 25_000,
    }));
    if (session !== current) return;
    if (data.orderId !== entry.orderId || data.receiptStatus !== 'issued' || data.receiptReference !== reference) {
      throw new ApiError(502, 'invalid_response');
    }
    receipts = receipts.map((item) => item.orderId === data.orderId ? data : item);
    const updated = renderedReceipt(data);
    card.replaceWith(updated);
    const status = updated.querySelector('.fiscal-result');
    status.tabIndex = -1;
    status.focus();
  } catch (error) {
    if (session !== current) return;
    if (error instanceof ApiError && error.status === 401) closeSession('Your staff session expired. Sign in again.');
    else showMessage(problem, messageFor(error));
  } finally {
    if (session === current) {
      submit.disabled = false;
      inputs.forEach((input) => { input.disabled = false; });
    }
  }
}

function closeSession(message = '') {
  authVersion++;
  refreshVersion++;
  queueEpoch++;
  paymentReviewVersion++;
  clearInterval(timer);
  clearInterval(kitchenTimer);
  session = null;
  closeCancellation('', false);
  showMessage(queueNotice);
  refreshing = false;
  refreshButton.disabled = false;
  queueSnapshot = null;
  needsQueueRefresh = false;
  kitchenTransitions.clear();
  orderSound.mute();
  orders = [];
  cards.clear();
  orderList.replaceChildren();
  paymentReview.hidden = true;
  paymentReviewJump.hidden = true;
  paymentReviewList.replaceChildren();
  paymentReviewRefresh.disabled = false;
  showMessage(paymentReviewProblem);
  showMessage(paymentReviewEmpty);
  receipts = [];
  fiscalReceipts.hidden = true;
  fiscalReceiptsJump.hidden = true;
  fiscalReceiptsFilter.value = '';
  fiscalReceiptsList.replaceChildren();
  fiscalReceiptsRefresh.disabled = false;
  showMessage(fiscalReceiptsProblem);
  showMessage(fiscalReceiptsEmpty);
  availability.reset();
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
  if (!current || !queueVisible() || (refreshing && !force)) return;

  const version = ++refreshVersion;
  refreshing = true;
  refreshButton.disabled = true;
  try {
    const data = await request('/orders', { token: current.accessToken });
    if (session !== current || refreshVersion !== version) return;
    if (!Array.isArray(data?.orders)) throw new ApiError(502, 'invalid_response');
    const serverTime = data.serverTime === undefined ? null : Date.parse(data.serverTime);
    if (serverTime !== null && (typeof data.serverTime !== 'string' || !Number.isFinite(serverTime))) {
      throw new ApiError(502, 'invalid_response');
    }
    orders = data.orders.map((order) => checkedOrder(order));
    queueSnapshot = { serverTime, receivedAt: performance.now() };
    needsQueueRefresh = false;
    renderOrders();
    showMessage(queueProblem);
    updateTime.textContent = `Updated at ${timeFormat.format(new Date(serverTime ?? Date.now()))} Kigali time`;
  } catch (error) {
    if (session !== current || refreshVersion !== version) return;
    if (error instanceof ApiError && error.status === 401) closeSession('Your staff session expired. Sign in again.');
    else {
      needsQueueRefresh = true;
      syncKitchenSignal();
      showMessage(queueProblem, messageFor(error));
    }
  } finally {
    if (session === current && refreshVersion === version) {
      refreshing = false;
      refreshButton.disabled = false;
    }
  }
}

async function refreshPaymentReview(force = false) {
  const current = availableSession();
  if (current?.role !== 'manager' || (paymentReviewRefresh.disabled && !force)) return;

  const version = ++paymentReviewVersion;
  paymentReviewRefresh.disabled = true;
  showMessage(paymentReviewProblem);
  showMessage(paymentReviewEmpty, paymentReviewList.childElementCount ? '' : 'Loading payment exceptions…');
  try {
    const data = await request('/payment-exceptions', { token: current.accessToken });
    if (session !== current || paymentReviewVersion !== version) return;
    if (!Array.isArray(data?.exceptions) || data.exceptions.length > 50) throw new ApiError(502, 'invalid_response');
    paymentReviewList.replaceChildren(...data.exceptions.map(renderedPaymentException));
    showMessage(paymentReviewEmpty, data.exceptions.length ? '' : 'No recent payment exceptions.');
    return data.exceptions;
  } catch (error) {
    if (session !== current || paymentReviewVersion !== version) return;
    if (error instanceof ApiError && error.status === 401) {
      closeSession('Your staff session expired. Sign in again.');
    } else {
      paymentReviewList.replaceChildren();
      showMessage(paymentReviewEmpty);
      showMessage(paymentReviewProblem, messageFor(error));
    }
  } finally {
    if (session === current && paymentReviewVersion === version) paymentReviewRefresh.disabled = false;
  }
}

async function refreshReceipts() {
  const current = availableSession();
  if (current?.role !== 'manager' || fiscalReceiptsRefresh.disabled) return;

  fiscalReceiptsRefresh.disabled = true;
  showMessage(fiscalReceiptsProblem);
  showMessage(fiscalReceiptsEmpty, receipts.length ? '' : 'Loading fiscal receipts…');
  try {
    const data = await request('/receipts', { token: current.accessToken });
    if (session !== current) return;
    if (!Array.isArray(data) || data.length > 100) throw new ApiError(502, 'invalid_response');
    receipts = data.map(checkedReceipt);
    renderReceipts();
  } catch (error) {
    if (session !== current) return;
    if (error instanceof ApiError && error.status === 401) closeSession('Your staff session expired. Sign in again.');
    else {
      receipts = [];
      fiscalReceiptsList.replaceChildren();
      showMessage(fiscalReceiptsEmpty);
      showMessage(fiscalReceiptsProblem, messageFor(error));
    }
  } finally {
    if (session === current) fiscalReceiptsRefresh.disabled = false;
  }
}

async function submitTransition(order, action, button, problem, input) {
  const current = availableSession();
  if (!current || button.disabled) return;
  const kitchenAction = action.status !== 'collected';
  const epoch = queueEpoch;
  if (kitchenAction && (!staffKitchen(current) || !queueFresh() || kitchenTransitions.has(order.id)
    || !orders.some((item) => item.id === order.id && item.status === order.status))) return;

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
  if (kitchenAction) kitchenTransitions.add(order.id);
  showMessage(problem);
  try {
    const data = await request(`/orders/${encodeURIComponent(order.id)}/status`, { method: 'POST', token: current.accessToken, body });
    if (session !== current || (kitchenAction && queueEpoch !== epoch)) return;
    const updated = checkedOrder(data, true);
    if (updated.id !== order.id || updated.status !== action.status) throw new ApiError(502, 'invalid_response');

    if (input) input.value = '';
    orders = orders.flatMap((item) => {
      if (item.id !== updated.id || item.status !== order.status) return [item];
      return updated.status === 'collected' ? [] : [updated];
    });
    renderOrders();
    await refreshQueue(true);
  } catch (error) {
    if (session !== current || (kitchenAction && queueEpoch !== epoch)) return;
    if (error instanceof ApiError && error.status === 401) closeSession('Your staff session expired. Sign in again.');
    else {
      showMessage(problem, messageFor(error));
      if (kitchenAction) {
        needsQueueRefresh = true;
        syncKitchenSignal();
        await refreshQueue(true);
      }
      if (input && error instanceof ApiError && error.code === 'pickup_code_mismatch') {
        input.value = '';
        input.disabled = false;
        input.setAttribute('aria-invalid', 'true');
        input.focus();
      }
    }
  } finally {
    if (session === current) {
      if (kitchenAction) {
        kitchenTransitions.delete(order.id);
        if (queueEpoch !== epoch && queueVisible()) {
          needsQueueRefresh = true;
          void refreshQueue(true);
        }
        syncKitchenSignal();
      } else button.disabled = false;
      if (input) input.disabled = false;
    }
  }
}

async function submitCancellation() {
  const current = availableSession();
  const selection = cancellation;
  if (current?.role !== 'manager' || !selection || selection.submitting) return;
  const number = orderNumber(selection.id);
  if (!isCurrentCancellation(selection)) {
    closeCancellation(`Order ${number} changed. Review the updated queue.`);
    return;
  }

  selection.submitting = true;
  keepOrderButton.disabled = true;
  confirmCancellationButton.disabled = true;
  showMessage(cancellationProblem);
  showMessage(cancellationProgress, 'Cancelling order…');
  cancellationProgress.focus();

  let cancelledOrder;
  let failure;
  try {
    const data = await request(`/orders/${encodeURIComponent(selection.id)}/cancel`, { method: 'POST', token: current.accessToken });
    if (data?.id !== selection.id || data.status !== 'cancelled' || !['refund_pending', 'refunded'].includes(data.paymentStatus)) {
      throw new ApiError(502, 'invalid_response');
    }
    cancelledOrder = data;
  } catch (error) {
    failure = error;
  }
  if (session !== current || cancellation !== selection) return;
  if (failure instanceof ApiError && failure.status === 401) {
    closeSession('Your staff session expired. Sign in again.');
    return;
  }

  const uncertain = !cancelledOrder && (!(failure instanceof ApiError) || failure.status >= 500);
  let exceptions;
  if (cancelledOrder || uncertain || (failure instanceof ApiError && [404, 409].includes(failure.status))) {
    showMessage(cancellationProgress, 'Checking the order and payment review…');
    [, exceptions] = await Promise.all([refreshQueue(true), refreshPaymentReview(true)]);
  }
  if (session !== current || cancellation !== selection) return;

  const recorded = exceptions?.find((entry) => entry.orderId === selection.id && entry.reason === 'restaurant_cancelled');
  if (cancelledOrder || recorded) {
    orders = orders.filter((order) => order.id !== selection.id);
    renderOrders();
    const refund = cancelledOrder?.paymentStatus === 'refunded' || recorded?.refund
      ? 'The refund is recorded in Payment review.' : 'Complete the refund and record it in Payment review.';
    closeCancellation(`Order ${number} was cancelled. ${refund}`);
  } else if (uncertain) {
    closeCancellation(`Cancellation of order ${number} could not be confirmed. Check the updated queue and Payment review before trying again.`);
  } else if (!isCurrentCancellation(selection)) {
    closeCancellation(`Order ${number} changed. Review the updated queue and Payment review.`);
  } else {
    selection.submitting = false;
    showMessage(cancellationProgress);
    showMessage(cancellationProblem, messageFor(failure));
    keepOrderButton.disabled = false;
    confirmCancellationButton.disabled = false;
    cancellationProblem.focus();
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
    fiscalReceipts.hidden = paymentReview.hidden;
    fiscalReceiptsJump.hidden = fiscalReceipts.hidden;
    workstationTitle.focus();
    timer = setInterval(() => { void refreshQueue(); }, queuePollMs);
    kitchenTimer = setInterval(() => {
      if (availableSession()) syncKitchenSignal();
    }, 1000);
    syncKitchenSignal();
    void refreshQueue();
    if (data.role === 'manager') {
      void refreshPaymentReview();
      void refreshReceipts();
      availability.show();
    }
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
kitchenSoundToggle.addEventListener('click', () => {
  if (!staffKitchen(availableSession())) return;
  if (kitchenSoundState === 'on') orderSound.mute();
  else void orderSound.enable();
});
element('cancellation-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void submitCancellation();
});
keepOrderButton.addEventListener('click', () => {
  if (!cancellation?.submitting) closeCancellation();
});
cancellationDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  if (!cancellation?.submitting) closeCancellation();
});
paymentReviewJump.addEventListener('click', () => { element('payment-review-title').focus(); });
paymentReviewRefresh.addEventListener('click', () => { void refreshPaymentReview(); });
fiscalReceiptsJump.addEventListener('click', () => { element('fiscal-receipts-title').focus(); });
fiscalReceiptsRefresh.addEventListener('click', () => { void refreshReceipts(); });
fiscalReceiptsFilter.addEventListener('input', renderReceipts);
document.addEventListener('visibilitychange', recheckQueue);
document.addEventListener('freeze', () => {
  pagePaused = true;
  recheckQueue();
});
document.addEventListener('resume', () => {
  pagePaused = false;
  recheckQueue();
});
window.addEventListener('pagehide', () => {
  pagePaused = true;
  recheckQueue();
});
window.addEventListener('pageshow', () => {
  pagePaused = false;
  recheckQueue();
});
window.addEventListener('offline', recheckQueue);
window.addEventListener('online', recheckQueue);
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
