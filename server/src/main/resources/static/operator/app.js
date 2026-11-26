import { mountAvailability } from './availability.js';
import { mountExternalOrders, readExternalOrder } from './external-orders.js';
import { mountOperationsSignals } from './operations-signals.js';
import { mountErasureRequests } from './erasure-requests.js';
import { createOrderSound } from './order-sound.js';
import { mountReconciliation } from './reconciliation.js';

const element = (id) => document.getElementById(id);
const signIn = element('sign-in');
const loginForm = element('login-form');
const loginButton = element('login-button');
const loginProblem = element('login-problem');
const authenticatorCode = element('authenticator-code');
const workstation = element('workstation');
const workstationTitle = element('workstation-title');
const refreshButton = element('refresh-button');
const queueProblem = element('queue-problem');
const queueStale = element('queue-stale');
const kitchenSignal = element('kitchen-signal');
const kitchenSignalTitle = element('kitchen-signal-title');
const kitchenNewOrders = element('kitchen-new-orders');
const kitchenSoundToggle = element('kitchen-sound-toggle');
const kitchenSoundStatus = element('kitchen-sound-status');
const queueNotice = element('queue-notice');
const pickupUncertainNotice = element('pickup-uncertain-notice');
const pickupLookupSection = element('pickup-lookup');
const pickupLookupForm = element('pickup-lookup-form');
const pickupLookupCode = element('pickup-lookup-code');
const pickupLookupFind = element('pickup-lookup-find');
const pickupLookupProblem = element('pickup-lookup-problem');
const pickupLookupNotice = element('pickup-lookup-notice');
const pickupLookupResult = element('pickup-lookup-result');
const pickupLookupOrder = element('pickup-lookup-order');
const pickupLookupStatus = element('pickup-lookup-status');
const pickupLookupWindow = element('pickup-lookup-window');
const pickupLookupOpen = element('pickup-lookup-open');
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
const paymentReviewOpen = element('payment-review-open');
const paymentReviewVerified = element('payment-review-verified');
const paymentReviewMore = element('payment-review-more');
const paymentReviewHelp = element('payment-review-help');
const paymentReviewNotice = element('payment-review-notice');
const paymentReviewProblem = element('payment-review-problem');
const paymentReviewEmpty = element('payment-review-empty');
const paymentReviewList = element('payment-review-list');
const paymentExceptionTemplate = element('payment-exception-template');
const pendingPaymentsRefresh = element('pending-payments-refresh');
const pendingPaymentsNotice = element('pending-payments-notice');
const pendingPaymentsProblem = element('pending-payments-problem');
const pendingPaymentsEmpty = element('pending-payments-empty');
const pendingPaymentsNavigation = element('pending-payments-navigation');
const pendingPaymentsFirst = element('pending-payments-first');
const pendingPaymentsNext = element('pending-payments-next');
const pendingPaymentsList = element('pending-payments-list');
const pendingPaymentTemplate = element('pending-payment-template');
const fiscalReceipts = element('fiscal-receipts');
const fiscalReceiptsJump = element('fiscal-receipts-jump');
const fiscalReceiptsRefresh = element('fiscal-receipts-refresh');
const fiscalReceiptsSearch = element('fiscal-receipts-search');
const fiscalReceiptsFilter = element('fiscal-receipts-filter');
const fiscalReceiptsFind = element('fiscal-receipts-find');
const fiscalReceiptsLookupProblem = element('fiscal-receipts-lookup-problem');
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
const pickupLookupLabels = { ...statuses, accepted: 'Accepted', collected: 'Collected', cancelled: 'Cancelled' };
const pickupLookupProgress = { accepted: 0, preparing: 1, ready: 2, collected: 3, cancelled: 3 };
const deliveryProgress = { accepted: 0, preparing: 1, ready: 2 };
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
const pickupChecks = new Map();
const knownExternalOrders = new Set();
const receiptCards = new Map();
const receiptUploads = new Set();

let session = null;
let orders = [];
let externalOrders = [];
let sawExternalOrders = false;
let receipts = [];
let receiptRefresh = null;
let receiptLookup = null;
let lastReceiptLookupId = null;
let pickupLookup = null;
let timer;
let kitchenTimer;
let refreshVersion = 0;
let queueEpoch = 0;
let queueSnapshot = null;
let needsQueueRefresh = false;
let pagePaused = false;
let refreshing = false;
let paymentReviewVersion = 0;
let paymentReviewView = 'open';
let paymentReviewCursor = null;
let paymentReviewLoading = false;
let refundVerificationBusy = false;
const paymentReviewCards = new Map();
const unconfirmedRefunds = new Map();
const unconfirmedRefundNotice = 'Verification could not be confirmed. Retry with the same refund ID or check verified history.';
let pendingPaymentsLoading = false;
let pendingPaymentChecking = false;
let pendingPaymentsCursor = null;
let pendingPaymentsNextCursor = null;
let authVersion = 0;
let cancellation = null;
const availability = mountAvailability({ currentSession: availableSession, request, messageFor, showMessage, closeSession });
const reconciliation = mountReconciliation({ currentSession: availableSession, request, messageFor, showMessage, closeSession });
const operationsSignals = mountOperationsSignals({
  currentSession: availableSession, request, messageFor, showMessage, closeSession, canRefresh: queueVisible,
});
const erasureRequests = mountErasureRequests({
  currentSession: availableSession, request, messageFor, showMessage, closeSession,
});
const delivery = mountExternalOrders({
  currentSession: availableSession, request, showMessage, messageFor, closeSession, queueFresh, syncQueue: syncKitchenSignal,
  isCurrent: (order) => externalOrders.some((item) => item.id === order.id && item.status === order.status),
  onOrder: updateExternalOrder,
});
let kitchenSoundState = 'off';
const orderSound = createOrderSound((state) => {
  kitchenSoundState = state;
  syncKitchenSignal();
});

class ApiError extends Error {
  constructor(status, code, requestId) {
    super('An operator request failed');
    this.status = status;
    this.code = code;
    this.requestId = typeof requestId === 'string' && uuid.test(requestId) ? requestId : null;
  }
}

async function request(path, { method = 'GET', token, body, receipt, csv = false, timeoutMs = 12_000, signal } = {}) {
  const headers = { Accept: csv ? 'text/csv, application/problem+json' : 'application/json, application/problem+json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (receipt) {
    headers['Content-Type'] = 'application/pdf';
    headers['X-Receipt-Reference'] = receipt.reference;
    headers['X-Receipt-Total-RWF'] = receipt.total;
  }

  const abort = new AbortController();
  const cancel = () => abort.abort();
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
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
    if (csv && response.ok) {
      const type = response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
      if (response.status !== 200 || type !== 'text/csv') throw new ApiError(502, 'invalid_response');
      return await response.blob();
    }
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) throw new ApiError(response.status, data?.code, response.headers.get('X-Request-ID'));
    return data;
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', cancel);
  }
}

function showMessage(target, message = '') {
  target.textContent = message;
  target.hidden = !message;
}

function messageFor(error, unavailable = 'The server could not complete this request. Try again.') {
  if (!(error instanceof ApiError)) return 'The server could not be reached. Try again.';
  if (error.status >= 500) {
    const message = error.code === 'refund_verification_unavailable' ? 'Refund verification is temporarily unavailable.' : unavailable;
    return error.requestId ? `${message} Support ID ${error.requestId}.` : message;
  }
  if (error.code === 'pickup_code_mismatch') return 'The pickup code did not match. Ask the guest for the code shown in their order.';
  if (error.code === 'refund_unconfirmed') return 'Flutterwave did not confirm a completed full refund for this payment.';
  if (error.code === 'payment_reference_unavailable') return 'The paid transaction could not be identified. Check Payment review before cancelling this order.';
  if (error.code === 'refund_already_recorded') return 'This payment already has a recorded refund. Refresh payment review.';
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
  return unavailable;
}

function label(value) {
  return value.replace(/[_-]+/g, ' ').replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function orderNumber(id) {
  return `#${id.slice(-8).toUpperCase()}`;
}

function exactOrderCode(input) {
  const code = input.trim().toLowerCase().replace(/^#(?=[0-9a-f]{8}$)/, '');
  return /^[0-9a-f]{8}$/.test(code) || uuid.test(code) ? code : null;
}

function matchesOrderCode(orderId, code) {
  return orderId === code || (code.length === 8 && orderId.endsWith(code));
}

function staffKitchen(current) {
  return current?.role === 'kitchen' || current?.role === 'manager';
}

function staffPickup(current) {
  return current?.role === 'pickup' || current?.role === 'manager';
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
  emptyState.hidden = !fresh || orders.length !== 0 || externalOrders.length !== 0;
  changeText(emptyState, sawExternalOrders ? 'No orders are waiting.' : 'No paid orders are waiting.');
  changeText(kitchenSignalTitle, sawExternalOrders ? 'New orders' : 'New paid orders');
  kitchenSignal.hidden = !kitchen;
  let waiting = 0;
  for (const { card, order } of cards.values()) {
    if (order.external) delivery.syncCard(card, order, fresh);
    else {
      const action = card.querySelector('[data-kitchen-action]');
      if (action) action.disabled = !fresh || kitchenTransitions.has(order.id);
    }
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
    kitchenSignal.dataset.waiting = String(fresh && waiting > 0);
    const waitingMessage = waiting === 1 ? '1 order awaiting preparation.' : `${waiting} orders awaiting preparation.`;
    changeText(kitchenNewOrders, fresh ? waitingMessage : stale ? 'Waiting orders could not be confirmed.' : '');
    changeText(kitchenSoundToggle, kitchenSoundState === 'on' ? 'Mute order sound' : 'Enable order sound');
    kitchenSoundToggle.disabled = kitchenSoundState === 'starting';
    changeText(kitchenSoundStatus, kitchenSoundState === 'on' ? (fresh ? 'Order sound is on.' : 'Order sound is paused until the queue is refreshed.')
      : kitchenSoundState === 'failed' ? 'Order sound could not be started. Select Enable order sound to try again.' : 'Order sound is off.');
  }
  syncPickupLookupQueue(fresh);
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
  operationsSignals.recheck();
}

function pickupWindow(start, end) {
  const startDate = new Date(start);
  const endDate = new Date(end);
  const day = dayFormat.format(startDate);
  const endDay = dayFormat.format(endDate);
  const endLabel = day === endDay ? timeFormat.format(endDate) : `${endDay}, ${timeFormat.format(endDate)}`;
  return `Pickup ${day}, ${timeFormat.format(startDate)}–${endLabel}`;
}

function pickupLookupQueueCard(fresh) {
  const entry = pickupLookup?.entry;
  if (!fresh || !entry || pickupLookup.unverified || !Object.hasOwn(statuses, entry.status)) return null;
  const card = cards.get(entry.orderId)?.card;
  return card?.isConnected ? card : null;
}

function syncPickupLookupQueue(fresh) {
  const entry = pickupLookup?.entry;
  const order = entry && fresh ? cards.get(entry.orderId)?.order : null;
  if (order && pickupLookupProgress[order.status] > pickupLookupProgress[entry.status]) entry.status = order.status;
  if (entry) {
    const label = pickupLookupLabels[entry.status];
    pickupLookupStatus.dataset.status = pickupLookup.unverified ? 'unverified' : entry.status;
    changeText(pickupLookupStatus, pickupLookup.unverified ? `Last known: ${label}` : label);
  }
  pickupLookupOpen.hidden = !pickupLookupQueueCard(fresh);
}

function renderPickupLookup() {
  const entry = pickupLookup?.entry;
  pickupLookupResult.hidden = !entry;
  changeText(pickupLookupOrder, entry ? `Order ${orderNumber(entry.orderId)}` : '');
  changeText(pickupLookupWindow, entry ? `${pickupWindow(entry.pickupStartsAt, entry.pickupEndsAt)} Kigali time` : '');
  if (!entry) {
    delete pickupLookupStatus.dataset.status;
    changeText(pickupLookupStatus, '');
  }
  syncPickupLookupQueue(queueFresh());
}

function clearPickupLookup() {
  const lookup = pickupLookup;
  pickupLookup = null;
  lookup?.controller.abort();
  pickupLookupFind.removeAttribute('aria-disabled');
  pickupLookupCode.removeAttribute('aria-invalid');
  showMessage(pickupLookupProblem);
  showMessage(pickupLookupNotice);
  renderPickupLookup();
}

function checkMissingPickupLookup() {
  const entry = pickupLookup?.entry;
  if (!entry || !Object.hasOwn(statuses, entry.status) || pickupLookup.queueStates.get(entry.orderId) !== 'missing') return;
  pickupLookup.queueStates.set(entry.orderId, 'checked');
  void findPickupOrder(entry.orderId);
}

function observePickupLookupQueue() {
  const lookup = pickupLookup;
  if (!lookup) return;
  const present = new Set(orders.filter(({ id }) => matchesOrderCode(id, lookup.code)).map(({ id }) => id));
  for (const [id, state] of lookup.queueStates) {
    if (state === 'present' && !present.has(id)) lookup.queueStates.set(id, 'missing');
  }
  for (const id of present) lookup.queueStates.set(id, 'present');

  if (lookup.entry && Object.hasOwn(statuses, lookup.entry.status)) {
    const state = lookup.queueStates.get(lookup.entry.orderId);
    if (state) lookup.unverified = state !== 'present';
    checkMissingPickupLookup();
  }
}

async function findPickupOrder(revalidateId) {
  const current = availableSession();
  if (!staffPickup(current) || (!revalidateId && pickupLookup?.loading)) return;
  const code = revalidateId ? pickupLookup?.code : exactOrderCode(pickupLookupCode.value);
  if (!code) {
    pickupLookupCode.setAttribute('aria-invalid', 'true');
    showMessage(pickupLookupProblem, 'Enter the eight-character order number or the full order ID.');
    pickupLookupCode.focus();
    return;
  }

  const previous = pickupLookup?.code === code ? pickupLookup : null;
  const queueStates = previous?.queueStates ?? new Map();
  if (queueFresh()) {
    for (const { id } of orders) if (matchesOrderCode(id, code)) queueStates.set(id, 'present');
  }
  const lookup = { code, entry: previous?.entry ?? null, loading: true, controller: new AbortController(),
    outcomes: previous?.outcomes ?? new Map(), queueStates, unverified: previous?.unverified ?? false };
  const startingQueue = queueSnapshot;
  const requestCode = revalidateId ?? code;
  pickupLookup = lookup;
  previous?.controller.abort();
  pickupLookupCode.removeAttribute('aria-invalid');
  pickupLookupFind.setAttribute('aria-disabled', 'true');
  showMessage(pickupLookupProblem);
  showMessage(pickupLookupNotice, 'Finding pickup order…');
  renderPickupLookup();
  try {
    const data = await request('/orders/lookup?' + new URLSearchParams({ orderCode: requestCode }), {
      token: current.accessToken, signal: lookup.controller.signal,
    });
    if (session !== current || pickupLookup !== lookup) return;
    if (typeof data?.orderId !== 'string' || !uuid.test(data.orderId) || !matchesOrderCode(data.orderId, requestCode)
      || !(Object.hasOwn(statuses, data.status) || data.status === 'collected')
      || typeof data.pickupStartsAt !== 'string' || typeof data.pickupEndsAt !== 'string'
      || !(Date.parse(data.pickupStartsAt) < Date.parse(data.pickupEndsAt))) {
      throw new ApiError(502, 'invalid_response');
    }
    const priorStatus = lookup.entry?.orderId === data.orderId ? lookup.entry.status : null;
    const status = pickupLookupProgress[priorStatus] > pickupLookupProgress[data.status] ? priorStatus : data.status;
    lookup.entry = { orderId: data.orderId, status: lookup.outcomes.get(data.orderId) ?? status,
      pickupStartsAt: data.pickupStartsAt, pickupEndsAt: data.pickupEndsAt };
    const queueState = lookup.queueStates.get(data.orderId);
    // A response begun before a later omission cannot certify a still-active pickup.
    lookup.unverified = Object.hasOwn(statuses, lookup.entry.status)
      && (queueState === 'missing' || (queueState === 'checked' && startingQueue !== queueSnapshot));
    showMessage(pickupLookupNotice);
  } catch (error) {
    if (session !== current || pickupLookup !== lookup) return;
    if (error instanceof ApiError && error.status === 401) closeSession('Your staff session expired. Sign in again.');
    else {
      showMessage(pickupLookupNotice);
      const terminal = lookup.entry && !Object.hasOwn(statuses, lookup.entry.status);
      const preserveLastKnown = !!lookup.entry && (terminal || lookup.unverified || !(error instanceof ApiError)
        || error.status >= 500);
      if (!preserveLastKnown) lookup.entry = null;
      lookup.unverified = preserveLastKnown && !terminal;
      if (error instanceof ApiError && error.status === 404) {
        showMessage(pickupLookupNotice, preserveLastKnown ? 'This order is no longer available for pickup lookup.'
          : 'No paid pickup order matches that number.');
      } else if (error instanceof ApiError && error.status === 409 && error.code === 'order_code_ambiguous') {
        lookup.entry = null;
        showMessage(pickupLookupProblem, 'More than one order has that code. Enter the full order ID.');
      } else {
        showMessage(pickupLookupProblem, messageFor(error, 'The pickup order could not be found right now. Try again.'));
      }
    }
  } finally {
    if (session === current && pickupLookup === lookup) {
      lookup.loading = false;
      lookup.outcomes.clear();
      pickupLookupFind.removeAttribute('aria-disabled');
      renderPickupLookup();
      checkMissingPickupLookup();
    }
  }
}

function rememberPickupLookupOutcome(orderId, status) {
  if (!pickupLookup || !matchesOrderCode(orderId, pickupLookup.code)) return;
  if (pickupLookup.loading) pickupLookup.outcomes.set(orderId, status);
  if (pickupLookup.entry?.orderId !== orderId) return;
  pickupLookup.entry.status = status;
  pickupLookup.unverified = false;
  renderPickupLookup();
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
  name.textContent = line.name ?? label(line.sku);
  details.append(name);
  const options = line.modifiers ?? line.modifierIds.map(label);
  if (options.length) {
    const modifiers = document.createElement('span');
    modifiers.className = 'modifiers';
    modifiers.textContent = options.join(' · ');
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
  button.disabled = input.disabled = pickupChecks.has(order.id);
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
  const display = [...orders, ...externalOrders].sort((left, right) =>
    Date.parse(left.pickupStartsAt ?? left.scheduledAt) - Date.parse(right.pickupStartsAt ?? right.scheduledAt)
    || left.id.localeCompare(right.id));
  const cardKey = (order) => order.external ? `external-${order.id}` : order.id;
  const visible = new Set(display.map(cardKey));
  for (const [id, { card }] of cards) {
    if (!visible.has(id)) {
      card.remove();
      cards.delete(id);
    }
  }
  display.forEach((order, index) => {
    const signature = JSON.stringify(order);
    const key = cardKey(order);
    const current = cards.get(key);
    let card = current?.card;
    if (current?.signature !== signature) {
      card = orderTemplate.content.firstElementChild.cloneNode(true);
      card.querySelector('.order-title').textContent = `Order ${order.external ? order.externalReference : orderNumber(order.id)}`;
      const badge = card.querySelector('.order-status');
      badge.dataset.status = order.status;
      badge.textContent = order.external && order.status === 'ready' ? 'Ready for handoff' : statuses[order.status];
      const time = card.querySelector('.pickup-window');
      card.querySelector('.order-lines').append(...order.lines.map(renderedLine));
      if (order.external) {
        const platform = document.createElement('p');
        platform.className = 'external-channel';
        platform.textContent = order.channelLabel;
        time.before(platform);
        time.textContent = `Handoff ${reviewTimeFormat.format(new Date(order.scheduledAt))} Kigali time`;
        delivery.addCardActions(card, order, session);
      } else {
        time.textContent = pickupWindow(order.pickupStartsAt, order.pickupEndsAt);
        addAction(card, order);
        addCancellation(card, order);
      }
      cards.set(key, { card, signature, order });
      current?.card.replaceWith(card);
    }
    if (orderList.children[index] !== card) orderList.insertBefore(card, orderList.children[index] ?? null);
  });
  syncKitchenSignal();
  if (cancellation && !cancellation.submitting && !isCurrentCancellation(cancellation)) {
    closeCancellation(`Order ${orderNumber(cancellation.id)} changed. Review the updated queue.`);
  }
}

function updateExternalOrder(order) {
  const latest = externalOrders.find(({ id }) => id === order.id);
  const active = Object.hasOwn(deliveryProgress, order.status);
  // An active response cannot undo observed progress or restore an order that left the active queue.
  if (active && (latest ? deliveryProgress[latest.status] > deliveryProgress[order.status] : knownExternalOrders.has(order.id))) {
    void refreshQueue(true);
    return latest;
  }
  // Discard a queue read that started before a write or a separately confirmed status.
  refreshVersion++;
  refreshing = false;
  refreshButton.disabled = false;
  externalOrders = externalOrders.filter(({ id }) => id !== order.id);
  if (active) externalOrders.push(order);
  knownExternalOrders.add(order.id);
  sawExternalOrders = true;
  renderOrders();
  void refreshQueue(true);
  return order;
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

function refundDescription(refund) {
  if (typeof refund?.providerRefundId !== 'string' || !providerId.test(refund.providerRefundId)
    || !Number.isSafeInteger(refund.amount) || refund.amount <= 0 || refund.currency !== 'RWF') {
    throw new ApiError(502, 'invalid_response');
  }
  return `Refund verified · ${integerFormat.format(refund.amount)} RWF · #${refund.providerRefundId}`;
}

function checkedPaymentException(entry) {
  if (!entry || ![entry.orderId, entry.merchantReference, entry.providerTransactionId, entry.reason]
    .every((value) => typeof value === 'string' && value.length > 0) || !Number.isFinite(Date.parse(entry.createdAt))) {
    throw new ApiError(502, 'invalid_response');
  }
  if (entry.refund != null) refundDescription(entry.refund);
  return entry;
}

function paymentExceptionKey(entry) {
  return JSON.stringify([entry.merchantReference, entry.providerTransactionId]);
}

function setUnconfirmedRefund(form, { refundId, message }) {
  const input = form.elements.namedItem('refundId');
  input.readOnly = true;
  input.value = refundId;
  form.querySelector('button').textContent = 'Retry verification';
  showMessage(form.querySelector('.manager-problem'), message);
}

function renderedPaymentException(entry) {
  const card = paymentExceptionTemplate.content.firstElementChild.cloneNode(true);
  card.querySelector('.payment-exception-reason').textContent = Object.hasOwn(paymentReasons, entry.reason)
    ? paymentReasons[entry.reason] : 'Payment exception';
  card.querySelector('.payment-exception-time').textContent = `${reviewTimeFormat.format(new Date(entry.createdAt))} Kigali time`;
  card.querySelector('.payment-exception-order').textContent = entry.orderId;
  card.querySelector('.payment-exception-reference').textContent = entry.merchantReference;
  card.querySelector('.payment-exception-transaction').textContent = entry.providerTransactionId;
  if (entry.refund != null) {
    showMessage(card.querySelector('.fiscal-result'), refundDescription(entry.refund));
  } else if (uuid.test(entry.merchantReference) && providerId.test(entry.providerTransactionId)) {
    const form = card.querySelector('.refund-form');
    form.hidden = false;
    const unconfirmed = unconfirmedRefunds.get(paymentExceptionKey(entry));
    if (unconfirmed) setUnconfirmedRefund(form, unconfirmed);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void verifyRefund(entry, card, form);
    });
  }
  return card;
}

function syncPaymentReviewControls() {
  const busy = paymentReviewLoading || refundVerificationBusy;
  paymentReviewOpen.disabled = refundVerificationBusy;
  paymentReviewVerified.disabled = refundVerificationBusy;
  paymentReviewOpen.setAttribute('aria-pressed', String(paymentReviewView === 'open'));
  paymentReviewVerified.setAttribute('aria-pressed', String(paymentReviewView === 'verified'));
  paymentReviewRefresh.disabled = busy;
  paymentReviewMore.disabled = busy;
  paymentReviewMore.hidden = paymentReviewCursor === null;
  paymentReviewList.setAttribute('aria-busy', String(paymentReviewLoading));
  for (const control of paymentReviewList.querySelectorAll('.refund-form input, .refund-form button')) {
    control.disabled = busy;
  }
}

function showPaymentReviewEmpty() {
  const empty = paymentReviewView === 'open' ? 'No open payment exceptions.' : 'No verified refunds.';
  showMessage(paymentReviewEmpty, paymentReviewCards.size || paymentReviewCursor !== null ? '' : empty);
}

function renderedPendingPayment(entry) {
  if (!entry || typeof entry.orderId !== 'string' || !uuid.test(entry.orderId)
    || typeof entry.merchantReference !== 'string' || !uuid.test(entry.merchantReference)
    || typeof entry.reservationExpiresAt !== 'string' || !Number.isFinite(Date.parse(entry.reservationExpiresAt))
    || (entry.lastCheckedAt !== null
      && (typeof entry.lastCheckedAt !== 'string' || !Number.isFinite(Date.parse(entry.lastCheckedAt))))) {
    throw new ApiError(502, 'invalid_response');
  }
  const card = pendingPaymentTemplate.content.firstElementChild.cloneNode(true);
  const number = orderNumber(entry.orderId);
  card.querySelector('.pending-payment-title').textContent = `Order ${number}`;
  card.querySelector('.pending-payment-order').textContent = entry.orderId;
  card.querySelector('.pending-payment-reference').textContent = entry.merchantReference;
  card.querySelector('.pending-payment-expires').textContent = reviewTimeFormat.format(new Date(entry.reservationExpiresAt));
  card.querySelector('.pending-payment-checked').textContent = entry.lastCheckedAt === null
    ? 'Awaiting first check' : reviewTimeFormat.format(new Date(entry.lastCheckedAt));
  const button = card.querySelector('.pending-payment-recheck');
  button.setAttribute('aria-label', `Recheck payment for order ${number}`);
  button.addEventListener('click', () => { void recheckPendingPayment(entry); });
  return card;
}

function syncPendingPaymentControls() {
  const busy = pendingPaymentsLoading || pendingPaymentChecking;
  pendingPaymentsRefresh.disabled = busy;
  pendingPaymentsFirst.disabled = busy;
  pendingPaymentsNext.disabled = busy;
  pendingPaymentsFirst.hidden = pendingPaymentsCursor === null;
  pendingPaymentsNext.hidden = pendingPaymentsNextCursor === null;
  pendingPaymentsNavigation.hidden = pendingPaymentsFirst.hidden && pendingPaymentsNext.hidden;
  pendingPaymentsList.setAttribute('aria-busy', String(pendingPaymentsLoading));
  for (const button of pendingPaymentsList.querySelectorAll('.pending-payment-recheck')) button.disabled = busy;
}

function pendingPaymentCheckMessage(error) {
  const unconfirmed = 'The payment check could not be confirmed. Review the payment lists before trying again.';
  if (!(error instanceof ApiError)) return unconfirmed;
  if (error.code === 'payment_check_cooldown') return 'This payment was checked recently. Wait before rechecking.';
  if (error.status === 404) return 'The attempt changed. Review the payment lists for its current status.';
  if (error.status === 409) return 'Flutterwave verification requires review. Use the merchant reference to check the payment in Flutterwave.';
  if (error.status === 503) {
    return messageFor(error, 'Payment verification is temporarily unavailable. Review the payment lists and recheck later.');
  }
  return messageFor(error, unconfirmed);
}

async function recheckPendingPayment(entry) {
  const current = availableSession();
  if (current?.role !== 'manager' || pendingPaymentsLoading || pendingPaymentChecking) return;

  const number = orderNumber(entry.orderId);
  pendingPaymentChecking = true;
  syncPendingPaymentControls();
  showMessage(pendingPaymentsNotice, `Checking payment for order ${number}…`);
  let message;
  try {
    const data = await request(`/payment-attempts/${entry.merchantReference}/recheck`, {
      method: 'POST', token: current.accessToken, timeoutMs: 28_000,
    });
    if (data?.status === 'pending') message = `Payment for order ${number} is still unresolved.`;
    else if (data?.status === 'settled') message = `Payment check completed for order ${number}. Review the payment exceptions for any required refund.`;
    else throw new ApiError(502, 'invalid_response');
  } catch (error) {
    if (session !== current) return;
    if (error instanceof ApiError && error.status === 401) {
      closeSession('Your staff session expired. Sign in again.');
      return;
    }
    message = pendingPaymentCheckMessage(error);
  }
  if (session !== current) return;
  await Promise.all([refreshPendingPayments(), refreshPaymentReview({ force: true })]);
  if (session !== current) return;
  pendingPaymentChecking = false;
  syncPendingPaymentControls();
  showMessage(pendingPaymentsNotice, message);
  if (document.activeElement === document.body) pendingPaymentsNotice.focus();
}

async function verifyRefund(entry, card, form) {
  const current = availableSession();
  const submit = form.querySelector('button');
  if (current?.role !== 'manager' || paymentReviewView !== 'open' || submit.disabled || refundVerificationBusy) return;
  const key = paymentExceptionKey(entry);
  const input = form.elements.namedItem('refundId');
  const refundId = unconfirmedRefunds.get(key)?.refundId ?? input.value.trim();
  if (!providerId.test(refundId)) return;
  const problem = form.querySelector('.manager-problem');
  refundVerificationBusy = true;
  syncPaymentReviewControls();
  showMessage(problem);
  showMessage(paymentReviewNotice);
  try {
    const data = await request(`/payment-exceptions/${entry.merchantReference}/${entry.providerTransactionId}/refund`, {
      method: 'POST', token: current.accessToken, body: { providerRefundId: refundId }, timeoutMs: 28_000,
    });
    if (session !== current) return;
    if (data?.providerRefundId !== refundId) throw new ApiError(502, 'invalid_response');
    const message = refundDescription(data);
    unconfirmedRefunds.delete(key);
    paymentReviewCards.delete(key);
    card.remove();
    showPaymentReviewEmpty();
    showMessage(paymentReviewNotice, message);
    if (document.activeElement === document.body) paymentReviewNotice.focus();
  } catch (error) {
    if (session !== current) return;
    if (error instanceof ApiError && error.status === 401) {
      closeSession('Your staff session expired. Sign in again.');
      return;
    }
    if (!(error instanceof ApiError) || error.status === 408 || error.status >= 500) {
      const message = error instanceof ApiError && error.requestId
        ? `${unconfirmedRefundNotice} Support ID ${error.requestId}.` : unconfirmedRefundNotice;
      const pending = { entry, refundId, message };
      unconfirmedRefunds.set(key, pending);
      setUnconfirmedRefund(form, pending);
    } else {
      unconfirmedRefunds.delete(key);
      input.readOnly = false;
      submit.textContent = 'Verify refund';
      showMessage(problem, messageFor(error));
    }
    if (document.activeElement === document.body) {
      problem.tabIndex = -1;
      problem.focus();
    }
  } finally {
    if (session === current) {
      refundVerificationBusy = false;
      syncPaymentReviewControls();
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
    if (receiptUploads.has(entry.orderId)) setReceiptFormBusy(card, true);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void attachReceipt(entry, card, form);
    });
  } else if (entry.receiptReference) {
    showMessage(card.querySelector('.fiscal-result'), `EBM reference ${entry.receiptReference}`);
  }
  return card;
}

function receiptCard(entry) {
  const previous = receiptCards.get(entry.orderId);
  if (previous && previous.entry.receiptStatus === entry.receiptStatus
    && previous.entry.receiptReference === entry.receiptReference && previous.entry.total === entry.total) return previous.card;
  const card = renderedReceipt(entry);
  receiptCards.set(entry.orderId, { entry, card });
  return card;
}

function renderReceipts() {
  const orderCode = fiscalReceiptsFilter.value.trim().replace(/^#/, '').toLowerCase();
  const visible = receiptLookup ? [receiptLookup.entry].filter(Boolean) : receipts.filter((entry) =>
    entry.orderId === orderCode || entry.orderId.slice(-8).includes(orderCode));
  const listedIds = new Set(receipts.map(({ orderId }) => orderId));
  // Retain one out-of-list draft for another lookup, and keep any upload alive through refiltering.
  if (lastReceiptLookupId) listedIds.add(lastReceiptLookupId);
  for (const id of receiptCards.keys()) {
    if (!listedIds.has(id) && !receiptUploads.has(id)) receiptCards.delete(id);
  }
  const focused = document.activeElement;
  const visibleCards = new Set(visible.map(receiptCard));
  for (const card of Array.from(fiscalReceiptsList.children)) {
    if (!visibleCards.has(card)) card.remove();
  }
  let index = 0;
  for (const card of visibleCards) {
    const current = fiscalReceiptsList.children[index++] ?? null;
    if (card !== current) fiscalReceiptsList.insertBefore(card, current);
  }
  if (document.activeElement === document.body && fiscalReceiptsList.contains(focused)) {
    focused.focus({ preventScroll: true });
  }
  if (receiptLookup) {
    if (receiptLookup.state === 'loading') showMessage(fiscalReceiptsEmpty, 'Finding order…');
    else showMessage(fiscalReceiptsEmpty, receiptLookup.state === 'missing' ? 'No paid order matches that number.' : '');
    return;
  }
  showMessage(fiscalReceiptsEmpty, visible.length ? ''
    : orderCode ? 'No matching order in this list.' : 'No paid orders for fiscal receipts.');
}

function syncReceiptSearchControls() {
  const finding = receiptLookup?.state === 'loading';
  for (const control of [fiscalReceiptsFind, fiscalReceiptsRefresh]) {
    if (finding) control.setAttribute('aria-disabled', 'true');
    else control.removeAttribute('aria-disabled');
  }
  fiscalReceiptsRefresh.disabled = !receiptLookup && receiptRefresh !== null;
}

function clearReceiptLookup() {
  const lookup = receiptLookup;
  receiptLookup = null;
  lookup?.controller.abort();
  syncReceiptSearchControls();
  fiscalReceiptsFilter.removeAttribute('aria-invalid');
  showMessage(fiscalReceiptsLookupProblem);
}

async function findReceipt() {
  const current = availableSession();
  if (current?.role !== 'manager' || receiptLookup?.state === 'loading') return;
  const code = exactOrderCode(fiscalReceiptsFilter.value);
  if (!code) {
    fiscalReceiptsFilter.setAttribute('aria-invalid', 'true');
    showMessage(fiscalReceiptsLookupProblem, 'Enter the eight-character order number or the full order ID.');
    fiscalReceiptsFilter.focus();
    return;
  }

  const entry = receiptLookup?.code === code ? receiptLookup.entry : null;
  const lookup = { code, entry, state: 'loading', controller: new AbortController(), attachments: new Map() };
  receiptLookup = lookup;
  syncReceiptSearchControls();
  fiscalReceiptsFilter.removeAttribute('aria-invalid');
  showMessage(fiscalReceiptsLookupProblem);
  renderReceipts();
  try {
    const data = await request('/receipts?' + new URLSearchParams({ orderCode: code }), {
      token: current.accessToken, signal: lookup.controller.signal,
    });
    if (session !== current || receiptLookup !== lookup) return;
    if (!Array.isArray(data) || data.length > 1) throw new ApiError(502, 'invalid_response');
    if (data.length === 1) {
      const found = checkedReceipt(data[0]);
      if (!matchesOrderCode(found.orderId, code)) {
        throw new ApiError(502, 'invalid_response');
      }
      lookup.entry = found.receiptStatus === 'pending' ? lookup.attachments.get(found.orderId) ?? found : found;
      if (lookup.entry.receiptStatus !== 'pending' && receipts.some((item) =>
        item.orderId === found.orderId && item.receiptStatus === 'pending')) {
        receiptRefresh?.attachments.set(found.orderId, lookup.entry);
        receipts = receipts.map((item) => item.orderId === found.orderId && item.receiptStatus === 'pending'
          ? lookup.entry : item);
      }
      lastReceiptLookupId = found.orderId;
      lookup.state = 'found';
    } else {
      lookup.entry = null;
      lookup.state = 'missing';
    }
  } catch (error) {
    if (session !== current || receiptLookup !== lookup) return;
    if (error instanceof ApiError && error.status === 401) closeSession('Your staff session expired. Sign in again.');
    else {
      lookup.state = 'failed';
      if (error instanceof ApiError && error.status === 409 && error.code === 'receipt_order_code_ambiguous') {
        lookup.entry = null;
        showMessage(fiscalReceiptsLookupProblem, 'More than one order has that code. Enter the full order ID.');
      } else {
        showMessage(fiscalReceiptsLookupProblem, messageFor(error, 'The order could not be found right now. Try again.'));
      }
    }
  } finally {
    if (session === current && receiptLookup === lookup) {
      lookup.attachments.clear();
      syncReceiptSearchControls();
      renderReceipts();
    }
  }
}

function setReceiptFormBusy(card, busy) {
  card.querySelectorAll('.receipt-form input, .receipt-form button').forEach((control) => { control.disabled = busy; });
}

async function attachReceipt(entry, card, form) {
  const current = availableSession();
  if (current?.role !== 'manager' || receiptUploads.has(entry.orderId) || !card.isConnected) return;
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

  const focusedBeforeUpload = card.contains(document.activeElement);
  receiptUploads.add(entry.orderId);
  setReceiptFormBusy(card, true);
  showMessage(problem);
  try {
    const data = checkedReceipt(await request(`/orders/${entry.orderId}/receipt`, {
      method: 'PUT', token: current.accessToken, receipt: { file, reference, total }, timeoutMs: 25_000,
    }));
    if (session !== current) return;
    if (data.orderId !== entry.orderId || data.total !== entry.total
      || data.receiptStatus !== 'issued' || data.receiptReference !== reference) {
      throw new ApiError(502, 'invalid_response');
    }
    receiptRefresh?.attachments.set(data.orderId, data);
    if (receiptLookup?.state === 'loading') receiptLookup.attachments.set(data.orderId, data);
    if (receiptLookup?.entry?.orderId === data.orderId && receiptLookup.entry.receiptStatus === 'pending') {
      receiptLookup.entry = data;
    }
    if (receipts.some(({ orderId }) => orderId === data.orderId)) {
      receipts = receipts.map((item) => item.orderId === data.orderId && item.receiptStatus === 'pending' ? data : item);
    } else {
      receipts.push(data);
    }
    const previous = receiptCards.get(data.orderId)?.card;
    const focused = document.activeElement;
    const focusResult = previous?.isConnected
      && (previous.contains(focused) || (focusedBeforeUpload && focused === document.body));
    renderReceipts();
    const result = receiptCards.get(data.orderId)?.card.querySelector('.fiscal-result');
    if (focusResult && result?.isConnected && !result.hidden) {
      result.tabIndex = -1;
      result.focus();
    }
  } catch (error) {
    if (session !== current) return;
    if (error instanceof ApiError && error.status === 401) closeSession('Your staff session expired. Sign in again.');
    else showMessage(problem, messageFor(error));
  } finally {
    if (session === current) {
      receiptUploads.delete(entry.orderId);
      setReceiptFormBusy(card, false);
      const latest = receiptCards.get(entry.orderId)?.card;
      if (latest && latest !== card) setReceiptFormBusy(latest, false);
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
  clearPickupLookup();
  pickupLookupCode.value = '';
  pickupLookupSection.hidden = true;
  closeCancellation('', false);
  showMessage(queueNotice);
  showMessage(pickupUncertainNotice);
  refreshing = false;
  refreshButton.disabled = false;
  queueSnapshot = null;
  needsQueueRefresh = false;
  kitchenTransitions.clear();
  pickupChecks.clear();
  orderSound.mute();
  orders = [];
  externalOrders = [];
  knownExternalOrders.clear();
  sawExternalOrders = false;
  cards.clear();
  orderList.replaceChildren();
  paymentReview.hidden = true;
  paymentReviewJump.hidden = true;
  paymentReviewView = 'open';
  paymentReviewCursor = null;
  paymentReviewLoading = false;
  refundVerificationBusy = false;
  paymentReviewCards.clear();
  unconfirmedRefunds.clear();
  paymentReviewList.replaceChildren();
  updatePaymentReviewHelp();
  syncPaymentReviewControls();
  showMessage(paymentReviewNotice);
  showMessage(paymentReviewProblem);
  showMessage(paymentReviewEmpty);
  pendingPaymentsLoading = false;
  pendingPaymentChecking = false;
  pendingPaymentsCursor = null;
  pendingPaymentsNextCursor = null;
  pendingPaymentsList.replaceChildren();
  syncPendingPaymentControls();
  showMessage(pendingPaymentsNotice);
  showMessage(pendingPaymentsProblem);
  showMessage(pendingPaymentsEmpty);
  receipts = [];
  receiptRefresh = null;
  clearReceiptLookup();
  lastReceiptLookupId = null;
  receiptUploads.clear();
  receiptCards.clear();
  fiscalReceipts.hidden = true;
  fiscalReceiptsJump.hidden = true;
  fiscalReceiptsFilter.value = '';
  fiscalReceiptsList.replaceChildren();
  showMessage(fiscalReceiptsProblem);
  showMessage(fiscalReceiptsEmpty);
  availability.reset();
  reconciliation.reset();
  operationsSignals.reset();
  erasureRequests.reset();
  delivery.reset();
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
    if (!Array.isArray(data?.orders) || (data.externalOrders !== undefined && !Array.isArray(data.externalOrders))) {
      throw new ApiError(502, 'invalid_response');
    }
    const serverTime = data.serverTime === undefined ? null : Date.parse(data.serverTime);
    if (serverTime !== null && (typeof data.serverTime !== 'string' || !Number.isFinite(serverTime))) {
      throw new ApiError(502, 'invalid_response');
    }
    const nextOrders = data.orders.map((order) => checkedOrder(order));
    const nextExternal = (data.externalOrders ?? []).map((order) => readExternalOrder(order, true));
    if (new Set(nextExternal.map(({ id }) => id)).size !== nextExternal.length) throw new ApiError(502, 'invalid_response');
    orders = nextOrders;
    externalOrders = nextExternal;
    for (const order of nextExternal) knownExternalOrders.add(order.id);
    sawExternalOrders ||= externalOrders.length !== 0;
    queueSnapshot = { serverTime, receivedAt: performance.now() };
    needsQueueRefresh = false;
    observePickupLookupQueue();
    renderOrders();
    showMessage(queueProblem);
    updateTime.textContent = `Updated at ${timeFormat.format(new Date(serverTime ?? Date.now()))} Kigali time`;
  } catch (error) {
    if (session !== current || refreshVersion !== version) return;
    if (error instanceof ApiError && error.status === 401) closeSession('Your staff session expired. Sign in again.');
    else {
      needsQueueRefresh = true;
      syncKitchenSignal();
      if (!queueSnapshot) updateTime.textContent = '';
      showMessage(queueProblem, messageFor(error, 'The order queue could not be refreshed. Try again.'));
    }
  } finally {
    if (session === current && refreshVersion === version) {
      refreshing = false;
      refreshButton.disabled = false;
    }
  }
}

function addPaymentExceptionCards(entries) {
  let first;
  for (const entry of entries) {
    const key = paymentExceptionKey(entry);
    if (paymentReviewCards.has(key)) continue;
    const card = renderedPaymentException(entry);
    paymentReviewCards.set(key, card);
    paymentReviewList.append(card);
    first ??= card;
  }
  return first;
}

function updatePaymentReviewHelp() {
  paymentReviewHelp.textContent = paymentReviewView === 'open'
    ? 'Process the refund in Flutterwave using the provider transaction ID. Enter the refund ID here to verify and record the result.'
    : 'Review refunds already verified and recorded for this restaurant.';
}

function selectPaymentReview(view) {
  if (availableSession()?.role !== 'manager' || paymentReviewView === view || refundVerificationBusy) return;
  paymentReviewView = view;
  paymentReviewCursor = null;
  paymentReviewCards.clear();
  paymentReviewList.replaceChildren();
  if (view === 'open') addPaymentExceptionCards([...unconfirmedRefunds.values()].map(({ entry }) => entry));
  updatePaymentReviewHelp();
  showMessage(paymentReviewNotice);
  void refreshPaymentReview({ force: true });
}

async function refreshPaymentReview({ append = false, force = false } = {}) {
  const current = availableSession();
  if (current?.role !== 'manager' || refundVerificationBusy || (paymentReviewLoading && !force)) return;

  const after = append ? paymentReviewCursor : null;
  if (append && after === null) return;
  const view = paymentReviewView;
  const params = new URLSearchParams({ state: view });
  if (after !== null) params.set('after', after);
  const version = ++paymentReviewVersion;
  paymentReviewLoading = true;
  syncPaymentReviewControls();
  showMessage(paymentReviewProblem);
  showMessage(paymentReviewEmpty, paymentReviewList.childElementCount ? '' : 'Loading payment exceptions…');
  try {
    const data = await request(`/payment-exceptions?${params}`, { token: current.accessToken });
    if (session !== current || paymentReviewVersion !== version) return;
    if (!Array.isArray(data?.exceptions) || data.exceptions.length > 50 || (data.nextCursor !== null
      && (typeof data.nextCursor !== 'string' || !data.nextCursor || data.nextCursor.length > 1024
        || data.nextCursor === after || !data.exceptions.length))) throw new ApiError(502, 'invalid_response');
    const entries = data.exceptions.map(checkedPaymentException);
    if (entries.some(entry => (entry.refund != null) !== (view === 'verified'))) throw new ApiError(502, 'invalid_response');
    if (!append) {
      paymentReviewCards.clear();
      paymentReviewList.replaceChildren();
      if (view === 'open') addPaymentExceptionCards([...unconfirmedRefunds.values()].map(({ entry }) => entry));
    }
    if (view === 'verified') {
      for (const entry of entries) unconfirmedRefunds.delete(paymentExceptionKey(entry));
    }
    const first = addPaymentExceptionCards(entries);
    paymentReviewCursor = data.nextCursor;
    showPaymentReviewEmpty();
    if (append && first && (document.activeElement === document.body || document.activeElement === paymentReviewMore)) {
      const heading = first.querySelector('.payment-exception-reason');
      heading.tabIndex = -1;
      heading.focus();
    }
  } catch (error) {
    if (session !== current || paymentReviewVersion !== version) return;
    if (error instanceof ApiError && error.status === 401) {
      closeSession('Your staff session expired. Sign in again.');
    } else {
      showMessage(paymentReviewEmpty);
      showMessage(paymentReviewProblem, messageFor(error, 'Payment exceptions could not be loaded. Try again.'));
    }
  } finally {
    if (session === current && paymentReviewVersion === version) {
      paymentReviewLoading = false;
      syncPaymentReviewControls();
    }
  }
}

async function readCancellationExceptions(current) {
  try {
    // The most recent exceptions can prove a lost cancellation reply regardless of the manager's current view.
    const data = await request('/payment-exceptions', { token: current.accessToken });
    if (session === current && Array.isArray(data?.exceptions) && data.exceptions.length <= 50) {
      return data.exceptions.map(checkedPaymentException);
    }
  } catch (error) {
    if (session === current && error instanceof ApiError && error.status === 401) {
      closeSession('Your staff session expired. Sign in again.');
    }
  }
}

async function refreshPendingPayments(after = pendingPaymentsCursor) {
  const current = availableSession();
  if (current?.role !== 'manager' || pendingPaymentsLoading) return;

  const moving = after !== pendingPaymentsCursor;
  let moved = false;
  pendingPaymentsLoading = true;
  syncPendingPaymentControls();
  showMessage(pendingPaymentsProblem);
  showMessage(pendingPaymentsEmpty, pendingPaymentsList.childElementCount ? '' : 'Loading unresolved payments…');
  try {
    const query = after === null ? '' : `?after=${after}`;
    const data = await request(`/payment-attempts/pending${query}`, { token: current.accessToken });
    if (session !== current) return;
    if (!Array.isArray(data?.attempts) || data.attempts.length > 50
      || typeof data.hasMore !== 'boolean' || (data.hasMore && !data.attempts.length)) {
      throw new ApiError(502, 'invalid_response');
    }
    pendingPaymentsList.replaceChildren(...data.attempts.map(renderedPendingPayment));
    pendingPaymentsCursor = after;
    pendingPaymentsNextCursor = data.hasMore ? data.attempts.at(-1).merchantReference : null;
    const empty = after === null ? 'No unresolved payments with an expired reservation.' : 'No unresolved payments on this page.';
    showMessage(pendingPaymentsEmpty, data.attempts.length ? '' : empty);
    moved = moving;
  } catch (error) {
    if (session !== current) return;
    if (error instanceof ApiError && error.status === 401) {
      closeSession('Your staff session expired. Sign in again.');
    } else {
      if (!moving) {
        pendingPaymentsList.replaceChildren();
        pendingPaymentsNextCursor = null;
      }
      showMessage(pendingPaymentsEmpty);
      showMessage(pendingPaymentsProblem, messageFor(error, 'Unresolved payments could not be loaded. Select Refresh unresolved payments.'));
    }
  } finally {
    if (session === current) {
      pendingPaymentsLoading = false;
      syncPendingPaymentControls();
      if (moved && (document.activeElement === document.body || pendingPaymentsNavigation.contains(document.activeElement))) {
        element('pending-payments-title').focus();
      }
    }
  }
}

async function refreshReceipts() {
  const current = availableSession();
  if (current?.role !== 'manager' || receiptRefresh) return;

  const refresh = { attachments: new Map() };
  receiptRefresh = refresh;
  syncReceiptSearchControls();
  showMessage(fiscalReceiptsProblem);
  if (!receiptLookup) showMessage(fiscalReceiptsEmpty, receipts.length ? '' : 'Loading fiscal receipts…');
  try {
    const data = await request('/receipts', { token: current.accessToken });
    if (session !== current) return;
    if (!Array.isArray(data) || data.length > 100) throw new ApiError(502, 'invalid_response');
    const next = data.map(checkedReceipt).map((entry) => {
      // A list request already in flight can still return the pre-upload state for an attached receipt.
      return entry.receiptStatus === 'pending' ? refresh.attachments.get(entry.orderId) ?? entry : entry;
    });
    const returnedIds = new Set(next.map(({ orderId }) => orderId));
    for (const entry of receipts) {
      if (returnedIds.has(entry.orderId)) continue;
      // The bounded list can omit the order. Carry a concurrent confirmation or active form until the next read.
      const confirmed = refresh.attachments.get(entry.orderId);
      if (confirmed || receiptUploads.has(entry.orderId)) next.push(confirmed ?? entry);
    }
    receipts = next;
    renderReceipts();
  } catch (error) {
    if (session !== current) return;
    if (error instanceof ApiError && error.status === 401) closeSession('Your staff session expired. Sign in again.');
    else {
      receipts = receipts.filter(({ orderId }) => refresh.attachments.has(orderId) || receiptUploads.has(orderId));
      renderReceipts();
      if (!receiptLookup) showMessage(fiscalReceiptsEmpty);
      showMessage(fiscalReceiptsProblem, messageFor(error));
    }
  } finally {
    if (session === current) {
      receiptRefresh = null;
      syncReceiptSearchControls();
    }
  }
}

function setPickupCheck(id, state) {
  const check = state ? { state } : null;
  if (check) pickupChecks.set(id, check);
  else pickupChecks.delete(id);
  const form = cards.get(id)?.card.querySelector('.pickup-form');
  if (form) {
    form.querySelector('button').disabled = !!state;
    form.elements.namedItem('pickupCode').disabled = !!state;
  }
  const uncertain = [...pickupChecks].filter(([, value]) => value.state === 'uncertain').map(([orderId]) => orderNumber(orderId));
  const target = uncertain.length === 1 ? `order ${uncertain[0]}` : `orders ${uncertain.join(', ')}`;
  showMessage(pickupUncertainNotice, uncertain.length
    ? `Pickup for ${target} could not be confirmed. Select Refresh to check the server before handing it out.` : '');
  return check;
}

function showPickupOutcome(id, status, confirmedByCurrentOperator) {
  const number = orderNumber(id);
  if (status === 'collected' || status === 'cancelled') {
    // A queue read started before the terminal outcome can still contain the ready card.
    refreshVersion++;
    refreshing = false;
    refreshButton.disabled = false;
    const focusWasOnOrder = cards.get(id)?.card.contains(document.activeElement);
    orders = orders.filter(item => item.id !== id);
    rememberPickupLookupOutcome(id, status);
    renderOrders();
    const message = status === 'cancelled' ? `Order ${number} was cancelled. Do not hand it out.`
      : confirmedByCurrentOperator ? `Pickup for order ${number} was confirmed by this account.`
        : `Order ${number} was already collected.`;
    showMessage(queueNotice, message);
    if (focusWasOnOrder) queueNotice.focus();
  } else {
    showMessage(queueNotice, status === 'ready'
      ? `Order ${number} is still ready for pickup. Check the code before confirming again.`
      : `Order ${number} is no longer ready for pickup. Review the queue.`);
  }
}

async function checkPickup(id, current) {
  const number = orderNumber(id);
  const checking = `Checking pickup for order ${number}…`;
  const check = setPickupCheck(id, 'checking');
  showMessage(queueNotice, checking);
  try {
    const result = await request(`/orders/${encodeURIComponent(id)}/pickup-status`, { token: current.accessToken });
    if (session !== current || pickupChecks.get(id) !== check) return;
    if (result?.id !== id || !['awaiting_payment', 'accepted', 'preparing', 'ready', 'collected', 'cancelled'].includes(result.status)
      || typeof result.confirmedByCurrentOperator !== 'boolean'
      || (result.confirmedByCurrentOperator && result.status !== 'collected')) {
      throw new ApiError(502, 'invalid_response');
    }
    setPickupCheck(id);
    showPickupOutcome(id, result.status, result.confirmedByCurrentOperator);
  } catch (error) {
    if (session !== current || pickupChecks.get(id) !== check) return;
    if (error instanceof ApiError && error.status === 401) closeSession('Your staff session expired. Sign in again.');
    else {
      setPickupCheck(id, 'uncertain');
      if (queueNotice.textContent === checking) showMessage(queueNotice);
    }
  }
}

async function refreshPickupChecks() {
  const current = availableSession();
  if (!current) return;
  await delivery.checkUnconfirmed();
  if (session !== current) return;
  const uncertain = [...pickupChecks].filter(([, check]) => check.state === 'uncertain');
  for (const [id, check] of uncertain) {
    if (session !== current) return;
    if (pickupChecks.get(id) === check) await checkPickup(id, current);
  }
  if (session === current) await refreshQueue(uncertain.length > 0);
}

async function submitTransition(order, action, button, problem, input) {
  const current = availableSession();
  if (!current || button.disabled) return;
  const kitchenAction = action.status !== 'collected';
  const epoch = queueEpoch;
  if (kitchenAction && (!staffKitchen(current) || !queueFresh() || kitchenTransitions.has(order.id)
    || !orders.some((item) => item.id === order.id && item.status === order.status))) return;
  if (!kitchenAction && (pickupChecks.has(order.id) || !orders.some((item) => item.id === order.id && item.status === 'ready'))) return;

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
  const pickupWrite = kitchenAction ? null : setPickupCheck(order.id, 'sending');
  if (kitchenAction) kitchenTransitions.add(order.id);
  showMessage(problem);
  try {
    const data = await request(`/orders/${encodeURIComponent(order.id)}/status`, { method: 'POST', token: current.accessToken, body });
    if (session !== current || (kitchenAction && queueEpoch !== epoch)) return;
    const updated = checkedOrder(data, true);
    if (updated.id !== order.id || updated.status !== action.status) throw new ApiError(502, 'invalid_response');

    if (!kitchenAction) {
      input.value = '';
      setPickupCheck(order.id);
      showPickupOutcome(order.id, updated.status, true);
      await refreshQueue(true);
      return;
    }
    orders = orders.map(item => item.id === updated.id && item.status === order.status ? updated : item);
    renderOrders();
    await refreshQueue(true);
  } catch (error) {
    if (session !== current || (kitchenAction && queueEpoch !== epoch)) return;
    if (error instanceof ApiError && error.status === 401) closeSession('Your staff session expired. Sign in again.');
    else if (!kitchenAction && (!(error instanceof ApiError) || error.status >= 500
      || ([404, 409].includes(error.status) && error.code !== 'pickup_code_mismatch'))) {
      input.value = '';
      await checkPickup(order.id, current);
      if (session === current) await refreshQueue(true);
    } else {
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
      } else if (pickupChecks.get(order.id) === pickupWrite) {
        setPickupCheck(order.id);
      }
      if (input && !pickupChecks.has(order.id)) input.disabled = false;
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
    [, exceptions] = await Promise.all([refreshQueue(true), readCancellationExceptions(current), refreshPaymentReview({ force: true })]);
  }
  if (session !== current || cancellation !== selection) return;

  const recorded = exceptions?.find((entry) => entry.orderId === selection.id && entry.reason === 'restaurant_cancelled');
  if (cancelledOrder || recorded) {
    orders = orders.filter((order) => order.id !== selection.id);
    rememberPickupLookupOutcome(selection.id, 'cancelled');
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
  const code = String(credentials.get('authenticatorCode') ?? '');
  element('password').value = '';
  authenticatorCode.value = '';
  authenticatorCode.disabled = true;
  showMessage(loginProblem);
  const version = ++authVersion;
  loginButton.disabled = true;
  loginButton.textContent = 'Signing in…';
  try {
    const data = await request('/sessions', { method: 'POST', body: {
      username: String(credentials.get('username') ?? '').trim(),
      password: String(credentials.get('password') ?? ''),
      ...(code ? { authenticatorCode: code } : {}),
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
    pickupLookupSection.hidden = !staffPickup(session);
    paymentReview.hidden = data.role !== 'manager';
    paymentReviewJump.hidden = paymentReview.hidden;
    fiscalReceipts.hidden = paymentReview.hidden;
    fiscalReceiptsJump.hidden = fiscalReceipts.hidden;
    delivery.show(session);
    workstationTitle.focus();
    timer = setInterval(() => { void refreshQueue(); }, queuePollMs);
    kitchenTimer = setInterval(() => {
      if (availableSession()) syncKitchenSignal();
    }, 1000);
    syncKitchenSignal();
    void refreshQueue();
    if (data.role === 'manager') {
      operationsSignals.show();
      erasureRequests.show();
      reconciliation.show();
      void refreshPendingPayments();
      void refreshPaymentReview();
      void refreshReceipts();
      availability.show();
    }
  } catch (error) {
    if (authVersion !== version) return;
    showMessage(loginProblem, error instanceof ApiError && error.status === 401
      ? 'The username, password or authenticator code was not accepted.' : messageFor(error));
    element('password').focus();
  } finally {
    authenticatorCode.value = '';
    authenticatorCode.disabled = false;
    loginButton.disabled = false;
    loginButton.textContent = 'Sign in';
  }
});

refreshButton.addEventListener('click', () => { void refreshPickupChecks(); });
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
paymentReviewOpen.addEventListener('click', () => selectPaymentReview('open'));
paymentReviewVerified.addEventListener('click', () => selectPaymentReview('verified'));
paymentReviewMore.addEventListener('click', () => { void refreshPaymentReview({ append: true }); });
pendingPaymentsRefresh.addEventListener('click', () => {
  showMessage(pendingPaymentsNotice);
  void refreshPendingPayments();
});
pendingPaymentsFirst.addEventListener('click', () => {
  showMessage(pendingPaymentsNotice);
  void refreshPendingPayments(null);
});
pendingPaymentsNext.addEventListener('click', () => {
  if (pendingPaymentsNextCursor === null) return;
  showMessage(pendingPaymentsNotice);
  void refreshPendingPayments(pendingPaymentsNextCursor);
});
fiscalReceiptsJump.addEventListener('click', () => { element('fiscal-receipts-title').focus(); });
fiscalReceiptsRefresh.addEventListener('click', () => { void (receiptLookup ? findReceipt() : refreshReceipts()); });
fiscalReceiptsFilter.addEventListener('input', () => {
  clearReceiptLookup();
  renderReceipts();
});
fiscalReceiptsSearch.addEventListener('submit', (event) => {
  event.preventDefault();
  void findReceipt();
});
pickupLookupCode.addEventListener('input', clearPickupLookup);
pickupLookupForm.addEventListener('submit', (event) => {
  event.preventDefault();
  void findPickupOrder();
});
pickupLookupOpen.addEventListener('click', () => {
  const title = pickupLookupQueueCard(queueFresh())?.querySelector('.order-title');
  if (!title) return;
  title.tabIndex = -1;
  title.focus();
});
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
