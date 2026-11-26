import { useRouter } from 'expo-router';
import { Pressable, StyleSheet } from 'react-native';
import { useShop } from '../state/shop';
import { colors, Icon, Text } from './core';
import { copy } from './format';

export function CartHeaderButton() {
  const { locale, count } = useShop();
  const router = useRouter();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copy(locale, count === 1 ? 'Cart, 1 item' : `Cart, ${count} items`, `Igitebo, ibintu ${count}`)}
      onPress={() => router.push('/cart')}
      style={styles.bag}
    >
      <Icon name="bag-handle-outline" color={colors.cream} />
      {count > 0 && <Text variant="small" tone="mustard">{count}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bag: {
    minHeight: 48, minWidth: 48, paddingHorizontal: 9, borderRadius: 12,
    borderColor: '#72586D', borderWidth: 1, alignItems: 'center', justifyContent: 'center',
    flexDirection: 'row', gap: 3,
  },
});
