import { toUserMessage } from '@/utils/toUserMessage';
// ⚠️ WORKING - DO NOT MODIFY WITHOUT EXPLICIT PERMISSION
// Google OAuth fixed 2026-02-24; proxy detection fixed 2026-02-24
// iOS native: uses iOS client ID with native redirect scheme
// Expo Go proxy: uses Web client ID with auth.expo.io redirect
// Changing this will break Google Sign In

import { User } from '@/api/entities';
import { getConfig } from '@/config/env';
import * as Application from 'expo-application';
import * as AuthSession from 'expo-auth-session';
import * as Google from 'expo-auth-session/providers/google';
import Constants from 'expo-constants';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';

WebBrowser.maybeCompleteAuthSession();
const { makeRedirectUri } = AuthSession;

type GoogleAuthResult = Awaited<ReturnType<typeof User.loginViaGoogle>>;
type GoogleLinkResult = Awaited<ReturnType<typeof User.linkGoogleProvider>>;

const appConfig = getConfig();

const googleClientConfig = (opts: { shouldUseProxy: boolean }) => {
  const { google } = appConfig;
  const androidClientId = google.androidClientId;
  const iosClientId = google.iosClientId;
  const webClientId = google.webClientId;
  const expoClientId = google.expoClientId;

  // When using proxy (HTTPS redirect via auth.expo.io), we MUST use Web client only.
  // Passing Android/iOS client IDs causes "Custom URI scheme is not enabled for your Android client"
  // because Google rejects native client IDs with HTTPS redirects.
  if (opts.shouldUseProxy && (webClientId || expoClientId)) {
    const webId = webClientId || expoClientId!;
    return {
      androidClientId: webId,
      iosClientId: webId,
      webClientId: webId,
      expoClientId: webId,
      forceWebClient: false,
    } as const;
  }

  return { androidClientId, iosClientId, webClientId, expoClientId } as const;
};

const FORCE_PROXY_FLAG = appConfig.google.forceProxy;
const FALLBACK_PROJECT_FULL_NAME = '@lime_prod/VarsityHubMobile';
const expoConfig: any = Constants.expoConfig ?? {};
const expoSlug: string | undefined = expoConfig.slug || expoConfig.name;
const expoOwner: string | undefined = expoConfig.owner;
const expoOriginalFullName: string | undefined = (expoConfig as any)?.extra?.expoGo
  ?.projectFullName;
const derivedProjectFullName =
  typeof expoOriginalFullName === 'string'
    ? expoOriginalFullName
    : typeof expoSlug === 'string'
      ? `${expoOwner ? `@${expoOwner}` : '@anonymous'}/${expoSlug}`
      : undefined;
const PROJECT_FULL_NAME =
  appConfig.expoProjectFullName || derivedProjectFullName || FALLBACK_PROJECT_FULL_NAME;

export function useGoogleAuth() {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Detect Expo Go via appOwnership, NOT executionEnvironment.
  // executionEnvironment === 'storeClient' matches BOTH production AND dev client builds,
  // which would incorrectly force proxy mode (auth.expo.io — deprecated since SDK 50).
  // appOwnership === 'expo' only matches Expo Go.
  const isExpoGo = Constants.appOwnership === 'expo';
  const proxyRequested = FORCE_PROXY_FLAG || isExpoGo;
  const shouldUseProxy = proxyRequested && !!PROJECT_FULL_NAME;

  const clients = useMemo(() => googleClientConfig({ shouldUseProxy }), [shouldUseProxy]);

  // Check if Google auth is configured for the CURRENT platform
  const isConfigured = useMemo(() => {
    if (Platform.OS === 'android') {
      return Boolean(clients.androidClientId);
    }
    if (Platform.OS === 'ios') {
      // For iOS, we need either the iOS client ID or Expo client ID (for Expo Go)
      return Boolean(clients.iosClientId || clients.expoClientId);
    }
    if (Platform.OS === 'web') {
      return Boolean(clients.webClientId);
    }
    // Fallback: any client ID configured
    return Boolean(
      clients.androidClientId || clients.iosClientId || clients.webClientId || clients.expoClientId
    );
  }, [clients]);

  const redirectUri = useMemo(() => {
    let uri = '';

    // For web platform, use current origin
    if (Platform.OS === 'web') {
      if (typeof window !== 'undefined' && window.location?.origin) {
        uri = window.location.origin;
      } else {
        // Fallback to production URL for SSR or missing window
        uri = appConfig.webBaseUrl || 'https://varsityhub.app';
      }
      return uri;
    }

    // Proxy: use https://auth.expo.io/@owner/slug (getRedirectUrl throws without projectNameForProxy)
    if (shouldUseProxy && PROJECT_FULL_NAME) {
      try {
        uri = AuthSession.getRedirectUrl();
      } catch {
        uri = `https://auth.expo.io/${PROJECT_FULL_NAME}`;
      }
      return uri;
    }

    // For standalone iOS, use native redirect with reversed iOS client ID scheme
    // CRITICAL: Use real iOS client from config, NOT clients (which may be web when proxy was requested)
    const isStandaloneIOS = Platform.OS === 'ios' && Constants.appOwnership !== 'expo';
    const realIosClientId = appConfig.google.iosClientId;
    if (isStandaloneIOS && realIosClientId) {
      // Convert xxx-yyy.apps.googleusercontent.com → com.googleusercontent.apps.xxx-yyy
      const prefix = realIosClientId.replace(/\.apps\.googleusercontent\.com$/, '');
      const scheme = `com.googleusercontent.apps.${prefix}`;
      uri = makeRedirectUri({
        native: `${scheme}:/oauthredirect`,
      });
      return uri;
    }

    uri = makeRedirectUri({
      native: `${Application.applicationId}:/oauthredirect`,
      scheme: appConfig.appScheme,
    });
    return uri;
  }, [shouldUseProxy]);

  useEffect(() => {
    if (proxyRequested && !PROJECT_FULL_NAME) {
      if (__DEV__)
        console.warn(
          '[google-auth] Proxy requested but project full name could not be resolved. Falling back to custom scheme.'
        );
    }
    if (!isConfigured) {
      console.warn('[google-auth] NOT configured', {
        platform: Platform.OS,
        isExpoGo,
        shouldUseProxy,
        hasIosId: Boolean(clients.iosClientId),
        hasAndroidId: Boolean(clients.androidClientId),
        hasWebId: Boolean(clients.webClientId),
        appOwnership: Constants.appOwnership,
      });
    }
  }, [proxyRequested, isConfigured]);

  // Create request config - use placeholder values if not configured
  // The hook must be called unconditionally (React rules of hooks)
  const requestConfig = useMemo((): Google.GoogleAuthRequestConfig => {
    // If configured, use real values
    if (isConfigured) {
      return {
        scopes: ['profile', 'email'],
        redirectUri,
        androidClientId: clients.androidClientId,
        iosClientId: clients.iosClientId,
        webClientId: clients.webClientId,
        clientId: clients.expoClientId || '',
        // Web only: the provider defaults to the implicit ResponseType.Token
        // flow on web, which returns just an access_token — but the server
        // exchange needs an id_token. IdToken makes Google return it directly
        // (provider auto-adds the nonce; TokenResponse maps id_token →
        // authentication.idToken, so the existing Path 1 handles it).
        // Native iOS/Android keep the provider's default code flow untouched.
        ...(Platform.OS === 'web' ? { responseType: AuthSession.ResponseType.IdToken } : {}),
      };
    }

    // If not configured, provide placeholder values that satisfy the hook
    // We won't actually use this to sign in (isConfigured check prevents it)
    return {
      scopes: ['profile', 'email'],
      redirectUri,
      // Use fake but valid-looking client IDs for all platforms
      androidClientId: '000000000000-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.apps.googleusercontent.com',
      iosClientId: '000000000000-yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy.apps.googleusercontent.com',
      webClientId: '000000000000-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz.apps.googleusercontent.com',
      clientId: '000000000000-wwwwwwwwwwwwwwwwwwwwwwwwwwwwwwww.apps.googleusercontent.com',
    };
  }, [isConfigured, clients, redirectUri]);

  // Always call useAuthRequest (React rules of hooks)
  const [request, , promptAsync] = Google.useAuthRequest(requestConfig);
  const exchangeInProgressRef = useRef(false);

  const runGoogleAuth = useCallback(
    async <T>(exchange: (idToken: string) => Promise<T>): Promise<T> => {
      if (!isConfigured) {
        throw new Error('Google sign-in is not configured');
      }
      if (!request) {
        throw new Error('Google sign-in is not ready yet');
      }
      if (exchangeInProgressRef.current) {
        throw new Error('GOOGLE_SIGN_IN_CANCELLED');
      }
      exchangeInProgressRef.current = true;
      setError(null);
      setLoading(true);
      try {
        const response = await promptAsync();

        // Handle user cancellation gracefully - don't throw
        if (response.type === 'cancel' || response.type === 'dismiss') {
          setLoading(false);
          const err: any = new Error('GOOGLE_SIGN_IN_CANCELLED');
          err.code = 'CANCELLED';
          throw err;
        }

        // Handle non-success responses
        if (response.type !== 'success') {
          throw new Error(`Google sign-in failed: ${response.type}`);
        }

        let idToken: string | undefined;

        // Path 1: Expo Go / proxy flow — response.authentication has the id_token directly
        if (response.authentication?.idToken) {
          idToken = response.authentication.idToken;
        }
        // Path 2: Native — Google returns an auth code, exchange it for an id_token
        else if (response.params?.code) {
          // CRITICAL: Use the REAL platform client ID from config, not from `clients`
          // which may have been swapped to the web client ID for proxy flows.
          const exchangeClientId =
            Platform.OS === 'ios'
              ? appConfig.google.iosClientId || clients.iosClientId || ''
              : appConfig.google.androidClientId || clients.androidClientId || '';
          const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id: exchangeClientId,
              redirect_uri: request.redirectUri,
              code: response.params.code,
              code_verifier: request.codeVerifier || '',
              grant_type: 'authorization_code',
            }).toString(),
          });
          const tokenData = await tokenResponse.json();
          if (!tokenResponse.ok || !tokenData.id_token) {
            throw new Error(
              tokenData.error_description || tokenData.error || 'Token exchange failed'
            );
          }
          idToken = tokenData.id_token;
        }

        if (!idToken) {
          throw new Error('Google sign-in failed: no id_token received');
        }

        return await exchange(idToken);
      } catch (err: any) {
        // If user cancelled, re-throw so caller can handle gracefully
        if (err?.code === 'CANCELLED' || err?.message === 'GOOGLE_SIGN_IN_CANCELLED') {
          throw err;
        }

        const message = err?.message || 'Unable to sign in with Google';
        setError(toUserMessage(err, 'Unable to sign in with Google. Please try again.'));
        throw err instanceof Error ? err : new Error(message);
      } finally {
        setLoading(false);
        exchangeInProgressRef.current = false;
      }
    },
    [clients, isConfigured, promptAsync, request]
  );

  const signInWithGoogle = useCallback(async (): Promise<GoogleAuthResult> => {
    return runGoogleAuth(idToken => User.loginViaGoogle(idToken) as Promise<GoogleAuthResult>);
  }, [runGoogleAuth]);

  const linkWithGoogle = useCallback(async (): Promise<GoogleLinkResult> => {
    return runGoogleAuth(idToken => User.linkGoogleProvider(idToken) as Promise<GoogleLinkResult>);
  }, [runGoogleAuth]);

  return {
    ready: isConfigured && !!request,
    isConfigured,
    loading,
    error,
    signInWithGoogle,
    linkWithGoogle,
  };
}
