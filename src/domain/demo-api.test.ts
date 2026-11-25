import { deepEqual, equal, match, ok, rejects } from 'node:assert/strict'
import { test } from 'node:test'
import { createDemoApi, DEMO_PHONE } from './demo-api'
import { createDemoMenu } from './demo-menu'
import { ApiError, type CartLine } from './types'

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
  let blockNextWrite = false
  let rescheduled = false
  const storage = {
    async getItem() { return saved },
    async setItem(_key: string, value: string) {
      if (blockNextWrite) {
        blockNextWrite = false
        throw new Error('Storage quota exceeded')
      }
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
        slots: rescheduled
          ? menu.slots.map((slot, index) => index === 0
            ? { ...slot, endsAt: new Date(Date.parse(slot.endsAt) + 5 * 60_000).toISOString() }
            : slot)
          : menu.slots,
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
    rescheduleFirstSlot: () => { rescheduled = true },
    loseNextSavedResponse: () => { loseSavedResponse = true },
    rejectNextWrite: () => { blockNextWrite = true },
    snapshot: () => saved,
    replaceSnapshot: (value: string) => { saved = value },
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
  await rejects(fixture.api.createOrder(input, 'order-one'), (error: unknown) =>
    error instanceof ApiError && error.code === 'storage_unavailable'
    && error.cause instanceof Error && error.cause.message === 'Response lost after save')
  fixture.advance(6)
  const recovered = fixture.restart()
  const order = await recovered.createOrder(input, 'order-one')
  equal((await recovered.getOrder(order.id)).id, order.id)
  await rejects(recovered.createOrder(input, 'different-key'), { code: 'conflict' })
  await rejects(recovered.createOrder({ ...input, quoteId: second.id }, 'order-one'), { code: 'conflict' })
  await rejects(recovered.createOrder({ ...input, quoteId: second.id }, 'order-two'), { code: 'quote_expired' })
  equal(fixture.snapshot()?.includes(DEMO_PHONE), false)
})

test('an offer needs renewed consent if the same slot ID changes its pickup window', async () => {
  const fixture = setup()
  const quote = await fixture.quote()
  const previous = (await fixture.api.getMenu()).slots[0]
  ok(previous)
  fixture.rescheduleFirstSlot()
  await rejects(fixture.api.createOrder({ quoteId: quote.id, phone: DEMO_PHONE }, 'order-one'), {
    code: 'quote_changed',
  })
  const reviewed = await fixture.quote()
  equal(reviewed.slotId, quote.slotId)
  const order = await fixture.api.createOrder({ quoteId: reviewed.id, phone: DEMO_PHONE }, 'order-two')
  equal(Date.parse(order.pickupEndsAt) - Date.parse(previous.endsAt), 5 * 60_000)
})

test('legacy quotes cannot start new orders and still replay orders already recorded', async () => {
  const fixture = setup()
  const created = await fixture.quote()
  const unused = await fixture.quote()
  const order = await fixture.api.createOrder({ quoteId: created.id, phone: DEMO_PHONE }, 'order-one')
  const attempt = await fixture.api.startPayment(order.id, 'attempt-one')
  const stored = fixture.snapshot()
  ok(stored)
  const legacy = JSON.parse(stored) as { quotes: { pickupStartsAt?: string; pickupEndsAt?: string }[] }
  for (const quote of legacy.quotes) {
    delete quote.pickupStartsAt
    delete quote.pickupEndsAt
  }
  fixture.replaceSnapshot(JSON.stringify(legacy))
  const api = fixture.restart()
  await rejects(api.createOrder({ quoteId: unused.id, phone: DEMO_PHONE }, 'order-two'), {
    code: 'quote_expired',
  })
  const replay = await api.createOrder({ quoteId: created.id, phone: DEMO_PHONE }, 'order-one')
  equal(replay.id, order.id)
  deepEqual(replay.paymentAttempt, attempt)
  equal((await api.setDemoPaymentResult(order.id, attempt.id, 'paid')).paymentStatus, 'paid')
})

test('a damaged ledger leaves the catalog readable, prevents ordering and preserves stored confirmations', async () => {
  const fixture = setup()
  const quote = await fixture.quote()
  const order = await fixture.api.createOrder({ quoteId: quote.id, phone: DEMO_PHONE }, 'order-one')
  const attempt = await fixture.api.startPayment(order.id, 'attempt-one')
  const paid = await fixture.api.setDemoPaymentResult(order.id, attempt.id, 'paid')
  const original = fixture.snapshot()
  ok(original)
  const damaged = JSON.parse(original) as { orders: unknown[] }
  damaged.orders.push(null)
  const raw = JSON.stringify(damaged)
  fixture.replaceSnapshot(raw)

  const api = fixture.restart()
  const menu = await api.getMenu()
  equal(menu.products.some(({ sku }) => sku === doubleSmash.sku), true)
  equal(menu.orderingUnavailable, true)
  ok(menu.slots.length > 0)
  equal(menu.slots.some(({ available }) => available), false)
  await rejects(api.createQuote({ storeId: menu.store.id, slotId: quote.slotId, lines: [doubleSmash] }), {
    code: 'storage_unavailable',
  })
  await rejects(api.getOrder(order.id), { code: 'storage_unavailable' })
  equal(fixture.snapshot(), raw)
  fixture.replaceSnapshot(original)
  deepEqual(await api.getOrder(order.id), paid)
  equal((await api.getMenu()).orderingUnavailable, undefined)
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
  await recovered.setDemoPaymentResult(order.id, attempts[0].id, 'declined')
  deepEqual(await recovered.startPayment(order.id, 'attempt-one'), { ...attempts[0], status: 'declined' })
  const nextAttempt = await recovered.startPayment(order.id, 'attempt-two')
  equal(nextAttempt.id === attempts[0].id, false)
  const paid = await recovered.setDemoPaymentResult(order.id, nextAttempt.id, 'paid')
  equal(paid.status, 'accepted')
  match(paid.pickupCode ?? '', /^\d{4}$/)
  equal(paid.receiptUrl, null)
  await recovered.setDemoOrderStatus(order.id, 'preparing')
  await recovered.setDemoOrderStatus(order.id, 'ready')
  equal((await recovered.setDemoOrderStatus(order.id, 'collected')).status, 'collected')
})

test('a payment result displayed for a declined attempt cannot settle a later attempt', async () => {
  const fixture = setup()
  const quote = await fixture.quote()
  const order = await fixture.api.createOrder({ quoteId: quote.id, phone: DEMO_PHONE }, 'order-one')
  const first = await fixture.api.startPayment(order.id, 'attempt-one')
  await fixture.api.setDemoPaymentResult(order.id, first.id, 'declined')
  const second = await fixture.api.startPayment(order.id, 'attempt-two')
  await rejects(fixture.api.setDemoPaymentResult(order.id, first.id, 'paid'), { code: 'conflict' })
  const after = await fixture.api.getOrder(order.id)
  equal(after.paymentStatus, 'processing')
  deepEqual(after.paymentAttempt, second)
  equal(after.pickupCode, null)
})

test('late successful payment stays out of the kitchen and repeat recalculates catalog data', async () => {
  const fixture = setup()
  const quote = await fixture.quote()
  const order = await fixture.api.createOrder({ quoteId: quote.id, phone: DEMO_PHONE }, 'order-one')
  const attempt = await fixture.api.startPayment(order.id, 'attempt-one')
  fixture.advance(11)
  equal((await fixture.api.getOrder(order.id)).status, 'cancelled')
  const late = await fixture.api.setDemoPaymentResult(order.id, attempt.id, 'paid')
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


test('expired quotes are pruned without affecting committed order retries', async () => {
  const f = setup();
  const old = await f.quote();
  const unused = await f.quote();
  const input = { quoteId: old.id, phone: DEMO_PHONE };
  const recorded = await f.api.createOrder(input, 'known-order');
  f.advance(6);

  const fresh = await f.quote();
  const saved = f.snapshot();
  ok(saved);
  deepEqual(JSON.parse(saved).quotes.map(({ id }: { id: string }) => id), [fresh.id]);
  equal((await f.restart().createOrder(input, 'known-order')).id, recorded.id);
  await rejects(f.api.createOrder({ quoteId: unused.id, phone: DEMO_PHONE }, 'expired-order'), {
    code: 'quote_expired',
  });
});


test('a failed write is classified and the same order request can safely retry', async () => {
  const f = setup()
  const quote = await f.quote()
  const input = { quoteId: quote.id, phone: DEMO_PHONE }
  f.rejectNextWrite()
  await rejects(f.api.createOrder(input, 'order-one'), (error: unknown) =>
    error instanceof ApiError && error.code === 'storage_unavailable'
    && error.cause instanceof Error && error.cause.message === 'Storage quota exceeded')
  deepEqual(await f.api.listDemoOrderRefs(10), [])
  const order = await f.restart().createOrder(input, 'order-one')
  equal((await f.api.listDemoOrderRefs(10)).length, 1)
  equal((await f.api.createOrder(input, 'order-one')).id, order.id)
})

test('a duplicate payment result after a lost response is idempotent for the same attempt', async () => {
  const f = setup()
  const quote = await f.quote()
  const order = await f.api.createOrder({ quoteId: quote.id, phone: DEMO_PHONE }, 'order-one')
  const first = await f.api.startPayment(order.id, 'attempt-one')
  f.loseNextSavedResponse()
  await rejects(f.api.setDemoPaymentResult(order.id, first.id, 'paid'), { code: 'storage_unavailable' })
  const replay = await f.restart().setDemoPaymentResult(order.id, first.id, 'paid')
  equal(replay.status, 'accepted')
  equal(replay.paymentStatus, 'paid')
  match(replay.pickupCode ?? '', /^\d{4}$/)
  await rejects(f.api.setDemoPaymentResult(order.id, first.id, 'declined'), { code: 'conflict' })
  deepEqual(await f.api.getOrder(order.id), replay)
})

test('a syntactically valid but inconsistent saved total blocks order creation and preserves the ledger', async () => {
  const f = setup()
  const quote = await f.quote()
  const saved = f.snapshot()
  ok(saved)
  const invalid = JSON.parse(saved)
  invalid.quotes[0].total += 100
  invalid.quotes[0].subtotal += 100
  const raw = JSON.stringify(invalid)
  f.replaceSnapshot(raw)

  await rejects(f.restart().createOrder({ quoteId: quote.id, phone: DEMO_PHONE }, 'order-one'), {
    code: 'storage_unavailable',
  })
  equal(f.snapshot(), raw)
  equal((await f.api.getMenu()).orderingUnavailable, true)
})

test('a burst across API instances sharing one adapter preserves capacity and both committed orders', async () => {
  const f = setup()
  const quotes = await Promise.all(Array.from({ length: 48 }, () => f.quote()))
  const results = await Promise.allSettled(quotes.map((quote, index) =>
    f.restart().createOrder({ quoteId: quote.id, phone: DEMO_PHONE }, `burst-${index}`)))
  const successful = results.filter(result => result.status === 'fulfilled')
  const rejected = results.filter(result => result.status === 'rejected')
  equal(successful.length, 2)
  equal(rejected.length, 46)
  for (const result of rejected) equal(result.reason.code, 'slot_unavailable')
  const saved = await f.api.listDemoOrderRefs(48)
  deepEqual(new Set(saved.map(record => record.orderId)), new Set(successful.map(result => result.value.id)))
})

test('192 synthetic checkout lifecycles preserve totals, attempt identity and kitchen gating', async () => {
  const optionSets = [[], ['extra-cheese'], ['no-pickles'], ['no-pickles', 'extra-cheese']]
  const quantities = [1, 4, 9]
  const outcomes = ['paid', 'declined', 'retry', 'late'] as const
  const interruptions = ['none', 'order', 'attempt', 'result'] as const
  let scenarios = 0

  for (const modifierIds of optionSets) {
    for (const quantity of quantities) {
      for (const outcome of outcomes) {
        for (const interruption of interruptions) {
          const f = setup()
          const quote = await f.quote([{ ...doubleSmash, modifierIds, quantity }])
          const expected = (9200 + (modifierIds.includes('extra-cheese') ? 500 : 0)) * quantity
          equal(quote.total, expected)
          equal(quote.subtotal + quote.tax, expected)
          const input = { quoteId: quote.id, phone: DEMO_PHONE }
          if (interruption === 'order') {
            f.loseNextSavedResponse()
            await rejects(f.api.createOrder(input, 'order-key'), { code: 'storage_unavailable' })
          }
          const order = await f.restart().createOrder(input, 'order-key')
          equal((await f.api.createOrder(input, 'order-key')).id, order.id)
          if (interruption === 'attempt') {
            f.loseNextSavedResponse()
            await rejects(f.api.startPayment(order.id, 'attempt-key'), { code: 'storage_unavailable' })
          }
          const attempt = await f.restart().startPayment(order.id, 'attempt-key')
          equal((await f.api.startPayment(order.id, 'attempt-key')).id, attempt.id)
          if (outcome === 'late') f.advance(11)
          const result = outcome === 'declined' || outcome === 'retry' ? 'declined' : 'paid'
          if (interruption === 'result') {
            f.loseNextSavedResponse()
            await rejects(f.api.setDemoPaymentResult(order.id, attempt.id, result), { code: 'storage_unavailable' })
          }
          let final = await f.restart().setDemoPaymentResult(order.id, attempt.id, result)
          if (outcome === 'retry') {
            const retried = await f.restart().startPayment(order.id, 'attempt-two')
            await rejects(f.api.setDemoPaymentResult(order.id, attempt.id, 'paid'), { code: 'conflict' })
            final = await f.api.setDemoPaymentResult(order.id, retried.id, 'paid')
          }
          equal(final.total, expected)
          equal(final.paymentStatus, outcome === 'late' ? 'refund_pending' : outcome === 'declined' ? 'declined' : 'paid')
          if (final.paymentStatus === 'paid') {
            equal(final.status, 'accepted')
            await f.api.setDemoOrderStatus(order.id, 'preparing')
            await f.api.setDemoOrderStatus(order.id, 'ready')
            equal((await f.api.setDemoOrderStatus(order.id, 'collected')).status, 'collected')
          } else {
            equal(final.pickupCode, null)
            await rejects(f.api.setDemoOrderStatus(order.id, 'preparing'), { code: 'conflict' })
          }
          equal((await f.restart().listDemoOrderRefs(10)).length, 1)
          scenarios += 1
        }
      }
    }
  }
  equal(scenarios, 192)
})
