import Ionicons from '@expo/vector-icons/Ionicons';
import type { ComponentProps, PropsWithChildren, ReactNode } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, RefreshControl,
  ScrollView, StyleSheet, Text as NativeText, View,
} from 'react-native';
import type { StyleProp, TextProps, ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export const colors = {
  ink: '#241620',
  plum: '#2B1827',
  cream: '#FFF5E6',
  mustard: '#F2BA4B',
  green: '#345C4A',
  muted: '#61555D',
  paper: '#F4EADF',
  white: '#FFFCF7',
  border: '#DDD0C4',
  red: '#9D342F',
  mint: '#E7EEE5',
};

const type = StyleSheet.create({
  body: { fontSize: 16, lineHeight: 24 },
  title: { fontSize: 36, lineHeight: 40, letterSpacing: -1.3, fontWeight: '900' },
  heading: { fontSize: 22, lineHeight: 27, letterSpacing: -0.35, fontWeight: '800' },
  label: { fontSize: 16, lineHeight: 22, fontWeight: '700' },
  small: { fontSize: 14, lineHeight: 20 },
});

export function Text({
  variant = 'body', tone = 'ink', style, ...props
}: TextProps & { variant?: keyof typeof type; tone?: keyof typeof colors }) {
  return <NativeText {...props} style={[type[variant], { color: colors[tone] }, style]} />;
}

export function Icon({ name, color = colors.ink, size = 22 }: {
  name: ComponentProps<typeof Ionicons>['name']; color?: string; size?: number;
}) {
  return <Ionicons name={name} size={size} color={color} accessible={false} aria-hidden />;
}

export function Button({ label, onPress, variant = 'primary', disabled, busy }: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost';
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled || !!busy, busy: !!busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        variant === 'primary' && styles.primary,
        variant === 'secondary' && styles.secondary,
        (pressed || disabled || busy) && styles.dimmed,
      ]}
    >
      {busy && <ActivityIndicator color={colors.ink} size="small" />}
      <Text variant="label" style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

export function Card({ children, style }: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Screen({ children, bottom, onRefresh, refreshing, safeBottom = false }: PropsWithChildren<{
  bottom?: ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
  safeBottom?: boolean;
}>) {
  const insets = useSafeAreaInsets();
  const extraBottom = safeBottom ? insets.bottom : 0;
  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, !bottom && { paddingBottom: 24 + extraBottom }]}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} /> : undefined}
      >
        {children}
      </ScrollView>
      {bottom && <View style={[styles.footer, { paddingBottom: 12 + extraBottom }]}>{bottom}</View>}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.cream },
  scroll: { flex: 1 },
  content: { padding: 18, gap: 18 },
  footer: {
    paddingHorizontal: 18, paddingTop: 12, borderTopWidth: 1,
    borderTopColor: colors.border, backgroundColor: colors.cream,
  },
  button: {
    minHeight: 48, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 11,
    alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8,
  },
  primary: { backgroundColor: colors.mustard },
  secondary: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.white },
  dimmed: { opacity: 0.58 },
  buttonText: { textAlign: 'center', flexShrink: 1 },
  card: { borderRadius: 16, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.white, padding: 15, gap: 9 },
});
