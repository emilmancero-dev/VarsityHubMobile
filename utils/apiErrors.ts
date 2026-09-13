import { toUserMessage } from './toUserMessage';

/**
 * API error normalization.
 *
 * Background: the app catches errors from axios (raw), from an api-client
 * wrapper that unwraps `.response.data` to the top level, from fetch, and
 * from plain Error throws. Call sites currently each probe both
 * `err.status / err.data` AND `err.response.status / err.response.data`
 * because neither shape is guaranteed. The cross-feature audit flagged
 * this as HIGH severity — silent swallows and blank error alerts are
 * the bug class.
 *
 * This module is the single source of truth for pulling a user-visible
 * error message, HTTP status, and server-supplied error code out of any
 * caught value. Use `extractApiError` when you need all three, or one of
 * the convenience helpers otherwise.
 *
 * Usage:
 *   } catch (err) {
 *     const { status, code, message } = extractApiError(err, 'Could not block user.');
 *     if (status === 429) showRateLimit();
 *     else Alert.alert('Error', message);
 *   }
 *
 * All functions are safe on any input (including null, undefined, non-objects).
 * They never throw.
 */

export interface ApiError {
  /** HTTP status code if available (e.g. 400, 403, 500). null otherwise. */
  status: number | null;

  /**
   * Server-supplied error code (e.g. `AGE_REQUIREMENT`, `REJECTION_COOLDOWN`,
   * `COACH_AGREEMENT_OUTDATED`). Useful for client-side switch statements
   * that map to specific UX flows. null when the server returned a generic
   * error or the response wasn't structured.
   */
  code: string | null;

  /** User-visible message. Never empty — falls back to the caller's default. */
  message: string;

  /** Raw response body for advanced callers. Do not expose to users. */
  data: unknown;
}

/**
 * Unwrap an error thrown by any layer (axios, fetch, api-client, plain
 * throw) into a normalized `ApiError`. Never throws. Always returns a
 * valid shape.
 *
 * Precedence for each field:
 *   status   — err.status ?? err.response?.status ?? null
 *   code     — data.code ?? data.error (if that's a string code) ?? null
 *   message  — reviewed public copy or the caller-authored fallback
 */
export function extractApiError(
  err: unknown,
  fallbackMessage: string = 'Something went wrong. Please try again.'
): ApiError {
  const e = (err ?? {}) as any;
  const rawStatus = e.status ?? e.response?.status ?? null;
  const data = e.data ?? e.response?.data ?? null;

  const dataCode =
    data && typeof data === 'object' && typeof (data as any).code === 'string'
      ? (data as any).code
      : null;
  // Some endpoints put the short code in `error` (e.g.
  // `{ error: 'AGE_REQUIREMENT' }`) and the human message in `message`.
  // Treat an all-caps error value as a code.
  const dataErrorField = data && typeof data === 'object' ? (data as any).error : null;
  const inferredCode =
    typeof dataErrorField === 'string' && /^[A-Z][A-Z0-9_]{2,}$/.test(dataErrorField.trim())
      ? dataErrorField.trim()
      : null;
  const code = dataCode ?? inferredCode;

  const message = toUserMessage(err, fallbackMessage);

  return {
    status: typeof rawStatus === 'number' ? rawStatus : null,
    code,
    message,
    data,
  };
}

/**
 * Convenience: just the user-visible message. Use at the common site
 *   Alert.alert('Error', apiErrorMessage(err, 'Could not save profile.'));
 */
export function apiErrorMessage(
  err: unknown,
  fallbackMessage: string = 'Something went wrong. Please try again.'
): string {
  return extractApiError(err, fallbackMessage).message;
}

/**
 * Convenience: just the HTTP status. Useful for early 401/429/503 branches
 * before falling back to the message.
 */
export function apiErrorStatus(err: unknown): number | null {
  return extractApiError(err).status;
}

/**
 * Convenience: just the server-supplied error code. Useful for
 *   if (apiErrorCode(err) === 'AGE_REQUIREMENT') routeToAgeGate();
 */
export function apiErrorCode(err: unknown): string | null {
  return extractApiError(err).code;
}
