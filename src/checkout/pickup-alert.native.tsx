import { router, useFocusEffect, useRootNavigationState } from 'expo-router';
import type { NotificationPermissionsStatus, NotificationResponse } from 'expo-notifications';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, Platform } from 'react-native';
import { ApiError, type Locale, type Order, type ShopApi } from '../domain/types';
import { useShop } from '../state/shop';
import { Button, Card, Text } from '../ui/core';
import { copy } from '../ui/format';
import { useCheckout } from './context';
import { canEnablePickupAlert, PICKUP_READY, savedPickupAlertOrderId } from './pickup-alert-rules';

type Notifications = typeof import('expo-notifications');
type Permission = 'allowed' | 'ask' | 'blocked';
type Notice = 'status' | 'enable' | 'disable' | 'closed' | 'settings' | 'permission';

const messages: Record<Notice, [string, string]> = {
  status: ['We couldn’t check the pickup alert setting.', 'Ntitwashoboye kureba igenamiterere ry’imenyesha.'],
  enable: ['We couldn’t confirm that the alert was turned on. Check this setting again.', 'Ntitwashoboye kwemeza ko imenyesha ryafunguwe. Ongera urebe iri genamiterere.'],
  disable: ['We couldn’t confirm that the alert was turned off. Try again.', 'Ntitwashoboye kwemeza ko imenyesha ryazimijwe. Ongera ugerageze.'],
  closed: ['This order can no longer be subscribed to. Check its latest status in Orders.', 'Iyi komande ntishobora kongera gushyirirwaho imenyesha. Reba uko ihagaze muri Komande.'],
  settings: ['We couldn’t open device settings.', 'Ntitwashoboye gufungura igenamiterere ry’igikoresho.'],
  permission: ['Notification permission was not granted. You can follow this order here.', 'Uruhushya rw’amamenyesha ntirwatanzwe. Ushobora gukurikirana iyi komande hano.'],
};

async function notificationPermission(notifications: Notifications, permission: NotificationPermissionsStatus): Promise<Permission> {
  if (Platform.OS === 'android') {
    const channel = await notifications.getNotificationChannelAsync(PICKUP_READY);
    if (channel?.importance === notifications.AndroidImportance.NONE) return 'blocked';
  }
  if (permission.granted || permission.ios?.status === notifications.IosAuthorizationStatus.PROVISIONAL
    || permission.ios?.status === notifications.IosAuthorizationStatus.EPHEMERAL) return 'allowed';
  return permission.canAskAgain ? 'ask' : 'blocked';
}

type PanelProps = {
  order: Order;
  alerts: NonNullable<ShopApi['pickupAlerts']>;
  projectId: string;
  locale: Locale;
};

function AlertSetting({ order, alerts, projectId, locale }: PanelProps) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [permission, setPermission] = useState<Permission | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<'enable' | 'disable' | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const revision = useRef(0);
  const working = useRef(false);
  const eligible = canEnablePickupAlert(order);
  const orderId = order.id;
  const t = (en: string, rw: string) => copy(locale, en, rw);

  const read = useCallback(async () => {
    if (working.current) return;
    const request = ++revision.current;
    setLoading(true);
    try {
      const notifications = await import('expo-notifications');
      const [status, allowed] = await Promise.all([
        alerts.get(orderId),
        notifications.getPermissionsAsync().then(result => notificationPermission(notifications, result)),
      ]);
      if (request === revision.current) {
        setEnabled(status.enabled);
        setAvailable(status.available);
        setPermission(allowed);
        setNotice(null);
      }
    } catch {
      if (request === revision.current) setNotice('status');
    } finally {
      if (request === revision.current) setLoading(false);
    }
  }, [alerts, orderId]);

  useFocusEffect(useCallback(() => {
    void read();
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') void read();
    });
    return () => {
      revision.current++;
      subscription.remove();
    };
  }, [read]));

  async function change(action: 'enable' | 'disable') {
    if (working.current || (action === 'enable' && !eligible)) return;
    revision.current++;
    working.current = true;
    setAction(action);
    setLoading(false);
    setNotice(null);
    try {
      if (action === 'disable') {
        await alerts.disable(orderId);
        setEnabled(false);
        return;
      }

      const current = await alerts.get(orderId);
      setAvailable(current.available);
      setEnabled(current.enabled);
      if (!current.available || current.enabled) return;

      const notifications = await import('expo-notifications');
      if (Platform.OS === 'android') {
        await notifications.setNotificationChannelAsync(PICKUP_READY, {
          name: t('Pickup ready', 'Komande yiteguye'),
          importance: notifications.AndroidImportance.DEFAULT,
        });
      }
      let allowed = await notificationPermission(notifications, await notifications.getPermissionsAsync());
      if (allowed === 'ask') {
        const result = await notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: false, allowSound: false } });
        allowed = await notificationPermission(notifications, result);
      }
      setPermission(allowed);
      if (allowed !== 'allowed') {
        if (allowed === 'ask') setNotice('permission');
        return;
      }

      const { data: token } = await notifications.getExpoPushTokenAsync({ projectId });
      const status = await alerts.enable(orderId, token, locale);
      setEnabled(status.enabled);
      setAvailable(status.available);
      if (!status.enabled) setNotice('enable');
    } catch (error) {
      if (action === 'enable') setEnabled(null);
      setNotice(error instanceof ApiError && error.code === 'pickup_alert_unavailable' ? 'closed' : action);
    } finally {
      working.current = false;
      setAction(null);
    }
  }

  if ((!eligible || available === false) && enabled === false && !notice) return null;

  return (
    <Card>
      <Text variant="heading" accessibilityRole="header">{t('Pickup alert', 'Imenyesha ryo gufata komande')}</Text>
      <Text variant="small" tone="muted" accessibilityLiveRegion="polite">{available === false
        ? t('Pickup alerts are paused. You can still check this order in Orders.', 'Amamenyesha yo gufata komande arahagaze. Uracyashobora kureba iyi komande muri Komande.')
        : permission === 'blocked' || (enabled && permission === 'ask')
        ? t('Device notifications are blocked. You can still check this order in Orders.', 'Amamenyesha azimijwe kuri iki gikoresho. Uracyashobora kureba iyi komande muri Komande.')
        : enabled ? t('The pickup alert is on for this device.', 'Imenyesha ryo gufata komande rifunguye kuri iki gikoresho.')
          : t('Get a notification when this order is ready for pickup.', 'Menyeshwa igihe iyi komande izaba yiteguye gufatwa.')}</Text>
      {notice && <Text variant="small" tone="red" accessibilityRole="alert">{t(...messages[notice])}</Text>}
      {enabled === null && !loading && !action && <Button label={t('Check alert setting', 'Reba igenamiterere ry’imenyesha')}
        variant="secondary" onPress={() => { void read(); }} />}
      {available && (permission === 'blocked' && (eligible || enabled) || (permission === 'ask' && enabled)) && <Button label={t('Open device settings', 'Fungura igenamiterere ry’igikoresho')}
        variant="secondary" disabled={!!action} onPress={() => { void Linking.openSettings().catch(() => setNotice('settings')); }} />}
      {eligible && available && enabled !== true && permission !== 'blocked' && action !== 'disable' && <Button label={t('Notify me when ready', 'Menyesha komande niyitegura')}
        variant="secondary" busy={action === 'enable'} disabled={loading || !!action} onPress={() => { void change('enable'); }} />}
      {(enabled === true || (enabled === null && !loading && action !== 'enable')) && <Button
        label={t('Turn off pickup alert', 'Zimya imenyesha ryo gufata komande')} variant="secondary"
        busy={action === 'disable'} disabled={loading || !!action} onPress={() => { void change('disable'); }} />}
    </Card>
  );
}

export function PickupAlertPanel({ order }: { order: Order }) {
  const { api, locale, pushProjectId } = useShop();
  if (!pushProjectId || !api.pickupAlerts || (!canEnablePickupAlert(order)
    && !(order.status === 'ready' && order.paymentStatus === 'paid'))) return null;

  return <AlertSetting order={order} alerts={api.pickupAlerts} projectId={pushProjectId} locale={locale} />;
}

export function PickupAlertResponses() {
  const { pushProjectId } = useShop();
  const { journal, setRequestedOrderId } = useCheckout();
  const navigationReady = !!useRootNavigationState()?.key;
  const orderIds = useRef(journal?.orderIds);

  useEffect(() => { orderIds.current = journal?.orderIds; }, [journal]);
  const journalReady = journal !== null;

  useEffect(() => {
    if (!pushProjectId || !navigationReady || !journalReady) return;
    let active = true;
    let remove: (() => void) | undefined;
    void import('expo-notifications').then(notifications => {
      if (!active) return;
      function open(response: NotificationResponse) {
        if (!active || response.actionIdentifier !== notifications.DEFAULT_ACTION_IDENTIFIER) return;
        const { request } = response.notification;
        if (notifications.getLastNotificationResponse()?.notification.request.identifier === request.identifier) {
          notifications.clearLastNotificationResponse();
        }
        const id = savedPickupAlertOrderId(request.content.data, orderIds.current ?? []);
        if (!id) return;
        setRequestedOrderId(id);
        router.navigate('/(tabs)/orders');
      }
      notifications.setNotificationHandler({
        handleNotification: async (notification) => {
          const known = savedPickupAlertOrderId(notification.request.content.data, orderIds.current ?? []);
          return { shouldShowBanner: !!known, shouldShowList: !!known, shouldPlaySound: false, shouldSetBadge: false };
        },
      });
      const subscription = notifications.addNotificationResponseReceivedListener(open);
      remove = () => {
        notifications.setNotificationHandler(null);
        subscription.remove();
      };
      const last = notifications.getLastNotificationResponse();
      if (last) open(last);
    }).catch(() => undefined);
    return () => {
      active = false;
      remove?.();
    };
  }, [journalReady, navigationReady, pushProjectId, setRequestedOrderId]);

  return null;
}
