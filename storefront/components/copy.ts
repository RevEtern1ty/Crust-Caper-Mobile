import type { Locale } from '../lib/catalog';

const labels = {
  en: {
    menu: 'Menu', orders: 'Orders', cart: 'Cart', customerNav: 'Order and cart', language: 'Language', main: 'Skip to content',
    store: 'Pickup location', directions: 'Directions', contact: 'Contact the restaurant', privacy: 'Order privacy',
    contactSupport: 'Contact support',
    supportUnavailable: 'The restaurant has not published a support link yet.',
    contactUnavailable: 'Contact information is temporarily unavailable.',
    contactDescription: 'Find the CrustCaper pickup location, hours and customer support.',
    nearest: 'Next available pickup', closed: 'The restaurant is closed',
    noTimes: 'Pickup times are unavailable',
    soldOut: 'Currently unavailable', emptyMenu: 'No items are available in the menu right now.',
    back: 'Back to menu', view: 'View details', choose: 'Customize and order',
    ingredients: 'Ingredients', allergens: 'Allergen information', options: 'Options',
    unlistedIngredients: 'Ingredient information is currently unavailable.',
    unlistedAllergens: 'Allergen information is currently unavailable.',
    missing: 'Page not found', missingText: 'The page or item may have moved.',
    unavailableTitle: 'The menu is temporarily unavailable',
    unavailableText: 'Try again in a moment.',
    reload: 'Try again',
    menuDescription: 'See the CrustCaper pickup menu, prices, ingredients and available pickup times.',
    categories: { burgers: 'Burgers', combos: 'Combos', sides: 'Sides', drinks: 'Drinks' },
  },
  rw: {
    menu: 'Ifunguro', orders: 'Komande', cart: 'Agatebo', customerNav: 'Komande n’agatebo', language: 'Ururimi',
    main: 'Jya ku bikubiye ku rupapuro',
    store: 'Aho ufatira komande', directions: 'Inzira', contact: 'Vugana na resitora', privacy: 'Amakuru bwite ya komande',
    contactSupport: 'Saba ubufasha',
    supportUnavailable: 'Resitora ntirashyiraho uburyo bwo kuyivugisha.',
    contactUnavailable: 'Amakuru yo kuvugana na resitora ntaboneka ubu.',
    contactDescription: 'Reba aho ufatira komande za CrustCaper, amasaha n’uburyo bwo gusaba ubufasha.',
    nearest: 'Igihe cya hafi cyo gufata komande',
    closed: 'Resitora irafunze', noTimes: 'Igihe cyo gufata komande ntikiboneka',
    soldOut: 'Ntikiboneka ubu',
    emptyMenu: 'Nta biribwa biboneka ku ifunguro ubu.',
    back: 'Subira ku ifunguro', view: 'Reba ibisobanuro', choose: 'Hitamo uko ushaka maze utumize',
    ingredients: 'Ibigize ifunguro', allergens: 'Amakuru ku bitera ubwivumbure bw’umubiri',
    options: 'Ibyo wahitamo',
    unlistedIngredients: 'Amakuru ku bigize ifunguro ntaboneka ubu.',
    unlistedAllergens: 'Amakuru ku bitera ubwivumbure bw’umubiri ntaboneka ubu.',
    missing: 'Urupapuro ntiruboneka', missingText: 'Urupapuro cyangwa ifunguro bishobora kuba byarimuwe.',
    unavailableTitle: 'Ifunguro ntiriboneka ubu', unavailableText: 'Ongera ugerageze nyuma y’akanya.',
    reload: 'Ongera ugerageze',
    menuDescription: 'Reba ifunguro rya CrustCaper, ibiciro, ibigize ibiribwa n’igihe cyo gufata komande.',
    categories: { burgers: 'Burgeri', combos: 'Amafunguro', sides: 'Ibyunganira', drinks: 'Ibinyobwa' },
  },
} as const;

export function text(locale: Locale) {
  return labels[locale];
}

export function menuPath(locale: Locale, sku?: string) {
  return '/menu/' + locale + (sku ? '/' + encodeURIComponent(sku) : '');
}

export function contactPath(locale: Locale) {
  return locale === 'rw' ? '/contact?storefrontLocale=rw' : '/contact';
}

export function price(amount: number, locale: Locale) {
  return new Intl.NumberFormat(locale === 'rw' ? 'rw-RW' : 'en-RW', {
    maximumFractionDigits: 0,
  }).format(amount) + ' RWF';
}

export function pickupStatus(open: boolean, startsAt: string | null, locale: Locale) {
  const t = text(locale);
  const blocked = !open ? t.closed : !startsAt ? t.noTimes : null;
  const nextPickup = startsAt
    ? new Intl.DateTimeFormat(locale === 'rw' ? 'rw-RW' : 'en-RW', {
      timeZone: 'Africa/Kigali', weekday: 'short', day: 'numeric', month: 'short',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date(startsAt))
    : null;
  return { blocked, nextPickup, startsAt: startsAt ?? undefined };
}
