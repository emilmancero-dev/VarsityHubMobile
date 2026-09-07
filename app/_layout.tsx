// Must be the very first import so Reactotron patches globals before anything else
if (__DEV__ && process.env.EXPO_OS !== 'web') {
  require('../ReactotronConfig');
}
import { Ionicons, MaterialIcons } from '@expo/vector-icons';
import {
  DarkTheme,
  DefaultTheme,
  ThemeProvider as NavigationThemeProvider,
} from '@react-navigation/native';
import Constants from 'expo-constants';
import { useFonts } from 'expo-font';
import { Stack, useRootNavigationState, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as Updates from 'expo-updates';
import { requestOtaReload } from '@/utils/runtimeReload';
const { useUpdates } = Updates;
import React, { useEffect } from 'react';
import { ActivityIndicator, AppState, LogBox, Platform, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import 'react-native-reanimated';
import { enableFreeze } from 'react-native-screens';

import { AdPurchaseProvider } from '@/context/AdPurchaseProvider';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ErrorToastContainer } from '@/components/ErrorToast';
import { NotificationTapHandler } from '@/components/NotificationTapHandler';
import { OfflineBanner } from '@/components/OfflineBanner';
import { VerificationRequiredModal } from '@/components/VerificationRequiredModal';
import { WebInstallCta } from '@/components/WebInstallCta';
import { WebThemeSync } from '@/components/WebThemeSync';
import { WebThemeToggle } from '@/components/WebThemeToggle';
import { getConfig } from '@/config/env';
import { Colors } from '@/constants/Colors';
import { MAX_CONTENT_WIDTH } from '@/constants/layout';
import { AuthProvider, useAuth } from '@/context/AuthProvider';
import { NavigationHistoryProvider } from '@/context/NavigationHistoryContext';
import { PostCacheProvider } from '@/context/PostCacheContext';
import {
  asyncStoragePersister,
  CACHE_BUSTER,
  queryClient,
  shouldPersistQuery,
} from '@/lib/queryClient';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { useColorScheme } from '@/hooks/useColorScheme';
import { ThemeProvider } from '@/hooks/useCustomColorScheme';
import { useVerificationGate } from '@/hooks/useVerificationGate';
import { initAnalytics } from '@/utils/analytics';
import {
  handleDeepLinkAuthAware,
  handleInitialDeepLink,
  setupDeepLinkListener,
} from '@/utils/deepLinks';
import { captureBreadcrumb, captureException, initSentry } from '@/utils/sentry';
import { StripeProvider } from '@/utils/stripe';
import { SafeAreaProvider } from 'react-native-safe-area-context';
// @ts-ignore
import { User } from '@/api/entities';

// Conditionally import notifications only if not in Expo Go
const isExpoGo = Constants.executionEnvironment === 'storeClient';
let Notifications: typeof import('expo-notifications') | null = null;
if (!isExpoGo && Platform.OS !== 'web') {
  Notifications = require('expo-notifications');
}

const devLog = (...args: unknown[]) => {
  if (__DEV__) {
    // eslint-disable-next-line no-console
    if (__DEV__) console.log(...args);
  }
};

// Initialize Sentry and PostHog before app renders
const sentryInitialized = initSentry();
initAnalytics({ sentry_ready: sentryInitialized });

// Suspend rendering of screens that are not visible (react-freeze). Inactive
// stack screens stay mounted but stop re-rendering, freeing the JS thread
// during transitions.
enableFreeze(true);

// Initialize testing monitor on web (only in development)
if (Platform.OS === 'web' && __DEV__) {
  void import('@/utils/testingMonitor.web')
    .then(({ testingMonitor }) => {
      testingMonitor.start();
      devLog('Web Testing Monitor Active - Tracking all errors');
    })
    .catch(error => devLog('Testing monitor failed to start', error));
}

function VerificationGateHost() {
  const { user, pendingVerificationEmail, checkAuth } = useAuth();
  const gate = useVerificationGate({
    getDefaultEmail: () => pendingVerificationEmail || user?.email || null,
    requestCode: () => User.requestVerification(),
    confirmCode: (code: string) => User.verifyEmail(code),
    onVerified: () => checkAuth(),
  });

  return (
    <VerificationRequiredModal
      visible={gate.visible}
      email={gate.email}
      code={gate.code}
      loading={gate.loading}
      error={gate.error}
      info={gate.info}
      resendCooldown={gate.resendCooldown}
      onChangeCode={gate.setCode}
      onVerify={gate.verify}
      onResend={gate.resend}
      onCancel={gate.cancel}
    />
  );
}

function AppShell() {
  const colorScheme = useColorScheme();

  return (
    <>
      <WebThemeSync />
      <WebThemeToggle />
      <NotificationTapHandler />
      <VerificationGateHost />
      <NavigationThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        {/* Inside the provider so the phone-width in-flow banner pushes the
            router content down instead of floating over it; the desktop
            variant is position:fixed and unaffected by tree position. */}
        <WebInstallCta />
        <OfflineBanner />
        <ErrorToastContainer />
        <View
          style={{
            flex: 1,
            backgroundColor: Colors[colorScheme ?? 'light'].background,
          }}
        >
          <View
            style={{
              flex: 1,
              maxWidth: MAX_CONTENT_WIDTH,
              width: '100%',
              alignSelf: 'center',
            }}
          >
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="+not-found" />
            </Stack>
          </View>
        </View>
        <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
      </NavigationThemeProvider>
    </>
  );
}

// useRootNavigationState re-renders its caller on EVERY navigation state
// change. Keep that subscription in this leaf wrapper so the rest of the
// provider tree doesn't re-render per navigation: AuthProvider is memoized,
// so it only re-renders when navReady actually flips (false -> true, once).
const MemoizedAuthProvider = React.memo(AuthProvider);

function NavReadyAuthProvider({ children }: { children: React.ReactNode }) {
  const navState = useRootNavigationState();
  const navReady = Boolean(navState?.key);
  return <MemoizedAuthProvider navReady={navReady}>{children}</MemoizedAuthProvider>;
}

function RootLayout() {
  const fallbackColorScheme = useColorScheme();
  const _router = useRouter();
  const [loaded] = useFonts({
    SpaceMono: require('../assets/fonts/SpaceMono-Regular.ttf'),
    // Explicitly load icon fonts so iOS doesn't render `?` glyphs for
    // arrow-upward / chat-bubble-outline at small sizes (PostCard StatPill).
    ...MaterialIcons.font,
    ...Ionicons.font,
  });
  const updateCheckInFlight = React.useRef(false);
  const activeAppState = React.useRef(AppState.currentState);

  // Immediately apply any update that finishes downloading mid-session.
  // This fires even if the user never cold-starts the app again.
  const { isUpdatePending } = useUpdates();

  useEffect(() => {
    if (__DEV__ || Platform.OS === 'web' || isExpoGo || !Updates.isEnabled) return;
    if (isUpdatePending) {
      void requestOtaReload();
    }
  }, [isUpdatePending]);

  const syncOtaUpdate = React.useCallback(async () => {
    if (
      __DEV__ ||
      Platform.OS === 'web' ||
      isExpoGo ||
      !Updates.isEnabled ||
      updateCheckInFlight.current
    ) {
      return;
    }

    updateCheckInFlight.current = true;
    try {
      const result = await Updates.checkForUpdateAsync();
      if (!result.isAvailable) {
        updateCheckInFlight.current = false;
        return;
      }
      await Updates.fetchUpdateAsync();
      // reloadAsync restarts the app with the new bundle immediately
      if (!(await requestOtaReload())) updateCheckInFlight.current = false;
    } catch (error) {
      devLog('[updates] OTA sync failed', error);
      captureException(error, { tags: { context: 'ota_sync' } });
      updateCheckInFlight.current = false;
    }
  }, []);

  React.useEffect(() => {
    if (__DEV__) {
      const key = getConfig().stripePublishableKey;
      devLog(
        '[Stripe] publishableKey:',
        key ? `${key.substring(0, 12)}...${key.slice(-4)}` : '(empty)'
      );
    }
  }, []);

  React.useEffect(() => {
    if (!__DEV__) return;
    LogBox.ignoreLogs([
      'Non-serializable values were found in the navigation state',
      'new NativeEventEmitter',
      'Require cycle:',
      'PushNotificationIOS has been extracted',
      'Invariant Violation: `new NativeEventEmitter()',
      'animations-in-inline-styling',
      '[Reanimated] Tried to access',
    ]);
    if (Platform.OS === 'web') {
      LogBox.ignoreLogs([
        '"shadow*" style props are deprecated',
        '"textShadow*" style props are deprecated',
      ]);
    }
  }, []);

  React.useEffect(() => {
    if (Platform.OS !== 'android' || isExpoGo || !Notifications) return;
    Notifications.setNotificationChannelAsync('default', {
      name: 'General',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [250, 250],
      sound: 'default',
      enableVibrate: true,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      lightColor: '#2563EB',
    }).catch(() => {});
  }, []);

  React.useEffect(() => {
    if (Platform.OS === 'web' || isExpoGo || !Notifications?.setNotificationHandler) return;
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: true,
      }),
    });
  }, []);

  // Handle deep links (shared post links, etc.)
  // Public routes (verify, reset-password) navigate immediately.
  // Protected routes (post, game, team, profile) are deferred until AuthProvider
  // confirms the user is authenticated — prevents bypassing onboarding/verification.
  useEffect(() => {
    handleInitialDeepLink(url => {
      handleDeepLinkAuthAware(url);
    }).catch(() => {});
    const unsubscribe = setupDeepLinkListener(url => {
      handleDeepLinkAuthAware(url);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    void syncOtaUpdate();

    const subscription = AppState.addEventListener('change', nextState => {
      captureBreadcrumb('App state changed', 'app.lifecycle', {
        from: activeAppState.current,
        to: nextState,
      });
      const wasBackgrounded = /inactive|background/.test(activeAppState.current);
      activeAppState.current = nextState;
      if (wasBackgrounded && nextState === 'active') {
        void syncOtaUpdate();
      }
    });

    return () => subscription.remove();
  }, [syncOtaUpdate]);

  if (!loaded) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: Colors[fallbackColorScheme ?? 'light'].background,
        }}
      >
        <ActivityIndicator color={Colors[fallbackColorScheme ?? 'light'].tint} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <StripeProvider publishableKey={getConfig().stripePublishableKey}>
            <PersistQueryClientProvider
              client={queryClient}
              persistOptions={{
                persister: asyncStoragePersister,
                // Drop persisted data older than 24h so a stale cold-start
                // never shows day-old content before revalidation.
                maxAge: 24 * 60 * 60 * 1000,
                buster: CACHE_BUSTER,
                dehydrateOptions: {
                  shouldDehydrateQuery: shouldPersistQuery,
                },
              }}
            >
              <PostCacheProvider>
                <NavigationHistoryProvider>
                  <NavReadyAuthProvider>
                    <AdPurchaseProvider>
                      <ThemeProvider>
                        <AppShell />
                      </ThemeProvider>
                    </AdPurchaseProvider>
                  </NavReadyAuthProvider>
                </NavigationHistoryProvider>
              </PostCacheProvider>
            </PersistQueryClientProvider>
          </StripeProvider>
        </GestureHandlerRootView>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}

export default RootLayout;
