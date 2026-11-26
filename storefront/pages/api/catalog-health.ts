import type { NextApiRequest, NextApiResponse } from 'next';

export default function catalogHealth(_request: NextApiRequest, response: NextApiResponse) {
  response.setHeader('Cache-Control', 'no-store');
  response.status(200).json({ status: 'up' });
}
