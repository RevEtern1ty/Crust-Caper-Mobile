import { Tabs, useRouter } from 'expo-router';
import { Image, Platform, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useShop } from '../../src/state/shop';
import { CartHeaderButton } from '../../src/ui/cart-header-button';
import { colors, Icon, Text } from '../../src/ui/core';
import { copy } from '../../src/ui/format';

function BrandHeader() {
  const { top } = useSafeAreaInsets();
  const { locale } = useShop();
  const router = useRouter();
  return (
    <View style={[styles.header, { paddingTop: top + 8 }]}>
      <View style={styles.brand} accessible accessibilityLabel="CrustCaper">
        <Image source={require('../../assets/brand-mark.png')} style={styles.mark} accessible={false} />
        <Text variant="heading" tone="cream" numberOfLines={1} style={styles.wordmark}>CrustCaper</Text>
      </View>
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" accessibilityLabel={copy(locale, 'Language settings', 'Guhitamo ururimi')}
          onPress={() => router.push('/settings')} style={styles.language}>
          <Text variant="label" tone="cream">{locale.toUpperCase()}</Text>
        </Pressable>
        <CartHeaderButton />
      </View>
    </View>
  );
}

export default function TabLayout() {
  const { locale } = useShop();
  const { bottom } = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const tabBarHeight = bottom + 45 + Math.ceil(18 * fontScale);
  return (
    <Tabs screenOptions={{
      header: () => <BrandHeader />,
      tabBarActiveTintColor: colors.plum,
      tabBarInactiveTintColor: colors.muted,
      tabBarStyle: {
        backgroundColor: colors.cream, borderTopColor: colors.border,
        height: Platform.OS === 'web' ? 'auto' : tabBarHeight,
        minHeight: tabBarHeight, paddingBottom: bottom + 5, paddingTop: 4,
      },
      tabBarLabelStyle: { fontSize: 12, fontWeight: '700' },
      tabBarAllowFontScaling: true,
      tabBarLabelPosition: 'below-icon',
    }}>
      <Tabs.Screen name="index" options={{
        title: copy(locale, 'Menu', 'Ifunguro'),
        tabBarIcon: ({ color }) => <Icon name="restaurant-outline" size={21} color={color} />,
      }} />
      <Tabs.Screen name="orders" options={{
        title: copy(locale, 'Orders', 'Komande'),
        tabBarIcon: ({ color }) => <Icon name="receipt-outline" size={21} color={color} />,
      }} />
      <Tabs.Screen name="pickup" options={{
        title: copy(locale, 'Pickup', 'Kwakira'),
        tabBarIcon: ({ color }) => <Icon name="location-outline" size={22} color={color} />,
      }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  header: {
    backgroundColor: colors.plum, paddingHorizontal: 16, paddingBottom: 8, gap: 8,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1, minWidth: 0 },
  wordmark: { flexShrink: 1, minWidth: 0, fontSize: 21, letterSpacing: -0.5 },
  mark: { width: 27, height: 27, flexShrink: 0, resizeMode: 'contain' },
  actions: { flexDirection: 'row', gap: 6, flexShrink: 0 },
  language: { minHeight: 48, minWidth: 48, alignItems: 'center', justifyContent: 'center' },
});
