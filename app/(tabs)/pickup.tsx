import { useRouter } from 'expo-router';
import { Linking, StyleSheet, View } from 'react-native';
import { useState } from 'react';
import { useShop } from '../../src/state/shop';
import { Button, Card, colors, Icon, Screen, Text } from '../../src/ui/core';
import { copy, slotLabel } from '../../src/ui/format';
import { useNextPickupSlot } from '../../src/ui/use-next-pickup-slot';

type LinkAction = 'directions' | 'support';

export default function PickupScreen() {
  const { locale, mode, menu, status, refreshing, refreshMenu, pickupNow } = useShop();
  const router = useRouter();
  const [linkErrors, setLinkErrors] = useState({ directions: false, support: false });
  const store = menu?.store;
  const next = useNextPickupSlot(status === 'ready' ? menu : null, pickupNow, refreshMenu);
  const directionsUrl = store?.directionsUrl;
  const supportUrl = store?.supportUrl;

  async function open(action: LinkAction, url: string) {
    setLinkErrors(current => ({ ...current, [action]: false }));
    try {
      if (!['https:', 'mailto:', 'tel:'].includes(new URL(url).protocol)) throw new Error('Unsupported link');
      await Linking.openURL(url);
    } catch {
      setLinkErrors(current => ({ ...current, [action]: true }));
    }
  }

  return (
    <Screen onRefresh={() => { void refreshMenu(); }} refreshing={refreshing}>
      <Text variant="title" accessibilityRole="header">{copy(locale, 'Pickup', 'Kwakira')}</Text>
      <Card style={styles.location}>
        <View style={styles.pin}><Icon name="location-outline" size={29} color={colors.green} /></View>
        <Text variant="heading">{store?.name[locale] ?? 'CrustCaper Kigali'}</Text>
        <Text>{store?.area[locale] ?? copy(locale, 'Kigali, Rwanda', 'Kigali, u Rwanda')}</Text>
        {store && <Text variant="small" tone="muted">{store.hours[locale]}</Text>}
        {next && <Text variant="label" tone="green">{mode === 'demo'
          ? copy(locale, 'Next demo slot', 'Igihe gikurikira cy’igerageza')
          : copy(locale, 'Next pickup time', 'Igihe gikurikira cyo kwakira')} · {slotLabel(next, locale)}</Text>}
        {status === 'ready' && !next && <Text variant="label" tone="muted">{!store?.open
          ? copy(locale, 'Closed', 'Hafunze')
          : refreshing
            ? copy(locale, 'Pickup availability unconfirmed.', 'Igihe cyo gufata komande ntikiramenyekana.')
            : copy(locale, 'No slots available', 'Nta mwanya uhari')}</Text>}
        {(status === 'stale' || status === 'unavailable') && (
          <>
            <Text tone="muted" accessibilityLiveRegion="polite">{copy(locale, 'Pickup availability unconfirmed.', 'Igihe cyo gufata komande ntikiramenyekana.')}</Text>
            <Button label={copy(locale, 'Refresh availability', 'Reba niba komande zakirwa')} variant="secondary"
              busy={refreshing} onPress={() => { void refreshMenu(); }} />
          </>
        )}
        {directionsUrl ? <Button label={copy(locale, 'Get directions', 'Reba inzira')} onPress={() => { void open('directions', directionsUrl); }} variant="secondary" />
          : <Text variant="small" tone="muted">{copy(locale, 'Pickup address will be published before the pilot.', 'Aderesi yo kwakiriraho izatangazwa mbere y’igerageza.')}</Text>}
        {linkErrors.directions && <Text tone="red" accessibilityRole="alert">{copy(locale, 'Could not open the directions.', 'Inzira ntiyafungutse.')}</Text>}
      </Card>
      <Card>
        <Text variant="heading" accessibilityRole="header">{copy(locale, 'At the counter', 'Aho bakirira abakiriya')}</Text>
        <Text>{copy(locale, 'Open Orders. When your order is ready, show the pickup code at the counter.', 'Fungura Komande. Komande yawe nimara gutegurwa, erekana kode yayo aho bakirira abakiriya.')}</Text>
        <Button label={copy(locale, 'Open orders', 'Fungura komande')} onPress={() => router.navigate('/orders')} variant="secondary" />
      </Card>
      <Card>
        <Text variant="heading" accessibilityRole="header">{copy(locale, 'Order help', 'Ubufasha kuri komande')}</Text>
        {supportUrl ? <Button label={copy(locale, 'Contact support', 'Saba ubufasha')} onPress={() => { void open('support', supportUrl); }} variant="secondary" />
          : <Text>{copy(locale, 'Contact details will be available when the pickup point launches.', 'Uburyo bwo gusaba ubufasha buzaboneka aho kwakirira hamaze gufungura.')}</Text>}
        {linkErrors.support && <Text tone="red" accessibilityRole="alert">{copy(locale, 'Could not open the support link.', 'Ihuriro ry’ubufasha ntiryafungutse.')}</Text>}
      </Card>
      <Button label={copy(locale, 'Settings', 'Amagenamiterere')} onPress={() => router.push('/settings')} variant="ghost" />
    </Screen>
  );
}

const styles = StyleSheet.create({
  location: { backgroundColor: colors.mint, borderColor: '#C7D9CC' },
  pin: { backgroundColor: colors.white, width: 48, height: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
});
