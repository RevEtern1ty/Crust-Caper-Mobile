import { DEMO_PHONE } from '../domain/demo-api';
import { ApiError, type Order, type Quote, type ShopApi } from '../domain/types';

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

type Dependencies = {
  api: Pick<ShopApi, 'createOrder' | 'getOrder' | 'startPayment'>;
  storage: {
    getItem: (key: string) => Promise<string | null>;
    setItem: (key: string, value: string) => Promise<void>;
  };
  newKey: () => string;
  onOrderCreated: (cartFingerprint: string) => Promise<void>;
  allowMissingDemoOrders?: boolean;
};

export class CheckoutError extends Error {
  constructor(readonly code: 'active_checkout' | 'invalid_journal' | 'missing_checkout') {
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
  if (order.paymentStatus === 'processing') {
    return false;
  }
  return order.status === 'cancelled'
    || order.paymentStatus === 'paid'
    || order.paymentStatus === 'refund_pending'
    || order.paymentStatus === 'refunded';
}

export class CheckoutController {
  private journal = emptyJournal;
  private loaded = false;
  private running = false;

  constructor(private readonly dependencies: Dependencies) {}

  get snapshot(): CheckoutJournal {
    return this.journal;
  }

  async restore(): Promise<CheckoutJournal> {
    await this.load();
    return this.journal;
  }

  async begin(quote: Quote, cartFingerprint: string): Promise<Order> {
    return this.exclusive(async () => {
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
      return this.placeOrder(intent);
    });
  }

  async resume(retryDeclined = false): Promise<Order> {
    return this.exclusive(async () => {
      const { active } = this.journal;
      if (!active) {
        throw new CheckoutError('missing_checkout');
      }
      if (active.phase === 'creating') {
        return this.placeOrder(active);
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
        return this.startPayment(active);
      }
      if (order.paymentStatus === 'declined' && !retryDeclined) {
        return order;
      }

      const intent: Progress = {
        phase: 'paying', orderId: order.id,
        key: order.paymentStatus === 'declined' ? this.dependencies.newKey() : active.key,
      };
      await this.save(intent);
      return this.startPayment(intent);
    });
  }

  private async placeOrder(intent: Extract<Progress, { phase: 'creating' }>): Promise<Order> {
    let order: Order;
    try {
      order = await this.dependencies.api.createOrder({ quoteId: intent.quoteId, phone: DEMO_PHONE }, intent.key);
    } catch (error) {
      if (error instanceof ApiError && (error.code === 'quote_expired' || error.code === 'quote_changed'
        || error.code === 'slot_unavailable' || error.code === 'invalid_input')) {
        await this.save(null);
      }
      throw error;
    }

    const orderIds = [order.id, ...this.journal.orderIds.filter((id) => id !== order.id)].slice(0, maxRecentOrders);
    const payment = {
      phase: 'paying', orderId: order.id, key: this.dependencies.newKey(), cartFingerprint: intent.cartFingerprint,
    } as const;
    if (order.status === 'cancelled') {
      await this.save({ phase: 'tracking', orderId: order.id, key: payment.key }, orderIds);
      return order;
    }
    await this.save(payment, orderIds);
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

  private async load(): Promise<void> {
    if (!this.loaded) {
      const journal = parseJournal(await this.dependencies.storage.getItem(CHECKOUT_JOURNAL_KEY));
      if (!this.loaded) {
        this.journal = journal;
        this.loaded = true;
      }
    }
  }

  private async save(active: Progress | null, orderIds = this.journal.orderIds): Promise<void> {
    const next = { version: 1, active, orderIds } as const;
    await this.dependencies.storage.setItem(CHECKOUT_JOURNAL_KEY, JSON.stringify(next));
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
