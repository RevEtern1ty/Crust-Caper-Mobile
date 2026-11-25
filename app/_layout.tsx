import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { CheckoutProvider } from '../src/checkout/context';
import { ShopProvider, useShop } from '../src/state/shop';
import { Button, colors, Text } from '../src/ui/core';
import { copy } from '../src/ui/format';

export const unstable_settings = { anchor: '(tabs)' };

function Routes() {
  const { locale } = useShop();
  useEffect(() => {
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      document.documentElement.lang = locale;
    }
  }, [locale]);

  return (
    <Stack screenOptions={{
      contentStyle: { backgroundColor: colors.cream },
      headerStyle: { backgroundColor: colors.plum },
      headerTintColor: colors.cream,
      headerShadowVisible: false,
      headerTitleStyle: { fontWeight: '800' },
      headerBackButtonDisplayMode: 'minimal',
    }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false, title: copy(locale, 'Menu', 'Ifunguro') }} />
      <Stack.Screen name="product/[sku]" options={{ title: copy(locale, 'Menu item', 'Ifunguro') }} />
      <Stack.Screen name="cart" options={{ title: copy(locale, 'Your cart', 'Igitebo cyawe') }} />
      <Stack.Screen name="checkout" options={{ title: copy(locale, 'Checkout', 'Kwemeza komande') }} />
      <Stack.Screen name="payment" options={{ title: copy(locale, 'Test payment', 'Kwishyura by’igerageza') }} />
      <Stack.Screen name="settings" options={{ title: copy(locale, 'Settings', 'Amagenamiterere') }} />
    </Stack>
  );
}

function DraftStorageNotice() {
  const { draftStorageError, locale, retryDraftStorage } = useShop();
  const insets = useSafeAreaInsets();
  const [retrying, setRetrying] = useState(false);
  if (!draftStorageError) return null;

  const message = draftStorageError === 'read'
    ? copy(locale, 'Your saved cart could not be opened.', 'Agatebo kawe kabitswe ntikashoboye gufunguka.')
    : copy(locale, 'Your cart changes are unsaved. Keep this screen open and retry.', 'Ibyahindutse mu gatebo ntibyabitswe. Guma hano wongere ugerageze.');

  async function retry() {
    setRetrying(true);
    try {
      await retryDraftStorage();
    } finally {
      setRetrying(false);
    }
  }

  return (
    <View style={[styles.storageNotice, { paddingBottom: 10 + insets.bottom }]}>
      <Text variant="small" tone="red" accessibilityRole="alert" style={styles.storageMessage}>{message}</Text>
      <Button label={copy(locale, 'Retry cart storage', 'Ongera ugerageze kubika agatebo')} variant="secondary"
        busy={retrying} onPress={() => { void retry(); }} />
    </View>
  );
}

export default function RootLayout() {
  return (
    <View style={styles.backdrop}>
      <View style={styles.frame}>
        <SafeAreaProvider>
          <ShopProvider>
            <CheckoutProvider>
              <StatusBar style="light" />
              <Routes />
              <DraftStorageNotice />
            </CheckoutProvider>
          </ShopProvider>
        </SafeAreaProvider>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: 'center', backgroundColor: colors.paper },
  frame: {
    flex: 1, width: '100%', backgroundColor: colors.cream,
    ...(Platform.OS === 'web' ? { maxWidth: 760, borderLeftWidth: 1, borderRightWidth: 1, borderColor: colors.border } : {}),
  },
  storageNotice: {
    flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: 12, rowGap: 6,
    paddingHorizontal: 18, paddingTop: 10, backgroundColor: colors.cream,
    borderTopWidth: 1, borderTopColor: colors.border,
  },
  storageMessage: { flexGrow: 1, flexShrink: 1, flexBasis: 120 },
});
