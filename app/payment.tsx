import { router, useLocalSearchParams } from 'expo-router';
import { openBrowserAsync } from 'expo-web-browser';
import { useRef, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';

import { useCheckout, useOrderStatus, useRouteActionGuard } from '../src/checkout/context';
import { checkoutError, delayedPaymentLabel, displayOrderId, paymentLabel } from '../src/checkout/labels';
import { hasInconsistentPayment } from '../src/checkout/pickup-hold';
import type { DemoPaymentResult } from '../src/domain/types';
import { useShop } from '../src/state/shop';
import { Button, Card, colors, Icon, Screen, Text } from '../src/ui/core';
import { copy, money } from '../src/ui/format';

export default function PaymentScreen() {
  const { from } = useLocalSearchParams<{ from?: string }>();
  const { mode, demoApi, settleLocalTestPayment, checkoutAllowed, webCheckout, locale } = useShop();
  const { journal } = useCheckout();
  const guardNavigation = useRouteActionGuard();
  const active = journal?.active;
  const orderId = active && active.phase !== 'creating' ? active.orderId : null;
  const { order, failed, error, loading, refresh, delayedPayment } = useOrderStatus(orderId);
  const [busy, setBusy] = useState<DemoPaymentResult | 'browser' | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const running = useRef(false);
  const t = (en: string, rw: string) => copy(locale, en, rw);
  const processing = !failed && order?.paymentStatus === 'processing' && order.paymentAttempt !== null && !order.recoveryReadOnly;
  const checkingPayment = order ? hasInconsistentPayment(order) : loading;
  const onDevice = Platform.OS === 'android' || Platform.OS === 'ios';
  const canOpenHostedPayment = checkoutAllowed && (onDevice || webCheckout);
  function goToOrders() {
    if (from === 'orders' && router.canGoBack()) router.back();
    else router.replace('/(tabs)/orders');
  }

  async function simulate(result: DemoPaymentResult) {
    if (!processing || !order.paymentAttempt || running.current) return;
    const settle = demoApi
      ? (id: string, attempt: string) => demoApi.setDemoPaymentResult(id, attempt, result)
      : result !== 'processing' && settleLocalTestPayment
        ? (id: string, attempt: string) => settleLocalTestPayment(id, attempt, result)
        : null;
    if (!settle) return;

    const shouldNavigate = guardNavigation();
    running.current = true;
    setBusy(result);
    setProblem(null);
    try {
      await settle(order.id, order.paymentAttempt.id);
      if (shouldNavigate()) goToOrders();
    } catch (error) {
      setProblem(checkoutError(error, locale));
      await refresh();
    } finally {
      setBusy(null);
      running.current = false;
    }
  }

  async function openHostedPayment() {
    if (!canOpenHostedPayment || !processing || !order.paymentAttempt || running.current) return;

    const shouldNavigate = guardNavigation();
    const attemptId = order.paymentAttempt.id;
    running.current = true;
    setBusy('browser');
    setProblem(null);
    try {
      const current = await refresh(true);
      const attempt = current?.paymentAttempt;
      if (!shouldNavigate() || current?.status !== 'awaiting_payment' || current.paymentStatus !== 'processing' || current.recoveryReadOnly
        || attempt?.id !== attemptId || !attempt.checkoutUrl) return;

      if (webCheckout) {
        window.location.assign(attempt.checkoutUrl);
        return;
      }
      await openBrowserAsync(attempt.checkoutUrl);
      await refresh();
    } catch {
      setProblem(t('Unable to open the payment page. Check your payment status or try again.', 'Urupapuro rwo kwishyura ntirufungutse. Genzura uko ubwishyu buhagaze cyangwa wongere ugerageze.'));
    } finally {
      setBusy(null);
      running.current = false;
    }
  }

  return (
    <Screen safeBottom>
      <View style={styles.hero}>
        <View style={styles.mark}><Icon name="card-outline" size={28} color={colors.mustard} /></View>
        <Text variant="title" tone="cream" accessibilityRole="header">{mode === 'demo' ? t('Demo payment', 'Ubwishyu bw’igerageza') : t('Payment', 'Kwishyura')}</Text>
        {order && <Text variant="heading" tone="cream">{money(order.total)}</Text>}
        {order && <Text variant="small" tone="cream">{displayOrderId(order.id)}</Text>}
      </View>
      {mode === 'demo' ? <Card>
        <Text>{t('Choose a test result. No money will be charged.', 'Hitamo igisubizo cy’igerageza. Nta mafaranga azakatwa.')}</Text>
        {processing ? (
          <>
            <Button label={t('Simulate successful payment', 'Gerageza ubwishyu bwemewe')} onPress={() => { void simulate('paid'); }} busy={busy === 'paid'} disabled={!!busy} />
            <Button label={t('Simulate payment decline', 'Gerageza ubwishyu bwanzwe')} onPress={() => { void simulate('declined'); }} busy={busy === 'declined'} disabled={!!busy} variant="secondary" />
            <Button label={t('Leave payment pending', 'Reka ubwishyu bukomeze gutegereza')} onPress={() => { void simulate('processing'); }} busy={busy === 'processing'} disabled={!!busy} variant="ghost" />
          </>
        ) : (
          <>
            <Text tone="muted">{loading
              ? t('Checking payment status…', 'Turimo kugenzura ubwishyu…')
              : t('See the latest payment status in Orders.', 'Reba uko ubwishyu buhagaze muri Komande.')}</Text>
            <Button label={t('Go to Orders', 'Jya muri Komande')} onPress={goToOrders} />
          </>
        )}
        {(problem || failed) && <Text selectable tone="red" accessibilityRole="alert">{problem ?? checkoutError(error, locale)}</Text>}
      </Card> : (
        <Card>
          <Text variant="heading" accessibilityLiveRegion="polite">{checkingPayment
            ? t('Checking payment status…', 'Turimo kugenzura ubwishyu…')
            : order ? paymentLabel(order.paymentStatus, locale)
              : t('Check payment status', 'Genzura uko ubwishyu buhagaze')}</Text>
          {processing && order.status === 'awaiting_payment' && (
            settleLocalTestPayment ? (
              <>
                <Text>{t('This is a local test. No money is charged.', 'Iri ni igerageza ryo kuri iki gikoresho. Nta mafaranga azakatwa.')}</Text>
                <Button label={t('Confirm local test payment', 'Emeza ubwishyu bw’igerageza')}
                  onPress={() => { void simulate('paid'); }} busy={busy === 'paid'} disabled={!!busy} />
                <Button label={t('Decline local test payment', 'Anga ubwishyu bw’igerageza')}
                  onPress={() => { void simulate('declined'); }} busy={busy === 'declined'} disabled={!!busy} variant="secondary" />
              </>
            ) : !order.paymentAttempt?.checkoutUrl ? (
              <Text tone="muted">{t(
                'The payment page is unavailable. Refresh to check this payment, or follow it later in Orders.',
                'Urupapuro rwo kwishyura ntiruboneka. Vugurura uko ubu bwishyu buhagaze cyangwa ubukurikirane nyuma muri Komande.',
              )}</Text>
            ) : canOpenHostedPayment ? (
              <Button label={t('Open payment page', 'Fungura urupapuro rwo kwishyura')}
                onPress={() => { void openHostedPayment(); }} busy={busy === 'browser'} disabled={loading} />
            ) : <Text>{t('Open the Android or iOS app to pay.', 'Fungura porogaramu ya Android cyangwa iOS kugira ngo wishyure.')}</Text>
          )}
          {processing && order.status === 'cancelled' && <Text tone="muted">{t(
            'The pickup hold ended. Refresh to check this payment, or follow it later in Orders.',
            'Igihe cyabikiwe komande cyarangiye. Vugurura uko ubu bwishyu buhagaze cyangwa ubukurikirane nyuma muri Komande.',
          )}</Text>}
          {delayedPayment && !failed && <Text tone="muted" accessibilityLiveRegion="polite">{delayedPaymentLabel(locale)}</Text>}
          {(problem || failed) && <Text selectable tone="red" accessibilityRole="alert">{problem ?? checkoutError(error, locale)}</Text>}
          {orderId && <Button label={t('Refresh payment status', 'Vugurura uko ubwishyu buhagaze')} variant="secondary"
            onPress={() => { setProblem(null); void refresh(); }} busy={loading} disabled={!!busy} />}
          <Button label={t('Go to Orders', 'Jya muri Komande')} variant="ghost" onPress={goToOrders} disabled={!!busy} />
        </Card>
      )}
      {mode === 'demo' && processing && (
        <Button label={t('Check later in Orders', 'Reba nyuma muri Komande')} onPress={goToOrders} variant="secondary" disabled={!!busy} />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { backgroundColor: colors.plum, borderRadius: 16, gap: 9, padding: 20 },
  mark: { alignSelf: 'flex-start', padding: 8, borderRadius: 12, borderWidth: 1, borderColor: colors.muted },
});
