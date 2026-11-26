import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { catalogIdPattern, type Locale } from './catalog-types.ts';

export { isCatalogSku, isLocale, type Locale } from './catalog-types.ts';
export type CatalogSite = { publicOrigin: string; indexable: boolean };

const storeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const imagePath = /^\/assets\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:avif|gif|jpe?g|png|webp)$/i;
const entityTag = /^(?:W\/)?"[\x21\x23-\x7e]{1,128}"$/;
const availabilityHeader = 'X-Availability-Checked-At';
const maxMenuBytes = 12 * 1024 * 1024;
const retainedMenuMs = 5 * 60 * 1000;

const identifier = z.string().regex(catalogIdPattern);
const timestamp = z.iso.datetime({ offset: true });
const localizedText = z.string().max(4096).refine(value => value.trim().length > 0);
const localized = z.object({ en: localizedText, rw: localizedText });
const amount = z.int().min(0).max(1_000_000_000);
const optionalLink = z.string().nullish();
const modifier = z.object({ id: identifier, name: localized, price: amount });
const product = z.object({
  sku: identifier,
  name: localized,
  description: localized,
  ingredients: z.array(localized),
  allergens: z.array(localized),
  category: z.enum(['burgers', 'combos', 'sides', 'drinks']),
  price: amount,
  available: z.boolean(),
  modifiers: z.array(modifier).max(25),
  photoUrl: optionalLink,
});
const store = z.object({
  id: z.string().regex(storeIdPattern),
  name: localized,
  area: localized,
  hours: localized,
  open: z.boolean(),
  supportUrl: optionalLink,
  directionsUrl: optionalLink,
});
const slot = z.object({ id: identifier, startsAt: timestamp, endsAt: timestamp, available: z.boolean() })
  .refine(value => Date.parse(value.startsAt) < Date.parse(value.endsAt));
const menuSchema = z.object({
  version: identifier,
  updatedAt: timestamp,
  store,
  products: z.array(product),
  slots: z.array(slot),
}).refine(menu => new Set(menu.products.map(item => item.sku)).size === menu.products.length);
type MenuResponse = z.infer<typeof menuSchema>;

export type CatalogProduct = Omit<z.infer<typeof product>, 'photoUrl'> & { photoUrl: string | null };
export type CatalogMenu = Omit<MenuResponse, 'store' | 'products'> & {
  store: Omit<z.infer<typeof store>, 'supportUrl' | 'directionsUrl'> & { supportUrl: string | null; directionsUrl: string | null };
  products: CatalogProduct[];
  availabilityCheckedAt: string | null;
};
type CatalogResult =
  | { status: 'ok'; site: CatalogSite; menu: CatalogMenu }
  | { status: 'missing'; site: CatalogSite }
  | { status: 'unavailable'; site: CatalogSite | null };

type RetainedMenu = {
  url: string;
  publicOrigin: string;
  tag: string;
  menu: CatalogMenu;
  retainedAt: number;
};

// The deployment serves one store and exactly two locales. A retained body is reused only after API revalidation.
const retainedMenus = new Map<Locale, RetainedMenu>();

function parseOrigin(value: string | undefined, secureOnly: boolean): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const protocolAllowed = url.protocol === 'https:' || (!secureOnly && url.protocol === 'http:');
    return protocolAllowed && (!secureOnly || !url.port) && url.origin === value ? url.origin : null;
  } catch {
    return null;
  }
}

function httpsLink(value: string | null | undefined): URL | null {
  if (!value || value.length > 2048 || /[\s\\\x00-\x1f\x7f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url : null;
  } catch {
    return null;
  }
}

function publicImage(value: string | null | undefined, publicOrigin: string): string | null {
  const url = httpsLink(value);
  return url && url.origin === publicOrigin && imagePath.test(url.pathname) && !url.search && !url.hash
    ? url.pathname : null;
}

function checkedAt(headers: Headers): string | null {
  const checked = timestamp.safeParse(headers.get(availabilityHeader));
  return checked.success ? checked.data : null;
}

async function readMenu(response: Response): Promise<MenuResponse | null> {
  const contentType = response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase();
  const size = Number(response.headers.get('Content-Length'));
  if (contentType !== 'application/json' || size > maxMenuBytes || !response.body) {
    await response.body?.cancel();
    return null;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const chunks: string[] = [];
  let bytes = 0;
  let consumed = false;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maxMenuBytes) return null;
      chunks.push(decoder.decode(result.value, { stream: true }));
    }
    consumed = true;
    chunks.push(decoder.decode());
    const parsed = menuSchema.safeParse(JSON.parse(chunks.join('')));
    return parsed.success ? parsed.data : null;
  } finally {
    if (!consumed) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function catalogSite(): CatalogSite | null {
  const publicOrigin = parseOrigin(process.env.CRUSTCAPER_PUBLIC_ORIGIN, true);
  if (!publicOrigin) return null;

  return {
    publicOrigin,
    indexable: process.env.CRUSTCAPER_STOREFRONT_PROFILE === 'production',
  };
}

function catalogSource() {
  const profile = process.env.CRUSTCAPER_STOREFRONT_PROFILE ?? 'stage';
  const apiOrigin = parseOrigin(process.env.CRUSTCAPER_CATALOG_API_ORIGIN, false);
  const storeId = process.env.CRUSTCAPER_STORE_ID;
  if ((profile !== 'stage' && profile !== 'production') || !apiOrigin || !storeId || !storeIdPattern.test(storeId)) {
    return null;
  }
  return { apiOrigin, storeId };
}

export function catalogConfigured(): boolean {
  return catalogSite() !== null && catalogSource() !== null;
}

export async function loadCatalog(locale: Locale): Promise<CatalogResult> {
  const site = catalogSite();
  const source = catalogSource();
  if (!site || !source) return { status: 'unavailable', site };

  const { publicOrigin } = site;
  const { apiOrigin, storeId } = source;

  const url = new URL(`/api/v1/stores/${encodeURIComponent(storeId)}/menu`, apiOrigin);
  url.searchParams.set('channel', 'web');
  url.searchParams.set('locale', locale);

  const latest = retainedMenus.get(locale);
  const retained = latest && latest.url === url.href && latest.publicOrigin === publicOrigin
    && performance.now() - latest.retainedAt < retainedMenuMs ? latest : null;
  const headers = new Headers({ Accept: 'application/json' });
  if (retained) headers.set('If-None-Match', retained.tag);

  try {
    const response = await fetch(url, {
      headers,
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(2500),
    });
    if (response.status === 304 && retained && response.headers.get('ETag') === retained.tag) {
      const menu = { ...retained.menu, availabilityCheckedAt: checkedAt(response.headers) };
      retainedMenus.set(locale, { ...retained, menu, retainedAt: performance.now() });
      return { status: 'ok', site, menu };
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      return response.status === 404 ? { status: 'missing', site } : { status: 'unavailable', site };
    }

    const catalog = await readMenu(response);
    if (!catalog || catalog.store.id !== storeId) return { status: 'unavailable', site };
    const menu: CatalogMenu = {
      ...catalog,
      store: {
        ...catalog.store,
        supportUrl: httpsLink(catalog.store.supportUrl)?.href ?? null,
        directionsUrl: httpsLink(catalog.store.directionsUrl)?.href ?? null,
      },
      products: catalog.products.map(item => ({ ...item, photoUrl: publicImage(item.photoUrl, publicOrigin) })),
      availabilityCheckedAt: checkedAt(response.headers),
    };
    const tag = response.headers.get('ETag');
    if (tag && entityTag.test(tag)) retainedMenus.set(locale, { url: url.href, publicOrigin, tag, menu, retainedAt: performance.now() });
    else retainedMenus.delete(locale);
    return { status: 'ok', site, menu };
  } catch {
    return { status: 'unavailable', site };
  }
}
