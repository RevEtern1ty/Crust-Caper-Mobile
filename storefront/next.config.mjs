import { dirname } from 'node:path';

/** @type {import('next').NextConfig} */
const config = {
  output: 'standalone',
  poweredByHeader: false,
  images: { unoptimized: true },
  turbopack: {
    root: dirname(import.meta.dirname),
  },
};

export default config;
