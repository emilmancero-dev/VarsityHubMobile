import { Prisma } from '@prisma/client';
import bcrypt from 'bcrypt';
import crypto, { createPublicKey, type KeyObject } from 'crypto';
import { Router, type Response } from 'express';
import { OAuth2Client } from 'google-auth-library';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { z } from 'zod';
import { getAccountDeletionConfirmationRequirements } from '../lib/accountDeletionConfirmation.js';
import { getBearerToken, revokeAccessToken } from '../lib/accessTokenRevocation.js';
import { isAdminEmail } from '../lib/adminEmails.js';
import { cacheGet, cacheSet } from '../lib/cache.js';
import { debugLog } from '../lib/debugLog.js';
import { AVATAR_URL_MESSAGE, isAllowedAvatarUrl } from '../lib/mediaHosts.js';
import {
  getCoachFlowState,
  getLatestCoachApplication,
  serializeCoachApplication,
} from '../lib/coachApplications.js';
import {
  buildCoachApplicationReviewUrl,
  sendCoachApplicationAdminEmail,
  sendPasswordResetEmail,
  sendVerificationEmail,
} from '../lib/email.js';
import { AppError } from '../lib/errors/AppError.js';
import { ConflictError } from '../lib/errors/ConflictError.js';
import { ValidationError } from '../lib/errors/ValidationError.js';
import { sendError } from '../lib/http/sendError.js';
import {
  generateRefreshTokenV2,
  hashRefreshToken,
  hashRefreshTokenSecret,
  parseRefreshToken,
  REFRESH_ROTATION_GRACE_MS,
  REFRESH_TOKEN_EXPIRY_DAYS,
  REFRESH_TOKEN_HASH_VERSION_V2,
  signAccessTokenForSession,
  verifyRefreshTokenHash,
} from '../lib/jwt.js';
import {
  buildOAuthExistingAccountConflict,
  getLinkedProviders,
} from '../lib/oauthAccountLinking.js';
import { ensureOAuthUserVerified } from '../lib/oauthVerification.js';
import { isReservedUsername, RESERVED_USERNAME_MESSAGE } from '../lib/reservedUsernames.js';
import { getOrganizationJoinRequestStateForUser } from '../lib/organizationWorkflowState.js';
import { prisma } from '../lib/prisma.js';
import { invalidatePrivateIdsCache } from '../lib/privacyUtils.js';
import { rlDel, rlGet, rlIncr, rlSet } from '../lib/redisRateLimit.js';
import { stripHtml } from '../lib/sanitizeHtml.js';
import { captureException } from '../lib/sentry.js';
import { revokeAllSessions, startNewSession } from '../lib/session.js';
import {
  buildSessionFingerprint,
  verifyStoredSessionFingerprint,
} from '../lib/sessionFingerprint.js';
import { mustSucceed } from '../lib/sideEffect.js';
import {
  evaluateDobUpdate,
  formatDobYmd,
  getCanonicalDob,
  requiresParentalConsent,
} from '../lib/userAge.js';
import {
  buildAuthStateColumns,
  getCanonicalAuthState,
  getCanonicalOrganizationId,
  getCanonicalUserRole,
  getPreferencesObject,
  isProceedingAsFan,
  isUserOnboardingComplete,
  mergeAuthStateIntoPreferences,
} from '../lib/userAuthState.js';
import {
  buildBillingStateColumns,
  getCanonicalBillingState,
  getCanonicalPlan,
  getSelectedPlan,
  isPaymentPending,
  mergeBillingStateIntoPreferences,
} from '../lib/userBillingState.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import type { AuthedRequest } from '../middleware/auth.js';
import {
  authLimiter,
  oauthLimiter,
  passwordResetLimiter,
  profileUpdateLimiter,
  refreshTokenLimiter,
  verificationConfirmLimiter,
} from '../middleware/rateLimiters.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireVerified } from '../middleware/requireVerified.js';
import {
  appleAuthSchema,
  CURRENT_TERMS_VERSION,
  deleteAccountSchema,
  googleAuthSchema,
  loginSchema,
  passwordChangeSchema,
  passwordResetRequestSchema,
  passwordResetSchema,
  refreshSchema,
  registerSchema,
  upgradeToCoachSchema,
} from '../validators/authSchemas.js';

export const authRouter = Router();

function sendAuthError(
  res: Response,
  status: number,
  error: string,
  code: string,
  extra?: Record<string, unknown>
) {
  return res.status(status).json({ error, code, ...(extra || {}) });
}

function authNoStore(_req: AuthedRequest, res: Response, next: () => void) {
  res.set('Cache-Control', 'no-store, private');
  res.set('Pragma', 'no-cache');
  res.set('Vary', 'Authorization, Origin');
  next();
}

async function invalidateMeCacheForUser(userId: string | null | undefined): Promise<void> {
  const { invalidateMeCacheForUser } = await import('../lib/userCache.js');
  await invalidateMeCacheForUser(userId);
}

async function assertCanSelfDeleteUser(userId: string): Promise<void> {
  const { assertCanSelfDeleteUser } = await import('../lib/accountDeletion.js');
  await assertCanSelfDeleteUser(userId);
}

async function softDeleteUserAccount(userId: string) {
  const { softDeleteUserAccount } = await import('../lib/accountDeletion.js');
  return softDeleteUserAccount(userId);
}

const ME_USER_SELECT = {
  id: true,
  email: true,
  password_hash: true,
  google_id: true,
  apple_id: true,
  display_name: true,
  username: true,
  avatar_url: true,
  bio: true,
  created_at: true,
  email_verified: true,
  email_verification_code: true,
  email_verification_expires: true,
  preferences: true,
  role: true,
  onboarding_completed: true,
  organization_id: true,
  proceeding_as_fan: true,
  coach_agreement_accepted_at: true,
  coach_agreement_version: true,
  plan: true,
  pending_plan: true,
  payment_pending: true,
  payment_approved: true,
  date_of_birth: true,
  dob_set_at: true,
  parental_consent_status: true,
  parental_consent_at: true,
  parental_consent_requested_at: true,
  approval_status: true,
  rejected_at: true,
  rejection_reason: true,
  subscription_tier: true,
  subscription_status: true,
  subscription_expires_at: true,
  max_teams: true,
  paid_by_owner: true,
  _count: {
    select: {
      followers: true,
      following: true,
    },
  },
} as const;

// Rate limit thresholds (unchanged)
const MAX_AUTH_ATTEMPTS = 5;
const AUTH_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_RESET_FAILURES = 5;
const RESET_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const MAX_LOGIN_FAILURES = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const REGISTER_EMAIL_SOFT_TIMEOUT_MS = 5000;

// Constant-time bcrypt hash used when the looked-up user doesn't exist or has
// no password set (OAuth-only account, for example). Running bcrypt.compare
// against this hash equalizes login timing so the endpoint cannot be used to
// enumerate which emails have an account. Generated once at boot from a random
// input so the hash itself is not predictable.
// Password hashing cost factor. Bumped 10→12 (2026 hardening). bcrypt embeds
// the cost in each hash, so pre-existing cost-10 hashes still verify on login;
// only newly set/changed passwords use 12. DUMMY_BCRYPT_HASH below MUST use the
// same cost so the no-account login path stays timing-matched to a real
// (newly-hashed) account — otherwise the timing delta re-opens the enumeration
// oracle the dummy hash exists to close. The random-secret OAuth-stub hashes
// (never used as password verifiers) intentionally stay at 10.
const PASSWORD_BCRYPT_COST = 12;

const DUMMY_BCRYPT_HASH = bcrypt.hashSync(
  `const-time-${crypto.randomBytes(16).toString('hex')}`,
  PASSWORD_BCRYPT_COST
);

// v1.0.2 audit fix: unified truthy parsing — must match middleware/rateLimiters.ts.
// Previously this checked "true" while rateLimiters.ts checked "1", so setting either
// value alone left half the app rate-limited.
const isRateLimitDisabled = (): boolean => {
  const v = process.env.DISABLE_RATE_LIMITING;
  return v !== undefined && ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
};

// Redis-backed auth rate limiting using INCR + EXPIRE pattern
async function checkAuthRateLimit(identifier: string): Promise<boolean> {
  if (isRateLimitDisabled()) return true;
  const key = `auth:${identifier}`;
  const count = await rlIncr(key, AUTH_WINDOW_MS);
  return count <= MAX_AUTH_ATTEMPTS;
}

// Redis-backed password reset failure tracking
type ResetFailureRecord = { attempts: number; lockedUntil: number };

// Defensive parse: malformed cache rows (Redis flush partial, schema change,
// version skew) shouldn't crash the auth endpoint. Treat un-parseable rows as
// "no failures recorded" — the worst case is one extra reset attempt allowed,
// which the rate limiter still gates separately.
function parseResetFailureRecord(raw: string | null): ResetFailureRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.attempts === 'number' && typeof parsed.lockedUntil === 'number') {
      return parsed as ResetFailureRecord;
    }
    return null;
  } catch {
    return null;
  }
}

async function checkResetAttempt(
  email: string
): Promise<{ allowed: boolean; retryAfterMs?: number }> {
  const key = `resetfail:${email}`;
  const raw = await rlGet(key);
  const record = parseResetFailureRecord(raw);
  if (!record) return { allowed: true };

  // Currently locked out
  if (record.attempts >= MAX_RESET_FAILURES && record.lockedUntil > Date.now()) {
    return { allowed: false, retryAfterMs: record.lockedUntil - Date.now() };
  }

  return { allowed: true };
}

async function recordResetFailure(email: string): Promise<void> {
  const key = `resetfail:${email}`;
  const raw = await rlGet(key);
  let record: ResetFailureRecord = parseResetFailureRecord(raw) ?? { attempts: 0, lockedUntil: 0 };

  record.attempts++;
  if (record.attempts >= MAX_RESET_FAILURES) {
    record.lockedUntil = Date.now() + RESET_LOCKOUT_MS;
  }
  // TTL = lockout window so keys auto-expire after lockout period
  await rlSet(key, JSON.stringify(record), RESET_LOCKOUT_MS);
}

async function clearResetFailures(email: string): Promise<void> {
  await rlDel(`resetfail:${email}`);
}

// ── Per-account login lockout ──
// Tracks failed login attempts keyed by email. Complements the per-IP / per-email
// velocity limiter (`checkAuthRateLimit`) which counts every call; this one only
// counts failures and resets on a successful login, so legit users who sign in
// repeatedly never trip it.

async function checkLoginAttempt(
  email: string
): Promise<{ allowed: boolean; retryAfterMs?: number }> {
  const key = `loginfail:${email}`;
  const raw = await rlGet(key);
  if (!raw) return { allowed: true };
  try {
    const record = JSON.parse(raw) as { attempts: number; lockedUntil: number };
    if (record.attempts >= MAX_LOGIN_FAILURES && record.lockedUntil > Date.now()) {
      return { allowed: false, retryAfterMs: record.lockedUntil - Date.now() };
    }
    return { allowed: true };
  } catch {
    return { allowed: true };
  }
}

async function recordLoginFailure(email: string): Promise<void> {
  const key = `loginfail:${email}`;
  const raw = await rlGet(key);
  let record: { attempts: number; lockedUntil: number };
  try {
    record = raw
      ? (JSON.parse(raw) as { attempts: number; lockedUntil: number })
      : { attempts: 0, lockedUntil: 0 };
  } catch {
    record = { attempts: 0, lockedUntil: 0 };
  }
  record.attempts += 1;
  if (record.attempts >= MAX_LOGIN_FAILURES) {
    record.lockedUntil = Date.now() + LOGIN_LOCKOUT_MS;
  }
  await rlSet(key, JSON.stringify(record), LOGIN_LOCKOUT_MS);
}

async function clearLoginFailures(email: string): Promise<void> {
  await rlDel(`loginfail:${email}`);
}

const shouldExposeDevCodes =
  process.env.ENABLE_DEV_CODES === '1' &&
  (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test');
const GOOGLE_ALLOWED_AUDIENCES = (
  process.env.GOOGLE_OAUTH_CLIENT_IDS ||
  process.env.GOOGLE_OAUTH_AUDIENCE ||
  ''
)
  .split(',')
  .map(value => value.trim())
  .filter(value => value.length > 0);

// Create a single OAuth2Client for token verification (uses Google's public keys, cached automatically)
const googleOAuthClient = new OAuth2Client();
const GOOGLE_VERIFY_TIMEOUT_MS = 10_000;

// Enforce Google OAuth audience validation in production
if (process.env.NODE_ENV === 'production' && GOOGLE_ALLOWED_AUDIENCES.length === 0) {
  console.error(
    '[auth] FATAL: GOOGLE_OAUTH_CLIENT_IDS is not set — Google sign-in is disabled in production'
  );
}

// v1.0.3: hard-fail if Apple simulator tokens are enabled in production.
// Previously only warned, which could let a stray env var ship simulator
// auth to real users. Simulator tokens bypass Apple's receipt validation
// pipeline and must never run in production.
if (process.env.NODE_ENV === 'production' && process.env.ALLOW_APPLE_SIM_TOKENS === 'true') {
  console.error(
    '[auth] FATAL: ALLOW_APPLE_SIM_TOKENS is enabled in production — this is a dev-only flag that bypasses Apple receipt validation. Refusing to start.'
  );
  process.exit(1);
}

const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
const APPLE_JWKS_TTL_MS = 6 * 60 * 60 * 1000;
const APPLE_JWKS_TIMEOUT_MS = 10_000;
const appleKeyCache = new Map<string, { key: KeyObject; expiresAt: number }>();

async function issueRefreshTokenForUser(userId: string, deviceInfo: string | null | undefined) {
  // v2 always: keyId is the lookup index, bcrypt(secret) is the verification hash.
  const { raw, keyId, secret } = generateRefreshTokenV2();
  const tokenHash = await hashRefreshTokenSecret(secret);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  await prisma.refreshToken.create({
    data: {
      token_hash: tokenHash,
      key_id: keyId,
      hash_version: REFRESH_TOKEN_HASH_VERSION_V2,
      user_id: userId,
      expires_at: expiresAt,
      device_info: deviceInfo || null,
    },
  });
  return raw;
}

async function verifyGoogleIdentityToken(idToken: string) {
  let ticket;
  try {
    ticket = await Promise.race([
      googleOAuthClient.verifyIdToken({
        idToken,
        ...(GOOGLE_ALLOWED_AUDIENCES.length
          ? {
              audience:
                GOOGLE_ALLOWED_AUDIENCES.length === 1
                  ? GOOGLE_ALLOWED_AUDIENCES[0]
                  : GOOGLE_ALLOWED_AUDIENCES,
            }
          : {}),
      }),
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(
            new AppError(503, 'Google sign-in is temporarily unavailable', {
              errorCode: 'GOOGLE_AUTH_TIMEOUT',
              metadata: { timeout_ms: GOOGLE_VERIFY_TIMEOUT_MS },
            })
          );
        }, GOOGLE_VERIFY_TIMEOUT_MS);
      }),
    ]);
  } catch (err: any) {
    if (err instanceof AppError) throw err;
    const msg = String(err?.message || err);
    if (
      msg.includes('audience') ||
      msg.includes('Token used too late') ||
      msg.includes('Invalid token')
    ) {
      throw new AppError(401, 'Google authentication failed', {
        errorCode: 'GOOGLE_AUTH_FAILED',
        metadata: { detail: msg },
      });
    }
    throw new AppError(401, 'Google authentication failed', {
      errorCode: 'GOOGLE_AUTH_FAILED',
    });
  }

  const payload = ticket.getPayload();
  if (!payload) {
    throw new AppError(401, 'Google authentication failed', {
      errorCode: 'GOOGLE_AUTH_FAILED',
    });
  }

  const googleId = typeof payload.sub === 'string' ? payload.sub : null;
  const email = typeof payload.email === 'string' ? String(payload.email).toLowerCase() : null;
  const emailVerified = payload.email_verified === true;
  if (!googleId || !email) {
    throw new ValidationError('Invalid Google credential', {
      errorCode: 'INVALID_GOOGLE_CREDENTIAL',
    });
  }
  if (!emailVerified) {
    throw new ValidationError('Google account email is not verified', {
      errorCode: 'GOOGLE_EMAIL_NOT_VERIFIED',
    });
  }

  return {
    googleId,
    email,
    displayName:
      typeof payload.name === 'string' && payload.name.trim().length ? payload.name.trim() : null,
    avatarUrl: typeof payload.picture === 'string' ? payload.picture : null,
  };
}

async function verifyAppleIdentityToken(identityToken: string, appleClientId: string) {
  const isDevelopmentToken = identityToken.startsWith('sim-');
  if (isDevelopmentToken && process.env.ALLOW_APPLE_SIM_TOKENS !== 'true') {
    throw new AppError(401, 'Simulator tokens are not accepted in this environment', {
      errorCode: 'APPLE_SIM_TOKEN_REJECTED',
    });
  }

  if (isDevelopmentToken) {
    const appleId = identityToken.replace('sim-', '');
    return {
      appleId,
      email: `${appleId}@privaterelay.appleid.com`,
    };
  }

  let decoded;
  try {
    decoded = jwt.decode(identityToken, { complete: true });
  } catch {
    decoded = null;
  }
  if (!decoded || typeof decoded === 'string' || !decoded.header) {
    throw new ValidationError('Invalid Apple token format', {
      errorCode: 'INVALID_APPLE_TOKEN',
    });
  }

  const kid = decoded.header.kid;
  if (!kid || typeof kid !== 'string') {
    throw new ValidationError('Invalid Apple token header', {
      errorCode: 'INVALID_APPLE_TOKEN',
    });
  }

  try {
    const appleKey = await getApplePublicKey(kid);
    const jwtPayload = jwt.verify(identityToken, appleKey, {
      algorithms: ['RS256'],
      issuer: 'https://appleid.apple.com',
      audience: appleClientId,
    }) as JwtPayload;
    const appleId = jwtPayload.sub as string;
    const email = (jwtPayload.email as string) || null;

    if (!appleId) {
      throw new ValidationError('Missing user identifier in token', {
        errorCode: 'INVALID_APPLE_TOKEN',
      });
    }

    return { appleId, email };
  } catch (err: any) {
    if (err instanceof ValidationError || err instanceof AppError) throw err;
    throw new ValidationError('Failed to verify Apple token', {
      errorCode: 'APPLE_AUTH_FAILED',
      metadata: { detail: err?.message },
    });
  }
}

async function getApplePublicKey(kid: string): Promise<KeyObject> {
  const cached = appleKeyCache.get(kid);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.key;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), APPLE_JWKS_TIMEOUT_MS);

  let response: globalThis.Response;
  try {
    response = await fetch(APPLE_JWKS_URL, { signal: controller.signal });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new AppError(503, 'Apple sign-in is temporarily unavailable', {
        errorCode: 'APPLE_JWKS_TIMEOUT',
        metadata: { timeout_ms: APPLE_JWKS_TIMEOUT_MS },
      });
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch Apple JWKS: ${response.status}`);
  }
  const data = (await response.json()) as { keys?: Array<Record<string, unknown>> };
  const keys = Array.isArray(data?.keys) ? data.keys : [];
  const jwk = keys.find(key => key?.kid === kid);
  if (!jwk) {
    throw new Error('Apple JWKS does not include requested key');
  }

  const key = createPublicKey({ key: jwk, format: 'jwk' });
  appleKeyCache.set(kid, { key, expiresAt: now + APPLE_JWKS_TTL_MS });
  return key;
}

/** Parse YYYY-MM-DD as local date (avoids UTC off-by-one when timezone offset shifts the day) */
function parseDobLocal(dob: string): Date {
  const parts = dob.split('-').map(Number);
  if (parts.length === 3 && parts.every(n => !isNaN(n))) {
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }
  return new Date(dob); // fallback
}

/** COPPA: Returns true if DOB indicates user is under 13. Do not store data for under-13 users. */
function isUnder13(dob: string | null | undefined): boolean {
  if (!dob || typeof dob !== 'string') return false;
  const d = parseDobLocal(dob);
  if (isNaN(d.getTime())) return false;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age < 13;
}

function deriveParentalConsentFields(dob: Date | null) {
  if (!dob) return {};
  return { parental_consent_status: 'not_required' as const, parental_consent_at: null };
}

function resolveEffectiveDob(
  currentDob: Date | string | null | undefined,
  currentPrefs: Record<string, any>,
  incomingDob?: string | null
): Date | null {
  if (incomingDob) return parseDobLocal(incomingDob);
  return getCanonicalDob({
    date_of_birth: currentDob,
    preferences:
      currentPrefs?.dob || currentPrefs?.date_of_birth
        ? {
            ...currentPrefs,
            dob: currentPrefs?.dob ?? currentPrefs?.date_of_birth,
          }
        : currentPrefs,
  });
}

authRouter.post(
  '/register',
  asyncHandler(async (req, res) => {
    const start = Date.now();
    req.log?.info({ path: '/register' }, '[register] start');
    debugLog('[register] Incoming request');
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError('Invalid registration data', {
        validationIssues: parsed.error.issues.map(issue => ({
          path: issue.path.map(String),
          message: issue.message,
        })),
      });
    }
    const { email, password, display_name, role, dob } = parsed.data;
    const sanitizedEmail = email.trim().toLowerCase();

    // SECURITY: Rate limiting to prevent mass account creation / enumeration
    if (!(await checkAuthRateLimit(`register:${sanitizedEmail}`))) {
      return res
        .status(429)
        .json({ error: 'Too many registration attempts. Please try again later.' });
    }

    // COPPA: Reject registration if DOB indicates under 13
    if (dob && isUnder13(dob)) {
      throw new ValidationError(
        'VarsityHub is not available for users under 13. Please have a parent or guardian contact support@varsityhub.app.',
        {
          errorCode: 'COPPA_UNDER_13',
        }
      );
    }

    // Canonical DOB column write (dual-writes preferences.dob below for
    // transition compatibility). If the DOB string is malformed, reject the
    // registration rather than silently drop it.
    let dobColumnWrite: { date_of_birth: Date; dob_set_at: Date } | null = null;
    if (dob) {
      const decision = evaluateDobUpdate({
        currentDob: null,
        currentSetAt: null,
        incomingDob: dob,
      });
      if (!decision.ok) {
        throw new ValidationError('Invalid date of birth', { errorCode: 'INVALID_DOB' });
      }
      dobColumnWrite = {
        date_of_birth: decision.newDob,
        dob_set_at: decision.newSetAt ?? new Date(),
      };
    }

    // Prevent duplicate accounts - check if email already exists
    // Users can create multiple accounts with different emails, but not duplicate the same email
    debugLog('[register] Checking for existing user');
    const exists = await prisma.user.findFirst({
      where: { email: { equals: sanitizedEmail, mode: 'insensitive' } },
      select: { id: true },
    });
    if (exists) {
      throw new ConflictError('Email already registered', {
        errorCode: 'EMAIL_ALREADY_REGISTERED',
      });
    }
    const password_hash = await bcrypt.hash(password, PASSWORD_BCRYPT_COST);
    const code = String(crypto.randomInt(100000, 999999));
    if (process.env.NODE_ENV === 'development')
      debugLog(`[verify-code] [register] Code generated: ${code} for ${sanitizedEmail}`);
    const exp = new Date(Date.now() + 30 * 60 * 1000);
    const userRole = role || 'fan';
    if (userRole === 'coach') {
      return res.status(400).json({
        error:
          'Direct coach registration is disabled. Please register as fan accounts and use the upgrade-to-coach flow.',
        code: 'COACH_REGISTRATION_DISABLED',
      });
    }

    // Set admin flag based on ADMIN_EMAILS env var
    const isAdmin = isAdminEmail(sanitizedEmail);
    const authStatePatch = {
      role: userRole,
      onboarding_completed: false,
    } as const;
    const initialPreferences = {
      ...mergeAuthStateIntoPreferences({}, authStatePatch),
      ...(isAdmin && { is_admin: true }),
      // Dual-write DOB to preferences.dob during transition so legacy readers
      // keep working while the codebase migrates to reading the column.
      ...(dob ? { dob } : {}),
    };

    // AUTH-5: Hash verification code before storage (matches /verify/request + /verify/confirm).
    // Prior to this fix registration stored plaintext while /verify/confirm compared against
    // sha256(submitted) — which meant the first code emailed after signup could never verify,
    // forcing every new user to hit "resend" to get a working code. Also closes the storage
    // leak of a short-lived shared secret at rest.
    const codeHash = hashRefreshToken(code);

    debugLog('[register] Creating user record');
    let user;
    try {
      user = await prisma.user.create({
        data: {
          email: sanitizedEmail,
          password_hash,
          display_name,
          email_verified: false,
          email_verification_code: codeHash,
          email_verification_expires: exp,
          preferences: initialPreferences,
          // Record ToS acceptance: the signup form gates submission on the
          // "I agree to the Terms of Service and Privacy Policy" checkbox, so a
          // successful registration is an affirmative agreement. Bump
          // CURRENT_TERMS_VERSION when the ToS changes materially.
          terms_accepted_at: new Date(),
          terms_version: CURRENT_TERMS_VERSION,
          ...buildAuthStateColumns(authStatePatch),
          ...(dobColumnWrite ? deriveParentalConsentFields(dobColumnWrite.date_of_birth) : {}),
          ...(dobColumnWrite ?? {}),
        },
      });
    } catch (createErr: any) {
      if (createErr?.code === 'P2002') {
        const existingUser = await prisma.user.findFirst({
          where: { email: { equals: sanitizedEmail, mode: 'insensitive' } },
          select: { id: true },
        });
        if (existingUser) {
          throw new ConflictError('Email already registered', {
            errorCode: 'EMAIL_ALREADY_REGISTERED',
          });
        }
      }
      throw createErr;
    }
    if (process.env.NODE_ENV === 'development')
      debugLog(
        `[verify-code] [register] Code hash stored in DB for user ${user.id} (expires ${exp.toISOString()})`
      );
    // New user defaults to session_epoch=0 in schema. Sign the access token
    // with `se: 0` so that when the user later logs in from another device
    // (which bumps the epoch), this initial token is rejected by auth
    // middleware — single-session enforcement applies from day one.
    const access_token = signAccessTokenForSession(user.id, 0);
    // Issue refresh token on registration
    const { raw: rawRefreshReg, keyId: regKeyId, secret: regSecret } = generateRefreshTokenV2();
    const regTokenHash = await hashRefreshTokenSecret(regSecret);
    const regExpiry = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await prisma.refreshToken.create({
      data: {
        token_hash: regTokenHash,
        key_id: regKeyId,
        hash_version: REFRESH_TOKEN_HASH_VERSION_V2,
        user_id: user.id,
        expires_at: regExpiry,
        device_info: buildSessionFingerprint(req),
      },
    });

    const emailSendAttempt = sendVerificationEmail(
      email,
      code,
      display_name || sanitizedEmail.split('@')[0]
    )
      .then(sent => ({
        sent,
        error: sent ? undefined : 'EMAIL_DELIVERY_FAILED',
      }))
      .catch(e => {
        console.error('[register] sendVerificationEmail threw:', e);
        return { sent: false, error: 'EMAIL_DELIVERY_EXCEPTION' as const };
      });

    const emailDelivery = await Promise.race([
      emailSendAttempt,
      new Promise<{ sent: false; error: 'EMAIL_DELIVERY_TIMEOUT' }>(resolve =>
        setTimeout(
          () => resolve({ sent: false, error: 'EMAIL_DELIVERY_TIMEOUT' }),
          REGISTER_EMAIL_SOFT_TIMEOUT_MS
        )
      ),
    ]);

    if (!emailDelivery.sent) {
      console.error(
        `[register] Initial verification email not confirmed: ${emailDelivery.error ?? 'unknown'}`
      );
    }

    const payload: any = {
      access_token,
      refresh_token: rawRefreshReg,
      user: sanitizeUser(user),
      verification_email_sent: emailDelivery.sent,
      verification_email_error: emailDelivery.error,
    };
    if (shouldExposeDevCodes) payload.dev_verification_code = code;
    debugLog('[register] Completed in', Date.now() - start, 'ms');
    res.status(201).json(payload);
  })
);

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid credentials' });
    const { email, password } = parsed.data;
    const sanitizedEmail = email.trim().toLowerCase();

    // Per-account lockout: if this account is currently locked out due to
    // too many failed attempts, refuse before doing any DB or bcrypt work.
    const lockCheck = await checkLoginAttempt(sanitizedEmail);
    if (!lockCheck.allowed) {
      return res.status(429).json({
        error: 'Too many failed login attempts. Please try again later.',
        retry_after_ms: lockCheck.retryAfterMs,
      });
    }

    // Velocity limiter — counts every call (success or fail) per email.
    if (!(await checkAuthRateLimit(sanitizedEmail))) {
      return res.status(429).json({ error: 'Too many login attempts. Please try again later.' });
    }

    const user = await prisma.user.findUnique({ where: { email: sanitizedEmail } });
    // Run bcrypt.compare unconditionally — against the real hash if the user
    // exists, against the dummy hash otherwise — so login timing cannot be used
    // to enumerate which emails have an account.
    const hashToCompare = user?.password_hash || DUMMY_BCRYPT_HASH;
    const passwordMatches = await bcrypt.compare(password, hashToCompare);

    if (!user) {
      await recordLoginFailure(sanitizedEmail);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (!user.password_hash) {
      await recordLoginFailure(sanitizedEmail);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    if (!passwordMatches) {
      await recordLoginFailure(sanitizedEmail);
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    // Success — clear the failure counter so this account isn't half-locked.
    await clearLoginFailures(sanitizedEmail);

    // Reveal ban status ONLY after credentials verify. Returning this 403
    // (with ban_reason) before the password check let anyone enumerate
    // accounts and read ban reasons using any password — undercutting the
    // DUMMY_BCRYPT_HASH timing-equalization above. A wrong password on a
    // banned account now returns the same generic 401 as any other account;
    // only the real owner (correct password) learns the account is banned.
    if (user.banned)
      return res.status(403).json({
        error: 'Account banned',
        ban_reason: user.ban_reason || null,
        banned_until: user.banned_until || null,
      });

    // Mint a fresh token pair for this login without invalidating the user's
    // other active devices. Forced security events (password change, bans,
    // account deletion) still revoke all sessions centrally.
    const deviceInfo = buildSessionFingerprint(req);
    const { access_token, refresh_token: rawRefresh } = await startNewSession(user.id, deviceInfo);

    const sanitized = sanitizeUser(user);
    const needsOnboarding = !isUserOnboardingComplete(user as any);
    // Include is_admin flag so AuthProvider knows admin status immediately on login
    const isLoginAdmin = isAdminEmail(user.email);
    const body: any = {
      access_token,
      refresh_token: rawRefresh,
      user: { ...sanitized, is_admin: isLoginAdmin },
      needs_onboarding: needsOnboarding,
    };
    if (!user.email_verified) body.needs_verification = true;
    return res.json(body);
  })
);

/**
 * A refresh token whose `rotated_at` is set has already been superseded. This
 * is reached two ways:
 *   (a) a slow/aborted /auth/refresh that retried with the just-rotated token
 *       (the client never persisted the new one), or a concurrent
 *       double-refresh that lost the rotation race, OR
 *   (b) genuine reuse/theft: a stolen, already-rotated token replayed later or
 *       from a different device.
 * Within the grace window AND from the same device we treat it as (a): mint a
 * fresh pair, do NOT revoke. Outside the window or from a different device we
 * treat it as (b): revoke every session (theft response) and return
 * TOKEN_REUSED. The superseded row is left intact so repeated retries inside
 * the window keep working.
 */
async function serveRotatedTokenOrRevoke(
  stored: {
    id: string;
    user_id: string;
    rotated_at: Date | null;
    device_info: string | null;
    created_at: Date;
  },
  req: AuthedRequest,
  res: Response
) {
  const user = await prisma.user.findUnique({ where: { id: stored.user_id } });
  if (!user || user.banned) {
    return res.status(401).json({ error: 'Invalid refresh token' });
  }

  // A password change already revokes sessions on its own path — never reissue
  // a token that predates it, even inside the grace window.
  if (user.password_changed_at && stored.created_at < user.password_changed_at) {
    return res.status(401).json({ error: 'Token invalidated by password change' });
  }

  const rotatedAtMs = stored.rotated_at ? stored.rotated_at.getTime() : 0;
  const withinGrace = Date.now() - rotatedAtMs <= REFRESH_ROTATION_GRACE_MS;
  const fingerprint = verifyStoredSessionFingerprint(stored.device_info, req);

  if (withinGrace && fingerprint.matches) {
    // Slow/aborted refresh (or concurrent race loser) retrying — reissue a
    // fresh pair against the user's current epoch. No revoke.
    const { raw: newRawRefresh, keyId: newKeyId, secret: newSecret } = generateRefreshTokenV2();
    const newHash = await hashRefreshTokenSecret(newSecret);
    const newExpiry = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await prisma.refreshToken.create({
      data: {
        token_hash: newHash,
        key_id: newKeyId,
        hash_version: REFRESH_TOKEN_HASH_VERSION_V2,
        user_id: user.id,
        expires_at: newExpiry,
        device_info: buildSessionFingerprint(req),
      },
    });
    const access_token = signAccessTokenForSession(user.id, (user as any).session_epoch ?? 0);
    return res.json({ access_token, refresh_token: newRawRefresh });
  }

  // Past grace or different device → genuine reuse/theft: revoke everything.
  console.warn('[auth] Rotated refresh token replayed outside grace — revoking all sessions', {
    userId: user.id,
    refreshTokenId: stored.id,
    withinGrace,
    fingerprintReason: fingerprint.reason,
    ip: req.ip,
    path: req.path,
  });
  try {
    await revokeAllSessions(user.id);
  } catch (revokeErr) {
    console.error('[auth] Failed to revoke sessions after token reuse', revokeErr);
  }
  return res.status(401).json({ error: 'Token already used', code: 'TOKEN_REUSED' });
}

/**
 * POST /auth/refresh
 * Exchange a valid refresh token for a new access token + rotated refresh token.
 * The old refresh token is superseded (rotation prevents reuse) but honored for
 * a short same-device grace window so a slow/aborted refresh can retry.
 */
authRouter.post(
  '/refresh',
  refreshTokenLimiter,
  asyncHandler(async (req, res) => {
    if (
      !req.body?.refresh_token ||
      typeof req.body.refresh_token !== 'string' ||
      !req.body.refresh_token.trim()
    ) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    try {
      const parsed = refreshSchema.safeParse(req.body);
      if (!parsed.success) return res.status(401).json({ error: 'Invalid refresh token' });

      const { refresh_token } = parsed.data;

      // Look up the row. v2 tokens carry their own keyId in the raw value
      // and use bcrypt for verification; v1 tokens are looked up directly
      // by SHA-256 of the raw value. Both paths are handled here so we
      // can read legacy and new rows during the migration window.
      const parsedToken = parseRefreshToken(refresh_token);
      let stored;
      if (parsedToken.version === 2) {
        stored = await prisma.refreshToken.findUnique({ where: { key_id: parsedToken.keyId } });
      } else {
        const tokenHash = hashRefreshToken(refresh_token);
        stored = await prisma.refreshToken.findUnique({ where: { token_hash: tokenHash } });
      }
      if (!stored) return res.status(401).json({ error: 'Invalid refresh token' });

      // Constant-time verification against the stored hash.
      const matches = await verifyRefreshTokenHash(
        refresh_token,
        stored.token_hash,
        stored.hash_version
      );
      if (!matches) return res.status(401).json({ error: 'Invalid refresh token' });

      // Already-rotated (superseded) token. Handle before the generic expiry
      // check: rotation shrinks the old row's expiry to the grace window, so a
      // past-grace replay would otherwise be swallowed as a plain expiry and
      // skip the reuse/theft revoke path. Within grace + same device → fresh
      // pair (slow/aborted-refresh retry); otherwise → revoke.
      if (stored.rotated_at) {
        return await serveRotatedTokenOrRevoke(stored, req as AuthedRequest, res);
      }

      if (stored.expires_at < new Date()) {
        await mustSucceed(
          'auth.refresh.delete-expired-token',
          {
            route: '/auth/refresh',
            refresh_token_id: stored.id,
            user_id: stored.user_id,
          },
          () => prisma.refreshToken.delete({ where: { id: stored.id } })
        );
        return res.status(401).json({ error: 'Refresh token expired' });
      }

      // Check user still valid
      const user = await prisma.user.findUnique({ where: { id: stored.user_id } });
      if (!user || user.banned) {
        await mustSucceed(
          'auth.refresh.delete-banned-token',
          {
            route: '/auth/refresh',
            refresh_token_id: stored.id,
            user_id: stored.user_id,
          },
          () => prisma.refreshToken.delete({ where: { id: stored.id } })
        );
        return res.status(401).json({ error: 'Account not found or banned' });
      }

      // Reject tokens issued before a password change
      if (user.password_changed_at && stored.created_at < user.password_changed_at) {
        await mustSucceed(
          'auth.refresh.delete-password-invalidated-token',
          {
            route: '/auth/refresh',
            refresh_token_id: stored.id,
            user_id: stored.user_id,
          },
          () => prisma.refreshToken.delete({ where: { id: stored.id } })
        );
        return res.status(401).json({ error: 'Token invalidated by password change' });
      }

      const fingerprintCheck = verifyStoredSessionFingerprint(stored.device_info, req);
      if (!fingerprintCheck.matches) {
        if (fingerprintCheck.enforce) {
          console.warn('[auth] Refresh token rejected for device mismatch', {
            userId: user.id,
            refreshTokenId: stored.id,
            reason: fingerprintCheck.reason,
          });
          await mustSucceed(
            'auth.refresh.delete-device-mismatch-token',
            {
              route: '/auth/refresh',
              refresh_token_id: stored.id,
              user_id: stored.user_id,
              reason: fingerprintCheck.reason,
            },
            () => prisma.refreshToken.delete({ where: { id: stored.id } })
          );
          return res.status(401).json({ error: 'Invalid refresh token' });
        }

        console.warn('[auth] Refresh token used from different legacy device fingerprint', {
          userId: user.id,
          refreshTokenId: stored.id,
          reason: fingerprintCheck.reason,
        });
      }

      // Rotate = supersede, not delete. Always issue v2 going forward — that's
      // the lazy-upgrade path for any v1 token still in circulation.
      //
      // Atomically CLAIM the old row (WHERE rotated_at IS NULL): mark it rotated
      // and shrink its expiry to the grace window, then create the new token.
      // Two concurrent refreshes find the same row but only one claim matches
      // (count 1); the loser (count 0) is served from the grace window instead
      // of being revoked. A slow/aborted refresh that never persisted the new
      // token also retries into that same grace window (via the early
      // rotated_at check above) — no forced sign-out.
      const { raw: newRawRefresh, keyId: newKeyId, secret: newSecret } = generateRefreshTokenV2();
      const newHash = await hashRefreshTokenSecret(newSecret);
      const newExpiry = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

      const claim = await prisma.refreshToken.updateMany({
        where: { id: stored.id, rotated_at: null },
        data: {
          rotated_at: new Date(),
          replaced_by_key_id: newKeyId,
          expires_at: new Date(Date.now() + REFRESH_ROTATION_GRACE_MS),
        },
      });

      if (claim.count === 0) {
        // Lost the rotation race — a concurrent refresh already superseded this
        // row. Serve that request from the grace window (or revoke if it's
        // actually past grace / a different device).
        const current = await prisma.refreshToken.findUnique({ where: { id: stored.id } });
        if (current) {
          return await serveRotatedTokenOrRevoke(current, req as AuthedRequest, res);
        }
        // Row vanished entirely (legacy delete path / cleanup) — reuse signal.
        console.warn('[auth] Refresh token reuse detected — revoking all sessions', {
          userId: user.id,
          refreshTokenId: stored.id,
          ip: req.ip,
          path: req.path,
        });
        try {
          await revokeAllSessions(user.id);
        } catch (revokeErr) {
          console.error('[auth] Failed to revoke sessions after token reuse', revokeErr);
        }
        return res.status(401).json({ error: 'Token already used', code: 'TOKEN_REUSED' });
      }

      await prisma.refreshToken.create({
        data: {
          token_hash: newHash,
          key_id: newKeyId,
          hash_version: REFRESH_TOKEN_HASH_VERSION_V2,
          user_id: user.id,
          expires_at: newExpiry,
          device_info: buildSessionFingerprint(req),
        },
      });

      // Refresh rotates tokens WITHIN an existing session — it doesn't start a
      // new one — so we don't bump session_epoch here. Mint the new access
      // token against the user's current epoch so it stays valid until the
      // user logs in again on any device (which is what bumps the epoch).
      const access_token = signAccessTokenForSession(user.id, (user as any).session_epoch ?? 0);
      return res.json({ access_token, refresh_token: newRawRefresh });
    } catch (err) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }
  })
);

/**
 * POST /auth/revoke-all-tokens
 * Invalidates every refresh token for the current user.
 * Use when a security breach is detected.
 */
authRouter.post(
  '/revoke-all-tokens',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const { revokedRefreshTokens } = await revokeAllSessions(req.user.id);
    await invalidateMeCacheForUser(req.user.id);
    return res.json({ ok: true, revoked: revokedRefreshTokens });
  })
);

/**
 * POST /auth/logout
 * Invalidates the provided refresh token.
 */
authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const bearerToken = getBearerToken(req.header('Authorization'));
    if (bearerToken) {
      await revokeAccessToken(bearerToken).catch((err: unknown) => {
        captureException(err instanceof Error ? err : new Error(String(err)), {
          context: 'logout_access_token_revoke_failed',
        });
      });
    }

    const { refresh_token } = req.body || {};
    if (refresh_token && typeof refresh_token === 'string') {
      // Look up the row by whichever index matches the token shape — v2
      // uses key_id, v1 uses token_hash — then verify the full raw token
      // before deleting anything. Requiring only a v2 key_id would let a
      // caller who learned that 64-bit identifier force-logout a victim
      // session and clear the associated push_token without proving
      // possession of the secret half.
      const parsedToken = parseRefreshToken(refresh_token);
      // Resolve the user from the refresh token BEFORE deleting it, so we can
      // also proactively clear their push token. Stale push tokens on logged-out
      // devices are a privacy leak (the device keeps receiving pushes for a user
      // who is no longer signed in) and an abuse vector if the device is shared.
      let row: { user_id: string; id: string } | null = null;
      // Lookup catches → null is intentional (logout must never fail), but
      // surfacing the underlying error to Sentry matters: a Prisma outage
      // here means the user's token isn't actually being deleted from the
      // DB and remains valid until natural expiry. Without capture, that
      // silently degrades to "logout looks fine, token still works."
      if (parsedToken.version === 2) {
        row = await prisma.refreshToken
          .findUnique({ where: { key_id: parsedToken.keyId }, select: { user_id: true, id: true } })
          .catch((err: any) => {
            captureException(err instanceof Error ? err : new Error(String(err)), {
              context: 'logout_refresh_token_lookup_failed',
              tokenVersion: 2,
            });
            return null;
          });
      } else {
        const tokenHash = hashRefreshToken(refresh_token);
        row = await prisma.refreshToken
          .findUnique({ where: { token_hash: tokenHash }, select: { user_id: true, id: true } })
          .catch((err: any) => {
            captureException(err instanceof Error ? err : new Error(String(err)), {
              context: 'logout_refresh_token_lookup_failed',
              tokenVersion: 1,
            });
            return null;
          });
      }
      let verifiedRow = row;
      if (row) {
        const fullRow = await prisma.refreshToken
          .findUnique({
            where: { id: row.id },
            select: { id: true, user_id: true, token_hash: true, hash_version: true },
          })
          .catch((err: any) => {
            captureException(err instanceof Error ? err : new Error(String(err)), {
              context: 'logout_refresh_token_verify_lookup_failed',
            });
            return null;
          });
        const tokenMatches =
          !!fullRow &&
          (await verifyRefreshTokenHash(
            refresh_token,
            fullRow.token_hash,
            fullRow.hash_version
          ).catch(() => false));
        verifiedRow = tokenMatches ? { id: fullRow!.id, user_id: fullRow!.user_id } : null;
      }

      if (verifiedRow) {
        await prisma.refreshToken.delete({ where: { id: verifiedRow.id } }).catch((err: any) => {
          captureException(err instanceof Error ? err : new Error(String(err)), {
            context: 'logout_refresh_token_delete_failed',
          });
        });
      }
      if (verifiedRow?.user_id) {
        try {
          const user = await prisma.user.findUnique({
            where: { id: verifiedRow.user_id },
            select: { preferences: true },
          });
          const prefs =
            user?.preferences && typeof user.preferences === 'object'
              ? (user.preferences as Record<string, unknown>)
              : null;
          if (prefs && 'push_token' in prefs) {
            const { push_token: _removed, ...rest } = prefs;
            // Use updateUserAndInvalidate so the /me cache also drops the
            // stale push_token. Direct prisma.user.update leaves the cache
            // serving the old token until natural TTL.
            await prisma.user.update({
              where: { id: verifiedRow.user_id },
              data: { preferences: rest as any },
            });
            await invalidateMeCacheForUser(verifiedRow.user_id).catch((err: unknown) => {
              console.warn(
                '[auth] Cache invalidation failed (non-critical):',
                (err as Error)?.message
              );
            });
          }
        } catch (err) {
          // Stale push tokens on logged-out devices are a privacy leak —
          // user keeps receiving pushes after signing out. Failure here
          // means the token wasn't cleared; surfacing to Sentry so it
          // gets triaged instead of buried in container stdout.
          console.warn('[auth] logout push_token clear failed:', (err as any)?.message || err);
          captureException(err instanceof Error ? err : new Error(String(err)), {
            context: 'logout_push_token_clear_failed',
            userId: verifiedRow.user_id,
          });
        }
      }
    }
    return res.json({ ok: true });
  })
);

/**
 * DELETE /auth/account
 *
 * Self-serve account deletion. Required for GDPR Art. 17 ("right to erasure")
 * and CCPA § 1798.105. The request is idempotent: calling on an already-
 * deleted account returns 200 with a no-op.
 *
 * Behavior:
 *   1. Require explicit destructive confirmation by typing DELETE. Password
 *      accounts must also re-authenticate with the current password.
 *   2. Anonymize PII fields in place — email, display_name, username, avatar,
 *      bio, preferences — using the user's own id as the anonymization seed
 *      so uniqueness constraints hold without collision.
 *   3. Soft-delete: set `deleted_at`, `deletion_anonymized=true`, and `banned`
 *      so auth middleware refuses further access even if a stale token leaks.
 *   4. Revoke all refresh tokens.
 *   5. Related rows (posts, messages, memberships, etc.) continue to exist
 *      under the anonymized user id. A scheduled hard-delete job will remove
 *      them after the retention window — that's a follow-up pass.
 *
 * Response: 200 { ok: true, deleted_at, already_deleted?: true }
 */
authRouter.post(
  '/account/delete',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const parsed = deleteAccountSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid payload' });
    }
    const userId = req.user!.id;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        password_hash: true,
        google_id: true,
        apple_id: true,
        deleted_at: true,
        deletion_anonymized: true,
      },
    });
    if (!user) return res.status(404).json({ error: 'Not found' });

    // Idempotent: already deleted → return 200 with already_deleted flag.
    if (user.deleted_at || user.deletion_anonymized) {
      return res.json({
        ok: true,
        already_deleted: true,
        deleted_at: user.deleted_at?.toISOString(),
      });
    }

    const confirmationCheck = getAccountDeletionConfirmationRequirements(user, parsed.data);
    if (!confirmationCheck.ok) {
      return res.status(confirmationCheck.status).json(confirmationCheck.body);
    }

    // Re-authentication gate. Password accounts require the current password
    // after the destructive confirmation text has been typed correctly.
    if (confirmationCheck.requiresPassword) {
      const suppliedPassword = String(parsed.data.password || '');
      const ok = await bcrypt.compare(suppliedPassword, String(user.password_hash || ''));
      if (!ok) {
        return res.status(401).json({
          error: 'INVALID_PASSWORD',
          message: 'Password does not match.',
        });
      }
    }

    try {
      await assertCanSelfDeleteUser(userId);
    } catch (err) {
      if ((err as any)?.code === 'SOLE_ORG_OWNER') {
        return res.status(400).json({
          error:
            'You are the sole owner of an organization. Transfer ownership before deleting your account.',
          code: 'SOLE_ORG_OWNER',
          organization_id: (err as any).organization_id,
        });
      }
      if ((err as any)?.code === 'SOLE_TEAM_OWNER') {
        return sendError(
          res,
          400,
          'You are the sole owner of a team. Transfer ownership before deleting your account.',
          { code: 'SOLE_TEAM_OWNER', details: { team_id: (err as any).team_id } }
        );
      }
      throw err;
    }

    const result = await softDeleteUserAccount(userId);

    await invalidateMeCacheForUser(userId).catch((err: unknown) => {
      console.warn('[auth] Cache invalidation failed (non-critical):', (err as Error)?.message);
    });

    console.warn(`[auth] Account permanently deleted: ${userId}`);

    return res.json({
      ok: true,
      deleted_at: result.deletedAt.toISOString(),
      ...(result.alreadyDeleted ? { already_deleted: true } : {}),
    });
  })
);

authRouter.post(
  '/google',
  oauthLimiter,
  asyncHandler(async (req, res) => {
    const parsed = googleAuthSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' });

    if (process.env.NODE_ENV === 'production' && GOOGLE_ALLOWED_AUDIENCES.length === 0) {
      console.error(
        '[auth/google] rejecting Google sign-in because GOOGLE_OAUTH_CLIENT_IDS is not configured'
      );
      return res.status(503).json({ error: 'Google sign-in is temporarily unavailable' });
    }

    const { id_token } = parsed.data;

    let stage = 'verify-token';
    try {
      // SECURITY: In production we MUST enforce audience — otherwise a token
      // signed for a different Google OAuth client (e.g. some random third-party
      // app) would successfully authenticate a user in our app. In dev/test we
      // accept any audience so local sign-in works without client-id config.
      if (process.env.NODE_ENV === 'production' && GOOGLE_ALLOWED_AUDIENCES.length === 0) {
        console.error('[auth/google] Rejecting token: GOOGLE_OAUTH_CLIENT_IDS not configured');
        return res.status(503).json({ error: 'Google Sign-In is not configured' });
      }

      const {
        googleId,
        email,
        displayName: displayNameSource,
        avatarUrl,
      } = await verifyGoogleIdentityToken(id_token);

      // Stage 4: User lookup/creation
      stage = 'user-lookup';
      let user = await prisma.user.findUnique({ where: { google_id: googleId } });
      let created = false;

      // v1.0.2: Sync email/avatar from Google on re-auth. If the user changed their
      // Google email, the DB should reflect it since they're authenticating with that
      // Google account. Avatar updates only fill a blank avatar.
      if (user) {
        const syncUpdates: any = {};
        if (user.email.toLowerCase() !== email.toLowerCase()) {
          // Check that the new email isn't taken by another account.
          // Use case-insensitive lookup so we don't end up with duplicate
          // accounts differing only in case (register stores lowercased
          // email; Google may return mixed-case from the ID token).
          const emailTaken = await prisma.user.findFirst({
            where: { email: { equals: email, mode: 'insensitive' }, NOT: { id: user.id } },
            select: { id: true },
          });
          if (!emailTaken) {
            syncUpdates.email = email;
            syncUpdates.email_verified = true;
          }
        }
        if (avatarUrl && !user.avatar_url) syncUpdates.avatar_url = avatarUrl;
        if (displayNameSource && !user.display_name) syncUpdates.display_name = displayNameSource;
        if (Object.keys(syncUpdates).length) {
          try {
            user = await prisma.user.update({ where: { id: user.id }, data: syncUpdates }); // cache-invalidation-exempt — invalidateMeCacheForUser called on next line
            await invalidateMeCacheForUser(user.id);
          } catch (syncErr: any) {
            // P2002 means a concurrent request claimed the email between our findFirst check
            // and this update. Skip the sync — the user still logs in successfully.
            if (syncErr?.code !== 'P2002') throw syncErr;
            debugLog('[auth/google] Email sync skipped due to concurrent claim (P2002)');
          }
        }
      }

      if (!user) {
        stage = 'user-resolve';
        // Case-insensitive so a Google sign-in with mixed-case email finds
        // the existing lowercased account instead of silently creating a
        // duplicate. Matches the behavior of Apple Sign In below.
        const existingByEmail = await prisma.user.findFirst({
          where: { email: { equals: email, mode: 'insensitive' } },
        });

        if (existingByEmail) {
          return res.status(409).json(
            buildOAuthExistingAccountConflict({
              email,
              user: existingByEmail,
              providerLabel: 'Google',
            })
          );
        } else {
          stage = 'create-user';
          const randomSecret = crypto.randomBytes(32).toString('hex');
          const password_hash = await bcrypt.hash(randomSecret, 10);
          try {
            user = await prisma.user.create({
              data: {
                email,
                password_hash,
                google_id: googleId,
                display_name: displayNameSource,
                avatar_url: avatarUrl,
                email_verified: true,
                preferences: mergeAuthStateIntoPreferences(
                  {},
                  {
                    role: 'fan',
                    onboarding_completed: false,
                  }
                ),
                role: 'fan',
                onboarding_completed: false,
              },
            });
          } catch (createErr: any) {
            if (createErr?.code === 'P2002') {
              const existingUser = await prisma.user.findFirst({
                where: { email: { equals: email, mode: 'insensitive' } },
              });
              if (existingUser) {
                return res.status(409).json(
                  buildOAuthExistingAccountConflict({
                    email,
                    user: existingUser,
                    providerLabel: 'Google',
                  })
                );
              }
            }
            throw createErr;
          }
          created = true;
        }
      } else if (!user.email_verified) {
        stage = 'verify-existing';
        // cache-invalidation-exempt — invalidateMeCacheForUser called on line below
        user = await prisma.user.update({
          where: { id: user.id },
          data: {
            email_verified: true,
            email_verification_code: null,
            email_verification_expires: null,
          },
        });
        await invalidateMeCacheForUser(user.id);
      }

      // Stage 5: Generate JWT + refresh token for this login without tearing
      // down the user's other active devices.
      stage = 'jwt';
      const sanitized = sanitizeUser(user);
      const { access_token, refresh_token: rawRefresh } = await startNewSession(
        sanitized.id,
        buildSessionFingerprint(req)
      );
      const needsOnboarding = !isUserOnboardingComplete(user as any);

      // Include is_admin so AuthProvider knows admin status immediately
      const isOAuthAdmin = isAdminEmail(sanitized.email);
      return res.json({
        access_token,
        refresh_token: rawRefresh,
        user: {
          ...sanitized,
          email_verified: true,
          is_admin: isOAuthAdmin,
          linked_providers: getLinkedProviders(user as any),
        },
        needs_onboarding: needsOnboarding,
        created,
      });
    } catch (err: any) {
      if (err instanceof AppError) {
        return res.status(err.statusCode).json(err.toJSON());
      }
      console.error(`[auth/google] error at stage="${stage}"`, {
        message: err?.message,
        code: err?.code,
        name: err?.name,
        stack: err?.stack?.split('\n').slice(0, 5).join('\n'),
      });
      captureException(err instanceof Error ? err : new Error(String(err?.message || err)), {
        stage,
        context: 'google-auth',
      });
      return res.status(500).json({ error: 'Failed to authenticate with Google' });
    }
  })
);

authRouter.post(
  '/apple',
  oauthLimiter,
  asyncHandler(async (req, res) => {
    const APPLE_CLIENT_ID = process.env.APPLE_CLIENT_ID;
    if (!APPLE_CLIENT_ID) {
      return res.status(503).json({ error: 'Apple Sign-In is not configured' });
    }

    const parsed = appleAuthSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' });

    const { identity_token } = parsed.data;

    try {
      const { appleId, email } = await verifyAppleIdentityToken(identity_token, APPLE_CLIENT_ID);

      // Look up user by Apple ID
      let user = await prisma.user.findUnique({ where: { apple_id: appleId } });
      let created = false;

      if (!user) {
        // Check if user exists by email (if provided) - use case-insensitive search
        let existingByEmail = null;
        if (email) {
          existingByEmail = await prisma.user.findFirst({
            where: { email: { equals: email, mode: 'insensitive' } },
          });
        }

        if (existingByEmail) {
          return res.status(409).json(
            buildOAuthExistingAccountConflict({
              email: email || existingByEmail.email,
              user: existingByEmail,
              providerLabel: 'Apple',
            })
          );
        } else {
          // Create new user
          const randomSecret = crypto.randomBytes(32).toString('hex');
          const password_hash = await bcrypt.hash(randomSecret, 10);
          const userEmail = email || `apple_${appleId.substring(0, 16)}@appleid.local`;

          try {
            // Apple private relay emails (e.g. xyz@privaterelay.appleid.com) are random tokens,
            // not real names. Always fall back to 'Apple User' for those.
            // Don't set display_name from Apple email — user will set their username during onboarding
            user = await prisma.user.create({
              data: {
                email: userEmail,
                password_hash,
                apple_id: appleId,
                display_name: null,
                email_verified: true,
                preferences: mergeAuthStateIntoPreferences(
                  {},
                  {
                    role: 'fan',
                    onboarding_completed: false,
                  }
                ),
                role: 'fan',
                onboarding_completed: false,
              },
            });
            created = true;
          } catch (createErr: any) {
            // Handle unique constraint violation (P2002) - user may have been created concurrently
            // or exists with different apple_id
            if (createErr?.code === 'P2002') {
              debugLog('[auth/apple] User already exists after create race');
              const existingUser = await prisma.user.findFirst({
                where: { email: { equals: userEmail, mode: 'insensitive' } },
              });
              if (existingUser) {
                return res.status(409).json(
                  buildOAuthExistingAccountConflict({
                    email: userEmail,
                    user: existingUser,
                    providerLabel: 'Apple',
                  })
                );
              } else {
                throw createErr; // Re-throw if we still can't find the user
              }
            } else {
              throw createErr;
            }
          }
        }
      }

      user = await ensureOAuthUserVerified(user);

      const sanitized = sanitizeUser(user);
      // Mint a fresh pair for this login without invalidating other devices.
      const { access_token, refresh_token: appleRawRefresh } = await startNewSession(
        sanitized.id,
        buildSessionFingerprint(req)
      );
      const needsOnboarding = !isUserOnboardingComplete(user as any);
      const isAppleOAuthAdmin = isAdminEmail(sanitized.email);
      return res.json({
        access_token,
        refresh_token: appleRawRefresh,
        user: {
          ...sanitized,
          email_verified: true,
          is_admin: isAppleOAuthAdmin,
          linked_providers: getLinkedProviders(user as any),
        },
        needs_onboarding: needsOnboarding,
        created,
      });
    } catch (err: any) {
      if (err instanceof AppError) {
        return res.status(err.statusCode).json(err.toJSON());
      }
      console.error('[auth/apple] unexpected error', err);
      return res.status(500).json({ error: 'Failed to authenticate with Apple' });
    }
  })
);

authRouter.post(
  '/google/link',
  requireAuth as any,
  oauthLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    const parsed = googleAuthSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' });

    const currentUser = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        id: true,
        email: true,
        password_hash: true,
        google_id: true,
        apple_id: true,
        avatar_url: true,
        display_name: true,
      },
    });
    if (!currentUser) return res.status(404).json({ error: 'Not found' });

    const { googleId, email, displayName, avatarUrl } = await verifyGoogleIdentityToken(
      parsed.data.id_token
    );
    const normalizedCurrentEmail = String(currentUser.email || '')
      .trim()
      .toLowerCase();
    if (normalizedCurrentEmail !== email) {
      return res.status(409).json({
        code: 'OAUTH_EMAIL_MISMATCH',
        email,
        error: `Google returned ${email}, which does not match your signed-in account.`,
      });
    }

    const linkedUser = await prisma.user.findUnique({ where: { google_id: googleId } });
    if (linkedUser && linkedUser.id !== currentUser.id) {
      return res.status(409).json({
        code: 'OAUTH_PROVIDER_ALREADY_LINKED',
        error: 'This Google account is already linked to another VarsityHub account.',
      });
    }
    if (currentUser.google_id && currentUser.google_id !== googleId) {
      return res.status(409).json({
        code: 'OAUTH_PROVIDER_ALREADY_LINKED',
        error: 'Your VarsityHub account is already linked to a different Google account.',
      });
    }

    const updateData: any = {
      google_id: googleId,
      email_verified: true,
      email_verification_code: null,
      email_verification_expires: null,
    };
    if (avatarUrl && !currentUser.avatar_url) updateData.avatar_url = avatarUrl;
    if (displayName && !currentUser.display_name) updateData.display_name = displayName;

    const updated = await prisma.user.update({
      where: { id: currentUser.id },
      data: updateData,
    });
    await invalidateMeCacheForUser(updated.id);

    return res.json({
      ok: true,
      user: {
        ...sanitizeUser(updated),
        linked_providers: getLinkedProviders(updated as any),
      },
    });
  })
);

authRouter.post(
  '/apple/link',
  requireAuth as any,
  oauthLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    const APPLE_CLIENT_ID = process.env.APPLE_CLIENT_ID;
    if (!APPLE_CLIENT_ID) {
      return res.status(503).json({ error: 'Apple Sign-In is not configured' });
    }

    const parsed = appleAuthSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' });

    const currentUser = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        id: true,
        email: true,
        password_hash: true,
        google_id: true,
        apple_id: true,
      },
    });
    if (!currentUser) return res.status(404).json({ error: 'Not found' });

    const { appleId, email } = await verifyAppleIdentityToken(
      parsed.data.identity_token,
      APPLE_CLIENT_ID
    );
    if (!email) {
      return res.status(400).json({
        code: 'APPLE_EMAIL_REQUIRED_FOR_LINK',
        error:
          'Apple did not provide an email address for this sign-in. Try again and share your email with Apple Sign-In enabled.',
      });
    }

    const normalizedCurrentEmail = String(currentUser.email || '')
      .trim()
      .toLowerCase();
    if (normalizedCurrentEmail !== String(email).trim().toLowerCase()) {
      return res.status(409).json({
        code: 'OAUTH_EMAIL_MISMATCH',
        email,
        error: `Apple returned ${email}, which does not match your signed-in account.`,
      });
    }

    const linkedUser = await prisma.user.findUnique({ where: { apple_id: appleId } });
    if (linkedUser && linkedUser.id !== currentUser.id) {
      return res.status(409).json({
        code: 'OAUTH_PROVIDER_ALREADY_LINKED',
        error: 'This Apple account is already linked to another VarsityHub account.',
      });
    }
    if (currentUser.apple_id && currentUser.apple_id !== appleId) {
      return res.status(409).json({
        code: 'OAUTH_PROVIDER_ALREADY_LINKED',
        error: 'Your VarsityHub account is already linked to a different Apple account.',
      });
    }

    const updated = await prisma.user.update({
      where: { id: currentUser.id },
      data: {
        apple_id: appleId,
        email_verified: true,
        email_verification_code: null,
        email_verification_expires: null,
      },
    });
    await invalidateMeCacheForUser(updated.id);

    return res.json({
      ok: true,
      user: {
        ...sanitizeUser(updated),
        linked_providers: getLinkedProviders(updated as any),
      },
    });
  })
);

authRouter.post(
  '/password/forgot',
  passwordResetLimiter as any,
  asyncHandler(async (req, res) => {
    const parsed = passwordResetRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' });
    const email = parsed.data.email.trim().toLowerCase();

    // SECURITY: Rate limiting to prevent password reset abuse / enumeration
    if (!(await checkAuthRateLimit(`forgot:${email}`))) {
      // Return generic success to prevent timing-based enumeration
      return res.json({ ok: true });
    }

    debugLog('[password-reset] Looking for user:', email);
    const user = await prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
    });
    const payload: any = { ok: true };
    if (!user) {
      debugLog('[password-reset] No user found for:', email);
      return res.json(payload);
    }
    debugLog('[password-reset] User found:', user.id, user.email);

    const code = String(crypto.randomInt(100000, 999999)); // 6-digit cryptographically secure code
    const expires = new Date(Date.now() + 30 * 60 * 1000);
    // AUTH-5: Hash the reset code at rest (matches email verification code hashing).
    // Ephemeral 30-min secret, but DB leaks during the TTL window would otherwise
    // hand attackers a working reset code.
    const resetCodeHash = hashRefreshToken(code);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password_reset_code: resetCodeHash,
        password_reset_expires: expires,
      },
    });

    try {
      debugLog('[email] Sending password reset email to:', user.email);
      const sent = await sendPasswordResetEmail(user.email, code);
      if (!sent) {
        console.warn('[email] Password reset email was not sent');
        captureException(new Error('Password reset email reported unsent'), {
          context: 'password_reset_email_unsent',
          route: '/auth/password/forgot',
          userId: user.id,
        });
      } else {
        debugLog('[email] Password reset email sent successfully');
      }
    } catch (e) {
      console.error('[email] Password reset email failed:', e);
      (req as any).log?.warn?.({ err: e }, 'Password reset email failed');
    }

    if (shouldExposeDevCodes) payload.dev_reset_code = code;
    return res.json(payload);
  })
);

authRouter.post(
  '/password/reset',
  asyncHandler(async (req, res) => {
    const parsed = passwordResetSchema.safeParse(req.body);
    if (!parsed.success) return sendAuthError(res, 400, 'Invalid payload', 'INVALID_PAYLOAD');
    const { email, code, password } = parsed.data;
    const sanitizedEmail = email.trim().toLowerCase();

    // SECURITY: Check dedicated failure-based lockout before anything else
    const attemptCheck = await checkResetAttempt(sanitizedEmail);
    if (!attemptCheck.allowed) {
      return sendAuthError(res, 429, 'Too many attempts. Try again in 15 minutes.', 'RESET_LOCKED');
    }

    // Also keep the general rate limit as a secondary guard
    if (!(await checkAuthRateLimit(`reset:${sanitizedEmail}`))) {
      return sendAuthError(
        res,
        429,
        'Too many reset attempts. Please request a new code.',
        'RESET_RATE_LIMITED'
      );
    }

    const user = await prisma.user.findFirst({
      where: { email: { equals: sanitizedEmail, mode: 'insensitive' } },
    });
    if (!user || !user.password_reset_code || !user.password_reset_expires) {
      await recordResetFailure(sanitizedEmail);
      return sendAuthError(
        res,
        400,
        'Invalid reset code. Request a new code and try again.',
        'RESET_CODE_INVALID'
      );
    }
    if (new Date() > user.password_reset_expires) {
      await recordResetFailure(sanitizedEmail);
      return sendAuthError(
        res,
        400,
        'Reset code expired. Request a new code and try again.',
        'RESET_CODE_EXPIRED'
      );
    }
    // AUTH-5: stored value is now a SHA-256 hash (see /password/forgot), so we hash
    // the submitted code with the same function and compare hash-to-hash.
    const submittedCodeHash = hashRefreshToken(String(code).trim());
    const storedCode = String(user.password_reset_code).trim();
    const codesMatch = (() => {
      if (submittedCodeHash.length !== storedCode.length) return false;
      try {
        return crypto.timingSafeEqual(Buffer.from(submittedCodeHash), Buffer.from(storedCode));
      } catch {
        return false;
      }
    })();
    if (!codesMatch) {
      await recordResetFailure(sanitizedEmail);
      return sendAuthError(
        res,
        400,
        'Invalid reset code. Request a new code and try again.',
        'RESET_CODE_INVALID'
      );
    }

    // Success — clear failure tracking and reset the code
    await clearResetFailures(sanitizedEmail);

    const password_hash = await bcrypt.hash(password, PASSWORD_BCRYPT_COST);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        password_hash,
        password_reset_code: null,
        password_reset_expires: null,
        password_changed_at: new Date(),
      },
    });
    await revokeAllSessions(user.id);

    // Security alert: password changed notification removed as part of email cleanup

    return res.json({ ok: true });
  })
);

authRouter.post(
  '/password/change',
  authLimiter,
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const parsed = passwordChangeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' });
    const { current_password, new_password } = parsed.data;

    // Get user with password hash
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Verify current password
    if (!user.password_hash)
      return res
        .status(400)
        .json({ error: 'No password set. Use OAuth login or set a password first.' });
    const isValid = await bcrypt.compare(current_password, user.password_hash);
    if (!isValid) return res.status(401).json({ error: 'Current password is incorrect' });

    // Hash new password
    const password_hash = await bcrypt.hash(new_password, PASSWORD_BCRYPT_COST);

    // Update password and revoke all refresh tokens atomically
    await prisma.user.update({
      where: { id: user.id },
      data: {
        password_hash,
        password_changed_at: new Date(),
      },
    });
    await revokeAllSessions(user.id);

    // Password changed notification removed as part of email cleanup

    return res.json({ ok: true });
  })
);

// Upgrade a fan account to coach
// v1.0.2: 48hr cooldown for rejected coach/org applications.
const REJECTION_COOLDOWN_MS = 48 * 60 * 60 * 1000;

authRouter.post(
  '/upgrade-to-coach',
  requireAuth as any,
  requireVerified as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const parsed = upgradeToCoachSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: 'Invalid payload', issues: parsed.error.issues });
    const { plan } = parsed.data;

    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        id: true,
        username: true,
        preferences: true,
        role: true,
        approval_status: true,
        rejected_at: true,
        rejection_reason: true,
        date_of_birth: true,
        onboarding_completed: true,
        organization_id: true,
        proceeding_as_fan: true,
        coach_agreement_accepted_at: true,
        coach_agreement_version: true,
      },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const currentPrefs = (user.preferences as any) || {};
    const currentRole = getCanonicalUserRole(user as any);
    // If already a coach, reject
    if (currentRole === 'coach') {
      const latestApplication = await getLatestCoachApplication(prisma, user.id);
      const joinRequest = await getOrganizationJoinRequestStateForUser(
        getCanonicalOrganizationId(user as any),
        user.id
      );
      const flowState = getCoachFlowState(user as any, latestApplication, joinRequest);
      const approvalStatus = String(user.approval_status || '').toUpperCase();
      const code =
        approvalStatus === 'APPROVED'
          ? 'COACH_ALREADY_APPROVED'
          : approvalStatus === 'REJECTED'
            ? 'COACH_REAPPLICATION_REQUIRED'
            : 'COACH_UPGRADE_IN_PROGRESS';
      const error =
        approvalStatus === 'APPROVED'
          ? 'Account is already an approved coach account.'
          : approvalStatus === 'REJECTED'
            ? 'Your coach application needs to be resumed from the approval flow.'
            : 'Coach upgrade is already in progress for this account.';
      return res.status(409).json({
        error,
        code,
        account_state: flowState.account_state,
        next_step: flowState.next_step,
        coach_application: serializeCoachApplication(latestApplication),
      });
    }

    // v1.0.2: enforce 48hr cooldown on rejected applicants to prevent admin spam.
    // v1.0.2 pass 4: legacy users REJECTED before rejected_at was added (null column) would otherwise
    // bypass the cooldown entirely. Treat null rejected_at as "reject stamp unknown — apply cooldown
    // from right now and backfill" so they can't spam admins by exploiting the legacy-null state.
    if (user.approval_status === 'REJECTED') {
      let rejectedAt = user.rejected_at;
      if (!rejectedAt) {
        rejectedAt = new Date();
        await prisma.user.update({
          where: { id: user.id },
          data: { rejected_at: rejectedAt },
        });
        await invalidateMeCacheForUser(user.id);
      }
      const elapsed = Date.now() - new Date(rejectedAt).getTime();
      if (Number.isFinite(elapsed) && elapsed < REJECTION_COOLDOWN_MS) {
        const retryAfterMs = REJECTION_COOLDOWN_MS - elapsed;
        // v1.0.3: also return an absolute ISO timestamp. `retry_after_hours`
        // rounds up and reads misleadingly ("48 hours" sounds like 2 full days
        // from now when the real cooldown started from the prior rejection).
        // Clients should prefer `retry_at` for a concrete date/time display.
        return res.status(429).json({
          error: 'Your previous coach application was declined. Please wait before trying again.',
          code: 'REJECTION_COOLDOWN',
          retry_after_ms: retryAfterMs,
          retry_after_hours: Math.ceil(retryAfterMs / (60 * 60 * 1000)),
          retry_at: new Date(Date.now() + retryAfterMs).toISOString(),
          reason: user.rejection_reason || null,
        });
      }
    }

    // Server-side 18+ age gate — coaches must be adults.
    // SECURITY: previously `if (dob) { ... }` silently skipped the gate when a
    // user had no DOB on record, which let clients bypass 18+ by simply never
    // submitting one. DOB is now required at coach-role transition.
    const dob = resolveEffectiveDob(user.date_of_birth, currentPrefs);
    if (!dob) {
      return res.status(400).json({
        error: 'Date of birth required to upgrade to a coach account.',
        code: 'DOB_REQUIRED',
      });
    }
    {
      const birthDate = dob;
      const today = new Date();
      let age = today.getFullYear() - birthDate.getFullYear();
      const monthDiff = today.getMonth() - birthDate.getMonth();
      if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) age--;
      if (age < 18) {
        return res.status(403).json({
          error: 'You must be at least 18 years old to become a coach.',
          code: 'AGE_REQUIREMENT',
        });
      }
    }

    const isPaidPlan = plan === 'veteran' || plan === 'legend';

    // Update role to coach and reset onboarding so they complete coach steps.
    // Paid plans are deferred until checkout succeeds; store them in pending_plan
    // so approval + paywall middleware treat the account as unpaid until billing completes.
    // CRITICAL: Set approval_status to PENDING so the coach must go through the
    // approval flow (create/join org → admin approval) before accessing coach tools.
    const merged = {
      ...currentPrefs,
      role: 'coach',
      plan: isPaidPlan ? 'rookie' : plan,
      pending_plan: isPaidPlan ? plan : null,
      payment_pending: isPaidPlan,
      onboarding_completed: false,
    };
    const billingPatch = {
      plan: (isPaidPlan ? 'rookie' : plan) as 'rookie' | 'veteran' | 'legend',
      pending_plan: (isPaidPlan ? plan : null) as 'veteran' | 'legend' | null,
      payment_pending: isPaidPlan,
      payment_approved: false,
    };
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        preferences: mergeBillingStateIntoPreferences(
          mergeAuthStateIntoPreferences(merged, {
            role: 'coach',
            onboarding_completed: false,
          }),
          billingPatch
        ),
        role: 'coach',
        onboarding_completed: false,
        ...buildBillingStateColumns(billingPatch),
        approval_status: 'PENDING',
        // v1.0.2: clear rejection tracking on fresh re-apply.
        rejected_at: null,
        rejection_reason: null,
      },
    });
    await invalidateMeCacheForUser(updated.id);

    return res.json({ ok: true, preferences: updated.preferences });
  })
);

// v1.0.2: POST /auth/skip-payment
// Allows a coach stuck with payment_pending=true to escape the paywall loop by
// downgrading to the free rookie plan. Clears payment_pending, pending_plan, and
// payment_approved so the AuthProvider redirect no longer fires.
authRouter.post(
  '/skip-payment',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        id: true,
        preferences: true,
        plan: true,
        pending_plan: true,
        payment_pending: true,
        payment_approved: true,
      },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const prefs = (user.preferences as any) || {};

    if (!isPaymentPending(user as any)) {
      return res.json({ ok: true, message: 'No pending payment to skip.' });
    }

    const { payment_pending, payment_approved, pending_plan, ...restPrefs } = prefs;
    const nextPrefs = mergeBillingStateIntoPreferences(restPrefs, {
      plan: 'rookie',
      pending_plan: null,
      payment_pending: false,
      payment_approved: false,
    }) as Record<string, any>;
    delete nextPrefs.pending_plan;
    delete nextPrefs.payment_pending;
    delete nextPrefs.payment_approved;
    const updated = await prisma.user.update({
      where: { id: req.user!.id },
      data: {
        preferences: nextPrefs,
        ...buildBillingStateColumns({
          plan: 'rookie',
          pending_plan: null,
          payment_pending: false,
          payment_approved: false,
        }),
      },
    });
    await invalidateMeCacheForUser(updated.id);

    return res.json({ ok: true, preferences: updated.preferences });
  })
);

authRouter.post(
  '/downgrade-to-fan',
  requireAuth as any,
  requireVerified as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        id: true,
        preferences: true,
        role: true,
        approval_status: true,
        onboarding_completed: true,
        organization_id: true,
        proceeding_as_fan: true,
        coach_agreement_accepted_at: true,
        coach_agreement_version: true,
        plan: true,
        pending_plan: true,
        payment_pending: true,
        payment_approved: true,
        paid_by_owner: true,
      },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const currentRole = getCanonicalUserRole(user as any);
    if (currentRole !== 'coach') {
      return res.status(400).json({
        error: 'Only coach accounts can downgrade to fan.',
        code: 'NOT_COACH',
      });
    }

    const billingState = getCanonicalBillingState(user as any);
    if (
      billingState.plan !== 'rookie' ||
      billingState.pending_plan !== null ||
      billingState.payment_pending
    ) {
      return res.status(409).json({
        error: 'Move your subscription back to the free Rookie plan before downgrading.',
        code: 'SUBSCRIPTION_DOWNGRADE_REQUIRED',
      });
    }

    const ownedOrganizations = await prisma.organization.count({
      where: { league_owner_id: user.id },
    });
    if (ownedOrganizations > 0) {
      return res.status(409).json({
        error: 'Transfer organization ownership before downgrading to fan.',
        code: 'ORG_OWNERSHIP_TRANSFER_REQUIRED',
        organization_count: ownedOrganizations,
      });
    }

    const managedOrganizations = await prisma.organizationMembership.count({
      where: {
        user_id: user.id,
        status: 'active',
        role: { in: ['owner', 'manager'] },
      },
    });
    if (managedOrganizations > 0) {
      return res.status(409).json({
        error: 'Leave or transfer your organization leadership roles before downgrading.',
        code: 'ORG_ROLE_TRANSFER_REQUIRED',
        organization_role_count: managedOrganizations,
      });
    }

    const staffedTeams = await prisma.teamMembership.count({
      where: {
        user_id: user.id,
        status: 'active',
        role: { in: ['owner', 'manager', 'coach', 'assistant_coach'] },
      },
    });
    if (staffedTeams > 0) {
      return res.status(409).json({
        error: 'Transfer team ownership or leave team staff roles before downgrading.',
        code: 'TEAM_ROLE_TRANSFER_REQUIRED',
        team_role_count: staffedTeams,
      });
    }

    const currentPrefs = getPreferencesObject(user.preferences);
    delete currentPrefs.organization_name;
    delete currentPrefs.team_id;
    delete currentPrefs.team_name;
    delete currentPrefs.join_request_pending;
    delete currentPrefs.coach_application_id;
    delete currentPrefs.coach_application_status;

    const downgradedPreferences = mergeBillingStateIntoPreferences(
      mergeAuthStateIntoPreferences(currentPrefs, {
        role: 'fan',
        onboarding_completed: true,
        organization_id: null,
        proceeding_as_fan: false,
        coach_agreement_accepted_at: null,
        coach_agreement_version: null,
      }),
      {
        plan: 'rookie',
        pending_plan: null,
        payment_pending: false,
        payment_approved: false,
      }
    );

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        preferences: downgradedPreferences,
        ...buildAuthStateColumns({
          role: 'fan',
          onboarding_completed: true,
          organization_id: null,
          proceeding_as_fan: false,
          coach_agreement_accepted_at: null,
          coach_agreement_version: null,
        }),
        ...buildBillingStateColumns({
          plan: 'rookie',
          pending_plan: null,
          payment_pending: false,
          payment_approved: false,
        }),
        approval_status: 'APPROVED',
        rejected_at: null,
        rejection_reason: null,
        paid_by_owner: false,
      },
    });
    await invalidateMeCacheForUser(updated.id);

    return res.json({ ok: true, preferences: updated.preferences });
  })
);

// v1.0.2: POST /auth/coach/reapply
// Rejected coaches can re-apply after 48hr cooldown. Resets approval_status to PENDING
// and clears rejection tracking. Does not touch role (already coach). Protected by REJECTION_COOLDOWN_MS.
authRouter.post(
  '/coach/reapply',
  requireAuth as any,
  requireVerified as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        id: true,
        preferences: true,
        approval_status: true,
        rejected_at: true,
        rejection_reason: true,
      },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const prefs = (user.preferences as any) || {};
    const currentRole = getCanonicalUserRole(user as any);
    if (currentRole !== 'coach') {
      return res.status(400).json({
        error: 'Only coach accounts can re-apply. Upgrade to coach first.',
        code: 'NOT_COACH',
      });
    }
    if (user.approval_status !== 'REJECTED') {
      return res
        .status(400)
        .json({ error: 'Your application is not in a rejected state.', code: 'NOT_REJECTED' });
    }
    // v1.0.2 pass 4: handle legacy null rejected_at by backfilling the timestamp now,
    // preventing bypass via the legacy-null state.
    let rejectedAt2 = user.rejected_at;
    if (!rejectedAt2) {
      rejectedAt2 = new Date();
      await prisma.user.update({
        where: { id: user.id },
        data: { rejected_at: rejectedAt2 },
      });
      await invalidateMeCacheForUser(user.id);
    }
    const elapsed = Date.now() - new Date(rejectedAt2).getTime();
    if (Number.isFinite(elapsed) && elapsed < REJECTION_COOLDOWN_MS) {
      const retryAfterMs = REJECTION_COOLDOWN_MS - elapsed;
      return res.status(429).json({
        error: 'Please wait before re-applying.',
        code: 'REJECTION_COOLDOWN',
        retry_after_ms: retryAfterMs,
        retry_after_hours: Math.ceil(retryAfterMs / (60 * 60 * 1000)),
        reason: user.rejection_reason || null,
      });
    }
    // Reset to PENDING, clear rejection, force re-run of onboarding (org connect).
    // Strip the dead organization pointer so step-3-league starts fresh — otherwise
    // the coach's /me keeps pointing at the rejected org and the onboarding UI
    // shows stale league info.
    const {
      organization_id: _oid,
      organization_name: _oname,
      ...scrubbedPrefs
    } = prefs as Record<string, unknown>;
    const merged = { ...scrubbedPrefs, onboarding_completed: false, join_request_pending: false };
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        preferences: mergeAuthStateIntoPreferences(merged, {
          role: 'coach',
          onboarding_completed: false,
          organization_id: null,
          proceeding_as_fan: false,
        }),
        ...buildAuthStateColumns({
          role: 'coach',
          onboarding_completed: false,
          organization_id: null,
          proceeding_as_fan: false,
        }),
        approval_status: 'PENDING',
        rejected_at: null,
        rejection_reason: null,
      },
    });
    await invalidateMeCacheForUser(updated.id);
    return res.json({ ok: true, preferences: updated.preferences });
  })
);

const submitCoachApplicationSchema = z.object({
  organization_name: z.string().trim().min(2).max(255),
  org_type: z.string().trim().min(2).max(100).optional(),
  location: z.string().trim().min(2).max(500).optional(),
  zip_code: z.string().trim().max(20).optional(),
  place_id: z.string().trim().max(255).optional(),
  supporting_document_url: z.string().url().max(2000),
  background_url: z.string().url().max(2000).optional(),
});

authRouter.post(
  '/coach-applications',
  requireAuth as any,
  requireVerified as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const parsed = submitCoachApplicationSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid payload',
        issues: parsed.error.issues.map(issue => ({
          path: issue.path.map(String),
          message: issue.message,
        })),
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        id: true,
        email: true,
        display_name: true,
        username: true,
        approval_status: true,
        rejected_at: true,
        rejection_reason: true,
        preferences: true,
        role: true,
        onboarding_completed: true,
        organization_id: true,
        proceeding_as_fan: true,
      },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const currentUserState = { role: getCanonicalUserRole(user as any) };
    if (currentUserState.role !== 'coach') {
      return res.status(400).json({
        error: 'Upgrade to coach before submitting an application.',
        code: 'NOT_COACH',
      });
    }
    if (user.approval_status !== 'PENDING') {
      return res.status(400).json({
        error: 'Your account is not eligible for a new coach application submission.',
        code: 'INVALID_APPROVAL_STATE',
      });
    }
    if (user.organization_id) {
      return res.status(400).json({
        error: 'Your coach account already has an organization attached.',
        code: 'ORG_ALREADY_EXISTS',
      });
    }

    const data = parsed.data;
    const now = new Date();
    const nextPrefs = getPreferencesObject(user.preferences);
    delete nextPrefs.organization_id;
    delete nextPrefs.organization_name;
    delete nextPrefs.team_id;
    delete nextPrefs.team_name;
    nextPrefs.join_request_pending = false;

    // Coach application involves 3 sequential writes; increase timeout from 5s default
    // to 15s so connection pool pressure doesn't abort the transaction.
    const result = await prisma.$transaction(
      async tx => {
        await tx.coachApplication.updateMany({
          where: {
            user_id: user.id,
            status: { in: ['submitted', 'rejected'] },
          },
          data: {
            status: 'superseded',
            reviewed_at: now,
            review_note: 'Superseded by a newer coach application submission.',
          },
        });

        const application = await tx.coachApplication.create({
          data: {
            user_id: user.id,
            organization_name: data.organization_name,
            org_type: data.org_type,
            location: data.location,
            zip_code: data.zip_code,
            place_id: data.place_id,
            supporting_document_url: data.supporting_document_url,
            background_url: data.background_url,
            payload: data,
            submitted_at: now,
          },
        });

        const updatedUser = await tx.user.update({
          where: { id: user.id },
          data: {
            preferences: mergeAuthStateIntoPreferences(nextPrefs, {
              onboarding_completed: false,
              organization_id: null,
              proceeding_as_fan: false,
            }),
            ...buildAuthStateColumns({
              onboarding_completed: false,
              organization_id: null,
              proceeding_as_fan: false,
            }),
            approval_status: 'PENDING',
            rejected_at: null,
            rejection_reason: null,
          },
        });

        return { application, updatedUser };
      },
      { timeout: 15000, maxWait: 5000 }
    );

    await invalidateMeCacheForUser(user.id);

    const flowState = getCoachFlowState(result.updatedUser as any, result.application);
    const serializedApplication = serializeCoachApplication(result.application);

    const { getAllAdminEmails } = await import('../lib/adminEmails.js');
    const adminEmails = getAllAdminEmails();
    for (const adminEmail of adminEmails) {
      sendCoachApplicationAdminEmail({
        to: adminEmail,
        applicantName:
          result.updatedUser.display_name || result.updatedUser.username || data.organization_name,
        applicantUsername: result.updatedUser.username || undefined,
        applicantEmail: result.updatedUser.email,
        applicantUserId: result.updatedUser.id,
        organizationName: data.organization_name,
        approveUrl: buildCoachApplicationReviewUrl({
          coachId: result.updatedUser.id,
          action: 'approve',
        }),
        rejectUrl: buildCoachApplicationReviewUrl({
          coachId: result.updatedUser.id,
          action: 'reject',
        }),
        supportingDocumentUrl: data.supporting_document_url,
      })
        .then(sent => {
          if (!sent) {
            captureException(new Error('Coach application admin notification reported unsent'), {
              context: 'coach_application_admin_notification_unsent',
              adminEmail,
              userId: result.updatedUser.id,
            });
          }
        })
        .catch(err => {
          console.error(
            '[auth] Failed to send coach-application admin notification to',
            adminEmail,
            err?.message || err
          );
          captureException(err instanceof Error ? err : new Error(String(err)), {
            context: 'coach_application_admin_notification_failed',
            adminEmail,
            userId: result.updatedUser.id,
          });
        });
    }

    return res.status(201).json({
      ok: true,
      application: serializedApplication,
      user: {
        ...sanitizeUser(result.updatedUser),
        coach_application: serializedApplication,
        account_state: flowState.account_state,
        next_step: flowState.next_step,
      },
    });
  })
);

authRouter.get(
  '/me',
  requireAuth as any,
  authNoStore as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    // Cache-aside: check Redis first (TTL 60s)
    const cacheKey = `me:${req.user.id}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return res.json(cached);

    const [rawUser, activePostCount, coachApplication] = await Promise.all([
      prisma.user.findUnique({
        where: { id: req.user!.id },
        select: ME_USER_SELECT,
      }),
      prisma.post.count({
        where: { author_id: req.user!.id, deleted_at: null },
      }),
      getLatestCoachApplication(prisma, req.user!.id),
    ]);
    // Parallelize: verify OAuth state and look up join request concurrently.
    // Both only need rawUser/orgId which are already available.
    const orgIdFromRaw = getCanonicalOrganizationId(rawUser as any);
    const [user, joinRequest] = await Promise.all([
      ensureOAuthUserVerified(rawUser),
      getOrganizationJoinRequestStateForUser(orgIdFromRaw, req.user!.id),
    ]);
    if (!user) return res.status(404).json({ error: 'Not found' });
    const is_admin = isAdminEmail(user.email);
    const defaults = {
      notifications: {
        game_event_reminders: false,
        team_updates: false,
        comments_upvotes: false,
        follows_notifications: true,
        messages_notifications: true,
      },
      is_parent: false,
    };
    const has_password = !!(user as any).password_hash;
    const safe = sanitizeUser(user);
    const userPrefs = ((safe as any).preferences || {}) as Record<string, unknown>;
    // Defaults only backfill missing preference keys. Canonical auth/billing
    // state is already injected into `safe.preferences` by sanitizeUser.
    const prefs = mergePreferences(defaults, userPrefs);
    const normalizedRole = getCanonicalUserRole(user as any);
    const requiredCoachAgreementVersion = Number(process.env.REQUIRED_COACH_AGREEMENT_VERSION ?? 1);
    const serializedApplication = serializeCoachApplication(coachApplication);
    const flowState = getCoachFlowState(
      {
        ...user,
        coach_agreement_accepted_at: (safe as any).coach_agreement_accepted_at,
        coach_agreement_version: (safe as any).coach_agreement_version,
      } as any,
      coachApplication,
      joinRequest
    );
    const payload = {
      ...safe,
      _count: {
        ...(safe as any)._count,
        posts: activePostCount,
      },
      has_password,
      linked_providers: getLinkedProviders(user as any),
      role: normalizedRole,
      preferences: prefs,
      required_coach_agreement_version: requiredCoachAgreementVersion,
      is_admin,
      coach_application: serializedApplication,
      account_state: flowState.account_state,
      next_step: flowState.next_step,
    };
    void cacheSet(cacheKey, payload, 60); // 60s TTL
    return res.json(payload);
  })
);

const updateMeSchema = z.object({
  display_name: z
    .string()
    .min(1)
    .max(120)
    .transform(val => stripHtml(val))
    .refine(val => val.trim().length > 0, { message: 'Display name cannot be only whitespace' })
    .optional()
    .nullable(),
  username: z
    .string()
    .min(3)
    .max(20)
    .regex(/^[a-z0-9_.]+$/, {
      message: 'Username can only contain lowercase letters, numbers, dots, and underscores',
    })
    .refine(val => !isReservedUsername(val), { message: RESERVED_USERNAME_MESSAGE })
    .optional()
    .nullable(),
  avatar_url: z
    .string()
    .url({ message: 'Avatar URL must be a valid URL' })
    .refine(isAllowedAvatarUrl, AVATAR_URL_MESSAGE)
    .optional()
    .nullable(),
  bio: z
    .string()
    .max(300)
    .transform(val => stripHtml(val))
    .transform(val => (val === '' ? null : val))
    .optional()
    .nullable(),
});

async function handleUpdateMe(req: AuthedRequest, res: Response) {
  const body = (req.body || {}) as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(body, 'preferences')) {
    return res.status(400).json({
      error: 'Invalid payload',
      message: 'Use PATCH /me/preferences to update preferences.',
    });
  }
  const parsed = updateMeSchema.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid payload',
      issues: parsed.error.issues.map(i => ({ path: i.path, message: i.message })),
    });
  }
  const data = parsed.data as any;
  let patch: any = { ...data };

  // Strip null values for fields that should not be cleared (treat null as "don't change")
  // bio and avatar_url CAN be null (user wants to clear them), but display_name/username should not be wiped
  if (patch.display_name === null) delete patch.display_name;
  if (patch.username === null) delete patch.username;

  // Validate username availability if provided
  let priorUsername: string | null = null;
  if (data.username) {
    const exists = await prisma.user.findFirst({
      where: {
        username: { equals: data.username, mode: 'insensitive' },
        NOT: { id: req.user!.id },
      },
      select: { id: true },
    });
    if (exists) {
      return sendError(res, 400, 'Username taken', {
        message: 'This username is already in use.',
      });
    }
    // Capture prior username so we can rewrite mentions in posts/comments below.
    const me = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { username: true },
    });
    priorUsername = me?.username || null;
    patch.username = data.username;
  }
  const { preferences, ...rest } = patch;

  // Fetch the current avatar_url before overwriting so we can clean up the old
  // Cloudinary asset if the user is replacing their profile photo.
  let priorAvatarUrl: string | null = null;
  if (data.avatar_url !== undefined) {
    const currentUser = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { avatar_url: true },
    });
    priorAvatarUrl = currentUser?.avatar_url ?? null;
  }

  // cache-invalidation-exempt — invalidateMeCacheForUser called on line below
  let user;
  try {
    user = await prisma.user.update({
      where: { id: req.user!.id },
      data: { ...rest, ...(preferences ? { preferences } : {}) },
    });
  } catch (err: any) {
    // P2002 = unique constraint violation — username was claimed by a concurrent request
    // between our findFirst check above and this update.
    if (err?.code === 'P2002' && err?.meta?.target?.includes('username')) {
      return sendError(res, 400, 'Username taken', {
        message: 'This username is already in use.',
      });
    }
    throw err;
  }
  await invalidateMeCacheForUser(req.user!.id);

  // Rewrite @mentions in existing posts + comments so old @oldname becomes @newname.
  // Fire-and-forget so the user's response isn't blocked. Uses raw SQL for case-insensitive
  // word-boundary replace; safe because both names are validated against /^[a-z0-9_.]+$/.
  if (
    priorUsername &&
    data.username &&
    priorUsername.toLowerCase() !== data.username.toLowerCase()
  ) {
    const oldHandle = '@' + priorUsername;
    const newHandle = '@' + data.username;
    const mentionRewriteSql = (table: 'Post' | 'Comment') =>
      Prisma.sql`UPDATE ${Prisma.raw(`"${table}"`)}
        SET content = regexp_replace(content, '\\m' || ${oldHandle} || '\\M', ${newHandle}, 'g')
        WHERE content ILIKE '%' || ${oldHandle} || '%'`;
    (async () => {
      try {
        await prisma.$executeRaw(mentionRewriteSql('Post'));
        await prisma.$executeRaw(mentionRewriteSql('Comment'));
      } catch (err: any) {
        console.error('[auth] mention rewrite after username change failed:', err?.message || err);
      }
    })();
  }

  // Fire-and-forget: destroy the old avatar if it was replaced. Handles BOTH
  // storage backends: Cloudinary assets and R2 objects (avatars migrated to R2
  // 2026-07; the Cloudinary-only gate used to leave every replaced R2 avatar
  // orphaned in the bucket). Both helpers are host-gated — extractCloudinaryPublicId
  // requires a cloudinary.com host and extractR2Key requires the R2_PUBLIC_BASE_URL
  // prefix — so Google/Apple CDN avatars we don't own no-op through both.
  if (priorAvatarUrl && priorAvatarUrl !== (data.avatar_url ?? null)) {
    void (async () => {
      try {
        const [{ extractCloudinaryPublicId, destroyCloudinaryAsset }, { deleteR2ObjectByUrl }] =
          await Promise.all([import('../lib/cloudinary.js'), import('../lib/r2.js')]);
        const parsed = extractCloudinaryPublicId(priorAvatarUrl!);
        if (parsed) {
          await destroyCloudinaryAsset(parsed.publicId, parsed.resourceType);
          return;
        }
        // Not a Cloudinary URL — try R2 (no-op if not an R2 URL).
        await deleteR2ObjectByUrl(priorAvatarUrl!);
      } catch (err: any) {
        console.warn('[auth] old avatar cleanup failed:', err?.message || err);
      }
    })();
  }

  return res.json(sanitizeUser(user));
}

authRouter.put(
  '/me',
  profileUpdateLimiter,
  requireAuth as any,
  requireVerified as any,
  asyncHandler((req: AuthedRequest, res) => handleUpdateMe(req, res))
);

// PATCH /me now delegates to the same shared handler as PUT /me,
// ensuring @mention rewrites are applied consistently on username changes.
authRouter.patch(
  '/me',
  profileUpdateLimiter,
  requireAuth as any,
  requireVerified as any,
  asyncHandler((req: AuthedRequest, res) => handleUpdateMe(req, res))
);

// Utility to deep-merge preferences, preserving nested notification keys
function mergePreferences(base: any, incoming: any) {
  if (!base && !incoming) return {};
  if (!base) return incoming;
  if (!incoming) return base;

  const out = { ...base };

  // Deep merge for nested objects
  for (const key in incoming) {
    if (incoming[key] === null || incoming[key] === undefined) {
      // Explicit null/undefined means remove (for optional fields)
      // But preserve existing if not explicitly set to null
      if (incoming[key] === null && key in incoming) {
        delete out[key];
      }
    } else if (
      typeof incoming[key] === 'object' &&
      !Array.isArray(incoming[key]) &&
      incoming[key] !== null &&
      incoming[key].constructor === Object
    ) {
      // Deep merge objects (but not arrays or special objects like Date)
      out[key] = mergePreferences(base[key], incoming[key]);
    } else {
      // Overwrite primitives and arrays
      out[key] = incoming[key];
    }
  }

  return out;
}

// Keys that a client must NEVER set via preferences — these are server-controlled.
// approval_status lives on the User model, not in preferences, but we strip it
// from incoming prefs as defense-in-depth in case it leaks into the JSON blob.
const PROTECTED_PREF_KEYS = new Set([
  'approval_status',
  'is_admin',
  'plan',
  'pending_plan',
  'paid_by_owner',
  'payment_pending',
  'payment_approved',
]);

function stripProtectedKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const cleaned = { ...obj };
  for (const key of PROTECTED_PREF_KEYS) {
    delete cleaned[key];
  }
  return cleaned;
}

// Partial update for user preferences
authRouter.patch(
  '/me/preferences',
  requireAuth as any,
  requireVerified as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const schema = z
      .object({
        notifications: z
          .object({
            game_event_reminders: z.boolean().optional(),
            team_updates: z.boolean().optional(),
            comments_upvotes: z.boolean().optional(),
            follows_notifications: z.boolean().optional(),
            messages_notifications: z.boolean().optional(),
          })
          .partial()
          .optional(),
        is_parent: z.boolean().optional(),
        zip_code: z.string().min(2).max(20).optional().nullable(),
        onboarding_completed: z.boolean().optional(),

        // New onboarding fields
        // NOTE: `plan` is intentionally NOT accepted here — it is server-controlled
        // (set only via verified payment / subscription flows). stripProtectedKeys()
        // also drops it as defense-in-depth, and this schema is non-strict so an
        // incoming `plan` is silently ignored. Do NOT re-add it — that would be a
        // client-controlled-plan foot-gun.
        // Rookie is not a role
        role: z.enum(['fan', 'coach']).optional(),
        affiliation: z
          .enum([
            'none',
            'other',
            'school',
            'independent',
            'university',
            'high_school',
            'club',
            'youth',
            'professional',
          ])
          .optional(),
        dob: z.string().optional(),
        sports_interests: z.array(z.string()).optional(),
        personalization_goals: z.array(z.string()).optional(),
        primary_intents: z.array(z.string()).optional(),
        season_start: z.string().optional(),
        season_end: z.string().optional(),
        location_enabled: z.boolean().optional(),
        notifications_enabled: z.boolean().optional(),
        messaging_policy_accepted: z.boolean().optional(),
        push_token: z.string().optional(),
        profile_private: z.boolean().optional(),
        comment_permission: z.enum(['everyone', 'following', 'none']).optional(),
        dm_policy: z.enum(['everyone', 'following', 'no_one']).optional(),
        proceeding_as_fan: z.boolean().optional(),
        coach_agreement_accepted_at: z.string().optional(),

        // Profile fields from edit-profile screen
        location: z.string().max(200).optional().nullable(),
        header_image_url: z.string().url().optional().nullable(),
        header_image_focus_y: z.number().min(-1).max(1).optional().nullable(),
        theme_color: z.string().max(20).optional().nullable(),
        position: z.string().max(100).optional().nullable(),
        jersey_number: z.string().max(10).optional().nullable(),
        grade_level: z.enum(['Freshman', 'Sophomore', 'Junior', 'Senior']).optional().nullable(),
        graduation_year: z.number().int().min(2020).max(2040).optional().nullable(),
        accolades: z.array(z.string()).optional().nullable(),
        primary_sport: z.string().max(50).optional().nullable(),
      })
      .partial();

    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid payload',
        issues: parsed.error.issues.map(i => ({ path: i.path, message: i.message })),
      });
    }

    // SECURITY: Strip any protected keys the client tries to sneak in
    const incoming = stripProtectedKeys(parsed.data as any) as any;

    // COPPA: Reject if DOB indicates under 13 - do not store
    if (incoming.dob !== undefined && isUnder13(incoming.dob)) {
      return res.status(403).json({
        error: 'COPPA_UNDER_13',
        message:
          'VarsityHub is not available for users under 13. Please have a parent or guardian contact support@varsityhub.app.',
      });
    }
    const current = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        preferences: true,
        email: true,
        approval_status: true,
        date_of_birth: true,
        dob_set_at: true,
        role: true,
        onboarding_completed: true,
        organization_id: true,
        proceeding_as_fan: true,
        coach_agreement_accepted_at: true,
        coach_agreement_version: true,
      },
    });
    const currentPrefs = (current?.preferences as any) || {};
    const currentAuthState = getCanonicalAuthState(current as any);

    // Gate `coach_agreement_accepted_at` writes so only an approved coach can
    // accept the agreement. Previously the PATCH accepted the timestamp from
    // any user in any state — a fan or pending coach could land a bogus
    // acceptance timestamp on their row. The server state machine already
    // compensated (a fan with this field still resolves to `fan_active` via
    // getCoachFlowState's role check), but the audit trail would show an
    // agreement the user never actually saw. Defense-in-depth: refuse the
    // write at the endpoint boundary instead of relying on downstream reads
    // to ignore it. Only after passing the gate do we stamp the version.
    if (incoming.coach_agreement_accepted_at !== undefined) {
      if (currentAuthState.role !== 'coach' || current?.approval_status !== 'APPROVED') {
        return res.status(403).json({
          error: 'You must be an approved coach to accept the coach agreement.',
          code: 'COACH_AGREEMENT_NOT_ELIGIBLE',
        });
      }
      // Server-side normalize: when a client writes the accept timestamp,
      // stamp the CURRENT required version alongside it so the client never
      // has to know the version number. Without this, bumping
      // REQUIRED_COACH_AGREEMENT_VERSION would loop coaches in re-accept.
      incoming.coach_agreement_version = Number(process.env.REQUIRED_COACH_AGREEMENT_VERSION ?? 1);
    }

    // Canonical DOB gate: under-13 users are blocked, but DOB itself remains
    // editable after first set. `evaluateDobUpdate` normalizes the date and
    // preserves the original first-set timestamp when applicable.
    let patchDobColumnWrite: { date_of_birth: Date; dob_set_at?: Date } | null = null;
    if (incoming.dob !== undefined && incoming.dob !== null && incoming.dob !== '') {
      const decision = evaluateDobUpdate({
        currentDob: current?.date_of_birth ?? null,
        currentSetAt: current?.dob_set_at ?? null,
        incomingDob: incoming.dob,
      });
      if (!decision.ok) {
        return res.status(400).json({
          error: 'INVALID_DOB',
          message: 'Date of birth is not a valid date.',
        });
      }
      if (decision.changed) {
        patchDobColumnWrite = {
          date_of_birth: decision.newDob,
          ...(decision.newSetAt ? { dob_set_at: decision.newSetAt } : {}),
        };
      }
    }

    // SECURITY: Prevent role changes after onboarding is completed.
    // The only legitimate path to change role post-onboarding is POST /auth/upgrade-to-coach.
    if (
      incoming.role &&
      currentAuthState.onboarding_completed === true &&
      incoming.role !== currentAuthState.role
    ) {
      return res.status(403).json({
        error:
          'Cannot change role after onboarding is complete. Use the upgrade-to-coach endpoint.',
      });
    }

    // v1.0.2 pass 6: SECURITY — prevent skipping onboarding by setting onboarding_completed=true
    // directly via PATCH. The legitimate path is POST /auth/complete-onboarding which validates
    // required fields. We allow clients to set it to `false` (restart flow) and to re-affirm `true`
    // if the server state already confirms it. Any other attempt is rejected.
    if (incoming.onboarding_completed === true && currentAuthState.onboarding_completed !== true) {
      // Require the same baseline fields /complete-onboarding checks for the user's role.
      const effectiveRole = incoming.role || currentAuthState.role || 'fan';
      const currentUserRec = await prisma.user.findUnique({
        where: { id: req.user!.id },
        select: { username: true },
      });
      if (effectiveRole === 'coach') {
        const hasUsername = !!currentUserRec?.username || !!incoming.username;
        const hasOrgOrTeam = !!(
          currentAuthState.organization_id ||
          currentPrefs.team_id ||
          incoming.organization_id ||
          incoming.team_id
        );
        if (!hasUsername || !hasOrgOrTeam) {
          return res.status(400).json({
            error:
              'Cannot mark onboarding complete — required coach fields missing. Use POST /auth/complete-onboarding.',
            code: 'ONBOARDING_VALIDATION_REQUIRED',
          });
        }
      } else {
        // Fan minimum: must have a username on record
        if (!currentUserRec?.username) {
          return res.status(400).json({
            error:
              'Cannot mark onboarding complete — username missing. Use POST /auth/complete-onboarding.',
            code: 'ONBOARDING_VALIDATION_REQUIRED',
          });
        }
      }
    }

    // Server-side 18+ age gate for coaches (mirrors /upgrade-to-coach and /complete-onboarding).
    // SECURITY: DOB is required — previously a missing DOB silently bypassed the gate.
    if (incoming.role === 'coach' && currentAuthState.role !== 'coach') {
      const effectiveDob = resolveEffectiveDob(current?.date_of_birth, currentPrefs, incoming.dob);
      if (!effectiveDob) {
        return res.status(400).json({
          error: 'Date of birth required to set coach role.',
          code: 'DOB_REQUIRED',
        });
      }
      const birthDate = effectiveDob;
      const today = new Date();
      let age = today.getFullYear() - birthDate.getFullYear();
      const monthDiff = today.getMonth() - birthDate.getMonth();
      if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) age--;
      if (age < 18) {
        return res.status(403).json({
          error: 'You must be at least 18 years old to become a coach.',
          code: 'AGE_REQUIREMENT',
        });
      }
    }

    // SECURITY: If role is being set to 'coach' and user was not previously a coach,
    // force approval_status to PENDING atomically. This ensures requireOnboarded
    // blocks all coach tools until an admin or org owner explicitly approves.
    // We do this in the same update below to avoid race conditions.
    const forceApprovalPending = incoming.role === 'coach' && currentAuthState.role !== 'coach';

    // Check if user is admin (same logic as GET /me endpoint)
    const is_admin = isAdminEmail(current?.email);
    const defaults = {
      notifications: {
        game_event_reminders: false,
        team_updates: false,
        comments_upvotes: false,
        follows_notifications: true,
        messages_notifications: true,
      },
      is_parent: false,
      plan: null,
      role: 'fan',
      sports_interests: [],
      personalization_goals: [],
      primary_intents: [],
      location_enabled: false,
      notifications_enabled: true,
      messaging_policy_accepted: false,
    };

    const merged = stripProtectedKeys(
      mergePreferences(mergePreferences(defaults, current?.preferences || {}), incoming)
    ) as any;
    const authStatePatch: Record<string, unknown> = {};
    if (incoming.role !== undefined) authStatePatch.role = incoming.role;
    if (incoming.onboarding_completed !== undefined) {
      authStatePatch.onboarding_completed = incoming.onboarding_completed;
    }
    if (incoming.organization_id !== undefined)
      authStatePatch.organization_id = incoming.organization_id;
    if (incoming.proceeding_as_fan !== undefined) {
      authStatePatch.proceeding_as_fan = incoming.proceeding_as_fan;
    }
    if (incoming.coach_agreement_accepted_at !== undefined) {
      authStatePatch.coach_agreement_accepted_at = incoming.coach_agreement_accepted_at || null;
    }
    if (incoming.coach_agreement_version !== undefined) {
      authStatePatch.coach_agreement_version = incoming.coach_agreement_version ?? null;
    }
    const dualWrittenPreferences = mergeAuthStateIntoPreferences(merged, authStatePatch);

    const updated = await prisma.user.update({
      where: { id: req.user!.id },
      data: {
        preferences: dualWrittenPreferences,
        ...buildAuthStateColumns(authStatePatch),
        ...(forceApprovalPending ? { approval_status: 'PENDING' } : {}),
        ...(patchDobColumnWrite
          ? deriveParentalConsentFields(patchDobColumnWrite.date_of_birth)
          : {}),
        ...(patchDobColumnWrite ?? {}),
      },
    });

    // Push-token de-duplication: if this PATCH wrote a push_token, ensure no
    // OTHER user still has the same token registered. Without this, switching
    // accounts on the same device leaves the prior account's preferences
    // pointing at this device's push token, so notifications targeting either
    // account get delivered here. The user reports it as "feeling signed into
    // multiple accounts at once."
    //
    // Whoever most-recently registered owns the device. Background-write per
    // affected row to keep the request bounded; failures are logged + captured
    // but don't fail the PATCH because the new user's preference IS already
    // saved correctly.
    const newPushToken = typeof incoming.push_token === 'string' ? incoming.push_token : null;
    if (newPushToken && newPushToken.length > 0) {
      try {
        const others = await prisma.user.findMany({
          where: {
            AND: [
              { id: { not: req.user!.id } },
              { preferences: { path: ['push_token'], equals: newPushToken } as any },
            ],
          },
          select: { id: true, preferences: true },
          // Device push tokens should be effectively unique. Bound the cleanup
          // scan so a malformed/shared token can never trigger an unbounded read.
          take: 25,
        });
        for (const other of others) {
          const otherPrefs = ((other.preferences as any) || {}) as Record<string, unknown>;
          if (otherPrefs.push_token !== newPushToken) continue;
          const { push_token: _stripped, ...rest } = otherPrefs;
          await prisma.user
            .update({
              where: { id: other.id },
              data: { preferences: rest as any },
            })
            .catch((err: any) => {
              console.warn('[auth] push_token reassignment cleanup failed:', err?.message || err);
              captureException(err instanceof Error ? err : new Error(String(err)), {
                context: 'push_token_reassign_cleanup_failed',
                outgoingUserId: other.id,
                incomingUserId: req.user!.id,
              });
            });
          await invalidateMeCacheForUser(other.id).catch((err: unknown) => {
            console.warn(
              '[auth] Cache invalidation failed (non-critical):',
              (err as Error)?.message
            );
          });
        }
      } catch (err: any) {
        console.warn('[auth] push_token reassignment scan failed:', err?.message || err);
        captureException(err instanceof Error ? err : new Error(String(err)), {
          context: 'push_token_reassign_scan_failed',
          incomingUserId: req.user!.id,
        });
      }
    }

    // Invalidate profile cache so GET /me returns fresh data immediately
    await invalidateMeCacheForUser(req.user!.id);

    // Invalidate the private-IDs feed cache when a user toggles profile_private
    if (incoming.profile_private !== undefined) {
      invalidatePrivateIdsCache();
    }

    return res.json({ preferences: updated.preferences });
  })
);

// Complete onboarding endpoint
const completeOnboardingSchema = z.object({
  // Core identity fields
  // Rookie is not a role
  role: z.enum(['fan', 'coach']).optional(),
  username: z
    .string()
    .min(3)
    .max(20)
    .regex(
      /^[a-z0-9_.]+$/,
      'Username must contain only lowercase letters, numbers, dots, and underscores'
    )
    .refine(val => !isReservedUsername(val), RESERVED_USERNAME_MESSAGE)
    .optional(),
  display_name: z
    .string()
    .min(1)
    .max(120)
    .refine(val => val.trim().length > 0, { message: 'Display name cannot be only whitespace' })
    .optional(),
  affiliation: z
    .enum([
      'none',
      'other',
      'university',
      'high_school',
      'club',
      'youth',
      'school',
      'independent',
      'professional',
    ])
    .optional(),
  dob: z.string().optional(),
  // For 13-17 minors, parent_email is required to initiate the consent flow.
  // For adults and under-13 (rejected at COPPA gate), it's ignored.
  parent_email: z.string().email().max(320).optional(),
  zip: z.string().optional(),
  zip_code: z.string().optional(),

  // Team/Organization
  team_id: z.string().optional(),
  team_name: z.string().optional(),
  organization_id: z.string().optional(),
  organization_name: z.string().optional(),
  join_request_pending: z.boolean().optional(),
  sport: z.string().optional(),

  // Season
  season_start: z.string().optional(),
  season_end: z.string().optional(),

  // Authorized users
  authorized: z.array(z.any()).optional(),
  authorized_users: z.array(z.any()).optional(),

  // Profile
  avatar_url: z.string().url().refine(isAllowedAvatarUrl, AVATAR_URL_MESSAGE).optional(),
  bio: z.string().max(300).optional(),
  sports_interests: z.array(z.string()).optional(),

  // Interests/Goals
  primary_intents: z.array(z.string()).optional(),
  personalization_goals: z.array(z.string()).optional(),

  // Features/Permissions
  location_enabled: z.boolean().optional(),
  notifications_enabled: z.boolean().optional(),
  messaging_policy_accepted: z.boolean().optional(),

  // Coach proceeding as fan while awaiting approval
  proceeding_as_fan: z.boolean().optional(),
});

authRouter.post(
  '/me/complete-onboarding',
  authLimiter,
  requireAuth as any,
  requireVerified as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const parsed = completeOnboardingSchema.safeParse(req.body);
    if (!parsed.success) {
      console.error('[Onboarding] Validation failed:', parsed.error);
      return res.status(400).json({
        error: 'Invalid payload',
        issues: parsed.error.issues.map(i => ({ path: i.path, message: i.message })),
      });
    }

    const data = parsed.data;

    // COPPA: Reject if DOB indicates under 13 - do not store
    if (data.dob !== undefined && isUnder13(data.dob)) {
      return res.status(403).json({
        error: 'COPPA_UNDER_13',
        message:
          'VarsityHub is not available for users under 13. Please have a parent or guardian contact support@varsityhub.app.',
      });
    }

    // Get current preferences FIRST to preserve role if not in payload
    const current = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        preferences: true,
        approval_status: true,
        date_of_birth: true,
        dob_set_at: true,
        role: true,
        onboarding_completed: true,
        organization_id: true,
        proceeding_as_fan: true,
        plan: true,
        pending_plan: true,
        payment_pending: true,
        payment_approved: true,
      },
    });
    const currentPrefs = (current?.preferences as any) || {};
    const currentAuthState = getCanonicalAuthState(current as any);

    // COPPA gate: onboarding cannot complete without a canonical DOB. The
    // helper `isMinor()` fails closed for null DOB, but the real defense is
    // here — `onboarding_completed === true` must GUARANTEE a non-null
    // `date_of_birth`. Either the payload provides a new DOB or the user
    // already has one from registration / an earlier onboarding attempt.
    const willHaveDob =
      (data.dob !== undefined && data.dob !== null && data.dob !== '') ||
      current?.date_of_birth !== null;
    if (!willHaveDob) {
      return res.status(400).json({
        error: 'DOB_REQUIRED',
        message: 'Date of birth is required to complete onboarding.',
      });
    }

    // Canonical DOB gate — same normalization logic as PATCH /me/preferences.
    let onboardingDobColumnWrite: { date_of_birth: Date; dob_set_at?: Date } | null = null;
    if (data.dob !== undefined && data.dob !== null && data.dob !== '') {
      const decision = evaluateDobUpdate({
        currentDob: current?.date_of_birth ?? null,
        currentSetAt: current?.dob_set_at ?? null,
        incomingDob: data.dob,
      });
      if (!decision.ok) {
        return res.status(400).json({
          error: 'INVALID_DOB',
          message: 'Date of birth is not a valid date.',
        });
      }
      if (decision.changed) {
        onboardingDobColumnWrite = {
          date_of_birth: decision.newDob,
          ...(decision.newSetAt ? { dob_set_at: decision.newSetAt } : {}),
        };
      }
    }

    // Detect if this user is a 13-17 minor after applying any pending DOB
    // change. If so, parental consent must be initiated. The check runs against
    // the PROSPECTIVE DOB (post-update) so a first-time DOB set in this call
    // immediately triggers the consent requirement rather than waiting for the
    // next request.
    const prospectiveDob =
      onboardingDobColumnWrite?.date_of_birth ?? current?.date_of_birth ?? null;
    const minorRequiringConsent = requiresParentalConsent({
      date_of_birth: prospectiveDob,
      preferences: { ...currentPrefs, ...(data.dob !== undefined ? { dob: data.dob } : {}) },
    });
    if (minorRequiringConsent) {
      // Parent email is required exactly once, at the point we detect a minor.
      // Subsequent re-calls (e.g. resend flow) skip this because the user's
      // parental_consent_status will already be pending/approved.
      // TypeScript: `parent_email` lives on User but the Prisma client for this
      // checkout may not yet expose it; the runtime behavior is correct and
      // the cast narrows the field access only.
      const existingParentEmail = (current as any)?.parent_email as string | null | undefined;
      const providedParentEmail = data.parent_email?.trim().toLowerCase();
      const effectiveParentEmail = providedParentEmail || existingParentEmail || null;
      if (!effectiveParentEmail) {
        return res.status(400).json({
          error: 'PARENT_EMAIL_REQUIRED',
          message:
            'A parent or guardian email is required to complete onboarding for users under 18.',
        });
      }
    }

    // CRITICAL: Role MUST be preserved from onboarding step-1 or provided in payload
    // If role is undefined in payload, use existing role from preferences (set during step-1)
    const finalRole = data.role !== undefined ? data.role : currentAuthState.role || 'fan';

    // Server-side 18+ age gate for coaches (mirrors /upgrade-to-coach validation).
    // SECURITY: DOB is required — previously a missing DOB silently bypassed the gate.
    if (finalRole === 'coach') {
      const effectiveDob = resolveEffectiveDob(current?.date_of_birth, currentPrefs, data.dob);
      if (!effectiveDob) {
        return res.status(400).json({
          error: 'Date of birth required to complete coach onboarding.',
          code: 'DOB_REQUIRED',
        });
      }
      const birthDate = effectiveDob;
      const today = new Date();
      let age = today.getFullYear() - birthDate.getFullYear();
      const monthDiff = today.getMonth() - birthDate.getMonth();
      if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) age--;
      if (age < 18) {
        return res.status(403).json({
          error: 'You must be at least 18 years old to become a coach.',
          code: 'AGE_REQUIREMENT',
        });
      }
    }

    // CRITICAL: For coaches, validate required steps are completed
    // Fall back to existing DB values for retry scenarios where payload may be incomplete
    const currentUser = await prisma.user.findUnique({ where: { id: req.user!.id } });
    // Billing-owned state must come from payment/server flows, never this endpoint.
    const persistedPlan = getCanonicalPlan(current as any);
    if (finalRole === 'coach') {
      const effectiveUsername = data.username || currentUser?.username;
      const effectivePlan = getSelectedPlan(current as any);
      const effectiveOrgId = data.organization_id || currentAuthState.organization_id;
      const effectiveTeamId = data.team_id || currentPrefs.team_id;
      if (!effectiveUsername) {
        return res.status(400).json({ error: 'Username required for coach onboarding' });
      }
      if (!effectivePlan) {
        return res.status(400).json({ error: 'Plan selection required for coach onboarding' });
      }
      if (!effectiveTeamId && !effectiveOrgId) {
        // v1.0.3: add explicit error code so the client can render a
        // path-specific message instead of a generic 400. Previously users
        // hitting this branch (e.g. via a deep-link that skipped step-3) saw
        // "Failed to complete onboarding" with no direction.
        return sendError(res, 400, 'Team or organization required for coach onboarding', {
          code: 'ORG_TEAM_REQUIRED',
        });
      }
      // Use DB values as fallback if not in payload
      if (!data.username && effectiveUsername) data.username = effectiveUsername;
      if (!data.organization_id && effectiveOrgId) data.organization_id = effectiveOrgId;
      if (!data.team_id && effectiveTeamId) data.team_id = effectiveTeamId;
    }

    // Update user with direct fields
    const updateData: any = {};
    if (data.username) updateData.username = data.username;
    if (data.display_name) updateData.display_name = data.display_name;
    if (data.avatar_url) updateData.avatar_url = data.avatar_url;
    if (data.bio) updateData.bio = data.bio;
    // Do not auto-set default bio — if user leaves bio blank, keep it blank

    // Prepare preferences update

    const preferencesUpdate: any = {
      onboarding_completed: true,
      role: finalRole, // Always set role explicitly - never leave undefined
      plan: persistedPlan,
      affiliation: data.affiliation,
      dob: data.dob,
      zip_code: data.zip_code || data.zip,
      team_id: data.team_id,
      team_name: data.team_name,
      organization_id: data.organization_id,
      organization_name: data.organization_name,
      join_request_pending: data.join_request_pending,
      sport: data.sport,
      season_start: data.season_start,
      season_end: data.season_end,
      authorized_users: data.authorized || data.authorized_users,
      sports_interests: data.sports_interests,
      primary_intents: data.primary_intents || data.personalization_goals,
      personalization_goals: data.personalization_goals || data.primary_intents,
      location_enabled: data.location_enabled,
      notifications_enabled: data.notifications_enabled,
      messaging_policy_accepted: data.messaging_policy_accepted,
      proceeding_as_fan: data.proceeding_as_fan,
    };

    // CRITICAL: Role must NEVER be undefined - preserve from current preferences if not in payload
    // This ensures OAuth-created users (who start as 'fan') can properly become 'coach' during onboarding
    if (preferencesUpdate.role === undefined) {
      preferencesUpdate.role = currentAuthState.role || 'fan'; // Use existing role or default to fan
    }

    // Clean up undefined values (but keep role - it's already set above)
    Object.keys(preferencesUpdate).forEach(key => {
      if (preferencesUpdate[key] === undefined && key !== 'role') {
        delete preferencesUpdate[key];
      }
    });
    // Normalize any legacy 'rookie' role values to 'coach' during merge
    const basePreferences = current?.preferences;
    const normalizedCurrent =
      basePreferences && typeof basePreferences === 'object' && !Array.isArray(basePreferences)
        ? ({ ...(basePreferences as Record<string, any>) } as any)
        : ({} as any);
    if (normalizedCurrent.role === 'rookie') {
      normalizedCurrent.role = 'coach';
    }
    // CRITICAL: Ensure role from preferencesUpdate takes precedence (user's choice during onboarding)
    const merged = stripProtectedKeys(
      mergePreferences(normalizedCurrent || {}, preferencesUpdate)
    ) as any;
    merged.plan = persistedPlan;
    const onboardingAuthPatch = {
      role: finalRole,
      onboarding_completed: true,
      organization_id:
        data.organization_id !== undefined
          ? data.organization_id || null
          : (currentAuthState.organization_id ?? null),
      proceeding_as_fan:
        data.proceeding_as_fan !== undefined
          ? data.proceeding_as_fan
          : isProceedingAsFan(current as any),
    };
    updateData.preferences = mergeAuthStateIntoPreferences(merged, onboardingAuthPatch);
    Object.assign(updateData, buildAuthStateColumns(onboardingAuthPatch));

    const hasReviewedCoachContext =
      current?.approval_status === 'APPROVED' &&
      currentAuthState.onboarding_completed === true &&
      Boolean(currentAuthState.organization_id);

    // SECURITY: Any fresh fan-to-coach onboarding transition must enter review.
    // New fan rows default to APPROVED for normal app access, so that default
    // cannot be trusted as coach approval. However, some legacy/retry rows have
    // split role state while already carrying an explicit APPROVED, completed,
    // org-bound coach context; onboarding replay must preserve that reviewed
    // status instead of demoting.
    if (finalRole === 'coach' && currentAuthState.role !== 'coach' && !hasReviewedCoachContext) {
      updateData.approval_status = 'PENDING';
    }

    // Persist parent_email when we detected a minor — stored alongside the
    // canonical DOB so the consent flow (below) has the address to email.
    const parentEmailToPersist = minorRequiringConsent
      ? data.parent_email?.trim().toLowerCase() || null
      : null;

    // Update user
    const updated = await prisma.user.update({
      where: { id: req.user!.id },
      data: {
        ...updateData,
        ...(onboardingDobColumnWrite
          ? deriveParentalConsentFields(onboardingDobColumnWrite.date_of_birth)
          : {}),
        ...(onboardingDobColumnWrite ?? {}),
        ...(parentEmailToPersist ? { parent_email: parentEmailToPersist } : {}),
      } as any,
    });
    await invalidateMeCacheForUser(updated.id);

    // Kick off the parental-consent email if this is a 13-17 minor who does
    // not already have an active consent token outstanding. Fire-and-forget
    // so email provider hiccups don't 500 the onboarding request — the
    // resend endpoint handles recovery if the email fails to arrive.
    if (minorRequiringConsent) {
      void (async () => {
        try {
          const fresh = await prisma.user.findUnique({
            where: { id: updated.id },
            select: {
              parent_email: true,
              display_name: true,
              email: true,
              parental_consent_status: true,
              parental_consent_token_hash: true,
            } as any,
          });
          const freshAny = fresh as any;
          if (!freshAny) return;
          if (freshAny.parental_consent_status !== 'pending') return;
          if (freshAny.parental_consent_token_hash) return; // active link exists, don't re-issue
          if (!freshAny.parent_email) return;

          const { issueConsentToken } = await import('../lib/parentalConsent.js');
          const rawToken = await issueConsentToken(updated.id);
          const { sendParentalConsentRequestEmail } = await import('../lib/email.js');
          await sendParentalConsentRequestEmail({
            to: freshAny.parent_email,
            minorDisplayName: freshAny.display_name || undefined,
            minorEmail: freshAny.email,
            consentToken: rawToken,
            expiresInDays: 14,
          });
        } catch (err) {
          console.error(
            '[auth] Failed to send parental consent request:',
            (err as any)?.message || err
          );
        }
      })();
    }

    // Fire-and-forget: notify ALL admins about new coach application
    if (finalRole === 'coach' && updateData.approval_status === 'PENDING') {
      const { getAllAdminEmails } = await import('../lib/adminEmails.js');
      const adminEmails = getAllAdminEmails();
      for (const adminEmail of adminEmails) {
        sendCoachApplicationAdminEmail({
          to: adminEmail,
          applicantName: updated.display_name || updated.email,
          applicantUsername: updated.username || undefined,
          applicantEmail: updated.email,
          applicantUserId: updated.id,
          organizationName:
            typeof (updateData as any)?.organization_name === 'string'
              ? String((updateData as any).organization_name)
              : undefined,
          approveUrl: buildCoachApplicationReviewUrl({
            coachId: updated.id,
            action: 'approve',
          }),
          rejectUrl: buildCoachApplicationReviewUrl({
            coachId: updated.id,
            action: 'reject',
          }),
          supportingDocumentUrl:
            typeof (updateData as any)?.supporting_document_url === 'string'
              ? String((updateData as any).supporting_document_url)
              : undefined,
        })
          .then(sent => {
            if (!sent) {
              captureException(new Error('Coach application admin notification reported unsent'), {
                context: 'coach_application_admin_notification_unsent',
                adminEmail,
                userId: updated.id,
              });
            }
          })
          .catch(err => {
            console.error(
              '[auth] Failed to send coach-application admin notification to',
              adminEmail,
              err?.message || err
            );
            captureException(err instanceof Error ? err : new Error(String(err)), {
              context: 'coach_application_admin_notification_failed',
              adminEmail,
              userId: updated.id,
            });
          });
      }
    }

    return res.json({
      message: 'Onboarding completed successfully',
      user: sanitizeUser(updated),
    });
  })
);

// Request a new email verification code (authenticated)
authRouter.post(
  '/verify/request',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const rawUser = await prisma.user.findUnique({ where: { id: req.user!.id } });
    const user = await ensureOAuthUserVerified(rawUser);
    if (!user) return res.status(404).json({ error: 'Not found' });
    if (user.email_verified) return res.json({ ok: true, already_verified: true });
    // Redis-backed verification rate limiting: 1 per 30s, 5 per hour
    const verifyLastKey = `verify:last:${user.id}`;
    const verifyHourKey = `verify:hour:${user.id}`;
    const lastSent = await rlGet(verifyLastKey);
    if (lastSent && Date.now() - parseInt(lastSent, 10) < 30_000) {
      return sendAuthError(
        res,
        429,
        'Please wait before requesting another code',
        'VERIFY_REQUEST_COOLDOWN'
      );
    }
    const hourCount = await rlIncr(verifyHourKey, 3600_000); // 1 hour TTL
    if (hourCount > 5) {
      return sendAuthError(res, 429, 'Too many requests', 'VERIFY_REQUEST_RATE_LIMITED');
    }
    const code = String(crypto.randomInt(100000, 999999));
    if (process.env.NODE_ENV === 'development')
      debugLog(
        `[verify-code] [verify/request] Code generated: ${code} for user ${user.id} (${user.email})`
      );
    const exp = new Date(Date.now() + 30 * 60 * 1000);
    // AUTH-5: Hash verification code before storage (same SHA-256 as refresh tokens)
    const codeHash = hashRefreshToken(code);
    await prisma.user.update({
      where: { id: user.id },
      data: { email_verification_code: codeHash, email_verification_expires: exp },
    });
    if (process.env.NODE_ENV === 'development')
      debugLog(
        `[verify-code] [verify/request] Code hash stored in DB (expires ${exp.toISOString()})`
      );
    try {
      if (process.env.NODE_ENV === 'development')
        debugLog(
          `[verify-code] [verify/request] Calling sendVerificationEmail → to: ${user.email}`
        );
      const sent = await sendVerificationEmail(
        user.email,
        code,
        user.display_name || user.email.split('@')[0]
      );
      const payload: any = { ok: true, verification_email_sent: sent };
      if (!sent) {
        console.error(
          '[verify-code] [verify/request] sendVerificationEmail returned false — email was NOT sent (check SendGridProvider logs above for the specific error)'
        );
        payload.verification_email_error = 'EMAIL_DELIVERY_FAILED';
      } else {
        debugLog(
          '[verify-code] [verify/request] sendVerificationEmail returned true — email accepted by SendGrid'
        );
      }
      if (shouldExposeDevCodes) payload.dev_verification_code = code;
      await rlSet(verifyLastKey, String(Date.now()), 30_000);
      return res.json(payload);
    } catch (e) {
      console.error('[verify-code] [verify/request] sendVerificationEmail threw:', e);
      (req as any).log?.warn?.({ err: e }, 'Email send failed');
      const payload: any = {
        ok: true,
        verification_email_sent: false,
        verification_email_error: 'EMAIL_DELIVERY_EXCEPTION',
      };
      if (shouldExposeDevCodes) payload.dev_verification_code = code;
      await rlSet(verifyLastKey, String(Date.now()), 30_000);
      return res.json(payload);
    }
  })
);

// Alias: /auth/verify/send
authRouter.post(
  '/verify/send',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    (authRouter as any).handle({ ...req, url: '/verify/request' }, res);
  })
);

// Verify code (authenticated)
authRouter.post(
  '/verify/confirm',
  verificationConfirmLimiter,
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const schema = z.object({ code: z.string().min(4).max(8) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return sendAuthError(res, 400, 'Invalid payload', 'INVALID_PAYLOAD');
    const { code } = parsed.data;
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) return res.status(404).json({ error: 'Not found' });
    if (user.email_verified) return res.json({ ok: true, already_verified: true });
    if (!user.email_verification_code || !user.email_verification_expires)
      return sendAuthError(res, 400, 'No verification in progress', 'VERIFY_NO_CODE');
    if (new Date() > user.email_verification_expires)
      return sendAuthError(res, 400, 'Code expired', 'VERIFY_CODE_EXPIRED');
    // AUTH-5: constant-time hash-to-hash comparison (mirrors /password/reset).
    // Both values are SHA-256 hashes; timingSafeEqual avoids a length/byte
    // timing side-channel on the verification code.
    const submittedVerificationHash = hashRefreshToken(String(code));
    const storedVerificationHash = String(user.email_verification_code);
    const verificationCodesMatch = (() => {
      if (submittedVerificationHash.length !== storedVerificationHash.length) return false;
      try {
        return crypto.timingSafeEqual(
          Buffer.from(submittedVerificationHash),
          Buffer.from(storedVerificationHash)
        );
      } catch {
        return false;
      }
    })();
    if (!verificationCodesMatch)
      return sendAuthError(res, 400, 'Invalid code', 'VERIFY_CODE_INVALID');
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        email_verified: true,
        email_verification_code: null,
        email_verification_expires: null,
      },
    });
    await invalidateMeCacheForUser(updated.id);
    return res.json({ ok: true, user: sanitizeUser(updated) });
  })
);

type SanitizedUser = Record<string, unknown> & {
  id: string;
  email: string;
  preferences: Record<string, unknown>;
};

function sanitizeUser(u: any): SanitizedUser {
  const source = (u || {}) as Record<string, any>;
  const normalizedDob = formatDobYmd(getCanonicalDob(source));
  const normalizedPreferences =
    source.preferences &&
    typeof source.preferences === 'object' &&
    !Array.isArray(source.preferences)
      ? { ...(source.preferences as Record<string, unknown>) }
      : {};
  const canonicalAuthState = getCanonicalAuthState(source);
  const canonicalBillingState = getCanonicalBillingState(source);
  normalizedPreferences.role = canonicalAuthState.role;
  normalizedPreferences.onboarding_completed = canonicalAuthState.onboarding_completed;
  if (canonicalAuthState.organization_id) {
    normalizedPreferences.organization_id = canonicalAuthState.organization_id;
  } else {
    delete normalizedPreferences.organization_id;
  }
  normalizedPreferences.proceeding_as_fan = canonicalAuthState.proceeding_as_fan;
  if (canonicalAuthState.coach_agreement_accepted_at) {
    normalizedPreferences.coach_agreement_accepted_at =
      canonicalAuthState.coach_agreement_accepted_at instanceof Date
        ? canonicalAuthState.coach_agreement_accepted_at.toISOString()
        : canonicalAuthState.coach_agreement_accepted_at;
  } else {
    delete normalizedPreferences.coach_agreement_accepted_at;
  }
  if (canonicalAuthState.coach_agreement_version !== null) {
    normalizedPreferences.coach_agreement_version = canonicalAuthState.coach_agreement_version;
  } else {
    delete normalizedPreferences.coach_agreement_version;
  }
  normalizedPreferences.plan = canonicalBillingState.plan;
  normalizedPreferences.pending_plan = canonicalBillingState.pending_plan;
  normalizedPreferences.payment_pending = canonicalBillingState.payment_pending;
  normalizedPreferences.payment_approved = canonicalBillingState.payment_approved;
  if (normalizedDob) {
    normalizedPreferences.dob = normalizedDob;
  }
  const aliasKeys = [
    'zip_code',
    'location',
    'affiliation',
    'header_image_url',
    'header_image_focus_y',
    'theme_color',
    'sports_interests',
    'primary_sport',
  ] as const;
  const topLevelAliases = Object.fromEntries(
    aliasKeys
      .filter(key => source[key] === undefined && normalizedPreferences[key] !== undefined)
      .map(key => [key, normalizedPreferences[key]])
  );
  const safeBase: Record<string, unknown> = {
    id: source.id,
    email: source.email,
    display_name: source.display_name ?? null,
    username: source.username ?? null,
    avatar_url: source.avatar_url ?? null,
    bio: source.bio ?? null,
    created_at: source.created_at,
    email_verified: source.email_verified,
    approval_status: source.approval_status ?? null,
    rejected_at: source.rejected_at ?? null,
    rejection_reason: source.rejection_reason ?? null,
    subscription_tier: source.subscription_tier,
    subscription_status: source.subscription_status,
    subscription_expires_at: source.subscription_expires_at ?? null,
    max_teams: typeof source.max_teams === 'number' ? source.max_teams : undefined,
    paid_by_owner: source.paid_by_owner ?? false,
    parental_consent_status: source.parental_consent_status ?? null,
    parental_consent_at: source.parental_consent_at ?? null,
    parental_consent_requested_at: source.parental_consent_requested_at ?? null,
  };
  const safeWithCounts = source._count ? { ...safeBase, _count: source._count } : safeBase;
  return {
    ...safeWithCounts,
    id: String(source.id || ''),
    email: String(source.email || ''),
    ...topLevelAliases,
    preferences: normalizedPreferences,
    role: canonicalAuthState.role,
    onboarding_completed: canonicalAuthState.onboarding_completed,
    organization_id: canonicalAuthState.organization_id,
    proceeding_as_fan: canonicalAuthState.proceeding_as_fan,
    coach_agreement_accepted_at: canonicalAuthState.coach_agreement_accepted_at,
    coach_agreement_version: canonicalAuthState.coach_agreement_version,
    plan: canonicalBillingState.plan,
    pending_plan: canonicalBillingState.pending_plan,
    payment_pending: canonicalBillingState.payment_pending,
    payment_approved: canonicalBillingState.payment_approved,
    dob: normalizedDob,
    date_of_birth: normalizedDob,
  };
}

// Test email endpoint (development only)
authRouter.post(
  '/test-email',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'Test endpoint not available in production' });
    }

    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }

    try {
      debugLog('[email-test] Testing email functionality...');
      const sent = await sendVerificationEmail(email, '123456', 'VarsityHub Tester');
      if (!sent) {
        return res.status(503).json({ success: false, error: 'SendGrid not configured' });
      }
      res.json({ success: true, message: 'Test email sent successfully' });
    } catch (error) {
      console.error('[email-test] Test email failed:', error);
      sendError(res, 500, 'Unable to send the test email.');
    }
  })
);

export default authRouter;
