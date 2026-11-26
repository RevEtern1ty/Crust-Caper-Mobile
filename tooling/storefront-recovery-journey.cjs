const { Buffer } = require('node:buffer');
const { isDeepStrictEqual } = require('node:util');
const { prepareHostedCheckout } = require('./storefront-load-journey.cjs');
const { openStaffSession } = require('./storefront-load-kitchen.cjs');

const menuPath = '/api/v1/stores/kigali/menu?channel=web&locale=en';
const receiptListPath = '/api/v1/operator/receipts';
const slotId = 'fixture-slot-0';
const paymentWaitMs = 45_000;
const identityFields = [
  'id', 'storeId', 'slotId', 'total', 'tax', 'currency', 'createdAt', 'reservationExpiresAt',
  'pickupStartsAt', 'pickupEndsAt',
];

function ensure(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}

function fixtureReceipt() {
  const text = 'BT /F1 15 Tf 36 72 Td (CrustCaper synthetic recovery test document) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 360 120] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + text.length + ' >>\nstream\n' + text + '\nendstream',
  ];
  let pdf = '%PDF-1.7\n';
  const offsets = objects.map((value, index) => {
    const offset = pdf.length;
    pdf += (index + 1) + ' 0 obj\n' + value + '\nendobj\n';
    return String(offset).padStart(10, '0') + ' 00000 n \n';
  });
  const xref = pdf.length;
  pdf += 'xref\n0 6\n0000000000 65535 f \n' + offsets.join('')
    + 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  return Buffer.from(pdf, 'ascii');
}

function verifyPaymentReplay(response, checkout, allowProcessing = false) {
  const attempt = response.data;
  ensure(response.status === 200 && attempt?.id === checkout.order.attemptId, 'recovery_replay_attempt_identity');
  if (allowProcessing && attempt.status === 'processing') {
    ensure(attempt.checkoutUrl === 'https://checkout.flutterwave.com/v3/hosted/pay/' + attempt.id,
      'recovery_replay_hosted_link');
  } else {
    ensure(attempt.status === 'paid' && attempt.checkoutUrl == null, 'recovery_replay_paid_state');
  }
}

function verifyReceiptBytes(response, document) {
  const cache = response.headers?.['cache-control']?.toLowerCase().split(/\s*,\s*/) ?? [];
  ensure(response.status === 200 && response.headers?.['content-type'] === 'application/pdf'
    && response.headers?.['x-content-type-options'] === 'nosniff'
    && /^attachment\b/i.test(response.headers?.['content-disposition'] ?? '')
    && cache.includes('no-store') && cache.includes('private') && Buffer.isBuffer(response.body)
    && response.body.equals(document), 'recovery_receipt_identity');
}

function verifyQueue(orders, expectedCheckouts) {
  ensure(orders.length === expectedCheckouts.length && expectedCheckouts.every(({ order }) => orders.some(row =>
    row.id === order.orderId && row.status === 'accepted' && row.paymentStatus === 'paid'
      && Number.isFinite(Date.parse(row.acceptedAt)))), 'recovery_queue_identity');
}

function createRecoveryJourney({ request, project, signal, fixtureMfaKey }) {
  const document = fixtureReceipt();
  let manager;
  let kitchen;
  let baselineOrder;
  let receiptRecord;
  let receiptPath;
  let a;
  let b;
  let c;
  let phase = 'initial';

  function enter(expected, next) {
    signal?.throwIfAborted();
    ensure(phase === expected, 'recovery_journey_phase');
    phase = next;
  }

  async function checkout(guest) {
    const menu = await request(menuPath);
    ensure(menu.status === 200 && menu.data?.store?.id === 'kigali'
      && Array.isArray(menu.data.products) && Array.isArray(menu.data.slots), 'recovery_menu_unavailable');
    return prepareHostedCheckout({ request, menu: menu.data, slotId, guest, signal, paymentWaitMs });
  }

  async function verifyManagerReceipt() {
    const receipts = await manager.request(receiptListPath);
    ensure(receipts.status === 200 && Array.isArray(receipts.data)
      && receipts.data.some(row => isDeepStrictEqual(row, receiptRecord)), 'recovery_manager_receipt_identity');
  }

  async function verifyGuest(checkout) {
    const response = await request('/api/v1/web/session', { headers: checkout.guest });
    ensure(response.status === 200 && response.data?.sessionId === checkout.guest['X-CrustCaper-Session'],
      'recovery_guest_session_identity');
  }

  return {
    async seed() {
      enter('initial', 'seeding');
      manager = await openStaffSession({ request, project, role: 'manager', fixtureMfaKey });
      kitchen = await openStaffSession({ request, project, role: 'kitchen', fixtureMfaKey });
      verifyQueue(await kitchen.readQueue(), []);
      a = await checkout();
      await a.settleHosted();
      await a.waitForPaid();
      const reference = 'RECOVERY-' + a.order.orderId.slice(-8).toUpperCase();
      const attached = await manager.request('/api/v1/operator/orders/' + a.order.orderId + '/receipt', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/pdf', 'X-Receipt-Reference': reference,
          'X-Receipt-Total-RWF': String(a.order.total) },
        body: document,
      });
      ensure(attached.status === 200 && attached.data?.orderId === a.order.orderId
        && attached.data.total === a.order.total && attached.data.receiptReference === reference
        && attached.data.currency === 'RWF' && attached.data.receiptStatus === 'issued', 'recovery_receipt_attach');
      receiptRecord = attached.data;
      receiptPath = '/api/v1/web/orders/' + a.order.orderId + '/receipt';
      const saved = await a.readOrder();
      ensure(saved.status === 200 && saved.data?.id === a.order.orderId && saved.data.paymentStatus === 'paid'
        && saved.data.receiptStatus === 'issued' && saved.data.receiptUrl === receiptPath
        && saved.data.paymentAttempt?.id === a.order.attemptId, 'recovery_paid_order_baseline');
      baselineOrder = saved.data;
      verifyReceiptBytes(await request(receiptPath, { headers: a.guest, binary: true }), document);
      b = await checkout();
      ensure(a.order.orderId !== b.order.orderId && a.order.attemptId !== b.order.attemptId, 'recovery_baseline_distinct');
      await verifyManagerReceipt();
      verifyQueue(await kitchen.readQueue(), [a]);
      phase = 'seeded';
      return { paidOrders: 1, paymentAttempts: 2, pendingAttempts: 1, attachedReceipts: 1,
        managerSessionAuthenticated: true, kitchenSessionAuthenticated: true };
    },

    async commitAfterSnapshot() {
      enter('seeded', 'committing');
      await verifyGuest(b);
      c = await checkout(b.guest);
      ensure(c.order.orderId !== b.order.orderId && c.order.orderId !== a.order.orderId
        && c.order.attemptId !== b.order.attemptId && c.order.attemptId !== a.order.attemptId,
      'recovery_post_snapshot_distinct');
      phase = 'committed';
      return { postSnapshotOrders: 1, pendingAttempts: 2, retainedGuestBinding: true };
    },

    async markPendingPaid() {
      enter('committed', 'settling');
      await b.settleHosted();
      await c.settleHosted();
      phase = 'settled';
      return { settledWithoutApi: 2, postSnapshotProviderPayments: 1 };
    },

    async verifyRecovered() {
      enter('settled', 'verifying');
      await Promise.all([verifyGuest(a), verifyGuest(b), verifyManagerReceipt()]);
      const [restored, missing, missingReplay, denied, signInRequired, forbidden] = await Promise.all([
        a.readOrder(), c.readOrder(), c.recoverOrder(),
        request(receiptPath, { headers: b.guest }),
        request(receiptPath),
        kitchen.request(receiptListPath),
      ]);
      ensure(restored.status === 200 && isDeepStrictEqual(restored.data, baselineOrder),
        'recovery_paid_order_identity');
      ensure(missing.status === 404 && missing.data?.code === 'not_found'
        && missingReplay.status === 404 && missingReplay.data?.code === 'not_found', 'recovery_snapshot_cut');
      ensure(denied.status === 404 && denied.data?.code === 'not_found'
        && signInRequired.status === 401 && signInRequired.data?.code === 'unauthenticated'
        && forbidden.status === 403 && forbidden.data?.code === 'forbidden', 'recovery_receipt_access_scope');
      verifyReceiptBytes(await request(receiptPath, { headers: a.guest, binary: true }), document);
      verifyPaymentReplay(await a.repeatPayment(), a);
      verifyPaymentReplay(await b.repeatPayment(), b, true);
      const paid = await b.waitForPaid();
      ensure(identityFields.every(field => paid[field] === b.placed[field])
        && isDeepStrictEqual(paid.lines, b.placed.lines), 'recovery_pending_order_identity');
      verifyPaymentReplay(await b.repeatPayment(), b);
      verifyQueue(await kitchen.readQueue(), [a, b]);
      phase = 'verified';
      return { restoredPaidOrders: 2, restoredGuestSessions: 2, restoredStaffSessions: 2,
        restoredReceiptByteIdentical: true, restoredReceiptAccessScoped: true, originalPaymentAttemptsRetained: true,
        postSnapshotOrdersAbsent: 1, externalPaymentsRequiringReconciliation: 1 };
    },

    async verifyNewOrder() {
      enter('verified', 'opening_new');
      const d = await checkout();
      const all = [a, b, c, d];
      ensure(new Set(all.map(({ order }) => order.orderId)).size === all.length
        && new Set(all.map(({ order }) => order.attemptId)).size === all.length, 'recovery_new_order_distinct');
      await d.settleHosted();
      await d.waitForPaid();
      verifyQueue(await kitchen.readQueue(), [a, b, d]);
      phase = 'complete';
      return { newPaidOrders: 1, paidOrdersInKitchen: 3 };
    },

    async close() {
      const sessions = [manager, kitchen].filter(Boolean);
      manager = kitchen = undefined;
      if (signal?.aborted) return;
      const closed = await Promise.allSettled(sessions.map(session => session.close()));
      ensure(closed.every(result => result.status === 'fulfilled'), 'recovery_staff_session_cleanup');
    },
  };
}

module.exports = { createRecoveryJourney };
