import type { AppProps } from 'next/app';
import '../styles/catalog.css';

export default function Storefront({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />;
}
