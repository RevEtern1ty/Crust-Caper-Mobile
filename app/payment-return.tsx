import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useCallback } from 'react';
import { Platform } from 'react-native';
import { useCheckout } from '../src/checkout/context';
import { paymentReturnOrderId } from '../src/checkout/payment-return';

export default function PaymentReturn() {
  const { orderId } = useLocalSearchParams<{ orderId?: string | string[] }>();
  const { setRequestedOrderId } = useCheckout();
  const requestedOrder = paymentReturnOrderId(orderId);
  useFocusEffect(useCallback(() => {
    setRequestedOrderId(requestedOrder);
    if (Platform.OS === 'ios') void WebBrowser.dismissBrowser().catch(() => undefined);
    router.replace('/(tabs)/orders');
  }, [requestedOrder, setRequestedOrderId]));
  return null;
}
