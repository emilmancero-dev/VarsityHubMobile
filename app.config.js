// app.config.js — Dynamic Expo config
// Sensitive values are loaded from environment variables.
// Non-sensitive values (app name, permissions, colors, plugins) remain inline.
//
// Set these env vars in your EAS build profile (eas.json) or local .env:
//   EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY
//   EXPO_PUBLIC_GOOGLE_MAPS_API_KEY
//   EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID
//   EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID
//   EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID
//   EXPO_PUBLIC_GOOGLE_EXPO_CLIENT_ID
//   EXPO_PUBLIC_SENTRY_DSN
//   EAS_PROJECT_ID

module.exports = ({ config }) => {
  const isTruthy = value =>
    typeof value === 'string' && ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  const EAS_PROJECT_ID = process.env.EAS_PROJECT_ID || '64489ed7-a8c0-41de-91ec-5846ea79a27f';
  const packageVersion = require('./package.json').version;
  const appVersion = process.env.APP_VERSION_OVERRIDE || packageVersion;
  const runtimeVersion = process.env.RUNTIME_VERSION_OVERRIDE || appVersion;
  // This bundle requires the native media picker introduced in 1.0.6.
  // Refuse an old-runtime OTA override instead of shipping it to incompatible binaries.
  if (appVersion !== packageVersion || runtimeVersion !== packageVersion) {
    throw new Error(
      'App and runtime versions must match package.json; native media releases require a matching build.'
    );
  }
  const sentryAutoUploadEnabled = process.env.SENTRY_DISABLE_AUTO_UPLOAD !== 'true';
  const useLocalApi = isTruthy(process.env.EXPO_PUBLIC_USE_LOCAL_API || '0');
  const publicApiUrl = useLocalApi
    ? 'http://localhost:4000'
    : process.env.EXPO_PUBLIC_API_URL || 'https://api-production-8ac3.up.railway.app';
  const forceRemoteApi = process.env.EXPO_PUBLIC_FORCE_REMOTE_API || (useLocalApi ? '0' : '1');
  const publicNodeEnv =
    process.env.EXPO_PUBLIC_NODE_ENV ||
    (process.env.NODE_ENV === 'development' ? 'development' : 'production');

  // Client IDs are NOT secrets — they're embedded in the app bundle.
  // Hardcoded fallbacks ensure the URL scheme is always registered even
  // when EAS build env vars are not explicitly set.
  const GOOGLE_IOS_CLIENT_ID =
    process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ||
    '514463516787-dm665i3u3a6un7eties8q73eik17vcs3.apps.googleusercontent.com';
  const universalLinkHosts = ['varsityhub.app', 'www.varsityhub.app', 'app.varsityhub.app'];
  const universalLinkPathPrefixes = [
    '/posts',
    '/games',
    '/teams',
    '/programs',
    '/users',
    '/events',
    '/organizations',
    '/join',
    '/share',
    '/verify',
    '/verify-email',
    '/reset-password',
    '/settings/manage-subscription',
    '/admin-dashboard',
    '/admin-ads',
    '/organization-join-requests',
    '/team-hub',
    '/create-fan-event',
    '/event-detail',
    '/payment-success',
    '/payment-cancel',
  ];

  return {
    ...config,
    name: 'VarsityHub',
    slug: 'varsityhub',
    owner: 'varsity-hub',
    version: appVersion,
    // Bare workflow EAS Update requires an explicit runtime string.
    // Keep the runtime aligned with the versioned native build.
    runtimeVersion,
    description:
      'VarsityHub is the sports social app where fans follow their teams, athletes share highlights, and friends connect over local games.',
    githubUrl: 'https://github.com/xsantcastx/VarsityHubMobile',
    icon: './assets/images/icon.png',
    scheme: 'varsityhubmobile',
    userInterfaceStyle: 'automatic',
    newArchEnabled: true,
    orientation: 'portrait',
    locales: {
      en: './locales/en.json',
    },
    updates: {
      enabled: true,
      fallbackToCacheTimeout: 0,
      url: `https://u.expo.dev/${EAS_PROJECT_ID}`,
      checkAutomatically: 'ON_LOAD',
      requestHeaders: {
        'expo-channel-name': 'production',
      },
    },
    ios: {
      buildNumber: '60',
      supportsTablet: true,
      appleTeamId: 'B5H8F69RW5',
      bundleIdentifier: 'com.varsithub.varsityhub-ios',
      associatedDomains: universalLinkHosts.map(host => `applinks:${host}`),
      usesAppleSignIn: true,
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
        NSCameraUsageDescription:
          'VarsityHub uses your camera to take photos and videos for team posts, profile pictures, and game highlights.',
        NSMicrophoneUsageDescription:
          'VarsityHub uses your microphone to capture audio when recording game-day videos and highlight clips.',
        NSPhotoLibraryUsageDescription:
          'VarsityHub uses your photo library so you can select existing photos and videos to share in team posts or set as your profile picture.',
        NSLocationWhenInUseUsageDescription:
          'VarsityHub uses your location to display nearby games, tournaments, and team events on the map, and to confirm you are at the venue when you post from a live event.',
        NSPrivacyPolicyURL: 'https://varsityhub.app/privacy-policy',
        CFBundleURLTypes: [
          {
            CFBundleURLSchemes: [
              'varsityhubmobile',
              'com.varsithub.varsityhub-ios',
              // Reversed Google iOS client ID for OAuth redirect
              // e.g. 514463516787-xxx.apps.googleusercontent.com → com.googleusercontent.apps.514463516787-xxx
              ...(GOOGLE_IOS_CLIENT_ID
                ? [
                    `com.googleusercontent.apps.${GOOGLE_IOS_CLIENT_ID.replace('.apps.googleusercontent.com', '')}`,
                  ]
                : []),
            ],
          },
        ],
      },
    },
    android: {
      adaptiveIcon: {
        foregroundImage: './assets/images/adaptive-icon.png',
        backgroundColor: '#000000',
      },
      softwareKeyboardLayoutMode: 'pan',
      edgeToEdgeEnabled: true,
      versionCode: 60,
      package: 'com.varsityhub.varsityhub',
      intentFilters: [
        {
          action: 'VIEW',
          autoVerify: true,
          category: ['BROWSABLE', 'DEFAULT'],
          data: universalLinkHosts.flatMap(host =>
            universalLinkPathPrefixes.map(pathPrefix => ({
              scheme: 'https',
              host,
              pathPrefix,
            }))
          ),
        },
      ],
      permissions: [
        'android.permission.CAMERA',
        'android.permission.READ_MEDIA_IMAGES',
        'android.permission.READ_MEDIA_VIDEO',
        'android.permission.ACCESS_FINE_LOCATION',
        'android.permission.ACCESS_COARSE_LOCATION',
        'android.permission.VIBRATE',
        'android.permission.INTERNET',
        'android.permission.READ_MEDIA_VISUAL_USER_SELECTED',
        'android.permission.POST_NOTIFICATIONS',
        'android.permission.RECORD_AUDIO',
        'android.permission.MODIFY_AUDIO_SETTINGS',
      ],
      blockedPermissions: [
        'android.permission.READ_MEDIA_AUDIO',
        'android.permission.READ_EXTERNAL_STORAGE',
        'android.permission.WRITE_EXTERNAL_STORAGE',
        'android.permission.SYSTEM_ALERT_WINDOW',
      ],
    },
    web: {
      bundler: 'metro',
      output: 'static',
      favicon: './assets/images/favicon.png',
    },
    plugins: [
      'expo-router',
      [
        'expo-splash-screen',
        {
          image: './assets/images/splash.png',
          imageWidth: 200,
          resizeMode: 'contain',
          backgroundColor: '#ffffff',
        },
      ],
      [
        'expo-image-picker',
        {
          photosPermission:
            'VarsityHub uses your photo library to let you attach game photos, team logos, and other images to your posts.',
          cameraPermission:
            'VarsityHub uses your camera to capture photos and videos for team posts and profile pictures.',
          microphonePermission:
            'VarsityHub uses your microphone to record audio when capturing video highlights through the camera.',
        },
      ],
      [
        'expo-location',
        {
          isAndroidBackgroundLocationEnabled: false,
          locationWhenInUsePermission:
            'VarsityHub uses your location to display nearby games, tournaments, and team events on the map.',
        },
      ],
      [
        'expo-media-library',
        {
          photosPermission:
            'VarsityHub uses your photo library to let you browse and select images and videos for team posts and profiles.',
          savePhotosPermission:
            'VarsityHub uses save access to download shared team photos and game-day images to your device.',
        },
      ],
      'expo-video',
      'expo-web-browser',
      'expo-secure-store',
      'expo-font',
      'expo-audio',
      'expo-apple-authentication',
      'expo-asset',
      [
        'expo-notifications',
        {
          icon: './assets/images/logo.png',
          color: '#3B82F6',
        },
      ],
      './plugins/withAndroidManifestCleanup',
      './plugins/withAndroidLintExtraTranslationFix',
      './plugins/withAndroidBuildConfig',
      './plugins/withAndroidGooglePay',
      './plugins/withStripeProguardFix',
      './plugins/withGoogleMaps',
      './plugins/withGoogleOAuth',
      [
        '@sentry/react-native/expo',
        {
          url: 'https://sentry.io/',
          organization: 'lime-productions',
          project: 'varsityhub',
          uploadSourcemaps: sentryAutoUploadEnabled,
        },
      ],
      'react-native-iap',
      'react-native-compressor',
    ],
    // Expo Router typed routes are required in this app.
    // Route safety should fail in two layers:
    // 1. TypeScript via generated Expo Router route types
    // 2. Jest via __tests__/route-registry.test.ts for static callsite coverage
    //
    // Keep app.config.js as the source of truth for router experiments.
    // app.json may mirror these values, but new routing config should be added here
    // unless the project is intentionally migrated away from dynamic Expo config.
    experiments: {
      typedRoutes: true,
    },
    extra: {
      router: {},
      eas: {
        projectId: EAS_PROJECT_ID,
      },
      EXPO_PUBLIC_API_URL: publicApiUrl,
      EXPO_PUBLIC_FORCE_REMOTE_API: forceRemoteApi,
      EXPO_PUBLIC_USE_LOCAL_API: useLocalApi ? '1' : process.env.EXPO_PUBLIC_USE_LOCAL_API || '0',
      EXPO_PUBLIC_NODE_ENV: publicNodeEnv,
      EXPO_PUBLIC_APP_SCHEME: 'varsityhubmobile',
      EXPO_PUBLIC_WEB_BASE_URL: 'https://varsityhub.app',
      APP_STORE_PRIVACY_POLICY_URL: 'https://varsityhub.app/privacy-policy',

      // Sensitive values — loaded from environment variables
      EXPO_PUBLIC_SENTRY_DSN: process.env.EXPO_PUBLIC_SENTRY_DSN || '',
      EXPO_PUBLIC_POSTHOG_API_KEY: process.env.EXPO_PUBLIC_POSTHOG_API_KEY || '',
      EXPO_PUBLIC_POSTHOG_HOST: process.env.EXPO_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
      EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY: process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY || '',
      EXPO_PUBLIC_GOOGLE_MAPS_API_KEY: process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY || '',
      EXPO_PUBLIC_ADMIN_EMAILS:
        process.env.EXPO_PUBLIC_ADMIN_EMAILS || 'customerservice@varsityhub.app',
      EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID:
        process.env.EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID ||
        '514463516787-bhvkja2devf8mrk204pcti7nld90d2g9.apps.googleusercontent.com',
      EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID: GOOGLE_IOS_CLIENT_ID,
      EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID:
        process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ||
        '514463516787-rqdc3es1n5ofr3v7dn1l1gpj6r8kauqu.apps.googleusercontent.com',
      EXPO_PUBLIC_GOOGLE_EXPO_CLIENT_ID:
        process.env.EXPO_PUBLIC_GOOGLE_EXPO_CLIENT_ID ||
        '514463516787-rqdc3es1n5ofr3v7dn1l1gpj6r8kauqu.apps.googleusercontent.com',
      EXPO_PUBLIC_GOOGLE_FORCE_PROXY: '0',
      EXPO_PUBLIC_EXPO_PROJECT_FULL_NAME: '@varsity-hub/varsityhub',
    },
  };
};
