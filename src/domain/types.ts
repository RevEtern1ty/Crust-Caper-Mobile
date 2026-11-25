export type Locale = 'en' | 'rw'
export type Localized = Record<Locale, string>
export type Category = 'burgers' | 'combos' | 'sides' | 'drinks'

export type Modifier = {
  id: string
  name: Localized
  price: number
}

export type Product = {
  sku: string
  name: Localized
  description: Localized
  ingredients: Localized[]
  allergens: Localized[]
  category: Category
  price: number
  available: boolean
  modifiers: Modifier[]
}

export type Store = {
  id: string
  name: Localized
  area: Localized
  open: boolean
  hours: Localized
  supportUrl?: string
  directionsUrl?: string
}

export type PickupSlot = {
  id: string
  startsAt: string
  endsAt: string
  available: boolean
}

export type Menu = {
  version: string
  updatedAt: string
  store: Store
  products: Product[]
  slots: PickupSlot[]
  orderingUnavailable?: true
}

export type CartLine = {
  sku: string
  modifierIds: string[]
  quantity: number
  unitPrice: number
}

export type QuoteChange = {
  kind: 'price' | 'unavailable' | 'slot'
  sku?: string
  previousPrice?: number
  currentPrice?: number
}

export type Quote = {
  id: string
  storeId: string
  slotId: string
  lines: CartLine[]
  subtotal: number
  tax: number
  total: number
  currency: 'RWF'
  expiresAt: string
  changes: QuoteChange[]
}

export type PaymentStatus =
  | 'unpaid'
  | 'processing'
  | 'paid'
  | 'declined'
  | 'refund_pending'
  | 'refunded'

export type KitchenStatus =
  | 'awaiting_payment'
  | 'accepted'
  | 'preparing'
  | 'ready'
  | 'collected'
  | 'cancelled'

export type ReceiptStatus = 'pending' | 'issued' | 'corrected'

export type PaymentAttempt = {
  id: string
  status: 'processing' | 'paid' | 'declined'
  checkoutUrl: string | null
}

export type Order = {
  id: string
  storeId: string
  slotId: string
  lines: CartLine[]
  total: number
  tax: number
  currency: 'RWF'
  paymentStatus: PaymentStatus
  status: KitchenStatus
  pickupCode: string | null
  receiptStatus: ReceiptStatus
  receiptUrl: string | null
  paymentAttempt: PaymentAttempt | null
  createdAt: string
  reservationExpiresAt: string
  pickupStartsAt: string
  pickupEndsAt: string
}

export type QuoteInput = { storeId: string; slotId: string; lines: CartLine[] }
export type OrderInput = { quoteId: string; phone: string }
export type ReorderResult = { lines: CartLine[]; changes: QuoteChange[] }

export type ApiErrorCode =
  | 'invalid_input'
  | 'not_found'
  | 'quote_expired'
  | 'quote_changed'
  | 'slot_unavailable'
  | 'conflict'
  | 'reservation_expired'
  | 'payment_pending'
  | 'storage_unavailable'

export class ApiError extends Error {
  readonly code: ApiErrorCode

  constructor(code: ApiErrorCode, options?: ErrorOptions) {
    super(code, options)
    this.name = 'ApiError'
    this.code = code
  }
}

export interface ShopApi {
  getMenu(): Promise<Menu>
  createQuote(input: QuoteInput): Promise<Quote>
  createOrder(input: OrderInput, key: string): Promise<Order>
  startPayment(orderId: string, key: string): Promise<PaymentAttempt>
  getOrder(orderId: string): Promise<Order>
  reorder(orderId: string): Promise<ReorderResult>
}

export type DemoPaymentResult = 'paid' | 'declined' | 'processing'
export type DemoKitchenStatus = 'preparing' | 'ready' | 'collected'

export interface DemoApi extends ShopApi {
  listDemoOrderRefs(limit: number): Promise<{ orderId: string; key: string }[]>
  setDemoPaymentResult(orderId: string, attemptId: string, result: DemoPaymentResult): Promise<Order>
  setDemoOrderStatus(orderId: string, status: DemoKitchenStatus): Promise<Order>
}

export interface Storage {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
}
