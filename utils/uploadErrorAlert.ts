import { toUserMessage } from './toUserMessage';
import { Alert } from 'react-native';
import { router } from 'expo-router';
import { ICLOUD_ERROR_MESSAGE, ICLOUD_ERROR_TITLE, isICloudError } from '@/utils/isICloudError';

type UploadErrorAlertOptions = {
  fallbackTitle?: string;
  fallbackMessage?: string;
  logTag?: string;
};

export function showUploadErrorAlert(
  error: any,
  {
    fallbackTitle = 'Upload Failed',
    fallbackMessage = 'Please try again.',
    logTag = 'upload',
  }: UploadErrorAlertOptions = {}
) {
  if (isICloudError(error)) {
    Alert.alert(ICLOUD_ERROR_TITLE, ICLOUD_ERROR_MESSAGE);
    return;
  }

  const rawMessage = String(error?.message || error || '').trim();
  const status = error?.status;
  const code = String(error?.data?.code || error?.code || '');
  // Transport-layer failures. http.ts stamps offline/DNS/dropped-connection
  // errors with `isNetworkError === true` and `status === 0`, and its message
  // ("Cannot connect to server at <origin URL>…") deliberately does NOT match
  // the loose regex below — so detect the flags first, or an offline upload
  // falls through to the raw-message fallback and prints the origin API URL.
  const isNetwork =
    error?.isNetworkError === true ||
    status === 0 ||
    /network|fetch|failed to fetch|typeerror/i.test(rawMessage);
  const isTimeout = /timeout|timed out|aborted/i.test(rawMessage);
  const isSessionExpired = error?.isSessionExpired === true;
  // v1.0.3: distinguish true session-auth 401s from upstream-provider 401s.
  // The server now reclassifies Cloudinary 401s as 502 with code UPSTREAM_*,
  // but we treat anything with UPSTREAM_ prefix or a 502 from an upload path
  // as upstream regardless of how it got here (defense-in-depth).
  const isUpstreamFailure =
    status === 502 ||
    code.startsWith('UPSTREAM_') ||
    /upload service is (misconfigured|temporarily unavailable)/i.test(rawMessage);
  const isAuth = !isUpstreamFailure && (status === 401 || /unauthoriz/i.test(rawMessage));
  const isServer =
    (typeof status === 'number' && status >= 500 && !isUpstreamFailure) ||
    /HTTP 5\d\d/i.test(rawMessage);
  const isSize = /too large|size|413/i.test(rawMessage);

  // Session expiry is handled centrally by AuthProvider (via sessionEvents):
  // it clears local state, shows a toast, and navigates to /sign-in. Showing
  // a modal that tells the user to "sign out and sign back in" would be
  // redundant and misleading — the app is already doing it for them.
  if (isSessionExpired) {
    if (__DEV__) {
      console.warn(`[${logTag}] Upload aborted — session expired, navigating to sign-in`);
    }
    return;
  }

  const isRateLimited = status === 429 || /too many requests|rate limit/i.test(rawMessage);
  if (isRateLimited) {
    Alert.alert(
      'Too Many Uploads',
      'You have hit the hourly upload limit. Wait a few minutes and try again.'
    );
    return;
  }

  if (isNetwork) {
    // Transport-layer failure (offline, DNS, dropped connection). The underlying
    // http.ts message embeds the origin API URL — surface a generic prompt with
    // NO URL so we never leak infrastructure details to the end user.
    Alert.alert(
      'Connection Problem',
      "Couldn't reach the server. Check your connection and try again."
    );
  } else if (isUpstreamFailure) {
    // Cloudinary or another upstream provider rejected the upload. This is
    // infrastructure — not the user's session. Show a clear retry prompt,
    // never mention signing in/out.
    Alert.alert(
      'Upload Unavailable',
      'Uploads are temporarily unavailable. Please try again in a minute.'
    );
  } else if (isAuth) {
    // A genuine 401 that isn't upstream means the request wasn't authenticated:
    // the user is signed out, or their session lapsed just before this upload.
    // "Try again in a moment" reads like the app is broken — instead point them
    // at signing in. The session-expired path (handled above) already navigates
    // automatically, so anything reaching here needs a manual nudge. Never tell
    // the user to sign OUT manually; the sign-in prompt is the actionable fix.
    Alert.alert(
      'Sign In to Upload',
      'You need to be signed in to upload. Please sign in and try again.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign In', onPress: () => router.push('/sign-in') },
      ]
    );
  } else if (isTimeout) {
    Alert.alert(
      'Upload Timed Out',
      'The upload took too long. Check your connection and try again.'
    );
  } else if (isServer) {
    Alert.alert(
      'Server Error',
      'Uploads are temporarily unavailable. Please try again in a minute.'
    );
  } else if (isSize) {
    Alert.alert('File Too Large', 'Please try a smaller file.');
  } else if (rawMessage) {
    Alert.alert(fallbackTitle, toUserMessage(error, fallbackMessage));
  } else {
    Alert.alert(fallbackTitle, fallbackMessage);
  }

  if (__DEV__) {
    console.warn(`[${logTag}] Upload error:`, { message: rawMessage, status, error });
  }
}
