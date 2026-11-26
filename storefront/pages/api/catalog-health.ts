import type { NextApiRequest, NextApiResponse } from 'next';
import { catalogConfigured } from '../../lib/catalog';

export default function catalogHealth(_request: NextApiRequest, response: NextApiResponse) {
  response.setHeader('Cache-Control', 'no-store');
  if (!catalogConfigured()) return response.status(503).json({ status: 'configuration_unavailable' });
  response.status(200).json({ status: 'up' });
}
