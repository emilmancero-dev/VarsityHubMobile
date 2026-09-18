module.exports = function (api) {
  api.cache(true);

  const isProduction = process.env.NODE_ENV === 'production';

  return {
    presets: ['babel-preset-expo'], // Includes react-refresh/plugin by default
    plugins: [
      [
        'module-resolver',
        {
          extensions: ['.ts', '.tsx', '.js', '.jsx', '.json'],
          alias: {
            // Place more specific aliases first to avoid '@' greedy matches
            '@/components': './components',
            '@/constants': './constants',
            '@/hooks': './hooks',
            '@/context': './context',
            '@/api': './apiclient',
            '@/utils': './utils',
            '@/config': './config',
            '@/lib': './lib',
            '@/shared': './shared',
            '@/data': './data',
            '@/features': './app/features',
            '@/ui': './components/ui',
            '@/styles': './styles',
            // Shim problematic nested deps on Windows
            'is-arrayish': './shims/is-arrayish',
          },
        },
      ],
      ...(isProduction ? [['transform-remove-console', { exclude: ['error', 'warn'] }]] : []),
      // Expo SDK 54 + Reanimated v4 requires the worklets plugin for Fast Refresh.
      'react-native-worklets/plugin',
    ],
  };
};
