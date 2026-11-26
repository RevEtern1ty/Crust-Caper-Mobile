import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback } from 'react';
import { useCheckout } from '../src/checkout/context';
import { checkoutPaymentReturnOrderId } from '../src/checkout/payment-return';
import { useShop } from '../src/state/shop';

export default function WebPaymentReturn() {
  const { orderId } = useLocalSearchParams<{ orderId?: string | string[] }>();
  const { webCheckout } = useShop();
  const { journal, restoreFailed, setRequestedOrderId } = useCheckout();
  useFocusEffect(useCallback(() => {
    if (webCheckout && !journal && !restoreFailed) return;

    // The browser route only selects a saved order. Orders fetches the payment result from the API.
    setRequestedOrderId(webCheckout ? checkoutPaymentReturnOrderId(orderId, journal) : null);
    router.replace('/(tabs)/orders');
  }, [journal, orderId, restoreFailed, setRequestedOrderId, webCheckout]));
  return null;
}
