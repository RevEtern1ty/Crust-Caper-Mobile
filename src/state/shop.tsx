import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
} from 'react';
import type { PropsWithChildren } from 'react';
import { AppState } from 'react-native';
import { createDemoApi } from '../domain/demo-api';
import type { CartLine, Locale, Menu } from '../domain/types';

const DRAFT_KEY = 'crustcaper.draft.v1';
const MENU_KEY = 'crustcaper.menu.v1';
export const MAX_QUANTITY = 9;
const api = createDemoApi({ storage: AsyncStorage, newId: randomUUID });

type Draft = { locale: Locale; cart: CartLine[] };
type MenuStatus = 'loading' | 'ready' | 'stale' | 'unavailable';

function readDraft(raw: string | null): Draft {
  const fallback: Draft = { locale: 'en', cart: [] };
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw) as Partial<Draft>;
    const cart = Array.isArray(value.cart) ? value.cart.filter(line =>
      line && typeof line.sku === 'string' && Array.isArray(line.modifierIds)
      && line.modifierIds.every(id => typeof id === 'string')
      && Number.isSafeInteger(line.quantity) && line.quantity > 0 && line.quantity <= MAX_QUANTITY
      && Number.isSafeInteger(line.unitPrice) && line.unitPrice >= 0,
    ) : [];
    return { locale: value.locale === 'rw' ? 'rw' : 'en', cart };
  } catch {
    return fallback;
  }
}

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

export function lineKey(line: Pick<CartLine, 'sku' | 'modifierIds'>) {
  return JSON.stringify([line.sku, [...line.modifierIds].sort()]);
}

type Shop = Draft & {
  api: ReturnType<typeof createDemoApi>;
  menu: Menu | null;
  status: MenuStatus;
  refreshing: boolean;
  hydrated: boolean;
  total: number;
  count: number;
  setLocale: (locale: Locale) => void;
  addLine: (line: CartLine) => void;
  setQuantity: (key: string, quantity: number) => void;
  editLine: (key: string, line: CartLine) => void;
  replaceCart: (lines: CartLine[]) => void;
  clearCart: (snapshot?: CartLine[]) => Promise<void>;
  refreshMenu: () => Promise<void>;
};

const ShopContext = createContext<Shop | null>(null);

export function ShopProvider({ children }: PropsWithChildren) {
  const [draft, setDraft] = useState<Draft>({ locale: 'en', cart: [] });
  const currentDraft = useRef(draft);
  const writeQueue = useRef(Promise.resolve());
  const [hydrated, setHydrated] = useState(false);
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
      setStatus('ready');
      return AsyncStorage.setItem(MENU_KEY, JSON.stringify(next)).catch(() => undefined);
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
    void AsyncStorage.multiGet([DRAFT_KEY, MENU_KEY]).then(entries => {
      if (!active) return;
      currentDraft.current = readDraft(entries[0]?.[1] ?? null);
      setDraft(currentDraft.current);
      const cached = readMenu(entries[1]?.[1] ?? null);
      if (cached && !cachedMenu.current) {
        cachedMenu.current = cached;
        setMenu(cached);
        setStatus('stale');
      }
    }).catch(() => undefined).finally(() => {
      if (!active) return;
      setHydrated(true);
      void refreshMenu();
    });
    const handle = AppState.addEventListener('change', state => {
      if (state === 'active') void refreshMenu();
    });
    return () => {
      active = false;
      handle.remove();
    };
  }, [refreshMenu]);

  const updateDraft = useCallback((update: (current: Draft) => Draft, durable = false) => {
    const previous = currentDraft.current;
    const next = update(previous);
    currentDraft.current = next;
    setDraft(next);
    const write = writeQueue.current.then(() => AsyncStorage.setItem(DRAFT_KEY, JSON.stringify(next)));
    writeQueue.current = write.catch(() => undefined);
    if (!durable) return writeQueue.current;
    return write.catch(error => {
      if (currentDraft.current === next) {
        currentDraft.current = previous;
        setDraft(previous);
      }
      throw error;
    });
  }, []);

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
  const setQuantity = (key: string, quantity: number) => updateDraft(current => ({
    ...current,
    cart: current.cart.flatMap(item => {
      if (lineKey(item) !== key) return [item];
      return quantity <= 0 ? [] : [{ ...item, quantity: Math.min(MAX_QUANTITY, quantity) }];
    }),
  }));
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
  const clearCart = useCallback((snapshot?: CartLine[]) => updateDraft(current => {
    if (!snapshot) return { ...current, cart: [] };
    const quantities = new Map(snapshot.map(item => [lineKey(item), item.quantity]));
    const cart = current.cart.flatMap(item => {
      const quantity = item.quantity - (quantities.get(lineKey(item)) ?? 0);
      return quantity > 0 ? [{ ...item, quantity }] : [];
    });
    return { ...current, cart };
  }, true), [updateDraft]);

  const total = draft.cart.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0);
  const count = draft.cart.reduce((sum, line) => sum + line.quantity, 0);
  return (
    <ShopContext.Provider value={{
      ...draft, api, menu, status, refreshing, hydrated, total, count,
      setLocale, addLine, setQuantity, editLine, replaceCart, clearCart, refreshMenu,
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
