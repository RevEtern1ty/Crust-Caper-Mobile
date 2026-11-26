import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import { ApiError } from '../domain/types';
import { useShop } from '../state/shop';
import { Button, Card, colors, Screen, Text } from '../ui/core';
import { copy } from '../ui/format';
import { normalizePhone } from './contact';
import { useCheckout, useRouteActionGuard } from './context';
import { checkoutError } from './labels';

type Step = { kind: 'details' } | { kind: 'code'; challengeId: string }
  | { kind: 'save'; orderId: string; sessionRevision: number } | { kind: 'notPlaced' };
type Field = 'orderCode' | 'phone' | 'code';

export function OrderAccessForm({ from, savedCode, pendingOrder = false, onPrivacyVerified, notice, suspended = false }: {
  from?: string;
  savedCode?: string;
  pendingOrder?: boolean;
  onPrivacyVerified?: (orderId: string, sessionRevision: number) => void;
  notice?: string;
  suspended?: boolean;
}) {
  const { api, checkoutAllowed, locale, mode } = useShop();
  const {
    guestSessionEndPending, guestSessionRevision, journal, restoreFailed, pendingOrderRecoveryChallengeId,
    requestPendingOrderRecovery, confirmPendingOrderRecovery, rememberRecoveredOrder, setRequestedOrderId,
  } = useCheckout();
  const guardNavigation = useRouteActionGuard();
  const [currentStep, setStep] = useState<Step>({ kind: 'details' });
  const [dismissedChallenge, setDismissedChallenge] = useState<string>();
  const [orderCode, setOrderCode] = useState(() =>
    typeof savedCode === 'string' && /^[0-9A-F]{8}$/.test(savedCode) ? savedCode : '');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [invalid, setInvalid] = useState<Field | null>(null);
  const orderInput = useRef<TextInput>(null);
  const phoneInput = useRef<TextInput>(null);
  const codeInput = useRef<TextInput>(null);
  const running = useRef(false);
  const displayedRevision = useRef(guestSessionRevision);
  const t = (en: string, rw: string) => copy(locale, en, rw);
  const privacy = !!onPrivacyVerified;
  const step: Step = pendingOrder && currentStep.kind === 'details' && pendingOrderRecoveryChallengeId
    && dismissedChallenge !== pendingOrderRecoveryChallengeId
    ? { kind: 'code', challengeId: pendingOrderRecoveryChallengeId }
    : currentStep;
  const available = mode === 'connected' && checkoutAllowed && !guestSessionEndPending
    && (pendingOrder
      ? !!requestPendingOrderRecovery && !!confirmPendingOrderRecovery && journal?.active?.phase === 'creating'
      : !!api.requestOrderAccess && !!api.verifyOrderAccess);

  useEffect(() => {
    if (displayedRevision.current === guestSessionRevision) return;
    displayedRevision.current = guestSessionRevision;
    setStep({ kind: 'details' });
    setDismissedChallenge(undefined);
    setOrderCode('');
    setPhone('');
    setCode('');
    setProblem(null);
    setWaiting(false);
    setInvalid(null);
  }, [guestSessionRevision]);

  useEffect(() => {
    if (!suspended) return;
    setOrderCode('');
    setPhone('');
    setCode('');
  }, [suspended]);

  function goToOrders() {
    if (!pendingOrder && from === 'orders' && router.canGoBack()) router.back();
    else router.replace('/(tabs)/orders');
  }

  function showInputError(field: Field, message: string) {
    const input = field === 'orderCode' ? orderInput : field === 'phone' ? phoneInput : codeInput;
    setInvalid(field);
    setProblem(message);
    input.current?.focus();
  }

  async function submit() {
    if (!available || running.current) return;

    const reference = orderCode.trim().replace(/^#/, '').toUpperCase();
    const normalizedPhone = normalizePhone(phone);
    if (step.kind === 'details') {
      if (!pendingOrder && !/^[0-9A-F]{8}$/.test(reference)) {
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
    const sessionRevision = step.kind === 'save' ? step.sessionRevision : guestSessionRevision;
    let saving = step.kind === 'save';
    running.current = true;
    setPending(true);
    setInvalid(null);
    setProblem(null);
    setWaiting(false);
    try {
      if (pendingOrder) {
        if (step.kind === 'details' && normalizedPhone && requestPendingOrderRecovery) {
          const result = await requestPendingOrderRecovery(normalizedPhone);
          if (!shouldNavigate() || displayedRevision.current !== sessionRevision) return;
          if (result.state === 'not_placed') {
            setPhone('');
            setStep({ kind: 'notPlaced' });
          } else if (result.state === 'waiting') {
            setWaiting(true);
          } else {
            setStep({ kind: 'code', challengeId: result.challengeId });
          }
          return;
        }
        if (step.kind === 'code' && confirmPendingOrderRecovery) {
          const order = await confirmPendingOrderRecovery(step.challengeId, code);
          if (shouldNavigate() && displayedRevision.current === sessionRevision) {
            setCode('');
            setPhone('');
            setRequestedOrderId(order.id);
            goToOrders();
          }
        }
        return;
      }
      if (!api.requestOrderAccess || !api.verifyOrderAccess) return;
      if (step.kind === 'details' && normalizedPhone) {
        const { challengeId } = await api.requestOrderAccess({ orderCode: reference, phone: normalizedPhone });
        if (shouldNavigate() && displayedRevision.current === sessionRevision) {
          if (privacy) {
            setOrderCode('');
            setPhone('');
          }
          setStep({ kind: 'code', challengeId });
        }
        return;
      }

      const orderId = step.kind === 'code'
        ? (await api.verifyOrderAccess(step.challengeId, code)).orderId
        : step.kind === 'save' ? step.orderId : null;
      if (!orderId || !shouldNavigate() || displayedRevision.current !== sessionRevision) return;
      setCode('');
      setPhone('');
      setOrderCode('');
      if (onPrivacyVerified) {
        onPrivacyVerified(orderId, sessionRevision);
        return;
      }
      saving = true;
      setStep({ kind: 'save', orderId, sessionRevision });
      await rememberRecoveredOrder(orderId, sessionRevision);
      if (shouldNavigate() && displayedRevision.current === sessionRevision) {
        setRequestedOrderId(orderId);
        goToOrders();
      }
    } catch (error) {
      if (!shouldNavigate() || displayedRevision.current !== sessionRevision) return;
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
    if (pendingOrder && step.kind === 'code') setDismissedChallenge(step.challengeId);
    setCode('');
    setInvalid(null);
    setProblem(null);
    setWaiting(false);
    setStep({ kind: 'details' });
  }

  if (suspended) return null;

  if (step.kind === 'notPlaced') {
    return (
      <Screen safeBottom>
        <Text variant="title" accessibilityRole="header">{t('No order was placed', 'Nta komande yakozwe')}</Text>
        <Text>{t('Your cart is saved. Choose a pickup time to check out again.', 'Agatebo kawe kabitswe. Hitamo igihe cyo gufata komande wongere wishyure.')}</Text>
        <Button label={t('Back to checkout', 'Subira aho kwishyurira')} onPress={() => router.replace('/checkout')} />
      </Screen>
    );
  }

  if (pendingOrder && !journal && !restoreFailed && !guestSessionEndPending) {
    return <Screen safeBottom><Text>{t('Opening saved checkout…', 'Turimo gufungura ubwishyu bwabitswe…')}</Text></Screen>;
  }

  if (!available) {
    return (
      <Screen safeBottom>
        <Text variant="title" accessibilityRole="header">{pendingOrder
          ? t('Recover checkout', 'Ongera ufungure ubwishyu') : t('Find an order', 'Shaka komande')}</Text>
        <Text>{guestSessionEndPending
          ? t('Finish ending this session in Settings.', 'Rangiriza gusoza iki gihe mu Magenamiterere.')
          : pendingOrder
            ? t('Open Orders to check your saved checkout.', 'Fungura Komande urebe ubwishyu bwabitswe.')
            : t('Use a connected CrustCaper app to recover an order.', 'Koresha porogaramu ya CrustCaper ihujwe na serivisi kugira ngo ubone komande.')}</Text>
        <Button label={t('Go to Orders', 'Jya muri Komande')} onPress={goToOrders} />
      </Screen>
    );
  }

  return (
    <Screen key={step.kind} safeBottom bottom={(
      <View style={styles.stack}>
        {problem && <Text tone="red" accessibilityRole="alert">{problem}</Text>}
        <Button label={step.kind === 'details' ? (pendingOrder
          ? t('Check saved checkout', 'Genzura ubwishyu bwabitswe') : t('Request verification code', 'Saba kode yo kwemeza'))
          : step.kind === 'code' ? (privacy
            ? t('Verify and continue', 'Emeza kode ukomeze') : t('Verify and open order', 'Emeza kode ufungure komande'))
            : t('Save order', 'Bika komande')}
        busy={pending} onPress={() => { void submit(); }} />
      </View>
    )}>
      <Text variant="title" accessibilityRole="header">{step.kind === 'details' ? (pendingOrder
        ? t('Recover checkout', 'Ongera ufungure ubwishyu')
        : privacy ? t('Order privacy', 'Amakuru bwite ya komande') : t('Find your order', 'Shaka komande yawe'))
        : step.kind === 'code' ? t('Verify your phone', 'Emeza nimero ya telefoni')
          : t('Order verified', 'Komande yemejwe')}</Text>
      {step.kind === 'details' && (
        <Card>
          {notice && <Text accessibilityRole="alert">{notice}</Text>}
          {privacy && <Text>{t('Verify a single order to download its data or request deletion.',
            'Emeza komande imwe kugira ngo ubike amakuru yayo cyangwa usabe ko asibwa.')}</Text>}
          <Text>{pendingOrder
            ? t('Enter the phone number you used at checkout.', 'Andika nimero ya telefoni wakoresheje igihe wayitumizaga.')
            : t('Enter the order number and the phone number used at checkout.', 'Andika nimero ya komande na nimero ya telefoni wakoresheje igihe wayitumizaga.')}</Text>
          {!pendingOrder && (
            <>
              <Text variant="label">{t('Order number', 'Nimero ya komande')}</Text>
              <TextInput ref={orderInput} accessibilityLabel={t('Order number', 'Nimero ya komande')}
                value={orderCode} onChangeText={(value) => { setOrderCode(value); setInvalid(null); }}
                placeholder="#1A2B3C4D" placeholderTextColor={colors.muted}
                autoCapitalize="characters" autoComplete="off" autoCorrect={false} maxLength={12} editable={!pending}
                style={[styles.input, invalid === 'orderCode' && styles.invalid]} />
            </>
          )}
          <Text variant="label">{t('Phone number', 'Nimero ya telefoni')}</Text>
          <TextInput ref={phoneInput} accessibilityLabel={t('Phone number', 'Nimero ya telefoni')}
            value={phone} onChangeText={(value) => { setPhone(value); setInvalid(null); }}
            placeholder="+250 …" placeholderTextColor={colors.muted}
            autoComplete="tel" keyboardType="phone-pad" maxLength={24} editable={!pending}
            style={[styles.input, invalid === 'phone' && styles.invalid]} />
          {waiting && <Text accessibilityLiveRegion="polite">{t(
            'The previous request can still finish. Wait a moment and check again.',
            'Icyifuzo cya mbere kiracyashobora kurangira. Tegereza gato wongere ugenzure.',
          )}</Text>}
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
