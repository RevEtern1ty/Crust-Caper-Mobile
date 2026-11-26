import type { Locale } from './catalog-types.ts';

export type LegalKind = 'privacy' | 'terms';

export function legalPath(kind: LegalKind, locale: Locale, version?: string) {
  return '/' + kind + (version ? '/' + version : '') + (locale === 'rw' ? '?lang=rw' : '');
}
