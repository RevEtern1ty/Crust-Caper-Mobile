import type { GetServerSideProps, PageConfig } from 'next';
import { ContactPage } from '../components/CatalogPages';
import { loadCatalog, type CatalogMenu, type CatalogSite, type Locale } from '../lib/catalog';

export const config: PageConfig = { unstable_runtimeJS: false };

type Props = {
  locale: Locale;
  site: CatalogSite | null;
  store: CatalogMenu['store'] | null;
};

export const getServerSideProps: GetServerSideProps<Props> = async ({ query, res }) => {
  const locale: Locale = query.storefrontLocale === 'rw' ? 'rw' : 'en';
  res.setHeader('Content-Language', locale);
  res.setHeader('Cache-Control', 'no-store');
  const catalog = await loadCatalog(locale);
  if (catalog.status !== 'ok') {
    res.statusCode = catalog.status === 'missing' ? 404 : 503;
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (catalog.status === 'unavailable') res.setHeader('Retry-After', '30');
    return { props: { locale, site: null, store: null } };
  }
  if (!catalog.site.indexable) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  return { props: { locale, site: catalog.site, store: catalog.menu.store } };
};

export default ContactPage;
