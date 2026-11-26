import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppState, Platform, Share, type Text as NativeText } from 'react-native';
import { OrderAccessForm } from '../src/checkout/OrderAccessForm';
import { useCheckout } from '../src/checkout/context';
import { ApiError, type Locale, type OrderErasureRequest, type ShopApi } from '../src/domain/types';
import { useShop } from '../src/state/shop';
import { Button, Card, Screen, Text } from '../src/ui/core';
import { copy, kigaliTime } from '../src/ui/format';

type VerifiedOrder = { orderId: string; sessionRevision: number };
type PrivacyApi = Required<Pick<ShopApi, 'getOrderDataExport' | 'getOrderErasureRequest' | 'requestOrderErasure'>>;
type ErasureStatus = { state: 'loading' | 'unavailable' } | { state: 'known'; request: OrderErasureRequest | null };

export default function PrivacyScreen() {
  const { api, checkoutAllowed, hydrated, locale, mode } = useShop();
  const { guestSessionEndPending, guestSessionRevision } = useCheckout();
  const [verified, setVerified] = useState<VerifiedOrder | null>(null);
  const [expired, setExpired] = useState(false);
  const [focused, setFocused] = useState(false);
  const [visible, setVisible] = useState(false);
  const routeFocused = useRef(false);
  const visibility = useRef({ active: false, revision: 0 });
  const { getOrderDataExport, getOrderErasureRequest, requestOrderErasure } = api;
  const available = hydrated && checkoutAllowed && !guestSessionEndPending && mode === 'connected'
    && !!api.requestOrderAccess && !!api.verifyOrderAccess
    && !!getOrderDataExport && !!getOrderErasureRequest && !!requestOrderErasure;
  const access = useRef({ available, guestSessionRevision });
  const t = (en: string, rw: string) => copy(locale, en, rw);

  useLayoutEffect(() => {
    access.current = { available, guestSessionRevision };
    if (verified && (!available || verified.sessionRevision !== guestSessionRevision)) setVerified(null);
  }, [available, guestSessionRevision, verified]);

  useFocusEffect(useCallback(() => {
    function updateVisibility(active: boolean) {
      if (visibility.current.active === active) return;
      visibility.current = { active, revision: visibility.current.revision + 1 };
      setVisible(active);
    }

    routeFocused.current = true;
    setFocused(true);
    updateVisibility(AppState.currentState !== 'background' && AppState.currentState !== 'inactive');
    const subscription = AppState.addEventListener('change', state => updateVisibility(state === 'active'));
    return () => {
      subscription.remove();
      updateVisibility(false);
      routeFocused.current = false;
      setFocused(false);
    };
  }, []));

  const captureAction = useCallback((sessionRevision: number) => {
    const revision = visibility.current.revision;
    return () => visibility.current.active && visibility.current.revision === revision
      && access.current.available && access.current.guestSessionRevision === sessionRevision;
  }, []);

  const clearVerification = useCallback((verifyAgain: boolean) => {
    visibility.current.revision++;
    setVerified(null);
    setExpired(verifyAgain);
  }, []);

  if (!focused || !hydrated) return null;

  if (!available || !getOrderDataExport || !getOrderErasureRequest || !requestOrderErasure) {
    return <Screen safeBottom>
      <Text variant="title" accessibilityRole="header">{t('Order privacy', 'Amakuru bwite ya komande')}</Text>
      <Text>{guestSessionEndPending
        ? t('Finish ending this session in Settings.', 'Rangiriza gusoza iki gihe mu Magenamiterere.')
        : t('Open the connected CrustCaper app to manage your order data.', 'Fungura porogaramu ya CrustCaper ihujwe na serivisi kugira ngo ucunge amakuru ya komande yawe.')}</Text>
      <Button label={t('Go to Settings', 'Jya mu Magenamiterere')} onPress={() => router.replace('/settings')} />
    </Screen>;
  }

  if (verified?.sessionRevision === guestSessionRevision) {
    return visible ? <VerifiedOrderPrivacy order={verified} locale={locale} captureAction={captureAction}
      api={{ getOrderDataExport, getOrderErasureRequest, requestOrderErasure }} onClear={clearVerification} />
      : null;
  }

  return <OrderAccessForm key={guestSessionRevision} suspended={!visible}
    notice={expired ? t('Verify this order again before continuing.', 'Ongera wemeze iyi komande mbere yo gukomeza.') : undefined}
    onPrivacyVerified={(orderId, sessionRevision) => {
      if (routeFocused.current && access.current.available && sessionRevision === access.current.guestSessionRevision) {
        setVerified({ orderId, sessionRevision });
        setExpired(false);
      }
    }} />;
}

function VerifiedOrderPrivacy({ order, locale, api, captureAction, onClear }: {
  order: VerifiedOrder;
  locale: Locale;
  api: PrivacyApi;
  captureAction: (revision: number) => () => boolean;
  onClear: (verifyAgain: boolean) => void;
}) {
  const { orderId, sessionRevision } = order;
  const { getOrderDataExport, getOrderErasureRequest, requestOrderErasure } = api;
  const [status, setStatus] = useState<ErasureStatus>({ state: 'loading' });
  const [confirmation, setConfirmation] = useState(false);
  const [exportFailed, setExportFailed] = useState(false);
  const [busy, setBusy] = useState<'export' | 'erasure' | null>(null);
  const running = useRef(false);
  const title = useRef<NativeText>(null);
  const isWeb = Platform.OS === 'web';
  const t = (en: string, rw: string) => copy(locale, en, rw);

  const readStatus = useCallback(async (isCurrent: () => boolean, onExpired: () => void) => {
    if (!isCurrent()) return;
    setStatus({ state: 'loading' });
    try {
      const result = await getOrderErasureRequest(orderId);
      if (isCurrent()) setStatus({ state: 'known', request: result.request });
    } catch (error) {
      if (!isCurrent()) return;
      if (privacyGrantExpired(error)) onExpired();
      else setStatus({ state: 'unavailable' });
    }
  }, [getOrderErasureRequest, orderId]);

  useEffect(() => {
    let mounted = true;
    const isCurrent = captureAction(sessionRevision);
    if (isWeb) title.current?.focus();
    void readStatus(() => mounted && isCurrent(), () => onClear(true));
    return () => { mounted = false; };
  }, [captureAction, isWeb, onClear, readStatus, sessionRevision]);

  async function runAction(action: 'export' | 'erasure') {
    if (running.current) return;
    const isCurrent = captureAction(sessionRevision);
    if (!isCurrent()) return;
    running.current = true;
    setBusy(action);
    setExportFailed(false);
    try {
      if (action === 'export') {
        const data = await getOrderDataExport(orderId);
        if (isCurrent()) await shareOrderData(data, t('Order data', 'Amakuru ya komande'));
      } else {
        const result = await requestOrderErasure(orderId);
        if (!isCurrent()) return;
        setConfirmation(false);
        setStatus(result.request ? { state: 'known', request: result.request } : { state: 'unavailable' });
      }
    } catch (error) {
      if (!isCurrent()) return;
      if (privacyGrantExpired(error)) onClear(true);
      else if (action === 'export') setExportFailed(true);
      else {
        setConfirmation(false);
        setStatus({ state: 'unavailable' });
      }
    } finally {
      if (isCurrent()) setBusy(null);
      running.current = false;
    }
  }

  const request = status.state === 'known' ? status.request : null;
  return <Screen safeBottom>
    <Text ref={title} tabIndex={isWeb ? -1 : undefined} variant="title" accessibilityRole="header">
      {t('Order privacy', 'Amakuru bwite ya komande')}
    </Text>
    <Card>
      <Text variant="heading" accessibilityRole="header">{t('Order data', 'Amakuru ya komande')}</Text>
      <Text>{t('Save a JSON copy of the data for this order.', 'Bika kopi ya JSON y’amakuru y’iyi komande.')}</Text>
      {exportFailed && <Text tone="red" accessibilityRole="alert">{t('We couldn’t open your order data. Try again.', 'Ntitwashoboye gufungura amakuru ya komande yawe. Ongera ugerageze.')}</Text>}
      <Button label={isWeb ? t('Download order data', 'Manura amakuru ya komande') : t('Share order data', 'Sangiza amakuru ya komande')}
        busy={busy === 'export'} disabled={busy !== null} onPress={() => { void runAction('export'); }} />
    </Card>
    <Card>
      <Text variant="heading" accessibilityRole="header">{t('Deletion request', 'Ubusabe bwo gusiba amakuru')}</Text>
      <Text>{t('Our team reviews requests to delete order data before taking action.', 'Itsinda ryacu risuzuma ubusabe bwo gusiba amakuru ya komande mbere yo kugira icyo rikora.')}</Text>
      {status.state === 'loading' && <Text accessibilityLiveRegion="polite">{t('Checking request status…', 'Turimo kugenzura uko ubusabe buhagaze…')}</Text>}
      {status.state === 'unavailable' && <>
        <Text tone="red" accessibilityRole="alert">{t('Request status is unavailable. Check again before submitting.', 'Uko ubusabe buhagaze ntibiboneka. Ongera ugenzure mbere yo kohereza ubusabe.')}</Text>
        <Button variant="secondary" label={t('Check request status', 'Genzura uko ubusabe buhagaze')} disabled={busy !== null}
          onPress={() => { void readStatus(captureAction(sessionRevision), () => onClear(true)); }} />
      </>}
      {request && <>
        <Text variant="label" accessibilityLiveRegion="polite">{request.status === 'pending'
          ? t('Pending review', 'Butegereje gusuzumwa') : t('In review', 'Burimo gusuzumwa')}</Text>
        <Text tone="muted" variant="small">{t('Submitted', 'Bwoherejwe')} {kigaliTime(request.submittedAt, locale)}</Text>
      </>}
      {status.state === 'known' && !request && (confirmation ? <>
        <Text>{t('Submit a deletion request for this order?', 'Ushaka kohereza ubusabe bwo gusiba amakuru y’iyi komande?')}</Text>
        <Button label={t('Submit deletion request', 'Ohereza ubusabe bwo gusiba amakuru')} busy={busy === 'erasure'}
          disabled={busy !== null} onPress={() => { void runAction('erasure'); }} />
        <Button variant="ghost" label={t('Cancel', 'Hagarika')} disabled={busy !== null} onPress={() => setConfirmation(false)} />
      </> : <Button variant="secondary" label={t('Request deletion', 'Saba ko amakuru asibwa')}
        disabled={busy !== null} onPress={() => setConfirmation(true)} />)}
    </Card>
    <Button variant="ghost" label={t('Verify another order', 'Emeza indi komande')} disabled={busy !== null} onPress={() => onClear(false)} />
  </Screen>;
}

function privacyGrantExpired(error: unknown) {
  return error instanceof ApiError && (error.code === 'not_found' || error.code === 'unauthenticated');
}

async function shareOrderData(data: Awaited<ReturnType<PrivacyApi['getOrderDataExport']>>, title: string) {
  const json = `${JSON.stringify(data, null, 2)}\n`;
  if (Platform.OS !== 'web') {
    await Share.share({ title, message: json }, { dialogTitle: title });
    return;
  }

  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'crustcaper-order-data.json';
  try {
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}
