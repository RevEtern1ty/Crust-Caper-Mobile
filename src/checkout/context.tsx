import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from 'expo-crypto';
import { useFocusEffect } from 'expo-router';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { PropsWithChildren } from 'react';
import { AppState } from 'react-native';

import { DEMO_PHONE } from '../domain/demo-api';
import { ApiError, type CartLine, type Order, type PendingCheckoutRecovery, type Quote } from '../domain/types';
import { privateStorage } from '../state/private-storage';
import { useShop } from '../state/shop';
import { CheckoutController, CheckoutError, type CheckoutContact, type CheckoutJournal } from './controller';
import { delayedPaymentThresholdMs, nextOrderStatusDelay, nextUncertainPaymentStart, type OrderStatusResult } from './order-status-polling';
import { isExpiredUnpaidHold } from './pickup-hold';

type Context = {
  journal: CheckoutJournal | null;
  requestedOrderId: string | null;
  setRequestedOrderId: (orderId: string | null) => void;
  restoreFailed: boolean;
  busy: boolean;
  guestSessionEndPending: boolean;
  guestSessionRevision: number;
  endGuestSession?: () => Promise<void>;
  retryRestore: () => Promise<void>;
  beginCheckout: (quote: Quote, cart: CartLine[], contact: CheckoutContact) => Promise<Order>;
  resumeCheckout: (retryDeclined?: boolean, contact?: CheckoutContact) => Promise<Order>;
  finishExpiredHold: (order: Order) => Promise<void>;
  rememberRecoveredOrder: (orderId: string, sessionRevision: number) => Promise<void>;
  pendingOrderRecoveryChallengeId: string | null;
  requestPendingOrderRecovery?: (phone: string) => Promise<PendingCheckoutRecovery>;
  confirmPendingOrderRecovery?: (challengeId: string, code: string) => Promise<Order>;
};

const CheckoutContext = createContext<Context | null>(null);

function fingerprint(cart: CartLine[]) {
  return digestStringAsync(CryptoDigestAlgorithm.SHA256, JSON.stringify(cart));
}

export function CheckoutProvider({ children }: PropsWithChildren) {
  const { api, demoApi, guestSession, checkoutStorageKey, cart, clearCart, webCheckout } = useShop();
  const cartRef = useRef(cart);
  const clearCartRef = useRef(clearCart);
  const running = useRef(false);
  const [journal, setJournal] = useState<CheckoutJournal | null>(null);
  const [requestedOrderId, setRequestedOrderId] = useState<string | null>(null);
  const [restoreFailed, setRestoreFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [endingGuestSession, setEndingGuestSession] = useState(false);
  const [guestSessionEndPending, setGuestSessionEndPending] = useState(false);

  useEffect(() => {
    cartRef.current = cart;
    clearCartRef.current = clearCart;
  }, [cart, clearCart]);

  const controller = useMemo(() => new CheckoutController({
    api,
    storage: privateStorage,
    storageKey: checkoutStorageKey,
    newKey: randomUUID,
    guestSession,
    demoContact: demoApi ? { phone: DEMO_PHONE } : undefined,
    allowMissingDemoOrders: !!demoApi,
    listDemoOrderRefs: demoApi ? (limit) => demoApi.listDemoOrderRefs(limit) : undefined,
    onOrderCreated: async (expected) => {
      const current = cartRef.current;
      if (await fingerprint(current) === expected) {
        await clearCartRef.current(current);
      }
    },
  }), [api, checkoutStorageKey, demoApi, guestSession]);

  const publishJournal = useCallback((saved: CheckoutJournal) => {
    setJournal(saved);
    setGuestSessionEndPending(controller.guestSessionEndPending);
    if (controller.guestSessionEndPending) setRequestedOrderId(null);
  }, [controller]);

  useEffect(() => {
    let active = true;
    void controller.restore().then((saved) => {
      if (active) {
        publishJournal(saved);
        setRestoreFailed(false);
      }
    }, () => {
      if (active) setRestoreFailed(true);
    });
    return () => { active = false; };
  }, [controller, publishJournal]);

  const run = useCallback(async <Result,>(operation: () => Promise<Result>) => {
    if (running.current) throw new CheckoutError('active_checkout');

    running.current = true;
    setBusy(true);
    try {
      return await operation();
    } finally {
      publishJournal(controller.snapshot);
      setBusy(false);
      running.current = false;
    }
  }, [controller, publishJournal]);

  const finishExpiredHold = useCallback(async (order: Order) => {
    const active = controller.snapshot.active;
    if (active?.phase !== 'paying' || active.orderId !== order.id || order.recoveryReadOnly || !isExpiredUnpaidHold(order)) return;
    await run(() => controller.finishExpiredHold(order));
  }, [controller, run]);

  const value: Context = {
    journal: endingGuestSession ? null : journal,
    requestedOrderId: endingGuestSession ? null : requestedOrderId,
    setRequestedOrderId,
    restoreFailed,
    busy,
    guestSessionEndPending,
    guestSessionRevision: controller.guestSessionRevision,
    endGuestSession: guestSession ? () => run(async () => {
      setEndingGuestSession(true);
      try {
        await controller.endGuestSession();
        setRequestedOrderId(null);
      } finally {
        setEndingGuestSession(false);
      }
    }) : undefined,
    retryRestore: async () => {
      setRestoreFailed(false);
      try {
        publishJournal(await controller.restore());
      } catch {
        setRestoreFailed(true);
      }
    },
    beginCheckout: (quote, snapshot, contact) => run(async () => controller.begin(quote, await fingerprint(snapshot), contact)),
    resumeCheckout: (retryDeclined, contact) => run(() => controller.resume(retryDeclined, contact)),
    finishExpiredHold,
    rememberRecoveredOrder: (orderId, sessionRevision) => run(() => controller.rememberRecoveredOrder(orderId, sessionRevision)),
    pendingOrderRecoveryChallengeId: journal?.active?.phase === 'creating' ? journal.active.recoveryChallengeId ?? null : null,
    requestPendingOrderRecovery: webCheckout && api.requestPendingCheckoutRecovery
      ? (phone) => run(() => controller.requestPendingOrderRecovery(phone)) : undefined,
    confirmPendingOrderRecovery: webCheckout && api.verifyPendingCheckoutRecovery
      ? (challengeId, code) => run(() => controller.confirmPendingOrderRecovery(challengeId, code)) : undefined,
  };

  return <CheckoutContext.Provider value={value}>{children}</CheckoutContext.Provider>;
}

export function useCheckout() {
  const context = useContext(CheckoutContext);
  if (!context) throw new Error('CheckoutProvider is missing');

  return context;
}

export function useRouteActionGuard() {
  const revision = useRef(0);
  useFocusEffect(useCallback(() => () => { revision.current++; }, []));

  return () => {
    const started = revision.current;
    return () => revision.current === started;
  };
}

type StatusPolling = {
  orderId: string;
  clearTimer: () => void;
  onResult: (result: OrderStatusResult) => void;
};

export function useOrderStatus(orderId: string | null) {
  const { api, mode, pickupNow } = useShop();
  const { finishExpiredHold } = useCheckout();
  const [known, setKnown] = useState<Order | null>(null);
  const [failure, setFailure] = useState<{ orderId: string; error: unknown } | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [delayedPaymentId, setDelayedPaymentId] = useState<string | null>(null);
  const version = useRef(0);
  const pending = useRef<Promise<Order | null> | null>(null);
  const polling = useRef<StatusPolling | null>(null);
  const pickupClock = useRef(pickupNow);

  useEffect(() => { pickupClock.current = pickupNow; }, [pickupNow]);

  const refresh = useCallback((silent = false) => {
    const monitor = polling.current;
    if (!orderId || monitor?.orderId !== orderId) return Promise.resolve(null);

    monitor.clearTimer();
    const request = ++version.current;
    if (!silent) setLoadingId(orderId);

    const earlierRequest = pending.current;
    const read = async () => {
      // A manual status check must see a fresh response after any earlier poll.
      await earlierRequest;
      if (request !== version.current) return null;
      try {
        const order = await api.getOrder(orderId);
        if (request !== version.current) return null;
        setKnown(order);
        setFailure(null);
        monitor.onResult({ order });
        if (isExpiredUnpaidHold(order)) {
          // A reordered basket can retry the local journal transition if this best-effort write fails.
          void finishExpiredHold(order).catch(() => undefined);
        }
        return order;
      } catch (error) {
        if (request !== version.current) return null;
        setFailure({ orderId, error });
        if (error instanceof ApiError && (error.code === 'unauthenticated' || error.code === 'not_found')) {
          setKnown(null);
        }
        monitor.onResult({ error });
        return null;
      } finally {
        if (request === version.current) setLoadingId(null);
      }
    };
    const latest = read();
    pending.current = latest;
    return latest.finally(() => {
      if (pending.current === latest) pending.current = null;
    });
  }, [api, finishExpiredHold, orderId]);

  useFocusEffect(useCallback(() => {
    if (!orderId) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let consecutiveFailures = 0;
    let uncertainSince: number | null = null;
    const monitor: StatusPolling = {
      orderId,
      clearTimer: () => clearTimeout(timer),
      onResult: (result) => {
        if (polling.current !== monitor) return;
        consecutiveFailures = 'error' in result ? consecutiveFailures + 1 : 0;
        const observedAt = performance.now();
        uncertainSince = mode === 'connected' ? nextUncertainPaymentStart(result, uncertainSince, observedAt) : null;
        const uncertainFor = uncertainSince === null ? null : observedAt - uncertainSince;
        setDelayedPaymentId(uncertainFor !== null && uncertainFor >= delayedPaymentThresholdMs ? orderId : null);
        const delay = nextOrderStatusDelay(mode, result, ++attempts, consecutiveFailures, pickupClock.current(), uncertainFor);
        if (delay !== null) timer = setTimeout(() => { void refresh(true); }, delay);
      },
    };

    function start() {
      if (polling.current === monitor) return;
      attempts = 0;
      consecutiveFailures = 0;
      uncertainSince = null;
      setDelayedPaymentId(null);
      polling.current = monitor;
      void refresh();
    }

    function stop() {
      if (polling.current === monitor) {
        polling.current = null;
        version.current++;
      }
      monitor.clearTimer();
    }

    if (AppState.currentState !== 'background' && AppState.currentState !== 'inactive') start();

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') start();
      else stop();
    });
    return () => {
      stop();
      subscription.remove();
    };
  }, [mode, orderId, refresh]));

  return {
    order: known?.id === orderId ? known : null,
    failed: failure !== null && failure.orderId === orderId,
    error: failure?.orderId === orderId ? failure.error : null,
    loading: loadingId !== null && loadingId === orderId,
    delayedPayment: delayedPaymentId !== null && delayedPaymentId === orderId,
    refresh,
  };
}
