import { z } from 'zod';
import { canStartNewOrder, hasSavedCheckout, parseJournal } from '../checkout/controller';
import { paymentReturnOrderId } from '../checkout/payment-return';
import { ApiError } from '../domain/types';
import type { ApiErrorCode, Locale, Order, PaymentAttempt, ShopApi, Storage } from '../domain/types';
import { PDF_MIME_TYPE, readReceiptPdf } from './receipt';
import { menuResponse, orderAccessChallenge, orderAccessGrant, orderResponse, paymentResponse, quoteResponse, reorderResponse, sessionResponse } from './wire';

type Session = z.infer<typeof sessionResponse>;
const savedSession = sessionResponse.extend({ rotationKey: z.guid().optional() });
type SavedSession = z.infer<typeof savedSession>;
type Fetcher = (url: string, options: RequestInit) => Promise<Pick<Response, 'ok' | 'status' | 'redirected' | 'url' | 'json' | 'headers' | 'body'>>;
const recoverySession = z.object({
  guest: savedSession,
  previous: z.string().nullable(),
  challengeId: z.guid().nullable(),
  grants: z.array(z.guid()).max(10),
});
type RecoverySession = z.infer<typeof recoverySession>;

class GuestRejected extends ApiError {
  constructor() { super('unauthenticated'); }
}

export type ConnectedConfig = {
  profile: 'local' | 'stage' | 'production';
  apiBaseUrl: string;
  storeId: string;
  pspHosts: string[];
  pushProjectId?: string;
};

type Options = {
  config: ConnectedConfig;
  storage: Storage & { removeItem(key: string): Promise<void> };
  journalKey: string;
  fetcher?: Fetcher;
  now?: () => number;
  timeoutMs?: number;
  newInstallationId?: () => string;
  newRotationKey?: () => string;
};

export interface LiveShopApi extends ShopApi {
  endGuestSession(): Promise<void>;
  hasGuestSessionEndPending(): Promise<boolean>;
  settleLocalTestPayment?: (orderId: string, attemptId: string, status: 'paid' | 'declined') => Promise<Order>;
}

const knownConflicts = new Set<string>([
  'quote_expired', 'quote_changed', 'slot_unavailable', 'conflict', 'reservation_expired', 'payment_pending',
  'pickup_alert_unavailable',
]);
const expoPushTokenPattern = /^(?:Expo|Exponent)PushToken\[[A-Za-z0-9_-]{1,128}\]$/;
const pickupAlertStatus = z.object({ enabled: z.boolean(), available: z.boolean() });

function invalidResponse(): never {
  throw new ApiError('invalid_response');
}

function sameGuest(left: Session, right: Session): boolean {
  return left.sessionId && right.sessionId ? left.sessionId === right.sessionId : left.refreshToken === right.refreshToken;
}

function refreshInput(guest: SavedSession) {
  return { refreshToken: guest.refreshToken, ...(guest.rotationKey ? { rotationKey: guest.rotationKey } : {}) };
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
  config, storage, journalKey, fetcher = fetch, now = Date.now, timeoutMs = 15_000, newInstallationId,
  newRotationKey = () => globalThis.crypto.randomUUID(),
}: Options): LiveShopApi {
  const base = new URL(config.apiBaseUrl);
  const endpoint = base.origin + '/api/v1';
  const sessionKey = journalKey + '.guest';
  const recoveryKey = journalKey + '.recovery-guest';
  const endKey = journalKey + '.end-guest';
  const installationKey = journalKey + '.installation';
  const hosts = new Set(config.pspHosts);
  const orderPath = (id: string) => '/orders/' + encodeURIComponent(id);
  const receiptPath = (id: string) => orderPath(id) + '/receipt';
  let sessionPromise: Promise<Session> | null = null;
  let activation: Promise<boolean> | null = null;
  let recoveryQueue: Promise<void> = Promise.resolve();
  let pendingRecovery: RecoverySession | null = null;
  let primaryChallenge: { id: string; guest: Session } | null = null;
  let installation: Promise<string> | null = null;
  const guestWork = new Set<Promise<unknown>>();
  let ending: Promise<void> | null = null;
  let guestRevision = 0;

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
    path, schema, method = 'GET', token, key, body, pdf = false, installationId,
  }: {
    path: string;
    schema: z.ZodType<T>;
    method?: 'POST' | 'GET' | 'PUT' | 'DELETE';
    token?: string;
    key?: string;
    body?: unknown;
    pdf?: boolean;
    installationId?: string;
  }): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = { Accept: (pdf ? PDF_MIME_TYPE : 'application/json') + ', application/problem+json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (key) headers['Idempotency-Key'] = key;
    if (installationId) headers['X-Installation-Id'] = installationId;
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
      if (response.status === 401 && (token || path === '/guest-sessions/refresh')) throw new GuestRejected();
      if (pdf && !response.ok) throw new ApiError(errorCode(response.status, null));
      if (pdf && response.status !== 200) invalidResponse();
      if ((method === 'DELETE' || path === '/guest-sessions/revoke') && response.ok && response.status !== 204) invalidResponse();
      const payload: unknown = pdf ? await readReceiptPdf(response) : response.status === 204 ? null : await response.json().catch(() => null);
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
    await writeSaved(sessionKey, JSON.stringify(session));
    return session;
  }

  async function writeSaved(key: string, value: string) {
    try {
      await storage.setItem(key, value);
    } catch {
      throw new ApiError('storage_unavailable');
    }
  }

  async function readSaved(key: string): Promise<string | null> {
    try {
      return await storage.getItem(key);
    } catch {
      throw new ApiError('storage_unavailable');
    }
  }

  function decodeSaved<T>(raw: string, schema: z.ZodType<T>): T {
    try {
      return schema.parse(JSON.parse(raw));
    } catch {
      throw new ApiError('storage_unavailable');
    }
  }

  function guestSnapshot(raw: string | null): string | null {
    return raw === null ? null : decodeSaved(raw, savedSession).sessionId ?? raw;
  }

  function matchesGuestSnapshot(raw: string | null, snapshot: string | null): boolean {
    if (raw === snapshot) return true;
    if (raw === null || snapshot === null) return false;
    const guest = decodeSaved(raw, savedSession);
    return paymentReturnOrderId(snapshot) ? guest.sessionId === snapshot : sameGuest(guest, decodeSaved(snapshot, savedSession));
  }

  async function renewGuest(existing: SavedSession, save: (guest: SavedSession) => Promise<unknown>): Promise<Session> {
    let pending = existing;
    if (existing.sessionId && !existing.rotationKey) {
      const rotationKey = newRotationKey();
      if (!paymentReturnOrderId(rotationKey)) throw new ApiError('storage_unavailable');
      pending = { ...existing, rotationKey };
      await save(pending);
    }
    const refreshed = await request({
      path: '/guest-sessions/refresh', method: 'POST', schema: sessionResponse, body: refreshInput(pending),
    });
    if (pending.rotationKey
      ? !pending.sessionId || refreshed.sessionId !== pending.sessionId || refreshed.refreshToken === pending.refreshToken
      : refreshed.refreshToken !== pending.refreshToken || (pending.sessionId && refreshed.sessionId !== pending.sessionId)) invalidResponse();
    if (Date.parse(refreshed.expiresAt) <= now() || Date.parse(refreshed.refreshExpiresAt) <= now()) invalidResponse();
    await save(refreshed);
    return refreshed;
  }

  function guestSession(rejectedAccessToken?: string): Promise<Session> {
    if (activation) return activation.catch(() => undefined).then(() => guestSession(rejectedAccessToken));
    if (sessionPromise) return sessionPromise;
    sessionPromise = (async () => {
      const raw = await readSaved(sessionKey);
      if (raw !== null) {
        const existing = decodeSaved(raw, savedSession);
        if (!existing.rotationKey && Date.parse(existing.expiresAt) > now() && existing.accessToken !== rejectedAccessToken) {
          return existing;
        }
        if (Date.parse(existing.refreshExpiresAt) > now()) {
          return renewGuest(existing, guest => writeSaved(sessionKey, JSON.stringify(guest)));
        }
      }
      // Never replace the identity behind a durable checkout with a fresh guest.
      if (rejectedAccessToken !== undefined || hasSavedCheckout(await readSaved(journalKey))) {
        throw new GuestRejected();
      }
      return durableSession(await request({ path: '/guest-sessions', method: 'POST', schema: sessionResponse }));
    })().finally(() => { sessionPromise = null; });
    return sessionPromise;
  }

  async function sendWithGuest<T>(options: Parameters<typeof request<T>>[0], guest: Session, retry: () => Promise<Session>): Promise<T> {
    try {
      return await request({ ...options, token: guest.accessToken });
    } catch (error) {
      if (!(error instanceof GuestRejected)) throw error;
      const updated = await retry();
      // A request started by the previous identity must not be repeated after recovery.
      if (!sameGuest(updated, guest)) throw error;
      return request({ ...options, token: updated.accessToken });
    }
  }

  async function hasGuestSessionEndPending() {
    return ending !== null || await readSaved(endKey) !== null;
  }

  function withGuestWork<T>(operation: () => Promise<T>): Promise<T> {
    const revision = guestRevision;
    const active = (async () => {
      if (await hasGuestSessionEndPending() || revision !== guestRevision) throw new ApiError('unauthenticated');
      const result = await operation();
      if (revision !== guestRevision) throw new ApiError('unauthenticated');
      return result;
    })();
    guestWork.add(active);
    return active.finally(() => { guestWork.delete(active); });
  }

  function primaryRequest<T>(options: Parameters<typeof request<T>>[0], expectedGuest?: Session) {
    return withGuestWork(async () => {
      const guest = await guestSession();
      if (expectedGuest && !sameGuest(guest, expectedGuest)) throw new ApiError('unauthenticated');
      const payload = await sendWithGuest(options, guest, () => guestSession(guest.accessToken));
      return { payload, guest };
    });
  }

  async function authorized<T>(options: Parameters<typeof request<T>>[0]): Promise<T> {
    return (await primaryRequest(options)).payload;
  }

  function queueRecovery<T>(operation: () => Promise<T>): Promise<T> {
    const queued = recoveryQueue;
    const revision = guestRevision;
    const next = withGuestWork(async () => {
      await queued;
      if (revision !== guestRevision) throw new ApiError('unauthenticated');
      return operation();
    });
    recoveryQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  async function loadRecovery(): Promise<RecoverySession | null> {
    if (pendingRecovery) return pendingRecovery;
    const raw = await readSaved(recoveryKey);
    return raw === null ? null : decodeSaved(raw, recoverySession.nullable());
  }

  async function saveRecovery(record: RecoverySession): Promise<void> {
    await writeSaved(recoveryKey, JSON.stringify(record));
    pendingRecovery = record;
  }

  async function sendRecovery<T>(options: Parameters<typeof request<T>>[0], record: RecoverySession): Promise<T> {
    async function renewRecovery() {
      if (Date.parse(record.guest.refreshExpiresAt) <= now()) throw new ApiError('unauthenticated');
      return renewGuest(record.guest, async guest => {
        await saveRecovery({ ...record, guest });
        record.guest = guest;
      });
    }
    if (record.guest.rotationKey) await renewRecovery();
    return sendWithGuest(options, record.guest, renewRecovery);
  }

  function activateRecovery(record: RecoverySession, orderId: string, observedOrder?: Order): Promise<boolean> {
    const reading = sessionPromise;
    activation = (async () => {
      await reading?.catch(() => undefined);
      const current = await readSaved(sessionKey);
      // The main write can succeed even when a storage response was lost.
      if (current !== null && sameGuest(decodeSaved(current, savedSession), record.guest)) return true;
      if (!matchesGuestSnapshot(current, record.previous)) return false;

      const raw = await readSaved(journalKey);
      let active;
      try { ({ active } = parseJournal(raw)); }
      catch { return false; }
      if (!active && observedOrder) return false;
      if (active) {
        if (active.phase === 'creating' || active.orderId !== orderId) return false;
        const snapshot = observedOrder ?? await sendRecovery({ path: orderPath(orderId), schema: orderResponse }, record)
          .then(order => checkedOrder(order, orderId)).catch(() => null);
        // A processing transaction may still settle after the pickup hold has expired.
        if (!snapshot || snapshot.paymentStatus === 'processing' || !canStartNewOrder(snapshot)) return false;
      }
      if (await readSaved(journalKey) !== raw || await readSaved(sessionKey) !== current) return false;
      await durableSession(record.guest);
      return true;
    })().then(async (activated) => {
      if (activated) {
        if (record.challengeId) primaryChallenge = { id: record.challengeId, guest: record.guest };
        pendingRecovery = null;
        await writeSaved(recoveryKey, 'null').catch(() => undefined);
      }
      return activated;
    }).finally(() => { activation = null; });
    return activation;
  }

  function withVerifiedRecovery<T>(orderId: string, error: unknown, read: (record: RecoverySession) => Promise<T>): Promise<T> {
    if (!(error instanceof GuestRejected) && !(error instanceof ApiError && error.code === 'not_found')) throw error;
    return queueRecovery(async () => {
      const record = await loadRecovery();
      if (!record?.grants.includes(orderId)) throw error;
      return read(record);
    });
  }

  function pickupAlertPath(orderId: string) {
    if (!paymentReturnOrderId(orderId)) throw new ApiError('invalid_input');
    return orderPath(orderId) + '/pickup-alert';
  }

  function pickupInstallation(): Promise<string> {
    installation ??= withGuestWork(async () => {
      const saved = await readSaved(installationKey);
      const id = paymentReturnOrderId(saved ?? newInstallationId?.());
      if (!id) throw new ApiError('storage_unavailable');
      if (saved === null) await writeSaved(installationKey, id);
      return id;
    }).catch(error => {
      installation = null;
      throw error;
    });
    return installation;
  }

  return {
    hasGuestSessionEndPending,
    endGuestSession() {
      if (ending) return ending;
      guestRevision++;
      ending = (async () => {
        await Promise.allSettled(guestWork);
        await writeSaved(endKey, 'pending');
        const raw = await readSaved(sessionKey);
        const recovery = await loadRecovery();
        const primary = raw === null ? null : decodeSaved(raw, savedSession);
        for (const guest of [primary, recovery?.guest]) {
          if (guest) await request({ path: '/guest-sessions/revoke', method: 'POST', schema: z.null(), body: refreshInput(guest) });
        }
        pendingRecovery = null;
        primaryChallenge = null;
        installation = null;
        try {
          for (const key of [sessionKey, recoveryKey, installationKey, journalKey, endKey]) await storage.removeItem(key);
        } catch {
          throw new ApiError('storage_unavailable');
        }
      })().finally(() => { ending = null; });
      return ending;
    },
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
      const options = { path: orderPath(orderId), schema: orderResponse };
      try {
        return checkedOrder(await authorized(options), orderId);
      } catch (error) {
        return withVerifiedRecovery(orderId, error, async (record) => {
          const order = checkedOrder(await sendRecovery(options, record), orderId);
          // An unavailable local session write must not hide an already verified order.
          const activated = await activateRecovery(record, orderId, order).catch(() => false);
          return activated ? order : { ...order, recoveryReadOnly: true };
        });
      }
    },
    async getReceiptPdf(orderId) {
      if (!paymentReturnOrderId(orderId)) throw new ApiError('invalid_input');
      const options = { path: receiptPath(orderId), schema: z.instanceof(Uint8Array), pdf: true };
      try {
        return await authorized(options);
      } catch (error) {
        return withVerifiedRecovery(orderId, error, (record) => sendRecovery(options, record));
      }
    },
    async reorder(orderId) {
      return authorized({ path: orderPath(orderId) + '/reorder', method: 'POST', schema: reorderResponse });
    },
    requestOrderAccess(input) {
      return queueRecovery(async () => {
        const options = { path: '/order-access/challenges', method: 'POST', schema: orderAccessChallenge, body: input } as const;
        const before = await readSaved(sessionKey);
        try {
          const result = await primaryRequest(options);
          primaryChallenge = { id: result.payload.challengeId, guest: result.guest };
          return result.payload;
        } catch (error) {
          if (!(error instanceof GuestRejected)) throw error;
        }

        const previous = await readSaved(sessionKey);
        if (!matchesGuestSnapshot(previous, guestSnapshot(before))) {
          throw new ApiError('unauthenticated');
        }
        const saved = await loadRecovery();
        const reusable = saved && matchesGuestSnapshot(previous, saved.previous)
          && Date.parse(saved.guest.refreshExpiresAt) > now() ? saved : null;
        const guest = reusable?.guest ?? await request({ path: '/guest-sessions', method: 'POST', schema: sessionResponse });
        const provisional = { guest, previous: guestSnapshot(previous), challengeId: null, grants: reusable?.grants ?? [] };
        await saveRecovery(provisional);
        const result = await sendRecovery(options, provisional);
        const challenge = { ...provisional, challengeId: result.challengeId };
        pendingRecovery = challenge;
        // The guest is already saved. If this write fails the open prompt can still use it.
        await saveRecovery(challenge).catch(() => undefined);
        return result;
      });
    },
    verifyOrderAccess(challengeId, code) {
      const path = '/order-access/challenges/' + encodeURIComponent(challengeId) + '/verify';
      const options = { path, method: 'POST', schema: orderAccessGrant, body: { code } } as const;
      return queueRecovery(async () => {
        if (primaryChallenge?.id === challengeId) {
          return (await primaryRequest(options, primaryChallenge.guest)).payload;
        }
        const record = await loadRecovery();
        if (record?.challengeId !== challengeId) return authorized(options);

        const grant = await sendRecovery(options, record);
        const granted = { ...record, grants: [grant.orderId, ...record.grants.filter(id => id !== grant.orderId)].slice(0, 10) };
        await saveRecovery(granted);
        await activateRecovery(granted, grant.orderId);
        return grant;
      });
    },
    ...(config.profile !== 'local' && paymentReturnOrderId(config.pushProjectId) && newInstallationId ? {
      pickupAlerts: {
        async get(orderId: string) {
          const path = pickupAlertPath(orderId);
          return authorized({ path, schema: pickupAlertStatus, installationId: await pickupInstallation() });
        },
        async enable(orderId: string, token: string, locale: Locale) {
          const path = pickupAlertPath(orderId);
          if (!expoPushTokenPattern.test(token) || (locale !== 'en' && locale !== 'rw')) throw new ApiError('invalid_input');
          return authorized({ path, method: 'PUT', schema: pickupAlertStatus, installationId: await pickupInstallation(), body: { token, locale } });
        },
        async disable(orderId: string) {
          const path = pickupAlertPath(orderId);
          await authorized({ path, method: 'DELETE', schema: z.null(), installationId: await pickupInstallation() });
        },
      },
    } : {}),
    ...(config.profile === 'local' ? {
      async settleLocalTestPayment(orderId: string, attemptId: string, status: 'paid' | 'declined') {
        const path = '/local' + orderPath(orderId) + '/payments/' + encodeURIComponent(attemptId) + '/result';
        return checkedOrder(await authorized({ path, method: 'POST', schema: orderResponse, body: { status } }), orderId);
      },
    } : {}),
  };
}
