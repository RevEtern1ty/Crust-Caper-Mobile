import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback } from 'react';
import { useCheckout } from '../src/checkout/context';
import { savedPaymentReturnOrderId } from '../src/checkout/payment-return';
import { useShop } from '../src/state/shop';

export default function WebPaymentReturn() {
  const { orderId } = useLocalSearchParams<{ orderId?: string | string[] }>();
  const { webCheckout } = useShop();
  const { journal, restoreFailed, setRequestedOrderId } = useCheckout();
  useFocusEffect(useCallback(() => {
    if (webCheckout && !journal && !restoreFailed) return;

    // The browser route only selects a saved order. Orders fetches the payment result from the API.
    const active = journal?.active;
    const activeOrder = active && active.phase !== 'creating' ? active.orderId : undefined;
    setRequestedOrderId(webCheckout && journal
      ? savedPaymentReturnOrderId(orderId ?? activeOrder, journal.orderIds) : null);
    router.replace('/(tabs)/orders');
  }, [journal, orderId, restoreFailed, setRequestedOrderId, webCheckout]));
  return null;
}
