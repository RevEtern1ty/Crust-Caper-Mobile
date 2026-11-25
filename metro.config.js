const { createHash } = require('node:crypto');
const { getConfig } = require('expo/config');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const { exp } = getConfig(__dirname, { isPublicConfig: true });
// Web expo-constants embeds the manifest at transform time. Separate build profiles must never share it.
const profileHash = createHash('sha256').update(JSON.stringify(exp.extra?.restaurant ?? null)).digest('hex');
config.cacheVersion = [config.cacheVersion, profileHash].filter(Boolean).join(':');
const decoder = require.resolve('./tooling/query-string-decoder.js');

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const origin = context.originModulePath.replaceAll('\\', '/');
  // Router 55 uses query-string 7, whose CommonJS decoder import expects a callable.
  if (moduleName === 'decode-uri-component' && origin.includes('/node_modules/query-string/')) {
    return { type: 'sourceFile', filePath: decoder };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
