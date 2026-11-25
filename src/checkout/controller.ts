import { ApiError, type Order, type OrderInput, type Quote, type ShopApi } from '../domain/types';

export const CHECKOUT_JOURNAL_KEY = 'crustcaper.checkout.v1';
const maxRecentOrders = 10;

type Progress =
  | { phase: 'creating'; quoteId: string; key: string; cartFingerprint: string }
  | { phase: 'paying'; orderId: string; key: string; cartFingerprint?: string }
  | { phase: 'tracking'; orderId: string; key: string };

export type CheckoutJournal = {
  version: 1;
  active: Progress | null;
  orderIds: string[];
};

export type CheckoutContact = Pick<OrderInput, 'phone' | 'email'>;

type Dependencies = {
  api: Pick<ShopApi, 'createOrder' | 'getOrder' | 'startPayment' | 'recoverOrder'>;
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
};

export class CheckoutError extends Error {
  constructor(readonly code: 'active_checkout' | 'invalid_journal' | 'missing_checkout' | 'contact_required') {
    super(code);
  }
}

const emptyJournal: CheckoutJournal = { version: 1, active: null, orderIds: [] };

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseJournal(raw: string | null): CheckoutJournal {
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
  return order.status === 'cancelled'
    || order.paymentStatus === 'paid'
    || order.paymentStatus === 'refund_pending'
    || order.paymentStatus === 'refunded';
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

  constructor(private readonly dependencies: Dependencies) {}

  get snapshot(): CheckoutJournal {
    return this.journal;
  }

  async restore(): Promise<CheckoutJournal> {
    await this.load();
    return this.journal;
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
        if (order && (active.phase !== 'tracking' || !canStartNewOrder(order))) {
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
      if (canStartNewOrder(order) || order.paymentStatus === 'processing') {
        if (active.phase === 'paying') {
          await this.finishPayment(active, order);
        }
        return order;
      }

      if (active.phase === 'paying') {
        // Reconcile the saved attempt before interpreting a decline as permission to retry.
        const reconciled = await this.startPayment(active);
        if (!retryDeclined || reconciled.paymentStatus !== 'declined' || reconciled.status === 'cancelled') {
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

  private async continueOrder(intent: Extract<Progress, { phase: 'creating' }>, order: Order): Promise<Order> {
    const orderIds = [order.id, ...this.journal.orderIds.filter((id) => id !== order.id)].slice(0, maxRecentOrders);
    const payment = {
      phase: 'paying', orderId: order.id, key: this.dependencies.newKey(), cartFingerprint: intent.cartFingerprint,
    } as const;
    await this.save(payment, orderIds);
    if (order.status === 'cancelled' || order.paymentStatus !== 'unpaid') {
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

  private async exclusive(operation: () => Promise<Order>): Promise<Order> {
    if (this.running) {
      throw new CheckoutError('active_checkout');
    }
    this.running = true;
    try {
      await this.load();
      return await operation();
    } finally {
      this.running = false;
    }
  }
}
