import type { Locale, PickupSlot } from '../domain/types';

export function copy(locale: Locale, en: string, rw: string) {
  return locale === 'en' ? en : rw;
}

export function money(value: number) {
  return `${new Intl.NumberFormat('en-RW', { maximumFractionDigits: 0 }).format(value)} RWF`;
}

const dateOptions = { timeZone: 'Africa/Kigali' } as const;

export function slotLabel(slot: Pick<PickupSlot, 'startsAt' | 'endsAt'>, locale: Locale) {
  const lang = locale === 'en' ? 'en-GB' : 'rw-RW';
  const start = new Date(slot.startsAt);
  const date = new Intl.DateTimeFormat(lang, { ...dateOptions, day: 'numeric', month: 'short' });
  const time = new Intl.DateTimeFormat(lang, { ...dateOptions, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return `${date.format(start)} · ${time.format(start)}–${time.format(new Date(slot.endsAt))}`;
}

export function kigaliTime(timestamp: string, locale: Locale) {
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'rw-RW', {
    ...dateOptions, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(timestamp));
}
