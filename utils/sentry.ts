import { getConfig } from '@/config/env';
import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { Platform } from 'react-native';
import { captureAnalyticsException, getAnalyticsSessionId } from '@/utils/analytics';
import {
  MAX_SENTRY_VALUE_LENGTH as MAX_BREADCRUMB_VALUE_LENGTH,
  SENSITIVE_SENTRY_KEY_RE as SENSITIVE_BREADCRUMB_KEY_RE,
  normalizeSentryValue,
} from '@/shared/runtime/sentrySanitization.js';

const appConfig = getConfig();
const envDsn = process.env.EXPO_PUBLIC_SENTRY_DSN?.trim() || '';
const configDsn = appConfig.sentryDsn || '';
const SENTRY_DSN = envDsn || configDsn;

const isPlaceholderDsn = (dsn: string) => {
  const lower = dsn.toLowerCase();
  return (
    lower.includes('your-key-here') || !lower.startsWith('http') || !lower.includes('.sentry.io')
  );
};

const shouldUseSentry = !__DEV__ && !!SENTRY_DSN && !isPlaceholderDsn(SENTRY_DSN);
const MOBILE_SERVICE_TAG = 'mobile';
const EXPECTED_AUTH_CONTEXTS = new Set([
  'email-password-login',
  'google-signin',
  'apple-signin',
  'email-signup-attempt',
  'email-signup-final',
  'google-signup',
  'apple-signup',
  'verify-email-resend',
  'verify-email-verify',
  'password_reset_code_request',
  'password_reset_submit',
  'reset_password_screen_submit',
]);

let sentryReady = false;
const SENSITIVE_VALUE_RE =
  /\b(?:sntryu_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+)\b/g;
const MAX_CONTEXT_DEPTH = 3;
const MAX_CONTEXT_KEYS = 25;
const MAX_CONTEXT_ARRAY_ITEMS = 10;

function redactSensitiveString(value: string): string {
  return value.replace(SENSITIVE_VALUE_RE, '[redacted]');
}

function getErrorStatus(error: unknown): number | null {
  const status =
    (error as { status?: unknown; response?: { status?: unknown } } | null | undefined)?.status ??
    (error as { response?: { status?: unknown } } | null | undefined)?.response?.status;
  const numeric = Number(status);
  return Number.isFinite(numeric) ? numeric : null;
}

function getErrorCode(error: unknown): string {
  const candidate =
    (
      error as
        | { code?: unknown; data?: { code?: unknown; error?: unknown; errorCode?: unknown } }
        | null
        | undefined
    )?.code ??
    (
      error as
        | { data?: { code?: unknown; error?: unknown; errorCode?: unknown } }
        | null
        | undefined
    )?.data?.code ??
    (error as { data?: { error?: unknown; errorCode?: unknown } } | null | undefined)?.data
      ?.errorCode ??
    (error as { data?: { error?: unknown } } | null | undefined)?.data?.error;
  return typeof candidate === 'string' ? candidate.trim().toUpperCase() : '';
}

function getErrorMessage(error: unknown): string {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' ? message : '';
}

function isTransientClientTransportError(error: unknown): boolean {
  const status = getErrorStatus(error);
  const message = getErrorMessage(error).toLowerCase();
  return (
    (error as { isNetworkError?: unknown; isTransientAuthError?: unknown } | null | undefined)
      ?.isNetworkError === true ||
    (error as { isTransientAuthError?: unknown } | null | undefined)?.isTransientAuthError ===
      true ||
    status === 0 ||
    status === 408 ||
    status === 502 ||
    status === 503 ||
    message.includes('cannot connect to server') ||
    message.includes('network request failed') ||
    message.includes('request timeout') ||
    message.includes('unable to refresh session right now')
  );
}

function isExpectedAuthUxError(
  error: unknown,
  event?: { tags?: Record<string, unknown> | undefined }
): boolean {
  const context = typeof event?.tags?.context === 'string' ? event.tags.context : '';
  if (!EXPECTED_AUTH_CONTEXTS.has(context)) return false;

  const status = getErrorStatus(error);
  const code = getErrorCode(error);
  const message = getErrorMessage(error).toLowerCase();

  if (status !== null && [400, 401, 403, 404, 409, 422, 429].includes(status)) return true;
  if (
    code === 'EMAIL_ALREADY_REGISTERED' ||
    code === 'TOKEN_ALREADY_USED' ||
    code === 'VERIFY_CODE_EXPIRED' ||
    code === 'VERIFY_CODE_INVALID' ||
    code === 'VERIFY_NO_CODE' ||
    code === 'VERIFY_REQUEST_COOLDOWN' ||
    code === 'VERIFY_REQUEST_RATE_LIMITED' ||
    code === 'RESET_CODE_EXPIRED' ||
    code === 'RESET_CODE_INVALID'
  ) {
    return true;
  }

  return (
    message.includes('invalid email or password') ||
    message.includes('too many login attempts') ||
    message.includes('token already used') ||
    message.includes('email already registered') ||
    message.includes('verification code has expired') ||
    message.includes('invalid verification code') ||
    message.includes('reset code expired') ||
    message.includes('reset code is invalid') ||
    message.includes('account not found')
  );
}

// Geofencing business outcomes from the posting flow. The server returns
// these as `{ error: <CODE>, message }` 403s and every posting screen handles
// them in-line (Alert + setError), but the rejection also leaks to Sentry via
// a floated promise. They are expected states, not product bugs.
const GEOFENCE_BUSINESS_CODES = [
  'POSTING_WINDOW_CLOSED',
  'TOO_FAR_FROM_VENUE',
  'LOCATION_REQUIRED',
  'NO_EVENT_LOCATION',
] as const;

export function isExpectedGeofenceBusinessError(
  error: unknown,
  event?: {
    exception?: { values?: Array<{ value?: string }> };
    tags?: Record<string, unknown>;
  }
): boolean {
  // api/http.ts puts the server's `data.error` code on err.data.error and
  // usually as the Error message itself — getErrorCode covers the former.
  const code = getErrorCode(error);
  if ((GEOFENCE_BUSINESS_CODES as readonly string[]).includes(code)) return true;

  const haystacks: string[] = [getErrorMessage(error)];
  for (const exceptionValue of event?.exception?.values ?? []) {
    if (typeof exceptionValue?.value === 'string') haystacks.push(exceptionValue.value);
  }
  for (const tagValue of Object.values(event?.tags ?? {})) {
    if (typeof tagValue === 'string') haystacks.push(tagValue);
  }
  return haystacks.some(haystack =>
    GEOFENCE_BUSINESS_CODES.some(businessCode => haystack.includes(businessCode))
  );
}

export function initSentry(): boolean {
  const dsn = SENTRY_DSN;
  if (!dsn || dsn === '' || isPlaceholderDsn(dsn)) {
    if (__DEV__) console.warn('Sentry DSN not configured — crash reporting disabled');
    return false;
  }

  if (__DEV__) {
    if (__DEV__) console.log('[sentry] Skipping initialization in development mode');
    return false;
  }

  try {
    const tracesSampleRate = Number(process.env.EXPO_PUBLIC_SENTRY_TRACES_SAMPLE_RATE ?? 0.2);
    Sentry.init({
      dsn,
      environment: appConfig.nodeEnv || 'development',
      debug: __DEV__,
      enableAutoSessionTracking: true,
      tracesSampleRate: Number.isNaN(tracesSampleRate) ? 0.2 : tracesSampleRate,
      beforeSend(event, hint) {
        // Disable error reporting in development to avoid blocking UI
        if (__DEV__) {
          return null; // Drop all events in dev mode
        }
        // A fatal/native event must not disappear because its message or tags
        // happen to contain an expected business-outcome code.
        if (event.level === 'fatal' || (event.platform && event.platform !== 'javascript'))
          return event;
        const originalException = hint?.originalException as unknown;
        // Unauthenticated startup probes to /me are expected; they should not create production issues.
        const customContext = (event.contexts?.custom || {}) as { path?: string };
        const exceptionValue = event.exception?.values?.[0]?.value;
        if (customContext.path === '/me' && exceptionValue === 'Unauthorized') {
          return null;
        }
        // Client transport failures are noisy and usually user/network/transient
        // conditions rather than actionable product bugs.
        if (
          isTransientClientTransportError(originalException) &&
          event.tags?.terminal_transport !== 'true'
        ) {
          return null;
        }
        // Expected auth UX states (invalid credentials, expired/invalid codes,
        // signup conflicts, rate limits) should not page as exceptions.
        if (isExpectedAuthUxError(originalException, event)) {
          return null;
        }
        // Geofencing business outcomes (posting window closed, too far from
        // venue, no GPS fix) are expected 403s already handled in-screen.
        if (isExpectedGeofenceBusinessError(originalException, event)) {
          return null;
        }
        return event;
      },
    });

    sentryReady = true;

    // Tag with platform and version for filtering
    Sentry.setTag('service', MOBILE_SERVICE_TAG);
    Sentry.setTag('platform', Platform.OS);
    Sentry.setTag('app_version', Constants.expoConfig?.version || '1.0.0');
    Sentry.setTag('expo_version', Constants.expoConfig?.sdkVersion || 'unknown');
    Sentry.setTag('ota_update_id', Updates.updateId || 'embedded');
    Sentry.setTag('ota_channel', Updates.channel || 'unknown');
    Sentry.setTag(
      'app_runtime',
      Updates.runtimeVersion || String(Constants.expoConfig?.runtimeVersion || 'unknown')
    );
    return true;
  } catch (error) {
    sentryReady = false;
    // Silently fail in development - Sentry initialization errors are non-critical
    if (__DEV__) {
      if (__DEV__) console.log('[sentry] Init failed (dev mode, ignoring):', error);
    }
    return false;
  }
}

// v1.0.2 pass 9: PII scrubbing for Sentry. Previously we sent raw user_id + email + username,
// which Sentry stores in plaintext and exposes to anyone with project access. Now we only
// send a hashed identifier so cross-error correlation still works without leaking PII.
function hashForSentry(input: string): string {
  // Lightweight FNV-1a 32-bit hash → 8-char hex. No real crypto needed for correlation.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function setUserContext(user: { id: string; email?: string; username?: string } | null) {
  if (!sentryReady) return;
  try {
    if (user) {
      // Hash the id so we can correlate errors per-user without exposing the raw identifier.
      // No email/username sent — those are PII.
      Sentry.setUser({ id: `u_${hashForSentry(user.id)}` });
    } else {
      Sentry.setUser(null);
    }
  } catch {
    // non-critical
  }
}

export function captureException(error: Error | unknown, context?: Record<string, any>) {
  if (
    (isTransientClientTransportError(error) && context?.tags?.terminal_transport !== 'true') ||
    isExpectedAuthUxError(error, context as { tags?: Record<string, unknown> } | undefined) ||
    isExpectedGeofenceBusinessError(
      error,
      context as { tags?: Record<string, unknown> } | undefined
    )
  ) {
    return;
  }

  let eventId: string | undefined;
  if (sentryReady) {
    try {
      Sentry.withScope(scope => {
        const sessionId = getAnalyticsSessionId?.();
        if (sessionId) scope.setTag('posthog_session_id', sessionId);
        scope.setTag('service', MOBILE_SERVICE_TAG);
        if (context) {
          const { tags, fingerprint, ...rest } = context;
          if (
            Array.isArray(fingerprint) &&
            fingerprint.length > 0 &&
            fingerprint.length <= 5 &&
            fingerprint.every(
              value => typeof value === 'string' && value.length > 0 && value.length <= 100
            )
          ) {
            scope.setFingerprint(fingerprint.map(redactSensitiveString));
          }
          if (tags && typeof tags === 'object' && !Array.isArray(tags)) {
            Object.entries(tags).forEach(([key, value]) => {
              if (value !== undefined && value !== null && !SENSITIVE_BREADCRUMB_KEY_RE.test(key)) {
                scope.setTag(key, String(value));
              }
            });
          }
          const sanitizedContext = sanitizeContextData(rest);
          if (sanitizedContext && Object.keys(sanitizedContext).length > 0) {
            scope.setContext('custom', sanitizedContext);
          }
        }
        scope.setTag('platform', Platform.OS);
        eventId = Sentry.captureException(error);
      });
    } catch {
      // Continue to the independent reporter even if Sentry itself fails.
      console.warn('[telemetry] Sentry exception capture failed');
    }
  }
  if (!__DEV__) {
    try {
      captureAnalyticsException(error, {
        ...context,
        ...(eventId ? { sentry_event_id: eventId } : {}),
      });
    } catch {
      console.warn('[telemetry] PostHog exception capture failed');
    }
  }
}

function sanitizeContextValue(value: unknown, depth = 0): unknown {
  if (value == null || typeof value === 'boolean') return value ?? null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 'non-finite';
  if (typeof value === 'string') {
    const redacted = redactSensitiveString(value);
    return redacted.length > MAX_BREADCRUMB_VALUE_LENGTH
      ? `${redacted.slice(0, MAX_BREADCRUMB_VALUE_LENGTH)}...`
      : redacted;
  }
  if (depth >= MAX_CONTEXT_DEPTH) {
    return normalizeSentryValue(value);
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_CONTEXT_ARRAY_ITEMS)
      .map(item => sanitizeContextValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const sanitized = Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, MAX_CONTEXT_KEYS)
        .filter(([, nestedValue]) => typeof nestedValue !== 'undefined')
        .map(([key, nestedValue]) => [
          key,
          SENSITIVE_BREADCRUMB_KEY_RE.test(key)
            ? '[redacted]'
            : sanitizeContextValue(nestedValue, depth + 1),
        ])
    );
    return Object.keys(sanitized).length > 0 ? sanitized : '[empty-object]';
  }
  return normalizeSentryValue(value);
}

function sanitizeContextData(data?: Record<string, any>) {
  if (!data) return undefined;

  const sanitized = Object.fromEntries(
    Object.entries(data)
      .slice(0, MAX_CONTEXT_KEYS)
      .filter(([, value]) => typeof value !== 'undefined')
      .map(([key, value]) => [
        key,
        SENSITIVE_BREADCRUMB_KEY_RE.test(key) ? '[redacted]' : sanitizeContextValue(value),
      ])
  );

  return Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

export function captureBreadcrumb(
  message: string,
  category: string,
  data?: Record<string, any>,
  level: 'fatal' | 'error' | 'warning' | 'info' | 'debug' = 'info'
) {
  const normalizedData = sanitizeContextData(data);

  if (!sentryReady) {
    if (__DEV__) {
      console.debug('[sentry] breadcrumb (dev-only, not sent):', {
        message,
        category,
        level,
        data: normalizedData,
      });
    }
    return;
  }

  try {
    const sessionId = getAnalyticsSessionId?.();
    if (sessionId) Sentry.setTag('posthog_session_id', sessionId);
    Sentry.addBreadcrumb({ message, category, level, data: normalizedData });
  } catch {
    // A diagnostic breadcrumb must never break the UI operation it describes.
    console.warn('[telemetry] Sentry breadcrumb capture failed');
  }
}

export default Sentry;
