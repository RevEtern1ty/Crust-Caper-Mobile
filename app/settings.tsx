import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, type Text as NativeText, View } from 'react-native';
import { useCheckout } from '../src/checkout/context';
import { CheckoutError } from '../src/checkout/controller';
import { useShop } from '../src/state/shop';
import { Button, Card, colors, Icon, Screen, Text } from '../src/ui/core';
import { copy } from '../src/ui/format';

const languages = [{ id: 'en', name: 'English' }, { id: 'rw', name: 'Kinyarwanda' }] as const;

export default function SettingsScreen() {
  const { locale, mode, setLocale, hydrated } = useShop();
  const { journal, busy, restoreFailed, retryRestore, guestSessionEndPending, endGuestSession } = useCheckout();
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [ended, setEnded] = useState(false);
  const [endError, setEndError] = useState<'active' | 'failed' | null>(null);
  const orderAccessHeading = useRef<NativeText>(null);
  const isWeb = Platform.OS === 'web';
  const t = (en: string, rw: string) => copy(locale, en, rw);

  useEffect(() => {
    if (isWeb && (confirmEnd || guestSessionEndPending || ended)) orderAccessHeading.current?.focus();
  }, [confirmEnd, ended, guestSessionEndPending, isWeb]);

  async function endSession() {
    if (!endGuestSession || busy) return;
    setEndError(null);
    try {
      await endGuestSession();
      setEnded(true);
      setConfirmEnd(false);
    } catch (error) {
      setEndError(error instanceof CheckoutError && error.code === 'active_checkout' ? 'active' : 'failed');
    }
  }

  return (
    <Screen safeBottom>
      <View role={isWeb ? 'group' : undefined} aria-labelledby={isWeb ? 'language-heading' : undefined} style={styles.languages}>
        <Text nativeID={isWeb ? 'language-heading' : undefined} variant="heading" accessibilityRole="header">
          {copy(locale, 'Language', 'Ururimi')}
        </Text>
        {languages.map(language => {
          const selected = locale === language.id;
          return <Pressable key={language.id} accessibilityRole={isWeb ? 'button' : 'radio'}
            aria-pressed={isWeb ? selected : undefined}
            accessibilityState={{ checked: selected, disabled: !hydrated }} accessibilityLanguage={language.id}
            disabled={!hydrated} onPress={() => setLocale(language.id)} style={[styles.language, selected && styles.selected]}>
            <Text variant="label">{language.name}</Text>
            <Icon name={selected ? 'radio-button-on' : 'radio-button-off'} color={colors.green} />
          </Pressable>;
        })}
      </View>
      {endGuestSession && <Card>
        <Text ref={orderAccessHeading} tabIndex={isWeb ? -1 : undefined} variant="heading" accessibilityRole="header">
          {t('Order access', 'Uburenganzira bwo kureba komande')}
        </Text>
        {ended && <Text accessibilityLiveRegion="polite">{t('Order access was cleared on this device.', 'Uburenganzira bwo kureba komande kuri iki gikoresho bwakuweho.')}</Text>}
        {!ended && (guestSessionEndPending || confirmEnd) && <>
          <Text>{guestSessionEndPending
            ? t('Finish ending this session to clear saved order access.', 'Rangiza gusoza iki gihe kugira ngo ukureho uburenganzira bwo kureba komande.')
            : t('This clears saved order access on this device. Keep your order number to find an order again by phone.',
              'Ibi bikuraho uburenganzira bwo kureba komande kuri iki gikoresho. Bika nimero ya komande kugira ngo wongere kuyibona ukoresheje telefoni.')}</Text>
          {endError && <Text tone="red" accessibilityRole="alert">{endError === 'active'
            ? t('Finish or collect your open orders before ending this session.', 'Rangiza cyangwa ufate komande zigikomeza mbere yo gusoza iki gihe.')
            : t('We couldn’t end this session. Try again.', 'Ntitwashoboye gusoza iki gihe. Ongera ugerageze.')}</Text>}
          <Button label={guestSessionEndPending ? t('Retry ending the session', 'Ongera ugerageze gusoza iki gihe') : t('Confirm end session', 'Emeza gusoza iki gihe')}
            onPress={() => { void endSession(); }} busy={busy} />
          {!guestSessionEndPending && <Button label={t('Keep my session', 'Komeza gukoresha iki gihe')} onPress={() => {
            setConfirmEnd(false);
            setEndError(null);
          }} variant="ghost" disabled={busy} />}
        </>}
        {!ended && !guestSessionEndPending && !confirmEnd && (restoreFailed
          ? <Button label={t('Retry opening saved orders', 'Ongera ugerageze gufungura komande zabitswe')} onPress={() => { void retryRestore(); }} variant="secondary" busy={busy} />
          : <Button label={t('End guest session', 'Soza igihe cy’umushyitsi')} onPress={() => setConfirmEnd(true)} variant="secondary" disabled={!journal || busy} />)}
      </Card>}
      {mode === 'connected' && (
        <Button label={t('Order privacy', 'Amakuru bwite ya komande')} variant="secondary" onPress={() => router.push('/privacy')} />
      )}
      {mode === 'demo' && <Card>
        <Text variant="heading">{copy(locale, 'CrustCaper Demo', 'Igerageza rya CrustCaper')}</Text>
        <Text>{copy(locale, 'Orders and payments use test data. Follow their status under Orders.', 'Komande no kwishyura bikoresha amakuru y’igerageza. Kurikirana uko bimeze muri Komande.')}</Text>
        <Text variant="small" tone="muted">{copy(locale, 'Test orders are saved on this device. Use the demo phone number at checkout.', 'Komande z’igerageza zibikwa kuri iki gikoresho. Koresha nimero y’igerageza igihe wemeza komande.')}</Text>
      </Card>}
    </Screen>
  );
}

const styles = StyleSheet.create({
  languages: { gap: 8 },
  language: {
    minHeight: 54, borderWidth: 1, borderRadius: 12, borderColor: colors.border,
    paddingHorizontal: 14, paddingVertical: 10, flexDirection: 'row',
    alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.white,
  },
  selected: { backgroundColor: colors.mint, borderColor: colors.green },
});
