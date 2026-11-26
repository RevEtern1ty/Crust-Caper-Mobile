import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useCallback } from 'react';
import { Platform } from 'react-native';
import { useCheckout } from '../src/checkout/context';
import { checkoutPaymentReturnOrderId } from '../src/checkout/payment-return';

export default function PaymentReturn() {
  const { orderId } = useLocalSearchParams<{ orderId?: string | string[] }>();
  const { journal, restoreFailed, setRequestedOrderId } = useCheckout();
  useFocusEffect(useCallback(() => {
    if (!journal && !restoreFailed) return;

    setRequestedOrderId(checkoutPaymentReturnOrderId(orderId, journal));
    if (Platform.OS === 'ios') void WebBrowser.dismissBrowser().catch(() => undefined);
    router.replace('/(tabs)/orders');
  }, [journal, orderId, restoreFailed, setRequestedOrderId]));
  return null;
}
