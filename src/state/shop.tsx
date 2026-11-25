import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { randomUUID } from 'expo-crypto';
import { fetch as expoFetch } from 'expo/fetch';
import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
} from 'react';
import type { PropsWithChildren } from 'react';
import { AppState, Platform } from 'react-native';
import { CHECKOUT_JOURNAL_KEY } from '../checkout/controller';
import { lineKey } from '../domain/cart';
import { createDemoApi } from '../domain/demo-api';
import type { CartLine, DemoApi, Locale, Menu, ShopApi } from '../domain/types';
import { createLiveApi, type ConnectedConfig, type LiveShopApi } from '../live/http-api';
import { MAX_QUANTITY, type Draft } from './draft-storage';
import { privateStorage } from './private-storage';
import { useShopDraft } from './use-shop-draft';

export { lineKey } from '../domain/cart';
export { MAX_QUANTITY } from './draft-storage';

const settings = Constants.expoConfig?.extra?.restaurant as ConnectedConfig | { profile: 'demo' } | undefined;
if (!settings || !['demo', 'local', 'stage', 'production'].includes(settings.profile)) {
  throw new Error('CrustCaper runtime profile is missing.');
}
const connected = settings.profile !== 'demo' ? settings : null;
const runtimeScope = connected ? [
  connected.profile, new URL(connected.apiBaseUrl).hostname, new URL(connected.apiBaseUrl).port || '443', connected.storeId,
].join('.') : null;
const checkoutStorageKey = runtimeScope ? CHECKOUT_JOURNAL_KEY + '.' + runtimeScope : CHECKOUT_JOURNAL_KEY;
const menuKey = runtimeScope ? 'crustcaper.menu.v1.' + runtimeScope : 'crustcaper.menu.v1';
const demoStorage = Platform.OS === 'web' ? {
  async getItem(key: string) {
    const saved = await privateStorage.getItem(key);
    if (saved !== null || await privateStorage.getItem(CHECKOUT_JOURNAL_KEY) === null) return saved;

    // Migrate the previous browser ledger only for a tab with a checkout journal.
    const legacy = await AsyncStorage.getItem(key);
    if (legacy !== null) await privateStorage.setItem(key, legacy);
    return legacy;
  },
  setItem: privateStorage.setItem,
} : AsyncStorage;
const demoApi = connected ? null : createDemoApi({ storage: demoStorage, newId: randomUUID });
const liveApi = connected ? createLiveApi({
  config: connected,
  storage: privateStorage,
  journalKey: checkoutStorageKey,
  // The React Native XHR-backed fetch does not enforce RequestInit.redirect.
  fetcher: Platform.OS === 'web' ? undefined : expoFetch,
}) : null;
const api: ShopApi = liveApi ?? demoApi!;

type MenuStatus = 'loading' | 'ready' | 'stale' | 'unavailable';

function readMenu(raw: string | null): Menu | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Menu;
    const localized = (text: { en: string; rw: string }) =>
      typeof text?.en === 'string' && typeof text?.rw === 'string';
    const validPrice = (price: number) => Number.isSafeInteger(price) && price >= 0;
    const validTime = (time: string) => typeof time === 'string' && Number.isFinite(Date.parse(time));
    if (!value?.store || typeof value.store.open !== 'boolean'
      || typeof value.store.id !== 'string' || !localized(value.store.name)
      || !localized(value.store.area) || !localized(value.store.hours)
      || typeof value.version !== 'string' || !validTime(value.updatedAt)) return null;
    if (!Array.isArray(value.slots) || !value.slots.every(slot =>
      slot && typeof slot.id === 'string' && typeof slot.available === 'boolean'
      && validTime(slot.startsAt) && validTime(slot.endsAt))) return null;
    if (!Array.isArray(value.products) || !value.products.every(product =>
      product && typeof product.sku === 'string' && typeof product.available === 'boolean'
      && typeof product.category === 'string' && localized(product.name) && localized(product.description)
      && validPrice(product.price) && Array.isArray(product.ingredients) && product.ingredients.every(localized)
      && Array.isArray(product.allergens) && product.allergens.every(localized)
      && Array.isArray(product.modifiers) && product.modifiers.every(modifier =>
        modifier && typeof modifier.id === 'string' && localized(modifier.name) && validPrice(modifier.price)))) return null;
    return value;
  } catch {
    return null;
  }
}

type Shop = Draft & {
  mode: 'demo' | 'connected';
  api: ShopApi;
  demoApi: DemoApi | null;
  settleLocalTestPayment: LiveShopApi['settleLocalTestPayment'];
  checkoutStorageKey: string;
  checkoutAllowed: boolean;
  fixturePhotos: boolean;
  menu: Menu | null;
  status: MenuStatus;
  refreshing: boolean;
  hydrated: boolean;
  draftSaving: boolean;
  draftStorageError: 'read' | 'write' | null;
  retryDraftStorage: () => Promise<void>;
  total: number;
  count: number;
  setLocale: (locale: Locale) => void;
  addLine: (line: CartLine) => void;
  changeQuantity: (key: string, delta: -1 | 1) => void;
  editLine: (key: string, line: CartLine) => void;
  replaceCart: (lines: CartLine[]) => void;
  clearCart: (snapshot: CartLine[]) => Promise<void>;
  refreshMenu: () => Promise<void>;
};

const ShopContext = createContext<Shop | null>(null);

export function ShopProvider({ children }: PropsWithChildren) {
  const { draft, hydrated, draftSaving, draftStorageError, retryDraftStorage, updateDraft } = useShopDraft(runtimeScope);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [status, setStatus] = useState<MenuStatus>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const cachedMenu = useRef<Menu | null>(null);
  const request = useRef<Promise<void> | null>(null);

  const refreshMenu = useCallback(() => {
    if (request.current) return request.current;
    setRefreshing(true);
    const load = api.getMenu().then(next => {
      cachedMenu.current = next;
      setMenu(next);
      setStatus(next.orderingUnavailable ? 'stale' : 'ready');
      return AsyncStorage.setItem(menuKey, JSON.stringify(next)).catch(() => undefined);
    }, () => {
      setStatus(cachedMenu.current ? 'stale' : 'unavailable');
    }).finally(() => {
      setRefreshing(false);
      request.current = null;
    });
    request.current = load;
    return load;
  }, []);

  useEffect(() => {
    let active = true;
    void AsyncStorage.getItem(menuKey).catch(() => null).then(rawMenu => {
      if (!active) return;
      const cached = readMenu(rawMenu);
      if (cached && !cachedMenu.current) {
        cachedMenu.current = cached;
        setMenu(cached);
        setStatus('stale');
      }
    }).finally(() => {
      if (active) void refreshMenu();
    });
    const handle = AppState.addEventListener('change', state => {
      if (state === 'active') void refreshMenu();
    });
    return () => {
      active = false;
      handle.remove();
    };
  }, [refreshMenu]);

  const setLocale = (locale: Locale) => updateDraft(current => ({ ...current, locale }));
  const replaceCart = (cart: CartLine[]) => updateDraft(current => ({ ...current, cart }));
  const addLine = (line: CartLine) => updateDraft(current => {
    const key = lineKey(line);
    const existing = current.cart.find(item => lineKey(item) === key);
    const cart = existing
      ? current.cart.map(item => lineKey(item) === key
        ? { ...line, quantity: Math.min(MAX_QUANTITY, existing.quantity + line.quantity) }
        : item)
      : [...current.cart, line];
    return { ...current, cart };
  });
  const changeQuantity = (key: string, delta: -1 | 1) => updateDraft(current => {
    const target = current.cart.find(item => lineKey(item) === key);
    if (!target) return current;
    const quantity = Math.min(MAX_QUANTITY, target.quantity + delta);
    if (quantity === target.quantity) return current;
    const cart = quantity <= 0 ? current.cart.filter(item => item !== target)
      : current.cart.map(item => item === target ? { ...item, quantity } : item);
    return { ...current, cart };
  });
  const editLine = (key: string, line: CartLine) => updateDraft(current => {
    const target = current.cart.find(item => lineKey(item) === key);
    if (!target) return current;
    const nextKey = lineKey(line);
    const remaining = current.cart.filter(item => lineKey(item) !== key);
    const match = remaining.find(item => lineKey(item) === nextKey);
    if (match && match.quantity + target.quantity > MAX_QUANTITY) return current;
    const quantity = target.quantity + (match?.quantity ?? 0);
    return {
      ...current,
      cart: [...remaining.filter(item => lineKey(item) !== nextKey), { ...line, quantity }],
    };
  });
  const clearCart = useCallback((snapshot: CartLine[]) => updateDraft(current => {
    return current.cart === snapshot ? { ...current, cart: [] } : current;
  }, true), [updateDraft]);

  const total = draft.cart.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
  const count = draft.cart.reduce((sum, line) => sum + line.quantity, 0);
  return (
    <ShopContext.Provider value={{
      ...draft, api, demoApi, settleLocalTestPayment: liveApi?.settleLocalTestPayment,
      checkoutStorageKey, mode: connected ? 'connected' : 'demo',
      checkoutAllowed: !connected || connected.profile === 'local' || Platform.OS !== 'web',
      fixturePhotos: !connected || connected.profile === 'local',
      menu, status, refreshing, hydrated, draftSaving, draftStorageError, retryDraftStorage, total, count,
      setLocale, addLine, changeQuantity, editLine, replaceCart, clearCart, refreshMenu,
    }}>
      {children}
    </ShopContext.Provider>
  );
}

export function useShop() {
  const value = useContext(ShopContext);
  if (!value) throw new Error('useShop requires ShopProvider');
  return value;
}
