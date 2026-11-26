import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';

import { useCheckout, useOrderStatus, useRouteActionGuard } from '../../src/checkout/context';
import { CheckoutError } from '../../src/checkout/controller';
import { checkoutError, delayedPaymentLabel, displayOrderId, itemName, itemOptions, kitchenLabel, paymentLabel } from '../../src/checkout/labels';
import { ReorderPanel } from '../../src/checkout/reorder-panel';
import { reorderOfferForCart } from '../../src/checkout/reorder-review';
import { savedPaymentReturnOrderId } from '../../src/checkout/payment-return';
import { PickupAlertPanel } from '../../src/checkout/pickup-alert';
import { hasInconsistentPayment, isAwaitingUnpaidHold, isExpiredUnpaidHold } from '../../src/checkout/pickup-hold';
import { shareReceipt } from '../../src/checkout/receipt-sharing';
import { ApiError, type DemoKitchenStatus, type ReorderResult } from '../../src/domain/types';
import { useShop } from '../../src/state/shop';
import { Button, Card, colors, Icon, Screen, Text } from '../../src/ui/core';
import { copy, money, slotLabel } from '../../src/ui/format';

type Action = 'resume' | 'reorder' | 'kitchen' | 'receipt';

export default function OrdersScreen() {
  const { api, mode, demoApi, checkoutAllowed, locale, menu, cart, hydrated, replaceCart } = useShop();
  const { journal, requestedOrderId, setRequestedOrderId, restoreFailed, retryRestore, resumeCheckout, finishExpiredHold, busy } = useCheckout();
  const guardNavigation = useRouteActionGuard();
  const latestId = journal?.orderIds[0] ?? null;
  const [choice, setChoice] = useState<{ latest: string | null; id: string } | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const [preview, setPreview] = useState<{ orderId: string; result: ReorderResult } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const running = useRef(false);
  const linkedOrderId = savedPaymentReturnOrderId(requestedOrderId ?? undefined, journal?.orderIds ?? []);
  const orderId = linkedOrderId ?? (choice?.latest === latestId ? choice.id : latestId);
  const { order, loading, failed, error: statusError, refresh, delayedPayment } = useOrderStatus(orderId);
  const t = (en: string, rw: string) => copy(locale, en, rw);
  const showDelayedPayment = !!order && delayedPayment && !failed;
  const needsPhoneVerification = mode === 'connected' && !!orderId
    && statusError instanceof ApiError && statusError.code === 'unauthenticated';

  useEffect(() => {
    if (!journal || requestedOrderId === null) return;
    if (linkedOrderId) {
      setChoice({ latest: latestId, id: linkedOrderId });
      setPreview(null);
      setProblem(null);
      if (Platform.OS !== 'web') void refresh();
    }
    setRequestedOrderId(null);
  }, [journal, latestId, linkedOrderId, refresh, requestedOrderId, setRequestedOrderId]);

  const active = journal?.active;
  const ongoingCreate = active?.phase === 'creating';
  const activeOrder = active && active.phase !== 'creating' && active.orderId === orderId;
  const inconsistentPayment = !!order && hasInconsistentPayment(order);
  const canResume = checkoutAllowed && activeOrder && !!order && !order.recoveryReadOnly && isAwaitingUnpaidHold(order);
  const expiredHold = !!order && isExpiredUnpaidHold(order);
  const nextKitchen: DemoKitchenStatus | null = order?.status === 'accepted' ? 'preparing'
    : order?.status === 'preparing' ? 'ready' : order?.status === 'ready' ? 'collected' : null;
  const repeat = !inconsistentPayment && preview?.orderId === orderId ? preview.result : null;

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
    if (!checkoutAllowed) return;
    const shouldNavigate = guardNavigation();
    void run('resume', async () => {
      try {
        const resumed = await resumeCheckout(retryDeclined);
        if (!resumed.recoveryReadOnly && resumed.paymentStatus === 'processing'
          && (mode === 'demo' || resumed.status === 'awaiting_payment') && shouldNavigate()) {
          router.push({ pathname: '/payment', params: { from: 'orders' } });
        } else await refresh();
      } catch (error) {
        if (error instanceof CheckoutError && error.code === 'contact_required') {
          if (shouldNavigate()) router.push({ pathname: '/checkout', params: { resume: 'contact' } });
          return;
        }
        throw error;
      }
    });
  }

  function openReceipt(id: string) {
    const shouldOpen = guardNavigation();
    void run('receipt', async () => {
      if (!api.getReceiptPdf) return;
      const pdf = await api.getReceiptPdf(id);
      if (shouldOpen()) await shareReceipt(pdf, `receipt-${id.slice(-8)}.pdf`, t('Receipt', 'Inyemezabwishyu'));
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
      {checkoutAllowed && activeOrder && !order && failed && !needsPhoneVerification && (
        <Button
          label={t('Restore saved checkout', 'Ongera ufungure ubwishyu bwabitswe')}
          onPress={() => resume()} variant="secondary" busy={busy || action === 'resume'} disabled={!hydrated}
        />
      )}
      {ongoingCreate && (
        <Card>
          <Text variant="heading">{t('Finish your last checkout', 'Rangiza kwishyura komande ya nyuma')}</Text>
          <Text>{t('Continue with the same order request.', 'Komeza icyifuzo cya komande kimwe.')}</Text>
          {checkoutAllowed && <Button label={t('Resume checkout', 'Komeza kwishyura')} onPress={() => resume()} busy={busy || action === 'resume'} disabled={!hydrated} />}
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

      {mode === 'connected' && checkoutAllowed && api.requestOrderAccess && api.verifyOrderAccess && (
        <Button label={needsPhoneVerification
          ? t('Verify this order by phone', 'Emeza iyi komande ukoresheje telefoni')
          : t('Find an order from another device', 'Shaka komande yakozwe ku kindi gikoresho')} variant="secondary"
          onPress={() => router.push({
            pathname: '/order-recovery',
            params: { from: 'orders', ...(needsPhoneVerification && orderId ? { orderCode: orderId.slice(-8).toUpperCase() } : {}) },
          })} />
      )}

      {order && (
        <>
          <View style={styles.statusCard}>
            <View style={styles.statusHeader}>
              <Text variant="label" tone="mustard">{displayOrderId(order.id)}</Text>
              <Text variant="small" tone="cream">{money(order.total)}</Text>
            </View>
            <Text variant="heading" tone="cream" accessibilityLiveRegion="polite">{inconsistentPayment
              ? t('Checking payment status…', 'Turimo kugenzura ubwishyu…')
              : kitchenLabel(order.status, locale)}</Text>
            {!inconsistentPayment && <Text tone="cream">{paymentLabel(order.paymentStatus, locale)}</Text>}
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

          {!order.recoveryReadOnly && <PickupAlertPanel key={order.id} order={order} />}

          {showDelayedPayment && (
            <Card>
              <Text accessibilityLiveRegion="polite">{delayedPaymentLabel(locale)}</Text>
              <Button label={t('Refresh order status', 'Vugurura uko komande ihagaze')} onPress={() => { void refresh(); }}
                busy={loading} variant="secondary" />
            </Card>
          )}

          {activeOrder && order.paymentStatus === 'processing' && (
            <Card>
              <Text>{mode === 'connected' && order.status === 'cancelled'
                ? t('The pickup hold ended. We’re checking this payment.', 'Igihe cyabikiwe komande cyarangiye. Turacyagenzura ubu bwishyu.')
                : t('This payment is being checked. You can leave and come back here.', 'Ubu bwishyu buracyagenzurwa. Ushobora kugenda ukagaruka hano.')}</Text>
              {checkoutAllowed && !order.recoveryReadOnly && (mode === 'demo' || order.status === 'awaiting_payment') && <Button
                label={mode === 'demo' ? t('Open existing demo payment', 'Fungura ubwishyu bw’igerageza busanzwe') : t('Open payment', 'Fungura aho kwishyurira')}
                onPress={() => resume()} variant="secondary" busy={busy || action === 'resume'} disabled={!hydrated}
              />}
            </Card>
          )}

          {order.recoveryReadOnly && order.status === 'awaiting_payment' && !inconsistentPayment && (
            <Card><Text>{t('You can view this order here. Contact the pickup team for help with payment.',
              'Ushobora kureba iyi komande hano. Saba ubufasha mu kwishyura aho ufatira komande.')}</Text></Card>
          )}

          {canResume && (
            <Button
              label={order.paymentStatus === 'declined'
                ? t(mode === 'demo' ? 'Retry demo payment' : 'Retry payment', 'Ongera ugerageze ubwishyu')
                : mode === 'demo' ? t('Continue to demo payment', 'Komeza ku bwishyu bw’igerageza')
                  : t('Continue to payment', 'Komeza wishyure')}
              onPress={() => resume(order.paymentStatus === 'declined')} busy={busy || action === 'resume'} disabled={!hydrated}
            />
          )}

          {checkoutAllowed && !order.recoveryReadOnly && activeOrder && active?.phase === 'paying' && !canResume && !expiredHold
            && !inconsistentPayment
            && (order.paymentStatus !== 'processing' || (mode === 'connected' && order.status === 'cancelled')) && (
            <Button
              label={t('Restore saved checkout', 'Ongera ufungure ubwishyu bwabitswe')}
              onPress={() => resume()} variant="secondary" busy={busy || action === 'resume'} disabled={!hydrated}
            />
          )}

          {expiredHold && <Card><Text accessibilityLiveRegion="polite">{order.recoveryReadOnly
            ? t('Your pickup hold ended.', 'Igihe cyabikiwe komande cyarangiye.')
            : t('Your pickup hold ended. Review a new order to choose another time.',
              'Igihe cyabikiwe komande cyarangiye. Reba komande nshya uhitemo ikindi gihe.')}</Text></Card>}

          {(order.paymentStatus === 'refund_pending' || order.paymentStatus === 'refunded') && (
            <Card><Text>{order.paymentStatus === 'refunded'
              ? t('Your refund has been confirmed. Contact the pickup team if you need help.', 'Gusubizwa amafaranga byemejwe. Saba ubufasha itsinda ritanga komande niba ubukeneye.')
              : t('Your refund is being checked. Refresh this order later for an update.', 'Gusubizwa amafaranga biracyagenzurwa. Vugurura iyi komande nyuma urebe uko bihagaze.')}</Text></Card>
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
            {mode === 'demo' && order.paymentStatus === 'paid' && (
              <Text variant="small" tone="muted">{t('Fiscal receipt unavailable in the demo.', 'Inyemezabwishyu yemewe ntiboneka mu igerageza.')}</Text>
            )}
            {mode === 'connected' && api.getReceiptPdf && order.receiptUrl && order.receiptStatus !== 'pending' && (
              <Button label={Platform.OS === 'web' ? t('Download receipt', 'Kuramo inyemezabwishyu') : t('Share receipt', 'Sangiza inyemezabwishyu')}
                variant="secondary" busy={action === 'receipt'} disabled={!!action} onPress={() => openReceipt(order.id)} />
            )}
            {mode === 'connected' && order.paymentStatus === 'paid' && order.receiptStatus === 'pending' && (
              <Text variant="small" tone="muted">{t('The receipt is pending.', 'Inyemezabwishyu iracyategerejwe.')}</Text>
            )}
            {!order.recoveryReadOnly && !inconsistentPayment && (order.paymentStatus === 'paid' || order.status === 'cancelled') ? (
              <Button label={t('Review reorder', 'Reba komande nshya isa n’iyi')} variant="secondary" busy={action === 'reorder'}
                disabled={!!action || (expiredHold && busy)} onPress={() => {
                  void run('reorder', async () => {
                    if (expiredHold) await finishExpiredHold(order);
                    const offer = await api.reorder(order.id);
                    setPreview({ orderId: order.id, result: reorderOfferForCart(offer) });
                  });
                }} />
            ) : null}
          </Card>

          {repeat && (
            <ReorderPanel
              original={order.lines} offer={repeat} menu={menu} locale={locale}
              replacesCart={cart.length > 0} disabled={!hydrated}
              onConfirm={() => {
                replaceCart(repeat.lines);
                setPreview(null);
                router.push('/cart');
              }}
              onCancel={() => setPreview(null)}
            />
          )}

          {demoApi && nextKitchen && (
            <Card style={styles.demoTools}>
              <Text variant="label">{t('Demo kitchen', 'Igikoni cy’igerageza')}</Text>
              <Button
                label={nextKitchen === 'preparing' ? t('Simulate preparation', 'Gerageza gutegura')
                  : nextKitchen === 'ready' ? t('Simulate ready for pickup', 'Gerageza ko yiteguye gufatwa')
                    : t('Simulate pickup', 'Gerageza gufata komande')}
                onPress={() => {
                  void run('kitchen', async () => {
                    await demoApi.setDemoOrderStatus(order.id, nextKitchen);
                    await refresh();
                  });
                }}
                busy={action === 'kitchen'} variant="secondary" disabled={!!action}
              />
            </Card>
          )}
        </>
      )}

      {(problem || failed) && <Text accessibilityRole="alert" tone="red">{problem ?? (needsPhoneVerification
        ? t('Verify your phone number to open this saved order.', 'Emeza nimero ya telefoni kugira ngo ufungure iyi komande yabitswe.')
        : checkoutError(statusError, locale))}</Text>}
      {orderId && !showDelayedPayment && <Button label={t('Refresh order status', 'Vugurura uko komande ihagaze')} onPress={() => { void refresh(); }} busy={loading} variant="secondary" />}

      {journal && journal.orderIds.length > 1 && (
        <Card>
          <Text variant="heading">{mode === 'demo' ? t('Recent demo orders', 'Komande z’igerageza ziheruka') : t('Recent orders', 'Komande ziheruka')}</Text>
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
