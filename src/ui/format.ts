import type { Locale, Menu, PickupSlot } from '../domain/types';

export function copy(locale: Locale, en: string, rw: string) {
  return locale === 'en' ? en : rw;
}

export function money(value: number) {
  return `${new Intl.NumberFormat('en-RW', { maximumFractionDigits: 0 }).format(value)} RWF`;
}

const dateOptions = { timeZone: 'Africa/Kigali' } as const;
const shortDateOptions = { ...dateOptions, day: 'numeric', month: 'short' } as const;
const timeOptions = { ...dateOptions, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } as const;
const englishDate = new Intl.DateTimeFormat('en-GB', shortDateOptions);
const englishDateTime = new Intl.DateTimeFormat('en-GB', { ...shortDateOptions, ...timeOptions });
const pickupTime = new Intl.DateTimeFormat('en-GB', timeOptions);
const numericDate = new Intl.DateTimeFormat('en-GB', { ...dateOptions, day: 'numeric', month: 'numeric' });
// Some native and browser engines omit rw. These month labels are from Unicode CLDR 49.
const rwMonths = ['Mut.', 'Gas.', 'Wer.', 'Mat.', 'Gic.', 'Kam.', 'Nya.', 'Kan.', 'Nze.', 'Ukw.', 'Ugu.', 'Uku.'];

function kinyarwandaDate(value: Date) {
  const parts = numericDate.formatToParts(value);
  const month = parts.find(part => part.type === 'month')?.value;
  const day = parts.find(part => part.type === 'day')?.value;
  return `${rwMonths[Number(month) - 1]} ${day}`;
}

export function nextPickupSlot(menu: Menu | null, now = Date.now()) {
  if (!menu?.store.open || menu.orderingUnavailable) return undefined;

  let next: PickupSlot | undefined;
  let nextStart = Infinity;
  for (const slot of menu.slots) {
    const start = Date.parse(slot.startsAt);
    if (slot.available && start > now && start < nextStart) {
      next = slot;
      nextStart = start;
    }
  }
  return next;
}

export function slotLabel(slot: Pick<PickupSlot, 'startsAt' | 'endsAt'>, locale: Locale) {
  const start = new Date(slot.startsAt);
  const date = locale === 'rw' ? kinyarwandaDate(start) : englishDate.format(start);
  return `${date} · ${pickupTime.format(start)}–${pickupTime.format(new Date(slot.endsAt))}`;
}

export function kigaliTime(timestamp: string, locale: Locale) {
  const date = new Date(timestamp);
  return locale === 'rw' ? `${kinyarwandaDate(date)} ${pickupTime.format(date)}` : englishDateTime.format(date);
}
