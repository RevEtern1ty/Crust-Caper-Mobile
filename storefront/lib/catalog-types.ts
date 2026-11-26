export type Locale = 'en' | 'rw';

export const catalogIdPattern = /^[A-Za-z0-9._:-]{1,100}$/;

export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'rw';
}

export function isCatalogSku(value: unknown): value is string {
  return typeof value === 'string' && catalogIdPattern.test(value) && value !== '.' && value !== '..';
}
