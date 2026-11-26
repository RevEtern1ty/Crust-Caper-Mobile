import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Image, Platform, Pressable, StyleSheet, View } from 'react-native';
import type { CartLine, Product } from '../../src/domain/types';
import { lineKey, MAX_QUANTITY, useShop } from '../../src/state/shop';
import { CartHeaderButton } from '../../src/ui/cart-header-button';
import { Button, Card, colors, Icon, Screen, Text } from '../../src/ui/core';
import { copy, money } from '../../src/ui/format';
import { menuPhoto } from '../../src/ui/menu-photos';

function Details({ product, editing }: { product: Product; editing?: CartLine }) {
  const { locale, mode, fixturePhotos, cart, hydrated, addLine, editLine } = useShop();
  const router = useRouter();
  const [selected, setSelected] = useState(editing?.modifierIds ?? []);
  const photo = menuPhoto(product.sku, fixturePhotos, product.photoUrl);
  const validSelected = product.modifiers.filter(option => selected.includes(option.id));
  const unitPrice = product.price + validSelected.reduce((sum, option) => sum + option.price, 0);
  const line = { sku: product.sku, modifierIds: validSelected.map(option => option.id), quantity: 1, unitPrice };
  const key = lineKey(line);
  const editingKey = editing ? lineKey(editing) : null;
  const matchingQuantity = cart.find(item => lineKey(item) === key && key !== editingKey)?.quantity ?? 0;
  const exceedsLimit = matchingQuantity + (editing?.quantity ?? 1) > MAX_QUANTITY;

  function updateCart() {
    if (editingKey) editLine(editingKey, line);
    else addLine(line);
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }

  return (
    <Screen safeBottom bottom={<Button
      label={editing ? copy(locale, `Save item · ${money(unitPrice * editing.quantity)}`, `Bika · ${money(unitPrice * editing.quantity)}`)
        : copy(locale, `Add to cart · ${money(unitPrice)}`, `Shyira mu gitebo · ${money(unitPrice)}`)}
      disabled={!product.available || exceedsLimit || !hydrated}
      onPress={updateCart}
    />}>
      <Stack.Screen options={{
        title: product.name[locale],
        headerRight: editing ? undefined : () => <CartHeaderButton />,
      }} />
      {photo && <View style={styles.photoFrame}>
        <Image source={photo} style={styles.photo} accessible={false} />
      </View>}
      <View style={styles.intro}>
        <Text variant="title" accessibilityRole="header">{product.name[locale]}</Text>
        <Text tone="muted">{product.description[locale]}</Text>
        <Text variant="label">{money(product.price)}</Text>
        {!product.available && <Text tone="red">{copy(locale, 'Sold out', 'Byashize')}</Text>}
      </View>
      <Card>
        <Text variant="label">{copy(locale, 'Ingredients', 'Ibigize ifunguro')}</Text>
        <Text>{product.ingredients.length ? product.ingredients.map(item => item[locale]).join(', ')
          : copy(locale, 'Ingredient details are unavailable.', 'Ibigize iri funguro ntibiraboneka.')}</Text>
        <Text variant="label">{copy(locale, 'Allergens', 'Ibitera ubwivumbure bw’umubiri')}</Text>
        <Text>{product.allergens.length ? product.allergens.map(item => item[locale]).join(', ')
          : mode === 'demo'
            ? copy(locale, 'None listed in the demo recipe.', 'Nta byanditswe mu ifunguro ry’igerageza.')
            : copy(locale, 'Ask the restaurant about allergens.', 'Baza resitora ku bitera ubwivumbure bw’umubiri.')}</Text>
      </Card>
      {product.modifiers.length > 0 && <View style={styles.options}>
        <Text variant="heading" accessibilityRole="header">{copy(locale, 'Make it yours', 'Hitamo ibyo wongeramo')}</Text>
        {product.modifiers.map(option => {
          const checked = selected.includes(option.id);
          return <Pressable key={option.id} accessibilityRole={Platform.OS === 'web' ? 'button' : 'checkbox'}
            aria-pressed={Platform.OS === 'web' ? checked : undefined}
            accessibilityState={Platform.OS === 'web' ? undefined : { checked }} accessibilityLanguage={locale}
            onPress={() => setSelected(current => current.includes(option.id)
              ? current.filter(id => id !== option.id) : [...current, option.id])}
            style={[styles.option, checked && styles.selected]}>
            <Icon name={checked ? 'checkbox' : 'square-outline'} color={colors.green} />
            <Text style={styles.optionLabel}>{option.name[locale]}</Text>
            <Text variant="small" style={styles.optionPrice}>+{money(option.price)}</Text>
          </Pressable>;
        })}
      </View>}
      {exceedsLimit && <Text tone="red">{copy(locale, `Limit of ${MAX_QUANTITY} for the same item and options.`, `Umubare ntarengwa w’ifunguro rifite ibyo wahisemo ni ${MAX_QUANTITY}.`)}</Text>}
    </Screen>
  );
}

export default function ProductScreen() {
  const { locale, menu, status, cart, hydrated } = useShop();
  const { sku, line } = useLocalSearchParams<{ sku: string; line?: string }>();
  const router = useRouter();
  const product = menu?.products.find(item => item.sku === sku);
  const editing = line ? cart.find(item => lineKey(item) === line && item.sku === sku) : undefined;
  const missingCartItem = !!line && !editing;
  if (product && (!line || editing)) return <Details key={`${sku}:${line ?? ''}`} product={product} editing={editing} />;
  return <Screen safeBottom>
    {!hydrated || status === 'loading' ? <ActivityIndicator color={colors.plum} accessibilityLabel={copy(locale, 'Loading item', 'Ifunguro ririmo gufunguka')} />
      : <Card>
        <Text accessibilityRole="alert">{missingCartItem ? copy(locale, 'This item is no longer in your cart.', 'Iri funguro ntirikiri mu gitebo cyawe.')
          : copy(locale, 'This item could not load.', 'Iri funguro ntiryabonetse.')}</Text>
        {missingCartItem ? <Button label={copy(locale, 'Back to cart', 'Subira ku gitebo')} onPress={() => router.replace('/cart')} />
          : <Button label={copy(locale, 'Back to menu', 'Subira ku ifunguro')} onPress={() => router.replace('/')} />}
      </Card>}
  </Screen>;
}

const styles = StyleSheet.create({
  photoFrame: { alignSelf: 'stretch', aspectRatio: 1.58, maxHeight: 360, borderRadius: 16, overflow: 'hidden', backgroundColor: colors.plum },
  photo: { width: '100%', height: '100%' },
  intro: { gap: 6 },
  options: { gap: 8 },
  option: {
    minHeight: 52, borderRadius: 12, borderWidth: 1, borderColor: colors.border,
    padding: 12, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.white,
  },
  selected: { borderColor: colors.green, backgroundColor: colors.mint },
  optionLabel: { flex: 1, minWidth: 0 },
  optionPrice: { flexShrink: 1, textAlign: 'right' },
});
