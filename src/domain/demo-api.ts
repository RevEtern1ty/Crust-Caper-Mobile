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

type DemoData = { version: 1; quotes: Quote[]; orders: SavedOrder[] }

type DemoOptions = {
  storage: Storage
  now?: () => number
  newId?: () => string
  menu?: (timestamp: number) => Menu
}

function parseData(raw: string | null): DemoData {
  if (raw === null) return { version: 1, quotes: [], orders: [] }
  const data: DemoData = JSON.parse(raw)
  if (data?.version !== 1 || !Array.isArray(data.quotes) || !Array.isArray(data.orders)) {
    throw new Error('Invalid demo storage format')
  }
  return data
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
  return typeof line.sku === 'string'
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
  return /^[A-Za-z0-9._:-]{1,128}$/.test(key)
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
  let pending: Promise<unknown> = Promise.resolve()

  function withData<T>(write: boolean, operation: (data: DemoData, timestamp: number) => T): Promise<T> {
    const result = pending.then(async () => {
      const data = parseData(await storage.getItem(DATA_KEY))
      const value = operation(data, now())
      if (write) await storage.setItem(DATA_KEY, JSON.stringify(data))
      return value
    })
    pending = result.catch(() => {})
    return result
  }

  return {
    getMenu() {
      return withData(false, (data, timestamp) => currentMenu(menu(timestamp), data, timestamp))
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
        const total = lines.reduce((amount, line) => amount + line.unitPrice * line.quantity, 0)
        const tax = Math.round((total * 18) / 118)
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
        data.quotes.push(quote)
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
        if (!quote || Date.parse(quote.expiresAt) <= timestamp) throw new ApiError('quote_expired')
        const availableMenu = currentMenu(menu(timestamp), data, timestamp)
        const slot = findAvailableSlot(availableMenu, quote.slotId)
        if (!slot) throw new ApiError('slot_unavailable')
        if (!quote.lines.length || canonicalLines(quote.lines, availableMenu).changes.length) {
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

    reorder(orderId) {
      return withData(false, (data, timestamp) => {
        const { order } = orderRecord(data, orderId)
        return canonicalLines(order.lines, menu(timestamp))
      })
    },

    setDemoPaymentResult(orderId, result) {
      return withData(true, (data, timestamp) => {
        const record = orderRecord(data, orderId)
        const { order } = record
        expireReservation(order, timestamp)
        const active = record.attempts.at(-1)?.attempt
        if (active?.status !== 'processing') throw new ApiError('conflict')
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
