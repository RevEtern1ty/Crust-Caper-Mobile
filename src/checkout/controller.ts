import { ApiError, type Order, type OrderInput, type PendingCheckoutRecovery, type Quote, type ShopApi } from '../domain/types';
import { paymentReturnOrderId } from './payment-return';
import { hasInconsistentPayment, isExpiredUnpaidHold } from './pickup-hold';

export const CHECKOUT_JOURNAL_KEY = 'crustcaper.checkout.v1';
const maxRecentOrders = 10;

type Progress =
  | { phase: 'creating'; quoteId: string; key: string; cartFingerprint: string; recoveryChallengeId?: string }
  | { phase: 'paying'; orderId: string; key: string; cartFingerprint?: string }
  | { phase: 'tracking'; orderId: string; key: string };

export type CheckoutJournal = {
  version: 1;
  active: Progress | null;
  orderIds: string[];
};

export type CheckoutContact = Pick<OrderInput, 'phone' | 'email'>;

export type GuestSessionLifecycle = {
  end: () => Promise<void>;
  hasEndPending: () => Promise<boolean>;
};

type Dependencies = {
  api: Pick<ShopApi, 'createOrder' | 'getOrder' | 'startPayment' | 'recoverOrder'
    | 'requestPendingCheckoutRecovery' | 'verifyPendingCheckoutRecovery'>;
  storage: {
    getItem: (key: string) => Promise<string | null>;
    setItem: (key: string, value: string) => Promise<void>;
  };
  newKey: () => string;
  onOrderCreated: (cartFingerprint: string) => Promise<void>;
  storageKey?: string;
  demoContact?: CheckoutContact;
  allowMissingDemoOrders?: boolean;
  listDemoOrderRefs?: (limit: number) => Promise<{ orderId: string; key: string }[]>;
  guestSession?: GuestSessionLifecycle;
};

export class CheckoutError extends Error {
  constructor(readonly code: 'active_checkout' | 'invalid_journal' | 'missing_checkout' | 'contact_required' | 'session_end_pending') {
    super(code);
  }
}

const emptyJournal: CheckoutJournal = { version: 1, active: null, orderIds: [] };

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function parseJournal(raw: string | null): CheckoutJournal {
  if (raw === null) {
    return emptyJournal;
  }

  try {
    const stored = JSON.parse(raw) as Partial<CheckoutJournal> | null;
    if (stored?.version !== 1 || !Array.isArray(stored.orderIds) || !stored.orderIds.every(isText)) {
      throw new CheckoutError('invalid_journal');
    }

    const active = stored.active;
    if (active === null) {
      return { version: 1, active, orderIds: stored.orderIds };
    }
    if (active?.phase === 'creating' && isText(active.quoteId) && isText(active.key) && isText(active.cartFingerprint)) {
      if (active.recoveryChallengeId !== undefined && !paymentReturnOrderId(active.recoveryChallengeId)) {
        throw new CheckoutError('invalid_journal');
      }
      return { version: 1, active, orderIds: stored.orderIds };
    }
    if (active && (active.phase === 'paying' || active.phase === 'tracking')
      && isText(active.orderId) && isText(active.key) && stored.orderIds.includes(active.orderId)) {
      if (active.phase === 'paying' && active.cartFingerprint !== undefined && !isText(active.cartFingerprint)) {
        throw new CheckoutError('invalid_journal');
      }
      return { version: 1, active, orderIds: stored.orderIds };
    }
  } catch {
    throw new CheckoutError('invalid_journal');
  }
  throw new CheckoutError('invalid_journal');
}

export function canStartNewOrder(order: Order): boolean {
  return !hasInconsistentPayment(order) && (order.status === 'cancelled'
    || order.paymentStatus === 'paid'
    || order.paymentStatus === 'refund_pending'
    || order.paymentStatus === 'refunded');
}

export function hasSavedCheckout(raw: string | null): boolean {
  try {
    const { active, orderIds } = parseJournal(raw);
    return active !== null || orderIds.length > 0;
  } catch {
    // A corrupt or unrecognised journal cannot prove that the previous identity is unused.
    return true;
  }
}

export class CheckoutController {
  private journal = emptyJournal;
  private loaded = false;
  private loading: Promise<void> | null = null;
  private running = false;
  private endPending = false;
  private revision = 0;

  constructor(private readonly dependencies: Dependencies) {}

  get snapshot(): CheckoutJournal {
    return this.endPending ? emptyJournal : this.journal;
  }

  get guestSessionEndPending(): boolean {
    return this.endPending;
  }

  get guestSessionRevision(): number {
    return this.revision;
  }

  async restore(): Promise<CheckoutJournal> {
    await this.load();
    return this.snapshot;
  }

  async rememberRecoveredOrder(orderId: string, sessionRevision = this.revision): Promise<void> {
    if (!paymentReturnOrderId(orderId)) throw new ApiError('invalid_response');

    await this.exclusive(async () => {
      if (sessionRevision !== this.revision) throw new ApiError('unauthenticated');
      const { active, orderIds } = this.journal;
      if (orderIds.includes(orderId)) return;

      const retained = orderIds.slice(0, maxRecentOrders - 1);
      if (active && active.phase !== 'creating' && !retained.includes(active.orderId)) {
        retained[retained.length - 1] = active.orderId;
      }
      await this.save(active, [...retained, orderId]);
    });
  }

  async requestPendingOrderRecovery(phone: string): Promise<PendingCheckoutRecovery> {
    return this.exclusive(async () => {
      const { active } = this.journal;
      if (active?.phase !== 'creating') throw new CheckoutError('missing_checkout');
      const request = this.dependencies.api.requestPendingCheckoutRecovery;
      if (!request) throw new ApiError('service_unavailable');

      const result = await request(active, phone);
      if (result.state === 'not_placed') await this.save(null);
      if (result.state === 'verify') await this.save({ ...active, recoveryChallengeId: result.challengeId });
      return result;
    });
  }

  async confirmPendingOrderRecovery(challengeId: string, code: string): Promise<Order> {
    return this.exclusive(async () => {
      const { active } = this.journal;
      if (active?.phase !== 'creating' || active.recoveryChallengeId !== challengeId) {
        throw new CheckoutError('missing_checkout');
      }
      const verify = this.dependencies.api.verifyPendingCheckoutRecovery;
      if (!verify) throw new ApiError('service_unavailable');

      const order = await verify(active, challengeId, code);
      if (!paymentReturnOrderId(order.id) || order.recoveryReadOnly) throw new ApiError('invalid_response');
      if (canStartNewOrder(order)) {
        if (order.status !== 'cancelled') await this.dependencies.onOrderCreated(active.cartFingerprint);
        await this.save({ phase: 'tracking', orderId: order.id, key: this.dependencies.newKey() }, this.recentOrderIds(order.id));
      } else {
        await this.saveCreatedOrder(active, order);
      }
      return order;
    });
  }

  async endGuestSession(): Promise<void> {
    const lifecycle = this.dependencies.guestSession;
    if (!lifecycle) throw new ApiError('service_unavailable');

    await this.exclusive(async () => {
      if (!this.endPending) {
        const { active, orderIds } = this.journal;
        if (active?.phase === 'creating') throw new CheckoutError('active_checkout');
        await Promise.all(orderIds.map(async orderId => {
          const order = await this.dependencies.api.getOrder(orderId).catch(error => {
            if (error instanceof ApiError && (error.code === 'unauthenticated' || error.code === 'not_found')) return null;
            throw error;
          });
          const unresolved = order
            ? hasInconsistentPayment(order) || order.paymentStatus === 'processing'
              || (order.status !== 'collected' && order.status !== 'cancelled')
            : active?.phase === 'paying' && active.orderId === orderId;
          if (unresolved) {
            throw new CheckoutError('active_checkout');
          }
        }));
      }

      try {
        await lifecycle.end();
      } catch (error) {
        this.endPending = await lifecycle.hasEndPending().catch(() => true);
        if (this.endPending) this.revision++;
        throw error;
      }
      this.journal = emptyJournal;
      this.endPending = false;
      this.revision++;
    }, true);
  }

  async begin(quote: Quote, cartFingerprint: string, contact = this.dependencies.demoContact): Promise<Order> {
    return this.exclusive(async () => {
      if (!contact) throw new CheckoutError('contact_required');

      const { active } = this.journal;
      if (active?.phase === 'creating') {
        throw new CheckoutError('active_checkout');
      }
      if (active) {
        const order = await this.getTrackedOrder(active.orderId);
        if (order && (order.recoveryReadOnly || active.phase !== 'tracking' || !canStartNewOrder(order))) {
          throw new CheckoutError('active_checkout');
        }
      }

      const intent: Progress = {
        phase: 'creating', quoteId: quote.id, key: this.dependencies.newKey(), cartFingerprint,
      };
      await this.save(intent);
      return this.placeOrder(intent, contact);
    });
  }

  async resume(retryDeclined = false, contact = this.dependencies.demoContact): Promise<Order> {
    return this.exclusive(async () => {
      const { active } = this.journal;
      if (!active) {
        throw new CheckoutError('missing_checkout');
      }
      if (active.phase === 'creating') {
        const committed = await this.dependencies.api.recoverOrder?.(active.key);
        return committed ? this.continueOrder(active, committed) : this.placeOrder(active, contact);
      }

      const order = await this.getTrackedOrder(active.orderId);
      if (!order) throw new ApiError('not_found');
      if (order.recoveryReadOnly || hasInconsistentPayment(order)) return order;
      if (canStartNewOrder(order) || order.paymentStatus === 'processing') {
        if (active.phase === 'paying') {
          await this.finishPayment(active, order);
        }
        return order;
      }

      if (active.phase === 'paying') {
        // Reconcile the saved attempt before interpreting a decline as permission to retry.
        const reconciled = await this.startPayment(active);
        if (!retryDeclined || reconciled.paymentStatus !== 'declined' || reconciled.status === 'cancelled'
          || hasInconsistentPayment(reconciled)) {
          return reconciled;
        }
        return this.retryDeclinedPayment(reconciled.id);
      }
      if (order.paymentStatus === 'declined') {
        return retryDeclined ? this.retryDeclinedPayment(order.id) : order;
      }

      const intent: Progress = {
        phase: 'paying', orderId: order.id,
        key: active.key,
      };
      await this.save(intent);
      return this.startPayment(intent);
    });
  }

  async finishExpiredHold(order: Order): Promise<void> {
    await this.exclusive(async () => {
      const active = this.journal.active;
      if (active?.phase !== 'paying' || active.orderId !== order.id || order.recoveryReadOnly || !isExpiredUnpaidHold(order)) return;
      await this.track(active);
    });
  }

  private async retryDeclinedPayment(orderId: string): Promise<Order> {
    const intent = { phase: 'paying', orderId, key: this.dependencies.newKey() } as const;
    await this.save(intent);
    return this.startPayment(intent);
  }

  private async placeOrder(intent: Extract<Progress, { phase: 'creating' }>, contact?: CheckoutContact): Promise<Order> {
    if (!contact) throw new CheckoutError('contact_required');

    let order: Order;
    try {
      order = await this.dependencies.api.createOrder({ quoteId: intent.quoteId, phone: contact.phone, email: contact.email }, intent.key);
    } catch (error) {
      if (error instanceof ApiError && (error.code === 'quote_expired' || error.code === 'quote_changed'
        || error.code === 'slot_unavailable' || error.code === 'invalid_input')) {
        await this.save(null);
      }
      throw error;
    }

    return this.continueOrder(intent, order);
  }

  private async saveCreatedOrder(intent: Extract<Progress, { phase: 'creating' }>, order: Order) {
    const payment = {
      phase: 'paying', orderId: order.id, key: this.dependencies.newKey(), cartFingerprint: intent.cartFingerprint,
    } as const;
    await this.save(payment, this.recentOrderIds(order.id));
    return payment;
  }

  private recentOrderIds(orderId: string) {
    return [orderId, ...this.journal.orderIds.filter((id) => id !== orderId)].slice(0, maxRecentOrders);
  }

  private async continueOrder(intent: Extract<Progress, { phase: 'creating' }>, order: Order): Promise<Order> {
    const payment = await this.saveCreatedOrder(intent, order);
    if (order.status === 'cancelled' || order.paymentStatus !== 'unpaid' || hasInconsistentPayment(order)) {
      await this.finishPayment(payment, order);
      return order;
    }
    return this.startPayment(payment);
  }

  private async startPayment(intent: Extract<Progress, { phase: 'paying' }>): Promise<Order> {
    try {
      await this.dependencies.api.startPayment(intent.orderId, intent.key);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'reservation_expired') {
        await this.track(intent);
      }
      throw error;
    }
    const order = await this.dependencies.api.getOrder(intent.orderId);
    await this.finishPayment(intent, order);
    return order;
  }

  private async finishPayment(intent: Extract<Progress, { phase: 'paying' }>, order: Order) {
    if (hasInconsistentPayment(order)) return;
    if (intent.cartFingerprint && order.status !== 'cancelled') {
      await this.dependencies.onOrderCreated(intent.cartFingerprint);
    }
    await this.track(intent);
  }

  private async getTrackedOrder(orderId: string): Promise<Order | null> {
    try {
      return await this.dependencies.api.getOrder(orderId);
    } catch (error) {
      // Demo records and the secure journal have different storage lifecycles.
      if (this.dependencies.allowMissingDemoOrders && error instanceof ApiError && error.code === 'not_found') {
        await this.save(null, this.journal.orderIds.filter((id) => id !== orderId));
        return null;
      }
      throw error;
    }
  }

  private async track({ orderId, key }: Extract<Progress, { phase: 'paying' }>) {
    await this.save({ phase: 'tracking', orderId, key });
  }

  private load(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    this.loading ??= this.readJournal().finally(() => { this.loading = null; });
    return this.loading;
  }

  private async readJournal(): Promise<void> {
    if (await this.dependencies.guestSession?.hasEndPending()) {
      this.endPending = true;
      this.loaded = true;
      return;
    }
    const raw = await this.dependencies.storage.getItem(this.dependencies.storageKey ?? CHECKOUT_JOURNAL_KEY);
    const listDemoOrderRefs = this.dependencies.allowMissingDemoOrders
      ? this.dependencies.listDemoOrderRefs : undefined;
    if (raw === null && listDemoOrderRefs) {
      await this.recoverDemoJournal(await listDemoOrderRefs(maxRecentOrders), false);
    } else {
      try {
        this.journal = parseJournal(raw);
      } catch (error) {
        if (!listDemoOrderRefs) throw error;

        await this.recoverDemoJournal(await listDemoOrderRefs(maxRecentOrders), true);
      }
    }
    this.loaded = true;
  }

  private async recoverDemoJournal(orders: { orderId: string; key: string }[], replaceMalformed: boolean): Promise<void> {
    // A readable demo ledger can recover committed orders without clearing the cart.
    const latest = orders[0];
    if (latest) {
      await this.save(
        { phase: 'tracking', orderId: latest.orderId, key: latest.key },
        orders.map(({ orderId }) => orderId),
      );
    } else if (replaceMalformed) {
      await this.save(null);
    }
  }

  private async save(active: Progress | null, orderIds = this.journal.orderIds): Promise<void> {
    const next = { version: 1, active, orderIds } as const;
    await this.dependencies.storage.setItem(this.dependencies.storageKey ?? CHECKOUT_JOURNAL_KEY, JSON.stringify(next));
    this.journal = next;
  }

  private async exclusive<Result>(operation: () => Promise<Result>, allowSessionEnd = false): Promise<Result> {
    if (this.running) {
      throw new CheckoutError('active_checkout');
    }
    this.running = true;
    try {
      await this.load();
      if (this.endPending && !allowSessionEnd) throw new CheckoutError('session_end_pending');
      return await operation();
    } finally {
      this.running = false;
    }
  }
}
