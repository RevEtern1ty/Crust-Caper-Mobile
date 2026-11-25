import { CryptoDigestAlgorithm, digestStringAsync, randomUUID } from 'expo-crypto';
import { useFocusEffect } from 'expo-router';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { PropsWithChildren } from 'react';
import { AppState } from 'react-native';

import { DEMO_PHONE } from '../domain/demo-api';
import { ApiError, type CartLine, type Order, type Quote } from '../domain/types';
import { privateStorage } from '../state/private-storage';
import { useShop } from '../state/shop';
import { CheckoutController, CheckoutError, type CheckoutContact, type CheckoutJournal } from './controller';

type Context = {
  journal: CheckoutJournal | null;
  restoreFailed: boolean;
  busy: boolean;
  retryRestore: () => Promise<void>;
  beginCheckout: (quote: Quote, cart: CartLine[], contact: CheckoutContact) => Promise<Order>;
  resumeCheckout: (retryDeclined?: boolean, contact?: CheckoutContact) => Promise<Order>;
};

const CheckoutContext = createContext<Context | null>(null);

function fingerprint(cart: CartLine[]) {
  return digestStringAsync(CryptoDigestAlgorithm.SHA256, JSON.stringify(cart));
}

export function CheckoutProvider({ children }: PropsWithChildren) {
  const { api, demoApi, checkoutStorageKey, cart, clearCart } = useShop();
  const cartRef = useRef(cart);
  const clearCartRef = useRef(clearCart);
  const running = useRef(false);
  const [journal, setJournal] = useState<CheckoutJournal | null>(null);
  const [restoreFailed, setRestoreFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    cartRef.current = cart;
    clearCartRef.current = clearCart;
  }, [cart, clearCart]);

  const controller = useMemo(() => new CheckoutController({
    api,
    storage: privateStorage,
    storageKey: checkoutStorageKey,
    newKey: randomUUID,
    demoContact: demoApi ? { phone: DEMO_PHONE } : undefined,
    allowMissingDemoOrders: !!demoApi,
    listDemoOrderRefs: demoApi ? (limit) => demoApi.listDemoOrderRefs(limit) : undefined,
    onOrderCreated: async (expected) => {
      const current = cartRef.current;
      if (await fingerprint(current) === expected) {
        await clearCartRef.current(current);
      }
    },
  }), [api, checkoutStorageKey, demoApi]);

  useEffect(() => {
    let active = true;
    void controller.restore().then((saved) => {
      if (active) {
        setJournal(saved);
        setRestoreFailed(false);
      }
    }, () => {
      if (active) setRestoreFailed(true);
    });
    return () => { active = false; };
  }, [controller]);

  const run = useCallback(async (operation: () => Promise<Order>) => {
    if (running.current) throw new CheckoutError('active_checkout');

    running.current = true;
    setBusy(true);
    try {
      return await operation();
    } finally {
      setJournal(controller.snapshot);
      setBusy(false);
      running.current = false;
    }
  }, [controller]);

  const value: Context = {
    journal,
    restoreFailed,
    busy,
    retryRestore: async () => {
      setRestoreFailed(false);
      try {
        setJournal(await controller.restore());
      } catch {
        setRestoreFailed(true);
      }
    },
    beginCheckout: (quote, snapshot, contact) => run(async () => controller.begin(quote, await fingerprint(snapshot), contact)),
    resumeCheckout: (retryDeclined, contact) => run(() => controller.resume(retryDeclined, contact)),
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

const statusRefreshMs = 3000;
const maxPolls = 8;

export function useOrderStatus(orderId: string | null) {
  const { api, mode } = useShop();
  const [known, setKnown] = useState<Order | null>(null);
  const [failure, setFailure] = useState<{ orderId: string; error: unknown } | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const version = useRef(0);

  const refresh = useCallback(async (silent = false) => {
    if (!orderId) return null;

    const request = ++version.current;
    if (!silent) setLoadingId(orderId);
    try {
      const order = await api.getOrder(orderId);
      if (request === version.current) {
        setKnown(order);
        setFailure(null);
      }
      return order;
    } catch (error) {
      if (request === version.current) {
        setFailure({ orderId, error });
        if (error instanceof ApiError && (error.code === 'unauthenticated' || error.code === 'not_found')) {
          setKnown(null);
        }
      }
      return null;
    } finally {
      if (request === version.current) setLoadingId(null);
    }
  }, [api, orderId]);

  useFocusEffect(useCallback(() => {
    if (!orderId) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let cycle = 0;

    async function poll(pollCycle: number, count: number) {
      const order = await refresh(count > 0);
      if (pollCycle !== cycle) return;

      const inKitchen = order?.status === 'accepted' || order?.status === 'preparing';
      if (mode === 'connected' && inKitchen) {
        timer = setTimeout(() => { void poll(pollCycle, 1); }, 5000);
        return;
      }

      if (count < maxPolls && (!order || order.paymentStatus === 'processing' || inKitchen)) {
        timer = setTimeout(() => { void poll(pollCycle, count + 1); }, statusRefreshMs);
      }
    }

    function start() {
      clearTimeout(timer);
      void poll(++cycle, 0);
    }

    function stop() {
      cycle++;
      version.current++;
      clearTimeout(timer);
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
    refresh,
  };
}
