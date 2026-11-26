import { router, usePathname } from 'expo-router';

import { useCheckout } from '../../src/checkout/context';
import OrdersScreen from '../../src/checkout/OrdersScreen';
import { paymentReturnOrderId } from '../../src/checkout/payment-return';
import { useShop } from '../../src/state/shop';
import { Button, Screen, Text } from '../../src/ui/core';
import { copy } from '../../src/ui/format';

export default function DirectOrderScreen() {
  const pathname = usePathname();
  const { hydrated, locale, webCheckout } = useShop();
  const { guestSessionEndPending, guestSessionRevision, journal, restoreFailed } = useCheckout();
  const orderId = pathname.startsWith('/order/') ? paymentReturnOrderId(pathname.slice('/order/'.length)) : null;
  const t = (en: string, rw: string) => copy(locale, en, rw);

  if (!webCheckout || !orderId) {
    return (
      <Screen safeBottom>
        <Text variant="title" accessibilityRole="header">{t('Order link unavailable', 'Ihuza rya komande ntiriboneka')}</Text>
        <Button label={t('Go to Orders', 'Jya muri Komande')} onPress={() => router.replace('/(tabs)/orders')} />
      </Screen>
    );
  }
  if (guestSessionEndPending) {
    return (
      <Screen safeBottom>
        <Text>{t('Finish ending this session in Settings.', 'Rangiriza gusoza iki gihe mu Magenamiterere.')}</Text>
        <Button label={t('Settings', 'Igenamiterere')} onPress={() => router.push('/settings')} />
      </Screen>
    );
  }
  if (!hydrated || (!journal && !restoreFailed)) {
    return <Screen safeBottom><Text>{t('Checking order access…', 'Turimo kugenzura uburenganzira bwo kureba komande…')}</Text></Screen>;
  }
  return <OrdersScreen key={`${orderId}:${guestSessionRevision}`} directOrderId={orderId} />;
}
