import { deepEqual, equal, match, ok, rejects } from 'node:assert/strict'
import { test } from 'node:test'
import { createDemoApi, DEMO_PHONE } from './demo-api'
import { createDemoMenu } from './demo-menu'
import type { CartLine } from './types'

const doubleSmash: CartLine = {
  sku: 'double-smash',
  modifierIds: [],
  quantity: 1,
  unitPrice: 9200,
}

function setup() {
  let saved: string | null = null
  let now = Date.parse('2026-11-25T10:00:00Z')
  let id = 0
  let price = 9200
  let available = true
  let loseSavedResponse = false
  const storage = {
    async getItem() { return saved },
    async setItem(_key: string, value: string) {
      saved = value
      if (loseSavedResponse) {
        loseSavedResponse = false
        throw new Error('Response lost after save')
      }
    },
  }
  const restart = () => createDemoApi({
    storage,
    now: () => now,
    newId: () => String(++id),
    menu: (timestamp) => {
      const menu = createDemoMenu(timestamp)
      return {
        ...menu,
        products: menu.products.map((product) =>
          product.sku === doubleSmash.sku ? { ...product, price, available } : product),
      }
    },
  })
  const api = restart()
  const quote = async (lines = [doubleSmash], slotIndex = 0) => {
    const menu = await api.getMenu()
    const slot = menu.slots[slotIndex]
    ok(slot)
    return api.createQuote({ storeId: menu.store.id, slotId: slot.id, lines })
  }
  return {
    api,
    quote,
    restart,
    advance: (minutes: number) => { now += minutes * 60_000 },
    changePrice: (value: number) => { price = value },
    stopProduct: () => { available = false },
    loseNextSavedResponse: () => { loseSavedResponse = true },
    snapshot: () => saved,
  }
}

test('quote applies current option price and keeps taxes inside the total', async () => {
  const { quote } = setup()
  const result = await quote([{ ...doubleSmash, modifierIds: ['extra-cheese'], quantity: 2 }])
  equal(result.total, 19_400)
  equal(result.subtotal + result.tax, result.total)
  equal(result.currency, 'RWF')
  deepEqual(result.changes, [
    { kind: 'price', sku: 'double-smash', previousPrice: 9200, currentPrice: 9700 },
  ])
})

test('new price and stop-list are rechecked between quote approval and reservation', async () => {
  const { api, quote, changePrice, stopProduct } = setup()
  const first = await quote()
  changePrice(9500)
  await rejects(api.createOrder({ quoteId: first.id, phone: DEMO_PHONE }, 'order-one'), {
    code: 'quote_changed',
  })
  const adjusted = await quote()
  equal(adjusted.total, 9500)
  stopProduct()
  await rejects(api.createOrder({ quoteId: adjusted.id, phone: DEMO_PHONE }, 'order-one'), {
    code: 'quote_changed',
  })
  const stopped = await quote()
  deepEqual(stopped.lines, [])
  deepEqual(stopped.changes, [{ kind: 'unavailable', sku: 'double-smash' }])
})

test('lost response and restart reuse one order even after the quote expires', async () => {
  const fixture = setup()
  const first = await fixture.quote()
  const second = await fixture.quote()
  const input = { quoteId: first.id, phone: DEMO_PHONE }
  fixture.loseNextSavedResponse()
  await rejects(fixture.api.createOrder(input, 'order-one'), /Response lost after save/)
  fixture.advance(6)
  const recovered = fixture.restart()
  const order = await recovered.createOrder(input, 'order-one')
  equal((await recovered.getOrder(order.id)).id, order.id)
  await rejects(recovered.createOrder(input, 'different-key'), { code: 'conflict' })
  await rejects(recovered.createOrder({ ...input, quoteId: second.id }, 'order-one'), { code: 'conflict' })
  await rejects(recovered.createOrder({ ...input, quoteId: second.id }, 'order-two'), { code: 'quote_expired' })
  equal(fixture.snapshot()?.includes(DEMO_PHONE), false)
})

test('demo accepts only its sample contact and order data stays in the creating storage', async () => {
  const { api, quote } = setup()
  const { id: quoteId } = await quote()
  await rejects(api.createOrder({ quoteId, phone: '+250000000001' }, 'order-one'), { code: 'invalid_input' })
  const order = await api.createOrder({ quoteId, phone: DEMO_PHONE }, 'order-one')
  await rejects(setup().api.getOrder(order.id), { code: 'not_found' })
})

test('concurrent reservations cannot take the last place in one slot twice', async () => {
  const { api, quote } = setup()
  const first = await quote()
  const second = await quote()
  const third = await quote()
  const reserve = (quoteId: string, key: string) => api.createOrder({ quoteId, phone: DEMO_PHONE }, key)
  await reserve(first.id, 'order-one')
  const results = await Promise.allSettled([reserve(second.id, 'order-two'), reserve(third.id, 'order-three')])
  equal(results[0].status, 'fulfilled')
  equal(results[1].status, 'rejected')
  if (results[1].status === 'rejected') equal(results[1].reason.code, 'slot_unavailable')
  equal((await api.getMenu()).slots[0]?.available, false)
})

test('attempt survives restart, blocks a second attempt while open, and advances the kitchen after payment', async () => {
  const fixture = setup()
  const quote = await fixture.quote()
  const order = await fixture.api.createOrder({ quoteId: quote.id, phone: DEMO_PHONE }, 'order-one')
  const attempts = await Promise.all([
    fixture.api.startPayment(order.id, 'attempt-one'),
    fixture.api.startPayment(order.id, 'attempt-one'),
  ])
  deepEqual(attempts[0], attempts[1])
  const recovered = fixture.restart()
  equal((await recovered.getOrder(order.id)).paymentStatus, 'processing')
  await rejects(recovered.startPayment(order.id, 'attempt-two'), { code: 'payment_pending' })
  await rejects(recovered.setDemoOrderStatus(order.id, 'preparing'), { code: 'conflict' })
  await recovered.setDemoPaymentResult(order.id, 'declined')
  deepEqual(await recovered.startPayment(order.id, 'attempt-one'), { ...attempts[0], status: 'declined' })
  const nextAttempt = await recovered.startPayment(order.id, 'attempt-two')
  equal(nextAttempt.id === attempts[0].id, false)
  const paid = await recovered.setDemoPaymentResult(order.id, 'paid')
  equal(paid.status, 'accepted')
  match(paid.pickupCode ?? '', /^\d{4}$/)
  equal(paid.receiptUrl, null)
  await recovered.setDemoOrderStatus(order.id, 'preparing')
  await recovered.setDemoOrderStatus(order.id, 'ready')
  equal((await recovered.setDemoOrderStatus(order.id, 'collected')).status, 'collected')
})

test('late successful payment stays out of the kitchen and repeat recalculates catalog data', async () => {
  const fixture = setup()
  const quote = await fixture.quote()
  const order = await fixture.api.createOrder({ quoteId: quote.id, phone: DEMO_PHONE }, 'order-one')
  await fixture.api.startPayment(order.id, 'attempt-one')
  fixture.advance(11)
  equal((await fixture.api.getOrder(order.id)).status, 'cancelled')
  const late = await fixture.api.setDemoPaymentResult(order.id, 'paid')
  equal(late.paymentStatus, 'refund_pending')
  equal(late.status, 'cancelled')
  equal(late.pickupCode, null)
  fixture.changePrice(9900)
  const repeat = await fixture.api.reorder(order.id)
  equal(repeat.lines[0]?.unitPrice, 9900)
  deepEqual(repeat.changes, [
    { kind: 'price', sku: 'double-smash', previousPrice: 9200, currentPrice: 9900 },
  ])
  await rejects(fixture.api.getOrder('unknown-order'), { code: 'not_found' })
})
