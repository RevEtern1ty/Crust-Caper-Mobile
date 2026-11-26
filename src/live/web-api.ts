import { z } from 'zod';
import { hasSavedCheckout, parseJournal } from '../checkout/controller';
import { paymentReturnOrderId } from '../checkout/payment-return';
import { ApiError, type Order, type PaymentAttempt, type Storage } from '../domain/types';
import { errorCode, invalidResponse, safeHttps, type ConnectedConfig, type LiveShopApi } from './http-api';
import { PDF_MIME_TYPE, readReceiptPdf } from './receipt';
import {
  menuResponse, orderAccessChallenge, orderAccessGrant, paymentResponse, quoteResponse, reorderResponse,
  webOrderResponse, webSessionResponse,
} from './wire';

export function webCheckoutAvailable(config: ConnectedConfig): boolean {
  return typeof window !== 'undefined' && window.isSecureContext
    && window.location.protocol === 'https:' && window.location.origin === new URL(config.apiBaseUrl).origin
    && typeof navigator.locks?.request === 'function';
}

type WebOptions = {
  config: ConnectedConfig;
  storage: Storage & { removeItem(key: string): Promise<void> };
  journalKey: string;
  fetcher?: typeof fetch;
  browser?: { available: () => boolean; locks: () => Pick<LockManager, 'request'> };
  timeoutMs?: number;
};

type Request<T> = {
  path: string;
  schema: z.ZodType<T>;
  method?: 'GET' | 'POST' | 'DELETE';
  key?: string;
  body?: unknown;
  pdf?: boolean;
  onHeaders?: (headers: Headers) => void;
};

const contextId = z.string().refine(value => paymentReturnOrderId(value) !== null);
const verifiedContext = z.object({ sessionId: contextId, orderIds: z.array(contextId).max(10), owned: z.boolean() });
const quotedContext = z.object({ quoteId: z.string(), sessionId: contextId });
const sessionPath = '/web/session';
const cookieLock = 'crustcaper-web-session-v1';

class NoWebSession extends ApiError {
  constructor() { super('unauthenticated'); }
}

export function createWebLiveApi({
  config, storage, journalKey, fetcher = fetch, timeoutMs = 15_000,
  browser = { available: () => webCheckoutAvailable(config), locks: () => navigator.locks },
}: WebOptions): LiveShopApi {
  const origin = new URL(config.apiBaseUrl).origin;
  const endpoint = origin + '/api/v1';
  const contextKey = journalKey + '.context';
  const quoteKey = journalKey + '.quote';
  const recoveryKey = journalKey + '.verified';
  const endKey = journalKey + '.end-cookie';
  const hosts = new Set(config.pspHosts);
  const orderPath = (id: string) => {
    if (!paymentReturnOrderId(id)) throw new ApiError('invalid_input');
    return '/orders/' + id;
  };
  const receiptPath = (id: string) => orderPath(id) + '/receipt';
  const work = new Set<Promise<unknown>>();
  let ending: Promise<void> | null = null;
  let challenge: { id: string; sessionId: string; separateContext: boolean } | null = null;

  async function storageCall<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch {
      throw new ApiError('storage_unavailable');
    }
  }

  const read = (key: string) => storageCall(() => storage.getItem(key));
  const save = (key: string, value: string) => storageCall(() => storage.setItem(key, value));
  const hasGuestSessionEndPending = async () => await read(endKey) !== null;

  async function savedContext() {
    const raw = await read(contextKey);
    if (raw === null) return null;
    if (!contextId.safeParse(raw).success) throw new ApiError('storage_unavailable');
    return raw;
  }

  async function savedRecovery() {
    const raw = await read(recoveryKey);
    if (raw === null) return null;
    try {
      return verifiedContext.parse(JSON.parse(raw));
    } catch {
      throw new ApiError('storage_unavailable');
    }
  }

  function requireBrowser() {
    if (!browser.available()) throw new ApiError('service_unavailable');
  }

  async function request<T>({
    path, schema, method = 'GET', key, body, pdf, onHeaders,
  }: Request<T>, privateRequest = false, sessionId?: string): Promise<T> {
    if (privateRequest) requireBrowser();
    const url = endpoint + path;
    const headers: Record<string, string> = { Accept: (pdf ? PDF_MIME_TYPE : 'application/json') + ', application/problem+json' };
    if (privateRequest && method !== 'GET') headers['X-CrustCaper-Web'] = '1';
    if (sessionId) headers['X-CrustCaper-Session'] = sessionId;
    if (key) headers['Idempotency-Key'] = key;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(url, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        credentials: privateRequest ? 'same-origin' : 'omit',
        mode: privateRequest ? 'same-origin' : 'cors',
        redirect: 'error', cache: 'no-store', signal: controller.signal,
      });
      if (response.redirected || (response.url && response.url !== url)) invalidResponse();
      if (path === sessionPath && method === 'GET' && response.status === 401) throw new NoWebSession();
      if (pdf && !response.ok) throw new ApiError(errorCode(response.status, null));
      if ((pdf && response.status !== 200) || (method === 'DELETE' && response.ok && response.status !== 204)) invalidResponse();
      const payload: unknown = pdf ? await readReceiptPdf(response) : response.status === 204 ? null : await response.json().catch(() => null);
      if (!response.ok) throw new ApiError(errorCode(response.status, payload));
      const parsed = schema.safeParse(payload);
      if (!parsed.success) invalidResponse();
      onHeaders?.(response.headers);
      return parsed.data;
    } catch (error) {
      controller.abort();
      if (error instanceof ApiError) throw error;
      throw new ApiError('network_unavailable');
    } finally {
      clearTimeout(timeout);
    }
  }

  async function withCookieLock<T>(operation: () => Promise<T>): Promise<T> {
    requireBrowser();
    try {
      return await browser.locks().request(cookieLock, { signal: AbortSignal.timeout(timeoutMs) }, operation);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError('network_unavailable');
    }
  }

  async function currentCookieContext(): Promise<string | null> {
    try {
      return (await request({ path: sessionPath, schema: webSessionResponse }, true)).sessionId;
    } catch (error) {
      if (error instanceof NoWebSession) return null;
      throw error;
    }
  }

  async function bootstrapCookie(): Promise<string> {
    const created = await request({ path: sessionPath, method: 'POST', schema: webSessionResponse }, true);
    // Confirm the browser accepted the cookie before releasing the lock or saving its context.
    if (await currentCookieContext() !== created.sessionId) throw new ApiError('unauthenticated');
    return created.sessionId;
  }

  function withWork<T>(operation: () => Promise<T>): Promise<T> {
    const pending = (async () => {
      requireBrowser();
      if (await hasGuestSessionEndPending() || ending) throw new ApiError('unauthenticated');
      return operation();
    })();
    work.add(pending);
    return pending.finally(() => work.delete(pending));
  }

  function forQuote() {
    return withCookieLock(async () => {
      const saved = await savedContext();
      if (hasSavedCheckout(await read(journalKey))) {
        if (saved) return saved;
        throw new ApiError('unauthenticated');
      }
      const active = await currentCookieContext();
      if (active && active === saved) return active;
      if (hasSavedCheckout(await read(journalKey))) throw new ApiError('unauthenticated');
      const sessionId = active ?? await bootstrapCookie();
      if (hasSavedCheckout(await read(journalKey))) throw new ApiError('unauthenticated');
      await save(contextKey, sessionId);
      return sessionId;
    });
  }

  function privateCall<T>(options: Request<T>, sessionId: string) {
    return request({ ...options, path: '/web' + options.path }, true, sessionId);
  }

  async function primaryCall<T>(options: Request<T>) {
    const sessionId = await savedContext();
    if (!sessionId) throw new ApiError('unauthenticated');
    return privateCall(options, sessionId);
  }

  async function contextForQuote(quoteId: string) {
    const sessionId = await savedContext();
    const raw = await read(quoteKey);
    let binding: z.infer<typeof quotedContext> | null;
    try {
      binding = raw === null ? null : quotedContext.parse(JSON.parse(raw));
    } catch {
      throw new ApiError('storage_unavailable');
    }
    if (!sessionId || binding?.quoteId !== quoteId || binding.sessionId !== sessionId) throw new ApiError('unauthenticated');
    return sessionId;
  }

  function readOrder<T>(id: string, options: Request<T>) {
    return withWork(async () => {
      try {
        return { payload: await primaryCall(options), alternateContext: false };
      } catch (error) {
        if (!(error instanceof ApiError && ['unauthenticated', 'not_found'].includes(error.code))) throw error;
        const recovered = await savedRecovery();
        if (!recovered?.orderIds.includes(id)) throw error;
        return { payload: await privateCall(options, recovered.sessionId), alternateContext: true };
      }
    });
  }

  const checkedPayment = (attempt: PaymentAttempt): PaymentAttempt => ({
    ...attempt,
    checkoutUrl: attempt.status === 'processing'
      ? safeHttps(attempt.checkoutUrl, url => hosts.has(url.hostname)) : null,
  });
  const checkedOrder = (order: Order, id?: string): Order => {
    if (!paymentReturnOrderId(order.id) || order.storeId !== config.storeId || (id !== undefined && order.id !== id)) invalidResponse();
    return {
      ...order,
      receiptUrl: order.receiptStatus !== 'pending'
        && order.receiptUrl === '/api/v1/web' + receiptPath(order.id) ? order.receiptUrl : null,
      paymentAttempt: order.paymentAttempt
        ? (order.recoveryReadOnly ? { ...order.paymentAttempt, checkoutUrl: null } : checkedPayment(order.paymentAttempt))
        : null,
    };
  };

  return {
    hasGuestSessionEndPending,
    endGuestSession() {
      if (ending) return ending;
      ending = (async () => {
        await Promise.allSettled(work);
        await withCookieLock(async () => {
          await save(endKey, 'pending');
          const saved = await savedContext();
          const recovered = await savedRecovery();
          const owned = recovered?.owned ? recovered.sessionId : null;
          const current = saved || owned ? await currentCookieContext() : null;
          // The alternate cookie may already have belonged to another tab when recovery started.
          if (current && (current === saved || current === owned)) {
            await request({ path: sessionPath, method: 'DELETE', schema: z.null() }, true, current);
          }
          challenge = null;
          for (const key of [journalKey, quoteKey, recoveryKey, contextKey, endKey]) {
            await storageCall(() => storage.removeItem(key));
          }
        });
      })().finally(() => { ending = null; });
      return ending;
    },
    async getMenu() {
      let availabilityCheckedAt: string | undefined;
      const menu = await request({
        path: '/stores/' + encodeURIComponent(config.storeId) + '/menu?channel=web',
        schema: menuResponse,
        onHeaders(headers) {
          const checkedAt = headers.get('X-Availability-Checked-At');
          if (checkedAt && Number.isFinite(Date.parse(checkedAt))) availabilityCheckedAt = checkedAt;
        },
      });
      if (menu.store.id !== config.storeId) invalidResponse();
      return {
        ...menu,
        availabilityCheckedAt,
        store: {
          ...menu.store,
          supportUrl: safeHttps(menu.store.supportUrl) ?? undefined,
          directionsUrl: safeHttps(menu.store.directionsUrl) ?? undefined,
        },
        products: menu.products.map(item => ({ ...item, photoUrl: safeHttps(item.photoUrl, url => url.origin === origin) ?? undefined })),
      };
    },
    createQuote(input) {
      return withWork(async () => {
        const sessionId = await forQuote();
        const quote = await privateCall({
          path: '/quotes', method: 'POST', schema: quoteResponse, body: input,
        }, sessionId);
        if (quote.storeId !== config.storeId || quote.slotId !== input.slotId) invalidResponse();
        const { quoteId, ...fields } = quote;
        // Keep the quote bound even if a new cookie appeared before the journal saved the intent.
        await save(quoteKey, JSON.stringify({ quoteId, sessionId }));
        return { ...fields, id: quoteId };
      });
    },
    createOrder(input, key) {
      return withWork(async () => checkedOrder(await privateCall({
        path: '/orders', method: 'POST', schema: webOrderResponse, key, body: input,
      }, await contextForQuote(input.quoteId))));
    },
    recoverOrder(key) {
      return withWork(async () => {
        try {
          const options = { path: '/orders/recovery', schema: webOrderResponse, key };
          const intent = parseJournal(await read(journalKey)).active;
          return checkedOrder(intent?.phase === 'creating' && intent.key === key
            ? await privateCall(options, await contextForQuote(intent.quoteId)) : await primaryCall(options));
        } catch (error) {
          if (error instanceof ApiError && error.code === 'not_found') return null;
          throw error;
        }
      });
    },
    startPayment(orderId, key) {
      return withWork(async () => checkedPayment(await primaryCall({
        path: orderPath(orderId) + '/payments', method: 'POST', schema: paymentResponse, key,
      })));
    },
    async getOrder(orderId) {
      const { payload, alternateContext } = await readOrder(orderId, { path: orderPath(orderId), schema: webOrderResponse });
      return checkedOrder(alternateContext ? { ...payload, recoveryReadOnly: true } : payload, orderId);
    },
    async getReceiptPdf(orderId) {
      const result = await readOrder(orderId, { path: receiptPath(orderId), schema: z.instanceof(Uint8Array), pdf: true });
      return result.payload;
    },
    reorder(orderId) {
      return withWork(() => primaryCall({ path: orderPath(orderId) + '/reorder', method: 'POST', schema: reorderResponse }));
    },
    requestOrderAccess(input) {
      return withWork(async () => {
        challenge = null;
        const context = await withCookieLock(async () => {
          const saved = await savedContext();
          const active = await currentCookieContext();
          const sessionId = active ?? await bootstrapCookie();
          if (saved === sessionId) return { sessionId, separateContext: false };
          if (hasSavedCheckout(await read(journalKey))) {
            // An explicit recovery grants access to an order without reassigning saved checkout writes.
            if (!active) await save(recoveryKey, JSON.stringify({ sessionId, orderIds: [], owned: true }));
            return { sessionId, separateContext: true };
          }
          await save(contextKey, sessionId);
          return { sessionId, separateContext: false };
        });
        const result = await privateCall({
          path: '/order-access/challenges', method: 'POST', schema: orderAccessChallenge, body: input,
        }, context.sessionId);
        challenge = { ...context, id: result.challengeId };
        return result;
      });
    },
    verifyOrderAccess(challengeId, code) {
      return withWork(async () => {
        const context = challenge;
        if (!context || context.id !== challengeId) throw new ApiError('unauthenticated');
        const grant = await privateCall({
          path: '/order-access/challenges/' + encodeURIComponent(challengeId) + '/verify',
          method: 'POST', schema: orderAccessGrant, body: { code },
        }, context.sessionId);
        if (context.separateContext) {
          const before = await savedRecovery();
          const earlier = before?.sessionId === context.sessionId ? before.orderIds : [];
          const orderIds = [grant.orderId, ...earlier.filter(id => id !== grant.orderId)].slice(0, 10);
          const owned = before?.sessionId === context.sessionId && before.owned;
          await save(recoveryKey, JSON.stringify({ sessionId: context.sessionId, orderIds, owned }));
        }
        challenge = null;
        return grant;
      });
    },
  };
}
