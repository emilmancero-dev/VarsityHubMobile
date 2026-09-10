import { Image } from 'expo-image';
import { Stack, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import type { TextInput } from 'react-native';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useColorScheme,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
// @ts-ignore JS exports
import { User } from '@/api/entities';
import { AuthenticatedEntryGuard } from '@/components/auth/AuthenticatedEntryGuard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import PasswordInput from '@/components/PasswordInput';
import { Colors } from '@/constants/Colors';
import { useAuth } from '@/context/AuthProvider';
import { useAppleAuth } from '@/hooks/useAppleAuth';
import { useExistingSessionActions } from '@/hooks/useExistingSessionActions';
import { useGoogleAuth } from '@/hooks/useGoogleAuth';
import { captureBreadcrumb, captureException } from '@/utils/sentry';
import { sanitizeEmail, validateEmail } from '@/utils/formUtils';
import { analytics, ANALYTICS_EVENTS } from '@/utils/analytics';
import { consumePendingDeepLink, handleDeepLink } from '@/utils/deepLinks';
import { getPostAuthLandingRoute } from '@/utils/postAuthRouting';
import { getOAuthExistingAccountMessage } from '@/utils/oauthErrors';
import { toAuthErrorMessage } from '@/utils/toUserMessage';
import { Ionicons } from '@expo/vector-icons';
import * as AppleAuthentication from 'expo-apple-authentication';

const { AppleAuthenticationButton, AppleAuthenticationButtonType, AppleAuthenticationButtonStyle } =
  AppleAuthentication;

export default function SignInScreen() {
  const router = useRouter();
  const colorScheme = useColorScheme();
  const palette = Colors[colorScheme === 'dark' ? 'dark' : 'light'];

  const passwordRef = useRef<TextInput>(null);
  const submitInFlightRef = useRef(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailFocused, setEmailFocused] = useState(false);
  const [passwordFocused, setPasswordFocused] = useState(false);
  const {
    signInWithGoogle,
    loading: googleLoading,
    ready: googleReady,
    isConfigured: googleConfigured,
  } = useGoogleAuth();
  const { signInWithApple, loading: appleLoading, ready: appleReady } = useAppleAuth();
  const { user, hasSession, checkAuth, registerPushToken, signOut } = useAuth();
  const insets = useSafeAreaInsets();
  const sessionGuardActive = hasSession;
  const authBusy = loading || googleLoading || appleLoading || signingOut;
  const emailInvalid = !!error && (!email || !validateEmail(sanitizeEmail(email)).valid);
  const passwordInvalid = !!error && !password;

  const getInputBorderColor = (focused: boolean, invalid: boolean) => {
    if (invalid) return palette.destructive;
    if (focused) return palette.tint;
    return palette.border;
  };

  const routeCurrentUser = async (resolvedUser?: any) => {
    const effectiveUser = resolvedUser || user;
    if (!effectiveUser) {
      captureException(new Error('routeCurrentUser called without a resolved auth user'), {
        tags: { context: 'sign_in_missing_routing_user' },
      });
      throw new Error('We could not determine which account is signed in.');
    }

    const landingRoute = getPostAuthLandingRoute(effectiveUser as any);

    if (landingRoute !== '/(tabs)') {
      router.replace(landingRoute as any);
      return;
    }

    const pendingUrl = consumePendingDeepLink();
    if (pendingUrl) {
      if (handleDeepLink(pendingUrl)) {
        return;
      }
      // The pending URL was already consumed but couldn't be opened (parse
      // failure, unknown route, router not ready). User isn't stranded —
      // we fall through to landingRoute below — but the original deep link
      // is silently lost. Surface it so we can debug what's failing.
      captureException(new Error('Pending deep link consumed but handleDeepLink returned false'), {
        tags: { context: 'sign_in_pending_deeplink_unhandled' },
        extra: { pendingUrl },
      });
    }

    router.replace(landingRoute as any);
  };

  const { handleSignOutToContinue, handleContinueExistingSession } = useExistingSessionActions({
    authBusy,
    signOut,
    setSigningOut,
    setError,
    user,
    checkAuth,
    routeCurrentUser,
    expiredMessage: 'Your saved session expired. Please sign in again.',
    restoreFailedMessage: 'We could not restore your saved session. Please sign in again.',
  });

  const onSubmit = async () => {
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    const sanitizedEmail = sanitizeEmail(email);
    if (authBusy) {
      submitInFlightRef.current = false;
      return;
    }
    // Same boundary as Google + Apple OAuth (handleGoogleLogin / handleAppleLogin).
    // Without this, a signed-in user could submit credentials for a different
    // account and effectively switch silently — local state would replace
    // correctly, but the previous user's push_token preference would remain
    // registered server-side, causing pushes for both accounts to land on this
    // device. Force explicit sign-out so /auth/logout properly clears the
    // server-side push_token of the outgoing account.
    if (sessionGuardActive) {
      setError('Sign out before signing in to a different account on this device.');
      submitInFlightRef.current = false;
      return;
    }
    if (!sanitizedEmail || !password) {
      setError('Please enter email and password');
      submitInFlightRef.current = false;
      return;
    }
    const emailCheck = validateEmail(sanitizedEmail);
    if (!emailCheck.valid) {
      setError(emailCheck.error || 'Please enter a valid email address');
      submitInFlightRef.current = false;
      return;
    }
    setLoading(true);
    setError(null);
    captureBreadcrumb('Sign-in started', 'auth.sign_in', {
      method: 'email',
      has_email: !!email.trim(),
    });
    try {
      const res: any = await User.loginViaEmailPassword(sanitizedEmail, password);

      if (!res?.access_token) {
        const errMsg = `Invalid login response: missing access_token. Response keys: ${Object.keys(res || {}).join(', ')}`;
        captureException(new Error(errMsg), { tags: { context: 'email-password-login' } });
        setError('Invalid login response from server');
        setLoading(false);
        return;
      }

      // If email verification is needed, call checkAuth with pendingVerification flag
      if (res?.needs_verification) {
        captureBreadcrumb('Sign-in requires verification', 'auth.sign_in', {
          method: 'email',
        });
        try {
          await checkAuth({ email: sanitizedEmail, pendingVerification: true });
        } catch (authError) {
          // Token is saved, AuthProvider will handle routing on next render
          // eslint-disable-next-line no-console
          if (__DEV__) console.log('[sign-in] checkAuth after verification login:', authError);
        }
        setLoading(false);
        return;
      }

      // Otherwise, refresh auth state - AuthProvider will handle routing
      try {
        const authUser = await checkAuth({ replaceSession: true });
        await routeCurrentUser(authUser);
        captureBreadcrumb('Sign-in succeeded', 'auth.sign_in', {
          method: 'email',
        });
        analytics.track(ANALYTICS_EVENTS.USER_SIGNED_IN, { method: 'email' });
        // Register push token after successful login (non-blocking)
        registerPushToken().catch((err: any) => {
          captureException(err, { tags: { context: 'push-token-register-email-login' } });
        });
      } catch (authError) {
        if (__DEV__) console.warn('[sign-in] checkAuth after email login:', authError);
        setError('Sign-in succeeded but we could not load your profile. Please try again.');
      }
    } catch (e: any) {
      const errMsg = e?.message || 'Login failed';
      const status = e?.status || e?.response?.status;
      captureBreadcrumb(
        'Sign-in failed',
        'auth.sign_in',
        {
          method: 'email',
          status: status ?? 'unknown',
        },
        'warning'
      );

      // Show user-friendly error messages
      if (status === 401) {
        setError('Invalid email or password. Please try again.');
      } else if (status === 429) {
        setError('Too many login attempts. Please wait a moment and try again.');
      } else if (status === 403) {
        const banReason = e?.data?.ban_reason || e?.response?.data?.ban_reason;
        const bannedUntil = e?.data?.banned_until || e?.response?.data?.banned_until;
        if (bannedUntil) {
          const until = new Date(bannedUntil).toLocaleDateString();
          setError(
            `Your account is temporarily suspended until ${until}.${banReason ? ` Reason: ${banReason}` : ''}`
          );
        } else {
          setError(
            banReason || 'This account has been banned. Please contact support@varsityhub.app.'
          );
        }
      } else if (e?.isNetworkError === true || errMsg.startsWith('Cannot connect to server')) {
        // Keep the "which host failed" diagnostic via a fingerprint (ref xxxx)
        // instead of the raw origin URL — see utils/toUserMessage. The branch
        // condition still keys off the raw message for retry/branch selection.
        setError(toAuthErrorMessage(e));
      } else if (
        errMsg.includes('Network') ||
        errMsg.includes('timeout') ||
        errMsg.includes('fetch')
      ) {
        // Don't tell the user to "check your internet" — OfflineBanner owns
        // that message and has real NetInfo evidence. If we hit this fallback,
        // the device is online (banner would be up otherwise) and the request
        // hiccupped without the http.ts rich-error tagging.
        setError('Connection hiccup. Please try again.');
      } else if (status === 500 || errMsg.toLowerCase().includes('internal server')) {
        setError('Server is temporarily unavailable. Please try again in a moment.');
      } else {
        setError(toAuthErrorMessage(e, 'Login failed. Please try again.'));
      }

      // Capture error with context
      captureException(typeof e === 'string' ? new Error(e) : e, {
        tags: { context: 'email-password-login' },
        extra: { response: e?.data?.error || e?.response?.data, status },
      });
    } finally {
      setLoading(false);
      submitInFlightRef.current = false;
    }
  };

  const handleGoogleLogin = async () => {
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    if (authBusy) {
      submitInFlightRef.current = false;
      return;
    }
    if (sessionGuardActive) {
      setError('Sign out before using a different Google account on this device.');
      submitInFlightRef.current = false;
      return;
    }
    if (!googleReady) {
      setError('Google sign in is not configured yet.');
      submitInFlightRef.current = false;
      return;
    }
    setError(null);
    captureBreadcrumb('Sign-in started', 'auth.sign_in', {
      method: 'google',
    });
    try {
      const response: any = await signInWithGoogle();

      if (!response?.access_token) {
        const errMsg = `Google sign-in failed: missing access_token. Response: ${JSON.stringify(response).substring(0, 200)}`;
        captureException(new Error(errMsg), { tags: { context: 'google-signin' } });
        setError('Failed to complete Google sign-in. Please try again.');
        return;
      }

      // Call checkAuth to set user state; AuthProvider will handle routing
      try {
        const authUser = await checkAuth({ replaceSession: true });
        await routeCurrentUser(authUser);
        captureBreadcrumb('Sign-in succeeded', 'auth.sign_in', {
          method: 'google',
        });
        analytics.track(ANALYTICS_EVENTS.USER_SIGNED_IN, { method: 'google' });
        // Register push token after successful login (non-blocking)
        registerPushToken().catch((err: any) => {
          captureException(err, { tags: { context: 'push-token-register-google-login' } });
        });
      } catch (authError: any) {
        if (__DEV__)
          console.warn('[sign-in] checkAuth after Google login failed:', authError?.message);
        setError('Sign-in succeeded but we could not load your profile. Please try again.');
      }
    } catch (e: any) {
      // Silently ignore user cancellation (native). On web, a "dismiss" also
      // covers the popup closing on an OAuth error page (e.g. a Google config
      // problem) — indistinguishable from a user cancel — so surface a soft
      // retry message instead of failing invisibly.
      if (e?.code === 'CANCELLED' || e?.message === 'GOOGLE_SIGN_IN_CANCELLED') {
        captureBreadcrumb('Sign-in cancelled', 'auth.sign_in', {
          method: 'google',
        });
        if (Platform.OS === 'web') {
          setError('Google sign-in was closed before completing. Please try again.');
        }
        return;
      }

      const message = e?.message || 'Google sign in failed';
      if (typeof message === 'string' && message.toLowerCase().includes('cancel')) {
        captureBreadcrumb('Sign-in cancelled', 'auth.sign_in', {
          method: 'google',
        });
        return;
      }
      const oauthConflictMessage = getOAuthExistingAccountMessage(e, 'Google');
      captureBreadcrumb(
        'Sign-in failed',
        'auth.sign_in',
        {
          method: 'google',
        },
        'warning'
      );

      // Show user-friendly error
      if (e?.isNetworkError === true || message.startsWith('Cannot connect to server')) {
        // Host fingerprint instead of the raw origin URL (utils/toUserMessage).
        setError(toAuthErrorMessage(e));
      } else if (
        message.includes('Network') ||
        message.includes('timeout') ||
        message.includes('fetch')
      ) {
        // OfflineBanner owns the "check your internet" message. See
        // email-login fallback above for the full reasoning.
        setError('Connection hiccup. Please try again.');
      } else if (message.includes('not configured')) {
        setError('Google sign-in is not configured. Please use email/password login.');
      } else if (oauthConflictMessage) {
        setError(oauthConflictMessage);
      } else {
        setError(toAuthErrorMessage(e, 'Google sign-in failed. Please try again.'));
      }

      captureException(typeof e === 'string' ? new Error(e) : e, {
        tags: { context: 'google-signin' },
      });
    } finally {
      submitInFlightRef.current = false;
    }
  };

  const handleAppleLogin = async () => {
    if (submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    if (authBusy) {
      submitInFlightRef.current = false;
      return;
    }
    if (sessionGuardActive) {
      setError('Sign out before using a different Apple account on this device.');
      submitInFlightRef.current = false;
      return;
    }
    if (Platform.OS !== 'ios') {
      setError('Apple sign in is only available on iOS.');
      submitInFlightRef.current = false;
      return;
    }
    // Race guard: useAppleAuth seeds `available` as false and resolves it
    // asynchronously via AppleAuthentication.isAvailableAsync(). Without
    // this gate, a fast tap on first paint can hit the "not available on
    // this device" path even when the device would have been fine a moment
    // later. Mirrors the existing guard in sign-up.tsx.
    if (!appleReady) {
      setError('Apple sign in is still initializing. Please try again in a moment.');
      submitInFlightRef.current = false;
      return;
    }
    setError(null);
    captureBreadcrumb('Sign-in started', 'auth.sign_in', {
      method: 'apple',
    });
    try {
      const response: any = await signInWithApple();

      if (!response?.access_token) {
        const errMsg = `Apple sign-in failed: missing access_token. Response: ${JSON.stringify(response).substring(0, 200)}`;
        captureException(new Error(errMsg), { tags: { context: 'apple-signin' } });
        setError('Failed to complete Apple sign-in. Please try again.');
        return;
      }

      // Call checkAuth to set user state; AuthProvider will handle routing
      try {
        const authUser = await checkAuth({ replaceSession: true });
        await routeCurrentUser(authUser);
        captureBreadcrumb('Sign-in succeeded', 'auth.sign_in', {
          method: 'apple',
        });
        analytics.track(ANALYTICS_EVENTS.USER_SIGNED_IN, { method: 'apple' });
        // Register push token after successful login (non-blocking)
        registerPushToken().catch((err: any) => {
          captureException(err, { tags: { context: 'push-token-register-apple-login' } });
        });
      } catch (authError: any) {
        if (__DEV__)
          console.warn('[sign-in] checkAuth after Apple login failed:', authError?.message);
        setError('Sign-in succeeded but we could not load your profile. Please try again.');
      }
    } catch (e: any) {
      const message = e?.message || 'Apple sign in failed';
      const code = String(e?.code || '').toLowerCase();

      // Silently ignore user cancellation (not an error)
      if (
        message.toLowerCase().includes('cancel') ||
        code.includes('canceled') ||
        code.includes('cancelled') ||
        code === 'err_request_canceled'
      ) {
        captureBreadcrumb('Sign-in cancelled', 'auth.sign_in', {
          method: 'apple',
        });
        return;
      }
      const oauthConflictMessage = getOAuthExistingAccountMessage(e, 'Apple');
      captureBreadcrumb(
        'Sign-in failed',
        'auth.sign_in',
        {
          method: 'apple',
          status: e?.status ?? 'unknown',
        },
        'warning'
      );

      // Show user-friendly error
      if (message.includes('not available in the simulator') || message.includes('simulator')) {
        setError('Apple Sign-In requires a real device. Use email/password in the simulator.');
      } else if (message.includes('not available on this device')) {
        setError('Apple Sign-In is not available on this device. Try email/password instead.');
      } else if (e?.isNetworkError === true || message.startsWith('Cannot connect to server')) {
        // Host fingerprint instead of the raw origin URL (utils/toUserMessage).
        setError(toAuthErrorMessage(e));
      } else if (
        message.includes('Network') ||
        message.includes('timeout') ||
        message.includes('fetch')
      ) {
        // OfflineBanner owns the "check your internet" message. See
        // email-login fallback above for the full reasoning.
        setError('Connection hiccup. Please try again.');
      } else if (message.toLowerCase().includes('internal server') || e?.status === 500) {
        setError('Server is temporarily unavailable. Please try again in a moment.');
      } else if (oauthConflictMessage) {
        setError(oauthConflictMessage);
      } else {
        setError(toAuthErrorMessage(e, 'Apple sign-in failed. Please try again.'));
      }

      captureException(typeof e === 'string' ? new Error(e) : e, {
        tags: { context: 'apple-signin' },
      });
    } finally {
      submitInFlightRef.current = false;
    }
  };

  return (
    <SafeAreaView
      style={[
        styles.root,
        { backgroundColor: palette.background, borderLeftWidth: 0, borderRightWidth: 0 },
      ]}
      edges={['top']}
    >
      <Stack.Screen options={{ title: 'Sign In', headerShown: false }} />
      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: Math.max(24, insets.bottom) },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        style={[styles.flex, { borderWidth: 0 }]}
        automaticallyAdjustKeyboardInsets
      >
        <View style={[styles.header, { borderWidth: 0 }]}>
          <View
            style={[
              styles.logoContainer,
              {
                backgroundColor: '#FFFFFF',
                overflow: 'hidden',
                borderWidth: colorScheme === 'dark' ? 3 : 1,
                borderColor: colorScheme === 'dark' ? '#64748b' : '#E5E7EB',
                ...(Platform.OS === 'web'
                  ? {
                      boxShadow:
                        colorScheme === 'dark'
                          ? '0px 4px 16px rgba(0, 0, 0, 0.6)'
                          : '0px 4px 16px rgba(0, 0, 0, 0.1)',
                    }
                  : {
                      shadowColor: '#000000',
                      shadowOpacity: colorScheme === 'dark' ? 0.6 : 0.1,
                      shadowOffset: { width: 0, height: 4 },
                      shadowRadius: 16,
                    }),
                elevation: 8,
              },
            ]}
          >
            <Image
              source={require('../assets/images/logo.png')}
              style={styles.logo}
              contentFit="contain"
              accessibilityLabel="VarsityHub logo"
            />
          </View>
          <Text style={[styles.title, { color: palette.text }]}>Welcome back</Text>
          <Text style={[styles.subtitle, { color: palette.mutedText }]}>
            Sign in to keep your community in sync.
          </Text>
        </View>

        <View
          style={[
            styles.card,
            {
              backgroundColor: palette.elevated,
              borderColor: error ? palette.destructive : palette.border,
              borderWidth: error ? 3 : 2,
            },
          ]}
        >
          {sessionGuardActive ? (
            <AuthenticatedEntryGuard
              email={user?.email}
              onContinue={() => void handleContinueExistingSession()}
              onSignOut={() => void handleSignOutToContinue()}
              signingOut={signingOut}
            />
          ) : null}
          {error ? (
            <Text style={[styles.error, { color: palette.destructive }]}>{error}</Text>
          ) : null}

          {!sessionGuardActive && Platform.OS === 'ios' ? (
            <View
              style={[
                authBusy ? styles.buttonDisabled : undefined,
                { pointerEvents: authBusy ? 'none' : 'auto' },
              ]}
            >
              <AppleAuthenticationButton
                onPress={handleAppleLogin}
                buttonType={AppleAuthenticationButtonType.SIGN_IN}
                buttonStyle={
                  colorScheme === 'dark'
                    ? AppleAuthenticationButtonStyle.WHITE
                    : AppleAuthenticationButtonStyle.BLACK
                }
                cornerRadius={8}
                style={{
                  width: '100%',
                  height: 50,
                  marginBottom: 0,
                  borderWidth: 2,
                  borderColor: palette.border,
                }}
                accessibilityLabel="Sign in with Apple"
              />
            </View>
          ) : null}

          {!sessionGuardActive && googleReady ? (
            <Pressable
              style={[
                styles.googleButton,
                authBusy && styles.buttonDisabled,
                { backgroundColor: palette.card, borderColor: palette.border, borderWidth: 2 },
              ]}
              onPress={handleGoogleLogin}
              disabled={authBusy}
              accessibilityRole="button"
              accessibilityLabel="Continue with Google"
              accessibilityHint="Double tap to sign in with your Google account"
            >
              <Ionicons name="logo-google" size={20} color="#4285F4" style={styles.googleIcon} />
              {googleLoading ? (
                <ActivityIndicator size="small" color="#4285F4" />
              ) : (
                <Text style={[styles.googleButtonText, { color: palette.text }]}>
                  Continue with Google
                </Text>
              )}
            </Pressable>
          ) : googleConfigured ? (
            // Client IDs are configured but the auth request hasn't initialized yet — show loading
            <View
              style={[
                styles.googleButton,
                styles.disabledGoogleButton,
                { backgroundColor: palette.card, borderColor: palette.border, borderWidth: 2 },
              ]}
              accessibilityRole="text"
              accessibilityLabel="Google sign in loading"
            >
              <Ionicons
                name="logo-google"
                size={20}
                color={palette.mutedText}
                style={styles.googleIcon}
              />
              <ActivityIndicator size="small" color={palette.mutedText} style={{ marginLeft: 8 }} />
            </View>
          ) : (
            // Client IDs are genuinely missing — show unavailable
            <View
              style={[
                styles.googleButton,
                styles.disabledGoogleButton,
                { backgroundColor: palette.surface, borderColor: palette.border, borderWidth: 2 },
              ]}
              accessibilityRole="text"
              accessibilityLabel="Google sign in not available"
            >
              <Ionicons
                name="logo-google"
                size={20}
                color={palette.mutedText}
                style={styles.googleIcon}
              />
              <View style={{ flex: 1 }}>
                <Text style={[styles.googleButtonText, { color: palette.mutedText }]}>
                  Google sign-in temporarily unavailable
                </Text>
                <Text style={[styles.googleButtonSubtext, { color: palette.mutedText }]}>
                  Please use email or Apple sign-in to continue.
                </Text>
              </View>
            </View>
          )}

          {!sessionGuardActive ? (
            <>
              <View style={styles.divider}>
                <View style={[styles.dividerLine, { backgroundColor: palette.border }]} />
                <Text style={[styles.dividerText, { color: palette.mutedText }]}>or</Text>
                <View style={[styles.dividerLine, { backgroundColor: palette.border }]} />
              </View>

              <View style={styles.fieldSpacing}>
                <Text style={[styles.label, { color: palette.mutedText }]}>Email</Text>
                <Input
                  testID="sign-in-email"
                  placeholder="name@school.edu"
                  value={email}
                  onChangeText={setEmail}
                  editable={!authBusy}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="email"
                  textContentType="emailAddress"
                  keyboardType="email-address"
                  returnKeyType="next"
                  onFocus={() => setEmailFocused(true)}
                  onBlur={() => setEmailFocused(false)}
                  onSubmitEditing={() => passwordRef.current?.focus()}
                  placeholderTextColor={palette.mutedText}
                  accessibilityLabel="Email"
                  accessibilityHint="Enter your email address"
                  style={[
                    styles.input,
                    {
                      backgroundColor: palette.surface,
                      borderColor: getInputBorderColor(emailFocused, emailInvalid),
                      borderWidth: emailFocused || emailInvalid ? 3 : 2,
                      color: palette.text,
                      ...(Platform.OS === 'web'
                        ? {
                            boxShadow: emailFocused ? `0px 0px 8px ${palette.tint}2e` : 'none',
                          }
                        : {
                            shadowColor: emailFocused ? palette.tint : 'transparent',
                            shadowOpacity: emailFocused ? 0.18 : 0,
                            shadowOffset: { width: 0, height: 0 },
                            shadowRadius: 8,
                          }),
                    },
                  ]}
                />
              </View>

              <View style={styles.fieldSpacing}>
                <Text style={[styles.label, { color: palette.mutedText }]}>Password</Text>
                <PasswordInput
                  ref={passwordRef}
                  testID="sign-in-password"
                  placeholder="Enter your password"
                  value={password}
                  onChangeText={setPassword}
                  editable={!authBusy}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="current-password"
                  textContentType="password"
                  returnKeyType="go"
                  onFocus={() => setPasswordFocused(true)}
                  onBlur={() => setPasswordFocused(false)}
                  onSubmitEditing={() => void onSubmit()}
                  placeholderTextColor={palette.mutedText}
                  accessibilityLabel="Password"
                  accessibilityHint="Enter your password"
                  style={[
                    styles.input,
                    {
                      backgroundColor: palette.surface,
                      borderColor: getInputBorderColor(passwordFocused, passwordInvalid),
                      borderWidth: passwordFocused || passwordInvalid ? 3 : 2,
                      color: palette.text,
                      ...(Platform.OS === 'web'
                        ? {
                            boxShadow: passwordFocused ? `0px 0px 8px ${palette.tint}2e` : 'none',
                          }
                        : {
                            shadowColor: passwordFocused ? palette.tint : 'transparent',
                            shadowOpacity: passwordFocused ? 0.18 : 0,
                            shadowOffset: { width: 0, height: 0 },
                            shadowRadius: 8,
                          }),
                    },
                  ]}
                />
              </View>

              <Pressable
                style={styles.forgotLink}
                onPress={() => void router.push('/forgot-password')}
                disabled={authBusy}
                accessibilityRole="button"
                accessibilityLabel="Forgot password?"
                accessibilityHint="Double tap to reset your password"
              >
                <Text style={[styles.forgotLinkText, { color: palette.tint }]}>
                  Forgot password?
                </Text>
              </Pressable>

              <Button
                onPress={onSubmit}
                disabled={authBusy}
                accessibilityLabel={authBusy ? 'Signing in' : 'Sign In'}
                accessibilityHint="Double tap to sign in with email and password"
              >
                {loading ? (
                  <ActivityIndicator color={palette.background} />
                ) : (
                  <Text style={{ color: palette.background, fontWeight: '700' }}>Sign In</Text>
                )}
              </Button>
            </>
          ) : null}
        </View>

        {!sessionGuardActive ? (
          <Pressable
            style={styles.footer}
            onPress={() => void router.replace('/sign-up')}
            disabled={authBusy}
            accessibilityRole="button"
            accessibilityLabel="Need an account? Create one"
            accessibilityHint="Double tap to go to sign up"
          >
            <Text style={[styles.footerText, { color: palette.mutedText }]}>Need an account?</Text>
            <Text style={[styles.footerLink, { color: palette.tint }]}>Create one</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    padding: 24,
    justifyContent: 'center',
  },
  header: {
    alignItems: 'center',
    marginBottom: 32,
  },
  logoContainer: {
    width: 130,
    height: 130,
    borderRadius: 65,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
    paddingHorizontal: 0,
    paddingVertical: 0,
  },
  logo: {
    width: 85,
    height: 85,
    borderRadius: 10,
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
  },
  subtitle: {
    fontSize: 15,
    textAlign: 'center',
    marginTop: 8,
    lineHeight: 22,
    maxWidth: 280,
  },
  card: {
    borderWidth: 2,
    borderRadius: 20,
    padding: 20,
    marginBottom: 16,
    gap: 8,
  },
  googleButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent', // Will be overridden with palette.card
    borderWidth: 2,
    borderColor: 'transparent', // Will be overridden with palette.border
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    gap: 8,
  },
  disabledGoogleButton: {
    backgroundColor: 'transparent', // Will be overridden with palette.surface
    borderColor: 'transparent', // Will be overridden with palette.border
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  googleIcon: {
    marginRight: 8,
  },
  googleButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: 'transparent', // Will be overridden with palette.text
  },
  googleButtonSubtext: {
    fontSize: 12,
    marginTop: 2,
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginVertical: 8,
  },
  dividerLine: {
    flex: 1,
    height: 1,
  },
  dividerText: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
  fieldSpacing: {
    gap: 8,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  input: {
    marginBottom: 0,
  },
  forgotLink: {
    alignSelf: 'flex-end',
  },
  forgotLinkText: {
    fontSize: 13,
    fontWeight: '600',
  },
  error: {
    marginBottom: 4,
    textAlign: 'center',
    fontWeight: '600',
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
    marginTop: 8,
  },
  footerText: {
    fontSize: 14,
  },
  footerLink: {
    fontSize: 14,
    fontWeight: '700',
  },
});
