import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { normalizePhone } from '../src/checkout/contact';
import { useCheckout, useRouteActionGuard } from '../src/checkout/context';
import { checkoutError } from '../src/checkout/labels';
import { ApiError } from '../src/domain/types';
import { useShop } from '../src/state/shop';
import { Button, Card, colors, Screen, Text } from '../src/ui/core';
import { copy } from '../src/ui/format';

type Step = { kind: 'details' } | { kind: 'code'; challengeId: string } | { kind: 'save'; orderId: string };
type Field = 'orderCode' | 'phone' | 'code';

export default function OrderRecoveryScreen() {
  const { from, orderCode: savedCode } = useLocalSearchParams<{ from?: string; orderCode?: string }>();
  const { api, checkoutAllowed, locale, mode } = useShop();
  const { rememberRecoveredOrder, setRequestedOrderId } = useCheckout();
  const guardNavigation = useRouteActionGuard();
  const [step, setStep] = useState<Step>({ kind: 'details' });
  const [orderCode, setOrderCode] = useState(() =>
    typeof savedCode === 'string' && /^[0-9A-F]{8}$/.test(savedCode) ? savedCode : '');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<Field | null>(null);
  const orderInput = useRef<TextInput>(null);
  const phoneInput = useRef<TextInput>(null);
  const codeInput = useRef<TextInput>(null);
  const running = useRef(false);
  const t = (en: string, rw: string) => copy(locale, en, rw);
  const available = mode === 'connected' && checkoutAllowed && !!api.requestOrderAccess && !!api.verifyOrderAccess;

  function goToOrders() {
    if (from === 'orders' && router.canGoBack()) router.back();
    else router.replace('/(tabs)/orders');
  }

  function showInputError(field: Field, message: string) {
    const input = field === 'orderCode' ? orderInput : field === 'phone' ? phoneInput : codeInput;
    setInvalid(field);
    setProblem(message);
    input.current?.focus();
  }

  async function submit() {
    if (!available || !api.requestOrderAccess || !api.verifyOrderAccess || running.current) return;

    const reference = orderCode.trim().replace(/^#/, '').toUpperCase();
    const normalizedPhone = normalizePhone(phone);
    if (step.kind === 'details') {
      if (!/^[0-9A-F]{8}$/.test(reference)) {
        showInputError('orderCode', t('Enter the eight characters of the order number.', 'Andika inyuguti n’imibare umunani bya nimero ya komande.'));
        return;
      }
      if (!normalizedPhone) {
        showInputError('phone', t('Enter the phone number with a country code, starting with +.', 'Andika nimero ya telefoni n’indangagihugu, itangizwa na +.'));
        return;
      }
    }
    if (step.kind === 'code' && !/^[0-9]{6}$/.test(code)) {
      showInputError('code', t('Enter the six-digit verification code.', 'Andika kode yo kwemeza igizwe n’imibare itandatu.'));
      return;
    }

    const shouldNavigate = guardNavigation();
    let saving = step.kind === 'save';
    running.current = true;
    setPending(true);
    setInvalid(null);
    setProblem(null);
    try {
      if (step.kind === 'details' && normalizedPhone) {
        const { challengeId } = await api.requestOrderAccess({ orderCode: reference, phone: normalizedPhone });
        if (shouldNavigate()) setStep({ kind: 'code', challengeId });
        return;
      }

      const orderId = step.kind === 'code'
        ? (await api.verifyOrderAccess(step.challengeId, code)).orderId
        : step.kind === 'save' ? step.orderId : null;
      if (!orderId) return;
      saving = true;
      setCode('');
      setPhone('');
      setOrderCode('');
      setStep({ kind: 'save', orderId });
      await rememberRecoveredOrder(orderId);
      if (shouldNavigate()) {
        setRequestedOrderId(orderId);
        goToOrders();
      }
    } catch (error) {
      if (!shouldNavigate()) return;
      if (saving) {
        setProblem(t('The order was verified. Try saving it on this device again.', 'Komande yemejwe. Ongera ugerageze kuyibika kuri iki gikoresho.'));
      } else if (step.kind === 'code' && error instanceof ApiError && (error.code === 'not_found' || error.code === 'invalid_input')) {
        showInputError('code', t('That code could not be confirmed. Try again or request a new code.', 'Iyo kode ntiyemejwe. Ongera ugerageze cyangwa usabe indi kode.'));
      } else if (error instanceof ApiError && error.code === 'rate_limited') {
        setProblem(t('Too many attempts. Try again later.', 'Wagerageje inshuro nyinshi. Ongera ugerageze nyuma.'));
      } else {
        setProblem(checkoutError(error, locale));
      }
    } finally {
      setPending(false);
      running.current = false;
    }
  }

  function changeDetails() {
    setCode('');
    setInvalid(null);
    setProblem(null);
    setStep({ kind: 'details' });
  }

  if (!available) {
    return (
      <Screen safeBottom>
        <Text variant="title" accessibilityRole="header">{t('Find an order', 'Shaka komande')}</Text>
        <Text>{t('Use a connected CrustCaper app to recover an order.', 'Koresha porogaramu ya CrustCaper ihujwe na serivisi kugira ngo ubone komande.')}</Text>
        <Button label={t('Go to Orders', 'Jya muri Komande')} onPress={goToOrders} />
      </Screen>
    );
  }

  return (
    <Screen key={step.kind} safeBottom bottom={(
      <View style={styles.stack}>
        {problem && <Text tone="red" accessibilityRole="alert">{problem}</Text>}
        <Button label={step.kind === 'details' ? t('Request verification code', 'Saba kode yo kwemeza')
          : step.kind === 'code' ? t('Verify and open order', 'Emeza kode ufungure komande')
            : t('Save order', 'Bika komande')}
        busy={pending} onPress={() => { void submit(); }} />
      </View>
    )}>
      <Text variant="title" accessibilityRole="header">{step.kind === 'details' ? t('Find your order', 'Shaka komande yawe')
        : step.kind === 'code' ? t('Verify your phone', 'Emeza nimero ya telefoni')
          : t('Order verified', 'Komande yemejwe')}</Text>
      {step.kind === 'details' && (
        <Card>
          <Text>{t('Enter the order number and the phone number used at checkout.', 'Andika nimero ya komande na nimero ya telefoni wakoresheje igihe wayitumizaga.')}</Text>
          <Text variant="label">{t('Order number', 'Nimero ya komande')}</Text>
          <TextInput ref={orderInput} accessibilityLabel={t('Order number', 'Nimero ya komande')}
            value={orderCode} onChangeText={(value) => { setOrderCode(value); setInvalid(null); }}
            placeholder="#1A2B3C4D" placeholderTextColor={colors.muted}
            autoCapitalize="characters" autoComplete="off" autoCorrect={false} maxLength={12} editable={!pending}
            style={[styles.input, invalid === 'orderCode' && styles.invalid]} />
          <Text variant="label">{t('Phone number', 'Nimero ya telefoni')}</Text>
          <TextInput ref={phoneInput} accessibilityLabel={t('Phone number', 'Nimero ya telefoni')}
            value={phone} onChangeText={(value) => { setPhone(value); setInvalid(null); }}
            placeholder="+250 …" placeholderTextColor={colors.muted}
            autoComplete="tel" keyboardType="phone-pad" maxLength={24} editable={!pending}
            style={[styles.input, invalid === 'phone' && styles.invalid]} />
        </Card>
      )}
      {step.kind === 'code' && (
        <Card>
          <Text>{t('If the details match, you’ll receive a six-digit code by SMS.', 'Amakuru namara guhura, uzahabwa kode y’imibare itandatu muri SMS.')}</Text>
          <Text variant="label">{t('Verification code', 'Kode yo kwemeza')}</Text>
          <TextInput ref={codeInput} accessibilityLabel={t('Verification code', 'Kode yo kwemeza')}
            value={code} onChangeText={(value) => { setCode(value.replace(/[^0-9]/g, '')); setInvalid(null); }}
            autoComplete="one-time-code" keyboardType="number-pad" maxLength={6} editable={!pending}
            style={[styles.input, invalid === 'code' && styles.invalid]} />
          <Button label={t('Request a new code', 'Saba indi kode')} variant="ghost" disabled={pending} onPress={changeDetails} />
        </Card>
      )}
      {step.kind === 'save' && <Text>{t('Save this order to see its status on this device.', 'Bika iyi komande kugira ngo ubone uko ihagaze kuri iki gikoresho.')}</Text>}
    </Screen>
  );
}

const styles = StyleSheet.create({
  stack: { gap: 6 },
  input: {
    minHeight: 48, paddingHorizontal: 12, paddingVertical: 10,
    fontSize: 17, color: colors.ink, borderWidth: 1, borderColor: colors.border, borderRadius: 12,
  },
  invalid: { borderColor: colors.red },
});
