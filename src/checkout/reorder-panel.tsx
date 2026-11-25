import { useEffect, useRef } from 'react';
import { Platform, StyleSheet, type Text as NativeText, View } from 'react-native';
import type { CartLine, Locale, Menu, ReorderResult } from '../domain/types';
import { Button, Card, colors, Text } from '../ui/core';
import { copy, money } from '../ui/format';
import { changeLabel, itemName, itemOptions } from './labels';
import { compareReorder } from './reorder-review';

type Props = {
  original: CartLine[];
  offer: ReorderResult;
  menu: Menu | null;
  locale: Locale;
  replacesCart: boolean;
  disabled: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

function ItemDescription({ line, menu, locale }: Pick<Props, 'menu' | 'locale'> & { line: CartLine }) {
  const options = itemOptions(line, locale, menu);
  return (
    <View style={styles.itemDescription}>
      <Text variant="label">{line.quantity} × {itemName(line.sku, locale, menu)}</Text>
      {options && <Text variant="small" tone="muted">{options}</Text>}
    </View>
  );
}

export function ReorderPanel({ original, offer, menu, locale, replacesCart, disabled, onConfirm, onCancel }: Props) {
  const heading = useRef<NativeText>(null);
  const t = (en: string, rw: string) => copy(locale, en, rw);
  const { available, removed, originalTotal, estimate } = compareReorder(original, offer.lines);

  useEffect(() => {
    if (Platform.OS === 'web') heading.current?.focus();
  }, []);

  return (
    <Card>
      <Text ref={heading} tabIndex={Platform.OS === 'web' ? -1 : undefined} variant="heading" accessibilityRole="header">
        {t('Available items today', 'Ibiribwa biboneka uyu munsi')}
      </Text>
      {available.map(({ current, previous }, index) => (
        <View key={index} style={styles.item}>
          <View style={styles.row}>
            <ItemDescription line={current} locale={locale} menu={menu} />
            <Text style={styles.amount}>{money(current.quantity * current.unitPrice)}</Text>
          </View>
          {!previous && <Text tone="green" variant="small">{t('New configuration', 'Uburyo bushya bwo gutegura')}</Text>}
          {previous && previous.unitPrice !== current.unitPrice && (
            <Text variant="small" tone="red">
              {t('Price per item', 'Igiciro kuri kimwe')} · {money(previous.unitPrice)} → {money(current.unitPrice)}
            </Text>
          )}
          {previous && previous.quantity !== current.quantity && (
            <Text variant="small" tone="red">
              {t('Quantity', 'Umubare')} · {previous.quantity} → {current.quantity}
            </Text>
          )}
        </View>
      ))}
      {!available.length && <Text tone="muted">{t('None of these items are available.', 'Nta na kimwe muri ibi biribwa kiboneka.')}</Text>}
      {removed.length > 0 && (
        <View style={styles.removed}>
          <Text variant="label" tone="red" accessibilityRole="header">
            {t('Unavailable from your previous order', 'Ibitakiboneka muri komande yawe yabanje')}
          </Text>
          {removed.map((line, index) => <ItemDescription key={index} line={line} locale={locale} menu={menu} />)}
        </View>
      )}
      {offer.changes.filter(({ kind }) => kind === 'slot').map((change, index) => (
        <Text key={index} tone="red">{changeLabel(change, locale, menu)}</Text>
      ))}
      {!!available.length && (
        <View style={styles.summary}>
          {originalTotal !== estimate && (
            <View style={styles.row}>
              <Text variant="small" tone="muted" style={styles.itemDescription}>{t('Previous items total', 'Igiteranyo cy’ibiribwa byabanje')}</Text>
              <Text variant="small" tone="muted" style={styles.amount}>{money(originalTotal)}</Text>
            </View>
          )}
          <View style={styles.row}>
            <Text variant="label" style={styles.itemDescription}>{t('Cart estimate', 'Igiciro cy’agateganyo cy’igitebo')}</Text>
            <Text variant="label" style={styles.amount}>{money(estimate)}</Text>
          </View>
        </View>
      )}
      <Button
        label={replacesCart ? t('Replace cart with these items', 'Simbuza ibiri mu gatebo ibi biribwa') : t('Add these items to cart', 'Shyira ibi biribwa mu gatebo')}
        onPress={onConfirm} disabled={disabled || !available.length}
      />
      <Button label={t('Cancel reorder', 'Hagarika gusubiramo komande')} variant="ghost" onPress={onCancel} />
    </Card>
  );
}

const styles = StyleSheet.create({
  item: { borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 8, gap: 3 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
  itemDescription: { flexShrink: 1 },
  amount: { flexShrink: 1, maxWidth: '100%', marginLeft: 'auto', textAlign: 'right' },
  removed: { gap: 8, padding: 10, borderRadius: 10, backgroundColor: colors.paper },
  summary: { gap: 6, paddingTop: 4 },
});
