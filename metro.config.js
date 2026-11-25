const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
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
