import type { NextApiRequest, NextApiResponse } from 'next';
import { catalogConfigured } from '../../lib/catalog';
import { legalPublication } from '../../lib/legal';

export default async function catalogHealth(_request: NextApiRequest, response: NextApiResponse) {
  response.setHeader('Cache-Control', 'no-store');
  const { status } = await legalPublication();
  const missingProductionDocuments = process.env.CRUSTCAPER_STOREFRONT_PROFILE === 'production' && status !== 'published';
  if (!catalogConfigured() || status === 'unavailable' || missingProductionDocuments) {
    return response.status(503).json({ status: 'configuration_unavailable' });
  }
  response.status(200).json({ status: 'up' });
}
