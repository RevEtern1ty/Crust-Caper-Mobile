import { useRouter } from 'expo-router';
import { Image, Pressable, StyleSheet, View } from 'react-native';
import { lineKey, MAX_QUANTITY, useShop } from '../src/state/shop';
import { Button, Card, colors, Icon, Screen, Text } from '../src/ui/core';
import { copy, money } from '../src/ui/format';
import { menuPhoto } from '../src/ui/menu-photos';

export default function CartScreen() {
  const { locale, menu, status, count, cart, hydrated, draftSaving, draftStorageError, changeQuantity, total, refreshMenu, refreshing } = useShop();
  const router = useRouter();
  const checkoutReady = count > 0 && status === 'ready' && !draftSaving && !draftStorageError;
  if (!hydrated) {
    return <Screen safeBottom>{!draftStorageError && <Text accessibilityLiveRegion="polite">
      {copy(locale, 'Opening cart…', 'Turimo gufungura agatebo…')}
    </Text>}</Screen>;
  }
  return (
    <Screen safeBottom bottom={count > 0 && <Button label={copy(locale, 'Choose pickup time', 'Hitamo igihe cyo kwakira')}
      disabled={!checkoutReady} onPress={() => router.push('/checkout')} />}>
      <Text variant="title" accessibilityRole="header">{copy(locale, 'Your cart', 'Igitebo cyawe')}</Text>
      {cart.length === 0 && <Card>
        <Icon name="bag-handle-outline" size={28} />
        <Text variant="heading">{copy(locale, 'Your cart is empty', 'Igitebo cyawe kirimo ubusa')}</Text>
        <Button label={copy(locale, 'Browse the menu', 'Reba amafunguro')} onPress={() => router.replace('/')} />
      </Card>}
      {cart.map(line => {
        const key = lineKey(line);
        const product = menu?.products.find(item => item.sku === line.sku);
        const photo = menuPhoto(line.sku);
        const name = product?.name[locale] ?? line.sku;
        const options = product?.modifiers.filter(option => line.modifierIds.includes(option.id)) ?? [];
        return <Card key={key}>
          <View style={styles.product}>
            {photo && <Image source={photo} style={styles.thumb} accessible={false} />}
            <View style={styles.productCopy}>
              <Text variant="heading">{name}</Text>
              {options.length > 0 && <Text variant="small" tone="muted">{options.map(option => option.name[locale]).join(' · ')}</Text>}
              {product && !product.available && <Text variant="small" tone="red">{copy(locale, 'Sold out', 'Byashize')}</Text>}
            </View>
          </View>
          <View style={styles.itemBar}>
            <View style={styles.stepper}>
              <Pressable accessibilityRole="button" accessibilityLabel={copy(locale, `Remove one ${name}`, `Kuramo imwe muri ${name}`)}
                style={styles.quantityButton} onPress={() => changeQuantity(key, -1)}>
                <Icon name={line.quantity === 1 ? 'trash-outline' : 'remove'} size={20} />
              </Pressable>
              <Text variant="label" accessibilityLiveRegion="polite">{line.quantity}</Text>
              <Pressable accessibilityRole="button" accessibilityLabel={copy(locale, `Add one ${name}`, `Ongeramo imwe muri ${name}`)}
                accessibilityState={{ disabled: line.quantity >= MAX_QUANTITY }}
                disabled={line.quantity >= MAX_QUANTITY} style={[styles.quantityButton, line.quantity >= MAX_QUANTITY && styles.disabled]}
                onPress={() => changeQuantity(key, 1)}>
                <Icon name="add" size={20} />
              </Pressable>
            </View>
            <Text variant="label">{money(line.unitPrice * line.quantity)}</Text>
          </View>
          {product && (product.modifiers.length > 0 || line.modifierIds.length > 0) && <Pressable accessibilityRole="button" style={styles.edit} onPress={() =>
            router.push({ pathname: '/product/[sku]', params: { sku: line.sku, line: key } })}>
            <Text variant="label" tone="green">{copy(locale, 'Edit options', 'Hindura ibyo wahisemo')}</Text>
          </Pressable>}
        </Card>;
      })}
      {count > 0 && <View style={styles.summary}>
        <View style={styles.itemBar}>
          <Text variant="label">{copy(locale, 'Estimated total', 'Igiteranyo cy’agateganyo')}</Text>
          <Text variant="heading">{money(total)}</Text>
        </View>
        <Text variant="small" tone="muted">{copy(locale, 'Availability, tax and final price are confirmed at checkout.', 'Kuboneka, umusoro n’igiciro cya nyuma byemezwa mbere yo kwishyura.')}</Text>
        {status !== 'ready' && <Button label={copy(locale, 'Refresh menu', 'Vugurura amafunguro')} variant="secondary"
          busy={refreshing} onPress={() => { void refreshMenu(); }} />}
      </View>}
    </Screen>
  );
}

const styles = StyleSheet.create({
  product: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  thumb: { width: 64, height: 56, borderRadius: 9 },
  productCopy: { flex: 1, gap: 4 },
  itemBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  stepper: { flexDirection: 'row', gap: 8, alignItems: 'center' },
  quantityButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.paper, borderRadius: 10 },
  disabled: { opacity: 0.38 },
  edit: { minHeight: 48, justifyContent: 'center', alignSelf: 'flex-start', paddingRight: 10 },
  summary: { gap: 7 },
});
