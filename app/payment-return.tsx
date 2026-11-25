import { Redirect } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect } from 'react';
import { Platform } from 'react-native';

export default function PaymentReturn() {
  useEffect(() => {
    if (Platform.OS === 'ios') void WebBrowser.dismissBrowser().catch(() => undefined);
  }, []);
  return <Redirect href="/(tabs)/orders" />;
}
