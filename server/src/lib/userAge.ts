/**
 * Canonical age helpers for VarsityHub.
 *
 * Why this file exists:
 *   Age checks used to be hand-rolled at every call site, reading DOB from
 *   `preferences.dob` — a mutable JSON blob the user could change at will.
 *   That meant "is this user a minor" was not a trustworthy question.
 *
 *   The `User.date_of_birth` column (added in 20260420153000_add_user_minors_foundation)
 *   is the canonical source. During the transition, these helpers fall back to
 *   `preferences.dob` when the column hasn't been populated yet, but every new
 *   feature — DM gating, ad serving, notification rate limits, etc. — should
 *   call these functions rather than re-parse DOB themselves.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * IMPORTANT — `preferences.dob` is read-only legacy.
 *
 * Writes to DOB MUST go through `User.date_of_birth` (via `evaluateDobUpdate`
 * + `parseDobLocal`). `preferences.dob` is kept as a read-fallback for users
 * whose migration backfill didn't populate the column, and nothing new should
 * write to it. Dual-writing from new code paths undoes the canonicalization.
 * If you find yourself about to do `preferences.dob = x`, stop and write to
 * the column instead — the helpers in this file handle the rest.
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Usage:
 *   import { getUserAge, isMinor, isChild } from '../lib/userAge.js';
 *
 *   if (isMinor(user)) { /* 13–17 minor branch */ /* }
 *   if (isChild(user)) { /* under-13 COPPA branch */ /* }
 */

export type AgeSource = {
  date_of_birth?: Date | string | null;
  preferences?: unknown;
};

/** Date-only cutoff for adult discovery using the same UTC birthday boundary
 * as getUserAge. SQL comparisons against this value exclude null DOBs. */
export function adultBirthDateCutoff(now: Date = new Date()): Date {
  const cutoff = new Date(Date.UTC(now.getUTCFullYear() - 18, now.getUTCMonth(), now.getUTCDate()));
  // Feb 29 in a leap year must not admit March 1 birthdays in a non-leap
  // birth year a day early.
  if (cutoff.getUTCMonth() !== now.getUTCMonth()) cutoff.setUTCDate(0);
  return cutoff;
}

/**
 * Parse `YYYY-MM-DD` as a UTC-midnight Date. DOB is a date-only concept — using
 * UTC-midnight sidesteps timezone drift entirely:
 *   - Postgres `DATE` columns have no time component; when Prisma writes a JS
 *     Date, the date portion is derived from the UTC representation. Using
 *     `new Date(y, m, d)` (local midnight) means a positive-offset server
 *     stores the date one day earlier than intended.
 *   - Age calculation must compare UTC-Y/M/D throughout to stay consistent.
 *
 * This helper is exported so every code path that converts a YYYY-MM-DD
 * string to a Date for DB storage goes through the same normalization.
 */
export function parseDobLocal(value: string): Date | null {
  if (!value || typeof value !== 'string') return null;
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    const fallback = new Date(value);
    return Number.isNaN(fallback.getTime()) ? null : fallback;
  }
  const [, yr, mo, dy] = m;
  const d = new Date(Date.UTC(Number(yr), Number(mo) - 1, Number(dy)));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDobYmd(dob: Date | null | undefined): string | null {
  if (!dob || Number.isNaN(dob.getTime())) return null;
  // Read UTC components to match the storage representation chosen above.
  return `${dob.getUTCFullYear()}-${String(dob.getUTCMonth() + 1).padStart(2, '0')}-${String(dob.getUTCDate()).padStart(2, '0')}`;
}

/** Read DOB from the canonical column first, then from legacy preferences. */
export function getCanonicalDob(user: AgeSource | null | undefined): Date | null {
  if (!user) return null;
  if (user.date_of_birth instanceof Date && !Number.isNaN(user.date_of_birth.getTime())) {
    return user.date_of_birth;
  }
  if (typeof user.date_of_birth === 'string') {
    const parsed = parseDobLocal(user.date_of_birth);
    if (parsed) return parsed;
  }
  // Legacy fallback — preferences.dob as YYYY-MM-DD string.
  const prefs =
    user.preferences && typeof user.preferences === 'object'
      ? (user.preferences as Record<string, unknown>)
      : null;
  const legacy = prefs && typeof prefs.dob === 'string' ? prefs.dob : null;
  return legacy ? parseDobLocal(legacy) : null;
}

/**
 * Returns age in whole years, or null if DOB is unknown.
 * Anniversary boundary is computed against "today" in the server's local
 * timezone. For a youth-sports platform that operates against US business
 * hours, using UTC vs local is noise; both produce the same answer except on
 * the birthday boundary, which is fine for age-gating purposes.
 */
export function getUserAge(
  user: AgeSource | null | undefined,
  now: Date = new Date()
): number | null {
  const dob = getCanonicalDob(user);
  if (!dob) return null;
  // UTC throughout so a server in any timezone returns the same age for the
  // same DOB. See `parseDobLocal` for why UTC is the canonical representation.
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < dob.getUTCDate())) {
    age -= 1;
  }
  return age;
}

/**
 * True for users whose DOB indicates they are under 13. COPPA-critical.
 * Returns `false` when DOB is unknown — treating every unknown-DOB user as a
 * 12-year-old would trigger the full parental-consent flow for legacy accounts
 * where backfill couldn't find valid data. Callers that want fail-closed
 * under-13 semantics should combine with `!!getCanonicalDob(user)` explicitly.
 */
export function isChild(user: AgeSource | null | undefined, now: Date = new Date()): boolean {
  const age = getUserAge(user, now);
  return age !== null && age < 13;
}

/**
 * True for users under 18. Used to gate ad serving, adult-initiated DMs, and
 * any feature that should be hidden from minors.
 *
 * **Fails CLOSED on unknown DOB.** If we don't have a canonical DOB we cannot
 * verify the user is an adult, so we must assume the safer default and apply
 * minor-level restrictions until DOB is provided. This defends against any
 * code path that lets a user onto the platform without a DOB — the
 * complete-onboarding handler now requires one, but defense in depth here
 * means a future code path bug doesn't silently expose minors to adult
 * features.
 */
export function isMinor(user: AgeSource | null | undefined, now: Date = new Date()): boolean {
  const age = getUserAge(user, now);
  return age === null || age < 18;
}

/**
 * True ONLY when we have a verified DOB indicating the user is 18+. Use this
 * for feature gates where "unknown age" must be treated as "not qualified" —
 * e.g. the coach 18+ gate. Complements `isMinor()`.
 */
export function isVerifiedAdult(
  user: AgeSource | null | undefined,
  now: Date = new Date()
): boolean {
  const age = getUserAge(user, now);
  return age !== null && age >= 18;
}

/**
 * VarsityHub no longer uses a parental-consent flow for teen accounts.
 * Product policy is:
 *   - under 13: reject / deny access
 *   - 13+: allowed on-platform
 *
 * Keep this helper as the single semantic switch so legacy call sites collapse
 * onto the new contract instead of each re-implementing age windows.
 */
export function requiresParentalConsent(
  user: AgeSource | null | undefined,
  now: Date = new Date()
): boolean {
  void user;
  void now;
  return false;
}

// ────────────────────────────────────────────────────────────────────────────
// DOB mutability
// ────────────────────────────────────────────────────────────────────────────

/**
 * Legacy constant retained for compatibility with older tests/import sites.
 * DOB is now editable after first set; the grace-window lock is no longer used.
 */
export const DOB_GRACE_WINDOW_MS = 24 * 60 * 60 * 1000;

export type DobUpdateDecision =
  | { ok: true; newDob: Date; newSetAt: Date | null; changed: boolean }
  | { ok: false; reason: 'invalid_dob' };

/**
 * Decide whether a DOB change is allowed.
 *
 * Rules:
 *   - Any write is allowed when the canonical column is still null (first set).
 *   - An "edit" that matches the current value is a no-op (always allowed).
 *   - Subsequent edits remain allowed; product policy is to block under-13
 *     users, not to permanently lock DOB after first set.
 *   - Invalid / unparseable DOB strings are rejected.
 *
 * Callers should persist the returned `newDob` into `User.date_of_birth` and
 * `newSetAt` into `User.dob_set_at`. `newSetAt` is null when no change to the
 * timestamp is needed (i.e. value unchanged or an existing first-set timestamp
 * should be preserved).
 */
export function evaluateDobUpdate(params: {
  currentDob: Date | null;
  currentSetAt: Date | null;
  incomingDob: string;
  now?: Date;
}): DobUpdateDecision {
  const now = params.now ?? new Date();
  const parsed = parseDobLocal(params.incomingDob);
  if (!parsed) return { ok: false, reason: 'invalid_dob' };

  const currentYmd = formatDobYmd(params.currentDob);
  const incomingYmd = formatDobYmd(parsed);

  // No-op — value unchanged.
  if (currentYmd === incomingYmd) {
    return { ok: true, newDob: parsed, newSetAt: null, changed: false };
  }

  // First set — always allowed; record the timestamp.
  if (!params.currentDob || !params.currentSetAt) {
    return { ok: true, newDob: parsed, newSetAt: now, changed: true };
  }

  // Subsequent edits remain allowed; preserve the first-set timestamp.
  return { ok: true, newDob: parsed, newSetAt: null, changed: true };
}
