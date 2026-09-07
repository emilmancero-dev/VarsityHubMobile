/**
 * Parental consent routes — the parent/guardian-facing surface.
 *
 * Auth model:
 *   - GET  /consent/:token             → public, no auth (parent has no account)
 *   - POST /consent/:token/approve     → public, token IS the auth
 *   - POST /consent/:token/deny        → public, token IS the auth
 *   - POST /me/consent/resend          → minor's own session, auth required
 *
 * The minor's own access to /me/consent/resend is intentionally allowed
 * through the parental-consent gate (see middleware/requireParentalConsent.ts)
 * so a minor whose parent didn't act can request a fresh email.
 */

import crypto from 'node:crypto';
import { Router } from 'express';
import escapeHtml from 'escape-html';
import { prisma } from '../lib/prisma.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { verificationLimiter } from '../middleware/rateLimiters.js';
import {
  lookupConsentByToken,
  recordConsentApproval,
  recordConsentDenial,
  issueConsentToken,
} from '../lib/parentalConsent.js';
import { sendParentalConsentRequestEmail } from '../lib/email.js';
import { invalidateMeCacheForUser } from '../lib/userCache.js';

export const consentRouter = Router();

const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://varsityhub.app').replace(/\/$/, '');
const APP_BASE_ORIGIN = (() => {
  try {
    return new URL(APP_BASE_URL).origin;
  } catch {
    return 'https://varsityhub.app';
  }
})();
const CONSENT_CSRF_COOKIE = 'vh_parental_consent_csrf';
const CONSENT_CSRF_TTL_MS = 15 * 60 * 1000;

function getConsentCsrfSecret(): string {
  const secret = process.env.PARENTAL_CONSENT_CSRF_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('Parental consent CSRF signing secret is not configured');
  }
  return secret;
}

function signConsentCsrf(
  rawToken: string,
  action: 'approve' | 'deny',
  nonce: string,
  expiresAt: number
) {
  return crypto
    .createHmac('sha256', getConsentCsrfSecret())
    .update(`${rawToken}:${action}:${nonce}:${expiresAt}`)
    .digest('hex');
}

function buildConsentCsrfField(
  rawToken: string,
  action: 'approve' | 'deny',
  nonce: string,
  expiresAt: number
) {
  const signature = signConsentCsrf(rawToken, action, nonce, expiresAt);
  return `${expiresAt}.${nonce}.${signature}`;
}

function parseCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const chunk of header.split(';')) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    const key = eq >= 0 ? trimmed.slice(0, eq) : trimmed;
    if (key !== name) continue;
    return eq >= 0 ? decodeURIComponent(trimmed.slice(eq + 1)) : '';
  }
  return null;
}

function setConsentCsrfCookie(res: any, rawToken: string, nonce: string) {
  const secure = APP_BASE_ORIGIN.startsWith('https://');
  const cookieValue = encodeURIComponent(`${rawToken}:${nonce}`);
  res.setHeader(
    'Set-Cookie',
    `${CONSENT_CSRF_COOKIE}=${cookieValue}; Max-Age=${Math.floor(CONSENT_CSRF_TTL_MS / 1000)}; Path=/consent/${encodeURIComponent(rawToken)}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
  );
}

function clearConsentCsrfCookie(res: any, rawToken: string) {
  const secure = APP_BASE_ORIGIN.startsWith('https://');
  res.append(
    'Set-Cookie',
    `${CONSENT_CSRF_COOKIE}=; Max-Age=0; Path=/consent/${encodeURIComponent(rawToken)}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
  );
}

function requestHasTrustedOrigin(req: any): boolean {
  const candidate = req.get('origin') || req.get('referer');
  if (!candidate) return true;
  try {
    return new URL(candidate).origin === APP_BASE_ORIGIN;
  } catch {
    return false;
  }
}

function verifyConsentCsrf(req: any, rawToken: string, action: 'approve' | 'deny'): boolean {
  if (!requestHasTrustedOrigin(req)) return false;

  const fieldValue = String(req.body?.csrf_token || '').trim();
  const cookieValue = parseCookie(req.headers.cookie, CONSENT_CSRF_COOKIE);
  if (!fieldValue || !cookieValue) return false;

  const [expiresRaw, nonce, providedSignature] = fieldValue.split('.');
  if (!expiresRaw || !nonce || !providedSignature) return false;

  const expiresAt = Number.parseInt(expiresRaw, 10);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  if (cookieValue !== `${rawToken}:${nonce}`) return false;

  const expectedSignature = signConsentCsrf(rawToken, action, nonce, expiresAt);
  const expectedBuffer = Buffer.from(expectedSignature, 'hex');
  const providedBuffer = Buffer.from(providedSignature, 'hex');
  if (expectedBuffer.length !== providedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

function landingPage(safeTitle: string, safeMessage: string, success: boolean): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:60px auto;padding:24px;text-align:center;color:#111827;">
<h2 style="color:${success ? '#16A34A' : '#DC2626'};margin-bottom:12px;">${safeTitle}</h2>
<p style="color:#374151;line-height:1.5;">${safeMessage}</p>
<p style="margin-top:24px;"><a href="${APP_BASE_URL}" style="color:#1B3A6B;text-decoration:none;">Return to VarsityHub</a></p>
</body></html>`;
}

function consentForm(
  rawToken: string,
  safeMinorName: string,
  approveCsrf: string,
  denyCsrf: string
): string {
  const safeToken = escapeHtml(rawToken);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Parental Consent — VarsityHub</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:40px auto;padding:24px;color:#111827;">
<h2 style="color:#1B3A6B;">Parental Consent Required</h2>
<p style="line-height:1.5;">Your child <strong>${safeMinorName}</strong> has signed up for VarsityHub. As a youth-sports platform serving users 13–17, we require a parent or guardian to confirm consent before their account becomes active.</p>
<p style="line-height:1.5;color:#374151;">By approving, you confirm you are the parent or guardian and consent to your child's use of VarsityHub under our <a href="${APP_BASE_URL}/privacy" style="color:#1B3A6B;">Privacy Policy</a>.</p>
<form method="POST" action="/consent/${safeToken}/approve" style="margin-top:24px;display:inline-block;">
  <input type="hidden" name="csrf_token" value="${escapeHtml(approveCsrf)}" />
  <button type="submit" style="background:#16A34A;color:#fff;border:none;padding:12px 28px;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;">Approve</button>
</form>
<form method="POST" action="/consent/${safeToken}/deny" style="margin-top:12px;display:inline-block;margin-left:8px;">
  <input type="hidden" name="csrf_token" value="${escapeHtml(denyCsrf)}" />
  <button type="submit" style="background:#fff;color:#DC2626;border:1px solid #DC2626;padding:12px 28px;border-radius:8px;font-size:16px;font-weight:600;cursor:pointer;">Deny</button>
</form>
<p style="margin-top:32px;font-size:12px;color:#6B7280;">Questions? Contact ${escapeHtml(process.env.CUSTOMER_SERVICE_EMAIL || 'support@varsityhub.app')}.</p>
</body></html>`;
}

function consentResolutionPage(
  reason: 'not_found' | 'expired' | 'already_approved' | 'already_denied'
): { status: number; html: string } {
  if (reason === 'not_found') {
    return {
      status: 404,
      html: landingPage(
        'Consent Link Unavailable',
        'This consent link is invalid. Please check the URL or request a new email.',
        false
      ),
    };
  }
  if (reason === 'expired') {
    return {
      status: 410,
      html: landingPage(
        'Consent Link Expired',
        'This consent link has expired. Please ask your child to request a new one from the app.',
        false
      ),
    };
  }
  if (reason === 'already_approved') {
    return {
      status: 200,
      html: landingPage(
        'Consent Already Approved',
        'This consent request was already approved. Your child can use VarsityHub.',
        true
      ),
    };
  }
  return {
    status: 200,
    html: landingPage(
      'Consent Already Denied',
      'This consent request was already denied. Contact support if you need to reverse it.',
      false
    ),
  };
}

function sendConsentCsrfExpired(res: any) {
  return res
    .status(403)
    .type('html')
    .send(
      landingPage(
        'Consent Confirmation Expired',
        'For security, please reopen the consent email link and submit the form again.',
        false
      )
    );
}

// GET /consent/:token — landing page for the parent
consentRouter.get(
  '/:token',
  asyncHandler(async (req, res) => {
    const token = String(req.params.token || '').trim();
    const lookup = await lookupConsentByToken(token);
    if (!lookup.ok) {
      const resolved = consentResolutionPage(lookup.reason);
      return res.status(resolved.status).type('html').send(resolved.html);
    }
    const minor = await prisma.user.findUnique({
      where: { id: lookup.userId },
      select: { display_name: true, username: true },
    });
    const minorName = minor?.display_name || minor?.username || 'your child';
    const nonce = crypto.randomBytes(16).toString('hex');
    const expiresAt = Date.now() + CONSENT_CSRF_TTL_MS;
    setConsentCsrfCookie(res, token, nonce);
    return res
      .type('html')
      .send(
        consentForm(
          token,
          escapeHtml(minorName),
          buildConsentCsrfField(token, 'approve', nonce, expiresAt),
          buildConsentCsrfField(token, 'deny', nonce, expiresAt)
        )
      );
  })
);

// POST /consent/:token/approve
consentRouter.post(
  '/:token/approve',
  asyncHandler(async (req, res) => {
    const token = String(req.params.token || '').trim();
    if (!verifyConsentCsrf(req, token, 'approve')) {
      return sendConsentCsrfExpired(res);
    }
    const lookup = await lookupConsentByToken(token);
    if (!lookup.ok) {
      const resolved = consentResolutionPage(lookup.reason);
      return res.status(resolved.status).type('html').send(resolved.html);
    }
    const result = await recordConsentApproval(lookup.userId);
    if (!result.ok) {
      const resolved = consentResolutionPage(result.reason);
      return res.status(resolved.status).type('html').send(resolved.html);
    }
    await invalidateMeCacheForUser(lookup.userId);
    clearConsentCsrfCookie(res, token);
    return res
      .type('html')
      .send(
        landingPage('Consent Approved', 'Thank you. Your child can now access the full app.', true)
      );
  })
);

// POST /consent/:token/deny
consentRouter.post(
  '/:token/deny',
  asyncHandler(async (req, res) => {
    const token = String(req.params.token || '').trim();
    if (!verifyConsentCsrf(req, token, 'deny')) {
      return sendConsentCsrfExpired(res);
    }
    const lookup = await lookupConsentByToken(token);
    if (!lookup.ok) {
      const resolved = consentResolutionPage(lookup.reason);
      return res.status(resolved.status).type('html').send(resolved.html);
    }
    const result = await recordConsentDenial(lookup.userId, 'Denied by parent or guardian');
    if (!result.ok) {
      const resolved = consentResolutionPage(result.reason);
      return res.status(resolved.status).type('html').send(resolved.html);
    }
    await invalidateMeCacheForUser(lookup.userId);
    clearConsentCsrfCookie(res, token);
    return res
      .type('html')
      .send(
        landingPage(
          'Consent Denied',
          "Your child's account has been disabled. To reverse this, contact support.",
          false
        )
      );
  })
);

// Standalone handler for POST /me/consent/resend — minor requests a fresh
// consent email be sent to their stored parent_email. Mounted in app.ts at a
// path that doesn't collide with the public /consent/:token landing routes.
// Enforces: must be in pending state, must have parent_email on file.
export const handleConsentResend = [
  requireAuth as any,
  verificationLimiter as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'UNAUTHORIZED' }); // error-envelope-exempt
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        email: true,
        display_name: true,
        parent_email: true,
        parental_consent_status: true,
      } as any,
    });
    const u = user as any;
    if (!u) return res.status(404).json({ error: 'NOT_FOUND' }); // error-envelope-exempt
    if (u.parental_consent_status !== 'pending') {
      return res.status(400).json({
        // error-envelope-exempt
        // error-envelope-exempt
        error: 'CONSENT_NOT_PENDING',
        message: 'Consent is not in a pending state — nothing to resend.',
      });
    }
    if (!u.parent_email) {
      return res.status(400).json({
        // error-envelope-exempt
        // error-envelope-exempt
        error: 'PARENT_EMAIL_MISSING',
        message: 'No parent email on file. Update onboarding to provide one.',
      });
    }
    const rawToken = await issueConsentToken(u.id);
    await sendParentalConsentRequestEmail({
      to: u.parent_email,
      minorDisplayName: u.display_name || undefined,
      minorEmail: u.email,
      consentToken: rawToken,
      expiresInDays: 14,
    });
    return res.json({ ok: true });
  }),
];
