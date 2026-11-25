import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useCheckout, useOrderStatus, useRouteActionGuard } from '../src/checkout/context';
import { checkoutError, displayOrderId } from '../src/checkout/labels';
import type { DemoPaymentResult } from '../src/domain/types';
import { useShop } from '../src/state/shop';
import { Button, Card, colors, Icon, Screen, Text } from '../src/ui/core';
import { copy, money } from '../src/ui/format';

export default function PaymentScreen() {
  const { from } = useLocalSearchParams<{ from?: string }>();
  const { api, locale } = useShop();
  const { journal } = useCheckout();
  const guardNavigation = useRouteActionGuard();
  const { order, failed, loading, refresh } = useOrderStatus(journal?.orderIds[0] ?? null);
  const [busy, setBusy] = useState<DemoPaymentResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const running = useRef(false);
  const t = (en: string, rw: string) => copy(locale, en, rw);
  const processing = order?.paymentStatus === 'processing' && order.paymentAttempt !== null;
  function goToOrders() {
    if (from === 'orders' && router.canGoBack()) router.back();
    else router.replace('/(tabs)/orders');
  }

  async function simulate(result: DemoPaymentResult) {
    if (!processing || !order.paymentAttempt || running.current) return;

    const shouldNavigate = guardNavigation();
    running.current = true;
    setBusy(result);
    setProblem(null);
    try {
      await api.setDemoPaymentResult(order.id, order.paymentAttempt.id, result);
      if (shouldNavigate()) goToOrders();
    } catch (error) {
      setProblem(checkoutError(error, locale));
      await refresh();
    } finally {
      setBusy(null);
      running.current = false;
    }
  }

  return (
    <Screen safeBottom>
      <View style={styles.hero}>
        <View style={styles.mark}><Icon name="card-outline" size={28} color={colors.mustard} /></View>
        <Text variant="title" tone="cream" accessibilityRole="header">{t('Demo payment', 'Ubwishyu bw’igerageza')}</Text>
        {order && <Text variant="heading" tone="cream">{money(order.total)}</Text>}
        {order && <Text variant="small" tone="cream">{displayOrderId(order.id)}</Text>}
      </View>
      <Card>
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
        {(problem || failed) && <Text tone="red" accessibilityRole="alert">{problem ?? t('Unable to check payment. Open Orders to retry.', 'Ntitwashoboye kugenzura ubwishyu. Fungura Komande wongere ugerageze.')}</Text>}
      </Card>
      {processing && (
        <Button label={t('Check later in Orders', 'Reba nyuma muri Komande')} onPress={goToOrders} variant="secondary" disabled={!!busy} />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { backgroundColor: colors.plum, borderRadius: 16, gap: 9, padding: 20 },
  mark: { alignSelf: 'flex-start', padding: 8, borderRadius: 12, borderWidth: 1, borderColor: colors.muted },
});
