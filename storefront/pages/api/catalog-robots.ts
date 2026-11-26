import type { NextApiRequest, NextApiResponse } from 'next';
import { catalogSite } from '../../lib/catalog';

export default function catalogRobots(_request: NextApiRequest, response: NextApiResponse) {
  const site = catalogSite();
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  if (!site?.indexable) {
    return response.status(site ? 200 : 503).send('User-agent: *\nDisallow: /\n');
  }

  return response.status(200).send([
    'User-agent: *',
    'Disallow: /api/',
    'Disallow: /operator/',
    'Sitemap: ' + site.publicOrigin + '/sitemap.xml',
    '',
  ].join('\n'));
}
