import Document, { Head, Html, Main, NextScript } from 'next/document';

export default class StorefrontDocument extends Document {
  render() {
    const language = this.props.__NEXT_DATA__.props.pageProps?.locale === 'rw' ? 'rw' : 'en';
    return (
      <Html lang={language}>
        <Head />
        <body>
          <Main />
          <NextScript />
        </body>
      </Html>
    );
  }
}
