import type { CartLine, Locale } from '../domain/types';

export const DRAFT_KEY = 'crustcaper.draft.v1';
export const MAX_QUANTITY = 9;
const LOCALE_KEY = 'crustcaper.locale.v1';

export type Draft = { locale: Locale; cart: CartLine[] };
type BrowserStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type GetSharedStorage = () => BrowserStorage;

export function readDraft(raw: string | null): Draft {
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

function trySharedStorage<Result>(getShared: GetSharedStorage, operation: (storage: BrowserStorage) => Result): Result | null {
  try {
    return operation(getShared());
  } catch {
    // Browser settings and storage quotas can block shared preferences independently of the tab cart.
    return null;
  }
}

export function readBrowserLocale(getShared: GetSharedStorage): Locale | null {
  const locale = trySharedStorage(getShared, shared => shared.getItem(LOCALE_KEY));
  return locale === 'en' || locale === 'rw' ? locale : null;
}

export function readBrowserDraft(tab: BrowserStorage, getShared: GetSharedStorage): Draft {
  const tabDraft = tab.getItem(DRAFT_KEY);
  const legacyDraft = tabDraft === null ? trySharedStorage(getShared, shared => shared.getItem(DRAFT_KEY)) : null;
  const draft = readDraft(tabDraft ?? legacyDraft);
  const locale = readBrowserLocale(getShared);
  if (legacyDraft !== null) {
    // Claim the old shared cart only after its tab-scoped copy is durable.
    tab.setItem(DRAFT_KEY, JSON.stringify(draft));
    trySharedStorage(getShared, shared => shared.removeItem(DRAFT_KEY));
    if (locale === null) trySharedStorage(getShared, shared => shared.setItem(LOCALE_KEY, draft.locale));
  }
  return { ...draft, locale: locale ?? draft.locale };
}

export function writeBrowserDraft(tab: BrowserStorage, getShared: GetSharedStorage, draft: Draft, localeChanged: boolean): void {
  tab.setItem(DRAFT_KEY, JSON.stringify(draft));
  if (localeChanged) trySharedStorage(getShared, shared => shared.setItem(LOCALE_KEY, draft.locale));
}
