import type { GetServerSideProps, PageConfig } from 'next';
import { CatalogProblem, MenuPage, ProductPage, type MenuItem } from '../../components/CatalogPages';
import { menuPath } from '../../components/copy';
import { isCatalogSku, isLocale, loadCatalog, type CatalogMenu, type CatalogSite, type Locale } from '../../lib/catalog';
import { legalPublication } from '../../lib/legal';

export const config: PageConfig = { unstable_runtimeJS: false };

type PageData = { locale: Locale; site: CatalogSite; store: CatalogMenu['store']; startsAt: string | null; legalAvailable: boolean };
type Props =
  | ({ view: 'menu'; products: MenuItem[] } & PageData)
  | ({ view: 'product'; product: CatalogMenu['products'][number] } & PageData)
  | { view: 'missing' | 'unavailable'; locale: Locale; retryPath: string };

export const getServerSideProps: GetServerSideProps<Props> = async ({ params, res }) => {
  const segments = params?.segments;
  const path = Array.isArray(segments) ? segments : [];
  const [requestedLocale, sku] = path;
  const locale: Locale = isLocale(requestedLocale) ? requestedLocale : 'en';

  res.setHeader('Content-Language', locale);
  res.setHeader('Cache-Control', 'no-store');

  const problem = (view: 'missing' | 'unavailable', validSku?: string): { props: Props } => {
    res.statusCode = view === 'missing' ? 404 : 503;
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (view === 'unavailable') res.setHeader('Retry-After', '30');
    return { props: { view, locale, retryPath: menuPath(locale, validSku) } };
  };

  if (path.length < 1 || path.length > 2 || !isLocale(requestedLocale)
    || (sku !== undefined && !isCatalogSku(sku))) return problem('missing');

  const catalog = await loadCatalog(locale);
  if (catalog.status !== 'ok') return problem(catalog.status, sku);
  if (!catalog.site.indexable) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  const { store, slots, products } = catalog.menu;
  const data: PageData = {
    locale, site: catalog.site, store,
    startsAt: slots.find(slot => slot.available)?.startsAt ?? null,
    legalAvailable: (await legalPublication()).status === 'published',
  };
  if (sku !== undefined) {
    const product = products.find(item => item.sku === sku);
    return product ? { props: { view: 'product', ...data, product } } : problem('missing');
  }
  const menu = products.filter(product => isCatalogSku(product.sku)).map(
    ({ sku, category, name, description, price, available, photoUrl }) => ({
      sku, category, name, description, price, available, photoUrl,
    }));
  res.setHeader('X-CrustCaper-Catalog-Version', catalog.menu.version);
  res.setHeader('X-CrustCaper-Store-Id', store.id);
  return { props: { view: 'menu', ...data, products: menu } };
};

export default function Catalog(props: Props) {
  if (props.view === 'menu') return <MenuPage {...props} />;
  if (props.view === 'product') return <ProductPage {...props} />;
  return <CatalogProblem locale={props.locale} reason={props.view} retryPath={props.retryPath} />;
}
