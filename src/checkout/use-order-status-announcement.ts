import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { AccessibilityInfo, AppState, Platform } from 'react-native';

import type { Locale, Order } from '../domain/types';
import { observeOrderStatus, type OrderStatusSnapshot, type OrderStatusSurface } from './order-status-announcement';

export function useOrderStatusAnnouncement(order: Order | null, locale: Locale, surface: OrderStatusSurface) {
  const focused = useRef(false);
  const previous = useRef<OrderStatusSnapshot | null>(null);

  useFocusEffect(useCallback(() => {
    if (Platform.OS !== 'ios') return;

    focused.current = true;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') previous.current = null;
    });
    return () => {
      focused.current = false;
      previous.current = null;
      subscription.remove();
    };
  }, []));

  useEffect(() => {
    if (!focused.current || AppState.currentState !== 'active') return;

    // The first confirmed result after entering establishes what VoiceOver can already read.
    const { snapshot, announcement } = observeOrderStatus(previous.current, order, locale, surface);
    previous.current = snapshot;
    if (announcement) AccessibilityInfo.announceForAccessibilityWithOptions(announcement, { queue: true });
  }, [order, locale, surface]);
}
