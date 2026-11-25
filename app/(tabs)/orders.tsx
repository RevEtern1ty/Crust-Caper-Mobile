import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';

import { useCheckout, useOrderStatus, useRouteActionGuard } from '../../src/checkout/context';
import { checkoutError, changeLabel, displayOrderId, itemName, itemOptions, kitchenLabel, paymentLabel } from '../../src/checkout/labels';
import type { DemoKitchenStatus, ReorderResult } from '../../src/domain/types';
import { useShop } from '../../src/state/shop';
import { Button, Card, colors, Icon, Screen, Text } from '../../src/ui/core';
import { copy, money, slotLabel } from '../../src/ui/format';

type Action = 'resume' | 'reorder' | 'kitchen';

export default function OrdersScreen() {
  const { api, locale, menu, cart, hydrated, replaceCart } = useShop();
  const { journal, restoreFailed, retryRestore, resumeCheckout, busy } = useCheckout();
  const guardNavigation = useRouteActionGuard();
  const latestId = journal?.orderIds[0] ?? null;
  const [choice, setChoice] = useState<{ latest: string | null; id: string } | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [preview, setPreview] = useState<{ orderId: string; result: ReorderResult } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const running = useRef(false);
  const orderId = choice?.latest === latestId ? choice.id : latestId;
  const { order, loading, failed, refresh } = useOrderStatus(orderId);
  const t = (en: string, rw: string) => copy(locale, en, rw);

  const active = journal?.active;
  const ongoingCreate = active?.phase === 'creating';
  const activeOrder = active && active.phase !== 'creating' && active.orderId === orderId;
  const canResume = activeOrder && !!order && order.status === 'awaiting_payment'
    && (order.paymentStatus === 'unpaid' || order.paymentStatus === 'declined');
  const nextKitchen: DemoKitchenStatus | null = order?.status === 'accepted' ? 'preparing'
    : order?.status === 'preparing' ? 'ready' : order?.status === 'ready' ? 'collected' : null;
  const repeat = preview?.orderId === orderId ? preview.result : null;

  async function run(label: Action, operation: () => Promise<void>) {
    if (running.current) return;

    running.current = true;
    setAction(label);
    setProblem(null);
    try {
      await operation();
    } catch (error) {
      setProblem(checkoutError(error, locale));
      await refresh();
    } finally {
      setAction(null);
      running.current = false;
    }
  }

  function resume(retryDeclined = false) {
    const shouldNavigate = guardNavigation();
    void run('resume', async () => {
      const resumed = await resumeCheckout(retryDeclined);
      if (resumed.paymentStatus === 'processing' && shouldNavigate()) {
        router.push({ pathname: '/payment', params: { from: 'orders' } });
      } else await refresh();
    });
  }

  return (
    <Screen onRefresh={orderId ? () => { void refresh(); } : undefined} refreshing={loading}>
      <View style={styles.intro}>
        <View style={styles.titleGroup}>
          <Text variant="title" accessibilityRole="header">{t('Orders', 'Komande')}</Text>
          <Text variant="small" tone="muted">{t('Track pickup on this device.', 'Kurikirana komande kuri iki gikoresho.')}</Text>
        </View>
        <Pressable
          accessibilityRole="button" accessibilityLabel={t('Settings', 'Igenamiterere')}
          onPress={() => router.push('/settings')} style={({ pressed }) => [styles.settings, pressed && styles.dimmed]}
        >
          <Icon name="settings-outline" />
        </Pressable>
      </View>

      {restoreFailed && (
        <Card>
          <Text tone="red" accessibilityRole="alert">{t('Saved orders could not be opened.', 'Komande zabitswe ntizashoboye gufungurwa.')}</Text>
          <Button label={t('Try opening saved orders again', 'Ongera ugerageze gufungura komande zabitswe')}
            variant="secondary" busy={busy} onPress={() => { void retryRestore(); }} />
        </Card>
      )}
      {!journal && !restoreFailed && <Text tone="muted">{t('Opening saved orders…', 'Turimo gufungura komande zabitswe…')}</Text>}
      {activeOrder && !order && failed && (
        <Button
          label={t('Restore saved checkout', 'Ongera ufungure ubwishyu bwabitswe')}
          onPress={() => resume()} variant="secondary" busy={busy || action === 'resume'} disabled={!hydrated}
        />
      )}
      {ongoingCreate && (
        <Card>
          <Text variant="heading">{t('Finish your last checkout', 'Rangiza kwishyura komande ya nyuma')}</Text>
          <Text>{t('Continue with the same order request.', 'Komeza icyifuzo cya komande kimwe.')}</Text>
          <Button label={t('Resume checkout', 'Komeza kwishyura')} onPress={() => resume()} busy={busy || action === 'resume'} disabled={!hydrated} />
        </Card>
      )}

      {journal && !orderId && !ongoingCreate && (
        <Card style={styles.empty}>
          <View style={styles.emptyIcon}><Icon name="receipt-outline" size={28} color={colors.plum} /></View>
          <Text variant="heading">{t('No orders yet', 'Nta komande uragira')}</Text>
          <Text tone="muted">{t('Your pickup order and its status will appear here.', 'Komande yawe n’uko ihagaze bizagaragara hano.')}</Text>
          <Button label={t('Browse the menu', 'Reba ibiribwa')} onPress={() => router.navigate('/(tabs)')} />
        </Card>
      )}

      {order && (
        <>
          <View style={styles.statusCard}>
            <View style={styles.statusHeader}>
              <Text variant="label" tone="mustard">{displayOrderId(order.id)}</Text>
              <Text variant="small" tone="cream">{money(order.total)}</Text>
            </View>
            <Text variant="heading" tone="cream" accessibilityLiveRegion="polite">{kitchenLabel(order.status, locale)}</Text>
            <Text tone="cream">{paymentLabel(order.paymentStatus, locale)}</Text>
            <View style={styles.statusDivider} />
            <View style={styles.pickupTime}>
              <Icon name="time-outline" color={colors.mustard} size={20} />
              <Text tone="cream" style={styles.shrink}>{slotLabel({ startsAt: order.pickupStartsAt, endsAt: order.pickupEndsAt }, locale)}</Text>
            </View>
          </View>

          {order.status === 'ready' && order.paymentStatus === 'paid' && order.pickupCode && (
            <Card style={styles.pickupCode}>
              <Text variant="label">{t('Pickup code', 'Kode yo gufata komande')}</Text>
              <Text style={styles.code}>{order.pickupCode}</Text>
              <Text variant="small" tone="muted">{t('Show this code at the pickup counter.', 'Erekana iyi kode aho bafatira komande.')}</Text>
            </Card>
          )}

          {activeOrder && order.paymentStatus === 'processing' && (
            <Card>
              <Text>{t('This payment is being checked. You can leave and come back here.', 'Ubu bwishyu buracyagenzurwa. Ushobora kugenda ukagaruka hano.')}</Text>
              <Button
                label={t('Open existing demo payment', 'Fungura ubwishyu bw’igerageza busanzwe')}
                onPress={() => resume()} variant="secondary" busy={busy || action === 'resume'} disabled={!hydrated}
              />
            </Card>
          )}

          {canResume && (
            <Button
              label={order.paymentStatus === 'declined' ? t('Retry demo payment', 'Ongera ugerageze ubwishyu') : t('Continue to demo payment', 'Komeza ku bwishyu bw’igerageza')}
              onPress={() => resume(order.paymentStatus === 'declined')} busy={busy || action === 'resume'} disabled={!hydrated}
            />
          )}

          {activeOrder && active?.phase === 'paying' && !canResume && order.paymentStatus !== 'processing' && (
            <Button
              label={t('Restore saved checkout', 'Ongera ufungure ubwishyu bwabitswe')}
              onPress={() => resume()} variant="secondary" busy={busy || action === 'resume'} disabled={!hydrated}
            />
          )}

          {(order.paymentStatus === 'refund_pending' || order.paymentStatus === 'refunded') && (
            <Card><Text>{t('The pickup hold ended. Check with the pickup team if you need help with the refund.', 'Igihe cyabikiwe komande cyarangiye. Baza aho bafatira komande niba ukeneye ubufasha bwo gusubizwa amafaranga.')}</Text></Card>
          )}

          <Card>
            <Text variant="heading">{t('Order details', 'Ibisobanuro bya komande')}</Text>
            {order.lines.map((line) => (
              <View key={`${line.sku}:${line.modifierIds.join(',')}`} style={styles.row}>
                <View style={styles.shrink}>
                  <Text>{line.quantity} × {itemName(line.sku, locale, menu)}</Text>
                  {line.modifierIds.length > 0 && <Text variant="small" tone="muted">{itemOptions(line, locale, menu)}</Text>}
                </View>
                <Text style={styles.amount}>{money(line.quantity * line.unitPrice)}</Text>
              </View>
            ))}
            {order.paymentStatus === 'paid' && (
              <Text variant="small" tone="muted">{t('Fiscal receipt unavailable in the demo.', 'Inyemezabwishyu yemewe ntiboneka mu igerageza.')}</Text>
            )}
            {order.paymentStatus === 'paid' || order.status === 'cancelled' ? (
              <Button label={t('Review reorder', 'Reba komande nshya isa n’iyi')} variant="secondary" busy={action === 'reorder'} disabled={!!action} onPress={() => {
                void run('reorder', async () => {
                  setPreview({ orderId: order.id, result: await api.reorder(order.id) });
                });
              }} />
            ) : null}
          </Card>

          {repeat && (
            <Card>
              <Text variant="heading">{t('Available items today', 'Ibiribwa biboneka uyu munsi')}</Text>
              {repeat.lines.map((line) => <Text key={`${line.sku}:${line.modifierIds.join(',')}`}>{line.quantity} × {itemName(line.sku, locale, menu)} · {money(line.unitPrice * line.quantity)}</Text>)}
              {repeat.changes.map((change, index) => <Text key={index} tone="red">{changeLabel(change, locale, menu)}</Text>)}
              {!repeat.lines.length && <Text tone="muted">{t('None of these items are available.', 'Nta na kimwe muri ibi biribwa kiboneka.')}</Text>}
              <Button
                label={cart.length ? t('Replace cart with these items', 'Simbuza ibiri mu gatebo ibi biribwa') : t('Add these items to cart', 'Shyira ibi biribwa mu gatebo')}
                onPress={() => {
                  replaceCart(repeat.lines);
                  setPreview(null);
                  router.push('/cart');
                }}
                disabled={!repeat.lines.length || !hydrated}
              />
              <Button label={t('Cancel reorder', 'Hagarika gusubiramo komande')} variant="ghost" onPress={() => setPreview(null)} />
            </Card>
          )}

          {nextKitchen && (
            <Card style={styles.demoTools}>
              <Text variant="label">{t('Demo kitchen', 'Igikoni cy’igerageza')}</Text>
              <Button
                label={nextKitchen === 'preparing' ? t('Simulate preparation', 'Gerageza gutegura')
                  : nextKitchen === 'ready' ? t('Simulate ready for pickup', 'Gerageza ko yiteguye gufatwa')
                    : t('Simulate pickup', 'Gerageza gufata komande')}
                onPress={() => {
                  void run('kitchen', async () => {
                    await api.setDemoOrderStatus(order.id, nextKitchen);
                    await refresh();
                  });
                }}
                busy={action === 'kitchen'} variant="secondary" disabled={!!action}
              />
            </Card>
          )}
        </>
      )}

      {(problem || failed) && <Text accessibilityRole="alert" tone="red">{problem ?? t('Unable to refresh the order. Try again.', 'Ntitwashoboye kuvugurura komande. Ongera ugerageze.')}</Text>}
      {orderId && <Button label={t('Refresh order status', 'Vugurura uko komande ihagaze')} onPress={() => { void refresh(); }} busy={loading} variant="secondary" />}

      {journal && journal.orderIds.length > 1 && (
        <Card>
          <Text variant="heading">{t('Recent demo orders', 'Komande z’igerageza ziheruka')}</Text>
          <View style={styles.history}>
            {journal.orderIds.map((id) => (
              <Pressable
                key={id}
                accessibilityRole="button"
                aria-pressed={Platform.OS === 'web' ? id === orderId : undefined}
                accessibilityState={Platform.OS === 'web' ? undefined : { selected: id === orderId }}
                onPress={() => {
                  setChoice({ latest: latestId, id });
                  setPreview(null);
                  setProblem(null);
                }}
                style={[styles.historyItem, id === orderId && styles.selected]}
              >
                <Text variant="label">{displayOrderId(id)}</Text>
              </Pressable>
            ))}
          </View>
        </Card>
      )}

      <Button label={t('Pickup & help', 'Gufata komande n’ubufasha')} onPress={() => router.navigate('/(tabs)/pickup')} variant="ghost" />
    </Screen>
  );
}

const styles = StyleSheet.create({
  intro: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  titleGroup: { gap: 5, flexShrink: 1 },
  settings: { width: 48, height: 48, borderRadius: 12, backgroundColor: colors.paper, alignItems: 'center', justifyContent: 'center' },
  dimmed: { opacity: 0.6 },
  empty: { alignItems: 'center', gap: 16, paddingVertical: 24 },
  emptyIcon: { width: 54, height: 54, borderRadius: 16, backgroundColor: colors.paper, alignItems: 'center', justifyContent: 'center' },
  statusCard: { backgroundColor: colors.plum, borderRadius: 16, padding: 18, gap: 9 },
  statusHeader: { flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 },
  statusDivider: { backgroundColor: colors.muted, height: 1, marginTop: 4 },
  pickupTime: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 4 },
  shrink: { flexShrink: 1 },
  pickupCode: { alignItems: 'center', backgroundColor: colors.mint, borderColor: colors.green },
  code: { fontSize: 39, lineHeight: 46, letterSpacing: 6, fontWeight: '900', textAlign: 'center' },
  row: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 },
  amount: { flexShrink: 1 },
  demoTools: { backgroundColor: colors.paper },
  history: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  historyItem: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: colors.border },
  selected: { backgroundColor: colors.mint, borderColor: colors.green },
});
