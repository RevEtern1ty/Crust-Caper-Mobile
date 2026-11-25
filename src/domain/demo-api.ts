import { createDemoMenu } from './demo-menu'
import { ApiError } from './types'
import type {
  CartLine,
  DemoApi,
  DemoKitchenStatus,
  Menu,
  Order,
  PaymentAttempt,
  PickupSlot,
  Quote,
  QuoteChange,
  ReorderResult,
  Storage,
} from './types'

export const DEMO_PHONE = '+250700000000'
const DATA_KEY = 'crustcaper.demo.v1'
const QUOTE_LIFETIME = 5 * 60_000
const RESERVATION_LIFETIME = 10 * 60_000
const SLOT_CAPACITY = 2
const ledgerQueues = new WeakMap<Storage, Promise<unknown>>()
const KITCHEN_PREDECESSOR: Record<DemoKitchenStatus, Order['status']> = {
  preparing: 'accepted',
  ready: 'preparing',
  collected: 'ready',
}

type SavedOrder = {
  order: Order
  quoteId: string
  key: string
  attempts: { key: string; attempt: PaymentAttempt }[]
}

type SavedQuote = Quote & { pickupStartsAt?: string; pickupEndsAt?: string }
type DemoData = { version: 1; quotes: SavedQuote[]; orders: SavedOrder[] }

type DemoOptions = {
  storage: Storage
  now?: () => number
  newId?: () => string
  menu?: (timestamp: number) => Menu
}

function parseData(raw: string | null): DemoData {
  if (raw === null) return { version: 1, quotes: [], orders: [] }
  const data = JSON.parse(raw) as Partial<DemoData> | null
  if (data?.version !== 1
    || !Array.isArray(data.quotes) || !data.quotes.every(validSavedQuote)
    || !Array.isArray(data.orders) || !data.orders.every(validSavedOrder)) {
    throw new Error('Invalid demo storage format')
  }
  return { ...data, version: data.version, quotes: data.quotes, orders: data.orders }
}

function orderRecord(data: DemoData, id: string): SavedOrder {
  const record = data.orders.find(({ order }) => order.id === id)
  if (!record) throw new ApiError('not_found')
  return record
}

function canonicalLines(lines: CartLine[], menu: Menu): ReorderResult {
  const changes: QuoteChange[] = []
  const currentLines = []
  for (const line of lines) {
    const product = menu.products.find(({ sku }) => sku === line.sku)
    const selected = new Set(line.modifierIds)
    const modifiers = product?.modifiers.filter(({ id }) => selected.has(id))
    if (!product?.available || modifiers?.length !== selected.size) {
      changes.push({ kind: 'unavailable', sku: line.sku })
      continue
    }
    const unitPrice = product.price + modifiers.reduce((total, modifier) => total + modifier.price, 0)
    if (unitPrice !== line.unitPrice) {
      changes.push({ kind: 'price', sku: line.sku, previousPrice: line.unitPrice, currentPrice: unitPrice })
    }
    currentLines.push({ ...line, modifierIds: modifiers.map(({ id }) => id), unitPrice })
  }
  return { lines: currentLines, changes }
}

function validQuoteLine(line: CartLine): boolean {
  return line != null
    && typeof line.sku === 'string'
    && line.sku.length > 0
    && Number.isSafeInteger(line.unitPrice)
    && line.unitPrice >= 0
    && Number.isInteger(line.quantity)
    && line.quantity > 0
    && line.quantity <= 99
    && Array.isArray(line.modifierIds)
    && line.modifierIds.every((id) => typeof id === 'string')
    && new Set(line.modifierIds).size === line.modifierIds.length
}

function validKey(key: string): boolean {
  return typeof key === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(key)
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function includedTax(total: number): number {
  // Split the quotient before multiplying to preserve integer precision for every valid total.
  return Math.floor(total / 118) * 18 + Math.round((total % 118) * 18 / 118)
}

function totalAmount(lines: CartLine[]): number {
  return lines.reduce((amount, line) => amount + line.unitPrice * line.quantity, 0)
}

function validAmounts(lines: CartLine[], total: number, tax: number): boolean {
  return Number.isSafeInteger(total) && total >= 0
    && total === totalAmount(lines) && tax === includedTax(total)
}

function validSavedQuote(quote: SavedQuote): boolean {
  return quote != null
    && typeof quote.id === 'string'
    && typeof quote.storeId === 'string'
    && typeof quote.slotId === 'string'
    && validTimestamp(quote.expiresAt)
    && Array.isArray(quote.lines) && quote.lines.every(validQuoteLine)
    && Array.isArray(quote.changes)
    && validAmounts(quote.lines, quote.total, quote.tax) && quote.subtotal === quote.total - quote.tax
    && quote.currency === 'RWF'
    && ((quote.pickupStartsAt === undefined && quote.pickupEndsAt === undefined)
      || (validTimestamp(quote.pickupStartsAt) && validTimestamp(quote.pickupEndsAt)))
}

function validAttempt(attempt: PaymentAttempt): boolean {
  return attempt != null
    && typeof attempt.id === 'string'
    && ['processing', 'paid', 'declined'].includes(attempt.status)
    && attempt.checkoutUrl === null
}

function validSavedOrder(record: SavedOrder): boolean {
  const order = record?.order
  return order != null
    && validKey(record.key)
    && typeof record.quoteId === 'string'
    && typeof order.id === 'string'
    && typeof order.storeId === 'string'
    && typeof order.slotId === 'string'
    && ['awaiting_payment', 'accepted', 'preparing', 'ready', 'collected', 'cancelled'].includes(order.status)
    && ['unpaid', 'processing', 'paid', 'declined', 'refund_pending', 'refunded'].includes(order.paymentStatus)
    && Array.isArray(order.lines) && order.lines.every(validQuoteLine)
    && validAmounts(order.lines, order.total, order.tax)
    && order.currency === 'RWF'
    && (order.pickupCode === null || typeof order.pickupCode === 'string')
    && ['pending', 'issued', 'corrected'].includes(order.receiptStatus)
    && (order.receiptUrl === null || typeof order.receiptUrl === 'string')
    && validTimestamp(order.createdAt)
    && validTimestamp(order.reservationExpiresAt)
    && validTimestamp(order.pickupStartsAt)
    && validTimestamp(order.pickupEndsAt)
    && (order.paymentAttempt === null || validAttempt(order.paymentAttempt))
    && Array.isArray(record.attempts)
    && record.attempts.every((entry) => entry != null && validKey(entry.key) && validAttempt(entry.attempt))
}

function expireReservation(order: Order, now: number): void {
  if (order.status === 'awaiting_payment' && Date.parse(order.reservationExpiresAt) <= now) {
    order.status = 'cancelled'
  }
}

function findAvailableSlot(menu: Menu, slotId: string): PickupSlot | undefined {
  return menu.slots.find(({ id, available }) => id === slotId && available)
}

function currentMenu(menu: Menu, data: DemoData, now: number): Menu {
  return {
    ...menu,
    slots: menu.slots.map((slot) => {
      const reservedCount = data.orders.filter(({ order }) =>
        order.slotId === slot.id
        && order.status !== 'cancelled'
        && (order.status !== 'awaiting_payment' || Date.parse(order.reservationExpiresAt) > now)
      ).length
      return {
        ...slot,
        available: slot.available && menu.store.open && reservedCount < SLOT_CAPACITY
          && Date.parse(slot.startsAt) > now,
      }
    }),
  }
}

export function createDemoApi({
  storage,
  now = Date.now,
  newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`,
  menu = createDemoMenu,
}: DemoOptions): DemoApi {
  function withData<T>(write: boolean, operation: (data: DemoData, timestamp: number) => T): Promise<T> {
    // API instances backed by the same adapter share one serialized ledger.
    const previous = ledgerQueues.get(storage) ?? Promise.resolve()
    const result = previous.then(async () => {
      let data: DemoData
      try {
        data = parseData(await storage.getItem(DATA_KEY))
      } catch {
        throw new ApiError('storage_unavailable')
      }
      const value = operation(data, now())
      if (write) {
        try {
          await storage.setItem(DATA_KEY, JSON.stringify(data))
        } catch (error) {
          throw new ApiError('storage_unavailable', { cause: error })
        }
      }
      return value
    })
    ledgerQueues.set(storage, result.catch(() => {}))
    return result
  }

  return {
    async getMenu() {
      try {
        return await withData(false, (data, timestamp) => currentMenu(menu(timestamp), data, timestamp))
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'storage_unavailable') throw error
        const catalog = menu(now())
        return {
          ...catalog,
          slots: catalog.slots.map((slot) => ({ ...slot, available: false })),
          orderingUnavailable: true,
        }
      }
    },

    createQuote(input) {
      return withData(true, (data, timestamp) => {
        const availableMenu = currentMenu(menu(timestamp), data, timestamp)
        if (input.storeId !== availableMenu.store.id
          || !input.lines.length
          || input.lines.length > 50
          || !input.lines.every(validQuoteLine)) {
          throw new ApiError('invalid_input')
        }
        const slot = findAvailableSlot(availableMenu, input.slotId)
        if (!slot) throw new ApiError('slot_unavailable')
        const { lines, changes } = canonicalLines(input.lines, availableMenu)
        const total = totalAmount(lines)
        if (!Number.isSafeInteger(total) || total < 0 || !lines.every(validQuoteLine)) {
          throw new ApiError('invalid_input')
        }
        const tax = includedTax(total)
        const quote: Quote = {
          id: newId(),
          storeId: input.storeId,
          slotId: slot.id,
          lines,
          subtotal: total - tax,
          tax,
          total,
          currency: 'RWF',
          expiresAt: new Date(Math.min(timestamp + QUOTE_LIFETIME, Date.parse(slot.startsAt))).toISOString(),
          changes,
        }
        // Recorded orders retain the original quote ID for idempotent replays.
        data.quotes = data.quotes.filter(({ expiresAt }) => Date.parse(expiresAt) > timestamp)
        data.quotes.push({ ...quote, pickupStartsAt: slot.startsAt, pickupEndsAt: slot.endsAt })
        return quote
      })
    },

    createOrder({ quoteId, phone }, key) {
      return withData(true, (data, timestamp) => {
        if (!validKey(key) || phone.replace(/\s/g, '') !== DEMO_PHONE) throw new ApiError('invalid_input')
        const existing = data.orders.find((record) => record.key === key)
        if (existing) {
          if (existing.quoteId !== quoteId) throw new ApiError('conflict')
          expireReservation(existing.order, timestamp)
          return existing.order
        }
        if (data.orders.some((record) => record.quoteId === quoteId)) throw new ApiError('conflict')

        const quote = data.quotes.find(({ id }) => id === quoteId)
        // An old, unused quote cannot prove which pickup window the customer reviewed.
        if (!quote?.pickupStartsAt || !quote.pickupEndsAt || Date.parse(quote.expiresAt) <= timestamp) {
          throw new ApiError('quote_expired')
        }
        const availableMenu = currentMenu(menu(timestamp), data, timestamp)
        const slot = findAvailableSlot(availableMenu, quote.slotId)
        if (!slot) throw new ApiError('slot_unavailable')
        if (Date.parse(quote.pickupStartsAt) !== Date.parse(slot.startsAt)
          || Date.parse(quote.pickupEndsAt) !== Date.parse(slot.endsAt)
          || !quote.lines.length || canonicalLines(quote.lines, availableMenu).changes.length) {
          throw new ApiError('quote_changed')
        }
        const order: Order = {
          id: newId(),
          storeId: quote.storeId,
          slotId: quote.slotId,
          lines: quote.lines,
          total: quote.total,
          tax: quote.tax,
          currency: quote.currency,
          paymentStatus: 'unpaid',
          status: 'awaiting_payment',
          pickupCode: null,
          receiptStatus: 'pending',
          receiptUrl: null,
          paymentAttempt: null,
          createdAt: new Date(timestamp).toISOString(),
          reservationExpiresAt: new Date(
            Math.min(timestamp + RESERVATION_LIFETIME, Date.parse(slot.startsAt)),
          ).toISOString(),
          pickupStartsAt: slot.startsAt,
          pickupEndsAt: slot.endsAt,
        }
        data.orders.push({ order, quoteId, key, attempts: [] })
        return order
      })
    },

    startPayment(orderId, key) {
      return withData(true, (data, timestamp) => {
        if (!validKey(key)) throw new ApiError('invalid_input')
        const record = orderRecord(data, orderId)
        const existing = record.attempts.find((entry) => entry.key === key)
        if (existing) return existing.attempt
        expireReservation(record.order, timestamp)
        if (record.order.status === 'cancelled') throw new ApiError('reservation_expired')
        if (record.order.paymentStatus === 'processing') throw new ApiError('payment_pending')
        if (record.order.status !== 'awaiting_payment') throw new ApiError('conflict')

        const attempt: PaymentAttempt = { id: newId(), status: 'processing', checkoutUrl: null }
        record.attempts.push({ key, attempt })
        record.order.paymentAttempt = attempt
        record.order.paymentStatus = 'processing'
        return attempt
      })
    },

    getOrder(orderId) {
      return withData(false, (data, timestamp) => {
        const { order } = orderRecord(data, orderId)
        expireReservation(order, timestamp)
        return order
      })
    },

    listDemoOrderRefs(limit) {
      return withData(false, (data) => data.orders.slice(Math.max(0, data.orders.length - limit)).reverse().map((record) => ({
        orderId: record.order.id,
        key: record.attempts.at(-1)?.key ?? record.key,
      })))
    },

    reorder(orderId) {
      return withData(false, (data, timestamp) => {
        const { order } = orderRecord(data, orderId)
        return canonicalLines(order.lines, menu(timestamp))
      })
    },

    setDemoPaymentResult(orderId, attemptId, result) {
      return withData(true, (data, timestamp) => {
        const record = orderRecord(data, orderId)
        const { order } = record
        expireReservation(order, timestamp)
        const active = record.attempts.at(-1)?.attempt
        if (active?.id !== attemptId) throw new ApiError('conflict')
        if (active.status === result) return order
        if (active.status !== 'processing') throw new ApiError('conflict')
        active.status = result
        order.paymentAttempt = active
        order.paymentStatus = result
        if (result === 'paid') {
          if (order.status === 'cancelled') {
            order.paymentStatus = 'refund_pending'
          } else {
            order.status = 'accepted'
            order.pickupCode = String(1000 + (data.orders.indexOf(record) % 9000))
          }
        }
        return order
      })
    },

    setDemoOrderStatus(orderId, status) {
      return withData(true, (data) => {
        const { order } = orderRecord(data, orderId)
        if (order.status === status) return order
        if (order.paymentStatus !== 'paid' || order.status !== KITCHEN_PREDECESSOR[status]) {
          throw new ApiError('conflict')
        }
        order.status = status
        return order
      })
    },
  }
}
