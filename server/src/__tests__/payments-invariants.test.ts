/**
 * Payments & subscriptions — structural regression guards.
 *
 * Integration tests that actually hit Stripe/Apple are blocked by the
 * pre-existing Jest ESM issue. These static scans lock the invariants that
 * matter for production safety:
 *
 *   1. Stripe webhook signature verification is actually called (not skipped).
 *   2. Apple IAP receipt verification uses the shared secret.
 *   3. Paid-plan checkout cannot be bypassed by clients.
 *   4. Grace-period expiry downgrades users (no "Premium forever free" bug).
 *   5. Transactions are logged for audit + refund tracing.
 *   6. Booking-horizon is enforced server-side (no client-forged future dates).
 *   7. Rate limits on payment endpoints are wired.
 */

import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'src');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const payments = read('routes/payments.ts');
const paymentCheckoutHelpers = read('services/payments/checkoutHelpers.ts');
const googlePlayVerifier = read('services/payments/googlePlayVerifier.ts');
const requireOnboarded = read('middleware/requireOnboarded.ts');
const appleAuth = read('lib/appleAuth.ts');
const appleNotifDedup = read('lib/appleNotificationDedup.ts');
const billingLifecycle = read('lib/billingLifecycle.ts');
const indexBoot = read('index.ts');
const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
const paymentSuccessScreen = readFileSync(
  join(process.cwd(), '..', 'app', 'payment-success.tsx'),
  'utf8'
);
const manageSubscriptionScreen = readFileSync(
  join(process.cwd(), '..', 'app', 'settings', 'manage-subscription.tsx'),
  'utf8'
);

describe('payments & subscriptions — structural invariants', () => {
  // ──────────────────────────────────────────────────────────────────────
  // Stripe webhook signature verification
  // ──────────────────────────────────────────────────────────────────────

  describe('Stripe webhook auth', () => {
    it('server refuses to start in production without STRIPE_WEBHOOK_SECRET', () => {
      // Line should contain process.exit(1) for prod-missing-secret case.
      const block = payments.match(/STRIPE_WEBHOOK_SECRET[\s\S]{0,600}/)?.[0] || '';
      expect(block).toMatch(/process\.exit\(1\)/);
    });

    it('webhook handler calls stripe.webhooks.constructEvent (signature check)', () => {
      expect(payments).toMatch(/stripe\.webhooks\.constructEvent/);
    });

    it('webhook handler reads the stripe-signature header before verifying', () => {
      expect(payments).toMatch(/stripe-signature/);
    });

    it('webhook handler returns 400 on signature mismatch (never processes unverified events)', () => {
      const block = payments.match(/constructEvent[\s\S]{0,800}/)?.[0] || '';
      expect(block).toMatch(/catch|400/);
    });

    it('webhook events are deduped via the per-event distributed lock (no double-processing)', () => {
      const block = payments.match(/paymentsRouter\.post\(\s*'\/webhook'[\s\S]{0,3500}/)?.[0] || '';
      expect(block).toMatch(/withDistributedLock/);
      expect(block).toMatch(/namespace:\s*['"]payments:webhook-event['"]/);
      expect(block).toMatch(/localLocks:\s*webhookEventLocks/);
    });

    it('legacy webhook route is a tombstone, not a second processing implementation', () => {
      const block =
        payments.match(/paymentsRouter\.post\(\s*'\/webhook-legacy-disabled'[\s\S]{0,300}/)?.[0] ||
        '';
      expect(block).toMatch(/Legacy webhook route disabled/);
      expect(block).not.toMatch(/stripe\.webhooks\.constructEvent/);
      expect(block).not.toMatch(/finalizeFromSession/);
    });

    it('server requires STRIPE_SECRET_KEY in production (fatal throw)', () => {
      expect(payments).toMatch(/STRIPE_SECRET_KEY must be set in production/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Apple IAP receipt verification
  // ──────────────────────────────────────────────────────────────────────

  describe('Apple IAP receipt verification', () => {
    it('Apple IAP uses APPLE_IAP_SHARED_SECRET for receipt verification', () => {
      expect(payments).toMatch(/APPLE_IAP_SHARED_SECRET/);
    });

    it('deduplicates Apple App Store notifications (prevents double-grant on retry)', () => {
      expect(appleNotifDedup).toMatch(/export|recordAppleNotificationReceipt|dedup/i);
      expect(payments).toMatch(/recordAppleNotificationReceipt/);
    });

    it('startup warns loudly when APPLE_IAP_SHARED_SECRET is missing', () => {
      expect(payments).toMatch(/Apple IAP shared secret not set/);
    });

    it('verification code paths tag the transaction source (apple_iap / apple_iap_jws)', () => {
      expect(payments).toMatch(/source:\s*['"]apple_iap/);
    });

    it('Apple Sign-In credential validation lives in appleAuth.ts', () => {
      expect(appleAuth.length).toBeGreaterThan(100);
    });

    it('invalid Apple signatures are rejected before notification processing', () => {
      expect(payments).toContain('await verifyAppleNotificationJws(signedPayload)');
      expect(payments).toContain("code: 'INVALID_APPLE_SIGNATURE'");
    });

    it('inner Apple JWS payloads use the same trusted verifier', () => {
      expect(payments).toContain('await verifyAppleSignedJws(data.signedTransactionInfo)');
      expect(payments).toContain('await verifyAppleRenewalJws(data.signedRenewalInfo)');
      expect(payments).not.toContain('const verifyInnerJWS');
      const verifier = read('lib/appleSignedJws.ts');
      expect(verifier).toContain('new SignedDataVerifier([APPLE_ROOT_CA_G3]');
      expect(verifier).toContain('verifyAndDecodeTransaction');
      expect(verifier).toContain('verifyAndDecodeNotification');
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Approval-only coach gating + billing lifecycle safety
  // ──────────────────────────────────────────────────────────────────────

  describe('approval-only coach gate with billing lifecycle cleanup', () => {
    it('requireOnboarded no longer blocks approved coaches on payment state', () => {
      expect(requireOnboarded).not.toMatch(/PAYMENT_REQUIRED/);
      expect(requireOnboarded).not.toMatch(/requiresPayment/);
      expect(requireOnboarded).not.toMatch(/pending_plan|selectedPlan/);
    });

    it('Apple-specific grace-period expiry triggers lazy downgrade to rookie', () => {
      expect(requireOnboarded).toMatch(/grace_period_expires_at/);
      expect(requireOnboarded).toMatch(/subscription_status:\s*['"]expired['"]/);
      expect(requireOnboarded).toMatch(/plan:\s*['"]rookie['"]/);
    });

    it('downgrade clears apple-specific preferences keys (product_id, expires_date)', () => {
      const block = requireOnboarded.match(/grace_period_expires_at[\s\S]{0,1500}/)?.[0] || '';
      expect(block).toMatch(/apple_product_id/);
      expect(block).toMatch(/apple_expires_date/);
    });

    it('grace-period downgrade resets max_teams to the canonical Rookie allowance', () => {
      const block = requireOnboarded.match(/grace_period_expires_at[\s\S]{0,1500}/)?.[0] || '';
      expect(block).toMatch(/max_teams:\s*SERVER_ROOKIE_TEAM_LIMIT/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Transaction logging (audit + refund support)
  // ──────────────────────────────────────────────────────────────────────

  describe('transaction audit trail', () => {
    it('payment routes log transactions', () => {
      expect(payments).toMatch(/logTransaction/);
    });

    it('failed payments update transaction status rather than silently dropping', () => {
      expect(payments).toMatch(/updateTransactionStatus/);
    });

    it('PaymentIntent activation carries its purchase identity through the guarded reservation pipeline', () => {
      const helper =
        payments.match(/async function activateApprovedAdPaymentIntent[\s\S]{0,2500}?\n\}/)?.[0] ||
        '';
      const block =
        payments.match(/if \(event\.type === 'payment_intent\.succeeded'\)[\s\S]{0,5000}/)?.[0] ||
        '';
      expect(block).toMatch(/activateApprovedAdPaymentIntent\(tx, adId, piDates, pi.id\)/);
      expect(helper).toMatch(/!\['approved', 'active', 'archived'\]\.includes\(ad.status\)/);
      expect(helper).toMatch(/AD_NOT_APPROVED/);
      expect(helper).toMatch(/reserveAdSlots\(tx/);
      expect(helper).toMatch(/purchaseReference/);
    });

    it('Stripe processing fee is computed and stored per transaction', () => {
      expect(payments).toMatch(/calculateStripeFee/);
    });

    it('success-page fallback only finalizes for an authenticated session owner', () => {
      const block = payments.match(/paymentsRouter\.get\(\s*'\/success'[\s\S]{0,3500}/)?.[0] || '';
      expect(block).toMatch(/req\.user\?\.id/);
      expect(block).toMatch(/String\(sessionUserId\) !== String\(req\.user\.id\)/);
      expect(block).toMatch(/refusing to finalize session for non-owner/);
    });

    it('web checkout success URLs include the session id and payment type for app handoff', () => {
      const block =
        paymentCheckoutHelpers.match(/function getCheckoutReturnUrls[\s\S]{0,1200}/)?.[0] || '';
      expect(block).toMatch(
        /payment-success\?session_id=\{CHECKOUT_SESSION_ID\}&type=\$\{params\.type\}/
      );
      expect(block).toMatch(/payment-cancel/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Booking horizon — clients cannot forge far-future ad bookings
  // ──────────────────────────────────────────────────────────────────────

  describe('ad booking horizon', () => {
    it('payment routes enforce booking horizon via getDatesPastBookingHorizon', () => {
      expect(payments).toMatch(/getDatesPastBookingHorizon/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Rate limiting on payment endpoints
  // ──────────────────────────────────────────────────────────────────────

  describe('payment rate limiters', () => {
    it('payment router imports paymentLimiter middleware', () => {
      expect(payments).toMatch(/paymentLimiter/);
    });

    it('uses the idempotent recovery limiter for automatic Apple intent reconciliation', () => {
      const start = payments.indexOf("paymentsRouter.post(\n  '/apple/ad-intents/reconcile'");
      const end = payments.indexOf('paymentsRouter.post(', start + 1);
      const reconcileRoute = payments.slice(start, end);
      expect(reconcileRoute).toMatch(/adPurchaseRecoveryLimiter/);
      expect(reconcileRoute).not.toMatch(/paymentLimiter/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Payment success recovery
  // ──────────────────────────────────────────────────────────────────────

  describe('payment success recovery flow', () => {
    it('re-verifies after account recovery by including the active auth identity in the attempt key', () => {
      expect(paymentSuccessScreen).toMatch(
        /const authAttemptOwner = user\?\.id \? String\(user\.id\) : 'anonymous';/
      );
      expect(paymentSuccessScreen).toMatch(
        /const attemptKey = `\$\{paymentType \|\| 'unknown'\}:\$\{rawSessionId\}:\$\{verificationAttempt\}:\$\{authAttemptOwner\}`;/
      );
    });

    it('fails closed when the payment deep link is missing a supported type', () => {
      expect(paymentSuccessScreen).toMatch(
        /const paymentType = params\.type === 'ad' \|\| params\.type === 'subscription' \? params\.type : null;/
      );
      expect(paymentSuccessScreen).toMatch(/if \(!paymentType\) \{/);
      expect(paymentSuccessScreen).toMatch(/This payment link is invalid or incomplete/);
    });

    it('prompts account recovery for both ad and subscription confirmations when the current session cannot finalize the owner-bound payment', () => {
      expect(paymentSuccessScreen).toMatch(/if \(!user\) \{/);
      expect(paymentSuccessScreen).toMatch(
        /Sign in with the account that purchased this ad to confirm the booking and load its details\./
      );
      expect(paymentSuccessScreen).toMatch(
        /Sign in with the account that started this purchase to confirm your subscription and unlock premium features\./
      );
      expect(paymentSuccessScreen).toMatch(/if \(isAuthError\(err\)\) \{/);
      expect(paymentSuccessScreen).toMatch(
        /We could not verify this ad payment on your current session\./
      );
      expect(paymentSuccessScreen).toMatch(
        /We could not verify this subscription on your current session\./
      );
      expect(paymentSuccessScreen).toMatch(/router\.replace\('\/sign-in'\)/);
    });
  });

  describe('payment sheet subscription confirmation flow', () => {
    it('exposes a dedicated finalize-subscription endpoint for Stripe subscription ids', () => {
      const block =
        payments.match(/paymentsRouter\.post\(\s*'\/finalize-subscription'[\s\S]{0,2200}/)?.[0] ||
        '';
      expect(block).toMatch(/subscription_id:\s*z\.string\(\)\.min\(1\)/);
      expect(block).toMatch(/subscription_id\.startsWith\('sub_'\)/);
      expect(block).toMatch(/stripe\.subscriptions\.retrieve\(subscription_id\)/);
      expect(block).toMatch(
        /syncStripeSubscriptionState\(subscription,\s*'subscription\.finalize'\)/
      );
    });

    it('manage-subscription confirms payment sheet subscriptions with finalizeSubscription, not finalizeSession', () => {
      expect(manageSubscriptionScreen).toMatch(
        /Subscriptions\.finalizeSubscription\(subscriptionId\)/
      );
      expect(manageSubscriptionScreen).not.toMatch(
        /Subscriptions\.finalizeSession\(subscriptionId\)/
      );
    });

    it('customer.subscription.updated uses the shared subscription sync helper', () => {
      const block =
        payments.match(
          /if \(event\.type === 'customer\.subscription\.updated'\) \{[\s\S]{0,1500}/
        )?.[0] || '';
      expect(block).toMatch(
        /syncStripeSubscriptionState\(subscription,\s*'subscription\.updated'\)/
      );
      expect(block).not.toMatch(/updateTransactionStatus\(subscription\.id,\s*'COMPLETED'/);
    });
  });

  describe('Google Play purchase identity', () => {
    it('hashes purchase tokens for order_id instead of truncating them', () => {
      const block =
        googlePlayVerifier.match(/function getGooglePurchaseOrderId[\s\S]{0,400}/)?.[0] || '';
      expect(block).toMatch(/crypto\.createHash\('sha256'\)/);
      expect(block).toMatch(/google_purchase:/);
    });

    it('google purchase dedupe accepts hashed ids and legacy truncated ids during migration', () => {
      const block =
        payments.match(
          /const orderId = getGooglePurchaseOrderId\(purchase_token\);[\s\S]{0,500}/
        )?.[0] || '';
      expect(block).toMatch(/const legacyOrderId = String\(purchase_token\)\.substring\(0, 40\);/);
      expect(block).toMatch(/order_id:\s*\{\s*in:\s*\[orderId,\s*legacyOrderId\]\s*\}/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Security audit 2026-06 hardening (#4 P2, #12 P3)
  // ──────────────────────────────────────────────────────────────────────

  describe('Google Play unverified fallback is a production no-op (audit #4)', () => {
    it('payments.ts derives the flag through resolveGooglePlayUnverifiedFallback, not a raw env parse', () => {
      expect(payments).toMatch(
        /const GOOGLE_PLAY_ALLOW_UNVERIFIED_FALLBACK = resolveGooglePlayUnverifiedFallback\(process\.env\);/
      );
      expect(payments).not.toMatch(/process\.env\.GOOGLE_PLAY_ALLOW_UNVERIFIED_FALLBACK === '1'/);
    });

    it('the policy helper forces the flag off in production and warns', () => {
      const policy = read('lib/googlePlayVerificationPolicy.ts');
      const prodBlock = policy.match(/NODE_ENV === 'production'[\s\S]{0,400}/)?.[0] || '';
      expect(prodBlock).toMatch(
        /\[payments\] GOOGLE_PLAY_ALLOW_UNVERIFIED_FALLBACK ignored in production/
      );
      expect(prodBlock).toMatch(/return false;/);
    });
  });

  describe('Apple DID_RENEW with unmapped product never changes the plan (audit #12)', () => {
    it('the renewal branch no longer defaults an unmapped product to veteran', () => {
      expect(payments).not.toMatch(/APPLE_PRODUCT_TO_PLAN\[productId\]\s*\|\|\s*getCanonicalPlan/);
    });

    it('an unmapped product logs, captures to Sentry, and returns before any user update', () => {
      // Anchor on the S2S renewal branch's audit comment — payments.ts has an earlier
      // APPLE_PRODUCT_TO_PLAN[productId] lookup in the client verify route (400s there).
      const block = payments.match(/Security audit 2026-06 #12[\s\S]{0,1600}/)?.[0] || '';
      expect(block).toMatch(/if \(!plan\) \{/);
      expect(block).toMatch(
        /\[payments\] Apple \$\{notificationType\} notification for unmapped productId/
      );
      expect(block).toMatch(
        /captureException\(new Error\(`apple-s2s: unmapped productId on \$\{notificationType\}`\)/
      );
      // The early return must come BEFORE the prisma user update in this branch.
      const guardEnd = block.indexOf('return res.sendStatus(200);');
      const userUpdate = block.indexOf('prisma.user.update');
      expect(guardEnd).toBeGreaterThan(-1);
      expect(userUpdate === -1 || guardEnd < userUpdate).toBe(true);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Plan canonicalization (no client-set plan escalation)
  // ──────────────────────────────────────────────────────────────────────

  describe('plan / billing state canonicalization', () => {
    it('payment routes use canonical billing helpers (not ad-hoc prefs writes)', () => {
      expect(payments).toMatch(/buildBillingStateColumns|mergeBillingStateIntoPreferences/);
    });

    it('plan changes write both the column AND the preferences (lockstep)', () => {
      // Same invariant as the auth-state split-brain we fixed earlier.
      expect(payments).toMatch(/buildBillingStateColumns/);
      expect(payments).toMatch(/mergeBillingStateIntoPreferences/);
    });

    it('billingLifecycle.ts defines transition helpers for subscription events', () => {
      expect(billingLifecycle.length).toBeGreaterThan(100);
    });

    it('subscription summary reports the canonical Rookie free-team allowance', () => {
      const block =
        payments.match(/paymentsRouter\.get\(\s*'\/subscription\/summary'[\s\S]{0,2200}/)?.[0] ||
        '';
      expect(block).toMatch(/const free_teams = SERVER_ROOKIE_TEAM_LIMIT;/);
    });

    it('refund and cancellation downgrades reset max_teams to the canonical Rookie allowance', () => {
      expect(payments).toMatch(/max_teams:\s*SERVER_ROOKIE_TEAM_LIMIT/);
    });

    it('subscription status writes use canonical Stripe spelling', () => {
      expect(payments).not.toMatch(/subscription_status:\s*'cancelled'/);
    });

    it('the persisted User.max_teams default matches the Rookie plan allowance', () => {
      expect(schema).toMatch(/max_teams\s+Int\s+@default\(4\)/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Tax calculation wired in (sales tax compliance)
  // ──────────────────────────────────────────────────────────────────────

  describe('sales tax calculation', () => {
    it('payment routes call calculateSalesTax somewhere in the purchase path', () => {
      expect(payments).toMatch(/calculateSalesTax/);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // Startup guards
  // ──────────────────────────────────────────────────────────────────────

  describe('boot-time visibility of payment config issues', () => {
    it('index.ts runs the Cloudinary probe — separate from payments but same pattern', () => {
      expect(indexBoot).toMatch(/Cloudinary auth probe/);
    });

    it('payments.ts loud-logs missing STRIPE_WEBHOOK_SECRET in dev (warn, not exit)', () => {
      const devBlock = payments.match(/STRIPE_WEBHOOK_SECRET[\s\S]{0,400}/)?.[0] || '';
      expect(devBlock).toMatch(/WARNING|warn/i);
    });
  });
});
