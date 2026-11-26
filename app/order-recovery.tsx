import { useLocalSearchParams } from 'expo-router';
import { OrderAccessForm } from '../src/checkout/OrderAccessForm';

export default function OrderRecoveryScreen() {
  const { from, orderCode: savedCode, pending } =
    useLocalSearchParams<{ from?: string; orderCode?: string; pending?: string }>();
  return <OrderAccessForm from={from} savedCode={savedCode} pendingOrder={pending === '1'} />;
}
