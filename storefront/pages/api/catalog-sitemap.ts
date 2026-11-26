import type { NextApiRequest, NextApiResponse } from 'next';
import { catalogSite, loadCatalog } from '../../lib/catalog';

export default async function catalogSitemap(_request: NextApiRequest, response: NextApiResponse) {
  const site = catalogSite();
  response.setHeader('Cache-Control', 'no-store');
  if (!site?.indexable) return response.status(site ? 404 : 503).end();

  const [english, kinyarwanda] = await Promise.all([loadCatalog('en'), loadCatalog('rw')]);
  if (english.status !== 'ok' || kinyarwanda.status !== 'ok') return response.status(503).end();
  const urls = [['en', english.menu], ['rw', kinyarwanda.menu]] as const;
  const locations = urls.flatMap(([locale, catalog]) => {
    const menu = site.publicOrigin + '/menu/' + locale;
    return [menu, ...catalog.products.map(product => menu + '/' + encodeURIComponent(product.sku))];
  });

  response.setHeader('Content-Type', 'application/xml; charset=utf-8');
  return response.status(200).send([
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...locations.map(url => '<url><loc>' + url + '</loc></url>'),
    '</urlset>',
  ].join('\n'));
}
