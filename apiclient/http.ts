import { throwIfUploadAborted, waitForUploadRetry } from '@/utils/resumableUpload';
/* eslint-disable @typescript-eslint/no-explicit-any, no-console */
// TODO(transport-hardening): Remove this grandfather when api/http gets typed
// request/response generics and a typed transport error contract. The current
// `any` usage is concentrated at the network boundary and is pre-existing debt.

import { captureBreadcrumb, captureException } from '@/utils/sentry';
import Constants from 'expo-constants';
import {
  isEmailVerificationRequiredError,
  openVerificationGate,
} from '@/hooks/useVerificationGate';
import { Platform } from 'react-native';
import { emitSessionExpired } from '@/utils/sessionEvents';
import { getClientDeviceId } from './deviceIdentity';

export type HttpBehaviorOptions = {
  omitAuthToken?: boolean;
  skipAuthRetry?: boolean;
  skipVerificationGate?: boolean;
};

export type RefreshOutcome =
  | { accessToken: string; reason: 'success' }
  | { accessToken: null; reason: 'missing' | 'auth' | 'network' | 'unknown'; error?: unknown };

// Default timeouts (ms) — kept at the module top so the values are reviewed
// together rather than spread across six call sites. GET gets longer
// because it can legitimately block on slow feeds; mutations get shorter
// so a stuck server fails fast and the caller can show a retry button.
const DEFAULT_GET_TIMEOUT_MS = 30_000;
const DEFAULT_MUTATION_TIMEOUT_MS = 15_000;
const LONG_POST_TIMEOUT_MS = 180_000; // 3 minutes — heavy uploads / report generation

let tokenCache: string | null = null;
export function setAuthToken(token: string | null) {
  tokenCache = token || null;
}
export function clearAuthToken() {
  tokenCache = null;
  // The cached refresh result belongs to the previous identity — if user A's
  // refresh is still cached when user B signs in, user B's first 401 would
  // reuse it and execute requests under user A's token. Drop both the promise
  // and its expiry timer so the next 401 starts a fresh refresh.
  refreshPromise = null;
  if (refreshCacheTimer) {
    clearTimeout(refreshCacheTimer);
    refreshCacheTimer = null;
  }
}
export function getAuthToken(): string | null {
  return tokenCache;
}

// Refresh lock: prevents concurrent refresh attempts when multiple 401s fire simultaneously.
// v1.0.2: Keep the resolved result cached for REFRESH_CACHE_TTL_MS so that late-arriving
// 401s reuse the fresh token instead of attempting a second refresh with a rotated
// (now-invalid) token. This prevents the logout-on-concurrent-401 race condition.
let refreshPromise: Promise<RefreshOutcome> | null = null;
let refreshCacheTimer: ReturnType<typeof setTimeout> | null = null;
const REFRESH_CACHE_TTL_MS = 5_000;

async function getRequestAuthToken(): Promise<string | null> {
  const inMemory = getAuthToken();
  if (inMemory) return inMemory;

  // Hydrate from persisted storage when a protected request fires before
  // AuthProvider/bootstrap has populated the in-memory token cache.
  // Keep this lazy to avoid a static cycle with api/auth.ts.
  const { auth } = await import('./auth' as string);
  return (await auth.getToken()) || null;
}

export async function refreshAccessTokenWithCache(): Promise<RefreshOutcome> {
  const { auth } = await import('./auth' as string);
  return attemptTokenRefreshWithCache(() => auth.refreshToken());
}

export async function getAccessTokenForRequest(options?: {
  allowRefresh?: boolean;
}): Promise<string | null> {
  const token = await getRequestAuthToken();
  if (token || !options?.allowRefresh) return token;
  const refreshResult = await refreshAccessTokenWithCache();
  return refreshResult?.accessToken ?? null;
}

/**
 * Coalesce concurrent refresh attempts behind a single promise and keep
 * the resolved outcome cached for REFRESH_CACHE_TTL_MS so late-arriving
 * 401s reuse the fresh token instead of triggering a second refresh
 * with a now-rotated (invalid) refresh token.
 *
 * Takes the refresh implementation as a parameter so this helper stays
 * free of a static dependency on api/auth — the 401 handler still lazy-
 * imports auth to keep the circular dependency broken.
 */
async function attemptTokenRefreshWithCache(
  refresh: () => Promise<RefreshOutcome>
): Promise<RefreshOutcome> {
  if (!refreshPromise) {
    refreshPromise = refresh().finally(() => {
      if (refreshCacheTimer) clearTimeout(refreshCacheTimer);
      refreshCacheTimer = setTimeout(() => {
        refreshPromise = null;
        refreshCacheTimer = null;
      }, REFRESH_CACHE_TTL_MS);
    });
  }
  return (await refreshPromise) as RefreshOutcome;
}

// GET request deduplication: coalesce concurrent identical GET requests into a single network call.
// Prevents duplicate fetches when multiple components mount simultaneously.
const inflightGets = new Map<string, Promise<any>>();

// Track every in-flight request's AbortController so `abortAllInflight()` can
// cancel them on sign-out. Without this, a request initiated under user A's
// token could resolve after user B signed in on the same device, and any
// lingering subscriber to that promise would observe user A's response.
const inflightControllers = new Set<AbortController>();

/**
 * Abort every in-flight HTTP request and clear the GET dedup map.
 * Call on sign-out and session-expiry so user A's pending responses cannot
 * arrive and be observed by user B who signs in next on the same device.
 * Called from context/AuthProvider.tsx during teardown.
 */
export function abortAllInflight(reason = 'sign_out'): void {
  for (const controller of inflightControllers) {
    try {
      controller.abort(reason);
    } catch {
      // abort() is safe to call even if already aborted; swallow.
    }
  }
  inflightControllers.clear();
  inflightGets.clear();
}

/**
 * Spot Railway's Correlation Key marker (27 uppercase alphanumeric
 * chars, optionally prefixed with "Correlation Key:") in a response
 * body. Railway's infra error pages always include one, so this is a
 * strong signal the response came from Railway's edge and not the app.
 */
function hasRailwayCorrelationKey(body: unknown): boolean {
  if (typeof body !== 'string') return false;
  return /Correlation Key:?\s*[A-Z0-9]{27}/i.test(body) || /[A-Z0-9]{27}/.test(body);
}

/**
 * Classify an HTTP 502 response as Railway's infrastructure error page
 * (as opposed to an application-level 502). Used on the fetch-response
 * path: if true, the thrown error is marked `isRailwayErrorPage` so the
 * catch block knows to surface a user-friendly "temporarily unavailable"
 * message instead of parsing the HTML body as JSON.
 *
 * A 502 is considered Railway-infra when the content-type is HTML, or
 * the body contains any of the well-known marker strings, or a
 * correlation key is present. Non-502 responses are never classified as
 * infra errors here.
 */
function isRailwayInfrastructureError(status: number, contentType: string, body: unknown): boolean {
  if (status !== 502) return false;
  if (contentType.includes('text/html')) return true;
  if (typeof body !== 'string') return false;
  return (
    body.includes('Bad Gateway') ||
    body.includes('502') ||
    body.includes('Correlation Key') ||
    hasRailwayCorrelationKey(body)
  );
}

function isHandledClientHttpStatus(status: unknown): boolean {
  const numeric = Number(status);
  return Number.isFinite(numeric) && numeric >= 400 && numeric < 500;
}

function shouldCaptureTerminalHttpError(error: unknown): boolean {
  const status = Number((error as { status?: unknown } | null | undefined)?.status);
  if (!Number.isFinite(status)) return true;
  if (isHandledClientHttpStatus(status)) return false;
  return status >= 500;
}

function parseResponseBody(text: string, contentType: string, status: number): any {
  if (!contentType.includes('application/json')) return text;
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    // Error responses still surface their HTTP status when their body is malformed.
    if (status < 200 || status >= 300) return null;
    // Never include the body or parser exception: either can contain private data.
    // Preserve the actual status; a protocol failure is not a retryable HTTP 502.
    throw Object.assign(new Error('The server returned an invalid response. Please try again.'), {
      name: 'HttpProtocolError',
      code: 'INVALID_JSON_RESPONSE',
      isProtocolError: true,
      status,
    });
  }
}

/**
 * If an identical GET (same path + auth token) is already in flight,
 * return its pending promise so callers share the response. Otherwise
 * run `exec()`, cache the promise under `dedupeKey` until it settles,
 * and return it.
 *
 * The dedup key includes the auth token so two different users don't
 * accidentally share a response. Anonymous callers collapse onto a
 * single "anon" slot, which is intentional — the response is not
 * user-specific in that case.
 */
function executeOrReuseInflightGet(
  path: string,
  token: string | null,
  exec: () => Promise<any>
): Promise<any> {
  const dedupeKey = `${path}::${token || 'anon'}`;
  const existing = inflightGets.get(dedupeKey);
  if (existing) return existing;
  const promise = exec().finally(() => inflightGets.delete(dedupeKey));
  inflightGets.set(dedupeKey, promise);
  return promise;
}

export function getApiBaseUrl(): string {
  const PRODUCTION_URL = 'https://api-production-8ac3.up.railway.app';
  const processEnv =
    typeof process !== 'undefined' && process?.env
      ? (process.env as Record<string, string | undefined>)
      : {};
  const processUseLocalApi = processEnv.EXPO_PUBLIC_USE_LOCAL_API;
  const constantsUseLocalApi = Constants.expoConfig?.extra?.EXPO_PUBLIC_USE_LOCAL_API;
  const processForceRemoteApi = processEnv.EXPO_PUBLIC_FORCE_REMOTE_API;
  const constantsForceRemoteApi = Constants.expoConfig?.extra?.EXPO_PUBLIC_FORCE_REMOTE_API;
  const useLocalApiRaw = processUseLocalApi || constantsUseLocalApi;
  const forceRemoteApiRaw = processForceRemoteApi || constantsForceRemoteApi;
  const useLocalApi =
    typeof useLocalApiRaw === 'string'
      ? ['1', 'true', 'yes', 'on'].includes(useLocalApiRaw.toLowerCase())
      : false;
  const forceRemoteApi =
    typeof forceRemoteApiRaw === 'string'
      ? ['1', 'true', 'yes', 'on'].includes(forceRemoteApiRaw.toLowerCase())
      : true;
  const processEnvUrl = processEnv.EXPO_PUBLIC_API_URL;
  const constantsEnvUrl =
    Constants.expoConfig?.extra?.EXPO_PUBLIC_API_URL || Constants.expoConfig?.extra?.apiUrl;
  const envUrl = processEnvUrl || constantsEnvUrl;
  const normalizedEnvUrl = envUrl?.trim().replace(/\/$/, '');
  const isLocalhostEnv = normalizedEnvUrl
    ? /(^http:\/\/localhost)|(^http:\/\/127\.0\.0\.1)/.test(normalizedEnvUrl)
    : false;
  const browserHostname =
    typeof window !== 'undefined' && typeof window.location?.hostname === 'string'
      ? window.location.hostname
      : null;
  const localWindowHost =
    browserHostname && /^(localhost|127\.0\.0\.1)$/.test(browserHostname) ? browserHostname : null;
  const localDevUrl = localWindowHost
    ? `http://${localWindowHost}:4000`
    : Platform.OS === 'android'
      ? 'http://10.0.2.2:4000'
      : 'http://localhost:4000';
  if (__DEV__ && useLocalApi) {
    return localDevUrl;
  }
  const preferLocalDevUrl =
    __DEV__ &&
    !forceRemoteApi &&
    (!normalizedEnvUrl || isLocalhostEnv || normalizedEnvUrl === PRODUCTION_URL);
  const finalUrl = preferLocalDevUrl
    ? localDevUrl
    : normalizedEnvUrl
      ? !isLocalhostEnv || __DEV__
        ? normalizedEnvUrl
        : PRODUCTION_URL
      : __DEV__ && !forceRemoteApi && localDevUrl
        ? localDevUrl
        : PRODUCTION_URL;
  const isCustom = finalUrl !== PRODUCTION_URL;

  if (__DEV__ && !('__VH_LOGGED_API_BASE' in (globalThis as any))) {
    (globalThis as any).__VH_LOGGED_API_BASE = true;
    if (__DEV__) console.log('[http] API base:', finalUrl, isCustom ? '(custom)' : '(production)');
  }

  return finalUrl;
}

function getBaseUrl(): string {
  return getApiBaseUrl();
}

async function request(
  path: string,
  options: RequestInit = {},
  timeoutMs: number = DEFAULT_GET_TIMEOUT_MS,
  retries: number = 1,
  behavior: HttpBehaviorOptions = {}
): Promise<any> {
  const externalSignal = options.signal ?? undefined;
  throwIfUploadAborted(externalSignal);
  const base = getBaseUrl();
  const telemetryPath = path.split(/[?#]/, 1)[0];
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as any),
  };
  const token = behavior.omitAuthToken ? null : await getAccessTokenForRequest();
  const deviceId = await getClientDeviceId();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (deviceId) headers['X-VarsityHub-Device-Id'] = deviceId;
  // Avoid stale caches/Etags for personalized endpoints
  if (
    /^\/(me|auth\/me|rsvps|follows|support|search|users|teams|team-memberships|team-invites|events\/)/.test(
      path
    )
  ) {
    headers['Cache-Control'] = headers['Cache-Control'] || 'no-store';
    headers['Pragma'] = headers['Pragma'] || 'no-cache';
    headers['If-None-Match'] = headers['If-None-Match'] || '';
  }

  // Add timeout to prevent hanging requests. Register the controller with
  // the inflight set so abortAllInflight() on sign-out can cancel this
  // request before user A's response leaks into user B's session.
  throwIfUploadAborted(externalSignal);
  const controller = new AbortController();
  const abortExternal = () => controller.abort();
  externalSignal?.addEventListener('abort', abortExternal, { once: true });
  inflightControllers.add(controller);
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // HTTP request initiated
    captureBreadcrumb(`HTTP ${options.method || 'GET'} ${telemetryPath}`, 'http', {
      base,
      path: telemetryPath,
      hasAuth: !!token,
    });
    const res = await fetch(base + path, {
      ...options,
      headers,
      signal: controller.signal,
    });
    throwIfUploadAborted(externalSignal);
    // HTTP response received
    captureBreadcrumb(`HTTP ${res.status} ${telemetryPath}`, 'http', {
      status: res.status,
      path: telemetryPath,
    });

    // Handle 304 Not Modified: return a special object or null.
    // The caller can then decide whether to use cached data or ignore.
    if (res.status === 304) {
      return { _status: 304, _isNotModified: true };
    }

    const text = await res.text();
    throwIfUploadAborted(externalSignal);
    const ct = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
    const data = parseResponseBody(text, ct, res.status);

    if (!res.ok) {
      const isRailwayErrorPage = isRailwayInfrastructureError(res.status, ct, data);
      const isHtmlError = ct.includes('text/html') && typeof data === 'string';
      const msg = ct.includes('application/json')
        ? data && (data.error || data.message)
        : isRailwayErrorPage
          ? 'Server temporarily unavailable'
          : isHtmlError
            ? res.status === 404
              ? 'Endpoint not found. Please update the app.'
              : `Request failed (${res.status}). Please try again.`
            : typeof data === 'string'
              ? data
              : null;

      const err: any = new Error(msg || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      err.isRailwayErrorPage = isRailwayErrorPage; // Flag for retry logic

      if (isEmailVerificationRequiredError(err.status, data) && !behavior.skipVerificationGate) {
        const verified = await openVerificationGate();
        if (verified) {
          return request(path, options, timeoutMs, retries, {
            ...behavior,
            skipVerificationGate: true,
          });
        }
      }

      // On 401, attempt a token refresh before giving up.
      // Do not clear on 403 (forbidden) because role-based endpoints can return 403 for valid sessions.
      if (err.status === 401 && token && !behavior.skipAuthRetry) {
        // Use the shared refresh cache so concurrent 401s across transports
        // coalesce onto one refresh attempt.
        const { auth } = await import('./auth' as string);
        const refreshResult = await refreshAccessTokenWithCache();
        const newToken = refreshResult?.accessToken ?? null;

        if (newToken) {
          // Retry the original request with the fresh token
          headers['Authorization'] = `Bearer ${newToken}`;
          const retryRes = await fetch(base + path, {
            ...options,
            headers,
            signal: controller.signal,
          });
          if (retryRes.ok) {
            const retryText = await retryRes.text();
            const retryCt =
              (retryRes.headers && retryRes.headers.get && retryRes.headers.get('content-type')) ||
              '';
            return parseResponseBody(retryText, retryCt, retryRes.status);
          }
          // Retry also failed — parse actual retry response and throw its error
          const retryText = await retryRes.text().catch(() => '');
          const retryCt =
            (retryRes.headers && retryRes.headers.get && retryRes.headers.get('content-type')) ||
            '';
          let retryData: any = null;
          if (retryCt.includes('application/json')) {
            try {
              retryData = retryText ? JSON.parse(retryText) : null;
            } catch {
              retryData = null;
            }
          } else {
            retryData = retryText || null;
          }
          const retryMsg = retryCt.includes('application/json')
            ? retryData && (retryData.error || retryData.message)
            : retryRes.status === 401
              ? 'Session expired'
              : null;
          const retryErr: any = new Error(retryMsg || `HTTP ${retryRes.status}`);
          retryErr.status = retryRes.status;
          retryErr.data = retryData;
          // A 401 after a successful refresh means the session is no longer usable.
          // Clear persisted auth state, emit a session-expired event so
          // AuthProvider routes the user to /sign-in, and DO NOT throw to
          // the caller. Throwing causes per-screen catch blocks (admin-ads,
          // admin-dashboard, et al.) to render Alert.alert('Error', e.message)
          // which stacks a native modal on top of the AuthProvider redirect
          // — the duplicate-session-expired UX the user has hit repeatedly.
          // The pending Promise resolves never; the screen unmounts during
          // redirect, releasing React refs. Memory impact is the orphaned
          // microtask reference, which is negligible.
          if (retryRes.status === 401) {
            await auth.clearTokensOnly();
            emitSessionExpired('token_rejected_after_refresh');
            return new Promise(() => {}); // intentional never-resolves
          }
          throw retryErr;
        }

        // Refresh failed. Only clear auth state on explicit auth failures.
        // Same contract as the retry-401 branch above: emit the event and
        // hang the Promise so per-screen catches don't stack a native Alert
        // on top of AuthProvider's redirect.
        if (refreshResult?.reason === 'auth' || refreshResult?.reason === 'missing') {
          await auth.clearTokensOnly();
          emitSessionExpired(
            refreshResult.reason === 'missing' ? 'refresh_missing' : 'refresh_failed'
          );
          return new Promise(() => {}); // intentional never-resolves
        }

        const refreshError = refreshResult && 'error' in refreshResult ? refreshResult.error : err;

        const transientRefreshErr: any = new Error(
          'Unable to refresh session right now. Please try again.'
        );
        transientRefreshErr.status = 503;
        transientRefreshErr.data = { error: 'Session refresh unavailable' };
        transientRefreshErr.isTransientAuthError = true;
        transientRefreshErr.refreshFailureReason = refreshResult?.reason || 'unknown';
        transientRefreshErr.originalStatus = err.status;
        transientRefreshErr.originalError = refreshError;
        throw transientRefreshErr;
      }
      throw err;
    }
    return data;
  } catch (error: any) {
    clearTimeout(timeoutId);
    inflightControllers.delete(controller);
    throwIfUploadAborted(externalSignal);
    if (error.isProtocolError) {
      captureException(error, {
        path: telemetryPath,
        method: options.method || 'GET',
      });
      throw error;
    }
    // Suppress verbose logging for expected auth errors in dev mode
    const isAuthError = path.includes('/auth/') || path.includes('/me');
    const isAbortError = error.name === 'AbortError';
    const isExpectedDevError =
      __DEV__ &&
      isAuthError &&
      (error.status === 401 || error.status === 408 || error.status === 400);
    const isExpectedAbortInDev = __DEV__ && isAbortError;

    // Suppress logging for known missing endpoints
    const isKnownMissingEndpoint =
      path.includes('/geocoding/autocomplete') ||
      path.includes('/posts/trending') ||
      (path.includes('/users') && error.status === 403) ||
      (path === '/me' && error.status === 401) ||
      // Public user profile lookups that return 404 are expected (user deleted/not found)
      (/^\/users\/[^/]+$/.test(path) && error.status === 404) ||
      (path.includes('/notifications') && error.status === 401);

    let capturedResponseError = false;

    // Enhanced error logging with more context
    if (!isExpectedDevError && !isKnownMissingEndpoint && !isExpectedAbortInDev) {
      const errorDetails = {
        url: base + path,
        method: options.method || 'GET',
        status: error.status,
        message: error.message,
        name: error.name,
        ...(error.data && { responseData: error.data }),
      };
      if (__DEV__) console.error('[http] Request failed:', errorDetails);

      // Capture non-network errors to Sentry (network errors already handled below)
      if (error.status && error.status >= 500) {
        captureException(error, {
          tags: { component: 'http-client', endpoint: path },
          extra: errorDetails,
        });
        capturedResponseError = true;
      }
    }
    if (isExpectedAbortInDev) {
      console.debug(`[http] Request timed out: ${path}`);
    }

    // Only retry non-idempotent methods (POST/PUT/PATCH/DELETE) for a narrow
    // allowlist of safe auth endpoints. A timed-out or network-failed request
    // may have already been processed server-side (e.g. a verification email
    // already sent, a post already created); blindly retrying it duplicates
    // the mutation. Computed once here so the 502, timeout, and network-error
    // branches below all share the same classification.
    const method = (options.method || 'GET').toUpperCase();
    const isSafeMethod = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
    const isSafeAuthEndpoint =
      path.includes('/auth/refresh') ||
      path.includes('/auth/login') ||
      path.includes('/auth/google') ||
      path.includes('/auth/apple') ||
      path === '/auth/me' ||
      path === '/me';
    const isRetryable = isSafeMethod || isSafeAuthEndpoint;

    // Handle 502 Bad Gateway errors with retry - backend may be temporarily down
    // Railway infrastructure errors show HTML error pages with Correlation Keys
    // Since ALL our API calls go to Railway, ANY 502 error is a Railway infrastructure issue
    if (error.status === 502 || error.isRailwayErrorPage) {
      // Use the shared correlation-key check so we classify consistently with
      // the response-handler path. NOTE: this catch-block treats any 502 (or a
      // previously-flagged Railway page) as infra — it's more permissive than
      // the strict classifier above, by design.
      const hasCorrelationKey = hasRailwayCorrelationKey(error.data);

      // ALL 502 errors from our Railway backend should be treated as infrastructure errors
      // This ensures maximum retries and proper handling
      const isRailwayInfraError =
        error.status === 502 || error.isRailwayErrorPage || hasCorrelationKey;

      if (__DEV__)
        console.error(
          '[http] 502 Bad Gateway on',
          path,
          '- Railway infra error:',
          isRailwayInfraError,
          '- retries left:',
          retries
        );
      captureException(error, {
        tags: {
          component: 'http-client',
          endpoint: path,
          errorType: 'bad-gateway',
          railwayInfraError: String(isRailwayInfraError),
        },
        extra: {
          path,
          method: options.method || 'GET',
          base,
          retries,
          isRailwayErrorPage: error.isRailwayErrorPage,
          hasCorrelationKey,
        },
      });

      // v1.0.2: Only retry 502s for idempotent requests (GET) or safe auth endpoints.
      // Retrying POST/PUT/DELETE/PATCH mutations on 502 can create duplicate records
      // (posts, payments, RSVPs) because the original request may have succeeded on
      // the server even though Railway returned a 502 to the client.
      // (method/isSafeMethod/isSafeAuthEndpoint/isRetryable are computed once, above.)
      if (!isRetryable) {
        if (__DEV__)
          console.warn(
            `[http] 502 on non-idempotent ${method} ${path} — NOT retrying to avoid duplicate mutations`
          );
        throw error;
      }

      // For retryable requests: Railway infrastructure can be temporarily unstable.
      // Critical endpoints still have a higher 502 ceiling here, but the caller's
      // retry budget remains the real cap on total attempts.
      const isCriticalEndpoint =
        path.includes('/auth/') || path.includes('/me') || path.includes('/notifications');
      const maxRetriesFor502 = isRailwayInfraError
        ? isCriticalEndpoint
          ? 5
          : 4 // More retries for Railway infra errors
        : isCriticalEndpoint
          ? 3
          : 2; // Standard retries for app-level 502
      const effectiveRetries = Math.min(retries, maxRetriesFor502);

      if (effectiveRetries > 0) {
        // Longer delays for Railway infrastructure errors (they need more time to recover)
        const baseDelay = isRailwayInfraError ? 1000 : 500;
        const retryCount = maxRetriesFor502 - effectiveRetries;
        const delay = Math.min(3000, baseDelay * Math.pow(2, retryCount)); // Exponential backoff

        if (__DEV__)
          console.log(
            `[http] Retrying 502 Bad Gateway after ${delay}ms... (${effectiveRetries}/${maxRetriesFor502} retries left)`
          );
        await waitForUploadRetry(delay, externalSignal);
        // Retry with original retries count but ensure we don't exceed maxRetriesFor502
        return request(
          path,
          options,
          timeoutMs,
          Math.min(retries - 1, maxRetriesFor502 - 1),
          behavior
        );
      }

      // If all retries exhausted, provide user-friendly error
      const err: any = new Error(
        isRailwayInfraError
          ? 'Our servers are temporarily unavailable. Please try again in a few moments.'
          : 'Server temporarily unavailable. Please try again in a moment.'
      );
      err.status = 502;
      err.data = error.data;
      err.isRailwayErrorPage = error.isRailwayErrorPage;
      throw err;
    }

    // Handle 429 Rate Limit errors — never retry, throw immediately.
    // Retrying would just extend the wait and make things worse (retryAfter can be 900s+).
    if (error.status === 429) {
      const retryAfter = typeof error.data?.retryAfter === 'number' ? error.data.retryAfter : null;
      const msg =
        retryAfter && retryAfter > 0 && retryAfter <= 300
          ? `Too many attempts. Please try again in ${retryAfter} second${retryAfter === 1 ? '' : 's'}.`
          : 'Too many attempts. Please wait a moment and try again.';
      const err: any = new Error(msg);
      err.status = 429;
      err.data = error.data;
      err.retryAfter = retryAfter;
      throw err;
    }

    if (error.name === 'AbortError') {
      const err: any = new Error('Request timeout - server did not respond');
      err.status = 408;
      if (!isExpectedDevError && !__DEV__) {
        captureException(err, { path, base, timeoutMs, method: options.method || 'GET' });
      }
      // Retry once on timeout if allowed — but never for non-idempotent
      // methods outside the safe auth allowlist: a timed-out request may
      // have already been processed server-side (see isRetryable above).
      if (retries > 0 && isRetryable) {
        // Exponential backoff: small delay before retry
        await new Promise(r => setTimeout(r, Math.min(1000, timeoutMs * 0.1)));
        return request(path, options, timeoutMs, retries - 1, behavior);
      }
      throw err;
    }

    // Add more context to network errors with better retry logic
    if (
      error.message === 'Network request failed' ||
      error.message?.includes('NetworkError') ||
      error.message?.includes('Failed to fetch') ||
      // iOS RN response-body read race: the native blob backing the response
      // was released before res.text() read it (typically right after a JS
      // reload, e.g. an OTA applying on cold start). Transient — retryable.
      error.message?.includes('Unable to resolve data for blob')
    ) {
      // Always show production server error (we never use localhost)
      const errorMessage = `Cannot connect to server at ${base}. Please check your internet connection and try again.`;

      const err: any = new Error(errorMessage);
      err.originalError = error;
      err.status = 0;
      err.isNetworkError = true;
      if (!isExpectedDevError && !isKnownMissingEndpoint) {
        captureException(err, {
          path,
          base,
          method: options.method || 'GET',
          isNetworkError: true,
        });
      }
      // Retry network errors with exponential backoff — but never for
      // non-idempotent methods outside the safe auth allowlist: the
      // request may have already reached and been processed by the server.
      if (retries > 0 && isRetryable) {
        const delay = Math.min(2000, 500 * Math.pow(2, 1 - retries)); // Exponential backoff
        await waitForUploadRetry(delay, externalSignal);
        return request(path, options, timeoutMs, retries - 1, behavior);
      }
      throw err;
    }
    if (
      !capturedResponseError &&
      !isExpectedDevError &&
      !isKnownMissingEndpoint &&
      shouldCaptureTerminalHttpError(error)
    ) {
      captureException(error, { path, base, method: options.method || 'GET' });
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    inflightControllers.delete(controller);
    externalSignal?.removeEventListener('abort', abortExternal);
  }
}

export function httpGet(
  path: string,
  options: RequestInit = {},
  timeoutMs?: number,
  retriesOverride?: number,
  behavior?: HttpBehaviorOptions
) {
  // Keep critical GETs on a short leash. These routes are called from many
  // screens during startup/focus, so large retry budgets turn a transient
  // outage into minutes of blocking spinners across the app.
  const isCriticalEndpoint =
    path.includes('/payments/') ||
    path.includes('/auth/') ||
    path.includes('/me') ||
    path.includes('/notifications');
  const defaultRetries = isCriticalEndpoint ? 1 : 3;
  const retries =
    typeof retriesOverride === 'number' ? Math.max(0, retriesOverride) : defaultRetries;

  return executeOrReuseInflightGet(path, getAuthToken(), () =>
    request(
      path,
      { ...options, method: 'GET' },
      timeoutMs || DEFAULT_GET_TIMEOUT_MS,
      retries,
      behavior
    )
  );
}
// Default POST should never retry automatically (prevents duplicate mutations).
export function httpPost(path: string, body?: any, behavior?: HttpBehaviorOptions) {
  return request(
    path,
    { method: 'POST', body: JSON.stringify(body || {}) },
    DEFAULT_MUTATION_TIMEOUT_MS,
    0,
    behavior
  );
}
// POST with explicit timeout/retry controls for endpoint-specific tuning.
export function httpPostWithOptions(
  path: string,
  body: any,
  timeoutMs: number,
  retries: number = 0,
  behavior?: HttpBehaviorOptions,
  signal?: AbortSignal
) {
  return request(
    path,
    { method: 'POST', body: JSON.stringify(body || {}), signal },
    timeoutMs,
    Math.max(0, retries),
    behavior
  );
}
// Long-timeout POST for heavy endpoints, still no automatic retries for safety.
export function httpPostLongTimeout(path: string, body?: any, behavior?: HttpBehaviorOptions) {
  return request(
    path,
    { method: 'POST', body: JSON.stringify(body || {}) },
    LONG_POST_TIMEOUT_MS,
    0,
    behavior
  );
}
// PUT/PATCH/DELETE should NOT retry - they are state-changing operations
// Retrying could cause duplicate updates or delete operations on already-deleted resources
export function httpPut(path: string, body?: any, behavior?: HttpBehaviorOptions) {
  return request(
    path,
    { method: 'PUT', body: JSON.stringify(body || {}) },
    DEFAULT_MUTATION_TIMEOUT_MS,
    0,
    behavior
  );
}
export function httpPatch(path: string, body?: any, behavior?: HttpBehaviorOptions) {
  return request(
    path,
    { method: 'PATCH', body: JSON.stringify(body || {}) },
    DEFAULT_MUTATION_TIMEOUT_MS,
    0,
    behavior
  );
}
export function httpDelete(path: string, body?: any, behavior?: HttpBehaviorOptions) {
  const payload = typeof body === 'undefined' ? undefined : JSON.stringify(body);
  const options: RequestInit = payload ? { method: 'DELETE', body: payload } : { method: 'DELETE' };
  return request(path, options, DEFAULT_MUTATION_TIMEOUT_MS, 0, behavior);
}
