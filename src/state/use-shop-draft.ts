import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import type { Locale } from '../domain/types';
import { DRAFT_KEY, readBrowserDraft, readBrowserLocale, readDraft, writeBrowserDraft, type Draft } from './draft-storage';

async function readStoredDraft(): Promise<Draft> {
  if (Platform.OS === 'web') return readBrowserDraft(window.sessionStorage, () => window.localStorage);
  return readDraft(await AsyncStorage.getItem(DRAFT_KEY));
}

async function writeStoredDraft(draft: Draft, localeChanged: boolean): Promise<void> {
  if (Platform.OS === 'web') {
    writeBrowserDraft(window.sessionStorage, () => window.localStorage, draft, localeChanged);
    return;
  }
  await AsyncStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
}

export function useShopDraft() {
  const [draft, setDraft] = useState<Draft>({ locale: 'en', cart: [] });
  const [hydrated, setHydrated] = useState(false);
  const [draftSaving, setDraftSaving] = useState(false);
  const [draftStorageError, setDraftStorageError] = useState<'read' | 'write' | null>(null);
  const current = useRef(draft);
  const ready = useRef(false);
  const readRequest = useRef<Promise<void> | null>(null);
  const writeQueue = useRef(Promise.resolve());
  const writeVersion = useRef(0);
  const pendingLanguage = useRef<Locale | null>(null);

  const restoreDraft = useCallback(() => {
    if (readRequest.current) return readRequest.current;

    const load = readStoredDraft().then(saved => {
      current.current = saved;
      setDraft(saved);
      ready.current = true;
      setHydrated(true);
      setDraftStorageError(null);
    }, () => {
      if (Platform.OS === 'web') {
        const locale = readBrowserLocale(() => window.localStorage);
        if (locale) {
          current.current = { ...current.current, locale };
          setDraft(current.current);
        }
      }
      setDraftStorageError('read');
    }).finally(() => {
      readRequest.current = null;
    });
    readRequest.current = load;
    return load;
  }, []);

  useEffect(() => { void restoreDraft(); }, [restoreDraft]);

  const persistDraft = useCallback((next: Draft) => {
    const version = ++writeVersion.current;
    setDraftSaving(true);
    function finishSave(error: 'write' | null) {
      if (version !== writeVersion.current) return;
      setDraftSaving(false);
      setDraftStorageError(error);
    }
    const write = writeQueue.current.then(async () => {
      const localeChanged = pendingLanguage.current === next.locale;
      await writeStoredDraft(next, localeChanged);
      if (localeChanged && pendingLanguage.current === next.locale) pendingLanguage.current = null;
    });
    writeQueue.current = write.then(() => finishSave(null), () => finishSave('write'));
    return write;
  }, []);

  const retryDraftStorage = useCallback(async () => {
    if (!ready.current) return restoreDraft();
    await persistDraft(current.current).catch(() => undefined);
  }, [persistDraft, restoreDraft]);

  const updateDraft = useCallback(async (update: (previous: Draft) => Draft, durable = false) => {
    if (!ready.current) {
      if (durable) throw new Error('The saved cart has not been restored');
      return;
    }

    const previous = current.current;
    const next = update(previous);
    if (next === previous) return;
    current.current = next;
    setDraft(next);
    if (previous.locale !== next.locale) pendingLanguage.current = next.locale;
    try {
      await persistDraft(next);
    } catch (error) {
      if (!durable) return;
      if (current.current === next) {
        current.current = previous;
        setDraft(previous);
      }
      throw error;
    }
  }, [persistDraft]);

  return { draft, hydrated, draftSaving, draftStorageError, retryDraftStorage, updateDraft };
}
