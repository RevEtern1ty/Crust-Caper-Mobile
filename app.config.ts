import type { ConfigContext, ExpoConfig } from 'expo/config';
import { createRunOncePlugin, withAndroidManifest, type ConfigPlugin } from 'expo/config-plugins';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const domainName = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const projectIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const firebaseApiKeyPattern = /^A[\w-]{38}$/;

// Expo Prebuild otherwise applies the installed notifications plugin automatically.
const withoutPickupAlertEntitlement = createRunOncePlugin(config => config, 'expo-notifications');

type FirebaseConfig = {
  project_info?: { project_number?: string; project_id?: string };
  client?: Array<{
    client_info?: { mobilesdk_app_id?: string; android_client_info?: { package_name?: string } };
    api_key?: Array<{ current_key?: string }>;
  }>;
};

// Run on Android prebuild and introspection without requiring Firebase for an iOS-only build.
const withFirebasePickupAlerts: ConfigPlugin = config => withAndroidManifest(config, mod => {
  const file = mod.android?.googleServicesFile;
  if (!file) throw new Error('Set CRUSTCAPER_ANDROID_GOOGLE_SERVICES_FILE for Android pickup notifications.');

  let firebase: FirebaseConfig;
  try {
    firebase = JSON.parse(readFileSync(resolve(mod.modRequest.projectRoot, file), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('CRUSTCAPER_ANDROID_GOOGLE_SERVICES_FILE must point to a readable google-services.json file.');
  }
  const projectNumber = firebase?.project_info?.project_number;
  const projectName = firebase?.project_info?.project_id;
  const clients = Array.isArray(firebase?.client) ? firebase.client.filter(client =>
    client?.client_info?.android_client_info?.package_name === mod.android?.package) : [];
  if (clients.length !== 1) {
    throw new Error('google-services.json must contain exactly one Firebase client for the Android package of this profile.');
  }
  const appId = clients[0]?.client_info?.mobilesdk_app_id;
  const keys = clients[0]?.api_key;
  // The Google Services Gradle plugin selects the first current_key in the matching client.
  const apiKey = Array.isArray(keys) ? keys.find(key => key && Object.hasOwn(key, 'current_key'))?.current_key : undefined;
  if (typeof projectNumber !== 'string' || !/^[0-9]+$/.test(projectNumber)
    || typeof projectName !== 'string' || !projectName.trim()
    || typeof appId !== 'string' || !appId.startsWith(`1:${projectNumber}:android:`)
    || appId === `1:${projectNumber}:android:` || typeof apiKey !== 'string' || !firebaseApiKeyPattern.test(apiKey)) {
    throw new Error('google-services.json has missing or invalid Firebase project or Android client fields for pickup notifications.');
  }
  return mod;
});

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
  const pushProfile = profile === 'stage' || profile === 'production';
  const webCheckout = process.env.CRUSTCAPER_WEB_CHECKOUT === 'true';
  if (webCheckout && !pushProfile) {
    throw new Error('CRUSTCAPER_WEB_CHECKOUT requires a stage or production HTTPS profile.');
  }
  const pushProjectId = pushProfile ? process.env.CRUSTCAPER_PUSH_PROJECT_ID?.trim().toLowerCase() || undefined : undefined;
  if (pushProjectId && !projectIdPattern.test(pushProjectId)) {
    throw new Error('CRUSTCAPER_PUSH_PROJECT_ID must be a UUID for this build profile.');
  }
  const googleServicesFile = pushProjectId ? process.env.CRUSTCAPER_ANDROID_GOOGLE_SERVICES_FILE?.trim() : undefined;
  const blockedPermissions = [
    ...(config.android?.blockedPermissions ?? []),
    'android.permission.RECEIVE_BOOT_COMPLETED',
    ...(pushProjectId ? [] : ['android.permission.POST_NOTIFICATIONS']),
  ];
  if (profile === 'demo') {
    return withoutPickupAlertEntitlement({ ...config, android: { ...config.android, blockedPermissions }, extra: { ...config.extra, restaurant: { profile } } });
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
  if (pushProjectId) plugins.push(['expo-notifications', { defaultChannel: 'pickup-ready', mode: 'production' }]);
  const resolved: ExpoConfig = {
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
      blockedPermissions,
      ...(googleServicesFile ? { googleServicesFile } : {}),
      intentFilters: appLinkOrigin ? [{
        action: 'VIEW',
        autoVerify: true,
        data: [{ scheme: 'https', host: appLinkOrigin.host, path: returnPath }],
        category: ['BROWSABLE', 'DEFAULT'],
      }] : undefined,
    },
    extra: {
      ...config.extra,
      ...(pushProjectId ? { eas: { ...config.extra?.eas, projectId: pushProjectId } } : {}),
      restaurant: { profile, apiBaseUrl: api.origin + '/api/v1', storeId, pspHosts, pushProjectId, webCheckout },
    },
  };
  return pushProjectId ? withFirebasePickupAlerts(resolved) : withoutPickupAlertEntitlement(resolved);
};
