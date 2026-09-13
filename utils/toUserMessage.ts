/**
 * toUserMessage — the single place that turns a caught error into a string
 * that is safe to show on screen.
 *
 * Why this exists: `api/http.ts` builds transport-error messages that embed the
 * origin API URL (e.g. "Cannot connect to server at https://…railway.app…"),
 * and any server/provider error body can flow into `err.message` verbatim.
 * Rendering those raw leaks infrastructure internals to users. Every UI site
 * that would otherwise show `err.message` / `err.data.message` should route it
 * through here instead.
 *
 * The core (`sanitizeMessage`) is pure and dependency-free so it can be unit
 * tested without mocking the RN/Expo transport layer.
 */

const GENERIC_FALLBACK = 'Something went wrong. Please try again.';
const NETWORK_MESSAGE = "Couldn't reach the server. Check your connection and try again.";

// Exact, reviewed public copy only. Never use a denylist: an unfamiliar native,
// provider, database, or proxy error must fail closed. Call-site fallbacks must
// be developer-authored copy, never values extracted from an error or response.
const PUBLIC_MESSAGES = new Set([
  'Invalid credentials',
  'Invalid email or password',
  'Please enter a valid email.',
  'Email verification required',
  'Authentication required',
  'Unauthorized',
  'Forbidden',
  'Resource not found',
  'Resource already exists',
  'Invalid input',
  'Too many requests',
  'Too many requests.',
  'You already have this subscription plan',
  'Payment already processed recently',
  'Your league must be approved before you can subscribe.',
  'Posting is not open yet.',
  'Posting is not open for this event.',
  'That user is already on this team.',
]);

// Codes preserve actionable business feedback without trusting response prose.
const PUBLIC_CODE_MESSAGES: Readonly<Record<string, string>> = {
  SOLE_OWNER: 'Transfer ownership to another member before removing the only owner.',
  USER_LIMIT_REACHED:
    'Your plan has reached its staff limit. Remove a pending invite or upgrade your plan.',
  ROSTER_LIMIT_REACHED: 'This team has reached its roster limit.',
  TEAM_PLAN_LOCKED:
    "This team is outside the owner's plan allowance. Contact the owner to update the plan.",
  EVENT_LIMIT_EXCEEDED:
    'You have reached the limit of 3 pending events. Wait for a review before submitting another.',
  APPLE_TRANSACTION_ALREADY_CLAIMED:
    'This purchase receipt has already been used for another purchase.',
  APPLE_RECEIPT_ALREADY_USED: 'This purchase receipt has already been used by another account.',
  APPLE_TRANSACTION_IDS_REQUIRED:
    'We could not verify this purchase. Please try restoring your purchases.',
  MEDIA_DURATION_EXCEEDED: 'Stories are limited to 20 seconds. Trim this video and try again.',
  MEDIA_PICKER_UPDATE_REQUIRED: 'Please update VarsityHub to select videos from your library.',
  ERR_MEDIA_ACQUISITION:
    'Unable to open this media. Open it in Photos first, then try again or choose another file.',
  MEDIA_NOT_READY: 'This media is not ready. Please upload it again.',
};

/** Only exact reviewed copy may cross the error-to-display boundary. */
export function sanitizeMessage(raw: unknown, fallback: string = GENERIC_FALLBACK): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  return PUBLIC_MESSAGES.has(trimmed) ? trimmed : fallback;
}

function isTransportError(err: any): boolean {
  return err?.isNetworkError === true || err?.status === 0;
}

function extractRaw(err: any): string {
  const data = err?.data ?? err?.response?.data;
  return (
    (typeof data?.message === 'string' && data.message) ||
    (typeof data?.error === 'string' && data.error) ||
    (typeof err?.message === 'string' && err.message) ||
    ''
  );
}

/**
 * Convert any caught error into a user-safe message.
 * - Transport/network failures never reveal the host → fixed generic string.
 * - Only exact reviewed public messages pass through.
 * - Anything unrecognized falls back to `fallback` (default generic).
 */
export function toUserMessage(err: unknown, fallback: string = GENERIC_FALLBACK): string {
  if (isTransportError(err)) return NETWORK_MESSAGE;
  const error = err as {
    data?: Record<string, unknown>;
    response?: { data?: Record<string, unknown> };
    code?: unknown;
  } | null;
  const data = error?.data ?? error?.response?.data;
  const code = data?.code ?? data?.errorCode ?? data?.error ?? error?.code;
  if (
    typeof code === 'string' &&
    Object.prototype.hasOwnProperty.call(PUBLIC_CODE_MESSAGES, code)
  ) {
    return PUBLIC_CODE_MESSAGES[code];
  }
  return sanitizeMessage(extractRaw(err), fallback);
}

/**
 * Stable 4-hex-char fingerprint of the current API host. Lets support correlate
 * "which host failed" from a screenshot without exposing the origin URL. Read
 * lazily to avoid a module cycle with api/http and to stay test-friendly.
 */
export function apiHostFingerprint(hostOverride?: string): string {
  try {
    let host = hostOverride;
    if (!host) {
      // Lazy require: keeps this module importable in tests without the full
      // Expo transport graph, and avoids an import cycle with api/http.
      const { getApiBaseUrl } = require('@/api/http') as typeof import('@/api/http');
      host = getApiBaseUrl();
    }
    const h = (host || '').replace(/^https?:\/\//i, '').split('/')[0];
    let hash = 0x811c9dc5; // FNV-1a 32-bit
    for (let i = 0; i < h.length; i++) {
      hash ^= h.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 4);
  } catch {
    return '----';
  }
}

/**
 * Pre-auth variant: on a transport failure it appends a host *fingerprint*
 * (not the URL) so sign-in/up/forgot screens keep their "which host failed"
 * diagnostic value without leaking the origin. Non-transport errors defer to
 * the normal sanitizer.
 */
export function toAuthErrorMessage(err: unknown, fallback: string = GENERIC_FALLBACK): string {
  if (isTransportError(err)) {
    return `Couldn't reach the server (ref ${apiHostFingerprint()}). Check your connection and try again.`;
  }
  return toUserMessage(err, fallback);
}
