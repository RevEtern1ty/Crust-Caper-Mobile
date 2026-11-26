import { useState } from 'react';
import { Linking } from 'react-native';
import { legalOrigin, useShop } from '../state/shop';
import { Button, Text } from './core';
import { copy } from './format';

export function LegalDocumentLink({ kind, variant = 'ghost' }: { kind: 'privacy' | 'terms'; variant?: 'ghost' | 'secondary' }) {
  const { locale } = useShop();
  const [failed, setFailed] = useState(false);
  if (!legalOrigin) return null;
  const url = legalOrigin + '/' + kind + (locale === 'rw' ? '?lang=rw' : '');
  const label = kind === 'privacy' ? copy(locale, 'Privacy policy', 'Politiki y’amakuru bwite')
    : copy(locale, 'Ordering terms', 'Amabwiriza yo gutumiza');

  async function openDocument() {
    setFailed(false);
    try {
      await Linking.openURL(url);
    } catch {
      setFailed(true);
    }
  }

  return <>
    <Button label={label} variant={variant} onPress={() => { void openDocument(); }} />
    {failed && <Text tone="red" accessibilityRole="alert">
      {copy(locale, 'Could not open the document. Try again.', 'Inyandiko ntiyafungutse. Ongera ugerageze.')}
    </Text>}
  </>;
}
