const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// Fast Refresh - REAL-TIME UPDATES CONFIGURATION
config.transformer = {
  ...config.transformer,
  experimentalImportSupport: false, // REQUIRED for Fast Refresh
  inlineRequires: true,
  unstable_allowRequireContext: true,
  // Enable Fast Refresh explicitly
  enableBabelRCLookup: true,
  enableBabelRuntime: true,
};

// Ensure Fast Refresh is not disabled by resolver - merge properly
config.resolver = {
  ...config.resolver,
  sourceExts: [...(config.resolver.sourceExts || []), 'jsx', 'js', 'ts', 'tsx'],
  unstable_enablePackageExports: false,
  // Add resolver alias for shims
  alias: {
    ...config.resolver.alias,
    'is-arrayish': path.resolve(__dirname, 'shims/is-arrayish.js'),
    'react-native-maps': path.resolve(__dirname, 'shims/react-native-maps.js'),
  },
};

// Shim deprecated React Native modules to prevent errors
config.resolver.extraNodeModules = {
  ...config.resolver.extraNodeModules,
  '@react-native-community/push-notification-ios': path.resolve(
    __dirname,
    'shims/PushNotificationIOS.js'
  ),
};

// Shim native-only modules on web so Metro doesn't try to bundle them
const originalResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    platform === 'web' &&
    moduleName.startsWith('./exports/') &&
    context.originModulePath.endsWith(
      path.join('node_modules', 'react-native-web', 'dist', 'index.js')
    )
  ) {
    return {
      type: 'sourceFile',
      filePath: path.resolve(
        __dirname,
        'node_modules/react-native-web/dist',
        moduleName,
        'index.js'
      ),
    };
  }
  if (moduleName === 'split-on-first') {
    return {
      type: 'sourceFile',
      filePath: path.resolve(__dirname, 'shims/split-on-first.js'),
    };
  }
  if (moduleName === 'expo-modules-core') {
    return {
      type: 'sourceFile',
      filePath: path.resolve(__dirname, 'node_modules/expo-modules-core/src/index.ts'),
    };
  }
  if (platform === 'web' && moduleName === '@stripe/stripe-react-native') {
    return {
      type: 'sourceFile',
      filePath: path.resolve(__dirname, 'shims/stripe-react-native.js'),
    };
  }
  if (platform === 'web' && moduleName === 'react-native-iap') {
    return { type: 'sourceFile', filePath: path.resolve(__dirname, 'shims/react-native-iap.js') };
  }
  if (platform === 'web' && moduleName === '@react-native-community/datetimepicker') {
    return { type: 'sourceFile', filePath: path.resolve(__dirname, 'shims/datetimepicker.js') };
  }
  // NOTE: a web shim that replaced @expo/vector-icons with an empty <Text> was
  // removed here (Sep 2026) — it rendered EVERY icon blank on the web app
  // (owner note "icons on web app still don't work"). Real vector icons now
  // render on web; their fonts are relocated out of the node_modules asset path
  // at build time (scripts/relocate-web-vendor-assets.mjs) so Vercel serves them.
  if (originalResolveRequest) {
    try {
      return originalResolveRequest(context, moduleName, platform);
    } catch (error) {
      return context.resolveRequest(context, moduleName, platform);
    }
  }
  return context.resolveRequest(context, moduleName, platform);
};

// Ensure shims directory is included in the watch folders
config.watchFolders = [...config.watchFolders, path.resolve(__dirname, 'shims')];

// Ensure Fast Refresh watch options are optimal
config.watchFolders = [...new Set(config.watchFolders)]; // Remove duplicates

// Server configuration for localhost development with fast refresh
config.server = {
  ...config.server,
  enhanceMiddleware: middleware => {
    return middleware;
  },
};

// Explicitly enable Fast Refresh (should be enabled by default, but ensure it)
config.transformer.unstable_allowRequireContext = true;

// Cache configuration for faster rebuilds
config.cacheStores = config.cacheStores || [];

module.exports = config;
