import Head from 'next/head';
import type { GetServerSideProps, PageConfig } from 'next';
import { CatalogProblem, Layout } from '../../../components/CatalogPages';
import { contactPath, text } from '../../../components/copy';
import { catalogSite, type Locale } from '../../../lib/catalog';
import { legalPublication, selectLegalDocument, type LegalDocument } from '../../../lib/legal';
import { legalPath, type LegalKind } from '../../../lib/legal-path';

export const config: PageConfig = { unstable_runtimeJS: false };

type Props = { locale: Locale; kind: LegalKind } & (
  { status: 'unavailable' } |
  { status: 'published'; current: string; version: string; document: LegalDocument; publicOrigin: string; versioned: boolean }
);

export const getServerSideProps: GetServerSideProps<Props> = async ({ params, query, res }) => {
  const kind = params?.kind;
  const versions = params?.version;
  if ((kind !== 'privacy' && kind !== 'terms') || (versions !== undefined && (!Array.isArray(versions) || versions.length !== 1))) {
    return { notFound: true };
  }
  const locale: Locale = query.lang === 'rw' || (query.lang === undefined && query.storefrontLocale === 'rw') ? 'rw' : 'en';
  const site = catalogSite();
  const publication = await legalPublication();
  if (publication.status === 'disabled') return { notFound: true };

  res.setHeader('Content-Language', locale);
  res.setHeader('Cache-Control', 'no-store');
  if (!site?.indexable) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (!site || publication.status !== 'published') {
    res.statusCode = 503;
    res.setHeader('Retry-After', '30');
    return { props: { status: 'unavailable', locale, kind } };
  }
  const selected = selectLegalDocument(publication.publication, kind, locale, versions?.[0]);
  return selected
    ? { props: { status: 'published', locale, kind, ...selected, publicOrigin: site.publicOrigin, versioned: !!versions } }
    : { notFound: true };
};

export default function LegalPage(props: Props) {
  const { locale, kind } = props;
  const rw = locale === 'rw';
  if (props.status === 'unavailable') {
    return <CatalogProblem locale={locale} reason="unavailable" retryPath={legalPath(kind, locale)} />;
  }
  const { current, document, publicOrigin, version, versioned } = props;
  const languagePath = (language: Locale) => legalPath(kind, language, versioned ? version : undefined);
  const other = kind === 'privacy' ? 'terms' : 'privacy';
  const t = text(locale);
  return (
    <Layout locale={locale} localizedPath={languagePath}>
      <Head>
        <title>{document.title} | CrustCaper</title>
        <link rel="canonical" href={publicOrigin + languagePath(locale)} />
        <link rel="alternate" hrefLang="en" href={publicOrigin + languagePath('en')} />
        <link rel="alternate" hrefLang="rw" href={publicOrigin + languagePath('rw')} />
      </Head>
      <article className="legal-document">
        <h1>{document.title}</h1>
        <p>
          {rw ? 'Verisiyo' : 'Version'}{' '}
          <a href={legalPath(kind, locale, version)}><time dateTime={version}>{version}</time></a>
        </p>
        {version !== current && (
          <a className="back-link" href={legalPath(kind, locale)}>{rw ? 'Reba verisiyo ikoreshwa ubu' : 'Read the current version'}</a>
        )}
        {document.sections.map(({ heading, paragraphs }, index) => (
          <section key={index}>
            {heading && <h2>{heading}</h2>}
            {paragraphs.map((text, position) => <p key={position}>{text}</p>)}
          </section>
        ))}
        <div className="store-links">
          <a href={legalPath(other, locale)}>{kind === 'privacy' ? t.terms : t.privacyPolicy}</a>
          <a href={contactPath(locale)}>{t.contact}</a>
          {kind === 'privacy' && (
            <a href={'/order-privacy?storefrontLocale=' + locale}>{rw ? 'Gucunga amakuru ya komande' : 'Manage your order data'}</a>
          )}
        </div>
      </article>
    </Layout>
  );
}
