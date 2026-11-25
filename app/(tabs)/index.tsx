import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import type { Category, Product } from '../../src/domain/types';
import { useShop } from '../../src/state/shop';
import { Button, Card, colors, Icon, Screen, Text } from '../../src/ui/core';
import { copy, kigaliTime, money, slotLabel } from '../../src/ui/format';
import { menuPhoto } from '../../src/ui/menu-photos';

const categories = [
  { id: 'burgers', en: 'Burgers', rw: 'Burgeri' },
  { id: 'combos', en: 'Combos', rw: 'Amafunguro' },
  { id: 'sides', en: 'Sides', rw: 'Ibyunganira' },
  { id: 'drinks', en: 'Drinks', rw: 'Ibinyobwa' },
] as const;

function ProductTile({ product, featured = false, wide = false }: { product: Product; featured?: boolean; wide?: boolean }) {
  const { locale } = useShop();
  const router = useRouter();
  const photo = menuPhoto(product.sku);
  const label = product.name[locale];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${money(product.price)}${product.available ? '' : copy(locale, ', sold out', ', byashize')}`}
      onPress={() => router.push({ pathname: '/product/[sku]', params: { sku: product.sku } })}
      style={({ pressed }) => [styles.tile, featured && styles.featured, wide && styles.half, pressed && styles.pressed]}
    >
      {photo && <Image source={photo} style={[styles.photo, featured && styles.heroPhoto]} accessible={false} />}
      <View style={styles.tileBody}>
        <View style={styles.tileCopy}>
          <Text variant="heading" style={featured && styles.heroTitle}>{label}</Text>
          <Text variant="small" tone="muted">{product.description[locale]}</Text>
        </View>
        <View style={styles.tileBottom}>
          <Text variant="label">{money(product.price)}</Text>
          {product.available ? (
            <View style={styles.productAction}>
              <Icon name="add" size={24} />
            </View>
          ) : <Text variant="small" tone="red">{copy(locale, 'Sold out', 'Byashize')}</Text>}
        </View>
      </View>
    </Pressable>
  );
}

export default function MenuScreen() {
  const { locale, menu, status, refreshing, refreshMenu, count, total } = useShop();
  const { width } = useWindowDimensions();
  const wide = width >= 620;
  const router = useRouter();
  const [category, setCategory] = useState<Category>('burgers');
  const products = menu?.products.filter(product => product.category === category) ?? [];
  const featured = products.find(product => product.sku === 'double-smash');
  const rest = products.filter(product => product !== featured);
  const next = menu?.slots.find(slot => slot.available && Date.parse(slot.startsAt) > Date.now());

  return (
    <Screen onRefresh={() => { void refreshMenu(); }} refreshing={refreshing}
      bottom={count > 0 && <Button label={copy(locale, `View cart · ${money(total)}`, `Reba igitebo · ${money(total)}`)} onPress={() => router.push('/cart')} />}>
      {menu && (
        <Pressable accessibilityRole="button" onPress={() => router.navigate('/pickup')} style={styles.pickup}>
          <View style={styles.pin}><Icon name="location-outline" size={23} color={colors.green} /></View>
          <View style={styles.pickupText}>
            <Text variant="label" tone="green">{copy(locale, 'Pickup in Kigali', 'Kwakirira i Kigali')}</Text>
            <Text variant="small" tone="muted">
              {copy(locale, 'Demo store', 'Aho kugeragereza')} · {copy(locale, menu.store.open ? 'Open' : 'Closed', menu.store.open ? 'Harafunguye' : 'Hafunze')} · {next
                ? slotLabel(next, locale)
                : copy(locale, 'No slots available', 'Nta mwanya uhari')}
            </Text>
          </View>
          <Icon name="chevron-forward" size={17} color={colors.green} />
        </Pressable>
      )}
      <Text variant="title" accessibilityRole="header">{copy(locale, 'Menu', 'Ifunguro')}</Text>
      {status === 'loading' && <ActivityIndicator color={colors.plum} accessibilityLabel={copy(locale, 'Loading menu', 'Ifunguro ririmo gufunguka')} />}
      {status === 'unavailable' && (
        <Card>
          <Text variant="label">{copy(locale, 'The menu could not load.', 'Ifunguro ntiryabonetse.')}</Text>
          <Button label={copy(locale, 'Try again', 'Ongera ugerageze')} onPress={() => { void refreshMenu(); }} />
        </Card>
      )}
      {menu && (
        <>
          {status === 'stale' && <Text variant="small" tone="red" accessibilityLiveRegion="polite">
            {copy(locale, 'Saved menu', 'Ifunguro ryabitswe')} · {kigaliTime(menu.updatedAt, locale)}
          </Text>}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categories}>
            {categories.map(item => {
              const selected = category === item.id;
              return <Pressable key={item.id} onPress={() => setCategory(item.id)} accessibilityRole="button"
                accessibilityState={{ selected }} style={[styles.category, selected && styles.selectedCategory]}>
                <Text variant="label" tone={selected ? 'cream' : 'ink'}>{item[locale]}</Text>
              </Pressable>;
            })}
          </ScrollView>
          {featured && <ProductTile product={featured} featured />}
          <View style={[styles.grid, wide && styles.wideGrid]}>
            {rest.map(product => <ProductTile key={product.sku} product={product} wide={wide} />)}
          </View>
          {products.length === 0 && <Text tone="muted">{copy(locale, 'No items in this category.', 'Nta funguro riri muri iki cyiciro.')}</Text>}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  pickup: {
    minHeight: 62, backgroundColor: colors.mint, padding: 10, paddingRight: 13, gap: 10,
    borderRadius: 14, alignItems: 'center', flexDirection: 'row',
  },
  pin: { backgroundColor: colors.white, borderRadius: 10, width: 37, height: 37, alignItems: 'center', justifyContent: 'center' },
  pickupText: { flex: 1, gap: 1 },
  categories: { gap: 7, alignItems: 'center' },
  category: { minHeight: 48, paddingVertical: 10, paddingHorizontal: 12, justifyContent: 'center', borderRadius: 11 },
  selectedCategory: { backgroundColor: colors.plum },
  grid: { gap: 14 },
  wideGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  tile: { borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.white },
  featured: { borderWidth: 0 },
  half: { width: '48.7%', flexGrow: 1 },
  pressed: { opacity: 0.76 },
  photo: { width: '100%', aspectRatio: 1.75, backgroundColor: colors.plum, resizeMode: 'cover' },
  heroPhoto: { aspectRatio: 1.56 },
  tileBody: { gap: 10, padding: 14, paddingTop: 12 },
  tileCopy: { gap: 4 },
  heroTitle: { fontSize: 25, lineHeight: 30 },
  tileBottom: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  productAction: { paddingHorizontal: 14, minHeight: 42, borderRadius: 10, backgroundColor: colors.mustard, justifyContent: 'center' },
});
