import { useRouter } from 'expo-router';
import { Linking, StyleSheet, View } from 'react-native';
import { useState } from 'react';
import { useShop } from '../../src/state/shop';
import { Button, Card, colors, Icon, Screen, Text } from '../../src/ui/core';
import { copy, slotLabel } from '../../src/ui/format';

export default function PickupScreen() {
  const { locale, menu } = useShop();
  const router = useRouter();
  const [linkError, setLinkError] = useState(false);
  const store = menu?.store;
  const next = menu?.slots.find(slot => slot.available && Date.parse(slot.startsAt) > Date.now());

  async function open(url: string) {
    try {
      if (!['https:', 'mailto:', 'tel:'].includes(new URL(url).protocol)) throw new Error('Unsupported link');
      await Linking.openURL(url);
      setLinkError(false);
    } catch {
      setLinkError(true);
    }
  }

  return (
    <Screen>
      <Text variant="title" accessibilityRole="header">{copy(locale, 'Pickup', 'Kwakira')}</Text>
      <Card style={styles.location}>
        <View style={styles.pin}><Icon name="location-outline" size={29} color={colors.green} /></View>
        <Text variant="heading">{store?.name[locale] ?? 'CrustCaper Kigali'}</Text>
        <Text>{store?.area[locale] ?? copy(locale, 'Kigali, Rwanda', 'Kigali, u Rwanda')}</Text>
        <Text variant="small" tone="muted">{store?.hours[locale] ?? copy(locale, 'Demo store · Kigali time', 'Aho kugeragereza · Isaha ya Kigali')}</Text>
        {next && <Text variant="label" tone="green">{copy(locale, 'Next demo slot', 'Igihe gikurikira cy’igerageza')} · {slotLabel(next, locale)}</Text>}
        {store?.directionsUrl ? <Button label={copy(locale, 'Get directions', 'Reba inzira')} onPress={() => { void open(store.directionsUrl!); }} variant="secondary" />
          : <Text variant="small" tone="muted">{copy(locale, 'Pickup address will be published before the pilot.', 'Aderesi yo kwakiriraho izatangazwa mbere y’igerageza.')}</Text>}
      </Card>
      <Card>
        <Text variant="heading" accessibilityRole="header">{copy(locale, 'At the counter', 'Aho bakirira abakiriya')}</Text>
        <Text>{copy(locale, 'Open Orders. When your order is ready, show the pickup code at the counter.', 'Fungura Komande. Komande yawe nimara gutegurwa, erekana kode yayo aho bakirira abakiriya.')}</Text>
        <Button label={copy(locale, 'Open orders', 'Fungura komande')} onPress={() => router.navigate('/orders')} variant="secondary" />
      </Card>
      <Card>
        <Text variant="heading" accessibilityRole="header">{copy(locale, 'Order help', 'Ubufasha kuri komande')}</Text>
        {store?.supportUrl ? <Button label={copy(locale, 'Contact support', 'Saba ubufasha')} onPress={() => { void open(store.supportUrl!); }} variant="secondary" />
          : <Text>{copy(locale, 'Contact details will be available when the pickup point launches.', 'Uburyo bwo gusaba ubufasha buzaboneka aho kwakirira hamaze gufungura.')}</Text>}
        {linkError && <Text tone="red" accessibilityLiveRegion="polite">{copy(locale, 'Could not open this link.', 'Iri huriro ntiryafungutse.')}</Text>}
      </Card>
      <Button label={copy(locale, 'Settings', 'Amagenamiterere')} onPress={() => router.push('/settings')} variant="ghost" />
    </Screen>
  );
}

const styles = StyleSheet.create({
  location: { backgroundColor: colors.mint, borderColor: '#C7D9CC' },
  pin: { backgroundColor: colors.white, width: 48, height: 48, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
});
