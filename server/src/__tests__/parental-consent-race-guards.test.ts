import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const consentLib = readFileSync(join(process.cwd(), 'src', 'lib', 'parentalConsent.ts'), 'utf8');
const consentRoute = readFileSync(join(process.cwd(), 'src', 'routes', 'consent.ts'), 'utf8');
const adminRoute = readFileSync(join(process.cwd(), 'src', 'routes', 'admin.ts'), 'utf8');
const overnightTasks = readFileSync(
  join(process.cwd(), 'src', 'cron', 'overnightTasks.ts'),
  'utf8'
);

describe('parental consent race guards', () => {
  it('tracks explicit approved/denied/expired terminal states for consent links', () => {
    expect(consentLib).toContain("'already_approved'");
    expect(consentLib).toContain("'already_denied'");
    expect(consentLib).toContain("banReason === 'Parental consent not received within 14 days'");
  });

  it('guards approval and denial writes on pending state instead of unconditional updates', () => {
    expect(consentLib).toContain("where: { id: userId, parental_consent_status: 'pending' }");
    expect(consentLib).toContain('const transition = await prisma.user.updateMany({');
    expect(consentLib).toContain('const transition = await prisma.$transaction(async tx => {');
  });

  it('preserves resolved token hashes so reused links can render final-state pages', () => {
    expect(consentLib).not.toContain('parental_consent_token_hash: null');
    expect(adminRoute).toContain("if (status === 'pending') {");
    expect(adminRoute).toContain('updateData.parental_consent_token_hash = null;');
    expect(overnightTasks).not.toContain('parental_consent_token_hash: null');
  });

  it('renders explicit final-state pages and rate-limits resend requests', () => {
    expect(consentRoute).toContain('function consentResolutionPage(');
    expect(consentRoute).toContain('Consent Already Approved');
    expect(consentRoute).toContain('Consent Already Denied');
    expect(consentRoute).toContain('Consent Link Expired');
    expect(consentRoute).toContain('verificationLimiter as any');
  });

  it('requires a signed CSRF token for approve/deny actions', () => {
    expect(consentRoute).toContain('const CONSENT_CSRF_COOKIE =');
    expect(consentRoute).toContain('function verifyConsentCsrf(');
    expect(consentRoute).toContain('name="csrf_token"');
    expect(consentRoute).toContain('Consent Confirmation Expired');
    expect(consentRoute).toContain('Parental consent CSRF signing secret is not configured');
    expect(consentRoute).not.toContain('dev-consent-csrf-secret');
  });

  it('rejects cross-site consent submissions unless the origin matches the app origin', () => {
    expect(consentRoute).toContain('function requestHasTrustedOrigin(');
    expect(consentRoute).toContain("req.get('origin') || req.get('referer')");
    expect(consentRoute).toContain('new URL(candidate).origin === APP_BASE_ORIGIN');
  });
});
