import { User } from '@/api/entities';
import { getApiBaseUrl } from '@/api/http';
import * as AppleAuthentication from 'expo-apple-authentication';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { toAuthErrorMessage } from '@/utils/toUserMessage';

type AppleAuthResult = Awaited<ReturnType<typeof User.loginViaApple>>;
type AppleLinkResult = Awaited<ReturnType<typeof User.linkAppleProvider>>;

export function useAppleAuth() {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [available, setAvailable] = useState<boolean>(false);

  // Check Apple Auth availability once on mount
  // IMPORTANT: Just checking availability should NOT trigger the auth dialog
  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const isAvailable = await AppleAuthentication.isAvailableAsync();
        if (mounted) {
          setAvailable(Boolean(isAvailable));
          // eslint-disable-next-line no-console
          if (__DEV__) console.log('[Apple Auth] Availability check result:', isAvailable);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        if (__DEV__) console.warn('[Apple Auth] Availability check failed:', err);
        if (mounted) setAvailable(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const signInInProgressRef = useRef(false);

  const runAppleAuth = useCallback(
    async <T>(exchange: (identityToken: string) => Promise<T>): Promise<T> => {
      if (signInInProgressRef.current) {
        // eslint-disable-next-line no-console
        if (__DEV__)
          console.log('[Apple Auth] Sign-in already in progress, skipping duplicate call');
        throw new Error('User canceled Apple sign-in');
      }
      signInInProgressRef.current = true;
      setError(null);
      setLoading(true);
      try {
        // eslint-disable-next-line no-console
        if (__DEV__) console.log('[Apple Auth] signInWithApple called, available:', available);

        // `available === false` from AppleAuthentication.isAvailableAsync()
        // covers more than just simulators on iOS hardware: a real device
        // can also report unavailable when the user isn't signed into iCloud,
        // Screen Time / parental controls block Sign in with Apple, the
        // iCloud account is in a restricted region, or the iOS version is
        // too old. Treating every false-available state as "simulator" mis-
        // labels real-device failures. Keep the mock-credential branch only
        // for local-dev use and surface a device-accurate message for prod.
        const appleNotAvailable = Platform.OS === 'ios' && !available;
        const apiBase = getApiBaseUrl();
        const isLocalDev = apiBase.includes('localhost') || apiBase.includes('127.0.0.1');
        if (appleNotAvailable && !isLocalDev) {
          throw new Error(
            'Apple Sign-In is not available on this device. Make sure you are signed into iCloud and Sign in with Apple is enabled, or use email/password.'
          );
        }

        let credential;
        if (appleNotAvailable) {
          // Local dev only: use a mock credential so simulator dev can iterate
          // on the post-auth UI without needing a real Apple sign-in flow.
          // eslint-disable-next-line no-console
          if (__DEV__)
            console.log('[Apple Auth] Using simulator mock credential (local dev server)');
          credential = {
            user: 'sim-dev-apple-user',
            authorizationCode: null,
            identityToken: null,
            email: 'simulator@appleid.local',
            fullName: null,
            state: null,
            realUserStatus: 1,
          };
        } else {
          const attemptNativeSignIn = async (scopes: any[]) => {
            // eslint-disable-next-line no-console
            if (__DEV__) console.log('[Apple Auth] Attempting native sign-in with scopes:', scopes);
            return AppleAuthentication.signInAsync({ requestedScopes: scopes });
          };

          try {
            // eslint-disable-next-line no-console
            if (__DEV__) console.log('[Apple Auth] Starting Apple authentication dialog...');
            credential = await attemptNativeSignIn([
              AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
              AppleAuthentication.AppleAuthenticationScope.EMAIL,
            ]);
            // eslint-disable-next-line no-console
            if (__DEV__) console.log('[Apple Auth] Got credential from native sign-in');
          } catch (appleErr: any) {
            const errCode = String(appleErr?.code || '').toLowerCase();
            const errMsg = String(appleErr?.message || '').toLowerCase();
            const isCanceled =
              errCode.includes('canceled') ||
              errCode.includes('cancelled') ||
              errCode === 'err_request_canceled' ||
              errMsg.includes('canceled') ||
              errMsg.includes('cancelled') ||
              errMsg.includes('user canceled');

            if (isCanceled) {
              // eslint-disable-next-line no-console
              if (__DEV__) console.log('[Apple Auth] User canceled sign-in (not an error)');
              throw new Error('User canceled Apple sign-in');
            }

            const isSimulatorUnknown =
              errCode === 'err_request_unknown' || errMsg.includes('unknown reason');
            if (__DEV__ && Platform.OS === 'ios' && isSimulatorUnknown) {
              // eslint-disable-next-line no-console
              if (__DEV__) console.log('[Apple Auth] Simulator fallback (native auth unavailable)');
              credential = {
                user: 'sim-dev-apple-user',
                authorizationCode: null,
                identityToken: null,
                email: 'simulator@appleid.local',
                fullName: null,
                state: null,
                realUserStatus: 1,
              };
            } else {
              try {
                credential = await attemptNativeSignIn([]);
              } catch (retryErr: any) {
                const retryCode = String(retryErr?.code || '').toLowerCase();
                const retryMsg = String(retryErr?.message || '').toLowerCase();
                const isRetryCanceled =
                  retryCode.includes('canceled') ||
                  retryCode.includes('cancelled') ||
                  retryCode === 'err_request_canceled' ||
                  retryMsg.includes('canceled') ||
                  retryMsg.includes('cancelled');
                if (isRetryCanceled) {
                  throw new Error('User canceled Apple sign-in');
                }
                throw retryErr;
              }
            }
          }
        }

        const fallbackToken =
          credential.authorizationCode || (credential.user ? `sim-${credential.user}` : null);
        const identityToken = credential.identityToken || fallbackToken;
        if (!identityToken) {
          throw new Error('Apple sign-in did not provide a token');
        }

        let res: T | null = null;
        let attempts = 0;
        const maxAttempts = 3;
        let lastError: any = null;

        while (attempts < maxAttempts) {
          try {
            res = await exchange(identityToken);
            return res;
          } catch (networkErr: any) {
            lastError = networkErr;
            attempts++;
            const isRetryable =
              networkErr?.message?.includes('Network request failed') ||
              networkErr?.message?.includes('timeout') ||
              networkErr?.message?.includes('server did not respond') ||
              networkErr?.status === 408 ||
              networkErr?.status === 0 ||
              networkErr?.status === 500 ||
              networkErr?.status === 502 ||
              networkErr?.status === 503;

            if (isRetryable && attempts < maxAttempts) {
              const delayMs = 1000 * Math.pow(2, attempts - 1);
              // eslint-disable-next-line no-console
              if (__DEV__)
                console.log(
                  `[Apple Auth] Retry attempt ${attempts}/${maxAttempts} after ${delayMs}ms`
                );
              await new Promise(resolve => setTimeout(resolve, delayMs));
            } else {
              break;
            }
          }
        }

        if (lastError) {
          throw lastError;
        }
        throw new Error('Invalid login response from server');
      } catch (err: any) {
        const message = err?.message || 'Apple sign-in failed';
        const normalizedMessage = String(message).toLowerCase();
        const code = String(err?.code || '').toLowerCase();

        const isCanceled =
          message.toLowerCase().includes('cancel') ||
          code.includes('canceled') ||
          code.includes('cancelled') ||
          code === 'err_request_canceled';

        if (isCanceled) {
          // eslint-disable-next-line no-console
          if (__DEV__) console.log('[Apple Auth] User canceled sign-in (not showing error)');
          throw err;
        }

        if (!(__DEV__ && Platform.OS === 'ios')) {
          // eslint-disable-next-line no-console
          if (__DEV__) console.error('[Apple Auth] Error:', err);
        } else {
          // eslint-disable-next-line no-console
          if (__DEV__)
            console.log('[Apple Auth] Native Apple auth unavailable (expected in simulator)');
        }

        if (__DEV__ && Platform.OS === 'ios') {
          // eslint-disable-next-line no-console
          if (__DEV__)
            console.log('[Apple Auth] Native auth not available in simulator - expected behavior');
          throw err;
        }

        if (err?.isNetworkError === true || message.startsWith('Cannot connect to server')) {
          // Host fingerprint on-screen; keep the raw error for the throw.
          setError(toAuthErrorMessage(err));
          throw err;
        }

        if (
          normalizedMessage.includes('timeout') ||
          normalizedMessage.includes('server did not respond')
        ) {
          const friendlyMessage = `Cannot connect to server at ${getApiBaseUrl()}. Please check your internet connection and try again.`;
          const networkErr: any = new Error(friendlyMessage);
          networkErr.isNetworkError = true;
          networkErr.status = err?.status ?? 0;
          networkErr.code = err?.code;
          // Display the host fingerprint, not the raw origin URL; the thrown
          // error keeps the full message for the retry contract.
          setError(toAuthErrorMessage(networkErr));
          throw networkErr;
        }

        const friendlyHints =
          '\nTips: Ensure you are signed into iCloud on this device, Two‑Factor Authentication is enabled for your Apple ID (Settings > [your name] > Password & Security), and you have a working network connection.';

        if (normalizedMessage.includes('authorization') || normalizedMessage.includes('unknown')) {
          const friendly = 'Apple authorization failed.' + friendlyHints;
          setError(friendly);
          throw new Error(friendly);
        }

        setError(toAuthErrorMessage(err, 'Apple sign-in failed. Please try again.'));
        throw err;
      } finally {
        setLoading(false);
        signInInProgressRef.current = false;
      }
    },
    [available]
  );

  const signInWithApple = useCallback(async (): Promise<AppleAuthResult> => {
    return runAppleAuth(
      identityToken => User.loginViaApple(identityToken) as Promise<AppleAuthResult>
    );
  }, [runAppleAuth]);

  const linkWithApple = useCallback(async (): Promise<AppleLinkResult> => {
    return runAppleAuth(
      identityToken => User.linkAppleProvider(identityToken) as Promise<AppleLinkResult>
    );
  }, [runAppleAuth]);

  return {
    signInWithApple,
    linkWithApple,
    loading,
    error,
    ready: available,
  };
}
