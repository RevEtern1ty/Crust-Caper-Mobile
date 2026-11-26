import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Image, Platform, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import type { Category, Product } from '../../src/domain/types';
import { useShop } from '../../src/state/shop';
import { Button, Card, colors, Icon, Screen, Text } from '../../src/ui/core';
import { copy, kigaliTime, money, nextPickupSlot, slotLabel } from '../../src/ui/format';
import { menuPhoto } from '../../src/ui/menu-photos';

const categories = [
  { id: 'burgers', en: 'Burgers', rw: 'Burgeri' },
  { id: 'combos', en: 'Combos', rw: 'Amafunguro' },
  { id: 'sides', en: 'Sides', rw: 'Ibyunganira' },
  { id: 'drinks', en: 'Drinks', rw: 'Ibinyobwa' },
] as const;

function ProductTile({ product, featured = false, wide = false }: { product: Product; featured?: boolean; wide?: boolean }) {
  const { locale, fixturePhotos } = useShop();
  const router = useRouter();
  const photo = menuPhoto(product.sku, fixturePhotos, product.photoUrl);
  const label = product.name[locale];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${money(product.price)}${product.available ? '' : copy(locale, ', sold out', ', byashize')}`}
      accessibilityHint={copy(locale, 'Opens item details.', 'Ifungura ibisobanuro by’ifunguro.')}
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
          {!product.available && <Text variant="small" tone="red">{copy(locale, 'Sold out', 'Byashize')}</Text>}
          <View style={styles.productAction}>
            <Text variant="small" style={styles.actionLabel}>{copy(locale, 'Details', 'Ibisobanuro')}</Text>
            <Icon name="chevron-forward" size={16} />
          </View>
        </View>
      </View>
    </Pressable>
  );
}

export default function MenuScreen() {
  const { locale, mode, menu, status, refreshing, refreshMenu, pickupNow, count, total } = useShop();
  const { width } = useWindowDimensions();
  const compactCategories = width < 380;
  const wide = width >= 620;
  const router = useRouter();
  const [category, setCategory] = useState<Category>('burgers');
  const products = menu?.products.filter(product => product.category === category) ?? [];
  const featured = products.find(product => product.sku === 'double-smash');
  const rest = products.filter(product => product !== featured);
  const next = status === 'ready' ? nextPickupSlot(menu, pickupNow()) : undefined;
  let pickupAvailability = copy(locale, 'Pickup availability unconfirmed', 'Igihe cyo gufata komande ntikiramenyekana');
  if (status === 'ready' && menu) {
    if (!menu.store.open) pickupAvailability = copy(locale, 'Closed', 'Hafunze');
    else if (next) pickupAvailability = slotLabel(next, locale);
    else pickupAvailability = copy(locale, 'No slots available', 'Nta mwanya uhari');
  }

  return (
    <Screen onRefresh={() => { void refreshMenu(); }} refreshing={refreshing}
      bottom={count > 0 && <Button label={copy(locale, `View cart · ${money(total)}`, `Reba igitebo · ${money(total)}`)} onPress={() => router.push('/cart')} />}>
      {menu && (
        <Pressable accessibilityRole="button" onPress={() => router.navigate('/pickup')} style={styles.pickup}>
          <View style={styles.pin}><Icon name="location-outline" size={23} color={colors.green} /></View>
          <View style={styles.pickupText}>
            <Text variant="label" tone="green">{mode === 'demo'
              ? copy(locale, 'Pickup in Kigali', 'Kwakirira i Kigali') : menu.store.name[locale]}</Text>
            <Text variant="small" tone="muted">
              {mode === 'demo' ? copy(locale, 'Demo store', 'Aho kugeragereza') : menu.store.area[locale]} · {pickupAvailability}
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
          {status === 'stale' && (
            <Card>
              <Text variant="small" tone="red" accessibilityLiveRegion="polite">
                {menu.orderingUnavailable
                  ? copy(locale, 'Orders are temporarily unavailable. Refresh the menu to retry.',
                    'Ntibishoboka gutanga komande muri aka kanya. Vugurura amafunguro wongere ugerageze.')
                  : `${copy(locale, 'Saved menu', 'Ifunguro ryabitswe')} · ${kigaliTime(menu.updatedAt, locale)}`}
              </Text>
              <Button label={copy(locale, 'Refresh menu', 'Vugurura amafunguro')} variant="secondary"
                busy={refreshing} onPress={() => { void refreshMenu(); }} />
            </Card>
          )}
          <View style={styles.categories}>
            {categories.map(item => {
              const selected = category === item.id;
              return <Pressable key={item.id} onPress={() => setCategory(item.id)} accessibilityRole="button"
                aria-pressed={Platform.OS === 'web' ? selected : undefined}
                accessibilityState={Platform.OS === 'web' ? undefined : { selected }} accessibilityLanguage={locale}
                style={[styles.category, compactCategories && styles.compactCategory, selected && styles.selectedCategory]}>
                <Text variant="label" tone={selected ? 'cream' : 'ink'} style={styles.categoryLabel}>{item[locale]}</Text>
              </Pressable>;
            })}
          </View>
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
  categories: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  category: {
    minHeight: 48, maxWidth: '100%', paddingVertical: 10, paddingHorizontal: 12,
    justifyContent: 'center', borderRadius: 11, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.white,
  },
  compactCategory: { flexBasis: '45%', flexGrow: 1 },
  categoryLabel: { textAlign: 'center' },
  selectedCategory: { backgroundColor: colors.plum, borderColor: colors.plum },
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
  productAction: {
    paddingHorizontal: 12, paddingVertical: 10, minHeight: 42, maxWidth: '100%', borderRadius: 10,
    backgroundColor: colors.mustard, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 5,
  },
  actionLabel: { flexShrink: 1, fontWeight: '700' },
});
