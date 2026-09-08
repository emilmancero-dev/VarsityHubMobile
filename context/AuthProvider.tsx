/**
 * AuthProvider - Centralized authentication and routing logic
 *
 * Fixes production issues:
 * - Eliminates competing screen-level auth fetches in _layout, index, and sign-in
 * - Provides single source of truth for auth state
 * - Prevents route flicker and redirect loops
 * - Exposes health check status for offline UX
 * - Unified auth paths: all flows call checkAuth() and let provider handle routing
 * - Email verification: detected and routed centrally; verify-email screen shows user context
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { useRouter, useSegments } from 'expo-router';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { AppState, Platform } from 'react-native';
// @ts-ignore JS exports
import auth from '@/api/auth';
import { User } from '@/api/entities';
import { abortAllInflight, httpGet } from '@/api/http';
import { showWarningToast } from '@/components/ErrorToast';
import { clearPostCacheOnLogout } from '@/context/PostCacheContext';
import { clearPersistedQueryCache } from '@/lib/queryClient';
import { analytics } from '@/utils/analytics';
import { getPostAuthRouteDecision, getRouteFamily } from '@/utils/appRouteDecisions';
import {
  getCanonicalOrganizationId,
  getCanonicalRole,
  hasAcceptedCoachAgreement,
  isOnboardingCompleteSnapshot,
  isProceedingAsFanSnapshot,
} from '@/utils/authState';
import { buildAuthRedirectFingerprint, navigateWithAuthRedirect } from '@/utils/authTelemetry';
import { consumePendingDeepLink, handleDeepLink } from '@/utils/deepLinks';
import Notifications from '@/utils/notifications';
import {
  GUEST_HOME_ROUTE,
  isAuthEntryRouteSegment,
  isPublicRouteSegment,
} from '@/utils/publicRoutes';
import { getCoachAccessState } from '@/utils/roleChecks';
import { captureException, setUserContext as setSentryUser } from '@/utils/sentry';
import { onSessionExpired, type SessionExpiredReason } from '@/utils/sessionEvents';

// Conditionally import notifications only if not in Expo Go
const isExpoGo = Constants.executionEnvironment === 'storeClient';

interface AuthUser {
  id: string;
  email: string;
  email_verified?: boolean;
  username?: string;
  display_name?: string | null;
  avatar_url?: string | null;
  bio?: string | null;
  affiliation?: string | null;
  role?: string;
  account_state?: string;
  next_step?: string | null;
  onboarding_completed?: boolean;
  is_admin?: boolean;
  approval_status?: string;
  rejected_at?: string | null;
  dob?: string | null;
  date_of_birth?: string | null;
  zip_code?: string | null;
  paid_by_owner?: boolean;
  google_id?: string | null;
  apple_id?: string | null;
  has_password?: boolean;
  linked_providers?: {
    password?: boolean;
    google?: boolean;
    apple?: boolean;
  };
  required_coach_agreement_version?: number;
  coach_application?: {
    id: string;
    status: string;
    organization_name?: string;
    org_type?: string | null;
    location?: string | null;
    zip_code?: string | null;
    supporting_document_url?: string | null;
    background_url?: string | null;
  } | null;
  organization_id?: string | null;
  preferences?: {
    onboarding_completed?: boolean;
    role?: string;
    plan?: string;
    pending_plan?: string;
    payment_pending?: boolean;
    payment_approved?: boolean;
    join_request_pending?: boolean;
    proceeding_as_fan?: boolean;
    coach_agreement_accepted_at?: string;
    coach_agreement_version?: number;
    organization_id?: string;
    zip_code?: string;
  };
}

export interface AuthContextType {
  user: AuthUser | null;
  hasSession: boolean;
  pendingVerificationEmail: string | null;
  loading: boolean;
  healthOk: boolean;
  healthError: string | null;
  isAdmin: boolean;
  subscriptionTier: string;
  hasActiveSubscription: boolean;
  checkAuth: (options?: {
    email?: string;
    pendingVerification?: boolean;
    replaceSession?: boolean;
    skipSubscriptionRefresh?: boolean;
    forceRefresh?: boolean;
  }) => Promise<any>;
  signOut: () => Promise<void>;
  registerPushToken: () => Promise<boolean>;
  markOnboardingCompleteLocally: () => Promise<void>;
  markOnboardingIncompleteLocally: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}

interface AuthProviderProps {
  children: React.ReactNode;
  navReady: boolean;
}

export function AuthProvider({ children, navReady }: AuthProviderProps) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [hasSession, setHasSession] = useState(false);
  const [pendingVerificationEmail, setPendingVerificationEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [healthOk, setHealthOk] = useState(true);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [routingReady, setRoutingReady] = useState(navReady);
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState<boolean>(false);
  const [subscriptionTier, setSubscriptionTier] = useState<string>('rookie');
  const [hasActiveSubscription, setHasActiveSubscription] = useState<boolean>(false);

  const ONBOARDING_COMPLETE_KEY = '@onboarding_completed_once';
  const ONBOARDING_COMPLETE_USER_KEY = '@onboarding_completed_user_id';
  const LAST_ONBOARDING_USER_KEY = '@last_onboarding_user_id';

  const router = useRouter();
  const segments = useSegments();
  const unauthenticatedEntryRoute = GUEST_HOME_ROUTE;
  const currentPath =
    Array.isArray(segments) && segments.length
      ? segments.map(segment => String(segment)).join('/')
      : '';

  const lastRedirectRef = React.useRef<string | null>(null);
  const recentRedirectsRef = React.useRef<Array<{ family: string; to: string; ts: number }>>([]);
  const segmentsRef = React.useRef(segments);
  const bootstrapStartedRef = React.useRef(false);
  // One-time flag: fires on the first routing check after bootstrap completes.
  // If Expo Router restores navigation state to sign-in from a previous session,
  // an unauthenticated guest would be stuck there. This catches that case and
  // redirects to the open feed instead.
  const startupSignInRestoreCheckedRef = React.useRef(false);
  // Guard against multiple in-flight coach-role restores triggered by repeated
  // effect runs. Cleared in the async block's finally.
  const restoringCoachRef = React.useRef(false);
  // Tracks whether THIS session has already failed the restore. Without it,
  // a failed restore (server still returns role=fan) would re-enter the
  // restore branch on every effect re-run because the trigger condition
  // hasn't changed. Cleared on sign-out (the user object goes null →
  // component cycle resets refs).
  const restoreCoachFailedThisSessionRef = React.useRef(false);

  // Bumped when a redirect appears to have been dropped, to force the routing
  // effect to re-evaluate and retry.
  const [redirectRetryTick, setRedirectRetryTick] = useState(0);

  // Track the concrete route path. Redirect suppression must reset when the
  // router actually moves; otherwise one dropped replace() can suppress every
  // future retry and strand the user on the passive root spinner.
  React.useEffect(() => {
    segmentsRef.current = segments;
    if (!lastRedirectRef.current) return;

    const normalizedTarget = lastRedirectRef.current.replace(/^\//, '');
    if (
      currentPath === normalizedTarget ||
      (currentPath !== '' && currentPath !== normalizedTarget)
    ) {
      lastRedirectRef.current = null;
      return;
    }

    // currentPath is still '' — the replace() was likely dropped before the
    // router was actually ready (the routingReady 2s fallback fires whether or
    // not navigation is mounted). Neither reset branch above can fire in that
    // state, so without this retry the suppression ref pins the user on the
    // passive root spinner forever. Clear it after a grace period and bump the
    // tick so the routing effect re-runs and re-issues the redirect.
    const retry = setTimeout(() => {
      if (lastRedirectRef.current) {
        if (__DEV__) {
          console.warn('[AuthProvider] Redirect appears dropped, retrying:', {
            target: lastRedirectRef.current,
          });
        }
        lastRedirectRef.current = null;
        setRedirectRetryTick(tick => tick + 1);
      }
    }, 1200);
    return () => clearTimeout(retry);
  }, [currentPath, segments]);

  // Expo Router readiness can lag or fail to surface a stable key on some cold
  // iOS starts. Do not let that pin the app on the root spinner forever.
  React.useEffect(() => {
    if (navReady) {
      setRoutingReady(true);
      return;
    }

    const timeout = setTimeout(() => {
      if (__DEV__) {
        console.warn('[AuthProvider] Navigation readiness timeout - allowing routing fallback');
      }
      setRoutingReady(true);
    }, 2000);

    return () => clearTimeout(timeout);
  }, [navReady]);

  // Derived state
  const normalizedRole = String(user?.role || '').toLowerCase();
  const isAdmin =
    user?.email_verified === true && (normalizedRole === 'super_admin' || user?.is_admin === true);
  const isOnboardingComplete = useCallback(
    (authUser: AuthUser | null | undefined) => isOnboardingCompleteSnapshot(authUser as any),
    []
  );

  // Check backend health (once on startup)
  const checkHealth = useCallback(async () => {
    try {
      // Health should answer quickly; a single retry absorbs transient
      // client-side failures (e.g. RN's "Unable to resolve data for blob"
      // response-read race) without wedging the whole app into offline mode.
      await httpGet('/health', {}, 5000, 1);
      setHealthOk(true);
      setHealthError(null);
      return true;
    } catch (err: any) {
      setHealthOk(false);
      if (__DEV__) console.warn('[AuthProvider] Health check failed:', err?.message);
      // Never store the raw transport error — it can contain internals (blob
      // registry ids, the origin API URL) that must not reach any UI surface.
      setHealthError('API unreachable');
      return false;
    }
  }, []);

  const lastPushRegistrationRef = React.useRef<string | null>(null);

  // Register for push notifications
  const setupPushNotifications = useCallback(async (userId: string) => {
    if (!userId) return false;

    // Skip push notifications in Expo Go
    if (isExpoGo || !Notifications) {
      if (__DEV__) console.log('[PushNotifications] Skipping setup in Expo Go environment');
      return false;
    }

    if (!Device.isDevice) {
      if (__DEV__) console.log('[PushNotifications] Skipping setup on simulator/emulator');
      return false;
    }
    if (lastPushRegistrationRef.current === userId) {
      // Already registered for this user during this session
      return true;
    }

    try {
      // 1. Check existing permissions
      let permissions = await Notifications.getPermissionsAsync();
      if (permissions.status !== 'granted') {
        permissions = await Notifications.requestPermissionsAsync();
      }

      if (permissions.status !== 'granted') {
        if (__DEV__) console.log('[PushNotifications] Permission denied by user');
        return false;
      }

      // 2. Get project ID from app config
      let projectId = null;
      try {
        const appJson = require('../app.json');
        projectId = appJson?.expo?.extra?.eas?.projectId;
      } catch {
        if (__DEV__) console.error('[PushNotifications] Could not load app.json for projectId');
      }

      if (!projectId) {
        if (__DEV__) console.error('[PushNotifications] EXPO_PROJECT_ID not found in app.json');
        return false;
      }

      // 3. Get Expo push token
      const tokenData = await Notifications.getExpoPushTokenAsync({
        projectId: projectId,
      });

      const token = tokenData.data;
      if (__DEV__) {
        // Defensive: token MIGHT be null/undefined on failed registration —
        // tokenData.data is typed as string but in practice the SDK can
        // hand back null on Expo push service issues. Avoid throwing in the
        // dev-log path.
        const preview = typeof token === 'string' ? `${token.substring(0, 30)}...` : '<missing>';
        console.log('[PushNotifications] Got push token:', preview);
      }
      if (typeof token !== 'string' || token.length === 0) {
        if (__DEV__)
          console.warn('[PushNotifications] Empty push token from Expo SDK; skipping save');
        return false;
      }

      // 4. Save token to backend (with retry on failure)
      const saveToken = async (attempt = 1): Promise<void> => {
        try {
          await User.updatePreferences({ push_token: token, notifications_enabled: true });
          if (__DEV__) console.log('[PushNotifications] Push token saved to backend');
          lastPushRegistrationRef.current = userId;
        } catch (err) {
          if (attempt < 3) {
            await new Promise(r => setTimeout(r, attempt * 3000));
            return saveToken(attempt + 1);
          }
          throw err;
        }
      };
      await saveToken();
      return true;
    } catch (error: any) {
      if (__DEV__) console.error('[PushNotifications] Failed to setup:', error?.message || error);
      // Don't block app - push notifications are optional
      return false;
    }
  }, []);

  // Fetch subscription status
  const fetchSubscription = useCallback(async () => {
    try {
      const data = await httpGet('/payments/subscription/summary');
      if (data && typeof data === 'object') {
        setSubscriptionTier(data.plan || data.tier || 'rookie');
        setHasActiveSubscription(data.plan !== 'rookie' && data.status === 'active');
      }
    } catch {
      // Non-critical — keep defaults
    }
  }, []);

  // v1.0.2: refs for deferred push registration (must be before checkAuth).
  const registerPushTokenRef = React.useRef<(() => Promise<boolean>) | null>(null);
  const pushTokenTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const subscriptionFetchTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearLocalAuthState = useCallback((options?: { abortInflight?: boolean }) => {
    if (pushTokenTimeoutRef.current) {
      clearTimeout(pushTokenTimeoutRef.current);
      pushTokenTimeoutRef.current = null;
    }
    if (subscriptionFetchTimeoutRef.current) {
      clearTimeout(subscriptionFetchTimeoutRef.current);
      subscriptionFetchTimeoutRef.current = null;
    }
    // Cancel every in-flight HTTP request and drop the GET dedup cache.
    // Without this, a request initiated under user A's token can resolve
    // after user B signs in on the same device, and any still-mounted
    // subscriber (or the GET-dedup cache) could observe user A's response.
    // AbortController cancellation causes fetch() to throw AbortError so
    // the resolution path never delivers the body.
    if (options?.abortInflight !== false) {
      abortAllInflight('sign_out_or_session_expiry');
    }
    clearPostCacheOnLogout();
    setUser(null);
    setHasSession(false);
    setSentryUser(null);
    analytics.reset();
    setPendingVerificationEmail(null);
    setHasCompletedOnboarding(false);
    setSubscriptionTier('rookie');
    setHasActiveSubscription(false);
    lastPushRegistrationRef.current = null;
  }, []);

  const clearUserScopedStorage = useCallback(async () => {
    const baseKeys = [
      ONBOARDING_COMPLETE_KEY,
      ONBOARDING_COMPLETE_USER_KEY,
      LAST_ONBOARDING_USER_KEY,
      'onboarding_state',
      'onboarding_progress',
      'onboarding_reducer_state',
    ];

    try {
      const allKeys = await AsyncStorage.getAllKeys();
      const userScopedKeys = allKeys.filter(
        key =>
          key.startsWith('vh_settings_') ||
          key === 'vh_recent_searches' ||
          key.startsWith('team_messages_') ||
          (key.startsWith('team-') && key.endsWith('-files'))
      );

      const keysToRemove = Array.from(new Set([...baseKeys, ...userScopedKeys]));
      if (keysToRemove.length > 0) {
        await AsyncStorage.multiRemove(keysToRemove);
      }
    } catch (storageErr) {
      if (__DEV__) console.warn('[AuthProvider] Failed to clear user-scoped storage:', storageErr);
    }
  }, []);

  // Check authentication
  const checkAuth = useCallback(
    async (options?: {
      email?: string;
      pendingVerification?: boolean;
      skipSubscriptionRefresh?: boolean;
      replaceSession?: boolean;
      forceRefresh?: boolean;
    }) => {
      try {
        // If pending verification flag is set, store email and don't try to fetch user
        if (options?.pendingVerification && options?.email) {
          setHasSession(true);
          setPendingVerificationEmail(options.email);
          setUser(null); // Don't set user until verification succeeds
          return;
        }

        // Recover a stale offline state before the auth flow makes routing
        // decisions. Without this, OfflineBanner retry and post-login
        // checkAuth calls can succeed server-side while `healthOk` remains
        // false, leaving redirects permanently suppressed.
        if (!healthOk) {
          await checkHealth();
        }

        // Try to fetch current user only if we have a token
        const token = await auth.getToken();
        if (!token) {
          // Startup/bootstrap can legitimately race with auth-establishing
          // requests like sign-in/sign-up on web. Clearing local auth state is
          // correct here, but aborting every in-flight request would cancel the
          // very registration/login call that is about to establish the token.
          clearLocalAuthState({ abortInflight: false });
          return;
        }

        const previousUserId = user?.id ?? null;
        if (options?.replaceSession) {
          // A fresh sign-in replaced the token on this device. Clear any old
          // in-memory identity first so user A cannot bleed into user B if the
          // subsequent /me refresh fails or resolves slowly.
          clearLocalAuthState();
        }
        setHasSession(true);

        // Most checkAuth callers are navigation/focus guards and can reuse the
        // short-lived /me cache. Force a network refresh only for auth-critical
        // transitions such as new session establishment.
        const shouldForceRefresh =
          options?.forceRefresh === true || options?.replaceSession === true;
        const me: any = await User.me(shouldForceRefresh ? { force: true } : undefined);
        setHealthOk(true);
        setHealthError(null);

        // If user is banned, clear session and redirect to sign-in
        if (me?.banned) {
          clearLocalAuthState();
          try {
            await auth.logout();
          } catch (error) {
            captureException(error, { tags: { context: 'auth_logout_after_ban_failed' } });
          }
          return;
        }

        const serverComplete = isOnboardingComplete(me);

        // Sync local onboarding flag BEFORE setUser to prevent routing race condition.
        // The routing effect fires when `user` changes — if hasCompletedOnboarding is
        // stale from a different account, needsOnboarding evaluates wrong for one cycle.
        if (serverComplete) {
          setHasCompletedOnboarding(true);
          await AsyncStorage.setItem(ONBOARDING_COMPLETE_KEY, 'true');
          await AsyncStorage.setItem(ONBOARDING_COMPLETE_USER_KEY, me.id);
        } else {
          // Server says incomplete — clear local flag regardless of who it belonged to
          setHasCompletedOnboarding(false);
          await AsyncStorage.removeItem(ONBOARDING_COMPLETE_KEY);
          await AsyncStorage.removeItem(ONBOARDING_COMPLETE_USER_KEY);
        }

        // Clear stale onboarding context data whenever the authed identity does
        // not match the last identity that touched onboarding storage. Runs
        // regardless of serverComplete because the keys are user-scoped — a
        // returning fan should never inherit a previous coach's draft, even if
        // the new account is already onboarded and never opens /onboarding.
        if (me?.id) {
          const lastUserId = await AsyncStorage.getItem(LAST_ONBOARDING_USER_KEY);
          if (lastUserId && lastUserId !== me.id) {
            if (__DEV__)
              console.log('[AuthProvider] Account changed — clearing stale onboarding data');
            await AsyncStorage.multiRemove([
              'onboarding_state',
              'onboarding_progress',
              'onboarding_reducer_state',
            ]);
          }
          await AsyncStorage.setItem(LAST_ONBOARDING_USER_KEY, me.id);
        }

        if (options?.replaceSession && previousUserId && previousUserId !== me.id) {
          // User identity changed on this device without a clean sign-out path.
          // Drop any user-scoped local data so the new account does not inherit
          // the prior account's drafts, settings caches, or onboarding state.
          analytics.reset();
          await clearUserScopedStorage();
        }

        // NOW set user — routing effect will fire with correct hasCompletedOnboarding
        setUser(me);
        setSentryUser({ id: me.id, email: me.email, username: me.username });
        analytics.identify(me.id, {
          email: me.email,
          username: me.username,
          role: me.role,
          plan: me.preferences?.plan,
          organization_id: getCanonicalOrganizationId(me as any),
          is_admin: me.is_admin,
          is_verified: Boolean(me.email_verified || me.verified || me.is_verified),
          has_completed_onboarding: serverComplete,
          onboarding_completed: me.onboarding_completed,
        });
        setPendingVerificationEmail(null);

        // Stagger non-critical subscription refresh so auth/bootstrap requests do not fan out at once.
        if (!options?.skipSubscriptionRefresh) {
          if (subscriptionFetchTimeoutRef.current)
            clearTimeout(subscriptionFetchTimeoutRef.current);
          subscriptionFetchTimeoutRef.current = setTimeout(() => {
            subscriptionFetchTimeoutRef.current = null;
            fetchSubscription().catch(e =>
              captureException(e, { tags: { context: 'subscription_fetch' } })
            );
          }, 750);
        }

        // v1.0.2: register push token after successful checkAuth; signOut clears the timeout.
        if (isOnboardingComplete(me)) {
          if (pushTokenTimeoutRef.current) clearTimeout(pushTokenTimeoutRef.current);
          pushTokenTimeoutRef.current = setTimeout(() => {
            pushTokenTimeoutRef.current = null;
            registerPushTokenRef.current?.().catch(e => {
              if (__DEV__)
                console.warn('[AuthProvider] checkAuth push token register failed:', e?.message);
            });
          }, 500);
        }

        return me;
      } catch (err: any) {
        if (options?.replaceSession) {
          clearLocalAuthState();
          throw err;
        }
        // Only clear auth state on explicit unauthorized responses.
        // For transient network/server errors, preserve the existing session.
        if (err?.status === 401) {
          clearLocalAuthState();
          throw err; // Rethrow 401 so callers (sign-in, sign-up) can handle it
        }
        if (__DEV__)
          console.error('[AuthProvider] checkAuth transient error (session preserved):', err);
        return null; // Don't crash the app on transient network/server errors
      }
    },
    [
      checkHealth,
      clearLocalAuthState,
      clearUserScopedStorage,
      fetchSubscription,
      healthOk,
      isOnboardingComplete,
      user?.id,
    ]
  );

  const checkAuthRef = React.useRef(checkAuth);
  React.useEffect(() => {
    checkAuthRef.current = checkAuth;
  }, [checkAuth]);

  const redirectWithTelemetry = useCallback(
    (to: string, reason: string, userSnapshot?: AuthUser | null) => {
      const from =
        Array.isArray(segmentsRef.current) && segmentsRef.current.length
          ? segmentsRef.current.join('/')
          : 'index';
      const effectiveUser = userSnapshot ?? user;
      const role = String(getCanonicalRole(effectiveUser as any) || '').trim() || null;
      const approvalStatus =
        typeof effectiveUser?.approval_status === 'string' ? effectiveUser.approval_status : null;
      const onboardingCompleted = isOnboardingComplete(effectiveUser);
      const emailVerified = effectiveUser?.email_verified === true;
      const pendingVerification = !!pendingVerificationEmail;
      const paidByOwner = effectiveUser?.paid_by_owner === true;
      const proceedingAsFan = isProceedingAsFanSnapshot(effectiveUser as any);
      const coachAgreementAccepted = hasAcceptedCoachAgreement(effectiveUser as any);
      const userStateFingerprint = buildAuthRedirectFingerprint({
        from,
        role,
        approvalStatus,
        onboardingCompleted,
        emailVerified,
        pendingVerification,
        healthOk,
        paidByOwner,
        proceedingAsFan,
        coachAgreementAccepted,
      });

      const now = Date.now();
      const family = getRouteFamily(to);
      recentRedirectsRef.current = recentRedirectsRef.current.filter(
        entry => now - entry.ts <= 30000
      );
      const recentFamilyRedirects = recentRedirectsRef.current.filter(
        entry => entry.family === family
      );
      // Session-expiry AND sign-out are TERMINAL redirects to the unauthenticated
      // entry route, not loops — the tokens are already cleared, so each fires at
      // most once (the sessionEvents bus also dedupes). Neither may be suppressed
      // by the routing-loop guard: the unauthenticated entry route is `/(tabs)/feed`,
      // whose family (`tabs`) is the hottest redirect bucket in the app, so a
      // couple of prior tabs redirects in the last 30s would otherwise swallow it.
      // When it's swallowed the destination screen never unmounts, and api/http.ts's
      // intentional never-resolving Promise (the anti-Alert-stacking design) hangs
      // forever — a permanent spinner on e.g. the ad-calendar payment button, only
      // recoverable by force-quit. Exempting these reasons guarantees the unmount
      // that makes that hang safe. (sign_out was originally assumed safe because it
      // unmounts via its own button, but production telemetry — VARSITYHUB-3A,
      // reason:sign_out, route_family:tabs, to:/(tabs)/feed — showed the guard IS
      // swallowing sign-out redirects when the tabs bucket is already hot, so it is
      // exempted here on the same terminal-redirect grounds.)
      const isTerminalSessionRedirect =
        reason.startsWith('session_expired') || reason.startsWith('sign_out');
      if (!isTerminalSessionRedirect && recentFamilyRedirects.length >= 2) {
        captureException(new Error('routing_loop_detected'), {
          tags: {
            context: 'routing_loop_detected',
            route_family: family,
          },
          from,
          to,
          reason,
          userStateFingerprint,
          recentTargets: recentFamilyRedirects.map(entry => entry.to),
        });
        if (__DEV__) {
          console.warn('[AuthProvider] Routing loop detected, suppressing redirect:', {
            family,
            to,
            reason,
          });
        }
        return false;
      }

      navigateWithAuthRedirect(router, {
        from,
        to,
        reason,
        userStateFingerprint,
        userId: effectiveUser?.id || null,
        role,
        approvalStatus,
        onboardingCompleted,
        emailVerified,
        pendingVerification,
        healthOk,
        paidByOwner,
        proceedingAsFan,
        coachAgreementAccepted,
      });

      recentRedirectsRef.current.push({ family, to, ts: now });
      lastRedirectRef.current = to;
      return true;
    },
    [healthOk, isOnboardingComplete, pendingVerificationEmail, router, user]
  );

  // Sign out
  const signOut = useCallback(async () => {
    const userBeforeSignOut = user;
    try {
      await auth.logout();
    } catch (error) {
      if (__DEV__) console.warn('[auth] Failed to clear persisted session during sign out:', error);
    } finally {
      clearLocalAuthState();
      await clearUserScopedStorage();
      // Wipe the persisted react-query cache so one account's feed/profile
      // data can never rehydrate into the next session on a shared device.
      await clearPersistedQueryCache();
      redirectWithTelemetry(unauthenticatedEntryRoute, 'sign_out', userBeforeSignOut);
    }
  }, [
    clearLocalAuthState,
    clearUserScopedStorage,
    redirectWithTelemetry,
    unauthenticatedEntryRoute,
    user,
  ]);

  const registerPushToken = useCallback(async () => {
    if (!user?.id) return false;
    return setupPushNotifications(user.id);
  }, [setupPushNotifications, user?.id]);

  /**
   * Handle an unrecoverable session expiry signalled from the HTTP layer.
   * The tokens have already been cleared by api/http.ts or api/upload.ts,
   * so this path deliberately skips `auth.logout()` (which would hit the
   * server with the now-missing refresh token and fail). It just clears
   * local state and routes to the guest entry route so dead sessions do
   * not strand browse-mode users on sign-in.
   */
  const handleSessionExpired = useCallback(
    async (reason: SessionExpiredReason) => {
      const userBeforeExpiry = user;
      const currentPath = Array.isArray(segmentsRef.current) ? segmentsRef.current.join('/') : '';
      const isAuthEntryScreen =
        currentPath === 'sign-in' ||
        currentPath.startsWith('sign-in/') ||
        currentPath === 'sign-up' ||
        currentPath.startsWith('sign-up/');
      clearLocalAuthState();
      await clearUserScopedStorage();
      await clearPersistedQueryCache();
      // Only surface a message if the user was actually signed in — a
      // missing refresh token during a background bootstrap doesn't need
      // a toast ("you were never really signed in").
      if (userBeforeExpiry && !isAuthEntryScreen) {
        try {
          showWarningToast('Your session expired. Please sign in again.');
        } catch {}
      }
      redirectWithTelemetry(
        unauthenticatedEntryRoute,
        `session_expired:${reason}`,
        userBeforeExpiry
      );
    },
    [
      clearLocalAuthState,
      clearUserScopedStorage,
      redirectWithTelemetry,
      unauthenticatedEntryRoute,
      user,
    ]
  );

  useEffect(() => {
    const unsubscribe = onSessionExpired(reason => {
      void handleSessionExpired(reason).catch(err =>
        captureException(err, { tags: { context: 'session_expired_handler' } })
      );
    });
    return unsubscribe;
  }, [handleSessionExpired]);

  React.useEffect(() => {
    registerPushTokenRef.current = registerPushToken;
  }, [registerPushToken]);

  const markOnboardingCompleteLocally = useCallback(async () => {
    try {
      setHasCompletedOnboarding(true);
      await AsyncStorage.setItem(ONBOARDING_COMPLETE_KEY, 'true');
      if (user?.id) {
        await AsyncStorage.setItem(ONBOARDING_COMPLETE_USER_KEY, user.id);
      }
    } catch (error) {
      if (__DEV__) console.warn('[Auth] Failed to persist onboarding completion flag:', error);
    }
  }, [user?.id]);

  const markOnboardingIncompleteLocally = useCallback(async () => {
    try {
      setHasCompletedOnboarding(false);
      await AsyncStorage.removeItem(ONBOARDING_COMPLETE_KEY);
      await AsyncStorage.removeItem(ONBOARDING_COMPLETE_USER_KEY);
    } catch (error) {
      if (__DEV__) console.warn('[Auth] Failed to clear onboarding completion flag:', error);
    }
  }, []);

  // Initial auth/bootstrap check. This must not depend on router readiness:
  // auth state and API health can be resolved before Expo Router publishes a
  // stable nav tree, and coupling them creates a cold-start race.
  useEffect(() => {
    let mounted = true;
    if (bootstrapStartedRef.current) return;
    bootstrapStartedRef.current = true;
    if (__DEV__) console.log('[AuthProvider] Starting auth bootstrap');

    (async () => {
      // Clear stale tokens and probe backend health in parallel so startup doesn't
      // serialize SecureStore/AsyncStorage work ahead of the first network check.
      if (__DEV__) console.log('[AuthProvider] Checking backend health...');
      const [healthy, freshInstallCleanup] = await Promise.all([
        checkHealth(),
        import('@/api/auth').then(({ clearStaleTokensOnFreshInstall }) =>
          clearStaleTokensOnFreshInstall()
        ),
      ]);
      if (__DEV__) console.log('[AuthProvider] Health check result:', healthy);

      if (!mounted) return;

      // If backend is down, we can't authenticate.
      if (!healthy) {
        if (__DEV__) console.log('[AuthProvider] Backend unhealthy, stopping initialization');
        setLoading(false);
        setInitializing(false);
        // Don't redirect - let user see offline banner
        return;
      }

      if (freshInstallCleanup?.ok === false) {
        clearLocalAuthState();
        captureException(new Error('fresh_install_token_cleanup_failed'), {
          tags: {
            context: 'fresh_install_token_cleanup_failed',
          },
          freshInstall: freshInstallCleanup.freshInstall,
          error:
            freshInstallCleanup.error instanceof Error
              ? freshInstallCleanup.error.message
              : String(freshInstallCleanup.error || 'unknown_error'),
        });
        if (__DEV__) {
          console.warn(
            '[AuthProvider] Fresh-install token cleanup failed; skipping persisted-session bootstrap'
          );
        }
        setLoading(false);
        setInitializing(false);
        return;
      }

      // One-time: upgrade already-stored Keychain tokens to AFTER_FIRST_UNLOCK.
      // A plain re-write can't change the accessibility of an existing item
      // (expo-secure-store's update path ignores it), so existing sessions need
      // an explicit delete→re-add. Best-effort; must not block bootstrap.
      await import('@/api/auth')
        .then(({ migrateKeychainAccessibility }) => migrateKeychainAccessibility())
        .catch(() => {});

      if (__DEV__) console.log('[AuthProvider] Checking authentication...');
      try {
        await checkAuthRef.current();
        if (__DEV__) console.log('[AuthProvider] Auth check successful');
      } catch (err: any) {
        if (__DEV__)
          console.log('[AuthProvider] Auth check failed (user not logged in):', err.message);
        // Auth failed - user not logged in
        // Don't redirect here - let the routing logic below handle it
      } finally {
        if (mounted) {
          if (__DEV__) console.log('[AuthProvider] Initialization complete');
          setLoading(false);
          setInitializing(false);
        }
      }
    })();

    return () => {
      mounted = false;
    };
  }, [checkHealth]);

  // Re-check auth when app comes to foreground (debounced to prevent rapid-fire)
  const lastForegroundCheckRef = React.useRef<number>(0);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'active' && !initializing) {
        const now = Date.now();
        // Skip if we checked less than 5 seconds ago (prevents infinite loop from rapid foreground events)
        if (now - lastForegroundCheckRef.current < 5000) return;
        lastForegroundCheckRef.current = now;
        checkAuthRef
          .current()
          .catch(e => captureException(e, { tags: { context: 'foreground_auth_refresh' } }));
      }
    });
    return () => {
      subscription.remove();
      if (subscriptionFetchTimeoutRef.current) {
        clearTimeout(subscriptionFetchTimeoutRef.current);
        subscriptionFetchTimeoutRef.current = null;
      }
    };
  }, [fetchSubscription, initializing]);

  // Periodic health re-check while the backend is known unhealthy. Recovery
  // otherwise depends entirely on a NetInfo connectivity event, the
  // OfflineBanner Retry button, or the app coming to the foreground — on a
  // congested venue network none of those may fire for a while, leaving the
  // "unable to connect" banner stuck long after the API is reachable again.
  // Runs every ~20s and stops itself the moment healthOk flips true; inert
  // (no timer at all) whenever healthOk is already true.
  useEffect(() => {
    if (healthOk) return;
    const interval = setInterval(() => {
      checkHealth().catch(() => {});
    }, 20000);
    return () => clearInterval(interval);
  }, [healthOk, checkHealth]);

  // Safety timeout - force initialization complete after 5 seconds
  useEffect(() => {
    const timeout = setTimeout(() => {
      if (initializing) {
        if (__DEV__)
          console.warn('[AuthProvider] ⚠️ Initialization timeout (5s) - forcing completion');
        setLoading(false);
        setInitializing(false);
      }
    }, 5000);

    return () => clearTimeout(timeout);
  }, [initializing]);

  // Load onboarding completion flag from AsyncStorage once on mount
  useEffect(() => {
    let mounted = true;
    const timeout = setTimeout(() => {
      if (mounted) {
        if (__DEV__) console.warn('[Auth] AsyncStorage timeout - assuming onboarding incomplete');
        setHasCompletedOnboarding(false);
      }
    }, 2000);

    (async () => {
      try {
        const [storedValue, storedUserId] = await AsyncStorage.multiGet([
          ONBOARDING_COMPLETE_KEY,
          ONBOARDING_COMPLETE_USER_KEY,
        ]);
        clearTimeout(timeout);
        if (mounted) {
          const flagValue = storedValue[1] === 'true';
          const hasUserId = !!storedUserId[1];
          // Only trust the flag if it has a user ID (will be validated in checkAuth)
          // Flags without a user ID are legacy/stale — ignore them
          setHasCompletedOnboarding(flagValue && hasUserId);
        }
      } catch (error) {
        clearTimeout(timeout);
        if (__DEV__) console.warn('[Auth] Failed to load onboarding flag from storage:', error);
      }
    })();

    return () => {
      mounted = false;
      clearTimeout(timeout);
    };
  }, []);

  // Routing logic (runs after auth check completes)
  useEffect(() => {
    if (initializing) {
      if (__DEV__) console.log('[AuthProvider] Still initializing, skipping routing');
      return;
    }

    // Startup race fix: auth bootstrap can finish before Expo Router reports a
    // stable navigation state. If we fire router.replace(...) before nav is
    // actually ready, the redirect can be dropped and the passive root spinner
    // never gets another chance to reroute. Wait explicitly for navReady and
    // re-run this effect when it flips true.
    if (!routingReady) {
      if (__DEV__) console.log('[AuthProvider] Routing gate not ready, deferring routing');
      return;
    }

    const firstSegment =
      Array.isArray(segmentsRef.current) && segmentsRef.current.length
        ? String(segmentsRef.current[0])
        : '';
    const isRootIndex = currentPath === '';
    const isPublic = isPublicRouteSegment(firstSegment);

    // STARTUP RESTORATION FIX: Expo Router can restore navigation state from
    // the previous session. If the user was last on sign-in, segments are
    // restored to ['sign-in'] → isPublic=true → the unauthenticated redirect
    // check below never fires → guest is stuck on the sign-in screen.
    // BUG FIX: Only mark as done once firstSegment is non-empty — if we mark it
    // done while firstSegment==='' (nav not yet restored), the actual sign-in
    // restoration fires after the flag is already set and gets skipped.
    if (!startupSignInRestoreCheckedRef.current && firstSegment !== '') {
      startupSignInRestoreCheckedRef.current = true;
      if (
        !user &&
        !pendingVerificationEmail &&
        (firstSegment === 'sign-in' || firstSegment === 'sign-up')
      ) {
        if (__DEV__)
          console.log(
            '[AuthProvider] Startup: nav restored to auth screen, redirecting guest to feed'
          );
        redirectWithTelemetry(unauthenticatedEntryRoute, 'startup_signin_restore');
        return;
      }
    }

    if (__DEV__)
      console.log(
        '[AuthProvider] Routing check - segment:',
        firstSegment,
        'user:',
        !!user,
        'pendingVerif:',
        !!pendingVerificationEmail
      );

    // If user is awaiting email verification, navigate to the canonical verify
    // screen. /verify-email remains as a compatibility alias only.
    if (pendingVerificationEmail && firstSegment !== 'verify' && firstSegment !== 'verify-email') {
      // Belt-and-suspenders: if we have a pending email but no user, check the
      // stored token asynchronously. If the token is gone, the verification
      // flow is stale — clear it. setState triggers this effect to re-run,
      // which then falls through to unauthenticated routing (→ /sign-in).
      if (!user) {
        void (async () => {
          const storedToken = await auth.getToken().catch(() => null);
          if (!storedToken) {
            if (__DEV__)
              console.log(
                '[AuthProvider] Stale pendingVerificationEmail — no user or token, clearing'
              );
            setPendingVerificationEmail(null);
          }
        })();
      }
      if (lastRedirectRef.current !== '/verify') {
        redirectWithTelemetry('/verify', 'pending_verification');
      }
      return;
    }

    // Authenticated routing
    if (user) {
      // If user hasn't verified their email, redirect to verify screen
      // This prevents unverified users from accessing protected features (e.g. creating posts)
      // that the server's requireVerified middleware would reject with 403
      const verifyRoutes = new Set(['verify', 'verify-email', 'verify-identity']);
      if (user.email_verified !== true && !verifyRoutes.has(firstSegment)) {
        if (__DEV__) console.log('[AuthProvider] User email not verified, redirecting to verify');
        if (lastRedirectRef.current !== '/verify') {
          redirectWithTelemetry('/verify', 'email_not_verified');
        }
        return;
      }

      const coachAccess = getCoachAccessState(user);
      const postAuthDecision = getPostAuthRouteDecision(user, {
        pendingVerification: !!pendingVerificationEmail,
      });
      const accountState = String(user.account_state || '').trim();
      const explicitNextStep =
        typeof user.next_step === 'string' && user.next_step.trim().startsWith('/')
          ? user.next_step.trim()
          : null;
      const normalizedExplicitNextStep = explicitNextStep?.replace(/^\//, '') || '';
      const isOnExplicitNextStep =
        !!normalizedExplicitNextStep &&
        (currentPath === normalizedExplicitNextStep ||
          currentPath.startsWith(`${normalizedExplicitNextStep}/`));

      if (
        explicitNextStep &&
        postAuthDecision.kind.startsWith('server_') &&
        explicitNextStep !== '/(tabs)' &&
        !coachAccess.isProceedingAsFan &&
        !isOnExplicitNextStep
      ) {
        if (lastRedirectRef.current !== explicitNextStep) {
          redirectWithTelemetry(explicitNextStep, `server_next_step:${accountState}`);
        }
        return;
      }

      // Approved coach who was browsing as fan — restore coach role in-place.
      // When a coach taps "Continue as Fan", role is saved as 'fan' with proceeding_as_fan=true.
      // Once the org is approved, we must flip them back to coach without
      // introducing another post-approval gate.
      if (coachAccess.isApprovedCoach && isProceedingAsFanSnapshot(user as any)) {
        // Fire-and-forget restore (the effect callback is sync, so we can't await).
        // Two refs prevent two distinct loops:
        //   restoringCoachRef — in-flight guard, prevents concurrent calls
        //   restoreCoachFailedThisSessionRef — once-per-session failure gate.
        //     Without this, a failed updatePreferences (server still says
        //     role=fan) leaves the trigger condition unchanged, so the next
        //     effect re-run would re-attempt indefinitely. The session-level
        //     gate breaks that loop; the user can retry by signing out and
        //     back in or by an explicit retry CTA on coach-agreement.
        if (!restoringCoachRef.current && !restoreCoachFailedThisSessionRef.current) {
          restoringCoachRef.current = true;
          void (async () => {
            try {
              await User.updatePreferences({ proceeding_as_fan: false, role: 'coach' });
              setUser(prev =>
                prev
                  ? {
                      ...prev,
                      preferences: { ...prev.preferences, proceeding_as_fan: false, role: 'coach' },
                    }
                  : prev
              );
              // Successful restore — leave the failure flag clear so a
              // future re-entry (after another sign-out cycle, etc.) gets
              // a fresh attempt.
            } catch (err: any) {
              if (__DEV__)
                console.warn('[AuthProvider] Failed to restore coach role:', err?.message);
              captureException(err, { tags: { context: 'fan_to_coach_restore' } });
              restoreCoachFailedThisSessionRef.current = true;
            } finally {
              restoringCoachRef.current = false;
            }
          })();
        }
      }

      // Block unapproved coaches (pending/rejected) on coach path.
      // Unless they chose "Continue as Fan" to use the app while waiting.
      // isPendingCoach is derived from user state, not route string — avoids fragile path matching
      const isPendingCoach =
        user?.is_admin !== true &&
        (coachAccess.isPendingCoach || coachAccess.isRejectedCoach) &&
        !coachAccess.isProceedingAsFan;
      // Don't yank pending coaches off onboarding routes (e.g. step-3 during upgrade flow)
      const pendingCoachRoute = postAuthDecision.route;
      if (
        isPendingCoach &&
        lastRedirectRef.current !== pendingCoachRoute &&
        firstSegment !== 'sign-in' &&
        firstSegment !== 'sign-up' &&
        firstSegment !== 'onboarding'
      ) {
        if (__DEV__)
          console.log('[AuthProvider] Unapproved coach blocked — must wait for approval decision');
        if (lastRedirectRef.current !== pendingCoachRoute) {
          redirectWithTelemetry(pendingCoachRoute, 'coach_pending_approval');
        }
        return;
      }

      // SERVER IS SOURCE OF TRUTH for onboarding completion — never trust AsyncStorage alone
      // Treat undefined/null as incomplete (prevents bypass when flag is missing)
      const serverSaysIncomplete = !isOnboardingComplete(user);
      const needsOnboarding = serverSaysIncomplete && !coachAccess.isProceedingAsFan;
      const isOnAgreementScreen = currentPath.includes('coach-agreement');
      const needsCoachAgreementAcceptance =
        isOnAgreementScreen && !hasAcceptedCoachAgreement(user as any);

      // If needs onboarding and not already there, redirect to start onboarding
      if (
        postAuthDecision.kind === 'generic_onboarding_required' &&
        firstSegment !== 'onboarding'
      ) {
        if (__DEV__) console.log('[AuthProvider] User needs onboarding, redirecting to step 1');
        if (lastRedirectRef.current !== postAuthDecision.route) {
          redirectWithTelemetry(postAuthDecision.route, 'onboarding_required');
        }
        return;
      }

      // If onboarding is complete and user is still on onboarding route, send to main app.
      // Exception: pending-approval and league-pending-approval are completion screens —
      // the user must tap the button themselves. Don't yank them away automatically.
      // Exception: coach-agreement — only keep the user there if they still need to accept it.
      const isOnPendingScreen =
        currentPath.includes('pending-approval') || currentPath.includes('league-pending-approval');
      if (
        !needsOnboarding &&
        firstSegment === 'onboarding' &&
        !isPendingCoach &&
        !isOnPendingScreen &&
        !needsCoachAgreementAcceptance
      ) {
        if (__DEV__)
          console.log('[AuthProvider] User completed onboarding, redirecting to main app');
        const landingRoute = postAuthDecision.route;
        if (lastRedirectRef.current !== landingRoute) {
          redirectWithTelemetry(landingRoute, 'onboarding_complete');
        }
        return;
      }

      // Root index is a splash trampoline only. Once auth/bootstrap is ready,
      // authenticated app-home users must be pushed onto a concrete screen.
      if (isRootIndex && postAuthDecision.kind === 'app_home') {
        const landingRoute = postAuthDecision.route;
        if (lastRedirectRef.current !== landingRoute) {
          redirectWithTelemetry(landingRoute, 'root_index_authenticated');
        }
        return;
      }

      // Payment redirect screens must stay mounted long enough to reconcile
      // webhook/finalize-session state. Redirecting an authenticated user away
      // from /payment-success or /payment-cancel causes a bounce back into
      // paywall logic before Stripe state is finalized.
      const isPaymentRedirectScreen =
        firstSegment === 'payment-success' || firstSegment === 'payment-cancel';

      // Auth entry screens must not trap an already-authenticated user. If a
      // valid session lands on /sign-in or /sign-up (stale history, manual nav,
      // deep-link recovery), immediately route to the canonical post-auth
      // destination instead of leaving the user on an auth screen that appears
      // to "loop".
      if (
        isAuthEntryRouteSegment(firstSegment) &&
        postAuthDecision.kind === 'app_home' &&
        !isPaymentRedirectScreen
      ) {
        const landingRoute = postAuthDecision.route;
        if (lastRedirectRef.current !== landingRoute) {
          redirectWithTelemetry(landingRoute, 'auth_entry_authenticated');
        }
        return;
      }

      // SECURITY: Flush any pending deep link now that auth is settled and user is valid.
      // Deep links to protected screens (post, game, team, profile) are deferred in
      // _layout.tsx until we reach this point — preventing unauthenticated access.
      if (!needsOnboarding) {
        const pendingUrl = consumePendingDeepLink();
        if (pendingUrl) {
          if (__DEV__) console.log('[AuthProvider] Flushing deferred deep link:', pendingUrl);
          handleDeepLink(pendingUrl);
          return;
        }
      }
    }

    // Root index is never a destination for guests; it is only the passive
    // splash while bootstrap decides where to go next.
    if (!user && !pendingVerificationEmail && isRootIndex) {
      if (lastRedirectRef.current !== unauthenticatedEntryRoute) {
        redirectWithTelemetry(unauthenticatedEntryRoute, 'root_index_guest');
      }
      return;
    }

    // Do not strand unauthenticated users on the passive root spinner when a
    // single startup health check fails. Route guests to feed where
    // OfflineBanner surfaces connectivity issues instead.
    if (!healthOk) {
      if (__DEV__) console.log('[AuthProvider] Backend unhealthy, limiting routing');
      if (
        !user &&
        !pendingVerificationEmail &&
        !isPublic &&
        firstSegment !== '(tabs)' &&
        firstSegment !== ''
      ) {
        if (lastRedirectRef.current !== unauthenticatedEntryRoute) {
          redirectWithTelemetry(unauthenticatedEntryRoute, 'unauthenticated_backend_unhealthy');
        }
      }
      return;
    }

    // Unauthenticated routing
    // Guests may freely browse the main tab screens (feed, highlights, discover, profile).
    // Only redirect when they land on a route that genuinely requires authentication.
    // Guard firstSegment !== '' to avoid firing before Expo Router restores nav state.
    if (
      !user &&
      !pendingVerificationEmail &&
      !isPublic &&
      firstSegment !== '(tabs)' &&
      firstSegment !== ''
    ) {
      if (lastRedirectRef.current !== unauthenticatedEntryRoute) {
        if (__DEV__)
          console.log(
            `[AuthProvider] Redirecting to ${unauthenticatedEntryRoute} (unauthenticated)`
          );
        redirectWithTelemetry(unauthenticatedEntryRoute, 'unauthenticated');
      }
    }
  }, [
    currentPath,
    user,
    pendingVerificationEmail,
    initializing,
    routingReady,
    healthOk,
    router,
    unauthenticatedEntryRoute,
    hasCompletedOnboarding,
    redirectWithTelemetry,
    redirectRetryTick,
  ]);

  const value = useMemo<AuthContextType>(
    () => ({
      user,
      hasSession,
      pendingVerificationEmail,
      loading,
      healthOk,
      healthError,
      isAdmin,
      subscriptionTier,
      hasActiveSubscription,
      checkAuth,
      signOut,
      registerPushToken,
      markOnboardingCompleteLocally,
      markOnboardingIncompleteLocally,
    }),
    [
      user,
      hasSession,
      pendingVerificationEmail,
      loading,
      healthOk,
      healthError,
      isAdmin,
      subscriptionTier,
      hasActiveSubscription,
      checkAuth,
      signOut,
      registerPushToken,
      markOnboardingCompleteLocally,
      markOnboardingIncompleteLocally,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
