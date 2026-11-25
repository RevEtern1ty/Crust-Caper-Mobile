import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { useCheckout, useRouteActionGuard } from '../src/checkout/context';
import { checkoutError, changeLabel, itemName, itemOptions } from '../src/checkout/labels';
import { DEMO_PHONE } from '../src/domain/demo-api';
import { ApiError, type Quote } from '../src/domain/types';
import { useShop } from '../src/state/shop';
import { Button, Card, colors, Icon, Screen, Text } from '../src/ui/core';
import { copy, money, slotLabel } from '../src/ui/format';

const demoPhoneLabel = '+250 700 000 000';

export default function CheckoutScreen() {
  const { api, locale, menu, cart, total, hydrated, refreshing, refreshMenu } = useShop();
  const { beginCheckout, journal, busy, restoreFailed } = useCheckout();
  const guardNavigation = useRouteActionGuard();
  const [selectedSlot, setSlot] = useState('');
  const [phone, setPhone] = useState('');
  const [phoneInvalid, setPhoneInvalid] = useState(false);
  const [review, setReview] = useState<{ quote: Quote; cartKey: string; slotKey: string } | null>(null);
  const [requestingQuote, setRequestingQuote] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const checking = useRef(false);
  const t = (en: string, rw: string) => copy(locale, en, rw);

  const slot = menu?.slots.find((option) => option.id === selectedSlot && option.available);
  const slotKey = slot ? JSON.stringify([slot.id, slot.startsAt, slot.endsAt]) : '';
  const cartKey = JSON.stringify(cart);
  const quote = review && review.cartKey === cartKey && review.slotKey === slotKey ? review.quote : null;
  const unfinished = journal?.active && journal.active.phase !== 'tracking';
  const savedOrder = !!journal?.orderIds.length;
  const noAvailableSlots = !menu?.slots.some((option) => option.available);

  useFocusEffect(useCallback(() => {
    void refreshMenu();
  }, [refreshMenu]));

  function updatePhone(value: string) {
    setPhone(value);
    setPhoneInvalid(false);
  }

  async function submit() {
    if (checking.current || !menu || !slot || !cart.length || busy || !journal) return;
    if (phone.replace(/\s/g, '') !== DEMO_PHONE) {
      setPhoneInvalid(true);
      return;
    }

    checking.current = true;
    const shouldNavigate = guardNavigation();
    setProblem(null);
    if (!quote) setRequestingQuote(true);
    try {
      if (!quote) {
        const result = await api.createQuote({ storeId: menu.store.id, slotId: slot.id, lines: cart });
        setReview({ quote: result, cartKey, slotKey });
        return;
      }
      const order = await beginCheckout(quote, cart);
      if (shouldNavigate()) router.replace(order.paymentStatus === 'processing' ? '/payment' : '/(tabs)/orders');
    } catch (error) {
      setProblem(checkoutError(error, locale));
      if (error instanceof ApiError && ['quote_expired', 'quote_changed', 'slot_unavailable', 'reservation_expired'].includes(error.code)) {
        setReview(null);
        if (error.code === 'slot_unavailable' || error.code === 'reservation_expired') setSlot('');
        await refreshMenu().catch(() => {});
      }
    } finally {
      checking.current = false;
      setRequestingQuote(false);
    }
  }

  if (!hydrated || (!journal && !restoreFailed)) {
    return <Screen safeBottom><Text>{t('Opening checkout…', 'Turimo gufungura aho kwishyurira…')}</Text></Screen>;
  }

  if (restoreFailed || unfinished || cart.length === 0) {
    const viewOrders = restoreFailed || unfinished || savedOrder;
    return (
      <Screen safeBottom>
        <Text variant="title" accessibilityRole="header">{t('Checkout', 'Kwishyura')}</Text>
        <Card>
          <Text>{restoreFailed
            ? t('The saved order could not be opened.', 'Komande yabitswe ntishobora gufungurwa.')
            : unfinished
              ? t('An order is waiting to be restored.', 'Hari komande itegereje kongera gufungurwa.')
              : savedOrder ? t('Your latest order is in Orders.', 'Komande yawe ya nyuma iri muri Komande.')
                : t('Your cart is empty.', 'Agatebo kawe karimo ubusa.')}</Text>
          {problem && <Text tone="red" accessibilityRole="alert">{problem}</Text>}
          <Button
            label={viewOrders ? t('Go to Orders', 'Jya muri Komande') : t('Browse menu', 'Reba ibiribwa')}
            onPress={() => router.replace(viewOrders ? '/(tabs)/orders' : '/(tabs)')}
          />
        </Card>
      </Screen>
    );
  }

  return (
    <Screen safeBottom bottom={(
      <Button
        label={quote
          ? t(`Confirm ${money(quote.total)} & continue`, `Emeza ${money(quote.total)} ukomeze`)
          : t('Review order', 'Reba komande')}
        onPress={() => { void submit(); }}
        busy={requestingQuote || busy}
        disabled={!journal || !slot || (!!quote && quote.lines.length === 0)}
      />
    )}>
      <View style={styles.stack}>
        <Text variant="title" accessibilityRole="header">{t('Pickup order', 'Komande yo gufata')}</Text>
        <Text tone="muted">{menu?.store.name[locale] ?? t('CrustCaper Kigali', 'CrustCaper Kigali')}</Text>
      </View>

      <Card>
        <Text variant="heading" accessibilityRole="header">{t('Pickup time', 'Igihe cyo gufata')}</Text>
        <View accessibilityRole="radiogroup" accessibilityLabel={t('Pickup time', 'Igihe cyo gufata')} style={styles.slotGroup}>
          {menu?.slots.map((option) => {
            const checked = option.id === slot?.id;
            const disabled = !option.available || requestingQuote || busy;
            const choose = () => {
              if (disabled || checked) return;
              setSlot(option.id);
              setReview(null);
              setProblem(null);
            };
            const webKeyboard = Platform.OS === 'web' ? {
              onKeyDown: (event: { key: string; preventDefault: () => void }) => {
                if (event.key === ' ' && !disabled) {
                  event.preventDefault();
                  choose();
                }
              },
            } : {};

            return (
              <Pressable
                key={option.id}
                accessibilityRole="radio"
                accessibilityState={{ checked, disabled }}
                aria-checked={checked}
                aria-disabled={disabled}
                disabled={disabled}
                onPress={choose}
                {...webKeyboard}
                style={({ pressed }) => [styles.slot, checked && styles.selected, (pressed || !option.available) && styles.dimmed]}
              >
                <Icon name={checked ? 'radio-button-on' : 'radio-button-off'} size={20} />
                <Text style={styles.shrink}>{slotLabel(option, locale)}{!option.available && ` · ${t('Unavailable', 'Ntikiboneka')}`}</Text>
              </Pressable>
            );
          })}
        </View>
        {noAvailableSlots && (
          <>
            <Text tone="muted">{refreshing
              ? t('Checking pickup times…', 'Turimo kugenzura ibihe byo gufata…')
              : t('No pickup times are available right now.', 'Nta gihe cyo gufata komande kiboneka ubu.')}</Text>
            <Button label={t('Refresh pickup times', 'Vugurura ibihe byo gufata')} variant="secondary" busy={refreshing} onPress={() => { void refreshMenu(); }} />
          </>
        )}
      </Card>

      <Card>
        <Text variant="heading" accessibilityRole="header">{t('Guest contact', 'Nimero y’umushyitsi')}</Text>
        <Text variant="small" tone="muted">{t('Use the demo number below. No calls or messages are sent.', 'Koresha nimero y’igerageza iri hasi. Nta guhamagara cyangwa ubutumwa bwoherezwa.')}</Text>
        <TextInput
          accessibilityLabel={t('Demo phone number', 'Nimero y’igerageza')}
          autoComplete="off"
          keyboardType="phone-pad"
          editable={!busy}
          maxLength={19}
          value={phone}
          onChangeText={updatePhone}
          placeholder={demoPhoneLabel}
          placeholderTextColor={colors.muted}
          style={[styles.input, phoneInvalid && styles.invalidInput]}
        />
        {phoneInvalid && <Text accessibilityRole="alert" tone="red">{t('Enter the demo phone number shown here.', 'Andika nimero y’igerageza yerekanwe hano.')}</Text>}
        <Button label={t('Use demo number', 'Koresha nimero y’igerageza')} variant="secondary" disabled={busy} onPress={() => updatePhone(demoPhoneLabel)} />
      </Card>

      <Card>
        <Text variant="heading" accessibilityRole="header">{quote ? t('Review your order', 'Reba komande yawe') : t('Order summary', 'Incamake ya komande')}</Text>
        {quote && slot && <Text variant="small" tone="muted">{t('Pickup', 'Gufata komande')} · {slotLabel(slot, locale)}</Text>}
        {(quote?.lines ?? cart).map((line) => (
          <View key={`${line.sku}:${line.modifierIds.join(',')}`} style={styles.row}>
            <View style={styles.shrink}>
              <Text>{line.quantity} × {itemName(line.sku, locale, menu)}</Text>
              {line.modifierIds.length > 0 && <Text variant="small" tone="muted">{itemOptions(line, locale, menu)}</Text>}
            </View>
            <Text>{money(line.quantity * line.unitPrice)}</Text>
          </View>
        ))}
        {quote && (
          <>
            {quote.changes.map((change, index) => <Text key={index} tone="red">{changeLabel(change, locale, menu)}</Text>)}
            {!quote.lines.length && <Button label={t('Edit cart', 'Hindura agatebo')} variant="secondary" onPress={() => router.replace('/cart')} />}
            <View style={styles.row}>
              <Text style={styles.shrink} tone="muted">{t('Included tax', 'Umusoro urimo')}</Text>
              <Text tone="muted">{money(quote.tax)}</Text>
            </View>
          </>
        )}
        <View style={[styles.row, styles.total]}>
          <Text variant="label" style={styles.shrink}>{quote ? t('Total', 'Igiteranyo') : t('Estimated total', 'Igiteranyo cy’agateganyo')}</Text>
          <Text variant="label">{money(quote?.total ?? total)}</Text>
        </View>
        <Text variant="small" tone="muted">{quote
          ? t('Confirm the shown items, total and time to open demo payment.', 'Emeza ibyo ubonye, igiteranyo n’igihe kugira ngo wishyure mu igerageza.')
          : t('We’ll confirm the items, price and time before payment.', 'Tuzemeza ibiribwa, igiciro n’igihe mbere yo kwishyura.')}</Text>
      </Card>
      {problem && (
        <Card>
          <Text accessibilityRole="alert" tone="red">{problem}</Text>
          <Button label={t('Go to Orders', 'Jya muri Komande')} onPress={() => router.replace('/(tabs)/orders')} variant="ghost" />
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 6 },
  slotGroup: { gap: 9 },
  row: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 },
  shrink: { flexShrink: 1 },
  total: { borderTopColor: colors.border, borderTopWidth: 1, paddingTop: 10 },
  slot: {
    minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: 12,
    paddingHorizontal: 10, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 9,
  },
  selected: { borderColor: colors.green, backgroundColor: colors.mint },
  dimmed: { opacity: 0.62 },
  input: {
    minHeight: 48, paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 17, color: colors.ink, borderWidth: 1, borderColor: colors.border, borderRadius: 12,
  },
  invalidInput: { borderColor: colors.red },
});
