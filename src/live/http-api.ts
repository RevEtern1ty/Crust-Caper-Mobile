import { z } from 'zod';
import { hasSavedCheckout } from '../checkout/controller';
import { paymentReturnOrderId } from '../checkout/payment-return';
import { ApiError } from '../domain/types';
import type { ApiErrorCode, Order, PaymentAttempt, ShopApi, Storage } from '../domain/types';
import { PDF_MIME_TYPE, readReceiptPdf } from './receipt';
import { menuResponse, orderAccessChallenge, orderAccessGrant, orderResponse, paymentResponse, quoteResponse, reorderResponse, sessionResponse } from './wire';

type Session = z.infer<typeof sessionResponse>;
type Fetcher = (url: string, options: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'redirected' | 'url' | 'json' | 'headers' | 'body'>>;

export type ConnectedConfig = {
  profile: 'local' | 'stage' | 'production';
  apiBaseUrl: string;
  storeId: string;
  pspHosts: string[];
};

type Options = {
  config: ConnectedConfig;
  storage: Storage;
  journalKey: string;
  fetcher?: Fetcher;
  now?: () => number;
  timeoutMs?: number;
};

export interface LiveShopApi extends ShopApi {
  settleLocalTestPayment?: (orderId: string, attemptId: string, status: 'paid' | 'declined') => Promise<Order>;
}

const knownConflicts = new Set<string>([
  'quote_expired', 'quote_changed', 'slot_unavailable', 'conflict', 'reservation_expired', 'payment_pending',
]);

function invalidResponse(): never {
  throw new ApiError('invalid_response');
}

function safeHttps(value: string | null | undefined, allow?: (url: URL) => boolean): string | null {
  if (!value || value !== value.trim() || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.port && !url.username && !url.password && (!allow || allow(url))) {
      return url.href;
    }
  } catch {
    // The wire URL is untrusted.
  }
  return null;
}

function errorCode(status: number, problem: unknown): ApiErrorCode {
  if (status === 400 || status === 422) return 'invalid_input';
  if (status === 401 || status === 403) return 'unauthenticated';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status === 409) {
    const code = z.object({ code: z.string() }).safeParse(problem);
    return code.success && knownConflicts.has(code.data.code) ? code.data.code as ApiErrorCode : 'conflict';
  }
  return 'service_unavailable';
}

export function createLiveApi({
  config, storage, journalKey, fetcher = fetch, now = Date.now, timeoutMs = 15_000,
}: Options): LiveShopApi {
  const base = new URL(config.apiBaseUrl);
  const endpoint = base.origin + '/api/v1';
  const sessionKey = journalKey + '.guest';
  const hosts = new Set(config.pspHosts);
  const orderPath = (id: string) => '/orders/' + encodeURIComponent(id);
  const receiptPath = (id: string) => orderPath(id) + '/receipt';
  let sessionPromise: Promise<Session> | null = null;

  const checkedPayment = (attempt: PaymentAttempt): PaymentAttempt => ({
    ...attempt,
    checkoutUrl: attempt.status === 'processing'
      ? safeHttps(attempt.checkoutUrl, url => hosts.has(url.hostname)) : null,
  });
  const checkedOrder = (order: Order, id?: string): Order => {
    if (order.storeId !== config.storeId || (id !== undefined && order.id !== id)) invalidResponse();
    return {
      ...order,
      receiptUrl: order.receiptStatus !== 'pending' && paymentReturnOrderId(order.id)
        && order.receiptUrl === '/api/v1' + receiptPath(order.id) ? order.receiptUrl : null,
      paymentAttempt: order.paymentAttempt ? checkedPayment(order.paymentAttempt) : null,
    };
  };

  async function request<T>({
    path, schema, method = 'GET', token, key, body, pdf = false,
  }: {
    path: string;
    schema: z.ZodType<T>;
    method?: 'POST' | 'GET';
    token?: string;
    key?: string;
    body?: unknown;
    pdf?: boolean;
  }): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = { Accept: (pdf ? PDF_MIME_TYPE : 'application/json') + ', application/problem+json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (key) headers['Idempotency-Key'] = key;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      const url = endpoint + path;
      const response = await fetcher(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
      });
      if (response.redirected || (response.url && response.url !== url)) invalidResponse();
      if (pdf && !response.ok) throw new ApiError(errorCode(response.status, null));
      if (pdf && response.status !== 200) invalidResponse();
      const payload: unknown = pdf ? await readReceiptPdf(response) : await response.json().catch(() => null);
      if (!response.ok) throw new ApiError(errorCode(response.status, payload));
      const parsed = schema.safeParse(payload);
      if (!parsed.success) invalidResponse();
      return parsed.data;
    } catch (error) {
      controller.abort();
      if (error instanceof ApiError) throw error;
      throw new ApiError('network_unavailable');
    } finally {
      clearTimeout(timeout);
    }
  }

  async function durableSession(session: Session): Promise<Session> {
    if (Date.parse(session.expiresAt) <= now() || Date.parse(session.refreshExpiresAt) <= now()) invalidResponse();
    try {
      await storage.setItem(sessionKey, JSON.stringify(session));
    } catch {
      throw new ApiError('storage_unavailable');
    }
    return session;
  }

  async function readSaved(key: string): Promise<string | null> {
    try {
      return await storage.getItem(key);
    } catch {
      throw new ApiError('storage_unavailable');
    }
  }

  function guestSession(rejectedAccessToken?: string): Promise<Session> {
    if (sessionPromise) return sessionPromise;
    sessionPromise = (async () => {
      const raw = await readSaved(sessionKey);
      if (raw !== null) {
        let parsed: ReturnType<typeof sessionResponse.safeParse>;
        try {
          parsed = sessionResponse.safeParse(JSON.parse(raw));
        } catch {
          throw new ApiError('storage_unavailable');
        }
        if (!parsed.success) throw new ApiError('storage_unavailable');
        const existing = parsed.data;
        if (Date.parse(existing.expiresAt) > now() && existing.accessToken !== rejectedAccessToken) {
          return existing;
        }
        if (Date.parse(existing.refreshExpiresAt) > now()) {
          return durableSession(await request({
            path: '/guest-sessions/refresh', method: 'POST', schema: sessionResponse,
            body: { refreshToken: existing.refreshToken },
          }));
        }
      }
      // Never replace the identity behind a durable checkout with a fresh guest.
      if (rejectedAccessToken !== undefined || hasSavedCheckout(await readSaved(journalKey))) {
        throw new ApiError('unauthenticated');
      }
      return durableSession(await request({ path: '/guest-sessions', method: 'POST', schema: sessionResponse }));
    })().finally(() => { sessionPromise = null; });
    return sessionPromise;
  }

  async function authorized<T>(options: Parameters<typeof request<T>>[0]): Promise<T> {
    const { accessToken } = await guestSession();
    try {
      return await request({ ...options, token: accessToken });
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'unauthenticated') throw error;
      const updated = await guestSession(accessToken);
      return request({ ...options, token: updated.accessToken });
    }
  }

  return {
    async getMenu() {
      const menu = await request({
        path: '/stores/' + encodeURIComponent(config.storeId) + '/menu?channel=mobile', schema: menuResponse,
      });
      if (menu.store.id !== config.storeId) invalidResponse();
      return {
        ...menu,
        store: {
          ...menu.store,
          supportUrl: safeHttps(menu.store.supportUrl) ?? undefined,
          directionsUrl: safeHttps(menu.store.directionsUrl) ?? undefined,
        },
        products: menu.products.map(item => ({ ...item, photoUrl: safeHttps(item.photoUrl) ?? undefined })),
      };
    },
    async createQuote(input) {
      const quote = await authorized({ path: '/quotes', method: 'POST', schema: quoteResponse, body: input });
      if (quote.storeId !== config.storeId || quote.slotId !== input.slotId) invalidResponse();
      const { quoteId, ...fields } = quote;
      return { ...fields, id: quoteId };
    },
    async createOrder(input, key) {
      return checkedOrder(await authorized({ path: '/orders', method: 'POST', schema: orderResponse, key, body: input }));
    },
    async recoverOrder(key) {
      try {
        return checkedOrder(await authorized({ path: '/orders/recovery', schema: orderResponse, key }));
      } catch (error) {
        if (error instanceof ApiError && error.code === 'not_found') return null;
        throw error;
      }
    },
    async startPayment(orderId, key) {
      const attempt = await authorized({ path: orderPath(orderId) + '/payments', method: 'POST', schema: paymentResponse, key });
      return checkedPayment(attempt);
    },
    async getOrder(orderId) {
      return checkedOrder(await authorized({ path: orderPath(orderId), schema: orderResponse }), orderId);
    },
    async getReceiptPdf(orderId) {
      if (!paymentReturnOrderId(orderId)) throw new ApiError('invalid_input');
      return authorized({ path: receiptPath(orderId), schema: z.instanceof(Uint8Array), pdf: true });
    },
    async reorder(orderId) {
      return authorized({ path: orderPath(orderId) + '/reorder', method: 'POST', schema: reorderResponse });
    },
    async requestOrderAccess(input) {
      return authorized({ path: '/order-access/challenges', method: 'POST', schema: orderAccessChallenge, body: input });
    },
    async verifyOrderAccess(challengeId, code) {
      const path = '/order-access/challenges/' + encodeURIComponent(challengeId) + '/verify';
      return authorized({ path, method: 'POST', schema: orderAccessGrant, body: { code } });
    },
    ...(config.profile === 'local' ? {
      async settleLocalTestPayment(orderId: string, attemptId: string, status: 'paid' | 'declined') {
        const path = '/local' + orderPath(orderId) + '/payments/' + encodeURIComponent(attemptId) + '/result';
        return checkedOrder(await authorized({ path, method: 'POST', schema: orderResponse, body: { status } }), orderId);
      },
    } : {}),
  };
}
