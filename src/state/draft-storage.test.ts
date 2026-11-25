import { deepEqual, equal, throws } from 'node:assert/strict';
import { test } from 'node:test';

import { DRAFT_KEY, readBrowserDraft, writeBrowserDraft, type Draft } from './draft-storage';

const burger = { sku: 'double-smash', unitPrice: 9200, modifierIds: [], quantity: 1 };
const fries = { sku: 'fries', unitPrice: 2500, modifierIds: [], quantity: 1 };

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

test('browser tabs retain separate carts and cart writes preserve the shared language', () => {
  const shared = storage();
  const getShared = () => shared;
  const firstTab = storage();
  const secondTab = storage();
  const first: Draft = { locale: 'en', cart: [burger] };
  const second: Draft = { locale: 'rw', cart: [fries] };
  writeBrowserDraft(firstTab, getShared, first, false);
  writeBrowserDraft(secondTab, getShared, second, true);
  writeBrowserDraft(firstTab, getShared, { ...first, cart: [{ ...burger, quantity: 2 }] }, false);

  deepEqual(readBrowserDraft(firstTab, getShared), { ...first, locale: 'rw', cart: [{ ...burger, quantity: 2 }] });
  deepEqual(readBrowserDraft(secondTab, getShared), second);
  deepEqual(readBrowserDraft(storage(), getShared), { locale: 'rw', cart: [] });
});

test('the legacy cart migrates once and is kept if the new storage rejects a write', () => {
  const shared = storage();
  const getShared = () => shared;
  const oldDraft: Draft = { locale: 'rw', cart: [burger] };
  shared.setItem(DRAFT_KEY, JSON.stringify(oldDraft));
  const brokenTab = { ...storage(), setItem: () => { throw new Error('Storage failed'); } };
  throws(() => readBrowserDraft(brokenTab, getShared), /Storage failed/);
  equal(shared.getItem(DRAFT_KEY), JSON.stringify(oldDraft));

  const tab = storage();
  deepEqual(readBrowserDraft(tab, getShared), oldDraft);
  equal(shared.getItem(DRAFT_KEY), null);
  deepEqual(readBrowserDraft(storage(), getShared), { locale: 'rw', cart: [] });
});

test('the tab cart survives blocked shared storage and preference writes', () => {
  const tab = storage();
  const draft: Draft = { locale: 'rw', cart: [burger] };
  const blocked = () => { throw new Error('Shared storage blocked'); };
  writeBrowserDraft(tab, blocked, draft, true);
  deepEqual(readBrowserDraft(tab, blocked), draft);
});

test('migration keeps the copied cart when shared preference and cleanup writes fail', () => {
  const shared = storage();
  const tab = storage();
  const draft: Draft = { locale: 'rw', cart: [burger] };
  shared.setItem(DRAFT_KEY, JSON.stringify(draft));
  const blocked = () => { throw new Error('Shared write blocked'); };
  const getShared = () => ({ ...shared, removeItem: blocked, setItem: blocked });

  deepEqual(readBrowserDraft(tab, getShared), draft);
  equal(tab.getItem(DRAFT_KEY), JSON.stringify(draft));
  equal(shared.getItem(DRAFT_KEY), JSON.stringify(draft));
});
