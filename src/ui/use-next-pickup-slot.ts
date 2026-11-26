import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { AppState } from 'react-native';
import type { Menu } from '../domain/types';
import { nextPickupSlot } from './format';

// Both tabs read the same menu snapshot. Once its last observed window expires,
// only the focused tab may request a new horizon.
const observedDeadlines = new WeakMap<Menu, number>();
const maximumTimeoutMs = 2_147_483_647;

export function useNextPickupSlot(menu: Menu | null, pickupNow: () => number, refreshMenu: () => Promise<void>) {
  const [, renderAfterDeadline] = useState(0);

  useFocusEffect(useCallback(() => {
    if (!menu?.store.open || menu.orderingUnavailable) return;
    const activeMenu = menu;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function updateWindow() {
      clearTimeout(timer);
      const now = pickupNow();
      const next = nextPickupSlot(activeMenu, now);
      renderAfterDeadline(previous => previous + 1);
      if (next) {
        const startsAt = Date.parse(next.startsAt);
        observedDeadlines.set(activeMenu, startsAt);
        timer = setTimeout(updateWindow, Math.min(maximumTimeoutMs, Math.ceil(startsAt - now)));
        return;
      }

      const observed = observedDeadlines.get(activeMenu);
      if (observed !== undefined && observed <= now) {
        observedDeadlines.delete(activeMenu);
        void refreshMenu();
      }
    }

    if (AppState.currentState !== 'background' && AppState.currentState !== 'inactive') updateWindow();
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') updateWindow();
      else clearTimeout(timer);
    });
    return () => {
      clearTimeout(timer);
      subscription.remove();
    };
  }, [menu, pickupNow, refreshMenu]));

  return nextPickupSlot(menu, pickupNow());
}
