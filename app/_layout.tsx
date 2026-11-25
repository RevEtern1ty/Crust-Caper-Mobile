import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { CheckoutProvider } from '../src/checkout/context';
import { ShopProvider, useShop } from '../src/state/shop';
import { colors } from '../src/ui/core';
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

export default function RootLayout() {
  return (
    <View style={styles.backdrop}>
      <View style={styles.frame}>
        <SafeAreaProvider>
          <ShopProvider>
            <CheckoutProvider>
              <StatusBar style="light" />
              <Routes />
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
});
