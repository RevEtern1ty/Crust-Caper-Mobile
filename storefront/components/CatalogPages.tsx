import Head from 'next/head';
import type { PropsWithChildren } from 'react';
import type { CatalogMenu, CatalogSite, Locale } from '../lib/catalog';
import { contactPath, menuPath, pickupStatus, price, text } from './copy';
import { brandMark, photoFor } from './photos';

type Product = CatalogMenu['products'][number];
type Store = CatalogMenu['store'];
export type MenuItem = Pick<Product, 'sku' | 'category' | 'name' | 'description' | 'price' | 'available' | 'photoUrl'>;

function Seo({ locale, site, title, description, sku, photo, localizedPath = language => menuPath(language, sku) }: {
  locale: Locale;
  site: CatalogSite;
  title: string;
  description: string;
  sku?: string;
  photo?: string;
  localizedPath?: (language: Locale) => string;
}) {
  const canonical = site.publicOrigin + localizedPath(locale);
  return (
    <Head>
      <title>{title}</title>
      <meta name="description" content={description} />
      {!site.indexable && <meta name="robots" content="noindex, nofollow" />}
      <link rel="canonical" href={canonical} />
      <link rel="alternate" hrefLang="en" href={site.publicOrigin + localizedPath('en')} />
      <link rel="alternate" hrefLang="rw" href={site.publicOrigin + localizedPath('rw')} />
      <link rel="alternate" hrefLang="x-default" href={site.publicOrigin + localizedPath('en')} />
      <meta property="og:type" content="website" />
      <meta property="og:site_name" content="CrustCaper" />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={canonical} />
      {photo && <meta property="og:image" content={new URL(photo, site.publicOrigin).href} />}
    </Head>
  );
}

export function Layout({ locale, sku, children, localizedPath = language => menuPath(language, sku) }:
  PropsWithChildren<{ locale: Locale; sku?: string; localizedPath?: (language: Locale) => string }>) {
  const t = text(locale);
  return (
    <>
      <a className="skip-link" href="#main">{t.main}</a>
      <header className="site-header">
        <div className="wrap header-row">
          <a className="brand" href={menuPath(locale)}>
            <img src={brandMark} alt="" width={36} height={36} />
            <span>CrustCaper</span>
          </a>
          <nav className="language" aria-label={t.language}>
            <a aria-label="English" lang="en" href={localizedPath('en')} aria-current={locale === 'en' ? 'page' : undefined}>EN</a>
            <a aria-label="Kinyarwanda" lang="rw" href={localizedPath('rw')} aria-current={locale === 'rw' ? 'page' : undefined}>RW</a>
          </nav>
          <nav className="site-nav" aria-label={t.customerNav}>
            <a href={'/orders?storefrontLocale=' + locale}>{t.orders}</a>
            <a className="cart-link" href={'/cart?storefrontLocale=' + locale}>{t.cart}</a>
          </nav>
        </div>
      </header>
      <main id="main" className="wrap content" tabIndex={-1}>{children}</main>
    </>
  );
}

function StoreAddress({ locale, store }: { locale: Locale; store: Store }) {
  return (
    <>
      <address>
        <strong>{store.name[locale]}</strong>
        {store.area[locale] && <div>{store.area[locale]}</div>}
      </address>
      {store.hours[locale] && <p>{store.hours[locale]}</p>}
    </>
  );
}

function StoreDetails({ locale, store }: { locale: Locale; store: Store }) {
  const t = text(locale);
  return (
    <footer className="store-info">
      <h2>{t.store}</h2>
      <StoreAddress locale={locale} store={store} />
      <div className="store-links">
        {store.directionsUrl && <a href={store.directionsUrl} rel="noreferrer">{t.directions}</a>}
        <a href={contactPath(locale)}>{t.contact}</a>
        <a href={'/privacy?storefrontLocale=' + locale}>{t.privacy}</a>
      </div>
    </footer>
  );
}

export function ContactPage({ locale, site, store }: {
  locale: Locale;
  site: CatalogSite | null;
  store: Store | null;
}) {
  const t = text(locale);
  const title = t.contact + ' | CrustCaper';
  return (
    <Layout locale={locale} localizedPath={contactPath}>
      {site && store ? (
        <Seo locale={locale} site={site} title={title} description={t.contactDescription} localizedPath={contactPath} />
      ) : (
        <Head><title>{title}</title><meta name="robots" content="noindex, nofollow" /></Head>
      )}
      <a className="back-link" href={menuPath(locale)}>‹ {t.back}</a>
      <h1 className="contact-title">{t.contact}</h1>
      {store ? (
        <section className="store-info">
          <h2>{t.store}</h2>
          <StoreAddress locale={locale} store={store} />
          <div className="store-links">
            {store.directionsUrl && <a href={store.directionsUrl} rel="noreferrer">{t.directions}</a>}
            {store.supportUrl && <a href={store.supportUrl} rel="noreferrer">{t.contactSupport}</a>}
          </div>
          {!store.supportUrl && <p>{t.supportUnavailable}</p>}
        </section>
      ) : (
        <div className="problem">
          <p>{t.contactUnavailable}</p>
          <a className="secondary-action" href={contactPath(locale)}>{t.reload}</a>
        </div>
      )}
    </Layout>
  );
}

function ItemCard({ locale, product, illustrative }: { locale: Locale; product: MenuItem; illustrative: boolean }) {
  const t = text(locale);
  const photo = photoFor(product, illustrative);
  return (
    <article className="item-card">
      {photo && <img className="card-photo" src={photo} alt="" loading="lazy" decoding="async" />}
      <div className="card-body">
        <h3>{product.name[locale]}</h3>
        <p>{product.description[locale]}</p>
        {!product.available && <p className="item-status">{t.soldOut}</p>}
        <div className="card-actions">
          <strong>{price(product.price, locale)}</strong>
          <a className="secondary-action card-detail" href={menuPath(locale, product.sku)}
            aria-label={t.view + ' – ' + product.name[locale]}>{t.view}</a>
        </div>
      </div>
    </article>
  );
}

export function MenuPage({ locale, site, store, startsAt, products }: {
  locale: Locale;
  site: CatalogSite;
  store: Store;
  startsAt: string | null;
  products: MenuItem[];
}) {
  const t = text(locale);
  const pickup = pickupStatus(store.open, startsAt, locale);
  const heroPhoto = products.map(product => photoFor(product, !site.indexable)).find((photo): photo is string => !!photo);
  const categories = (Object.keys(t.categories) as Product['category'][]).flatMap(category => {
    const items = products.filter(product => product.category === category);
    return items.length ? [{ category, items }] : [];
  });
  return (
    <Layout locale={locale}>
      <Seo locale={locale} site={site} title={t.menu + ' | CrustCaper'} description={t.menuDescription} photo={heroPhoto} />
      <section className="hero">
        <div className="hero-copy">
          <h1>{t.menu}</h1>
          <p className="hero-place">{store.name[locale]}{store.area[locale] && <> · {store.area[locale]}</>}</p>
          <div className="pickup-info">
            {pickup.blocked && <strong>{pickup.blocked}</strong>}
            {pickup.nextPickup && <div>{t.nearest} <time dateTime={pickup.startsAt}>{pickup.nextPickup}</time></div>}
          </div>
        </div>
        {heroPhoto && <img className="hero-photo" src={heroPhoto} alt="" fetchPriority="high" />}
      </section>

      {categories.length > 0 && (
        <nav className="categories" aria-label={t.menu}>
          {categories.map(({ category }) => (
            <a key={category} href={'#menu-' + category}>{t.categories[category]}</a>
          ))}
        </nav>
      )}
      {categories.map(({ category, items }) => (
        <section className="menu-section" key={category} aria-labelledby={'menu-' + category}>
          <h2 id={'menu-' + category}>{t.categories[category]}</h2>
          <div className="cards">{items.map(product => (
            <ItemCard key={product.sku} locale={locale} product={product} illustrative={!site.indexable} />
          ))}</div>
        </section>
      ))}
      {categories.length === 0 && <p className="empty-menu">{t.emptyMenu}</p>}
      <StoreDetails locale={locale} store={store} />
    </Layout>
  );
}

function ProductFacts({ locale, product }: { locale: Locale; product: Product }) {
  const t = text(locale);
  return (
    <div className="product-facts">
      <section>
        <h2>{t.ingredients}</h2>
        {product.ingredients.length ? (
          <ul>{product.ingredients.map((ingredient, index) => <li key={index}>{ingredient[locale]}</li>)}</ul>
        ) : <p>{t.unlistedIngredients}</p>}
      </section>
      <section>
        <h2>{t.allergens}</h2>
        {product.allergens.length ? (
          <ul>{product.allergens.map((allergen, index) => <li key={index}>{allergen[locale]}</li>)}</ul>
        ) : <p>{t.unlistedAllergens}</p>}
      </section>
      {!!product.modifiers.length && (
        <section>
          <h2>{t.options}</h2>
          <ul className="option-list">
            {product.modifiers.map(option => (
              <li key={option.id}><span>{option.name[locale]}</span><strong>{option.price > 0 ? '+' : ''}{price(option.price, locale)}</strong></li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

export function ProductPage({ locale, site, store, startsAt, product }: {
  locale: Locale;
  site: CatalogSite;
  store: Store;
  startsAt: string | null;
  product: Product;
}) {
  const t = text(locale);
  const pickup = pickupStatus(store.open, startsAt, locale);
  const title = product.name[locale];
  const photo = photoFor(product, !site.indexable);
  const unavailable = !product.available ? t.soldOut : pickup.blocked;
  return (
    <Layout locale={locale} sku={product.sku}>
      <Seo locale={locale} site={site} title={title + ' | CrustCaper'} description={product.description[locale]}
        sku={product.sku} photo={photo} />
      <a className="back-link" href={menuPath(locale)}>‹ {t.back}</a>
      <article className="product-layout">
        {photo && <img className="product-photo" src={photo} alt={title} fetchPriority="high" />}
        <div className="product-main">
          <h1>{title}</h1>
          <p className="product-price">{price(product.price, locale)}</p>
          <p className="product-description">{product.description[locale]}</p>
          <ProductFacts locale={locale} product={product} />
          <div className="product-order">
            {unavailable ? <p className="item-status">{unavailable}</p> : (
              <a className="primary-action" href={'/product/' + encodeURIComponent(product.sku) + '?storefrontLocale=' + locale}>{t.choose}</a>
            )}
            {pickup.nextPickup && <p>{t.nearest} <time dateTime={pickup.startsAt}>{pickup.nextPickup}</time></p>}
          </div>
        </div>
      </article>
      <StoreDetails locale={locale} store={store} />
    </Layout>
  );
}

export function CatalogProblem({ locale, reason, retryPath }: {
  locale: Locale;
  reason: 'missing' | 'unavailable';
  retryPath: string;
}) {
  const t = text(locale);
  const missing = reason === 'missing';
  const title = missing ? t.missing : t.unavailableTitle;
  return (
    <Layout locale={locale}>
      <Head>
        <title>{title + ' | CrustCaper'}</title>
        <meta name="robots" content="noindex, nofollow" />
      </Head>
      <section className="problem">
        <h1>{title}</h1>
        <p>{missing ? t.missingText : t.unavailableText}</p>
        <a className="primary-action" href={missing ? menuPath(locale) : retryPath}>{missing ? t.back : t.reload}</a>
      </section>
    </Layout>
  );
}
