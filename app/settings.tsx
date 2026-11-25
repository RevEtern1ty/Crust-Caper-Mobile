import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { useShop } from '../src/state/shop';
import { Card, colors, Icon, Screen, Text } from '../src/ui/core';
import { copy } from '../src/ui/format';

const languages = [{ id: 'en', name: 'English' }, { id: 'rw', name: 'Kinyarwanda' }] as const;

export default function SettingsScreen() {
  const { locale, setLocale, hydrated } = useShop();
  const isWeb = Platform.OS === 'web';
  return (
    <Screen safeBottom>
      <Text variant="title" accessibilityRole="header">{copy(locale, 'Settings', 'Amagenamiterere')}</Text>
      <View role={isWeb ? 'group' : undefined} aria-labelledby={isWeb ? 'language-heading' : undefined} style={styles.languages}>
        <Text nativeID={isWeb ? 'language-heading' : undefined} variant="heading">{copy(locale, 'Language', 'Ururimi')}</Text>
        {languages.map(language => {
          const selected = locale === language.id;
          return <Pressable key={language.id} accessibilityRole={isWeb ? 'button' : 'radio'}
            aria-pressed={isWeb ? selected : undefined}
            accessibilityState={{ checked: selected, disabled: !hydrated }} accessibilityLanguage={language.id}
            disabled={!hydrated} onPress={() => setLocale(language.id)} style={[styles.language, selected && styles.selected]}>
            <Text variant="label">{language.name}</Text>
            <Icon name={selected ? 'radio-button-on' : 'radio-button-off'} color={colors.green} />
          </Pressable>;
        })}
      </View>
      <Card>
        <Text variant="heading">{copy(locale, 'CrustCaper Demo', 'Igerageza rya CrustCaper')}</Text>
        <Text>{copy(locale, 'Orders and payments use test data. Follow their status under Orders.', 'Komande no kwishyura bikoresha amakuru y’igerageza. Kurikirana uko bimeze muri Komande.')}</Text>
        <Text variant="small" tone="muted">{copy(locale, 'Test orders are saved on this device. Use the demo phone number at checkout.', 'Komande z’igerageza zibikwa kuri iki gikoresho. Koresha nimero y’igerageza igihe wemeza komande.')}</Text>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  languages: { gap: 8 },
  language: {
    minHeight: 54, borderWidth: 1, borderRadius: 12, borderColor: colors.border,
    paddingHorizontal: 14, paddingVertical: 10, flexDirection: 'row',
    alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.white,
  },
  selected: { backgroundColor: colors.mint, borderColor: colors.green },
});
