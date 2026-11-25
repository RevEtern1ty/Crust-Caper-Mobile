import type { ConfigContext, ExpoConfig } from 'expo/config';

const domainName = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`Set ${name} for this CrustCaper build profile.`);
  return value.trim();
}

function httpsOrigin(value: string, name: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !domainName.test(url.hostname) || url.hostname.endsWith('.localhost')
      || url.username || url.password || url.port || url.search || url.hash) {
    throw new Error(`${name} must use a domain over HTTPS on its standard port.`);
  }
  return url;
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const profile = process.env.CRUSTCAPER_BUILD_PROFILE ?? 'demo';
  if (profile === 'demo') {
    return { ...config, extra: { ...config.extra, restaurant: { profile } } };
  }
  if (profile !== 'local' && profile !== 'stage' && profile !== 'production') {
    throw new Error('Use demo, local, stage or production for CRUSTCAPER_BUILD_PROFILE.');
  }

  const local = profile === 'local';
  const apiUrl = required(process.env.CRUSTCAPER_API_BASE_URL, 'CRUSTCAPER_API_BASE_URL');
  const api = local ? new URL(apiUrl) : httpsOrigin(apiUrl, 'CRUSTCAPER_API_BASE_URL');
  if ((local && (api.protocol !== 'http:' || !['127.0.0.1', 'localhost', '10.0.2.2'].includes(api.hostname)
      || api.username || api.password || api.search || api.hash))
      || api.pathname.replace(/\/$/, '') !== '/api/v1') {
    throw new Error('The API URL must point to /api/v1 on an origin allowed by the profile.');
  }

  const storeId = local ? process.env.CRUSTCAPER_STORE_ID || 'kigali'
    : required(process.env.CRUSTCAPER_STORE_ID, 'CRUSTCAPER_STORE_ID');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(storeId)) throw new Error('Invalid CrustCaper store ID.');

  const pspHosts = local ? [] : required(process.env.CRUSTCAPER_PSP_HOSTS, 'CRUSTCAPER_PSP_HOSTS')
    .split(',').map(host => host.trim().toLowerCase());
  if (pspHosts.some(host => !domainName.test(host))) {
    throw new Error('Supply exact PSP host names separated by commas.');
  }

  const production = profile === 'production';
  const androidPackage = production ? required(process.env.CRUSTCAPER_ANDROID_PACKAGE, 'CRUSTCAPER_ANDROID_PACKAGE')
    : `com.crustcaper.mobile.${profile}`;
  const iosBundleId = production ? required(process.env.CRUSTCAPER_IOS_BUNDLE_ID, 'CRUSTCAPER_IOS_BUNDLE_ID')
    : `com.crustcaper.mobile.${profile}`;
  for (const identifier of [androidPackage, iosBundleId]) {
    if (!/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/.test(identifier) || (production && /\.(demo|local|stage)$/.test(identifier))) {
      throw new Error('Use a distinct, valid native application identifier for this profile.');
    }
  }
  const appLinkOrigin = local ? null : httpsOrigin(
    required(process.env.CRUSTCAPER_APP_LINK_ORIGIN, 'CRUSTCAPER_APP_LINK_ORIGIN'), 'CRUSTCAPER_APP_LINK_ORIGIN',
  );
  if (appLinkOrigin && appLinkOrigin.pathname !== '/') throw new Error('Use only the app-link origin.');
  const returnPath = '/payment-return';
  const name = production ? 'CrustCaper' : `CrustCaper ${profile === 'local' ? 'Local' : 'Stage'}`;
  const plugins = (config.plugins ?? []).map(plugin =>
    Array.isArray(plugin) && plugin[0] === 'expo-build-properties'
      ? [plugin[0], {
          ...plugin[1],
          android: { ...plugin[1]?.android, usesCleartextTraffic: local },
        }] as typeof plugin
      : plugin);
  return {
    ...config,
    name,
    scheme: production ? 'crustcaper' : `crustcaper-${profile}`,
    plugins,
    ios: {
      ...config.ios,
      bundleIdentifier: iosBundleId,
      associatedDomains: appLinkOrigin ? [`applinks:${appLinkOrigin.host}`] : undefined,
      infoPlist: {
        ...config.ios?.infoPlist,
        NSAppTransportSecurity: { NSAllowsArbitraryLoads: false, NSAllowsLocalNetworking: local },
      },
    },
    android: {
      ...config.android,
      package: androidPackage,
      intentFilters: appLinkOrigin ? [{
        action: 'VIEW',
        autoVerify: true,
        data: [{ scheme: 'https', host: appLinkOrigin.host, path: returnPath }],
        category: ['BROWSABLE', 'DEFAULT'],
      }] : undefined,
    },
    extra: {
      ...config.extra,
      restaurant: { profile, apiBaseUrl: api.origin + '/api/v1', storeId, pspHosts },
    },
  };
};
