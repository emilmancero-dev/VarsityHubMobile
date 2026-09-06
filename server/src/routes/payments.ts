import {
  AdIntentError,
  createAdPurchaseIntent,
  listAdPurchaseIntents,
  recordAdPurchaseReceipt,
  reconcileReadyAdPurchases,
  reviseAdPurchaseIntentDates,
} from '../lib/adPurchaseIntents.js';
import {
  verifyAppleSignedJws,
  verifyAppleNotificationJws,
  verifyAppleRenewalJws,
} from '../lib/appleSignedJws.js';
import { releaseAdPurchaseHolds } from '../lib/adInventory.js';
import { appleAdTransactionSchema } from '../lib/appleAdTransaction.js';
import { Prisma } from '@prisma/client';
import crypto from 'crypto';
import expressPkg, { Router, type Response } from 'express';
import jwt from 'jsonwebtoken';
import StripeCtor, { type Stripe } from 'stripe';
import { z } from 'zod';
import { recordAppleNotificationReceipt } from '../lib/appleNotificationDedup.js';
import { debugLog } from '../lib/debugLog.js';
import { withDistributedLock } from '../lib/distributedLock.js';
import { sendBillingNoticeEmail } from '../lib/email.js';
import { resolveGooglePlayUnverifiedFallback } from '../lib/googlePlayVerificationPolicy.js';
import { redactIdentifier } from '../lib/logRedaction.js';
import { ensureOAuthUserVerified } from '../lib/oauthVerification.js';
import { getOrganizationMembership } from '../lib/organizationAuthorization.js';
import {
  formatUsd,
  getCheckoutReturnUrls,
  getPastAdDates,
} from '../services/payments/checkoutHelpers.js';
import {
  getGooglePurchaseOrderId,
  GOOGLE_ALLOWED_PACKAGES,
  GOOGLE_PRODUCT_TO_PLAN,
  hasGooglePlayVerifierConfig,
  verifyGooglePurchaseWithPlayApi,
} from '../services/payments/googlePlayVerifier.js';
import {
  AD_PRODUCT_CENTS,
  APPLE_PRODUCT_TO_PLAN,
  ensureApplePendingTransactionLog,
  finalizeAppleAdPurchase,
  finalizeAppleSubscriptionPurchase,
  getFullAdSlotDates,
  getVeteranBillingSnapshot,
  getVeteranTotalTeamAllowance,
  isUniqueConstraintError,
  normalizeAppleTransactionIds,
  releaseAdInventoryAfterSlotFullRefund,
  releaseAdInventoryAfterSlotFullRefundWithRetry,
  reserveAdSlots,
  resolveOwnerBillingOrgId,
  resolveVeteranQuantityUpdate,
  runFinalizeFromSession,
  sendAdPaymentEmail,
  syncStripeSubscriptionState,
  encodeAdDates,
  decodeAdDates,
} from '../lib/paymentInternals.js';
import { shouldApplyStripeSubscriptionEvent } from '../lib/stripeSubscriptionGuard.js';
import {
  SERVER_LEGEND_PRICE_CENTS,
  SERVER_LEGEND_PRICE_LABEL,
  SERVER_ROOKIE_PROGRAM_LIMIT,
  SERVER_ROOKIE_TEAM_LIMIT,
  SERVER_VETERAN_MIN_TOTAL_TEAMS,
  SERVER_VETERAN_PRICE_CENTS,
  SERVER_VETERAN_PRICE_LABEL,
} from '../lib/planDefinitions.js';
import { getAllPlanDefinitions } from '../lib/planLimits.js';
import { prisma } from '../lib/prisma.js';
import { sendError } from '../lib/http/sendError.js';
import { previewPromo, redeemPromo, reversePromoRedemption } from '../lib/promos.js';
import { addBreadcrumb, captureException } from '../lib/sentry.js';
import { runWithBreaker } from '../lib/circuitBreaker.js';
import { calculateSalesTax } from '../lib/taxCalculator.js';
import {
  calculateStripeFee,
  logTransaction,
  updateTransactionStatus,
} from '../lib/transactionLogger.js';
import { getCanonicalUserRole } from '../lib/userAuthState.js';
import {
  buildBillingStateColumns,
  getCanonicalPlan,
  getSelectedPlan,
  mergeBillingStateIntoPreferences,
} from '../lib/userBillingState.js';
import { invalidateMeCacheForUser, invalidateMeCacheForUsers } from '../lib/userCache.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { paymentLimiter } from '../middleware/rateLimiters.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireVerified } from '../middleware/requireVerified.js';
import { adDateSchema, calculateAdPriceCents } from '../utils/adPricing.js';
import { getDatesPastBookingHorizon } from '../utils/bookingHorizon.js';

if (process.env.NODE_ENV === 'production' && !process.env.STRIPE_SECRET_KEY) {
  throw new Error(
    'FATAL: STRIPE_SECRET_KEY must be set in production. Server cannot start without payment processing.'
  );
}
if (!process.env.STRIPE_SECRET_KEY) {
  console.error('[payments] STRIPE_SECRET_KEY is not set — payment features will fail');
}
const stripe = new StripeCtor(process.env.STRIPE_SECRET_KEY || 'sk_test_not_configured', {
  apiVersion: '2024-06-20',
  // Bound hangs (SDK default is 80s) and retry transient network errors. All
  // mutating calls here pass idempotencyKeys, so retries are safe.
  timeout: 20000,
  maxNetworkRetries: 2,
});
const webhookEventLocks = new Map<string, Promise<any>>();
const isJestRuntime = process.env.JEST_WORKER_ID != null;
const hasStripeWebhookSecret = Boolean(process.env.STRIPE_WEBHOOK_SECRET);
const hasAppleBundleId = Boolean(process.env.APPLE_BUNDLE_ID);
const hasAppleIapSharedSecret = Boolean(process.env.APPLE_IAP_SHARED_SECRET);

// Startup warnings for critical payment config
if (process.env.NODE_ENV === 'production') {
  if (!hasStripeWebhookSecret) {
    console.error(
      '[payments] FATAL: STRIPE_WEBHOOK_SECRET is not set in production — webhooks will fail silently. Server cannot start.'
    );
    process.exit(1);
  }
  if (!hasAppleBundleId) {
    console.error(
      '[payments] FATAL: APPLE_BUNDLE_ID is not set in production — Apple StoreKit signed transaction verification will fail. Server cannot start.'
    );
    process.exit(1);
  }
  if (!hasAppleIapSharedSecret) {
    console.warn(
      '[payments] Apple IAP shared secret not set — legacy receipt fallback is disabled, but signed StoreKit transactions still work'
    );
  }
} else {
  if (!hasStripeWebhookSecret) {
    console.warn(
      '[payments] WARNING: STRIPE_WEBHOOK_SECRET is not set in development — Stripe webhooks will fail silently'
    );
  }
  if (!hasAppleBundleId) {
    console.warn(
      '[payments] WARNING: APPLE_BUNDLE_ID is not set in development — signed StoreKit transaction verification may fail'
    );
  }
  if (!hasAppleIapSharedSecret) {
    console.warn(
      '[payments] WARNING: APPLE_IAP_SHARED_SECRET is not set in development — legacy Apple receipt fallback is disabled'
    );
  }
}

// Admin notification email — first entry from ADMIN_EMAILS env var
const ADMIN_NOTIFY_EMAIL =
  (process.env.ADMIN_NOTIFICATION_EMAILS || process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)[0] || '';

export const paymentsRouter = Router();

const OWNER_MANAGED_SUBSCRIPTION_ERROR =
  'Your league owner manages this subscription. Contact them if you need billing changes.';

async function activateApprovedAdPaymentIntent(
  tx: Prisma.TransactionClient,
  adId: string,
  dates: string[],
  purchaseReference: string
) {
  const ad = await tx.ad.findUnique({ where: { id: adId } });
  if (!ad || !['approved', 'active', 'archived'].includes(ad.status)) {
    throw new Error(`AD_NOT_APPROVED: Ad ${adId} cannot activate`);
  }
  await reserveAdSlots(tx, {
    adId,
    isoDates: dates,
    paymentStatus: 'paid',
    status: 'active',
    purchaseReference,
    stripePaymentIntentId: purchaseReference,
  });
}

async function enforceVerifiedForSubscriptionFlow(
  req: AuthedRequest,
  res: Response,
  plan?: string
) {
  if (!plan?.trim()) return true;
  if (!req.user?.id) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  const u = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: {
      id: true,
      email_verified: true,
      google_id: true,
      apple_id: true,
      paid_by_owner: true,
    },
  });
  const verifiedUser = await ensureOAuthUserVerified(u);
  if (!verifiedUser?.email_verified) {
    res.status(403).json({ error: 'Email verification required' });
    return false;
  }
  if (verifiedUser?.paid_by_owner === true) {
    res.status(403).json({ error: OWNER_MANAGED_SUBSCRIPTION_ERROR });
    return false;
  }
  return true;
}

async function enforceVerifiedForAdPaymentFlow(req: AuthedRequest, res: Response, adId?: string) {
  if (!adId?.trim()) return true;
  if (!req.user?.id) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  const u = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { id: true, email_verified: true, google_id: true, apple_id: true },
  });
  const verifiedUser = await ensureOAuthUserVerified(u);
  if (!verifiedUser?.email_verified) {
    res.status(403).json({ error: 'Email verification required' });
    return false;
  }
  return true;
}

type WebhookRouteResponse = {
  status: number;
  body: Record<string, any>;
};

async function processStripeWebhookEvent(event: Stripe.Event): Promise<WebhookRouteResponse> {
  // Event-level deduplication: retain the row and mark it processed only after success.
  // Failed events remain retryable instead of deleting the dedup row and risking partial-work replays.
  try {
    const existing = await prisma.processedStripeEvent.findUnique({
      where: { event_id: event.id },
      select: { processed: true },
    });
    if (existing?.processed) {
      debugLog('[webhook] Duplicate event skipped', { event_id: event.id, event_type: event.type });
      return { status: 200, body: { received: true, deduplicated: true } };
    }
    if (!existing) {
      await prisma.processedStripeEvent.create({
        data: {
          event_id: event.id,
          event_type: event.type,
          processed: false,
          processing_started_at: new Date(),
        },
      });
    } else {
      await prisma.processedStripeEvent.update({
        where: { event_id: event.id },
        data: {
          event_type: event.type,
          processing_started_at: new Date(),
          last_error: null,
        },
      });
    }
  } catch (dedupErr: any) {
    console.error(
      '[webhook] Failed to record event state for dedup, rejecting for retry:',
      dedupErr?.message || dedupErr
    );
    return { status: 500, body: { error: 'Dedup recording failed, will retry' } };
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      if (!session?.id) {
        console.error('[webhook] Malformed checkout.session.completed — missing session.id', {
          eventId: event.id,
        });
        await markStripeEventFailed(event.id, new Error('Invalid session object'));
        return { status: 400, body: { error: 'Invalid session object' } };
      }
      try {
        await finalizeFromSession(session);
      } catch (e) {
        await markStripeEventFailed(event.id, e);
        console.error(
          '[webhook] CRITICAL: Error finalizing session — returning 500 for Stripe retry:',
          (e as any)?.message || e
        );
        captureException(e as Error, {
          context: 'stripe_webhook_finalize_failed',
          sessionId: session.id,
        });
        return { status: 500, body: { error: 'Finalization failed' } };
      }
    }

    // Send billing notification emails for subscription events
    if (event.type === 'invoice.payment_succeeded') {
      const invoice = event.data.object as Stripe.Invoice;
      // Log renewal transaction
      if (invoice.customer && invoice.subscription) {
        const renewalUser = await prisma.user.findFirst({
          where: { stripe_customer_id: String(invoice.customer) },
          select: { id: true },
        });
        if (renewalUser) {
          // v1.0.2 audit fix: await so renewal audit trail is never silently dropped.
          try {
            await logTransaction({
              transactionType: 'SUBSCRIPTION_RENEWAL',
              status: 'COMPLETED',
              userId: renewalUser.id,
              totalCents: invoice.amount_paid || 0,
              stripeSessionId: String(invoice.id),
              stripeSubscriptionId: String(invoice.subscription),
              metadata: { event: 'invoice.payment_succeeded', period_end: invoice.period_end },
            });
          } catch (err) {
            captureException(err as Error, { context: 'renewal_transaction_log' });
          }
        }
      }
    }

    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object as Stripe.Invoice;
      // Mark user's subscription as past_due so the app can prompt for payment update
      if (invoice.customer && invoice.subscription) {
        const failedUser = await prisma.user.findFirst({
          where: { stripe_customer_id: String(invoice.customer) },
        });
        if (
          failedUser &&
          shouldApplyStripeSubscriptionEvent(
            failedUser.preferences as any,
            typeof invoice.subscription === 'string' ? invoice.subscription : null
          )
        ) {
          // cache-invalidation-exempt: invalidateMeCacheForUser called below
          await prisma.user.update({
            where: { id: failedUser.id },
            data: { subscription_status: 'past_due' },
          });
          await invalidateMeCacheForUser(failedUser.id);
          console.warn('[webhook] invoice.payment_failed — marked user as past_due', {
            userId: failedUser.id,
            invoiceId: invoice.id,
          });
        } else if (failedUser) {
          console.warn(
            '[webhook] invoice.payment_failed — ignored: stale/non-active subscription for user',
            { userId: failedUser.id, invoiceId: invoice.id, subscription: invoice.subscription }
          );
        }
      }
      if (invoice.customer_email) {
        await sendBillingNoticeEmail({
          to: invoice.customer_email,
          type: 'payment_failed',
          planName: invoice.lines.data[0]?.description || 'VarsityHub Subscription',
        }).catch(err => console.warn('[billing-email] payment_failed failed:', err));
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object as Stripe.Subscription;
      const customerId = typeof subscription.customer === 'string' ? subscription.customer : null;
      if (!customerId) {
        console.error('[webhook] customer.subscription.deleted: subscription.customer is null');
        return { status: 400, body: { error: 'Missing customer ID' } };
      }
      const customer = await stripe.customers.retrieve(customerId).catch(() => null);
      const customerEmail = customer && !customer.deleted ? customer.email : null;
      void customerEmail;

      // Downgrade user to rookie plan now that subscription period has ended
      const canceledUser = await prisma.user.findFirst({
        where: { stripe_customer_id: customerId },
      });
      // Only the user's CURRENTLY-ACTIVE Stripe subscription may downgrade them.
      // A deleted old sub (post-upgrade) or a migrated Apple/Google user must not
      // lose their live entitlement. See stripeSubscriptionGuard.ts.
      if (
        canceledUser &&
        !shouldApplyStripeSubscriptionEvent(canceledUser.preferences as any, subscription.id)
      ) {
        console.warn(
          '[webhook] customer.subscription.deleted — ignored: stale/non-active subscription',
          { userId: canceledUser.id, subscriptionId: subscription.id }
        );
        return { status: 200, body: { received: true, ignored: 'stale_subscription' } };
      }
      if (canceledUser) {
        const prefs =
          canceledUser.preferences && typeof canceledUser.preferences === 'object'
            ? (canceledUser.preferences as any)
            : {};
        const previousPlan = getCanonicalPlan(canceledUser as any);

        // PAY-9: Only downgrade users who were actually on a paid plan.
        // Ignoring this event for rookie users prevents spurious DB writes when
        // Stripe deletes an incomplete/expired subscription they never paid for.
        if (previousPlan !== 'veteran' && previousPlan !== 'legend') {
          debugLog(
            '[webhook] customer.subscription.deleted: user was not on paid plan, skipping downgrade',
            {
              user_id: canceledUser.id,
              previous_plan: previousPlan,
              subscription_id: subscription.id,
            }
          );
        } else {
          delete prefs.subscription_id;
          delete prefs.subscription_period_end;
          const nextPrefs = mergeBillingStateIntoPreferences(prefs, {
            plan: 'rookie',
            pending_plan: null,
            payment_pending: false,
            payment_approved: false,
          });
          // ATOMIC: downgrade + cancellation log must succeed or fail together
          await prisma.$transaction([
            // cache-invalidation-exempt: invalidateMeCacheForUser called after this transaction resolves
            prisma.user.update({
              where: { id: canceledUser.id },
              data: {
                preferences: nextPrefs,
                ...buildBillingStateColumns({
                  plan: 'rookie',
                  pending_plan: null,
                  payment_pending: false,
                  payment_approved: false,
                }),
                subscription_tier: 'free',
                subscription_status: 'canceled',
              },
            }),
            prisma.transactionLog.create({
              data: {
                transaction_type: 'SUBSCRIPTION_CANCEL',
                status: 'COMPLETED',
                stripe_subscription_id: subscription.id,
                user_id: canceledUser.id,
                metadata: { reason: 'subscription_deleted', previous_plan: previousPlan },
                subtotal_cents: 0,
                tax_cents: 0,
                stripe_fee_cents: 0,
                discount_cents: 0,
                total_cents: 0,
                net_cents: 0,
                promo_discount_cents: 0,
                currency: 'usd',
              },
            }),
          ]);
          await invalidateMeCacheForUser(canceledUser.id);
        } // end else (was on paid plan)
      }
    }

    if (event.type === 'customer.subscription.updated') {
      const subscription = event.data.object as Stripe.Subscription;
      const subCustomerId =
        typeof subscription.customer === 'string' ? subscription.customer : null;
      if (!subCustomerId) {
        console.error('[webhook] customer.subscription.updated: subscription.customer is null');
        return { status: 400, body: { error: 'Missing customer ID' } };
      }
      const customer = await stripe.customers.retrieve(subCustomerId).catch(() => null);
      const customerEmail = customer && !customer.deleted ? customer.email : null;
      const syncResult = await syncStripeSubscriptionState(subscription, 'subscription.updated');
      if (syncResult.userId) {
        debugLog(
          `[webhook] subscription.updated: user ${syncResult.userId} -> status=${syncResult.normalizedStatus} plan=${syncResult.plan || 'unchanged'} tx=${syncResult.transactionStatus}`
        );
      }

      void customerEmail;
    }

    // Handle expired checkout sessions — mark PENDING transactions as FAILED and release holds
    // v1.0.2 pass 8: handle Stripe-side refunds (admin or dispute) so the user's access
    // is correctly downgraded. Previously a refund issued via Stripe dashboard would not
    // affect the user's plan or ad — they kept access without paying.
    if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created') {
      const charge = event.data.object as Stripe.Charge;
      const piId =
        typeof charge.payment_intent === 'string'
          ? charge.payment_intent
          : charge.payment_intent?.id;
      const refundAmount = charge.amount_refunded || charge.amount;
      try {
        // Find the original transaction by payment intent
        const tx = piId
          ? await prisma.transactionLog.findFirst({
              where: {
                OR: [
                  { stripe_payment_intent_id: piId },
                  // Historical PaymentSheet writers stored the verified PI in the session field.
                  {
                    transaction_type: 'AD_PURCHASE',
                    stripe_payment_intent_id: null,
                    stripe_session_id: piId,
                  },
                ],
              },
              orderBy: { created_at: 'desc' },
            })
          : null;
        if (!tx) {
          console.error('[webhook] charge.refunded without matching transactionLog', {
            charge_id: charge.id,
            pi: piId,
          });
          captureException(new Error('charge.refunded: no matching transaction'), {
            context: 'refund_no_tx',
            chargeId: charge.id,
          });
          throw new Error('Refund transaction is not available yet');
        } else {
          const promoRollbackRefs = Array.from(
            new Set(
              [tx.stripe_payment_intent_id, tx.stripe_session_id]
                .map(value => String(value || '').trim())
                .filter(Boolean)
            )
          );

          const { promoRollback, entitlementRevoked } = await prisma.$transaction(
            async db => {
              const fresh = await db.transactionLog.findUniqueOrThrow({ where: { id: tx.id } });
              if ((fresh.metadata as any)?.refund_event_id === event.id)
                return {
                  promoRollback: { reversed: false, count: 0, orderReferences: [] as string[] },
                  entitlementRevoked: false,
                };
              let entitlementRevoked = false;
              const promoRollbackResult = await reversePromoRedemption(
                { orderReferences: promoRollbackRefs },
                db
              );

              await db.transactionLog.update({
                where: { id: tx.id },
                data: {
                  status: 'REFUNDED' as any,
                  ...(piId && !fresh.stripe_payment_intent_id
                    ? { stripe_payment_intent_id: piId }
                    : {}),
                  metadata: {
                    ...((tx.metadata as any) || {}),
                    refund_source:
                      event.type === 'charge.dispute.created' ? 'dispute' : 'stripe_dashboard',
                    refunded_amount_cents: refundAmount,
                    stripe_charge_id: charge.id,
                    refunded_at: new Date().toISOString(),
                    refund_event_id: event.id,
                    promo_redemption_reversed: promoRollbackResult.reversed,
                    promo_reversal_count: promoRollbackResult.count,
                    promo_reversal_refs: promoRollbackResult.orderReferences,
                  },
                },
              });

              // Cascade based on transaction type:
              // - SUBSCRIPTION_PURCHASE/RENEWAL → downgrade user to rookie immediately
              // - AD_PURCHASE → mark ad refunded + release reservations
              if (
                tx.user_id &&
                (tx.transaction_type === 'SUBSCRIPTION_PURCHASE' ||
                  tx.transaction_type === 'SUBSCRIPTION_RENEWAL')
              ) {
                const u = await db.user.findUnique({
                  where: { id: tx.user_id },
                  select: { preferences: true },
                });
                const prefs = (u?.preferences as any) || {};
                const refundSubscriptionId =
                  tx.stripe_subscription_id ||
                  (tx.metadata as any)?.subscription_id ||
                  (tx.metadata as any)?.stripe_subscription_id;
                if (
                  typeof refundSubscriptionId === 'string' &&
                  prefs.subscription_id === refundSubscriptionId &&
                  shouldApplyStripeSubscriptionEvent(prefs, refundSubscriptionId)
                ) {
                  entitlementRevoked = true;
                  const nextPrefs = mergeBillingStateIntoPreferences(
                    { ...prefs, subscription_id: null, subscription_period_end: null },
                    {
                      plan: 'rookie',
                      pending_plan: null,
                      payment_pending: false,
                      payment_approved: false,
                    }
                  );
                  // cache-invalidation-exempt: invalidateMeCacheForUser called below
                  await db.user.update({
                    where: { id: tx.user_id },
                    data: {
                      preferences: nextPrefs,
                      ...buildBillingStateColumns({
                        plan: 'rookie',
                        pending_plan: null,
                        payment_pending: false,
                        payment_approved: false,
                      }),
                      subscription_tier: 'free',
                      subscription_status: 'canceled',
                      max_teams: SERVER_ROOKIE_TEAM_LIMIT,
                    },
                  });
                }
              } else if (tx.order_id && tx.transaction_type === 'AD_PURCHASE') {
                const purchaseReferences = [
                  tx.stripe_session_id,
                  tx.stripe_payment_intent_id,
                ].filter((ref): ref is string => !!ref);
                // Purchase provenance prevents a refund for an earlier run erasing newer inventory.
                // NULL legacy rows require reconciliation; no guessed date ownership.
                await db.adReservation.deleteMany({
                  where: { ad_id: tx.order_id, purchase_reference: { in: purchaseReferences } },
                });
                await db.adSlotHold.deleteMany({
                  where: { ad_id: tx.order_id, purchase_reference: { in: purchaseReferences } },
                });
                const remaining = await db.adReservation.count({ where: { ad_id: tx.order_id } });
                if (!remaining) {
                  const liveHolds = await db.adSlotHold.count({
                    where: { ad_id: tx.order_id, expires_at: { gt: new Date() } },
                  });
                  if (liveHolds) {
                    const currentAd = await db.ad.findUnique({
                      where: { id: tx.order_id },
                      select: { status: true },
                    });
                    await db.ad.updateMany({
                      where: { id: tx.order_id },
                      data: {
                        payment_status: 'hold',
                        ...(['active', 'approved', 'archived'].includes(currentAd?.status || '')
                          ? { status: 'approved' }
                          : {}),
                      },
                    });
                  } else {
                    await db.ad.updateMany({
                      where: { id: tx.order_id },
                      data: { status: 'draft', payment_status: 'refunded' },
                    });
                  }
                }
              }

              return { promoRollback: promoRollbackResult, entitlementRevoked };
            },
            { isolationLevel: 'Serializable' }
          );

          if (
            entitlementRevoked &&
            tx.user_id &&
            (tx.transaction_type === 'SUBSCRIPTION_PURCHASE' ||
              tx.transaction_type === 'SUBSCRIPTION_RENEWAL')
          ) {
            await invalidateMeCacheForUser(tx.user_id);
            console.warn('[webhook] User downgraded to rookie after Stripe refund', {
              user_id: tx.user_id,
            });
          } else if (tx.order_id && tx.transaction_type === 'AD_PURCHASE') {
            console.warn('[webhook] Ad refunded + reservations released', { ad_id: tx.order_id });
          }

          if (promoRollback.reversed) {
            console.warn('[webhook] Promo redemption reversed after refund', {
              transaction_id: tx.id,
              refs: promoRollback.orderReferences,
              count: promoRollback.count,
            });
          }
        }
      } catch (refundErr: any) {
        console.error('[webhook] charge.refunded handler failed:', refundErr?.message);
        captureException(refundErr as Error, { context: 'webhook_charge_refunded' });
        throw refundErr;
      }
    }

    if (event.type === 'checkout.session.expired') {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.metadata?.ad_id) {
        await releaseAdPurchaseHolds(session.metadata.ad_id, session.id, true);
      } else {
        await updateTransactionStatus(session.id, 'FAILED', {
          metadata: { reason: 'checkout_expired' },
        });
      }
    }

    // Handle canceled payment intents (Android PaymentSheet abandoned by user).
    // Without this handler the ad slot hold stays locked until the next expiry check.
    if (event.type === 'payment_intent.canceled') {
      const pi = event.data.object as Stripe.PaymentIntent;
      const meta = pi.metadata || {};
      if (!meta.ad_id)
        await logTransaction({
          transactionType: meta.ad_id ? 'AD_PURCHASE' : 'SUBSCRIPTION_PURCHASE',
          status: 'FAILED',
          stripePaymentIntentId: pi.id,
          userId: meta.user_id || undefined,
          totalCents: pi.amount,
          metadata: { reason: 'payment_intent_canceled', ...meta },
        }).catch(err => {
          console.error('[transaction-log] canceled PI log failed:', err);
          captureException(err as Error, { context: 'transaction_log_canceled_pi' });
        });

      if (meta.ad_id) await releaseAdPurchaseHolds(meta.ad_id, pi.id, true);
    }

    // Handle failed payment intents
    if (event.type === 'payment_intent.payment_failed') {
      const pi = event.data.object as Stripe.PaymentIntent;
      const meta = pi.metadata || {};
      if (!meta.ad_id)
        await logTransaction({
          transactionType: meta.ad_id ? 'AD_PURCHASE' : 'SUBSCRIPTION_PURCHASE',
          status: 'FAILED',
          stripePaymentIntentId: pi.id,
          userId: meta.user_id || undefined,
          totalCents: pi.amount,
          metadata: { reason: pi.last_payment_error?.message || 'payment_failed', ...meta },
        }).catch(err => {
          console.error('[transaction-log] failed payment log failed:', err);
          captureException(err as Error, { context: 'transaction_log_failed_payment' });
        });

      if (meta.ad_id) await releaseAdPurchaseHolds(meta.ad_id, pi.id, true);

      // Notify user of failed payment
      if (meta.user_id) {
        const failedUser = await prisma.user.findUnique({ where: { id: meta.user_id } });
        if (failedUser?.email) {
          await sendBillingNoticeEmail({
            to: failedUser.email,
            type: 'payment_failed',
            amount: `$${(pi.amount / 100).toFixed(2)}`,
            planName: meta.ad_id ? 'Ad Purchase' : 'VarsityHub Subscription',
          }).catch(err =>
            console.warn('[billing-email] payment_intent.failed notification failed:', err)
          );
        }
      }
    }

    // Handle PaymentSheet ad payments (PaymentIntent-based, no Checkout Session)
    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object as Stripe.PaymentIntent;
      const meta = pi.metadata || {};
      if (meta.ad_id) {
        const adId = meta.ad_id;
        let piDates: string[] = decodeAdDates(meta.dates);
        if (piDates.length === 0 && meta.dates) {
          console.error(
            '[webhook] ad payment_intent.succeeded: meta.dates malformed or empty — ad will NOT be activated, manual review needed',
            { adId, metaDates: meta.dates, piId: pi.id }
          );
          await updateTransactionStatus(pi.id, 'NEEDS_REVIEW', {
            stripePaymentIntentId: pi.id,
          }).catch(() => {});
        }
        if (piDates.length > 0) {
          try {
            await prisma.$transaction(
              async tx => {
                await activateApprovedAdPaymentIntent(tx, adId, piDates, pi.id);
              },
              { isolationLevel: 'Serializable' }
            );

            // Completion was committed with inventory in reserveAdSlots.
            // Send payment receipt (PDF Note 8 — restored from 87aeafa0)
            const adForEmail = await prisma.ad.findUnique({
              where: { id: adId },
              select: { business_name: true, target_zip_code: true, contact_email: true },
            });
            sendAdPaymentEmail({
              userId: meta.user_id || null,
              contactEmail: adForEmail?.contact_email || null,
              adId,
              dates: piDates,
              totalCents: pi.amount,
              businessName: adForEmail?.business_name,
              zipCode: adForEmail?.target_zip_code,
            }).catch((err: any) =>
              console.warn('[webhook] ad payment receipt failed:', (err as any)?.message || err)
            );
            // Ad was already approved before payment — no admin review needed

            // Redeem promo code if one was used — retry up to 3 times to prevent reuse
            if (meta.promo_code && meta.user_id) {
              const promoSubtotal = Number(meta.subtotal_cents || 0) || 0;
              let promoRedeemed = false;
              for (let attempt = 1; attempt <= 3; attempt++) {
                try {
                  await redeemPromo({
                    code: meta.promo_code,
                    subtotalCents: promoSubtotal,
                    userId: meta.user_id || '',
                    service: 'booking',
                    orderId: pi.id,
                  });
                  promoRedeemed = true;
                  break;
                } catch (e) {
                  console.warn(
                    `[webhook] promo redeem attempt ${attempt}/3 failed:`,
                    (e as any)?.message
                  );
                  if (attempt < 3) await new Promise(r => setTimeout(r, 500 * attempt));
                }
              }
              if (!promoRedeemed) {
                // PAY-5: Payment succeeded but promo usage wasn't decremented — promo can be reused.
                // Use NEEDS_REVIEW (not FAILED — the payment completed) so the admin
                // dashboard surfaces it without misrepresenting the payment outcome.
                console.error(
                  '[webhook] ⛔ PROMO REDEEM FAILED after 3 attempts — promo code may be reusable',
                  { code: meta.promo_code, pi_id: pi.id, userId: meta.user_id }
                );
                captureException(
                  new Error('Promo redemption failed after retries — revenue leak risk'),
                  {
                    context: 'promo_redeem_failed',
                    promoCode: meta.promo_code,
                    piId: pi.id,
                    userId: meta.user_id,
                    level: 'fatal',
                  }
                );
                updateTransactionStatus(pi.id, 'NEEDS_REVIEW', {
                  metadata: {
                    promo_redemption_failed: true,
                    promo_code: meta.promo_code,
                    needs_review: true,
                  },
                }).catch(err =>
                  console.warn('[webhook] failed to flag promo redemption failure:', err)
                );
              }
            }
          } catch (e: any) {
            if (e?.code === 'AD_PURCHASE_REFUNDED') {
              await markStripeEventProcessed(event.id);
              return { status: 200, body: { received: true, refunded: true } };
            }
            if (e?.slotFull) {
              console.error(
                '[payments] SLOT_FULL on payment_intent.succeeded — issuing auto-refund',
                { ad_id: adId, dates: e.dates, pi_id: pi.id }
              );
              // Auto-refund: charge the user's card back immediately
              try {
                const refund = await stripe.refunds.create({
                  payment_intent: pi.id,
                  reason: 'requested_by_customer',
                });
                try {
                  await releaseAdInventoryAfterSlotFullRefundWithRetry(adId, pi.id);
                  await updateTransactionStatus(pi.id, 'REFUNDED', {
                    metadata: {
                      reason: 'slot_full',
                      overbooked_dates: e.dates,
                      stripe_refund_id: refund.id,
                      refunded_amount_cents: refund.amount ?? pi.amount,
                      refund_currency: refund.currency || 'usd',
                      refund_status: refund.status || 'pending',
                      refunded_at: new Date().toISOString(),
                    },
                  });
                } catch (releaseErr: any) {
                  console.error(
                    '[payments] CRITICAL: Auto-refund succeeded but ad inventory release FAILED',
                    {
                      ad_id: adId,
                      pi_id: pi.id,
                      error: releaseErr?.message,
                    }
                  );
                  captureException(releaseErr as Error, {
                    context: 'slot_full_release_after_refund_failed',
                    adId,
                    piId: pi.id,
                    refundId: refund.id,
                  });
                  await updateTransactionStatus(pi.id, 'NEEDS_REVIEW', {
                    metadata: {
                      reason: 'slot_full_release_failed',
                      overbooked_dates: e.dates,
                      stripe_refund_id: refund.id,
                      refunded_amount_cents: refund.amount ?? pi.amount,
                      refund_currency: refund.currency || 'usd',
                      refund_status: refund.status || 'pending',
                      refunded_at: new Date().toISOString(),
                      release_pending: true,
                      release_error: releaseErr?.message || 'release_failed',
                    },
                  });
                }
                // Notify user their dates were unavailable and they've been refunded
                const adForRefund = await prisma.ad.findUnique({
                  where: { id: adId },
                  select: { business_name: true, target_zip_code: true },
                });
                const refundUser = meta.user_id
                  ? await prisma.user.findUnique({
                      where: { id: meta.user_id },
                      select: { email: true },
                    })
                  : null;
                if (refundUser?.email) {
                  sendBillingNoticeEmail({
                    to: refundUser.email,
                    type: 'payment_failed',
                    planName: `Ad Reservation for ${adForRefund?.business_name || 'your ad'}`,
                    amount: `$${(pi.amount / 100).toFixed(2)}`,
                    perks: [
                      `Your selected dates in zip code ${adForRefund?.target_zip_code || 'N/A'} were fully booked. You have been fully refunded $${(pi.amount / 100).toFixed(2)}.`,
                    ],
                  }).catch(err => {
                    console.error('[payments] Failed to send refund email:', err);
                    captureException(err as Error, {
                      context: 'slot_full_refund_email',
                      adId,
                      piId: pi.id,
                    });
                  });
                }
              } catch (refundErr: any) {
                // Refund failed — this is critical, requires manual intervention
                console.error('[payments] CRITICAL: Auto-refund FAILED for SLOT_FULL', {
                  ad_id: adId,
                  pi_id: pi.id,
                  error: refundErr?.message,
                });
                captureException(refundErr as Error, {
                  context: 'slot_full_auto_refund_failed',
                  adId,
                  piId: pi.id,
                  amount: pi.amount,
                });
                await updateTransactionStatus(pi.id, 'FAILED', {
                  metadata: {
                    reason: 'slot_full_refund_failed',
                    overbooked_dates: e.dates,
                    refund_failed: true,
                  },
                }).catch(err => {
                  console.error('[transaction-log] PI slot-full status update failed:', err);
                  captureException(err as Error, { context: 'transaction_log_slot_full_pi' });
                });
                await markStripeEventFailed(event.id, refundErr);
                return { status: 500, body: { error: 'Auto-refund failed; retrying webhook' } };
              }
            } else {
              await markStripeEventFailed(event.id, e);
              console.error(
                '[payments] CRITICAL: Error processing ad PI succeeded — returning 500 for Stripe retry',
                { ad_id: adId, pi_id: pi.id, error: e }
              );
              captureException(e as Error, {
                context: 'payment_intent_succeeded_ad',
                adId,
                piId: pi.id,
              });
              return { status: 500, body: { error: 'Ad processing failed' } };
            }
          }
        }
      }
    }
  } catch (eventErr: any) {
    await markStripeEventFailed(event.id, eventErr);
    console.error(
      '[webhook] CRITICAL: Unhandled webhook processing failure:',
      eventErr?.message || eventErr
    );
    captureException(eventErr as Error, {
      context: 'stripe_webhook_unhandled_processing_error',
      eventType: event.type,
      eventId: event.id,
    });
    return { status: 500, body: { error: 'Webhook processing failed' } };
  }

  await markStripeEventProcessed(event.id);
  return { status: 200, body: { received: true } };
}

// Public config for coach onboarding and payment UI (no auth required)
paymentsRouter.get('/config', (_req, res) => {
  const stripePublishableKey =
    process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY || process.env.STRIPE_PUBLISHABLE_KEY || '';
  const availablePlans = getAllPlanDefinitions();
  const stripeConfigured = !!(stripePublishableKey && process.env.STRIPE_SECRET_KEY);
  const hasWebhookSecret = !!process.env.STRIPE_WEBHOOK_SECRET;
  res.json({
    stripe_publishable_key: stripePublishableKey,
    available_plans: availablePlans,
    payments_enabled: stripeConfigured,
    stripe_configured: stripeConfigured,
    has_webhook_secret: hasWebhookSecret,
  });
});

paymentsRouter.post(
  '/ad-quote',
  expressPkg.json(),
  requireAuth as any,
  paymentLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    const quoteSchema = z.object({
      ad_id: z.string(),
      dates: z.array(adDateSchema).min(1),
      promo_code: z.string().optional(),
    });
    const parsed = quoteSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid payload', details: parsed.error.flatten().fieldErrors });
    }

    const isoDates = Array.from(new Set(parsed.data.dates.map(d => String(d))));
    const quote = await buildAdQuote({
      adId: parsed.data.ad_id,
      userId: req.user!.id,
      isoDates,
      promoCode: parsed.data.promo_code,
    });
    if ('error' in quote) {
      return res.status(quote.status!).json({
        error: quote.error!,
        ...(quote.dates ? { dates: quote.dates } : {}),
      });
    }

    return res.json({
      ad_id: parsed.data.ad_id,
      dates: isoDates,
      subtotal_cents: quote.subtotalCents,
      tax_cents: quote.taxCents,
      discount_cents: quote.discountCents,
      total_cents: quote.totalCents,
      weekday_blocks: quote.weekdayBlocks,
      weekend_blocks: quote.weekendBlocks,
      promo_code: quote.appliedPromoCode,
    });
  })
);

async function buildAdQuote(params: {
  adId: string;
  userId: string;
  isoDates: string[];
  promoCode?: string;
}) {
  const ad = await prisma.ad.findUnique({ where: { id: params.adId } });
  if (!ad) return { error: 'Ad not found', status: 404 as const };
  if (ad.user_id !== params.userId) {
    return { error: 'You can only price your own ads', status: 403 as const };
  }

  const MAX_BOOKING_HORIZON_DAYS = 56;
  const pastHorizon = getDatesPastBookingHorizon(
    params.isoDates,
    new Date(),
    MAX_BOOKING_HORIZON_DAYS
  );
  if (pastHorizon.length > 0) {
    return {
      error: `Dates must be within ${MAX_BOOKING_HORIZON_DAYS} days from today`,
      status: 400 as const,
      dates: pastHorizon,
    };
  }

  const pastDates = getPastAdDates(params.isoDates);
  if (pastDates.length > 0) {
    return {
      error: 'Ad dates must be today or in the future',
      status: 400 as const,
      dates: pastDates,
    };
  }

  const pricingResult = calculateAdPriceCents(params.isoDates);
  const subtotalCents = pricingResult.totalCents;
  if (subtotalCents <= 0) {
    return { error: 'Invalid amount', status: 400 as const };
  }

  const taxCents = ad.target_zip_code ? calculateSalesTax(subtotalCents, ad.target_zip_code) : 0;
  let discountCents = 0;
  let appliedPromoCode: string | null = null;
  if (params.promoCode && typeof params.promoCode === 'string') {
    const preview = await previewPromo({
      code: params.promoCode,
      subtotalCents,
      userId: params.userId,
      service: 'booking',
    });
    if (!preview.valid) {
      return { error: preview.reason || 'Invalid promo code', status: 400 as const };
    }
    discountCents = preview.discount_cents;
    appliedPromoCode = preview.code;
  }

  const totalCents = Math.max(0, subtotalCents - discountCents + taxCents);
  return {
    ad,
    subtotalCents,
    taxCents,
    discountCents,
    totalCents,
    appliedPromoCode,
    weekdayBlocks: pricingResult.weekdayBlocks,
    weekendBlocks: pricingResult.weekendBlocks,
  };
}

async function handleFullyCompedAdPayment(params: {
  res: Response;
  userId: string;
  adId: string;
  isoDates: string[];
  appliedCode?: string | null;
  subtotalCents: number;
  discountCents: number;
  ad: {
    target_zip_code?: string | null;
    business_name?: string | null;
  };
  transactionLogContext: string;
}) {
  const { res, userId, adId, isoDates, appliedCode, subtotalCents, discountCents, ad } = params;

  if (appliedCode) {
    await redeemPromo({
      code: appliedCode,
      subtotalCents,
      userId,
      service: 'booking',
      orderId: `FREE-${crypto.randomUUID()}`,
    });
  }
  try {
    await prisma.$transaction(
      async tx => {
        await reserveAdSlots(tx, {
          adId,
          targetZipCode: ad.target_zip_code,
          isoDates,
          paymentStatus: 'paid',
          status: 'active',
        });
      },
      { isolationLevel: 'Serializable' }
    );
  } catch (e: any) {
    if (e?.slotFull) {
      return res.status(409).json({
        error: 'One or more selected dates are fully booked',
        dates: e.dates,
      });
    }
    console.error('Failed to create ad reservations for free promo:', e);
    return res.status(500).json({ error: 'Failed to reserve ad dates. Please try again.' });
  }

  try {
    await logTransaction({
      transactionType: 'AD_PURCHASE',
      status: 'COMPLETED',
      userId,
      subtotalCents,
      taxCents: 0,
      discountCents,
      promoCode: appliedCode || undefined,
      promoDiscountCents: discountCents,
      totalCents: 0,
      netCents: 0,
      currency: 'usd',
      metadata: { free_promo: true, ad_id: adId, dates: isoDates },
    });
  } catch (err) {
    console.error('[payments] Failed to log free promo transaction:', err);
    captureException(err as Error, {
      context: params.transactionLogContext,
      adId,
    });
  }

  sendAdPaymentEmail({
    userId,
    adId,
    dates: isoDates,
    totalCents: 0,
    businessName: ad.business_name,
    zipCode: ad.target_zip_code,
  }).catch((err: any) =>
    console.warn('[payments] Free promo ad receipt failed:', (err as any)?.message || err)
  );
  return res.json({ free: true });
}

// Ad pricing now uses the shared helper from utils/adPricing.ts
// This ensures consistent pricing calculation ($5 weekday, $8 weekend per week block)
// and proper week-block grouping (multiple dates in same week = single charge)

const membershipPlans = ['veteran', 'legend'] as const;
type MembershipPlan = (typeof membershipPlans)[number];

const membershipPriceIds: Record<MembershipPlan, string | undefined> = {
  veteran: process.env.STRIPE_PRICE_VETERAN,
  legend: process.env.STRIPE_PRICE_LEGEND,
};

function membershipError(status: number, message: string) {
  const error = new Error(message);
  (error as any).statusCode = status;
  return error;
}

async function createMembershipCheckoutSession(
  req: AuthedRequest,
  planValue: unknown,
  promoCode?: string,
  teamCount?: number,
  organizationId?: string
) {
  if (!process.env.STRIPE_SECRET_KEY) throw membershipError(500, 'Stripe not configured');
  if (typeof planValue !== 'string' || !planValue.trim())
    throw membershipError(400, 'plan is required');
  const raw = planValue.trim().toLowerCase();
  if (raw !== 'veteran' && raw !== 'legend')
    throw membershipError(400, 'Invalid plan for subscription');
  const chosen = raw as MembershipPlan;
  let actualTeamCount = 0;
  let billableQuantity = 1;

  // Verify org ownership if organization_id provided
  if (organizationId) {
    const orgMembership = await getOrganizationMembership(req.user!.id, organizationId);
    if (!orgMembership || orgMembership.role !== 'owner' || orgMembership.status !== 'active') {
      throw membershipError(
        403,
        'Only the organization owner can purchase a subscription for the organization'
      );
    }
  }

  if (chosen === 'veteran') {
    // Scope to the org the user OWNS (server-authoritative via league_owner_id),
    // so an owner's subscription is billed on their whole org's program count —
    // consistent with the create-gate and quantity-update.
    const scopeOrgId = await resolveOwnerBillingOrgId(req.user!.id, organizationId);
    const snapshot = await getVeteranBillingSnapshot(req.user!.id, scopeOrgId);
    actualTeamCount = snapshot.programCount;
    billableQuantity = snapshot.billableQuantity;

    if (typeof teamCount === 'number' && teamCount !== actualTeamCount) {
      debugLog(
        `[payments] Ignoring client team_count=${teamCount}; using actual ${actualTeamCount} for user ${req.user!.id}${scopeOrgId ? ` org ${scopeOrgId}` : ''}`
      );
    }

    if (actualTeamCount < SERVER_VETERAN_MIN_TOTAL_TEAMS) {
      throw membershipError(
        400,
        `Veteran plan requires at least ${SERVER_VETERAN_MIN_TOTAL_TEAMS} total sports (first ${SERVER_ROOKIE_PROGRAM_LIMIT} are free)`
      );
    }
    if (billableQuantity === 0) {
      throw membershipError(
        400,
        `Select at least one billable sport (${SERVER_VETERAN_MIN_TOTAL_TEAMS} total) to use Veteran plan`
      );
    }
  }

  // Check if user already has this exact paid plan (allow upgrades from rookie)
  const userId = req.user!.id;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      preferences: true,
      approval_status: true,
      role: true,
      plan: true,
      pending_plan: true,
      payment_pending: true,
      payment_approved: true,
      paid_by_owner: true,
    },
  });
  const prefs =
    user?.preferences && typeof user.preferences === 'object' ? (user.preferences as any) : {};
  const userRole = getCanonicalUserRole(user as any);

  if (user?.paid_by_owner === true) {
    throw membershipError(403, OWNER_MANAGED_SUBSCRIPTION_ERROR);
  }

  // Block checkout if coach hasn't been approved yet
  if (userRole === 'coach' && user?.approval_status !== 'APPROVED') {
    throw membershipError(403, 'Your league must be approved before you can subscribe.');
  }
  const currentPlan = getCanonicalPlan(user as any);

  // Only block if user already has the exact same paid plan they're trying to purchase
  // Allow upgrades from rookie to veteran/legend, and between veteran/legend
  if (currentPlan === chosen) {
    throw membershipError(400, 'You already have this subscription plan');
  }

  debugLog(`[payments] Plan upgrade: ${currentPlan} → ${chosen} for user ${userId}`);

  // Check for recent payments to prevent duplicates
  try {
    const recentSessions = await stripe.checkout.sessions.list({
      limit: 10,
      created: { gte: Math.floor((Date.now() - 10 * 60 * 1000) / 1000) }, // Last 10 minutes
    });

    const recentUserSession = recentSessions.data.find(
      session =>
        session.metadata?.user_id === userId &&
        session.metadata?.plan === chosen &&
        session.payment_status === 'paid' // Only consider actually paid sessions
    );

    if (recentUserSession) {
      debugLog(
        '[payments] Recent PAID session found, updating user preferences from Stripe session'
      );
      // Update user preferences from the recent successful session
      await finalizeFromSession(recentUserSession);
      throw membershipError(400, 'Payment already processed recently');
    }
  } catch (err: any) {
    if (err.statusCode) throw err; // Re-throw our custom errors
    console.warn('[payments] Failed to check recent sessions:', err?.message || err);
  }
  const priceIdRaw = membershipPriceIds[chosen];
  const normalizedPriceId = typeof priceIdRaw === 'string' ? priceIdRaw.trim() : '';
  const placeholderHints = ['price_xxx', 'price_yyy', 'your_price_id'];
  const isPlaceholder =
    normalizedPriceId.length === 0 ||
    placeholderHints.some(hint => normalizedPriceId.toLowerCase().includes(hint));
  const hasExplicitPriceId = /^price_/i.test(normalizedPriceId) && !isPlaceholder;
  if (!hasExplicitPriceId && normalizedPriceId) {
    console.warn('[payments] Ignoring invalid Stripe price id for plan', chosen, normalizedPriceId);
  }

  if (!hasExplicitPriceId && process.env.NODE_ENV === 'production') {
    throw membershipError(
      500,
      `Stripe price ID not configured for ${chosen} plan. Set STRIPE_PRICE_${chosen.toUpperCase()} env var.`
    );
  }

  const lineItems = hasExplicitPriceId
    ? [{ price: normalizedPriceId, quantity: chosen === 'veteran' ? billableQuantity : 1 }]
    : [
        {
          quantity: chosen === 'veteran' ? billableQuantity : 1,
          price_data: {
            currency: 'usd',
            unit_amount:
              chosen === 'veteran' ? SERVER_VETERAN_PRICE_CENTS : SERVER_LEGEND_PRICE_CENTS,
            recurring: { interval: chosen === 'veteran' ? 'month' : 'year' },
            product_data: {
              name: 'Membership - ' + chosen,
              description:
                chosen === 'veteran'
                  ? `Veteran plan - ${SERVER_VETERAN_PRICE_LABEL} (${billableQuantity} billable of ${actualTeamCount} total, ${SERVER_ROOKIE_PROGRAM_LIMIT} free)`
                  : `Legend plan - ${SERVER_LEGEND_PRICE_LABEL} unlimited`,
            },
          },
        },
      ];

  const { success, cancel } = getCheckoutReturnUrls({ type: 'subscription' });

  // Create checkout session configuration
  const sessionConfig: Stripe.Checkout.SessionCreateParams = {
    mode: 'subscription',
    success_url: success,
    cancel_url: cancel,
    line_items: lineItems as any,
    metadata: {
      membership: '1',
      plan: chosen,
      user_id: req.user!.id,
      promo_code: promoCode || '',
      team_count_total: chosen === 'veteran' && actualTeamCount ? String(actualTeamCount) : '',
      team_count_billable: chosen === 'veteran' ? String(billableQuantity) : '',
      organization_id: organizationId || '',
    },
  };

  // Apply promo code if provided (Stripe coupon/promotion code)
  if (promoCode && typeof promoCode === 'string' && promoCode.trim()) {
    try {
      // Stripe accepts promotion codes directly in checkout sessions
      sessionConfig.discounts = [
        {
          promotion_code: promoCode.trim(),
        },
      ];
      debugLog(`[payments] Applying promo code to subscription: ${promoCode.trim()}`);
    } catch (promoErr) {
      console.warn('[payments] Failed to apply promo code:', promoErr);
      // Continue without promo code rather than failing
    }
  }

  // Store old subscription ID for cancellation AFTER new payment completes (in webhook/finalizeFromSession)
  // Do NOT cancel here — if user abandons checkout, they'd lose their current subscription
  const existingSubId = prefs.subscription_id;
  if (existingSubId && currentPlan !== 'rookie') {
    debugLog(
      `[payments] User has existing subscription ${existingSubId} — will cancel after new payment completes`
    );
  }

  // v1.0.2 audit fix: idempotency key was drifting every 60s via Math.floor(Date.now()/60000).
  // Network retries past the minute boundary created duplicate Stripe sessions → duplicate charges.
  // Now prefer client-supplied x-idempotency-key; fall back to a 1-hour window that still provides
  // meaningful retry protection without blocking legitimate new upgrades.
  const clientKey = (req.headers['x-idempotency-key'] as string) || '';
  if (!clientKey && process.env.NODE_ENV !== 'production') {
    console.warn(
      '[payments] No x-idempotency-key header on /payments/checkout — using 1h fallback window. Client should supply a UUID per checkout attempt.'
    );
  }
  const idempotencyKey =
    clientKey ||
    `membership_${req.user!.id}_${chosen}_${Math.floor(Date.now() / (60 * 60 * 1000))}`;
  const session = await stripe.checkout.sessions.create(sessionConfig, { idempotencyKey });

  // Log subscription transaction
  const currentUser = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: { email: true },
  });
  const amount =
    chosen === 'veteran'
      ? SERVER_VETERAN_PRICE_CENTS * billableQuantity
      : SERVER_LEGEND_PRICE_CENTS;
  await logTransaction({
    transactionType: 'SUBSCRIPTION_PURCHASE',
    status: 'PENDING',
    stripeSessionId: session.id,
    userId: req.user!.id,
    userEmail: currentUser?.email || 'unknown',
    subtotalCents: amount,
    taxCents: 0,
    stripeFeeeCents: calculateStripeFee(amount),
    discountCents: 0, // Will be updated in webhook when we know actual discount
    totalCents: amount, // Will be updated in webhook
    promoCode: promoCode || undefined,
    metadata: {
      plan: chosen,
      team_count_total: chosen === 'veteran' ? actualTeamCount : undefined,
      team_count_billable: chosen === 'veteran' ? billableQuantity : undefined,
      organization_id: organizationId || undefined,
    },
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  });

  return { url: session.url ?? null, sessionId: session.id };
}

async function getOrCreateStripeCustomer(userId: string, email?: string | null) {
  const existingUser = await prisma.user.findUnique({
    where: { id: userId },
    select: { stripe_customer_id: true },
  });
  if (existingUser?.stripe_customer_id) {
    return existingUser.stripe_customer_id;
  }

  return prisma.$transaction(
    async tx => {
      const fresh = await tx.user.findUnique({
        where: { id: userId },
        select: { stripe_customer_id: true },
      });
      if (fresh?.stripe_customer_id) return fresh.stripe_customer_id;

      const customer = await stripe.customers.create({
        email: email || undefined,
        metadata: { user_id: userId },
      });
      await tx.user.update({
        where: { id: userId },
        data: { stripe_customer_id: customer.id },
      });
      return customer.id;
    },
    { isolationLevel: 'Serializable' }
  );
}

// Create a Stripe Checkout Session for ad reservations
paymentsRouter.post(
  '/checkout',
  expressPkg.json(),
  requireAuth as any,
  paymentLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    req.log?.info({ userId: req.user?.id, path: '/checkout' }, '[checkout] start');
    const checkoutSchema = z.object({
      ad_id: z.string().optional(),
      dates: z.array(adDateSchema).optional(),
      promo_code: z.string().optional(),
      plan: z.string().optional(),
      team_count: z.number().optional(),
      organization_id: z.string().optional(),
      checkout_mode: z.enum(['app', 'web']).optional(),
    });
    const parsed = checkoutSchema.safeParse(req.body || {});
    if (!parsed.success)
      return res
        .status(400)
        .json({ error: 'Invalid payload', details: parsed.error.flatten().fieldErrors });
    const { ad_id, dates, promo_code, plan, team_count, organization_id, checkout_mode } =
      parsed.data;
    if (!(await enforceVerifiedForSubscriptionFlow(req, res, plan))) return;
    if (!(await enforceVerifiedForAdPaymentFlow(req, res, ad_id))) return;
    if (typeof plan === 'string' && plan.trim()) {
      if (!process.env.STRIPE_SECRET_KEY)
        return res.status(500).json({ error: 'Stripe not configured' });
      try {
        const { url, sessionId } = await createMembershipCheckoutSession(
          req,
          plan,
          promo_code,
          team_count,
          organization_id
        );
        return res.json({ url, session_id: sessionId });
      } catch (err: any) {
        const isOperational = typeof err?.statusCode === 'number';
        const status = isOperational ? err.statusCode : 500;
        captureException(err, { context: 'stripe_checkout_error', plan });
        return res.status(status).json({
          // error-envelope-exempt: pre-existing raw {error:string} response (whole file uses this shape); sanitized to a generic message for non-operational errors.
          error: isOperational ? err.message : 'Unable to start subscription checkout',
        });
      }
    }
    if (!ad_id || !Array.isArray(dates) || dates.length === 0)
      return res.status(400).json({ error: 'ad_id and dates[] are required' });
    if (!process.env.STRIPE_SECRET_KEY)
      return res.status(500).json({ error: 'Stripe not configured' });
    const isoDates: string[] = Array.from(new Set(dates.map((d: any) => String(d))));
    const quote = await buildAdQuote({
      adId: String(ad_id),
      userId: req.user!.id,
      isoDates,
      promoCode: promo_code,
    });
    if ('error' in quote) {
      return res.status(quote.status!).json({
        error: quote.error!,
        ...(quote.dates ? { dates: quote.dates } : {}),
      });
    }
    const { ad } = quote;

    // No charge until approved — archived campaigns can be re-booked
    // without re-approval because the media was already approved once.
    if (ad.status !== 'approved' && ad.status !== 'active' && ad.status !== 'archived') {
      return res.status(403).json({
        error: 'APPROVAL_REQUIRED',
        message:
          'Your ad must be approved before payment. An admin will review it and notify you when you can pay.',
      });
    }

    // Slot availability check — reject before Stripe if any date is already full.
    // Up to the shared ad-slot cap may run per date per zip.
    if (ad.target_zip_code) {
      // Include paid, hold, and pending_approval — align with PaymentSheet to prevent overfilling zip
      const fullDates = await getFullAdSlotDates(prisma, {
        adId: String(ad_id),
        targetZipCode: ad.target_zip_code,
        isoDates,
      });
      if (fullDates.length > 0) {
        return res.status(409).json({
          error: 'One or more selected dates are fully booked',
          dates: fullDates,
        });
      }
    }

    const subtotal = quote.subtotalCents;
    if (subtotal <= 0) return res.status(400).json({ error: 'Invalid amount' });
    const taxCents = quote.taxCents;
    const discount = quote.discountCents;
    const appliedCode = quote.appliedPromoCode;
    const total = quote.totalCents;
    // If promo covers 100% of the base price, treat as free (absorb tax on complimentary orders)
    const isFullyComped = discount >= subtotal;
    if (total === 0 || isFullyComped) {
      return handleFullyCompedAdPayment({
        res,
        userId: req.user!.id,
        adId: String(ad_id),
        isoDates,
        appliedCode,
        subtotalCents: subtotal,
        discountCents: discount,
        ad,
        transactionLogContext: 'free_promo_transaction_log',
      });
    }

    const { success, cancel } = getCheckoutReturnUrls({ type: 'ad', mode: checkout_mode });

    // Check if Stripe Price IDs are configured for ads (optional, fallback to price_data)
    const weekdayPriceId = process.env.STRIPE_PRICE_AD_WEEKDAY?.trim() || '';
    const weekendPriceId = process.env.STRIPE_PRICE_AD_WEEKEND?.trim() || '';
    const hasPriceIds =
      weekdayPriceId &&
      weekendPriceId &&
      /^price_/.test(weekdayPriceId) &&
      /^price_/.test(weekendPriceId);

    // CRITICAL: When using Price IDs, Stripe doesn't automatically add tax/discount
    // If tax or discount exists, we must use price_data to include them in the total
    // Otherwise we'd underbill by charging only base price without tax/discount
    const hasTaxOrDiscount = taxCents > 0 || discount > 0;

    // Build human-readable date range description (e.g. "Ad Reservation — Feb 27 - Mar 12, 2026 (7 days)")
    const _sd = [...isoDates].sort();
    const _d0 = new Date(_sd[0] + 'T12:00:00Z');
    const _d1 = new Date(_sd[_sd.length - 1] + 'T12:00:00Z');
    const _fmt = (d: Date, yr: boolean) =>
      d.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        ...(yr ? { year: 'numeric' } : {}),
      });
    const adDateDesc = `Ad Reservation — ${_fmt(_d0, false)} - ${_fmt(_d1, true)} (${isoDates.length} day${isoDates.length !== 1 ? 's' : ''})`;

    let lineItems: any[] = [];

    if (hasPriceIds && !hasTaxOrDiscount) {
      // Use Stripe Price IDs when available AND no tax/discount (can't add tax/discount to Price IDs easily)
      debugLog('[payments] Using Stripe Price IDs for ad checkout', {
        weekdayBlocks: quote.weekdayBlocks,
        weekendBlocks: quote.weekendBlocks,
        tax: taxCents,
        discount,
      });
      lineItems = [
        ...(quote.weekdayBlocks > 0
          ? [
              {
                price: weekdayPriceId,
                quantity: quote.weekdayBlocks,
              },
            ]
          : []),
        ...(quote.weekendBlocks > 0
          ? [
              {
                price: weekendPriceId,
                quantity: quote.weekendBlocks,
              },
            ]
          : []),
      ];

      // If no blocks selected (shouldn't happen, but defensive), fall back to price_data
      if (lineItems.length === 0) {
        debugLog('[payments] No blocks found, falling back to price_data');
        lineItems = [
          {
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: total,
              product_data: {
                name: 'Ad Reservation',
                description: adDateDesc,
              },
            },
          },
        ];
      }
    } else {
      // Use dynamic price_data when:
      // - Price IDs not configured, OR
      // - Tax or discount exists (Price IDs can't easily include tax/discount)
      if (hasTaxOrDiscount && hasPriceIds) {
        debugLog(
          '[payments] Tax/discount detected - using price_data instead of Price IDs to include tax/discount in total',
          {
            tax: taxCents,
            discount,
            total,
            subtotal,
          }
        );
      } else {
        debugLog('[payments] Using dynamic price_data for ad checkout (Price IDs not configured)');
      }

      lineItems = [
        {
          quantity: 1,
          price_data: {
            currency: 'usd',
            unit_amount: total, // Total includes tax and discount already calculated
            product_data: {
              name: 'Ad Reservation',
              description: `${adDateDesc}${discount > 0 ? ` (${formatUsd(discount)} discount applied)` : ''}${taxCents > 0 ? ` + ${formatUsd(taxCents)} tax` : ''}`,
            },
          },
        },
      ];
    }

    const sessionConfig: Stripe.Checkout.SessionCreateParams = {
      mode: 'payment',
      success_url: success,
      cancel_url: cancel,
      line_items: lineItems as any,
      // Useful metadata for webhook
      metadata: {
        ad_id: String(ad_id),
        dates: encodeAdDates(isoDates),
        user_id: req.user!.id,
        subtotal_cents: String(subtotal),
        tax_cents: String(taxCents),
        promo_code: appliedCode || '',
        discount_cents: String(discount || 0),
        weekday_blocks: String(quote.weekdayBlocks),
        weekend_blocks: String(quote.weekendBlocks),
      },
    };

    // If using Price IDs and there's a tax, we can't easily add it to Price ID line items
    // Stripe's automatic_tax feature could be used if enabled, but for now we fall back to price_data
    // This is already handled above (hasTaxOrDiscount check)

    // Note: If Stripe automatic tax is enabled in your Stripe account, you could set:
    // sessionConfig.automatic_tax = { enabled: true };
    // This would calculate and add tax automatically for Price IDs

    // v1.0.2 audit fix: same idempotency drift bug — widen fallback window to 1h.
    const adIdemClientKey = (req.headers['x-idempotency-key'] as string) || '';
    const adIdempotencyKey = crypto
      .createHash('sha256')
      .update(
        JSON.stringify([
          'ad_checkout',
          req.user!.id,
          ad_id,
          [...isoDates].sort(),
          appliedCode || '',
          adIdemClientKey || Math.floor(Date.now() / (60 * 60 * 1000)),
        ])
      )
      .digest('hex');
    const session = await stripe.checkout.sessions.create(sessionConfig, {
      idempotencyKey: adIdempotencyKey,
    });

    // Hold only this purchase's dates; existing paid inventory keeps serving.
    try {
      await prisma.$transaction(
        async tx => {
          await reserveAdSlots(tx, {
            adId: String(ad_id),
            targetZipCode: ad.target_zip_code,
            isoDates,
            paymentStatus: 'hold',
            purchaseReference: session.id,
            expiresAt: new Date(session.expires_at * 1000),
            ...(ad.status === 'archived' ? { status: 'approved' as const } : {}),
          });
        },
        { isolationLevel: 'Serializable' }
      );
    } catch (holdErr) {
      await stripe.checkout.sessions.expire(session.id).catch(error =>
        captureException(error, {
          context: 'expire_checkout_after_hold_failure',
          sessionId: session.id,
        })
      );
      if ((holdErr as any)?.slotFull || (holdErr as any)?.code === 'P2034') {
        return res.status(409).json({
          error:
            (holdErr as any)?.code === 'AD_DATES_ALREADY_BOOKED'
              ? 'Selected dates are already paid or booked for this ad.'
              : 'One or more selected dates are fully booked',
          code:
            (holdErr as any)?.code === 'AD_DATES_ALREADY_BOOKED'
              ? 'AD_DATES_ALREADY_BOOKED'
              : 'SLOT_FULL',
          dates: (holdErr as any).dates,
        });
      }
      console.error(
        '[payments] Failed to create slot hold — aborting checkout:',
        (holdErr as any)?.message
      );
      captureException(holdErr as Error, {
        context: 'ad_slot_hold_failed',
        adId: String(ad_id),
        userId: req.user!.id,
      });
      return res.status(500).json({ error: 'Failed to reserve ad slot. Please try again.' });
    }

    // Log transaction
    const currentUser = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { email: true },
    });
    await logTransaction({
      transactionType: 'AD_PURCHASE',
      status: 'PENDING',
      stripeSessionId: session.id,
      userId: req.user!.id,
      userEmail: currentUser?.email || 'unknown',
      orderId: String(ad_id),
      subtotalCents: subtotal,
      taxCents: taxCents,
      stripeFeeeCents: calculateStripeFee(total),
      discountCents: discount,
      totalCents: total,
      promoCode: appliedCode || undefined,
      promoDiscountCents: discount,
      metadata: {
        dates: isoDates,
        adId: ad_id,
        zipCode: ad.target_zip_code,
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    return res.json({ url: session.url });
  })
);

// ── In-App PaymentSheet endpoint ────────────────────────────────────────────
// Returns client_secret, ephemeral key, customer id and publishable key
// so the mobile app can present Stripe PaymentSheet without leaving the app.
paymentsRouter.post(
  '/create-payment-sheet',
  expressPkg.json(),
  requireAuth as any,
  paymentLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    const publishableKey =
      process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY || process.env.STRIPE_PUBLISHABLE_KEY || '';
    const userId = req.user!.id;
    const paymentSheetSchema = z.object({
      ad_id: z.string().optional(),
      dates: z.array(adDateSchema).optional(),
      promo_code: z.string().optional(),
      plan: z.string().optional(),
      team_count: z.number().optional(),
      organization_id: z.string().optional(),
    });
    const parsed = paymentSheetSchema.safeParse(req.body || {});
    if (!parsed.success)
      return res
        .status(400)
        .json({ error: 'Invalid payload', details: parsed.error.flatten().fieldErrors });
    const { ad_id, dates, promo_code, plan, team_count, organization_id: orgIdBody } = parsed.data;
    if (!(await enforceVerifiedForSubscriptionFlow(req, res, plan))) return;
    if (!(await enforceVerifiedForAdPaymentFlow(req, res, ad_id))) return;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        stripe_customer_id: true,
        preferences: true,
        plan: true,
        pending_plan: true,
        payment_pending: true,
        payment_approved: true,
        paid_by_owner: true,
      },
    });

    // ── SUBSCRIPTION FLOW ──
    if (typeof plan === 'string' && plan.trim()) {
      if (!process.env.STRIPE_SECRET_KEY)
        return res.status(500).json({ error: 'Stripe not configured' });
      const prefs =
        user?.preferences && typeof user.preferences === 'object' ? (user.preferences as any) : {};
      const customerId = await getOrCreateStripeCustomer(userId, user?.email);
      const ephemeralKey = await stripe.ephemeralKeys.create(
        { customer: customerId },
        { apiVersion: '2024-06-20' }
      );

      // Rule A: Fall back to pending_plan if plan param matches it, or use pending_plan directly
      const raw = plan.trim().toLowerCase();
      const selectedPlan = getSelectedPlan(user as any);
      const resolvedPlan = raw === 'veteran' || raw === 'legend' ? raw : selectedPlan;
      if (resolvedPlan !== 'veteran' && resolvedPlan !== 'legend')
        return res.status(400).json({ error: 'Invalid plan for subscription' });
      const chosen = resolvedPlan as MembershipPlan;
      let actualTeamCount = 0;
      let billableQuantity = 1;

      // Verify org ownership if organization_id provided
      if (orgIdBody) {
        const orgMem = await getOrganizationMembership(userId, orgIdBody);
        if (!orgMem || orgMem.role !== 'owner' || orgMem.status !== 'active') {
          return res.status(403).json({
            error: 'Only the organization owner can purchase a subscription for the organization',
          });
        }
      }

      // Rule A: Block checkout if coach hasn't been approved yet
      const approvalCheck = await prisma.user.findUnique({
        where: { id: req.user!.id },
        select: { approval_status: true, role: true, preferences: true },
      });
      if (
        getCanonicalUserRole(approvalCheck as any) === 'coach' &&
        approvalCheck?.approval_status !== 'APPROVED'
      ) {
        return res.status(403).json({
          error: 'APPROVAL_REQUIRED',
          message: 'Your league must be approved before you can subscribe.',
        });
      }

      if (chosen === 'veteran') {
        // Server-authoritative org scope (owner's subscription covers their org),
        // consistent with checkout + the create-gate. Also validates ownership —
        // a non-owned orgIdBody resolves away instead of being trusted.
        const scopeOrgId = await resolveOwnerBillingOrgId(userId, orgIdBody);
        const snapshot = await getVeteranBillingSnapshot(userId, scopeOrgId);
        actualTeamCount = snapshot.programCount;
        billableQuantity = snapshot.billableQuantity;

        if (typeof team_count === 'number' && team_count !== actualTeamCount) {
          debugLog(
            `[payments] Ignoring client team_count=${team_count}; using actual ${actualTeamCount} for user ${userId}${scopeOrgId ? ` org ${scopeOrgId}` : ''}`
          );
        }

        if (actualTeamCount < SERVER_VETERAN_MIN_TOTAL_TEAMS) {
          return res.status(400).json({
            error: `Veteran plan requires at least ${SERVER_VETERAN_MIN_TOTAL_TEAMS} total sports (first ${SERVER_ROOKIE_PROGRAM_LIMIT} are free)`,
          });
        }
        if (billableQuantity === 0) {
          // error-envelope-exempt: pre-existing raw response, unrelated to this change beyond the interpolated team-count constant.
          return res.status(400).json({
            // error-envelope-exempt
            error: `Select at least one billable sport (${SERVER_VETERAN_MIN_TOTAL_TEAMS} total) to use Veteran plan`,
          });
        }
      }

      // Check if user already has this plan (check active plan, not pending_plan)
      const currentPlan = getCanonicalPlan(user as any);
      if (currentPlan === chosen)
        return res.status(400).json({ error: 'You already have this subscription plan' });

      // Build price / line items
      const priceIdRaw = membershipPriceIds[chosen];
      const normalizedPriceId = typeof priceIdRaw === 'string' ? priceIdRaw.trim() : '';
      const hasExplicitPriceId =
        /^price_/i.test(normalizedPriceId) &&
        !['price_xxx', 'price_yyy', 'your_price_id'].some(h =>
          normalizedPriceId.toLowerCase().includes(h)
        );

      if (!hasExplicitPriceId && process.env.NODE_ENV === 'production') {
        return res.status(500).json({
          error: `Stripe price ID not configured for ${chosen} plan. Set STRIPE_PRICE_${chosen.toUpperCase()} env var.`,
        });
      }

      const items = hasExplicitPriceId
        ? [{ price: normalizedPriceId, quantity: chosen === 'veteran' ? billableQuantity : 1 }]
        : [
            {
              quantity: chosen === 'veteran' ? billableQuantity : 1,
              price_data: {
                currency: 'usd',
                unit_amount:
                  chosen === 'veteran' ? SERVER_VETERAN_PRICE_CENTS : SERVER_LEGEND_PRICE_CENTS,
                recurring: {
                  interval: chosen === 'veteran' ? ('month' as const) : ('year' as const),
                },
                product_data: {
                  name: 'Membership - ' + chosen,
                  description:
                    chosen === 'veteran'
                      ? `Veteran plan - ${SERVER_VETERAN_PRICE_LABEL} (${billableQuantity} billable of ${actualTeamCount} total, ${SERVER_ROOKIE_PROGRAM_LIMIT} free)`
                      : `Legend plan - ${SERVER_LEGEND_PRICE_LABEL} unlimited`,
                },
              },
            },
          ];

      try {
        const subscription = await stripe.subscriptions.create({
          customer: customerId,
          items: items as any,
          payment_behavior: 'default_incomplete',
          payment_settings: { save_default_payment_method: 'on_subscription' },
          expand: ['latest_invoice.payment_intent'],
          metadata: {
            membership: '1',
            plan: chosen,
            user_id: userId,
            promo_code: promo_code || '',
            team_count_total:
              chosen === 'veteran' && actualTeamCount ? String(actualTeamCount) : '',
            team_count_billable: chosen === 'veteran' ? String(billableQuantity) : '',
            organization_id: orgIdBody || '',
          },
        });

        const invoice = subscription.latest_invoice as Stripe.Invoice | null;
        const paymentIntent = invoice?.payment_intent as Stripe.PaymentIntent | null;
        if (!invoice || !paymentIntent) {
          return res.status(500).json({
            error:
              'Subscription created but payment could not be initialized. Please contact support.',
          });
        }

        const amount =
          chosen === 'veteran'
            ? SERVER_VETERAN_PRICE_CENTS * billableQuantity
            : SERVER_LEGEND_PRICE_CENTS;
        await logTransaction({
          transactionType: 'SUBSCRIPTION_PURCHASE',
          status: 'PENDING',
          stripeSessionId: subscription.id,
          userId,
          userEmail: user?.email || 'unknown',
          subtotalCents: amount,
          taxCents: 0,
          stripeFeeeCents: calculateStripeFee(amount),
          discountCents: 0,
          totalCents: amount,
          promoCode: promo_code || undefined,
          metadata: {
            plan: chosen,
            team_count_total: chosen === 'veteran' ? actualTeamCount : undefined,
            team_count_billable: chosen === 'veteran' ? billableQuantity : undefined,
          },
          ipAddress: req.ip,
          userAgent: req.get('user-agent'),
        });

        return res.json({
          paymentIntent: paymentIntent.client_secret,
          payment_intent_id: paymentIntent.id,
          ephemeralKey: ephemeralKey.secret,
          customer: customerId,
          publishableKey,
          subscriptionId: subscription.id,
        });
      } catch (err: any) {
        captureException(err, { context: 'create_payment_sheet_subscription', plan: chosen });
        const raw = err?.message || '';
        const safeMsg = /prod_|price_/i.test(raw)
          ? 'Unable to start subscription. Please try again or contact support.'
          : raw || 'Unable to start subscription';
        return res.status(500).json({ error: safeMsg });
      }
    }

    // ── AD PAYMENT FLOW ──
    if (!ad_id || !Array.isArray(dates) || dates.length === 0)
      return res
        .status(400)
        .json({ error: 'ad_id and dates[] are required (or plan for subscription)' });
    if (!process.env.STRIPE_SECRET_KEY)
      return res.status(500).json({ error: 'Stripe not configured' });
    const customerId = await getOrCreateStripeCustomer(userId, user?.email);
    const ephemeralKey = await stripe.ephemeralKeys.create(
      { customer: customerId },
      { apiVersion: '2024-06-20' }
    );
    const isoDates: string[] = Array.from(new Set(dates.map((d: any) => String(d))));
    const quote = await buildAdQuote({
      adId: String(ad_id),
      userId,
      isoDates,
      promoCode: promo_code,
    });
    if ('error' in quote) {
      return res.status(quote.status!).json({
        error: quote.error!,
        ...(quote.dates ? { dates: quote.dates } : {}),
      });
    }
    const { ad } = quote;

    // No charge until approved by emancero@varsityhub.app. Once approved,
    // archived campaigns can be booked again without another approval cycle.
    if (ad.status !== 'approved' && ad.status !== 'active' && ad.status !== 'archived') {
      return res.status(403).json({
        error: 'APPROVAL_REQUIRED',
        message:
          'Your ad must be approved before payment. An admin will review it and notify you when you can pay.',
      });
    }

    // Slot availability check — include 'hold' and 'pending_approval' ads
    if (ad.target_zip_code) {
      const fullDates = await getFullAdSlotDates(prisma, {
        adId: String(ad_id),
        targetZipCode: ad.target_zip_code,
        isoDates,
      });
      if (fullDates.length > 0) {
        return res.status(409).json({
          error: 'One or more selected dates are fully booked',
          dates: fullDates,
        });
      }
    }

    const subtotal = quote.subtotalCents;
    if (subtotal <= 0) return res.status(400).json({ error: 'Invalid amount' });
    const taxCents = quote.taxCents;
    const discount = quote.discountCents;
    const appliedCode = quote.appliedPromoCode;
    const total = quote.totalCents;
    const isFullyComped = discount >= subtotal;
    if (total === 0 || isFullyComped) {
      return handleFullyCompedAdPayment({
        res,
        userId,
        adId: String(ad_id),
        isoDates,
        appliedCode,
        subtotalCents: subtotal,
        discountCents: discount,
        ad,
        transactionLogContext: 'free_promo_transaction_log_pi',
      });
    }

    try {
      const paymentIntent = await stripe.paymentIntents.create(
        {
          amount: total,
          currency: 'usd',
          customer: customerId,
          automatic_payment_methods: { enabled: true },
          metadata: {
            ad_id: String(ad_id),
            dates: encodeAdDates(isoDates),
            user_id: userId,
            subtotal_cents: String(subtotal),
            tax_cents: String(taxCents),
            promo_code: appliedCode || '',
            discount_cents: String(discount || 0),
            weekday_blocks: String(quote.weekdayBlocks),
            weekend_blocks: String(quote.weekendBlocks),
          },
        },
        {
          // v1.0.2 audit fix: widen fallback window from 60s to 1h to prevent duplicate payment intents on retry
          idempotencyKey: crypto
            .createHash('sha256')
            .update(
              JSON.stringify([
                'ad_pi',
                userId,
                ad_id,
                [...isoDates].sort(),
                appliedCode || '',
                (req.headers['x-idempotency-key'] as string) ||
                  Math.floor(Date.now() / (60 * 60 * 1000)),
              ])
            )
            .digest('hex'),
        }
      );

      // Hold slots atomically — re-check capacity inside transaction to prevent race conditions
      try {
        await prisma.$transaction(
          async tx => {
            await reserveAdSlots(tx, {
              adId: String(ad_id),
              targetZipCode: ad.target_zip_code,
              isoDates,
              paymentStatus: 'hold',
              purchaseReference: paymentIntent.id,
              ...(ad.status === 'archived' ? { status: 'approved' as const } : {}),
            });
          },
          { isolationLevel: 'Serializable' }
        );
      } catch (holdErr: any) {
        // Cancel the payment intent since we can't hold the slots
        try {
          await stripe.paymentIntents.cancel(paymentIntent.id);
        } catch (cancelErr) {
          console.warn(
            '[payments] Failed to cancel payment intent after hold failure:',
            (cancelErr as Error)?.message
          );
        }
        console.error(
          '[payments] Failed to hold ad slots, cancelled payment:',
          (holdErr as any)?.message
        );
        return sendError(
          res,
          409,
          holdErr?.code === 'AD_DATES_ALREADY_BOOKED'
            ? 'Selected dates are already paid or booked for this ad.'
            : 'Ad slots are no longer available. Please try different dates.',
          {
            code:
              holdErr?.code === 'AD_DATES_ALREADY_BOOKED' ? 'AD_DATES_ALREADY_BOOKED' : 'SLOT_FULL',
          }
        );
      }

      // Log transaction
      await logTransaction({
        transactionType: 'AD_PURCHASE',
        status: 'PENDING',
        stripeSessionId: paymentIntent.id,
        stripePaymentIntentId: paymentIntent.id,
        userId,
        userEmail: user?.email || 'unknown',
        orderId: String(ad_id),
        subtotalCents: subtotal,
        taxCents,
        stripeFeeeCents: calculateStripeFee(total),
        discountCents: discount,
        totalCents: total,
        promoCode: appliedCode || undefined,
        promoDiscountCents: discount,
        metadata: { dates: isoDates, adId: ad_id, zipCode: ad.target_zip_code },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });

      return res.json({
        paymentIntent: paymentIntent.client_secret,
        payment_intent_id: paymentIntent.id,
        ephemeralKey: ephemeralKey.secret,
        customer: customerId,
        publishableKey,
        amount_cents: total,
      });
    } catch (err: any) {
      captureException(err, { context: 'create_payment_sheet_ad', ad_id });
      const isOperational = typeof err?.statusCode === 'number';
      // error-envelope-exempt: pre-existing raw {error:string} response; sanitized to a generic message for non-operational errors.
      return res
        .status(500)
        .json({ error: isOperational ? err.message : 'Unable to create payment' });
    }
  })
);

// Stripe webhook to finalize reservations on successful payment.
// IMPORTANT: The raw body parser is registered at the app level (server/src/index.ts)
// for route /payments/webhook BEFORE express.json(). Do not add parsers here.
paymentsRouter.post(
  '/webhook',
  asyncHandler(async (req, res) => {
    const sig = req.headers['stripe-signature'];
    if (!sig) {
      return res.status(400).json({ error: 'Missing stripe-signature header' });
    }

    const webhookSecret = (process.env.STRIPE_WEBHOOK_SECRET || '').trim();
    if (!webhookSecret) {
      console.error('STRIPE_WEBHOOK_SECRET is not set or is empty!');
      captureException(new Error('STRIPE_WEBHOOK_SECRET missing or empty'), {
        context: 'webhook_secret_missing',
        provider: 'stripe',
      });
      return res.status(500).json({ error: 'Webhook verification failed — server misconfigured' });
    }

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent((req as any).body, sig as string, webhookSecret);
    } catch (err: any) {
      console.error('Stripe webhook signature verification failed:', err?.message || err);
      captureException(err, { context: 'stripe_webhook_verification_failed', provider: 'stripe' });
      return res.status(400).send('Webhook Error: Invalid signature');
    }

    try {
      const response = await withDistributedLock(
        {
          namespace: 'payments:webhook-event',
          key: event.id,
          ttlMs: 10 * 60 * 1000,
          acquireTimeoutMs: 15 * 1000,
          retryDelayMs: 100,
          localLocks: webhookEventLocks,
        },
        () => processStripeWebhookEvent(event)
      );
      return res.status(response.status).json(response.body);
    } catch (lockErr: any) {
      const existing = await prisma.processedStripeEvent
        .findUnique({
          where: { event_id: event.id },
          select: { processed: true },
        })
        .catch(() => null);
      if (existing?.processed) {
        debugLog('[webhook] Duplicate event skipped after lock wait', {
          event_id: event.id,
          event_type: event.type,
        });
        return res.json({ received: true, deduplicated: true });
      }
      console.error(
        '[webhook] Failed to acquire event lock, rejecting for retry:',
        lockErr?.message || lockErr
      );
      captureException(lockErr as Error, {
        context: 'stripe_webhook_lock_failed',
        provider: 'stripe',
        eventType: event.type,
        eventId: event.id,
      });
      // PAY-1: Return 503 (not 500) so Stripe treats this as a transient failure and retries.
      // 500 causes Stripe to mark the event as failed after exhausting retries.
      return res
        .status(503)
        .json({ error: 'Webhook processing temporarily unavailable — will retry' });
    }
  })
);

// This route used to contain a full second Stripe webhook implementation.
// Keep the path as an explicit tombstone so old callers fail closed instead of
// silently reviving a divergent payment flow.
paymentsRouter.post(
  '/webhook-legacy-disabled',
  asyncHandler(async (_req, res) => {
    return res.status(410).json({ error: 'Legacy webhook route disabled' });
  })
);

// Cancel an abandoned PaymentIntent and mark transaction as FAILED
paymentsRouter.post(
  '/cancel-intent',
  expressPkg.json(),
  requireAuth as any,
  paymentLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    const cancelIntentSchema = z.object({
      payment_intent_id: z.string().min(1),
    });
    const parsed = cancelIntentSchema.safeParse(req.body || {});
    if (!parsed.success)
      return res
        .status(400)
        .json({ error: 'Invalid payload', details: parsed.error.flatten().fieldErrors });
    const { payment_intent_id } = parsed.data;
    try {
      const pi = await stripe.paymentIntents.retrieve(payment_intent_id);
      // Only cancel if the PI belongs to this user and is still cancelable
      if (pi.metadata?.user_id !== req.user!.id) {
        return res.status(403).json({ error: 'Unauthorized' });
      }
      if (
        ['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(pi.status)
      ) {
        await stripe.paymentIntents.cancel(payment_intent_id);
      } else if (pi.status !== 'canceled') {
        return sendError(res, 409, 'Payment is no longer cancelable', {
          extraFields: { canceled: false },
        });
      }
      if (!pi.metadata?.ad_id)
        await updateTransactionStatus(payment_intent_id, 'FAILED', {
          metadata: { reason: 'user_abandoned', canceled_at: new Date().toISOString() },
        }).catch(err => {
          console.error('[transaction-log] cancel-intent log failed:', err);
          captureException(err as Error, { context: 'cancel_intent_log' });
        });

      // Cancel incomplete subscription if this PI belongs to one (prevents orphaned subscriptions in Stripe)
      if (pi.invoice) {
        try {
          const invoice = await stripe.invoices.retrieve(String(pi.invoice));
          if (invoice.subscription) {
            const sub = await stripe.subscriptions.retrieve(String(invoice.subscription));
            if (sub.status === 'incomplete') {
              await stripe.subscriptions.cancel(sub.id);
              debugLog('[payments] Canceled incomplete subscription on cancel-intent', {
                sub_id: sub.id,
              });
            }
          }
        } catch (subErr) {
          console.warn(
            '[payments] Failed to cancel incomplete subscription:',
            (subErr as any)?.message
          );
        }
      }

      const cancelAdId = pi.metadata?.ad_id;
      if (cancelAdId) await releaseAdPurchaseHolds(cancelAdId, pi.id, true);

      return res.json({ canceled: true });
    } catch (err: any) {
      console.warn('[payments] cancel-intent error:', err?.message);
      return res.json({ canceled: false });
    }
  })
);

// Create a subscription Checkout Session for recurring membership plans
paymentsRouter.post(
  '/subscribe',
  expressPkg.json(),
  requireVerified as any,
  paymentLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const subscribeSchema = z.object({
        plan: z.string().min(1),
        promo_code: z.string().optional(),
      });
      const parsed = subscribeSchema.safeParse(req.body || {});
      if (!parsed.success)
        return res
          .status(400)
          .json({ error: 'Invalid payload', details: parsed.error.flatten().fieldErrors });
      const { plan, promo_code } = parsed.data;
      const { url, sessionId } = await createMembershipCheckoutSession(req, plan, promo_code);
      return res.json({ url, session_id: sessionId });
    } catch (err: any) {
      const isOperational = typeof err?.statusCode === 'number';
      const status = isOperational ? err.statusCode : 500;
      if (!isOperational) captureException(err, { context: 'subscribe_checkout_error' });
      return res.status(status).json({
        // error-envelope-exempt: pre-existing raw {error:string} response; sanitized to a generic message for non-operational errors.
        error: isOperational ? err.message : 'Unable to start subscription checkout',
      });
    }
  })
);

// Cancel an active membership subscription
paymentsRouter.post(
  '/subscription/cancel',
  expressPkg.json(),
  requireVerified as any,
  paymentLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const userId = req.user!.id;
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { preferences: true, stripe_customer_id: true, paid_by_owner: true },
      });
      if (user?.paid_by_owner === true) {
        return res.status(403).json({ error: OWNER_MANAGED_SUBSCRIPTION_ERROR });
      }
      const prefs =
        user?.preferences && typeof user.preferences === 'object' ? (user.preferences as any) : {};
      const subscriptionId: string | undefined =
        typeof prefs.subscription_id === 'string' ? prefs.subscription_id.trim() : undefined;

      if (!subscriptionId || !user?.stripe_customer_id) {
        return res.status(400).json({ error: 'No active subscription found' });
      }

      let subscription: Stripe.Subscription;
      try {
        subscription = await stripe.subscriptions.retrieve(subscriptionId);
      } catch (err: any) {
        return res
          .status(404)
          .json({ error: 'Subscription not found in Stripe', detail: err?.message });
      }
      const subCustomerId =
        typeof subscription.customer === 'string'
          ? subscription.customer
          : subscription.customer?.id;
      if (!subCustomerId || String(subCustomerId) !== String(user.stripe_customer_id)) {
        console.warn('[payments] refusing to mutate subscription owned by another customer', {
          userId,
          subscriptionId,
          subCustomerId,
          stripeCustomerId: user.stripe_customer_id,
        });
        return res.status(403).json({ error: 'Subscription ownership mismatch' });
      }

      await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });

      // Log the cancellation request
      await logTransaction({
        transactionType: 'SUBSCRIPTION_CANCEL',
        status: 'COMPLETED',
        stripeSubscriptionId: subscriptionId,
        userId,
        metadata: { action: 'cancel_at_period_end', plan: getCanonicalPlan(user as any) },
      }).catch(err => {
        console.error('[transaction-log] cancel request log failed:', err);
        captureException(err as Error, { context: 'transaction_log_cancel_request' });
      });

      return res.json({ ok: true });
    } catch (err) {
      console.error('Error cancelling subscription:', (err as any)?.message || err);
      return res.status(500).json({ error: 'Server error' });
    }
  })
);

// v1.0.2 pass 9: resume a cancel-at-period-end subscription before period actually ends.
// Mirrors /subscription/cancel; just sets cancel_at_period_end back to false.
// v1.0.2 pass 10: explicit requireAuth for defense-in-depth (matches pattern set in earlier passes).
// Logged as SUBSCRIPTION_CANCEL with metadata.action='resume_cancel_at_period_end' since
// SUBSCRIPTION_RESUME isn't in the TransactionType enum (would need a migration).
paymentsRouter.post(
  '/subscription/resume',
  expressPkg.json(),
  requireAuth as any,
  requireVerified as any,
  paymentLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const userId = req.user!.id;
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { preferences: true, stripe_customer_id: true, paid_by_owner: true },
      });
      if (user?.paid_by_owner === true) {
        return res.status(403).json({ error: OWNER_MANAGED_SUBSCRIPTION_ERROR });
      }
      const prefs =
        user?.preferences && typeof user.preferences === 'object' ? (user.preferences as any) : {};
      const subscriptionId: string | undefined =
        typeof prefs.subscription_id === 'string' ? prefs.subscription_id.trim() : undefined;
      if (!subscriptionId || !user?.stripe_customer_id) {
        return res.status(400).json({ error: 'No subscription to resume' });
      }
      let sub: Stripe.Subscription;
      try {
        sub = await stripe.subscriptions.retrieve(subscriptionId);
      } catch (err: any) {
        return res
          .status(404)
          .json({ error: 'Subscription not found in Stripe', detail: err?.message });
      }
      const resumeSubCustomerId =
        typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
      if (!resumeSubCustomerId || String(resumeSubCustomerId) !== String(user.stripe_customer_id)) {
        console.warn('[payments] refusing to mutate subscription owned by another customer', {
          userId,
          subscriptionId,
          resumeSubCustomerId,
          stripeCustomerId: user.stripe_customer_id,
        });
        return res.status(403).json({ error: 'Subscription ownership mismatch' });
      }
      if (!sub.cancel_at_period_end) {
        return res.json({
          ok: true,
          message: 'Subscription is already active',
          already_active: true,
        });
      }
      if (sub.status === 'canceled' || sub.status === 'incomplete_expired') {
        return res.status(400).json({
          error: 'Subscription has already ended. Please subscribe again.',
          code: 'SUBSCRIPTION_ENDED',
        });
      }
      try {
        await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: false });
      } catch (err: any) {
        console.warn('Failed to resume subscription:', err?.message || err);
        return res.status(500).json({ error: 'Failed to resume subscription with Stripe' });
      }
      await logTransaction({
        transactionType: 'SUBSCRIPTION_CANCEL',
        status: 'COMPLETED',
        stripeSubscriptionId: subscriptionId,
        userId,
        metadata: { action: 'resume_cancel_at_period_end', plan: getCanonicalPlan(user as any) },
      }).catch(err => {
        console.error('[transaction-log] resume log failed:', err);
        captureException(err as Error, { context: 'transaction_log_resume' });
      });
      return res.json({ ok: true, resumed: true });
    } catch (err) {
      console.error('Error resuming subscription:', (err as any)?.message || err);
      return res.status(500).json({ error: 'Server error' });
    }
  })
);

// Update subscription quantity for Veteran plan
paymentsRouter.post(
  '/update-subscription-quantity',
  expressPkg.json(),
  requireVerified as any,
  paymentLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      if (!process.env.STRIPE_SECRET_KEY)
        return res.status(500).json({ error: 'Stripe not configured' });

      const userId = req.user!.id;
      const updateQuantitySchema = z.object({
        team_count: z
          .number()
          .int()
          .min(
            SERVER_VETERAN_MIN_TOTAL_TEAMS,
            `Minimum ${SERVER_VETERAN_MIN_TOTAL_TEAMS} total sports required for Veteran plan.`
          ),
      });
      const parsed = updateQuantitySchema.safeParse(req.body);
      if (!parsed.success)
        return res
          .status(400)
          .json({ error: 'Invalid payload', details: parsed.error.flatten().fieldErrors });
      const { team_count } = parsed.data;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          preferences: true,
          plan: true,
          pending_plan: true,
          payment_pending: true,
          payment_approved: true,
          paid_by_owner: true,
        },
      });
      if (user?.paid_by_owner === true) {
        return res.status(403).json({ error: OWNER_MANAGED_SUBSCRIPTION_ERROR });
      }
      const prefs =
        user?.preferences && typeof user.preferences === 'object' ? (user.preferences as any) : {};
      const plan = getCanonicalPlan(user as any);
      const subscriptionId = prefs.subscription_id;

      if (plan !== 'veteran') {
        return res
          .status(400)
          .json({ error: 'This endpoint is only for Veteran plan subscribers' });
      }

      if (!subscriptionId) {
        return res.status(400).json({ error: 'No active subscription found' });
      }

      // Server-authoritative org scope (owner's subscription covers their org),
      // consistent with checkout, the create-gate, and update-subscription-quantity.
      const scopeOrgId = await resolveOwnerBillingOrgId(userId);
      const snapshot = await getVeteranBillingSnapshot(userId, scopeOrgId);
      const actualTeamCount = snapshot.programCount;
      const quantityUpdate = resolveVeteranQuantityUpdate(actualTeamCount, team_count);
      const billable = quantityUpdate.billableQuantity;
      if (billable === 0) {
        // error-envelope-exempt: pre-existing raw response, unrelated to this change beyond the interpolated team-count constant.
        return res.status(400).json({
          // error-envelope-exempt
          error: `No billable sports (only ${SERVER_ROOKIE_PROGRAM_LIMIT}). Remain on Rookie plan instead.`,
        });
      }

      if (!quantityUpdate.allowed) {
        return res.status(400).json({
          error: 'Team count mismatch',
          message:
            actualTeamCount >= SERVER_VETERAN_MIN_TOTAL_TEAMS
              ? `You currently own ${actualTeamCount} sport${actualTeamCount !== 1 ? 's' : ''}. This flow can only keep billing aligned with your current total or prepay for the next sport (${quantityUpdate.maxAllowedTotal} total).`
              : `Veteran billing requires at least ${SERVER_VETERAN_MIN_TOTAL_TEAMS} total sports.`,
          owned_teams: actualTeamCount,
          requested_teams: team_count,
        });
      }

      try {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);

        if (subscription.status !== 'active' && subscription.status !== 'trialing') {
          return res.status(400).json({ error: 'Subscription is not active' });
        }

        // Update the quantity of the subscription item
        const subscriptionItem = subscription.items.data[0];
        if (!subscriptionItem) {
          return res.status(400).json({ error: 'No subscription item found' });
        }

        await stripe.subscriptionItems.update(subscriptionItem.id, {
          quantity: billable,
        });

        // Log the quantity update
        logTransaction({
          transactionType: 'SUBSCRIPTION_PURCHASE',
          status: 'COMPLETED',
          userId,
          stripeSubscriptionId: subscriptionId,
          metadata: {
            event: 'quantity_update',
            new_quantity: billable,
            total_teams: team_count,
            subscription_id: subscriptionId,
          },
        }).catch(err =>
          captureException(err as Error, { context: 'quantity_update_transaction_log' })
        );

        debugLog(
          `[payments] Updated subscription ${subscriptionId} billable quantity to ${billable} (total teams ${team_count})`
        );

        return res.json({
          ok: true,
          subscription_id: subscriptionId,
          total_teams: team_count,
          billable_teams: billable,
          allowed_total_teams: getVeteranTotalTeamAllowance(billable),
          monthly_cost: Number(((billable * SERVER_VETERAN_PRICE_CENTS) / 100).toFixed(2)),
        });
      } catch (err: any) {
        console.warn('Failed to update Stripe subscription quantity:', err?.message || err);
        return res.status(500).json({ error: 'Failed to update subscription quantity' });
      }
    } catch (err) {
      console.error('Error updating subscription quantity:', (err as any)?.message || err);
      return res.status(500).json({ error: 'Server error' });
    }
  })
);

// Debug endpoint to check and fix subscription status discrepancies
paymentsRouter.get(
  '/debug/subscription-status',
  requireVerified as any,
  requireAdmin as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const userId = req.user!.id;
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          preferences: true,
          plan: true,
          pending_plan: true,
          payment_pending: true,
          payment_approved: true,
        },
      });
      const prefs =
        user?.preferences && typeof user.preferences === 'object' ? (user.preferences as any) : {};

      const storedPlan = getCanonicalPlan(user as any);
      const storedSubscriptionId = prefs.subscription_id;
      const storedPeriodEnd = prefs.subscription_period_end;

      let stripeSubscription = null;
      let stripeStatus = null;

      // Check actual Stripe subscription status if we have a subscription ID
      if (storedSubscriptionId && process.env.STRIPE_SECRET_KEY) {
        try {
          stripeSubscription = await stripe.subscriptions.retrieve(storedSubscriptionId);
          stripeStatus = stripeSubscription.status;
        } catch (err) {
          console.warn('Failed to retrieve Stripe subscription:', (err as any)?.message || err);
        }
      }

      // Check if there's a mismatch
      const hasPaidPlan = storedPlan !== 'rookie';
      const hasValidStripeSubscription = stripeStatus === 'active' || stripeStatus === 'trialing';
      const mismatch = hasPaidPlan && !hasValidStripeSubscription;

      return res.json({
        userId,
        stored: {
          plan: storedPlan,
          subscription_id: storedSubscriptionId,
          subscription_period_end: storedPeriodEnd,
        },
        stripe: {
          subscription_id: stripeSubscription?.id,
          status: stripeStatus,
          current_period_end: stripeSubscription?.current_period_end
            ? new Date(stripeSubscription.current_period_end * 1000).toISOString()
            : null,
        },
        mismatch,
        recommendation: mismatch
          ? 'Reset to rookie plan - no valid Stripe subscription found'
          : 'Status looks correct',
      });
    } catch (err) {
      console.error('Error checking subscription status:', (err as any)?.message || err);
      return res.status(500).json({ error: 'Server error' });
    }
  })
);

// Subscription summary for Billing screen
// v1.0.2: GET /payments/history — list user's own billing transactions (most recent first).
// Backs the new manage-subscription billing history view.
paymentsRouter.get(
  '/history',
  requireAuth as any,
  requireVerified as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const rows = await prisma.transactionLog.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
      take: limit,
      select: {
        id: true,
        transaction_type: true,
        status: true,
        total_cents: true,
        currency: true,
        promo_code: true,
        promo_discount_cents: true,
        created_at: true,
        metadata: true,
      },
    });
    return res.json({
      transactions: rows.map(r => ({
        id: r.id,
        type: r.transaction_type,
        status: r.status,
        amount_cents: r.total_cents,
        currency: r.currency,
        promo_code: r.promo_code,
        promo_discount_cents: r.promo_discount_cents,
        created_at: r.created_at.toISOString(),
      })),
    });
  })
);

paymentsRouter.get(
  '/subscription/summary',
  requireVerified as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const userId = req.user!.id;
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          preferences: true,
          plan: true,
          pending_plan: true,
          payment_pending: true,
          payment_approved: true,
        },
      });
      const prefs =
        user?.preferences && typeof user.preferences === 'object' ? (user.preferences as any) : {};
      const plan = getCanonicalPlan(user as any);
      const subscriptionId = prefs.subscription_id || null;

      let quantity: number | null = null;
      let status: string | null = null;
      let current_period_end: string | null = null;
      let monthly_cost: number | null = null;
      let annual_cost: number | null = null;
      const free_teams = SERVER_ROOKIE_TEAM_LIMIT;

      if (plan === 'veteran' && subscriptionId && process.env.STRIPE_SECRET_KEY) {
        try {
          const sub = await stripe.subscriptions.retrieve(subscriptionId);
          status = sub.status;
          if (sub.current_period_end)
            current_period_end = new Date(sub.current_period_end * 1000).toISOString();
          const item = sub.items.data[0];
          quantity = item?.quantity ?? null;
          if (typeof quantity === 'number')
            monthly_cost = Number(((quantity * SERVER_VETERAN_PRICE_CENTS) / 100).toFixed(2));
        } catch (err) {
          console.warn(
            '[payments] Failed to retrieve summary subscription:',
            (err as any)?.message || err
          );
        }
      } else if (plan === 'legend') {
        annual_cost = Number((SERVER_LEGEND_PRICE_CENTS / 100).toFixed(2));
        // status can be determined if subscription id exists
        if (subscriptionId && process.env.STRIPE_SECRET_KEY) {
          try {
            const sub = await stripe.subscriptions.retrieve(subscriptionId);
            status = sub.status;
            if (sub.current_period_end)
              current_period_end = new Date(sub.current_period_end * 1000).toISOString();
          } catch (err) {
            console.warn(
              '[payments] Failed to retrieve Legend subscription:',
              (err as any)?.message || err
            );
          }
        }
      }

      return res.json({
        plan,
        subscription_id: subscriptionId,
        status,
        quantity,
        free_teams,
        monthly_cost,
        annual_cost,
        current_period_end,
      });
    } catch (err) {
      console.error('Error building subscription summary:', (err as any)?.message || err);
      return res.status(500).json({ error: 'Server error' });
    }
  })
);

// Endpoint to reset subscription status to rookie (for fixing invalid states)
paymentsRouter.post(
  '/debug/reset-to-rookie',
  requireVerified as any,
  requireAdmin as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const userId = req.user!.id;
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          preferences: true,
          plan: true,
          pending_plan: true,
          payment_pending: true,
          payment_approved: true,
        },
      });
      const prefs =
        user?.preferences && typeof user.preferences === 'object' ? (user.preferences as any) : {};

      // Reset subscription-related preferences
      const nextPrefs: any = { ...prefs };
      delete nextPrefs.pending_plan;
      delete nextPrefs.subscription_id;
      delete nextPrefs.subscription_period_end;
      delete nextPrefs.stripe_customer_id;
      delete nextPrefs.payment_pending;
      delete nextPrefs.payment_approved;
      const normalizedPrefs = mergeBillingStateIntoPreferences(nextPrefs, {
        plan: 'rookie',
        pending_plan: null,
        payment_pending: false,
        payment_approved: false,
      });
      delete (normalizedPrefs as any).pending_plan;
      delete (normalizedPrefs as any).payment_pending;
      delete (normalizedPrefs as any).payment_approved;

      // cache-invalidation-exempt: invalidateMeCacheForUser called below
      await prisma.user.update({
        where: { id: userId },
        data: {
          preferences: normalizedPrefs,
          ...buildBillingStateColumns({
            plan: 'rookie',
            pending_plan: null,
            payment_pending: false,
            payment_approved: false,
          }),
        },
      });
      await invalidateMeCacheForUser(userId);

      debugLog(`[payments] Reset user ${userId} to rookie plan (debug endpoint)`);

      return res.json({
        ok: true,
        message: 'Successfully reset to rookie plan',
        newPlan: 'rookie',
      });
    } catch (err) {
      console.error('Error resetting to rookie plan:', (err as any)?.message || err);
      return res.status(500).json({ error: 'Server error' });
    }
  })
);

// Admin endpoint to reset all users with unpaid subscriptions
paymentsRouter.post(
  '/admin/reset-unpaid-subscriptions',
  requireVerified as any,
  requireAdmin as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      debugLog('🔍 Admin-initiated bulk reset of unpaid subscriptions...');

      // Find users with paid plans — filter subscription_id in JavaScript (JSON null detection is Prisma-version-specific)
      const paidPlanUsers = await prisma.user.findMany({
        where: {
          OR: [{ plan: 'veteran' }, { plan: 'legend' }],
        },
        select: {
          id: true,
          email: true,
          display_name: true,
          preferences: true,
          plan: true,
        },
        take: 5000,
      });
      // Filter out users who DO have a subscription_id — these are legitimate paid users
      const usersToReset = paidPlanUsers.filter(user => {
        const prefs =
          user.preferences && typeof user.preferences === 'object' ? (user.preferences as any) : {};
        return !prefs.subscription_id;
      });

      debugLog(`Found ${usersToReset.length} users with paid plans but no subscription ID`);

      if (usersToReset.length === 0) {
        return res.json({
          ok: true,
          message: 'No users needed to be reset',
          usersReset: 0,
          usersFound: 0,
        });
      }

      // Reset users
      let resetCount = 0;
      const resetUsers: Array<{ email: string; name: string | null; previousPlan: string }> = [];

      // Batch update: build all update operations, then execute in a single transaction
      const updateOps = usersToReset.map(user => {
        const currentPrefs =
          user.preferences && typeof user.preferences === 'object' ? (user.preferences as any) : {};
        const nextPrefs: any = { ...currentPrefs };
        delete nextPrefs.pending_plan;
        delete nextPrefs.subscription_id;
        delete nextPrefs.subscription_period_end;
        delete nextPrefs.stripe_customer_id;
        delete nextPrefs.payment_pending;
        delete nextPrefs.payment_approved;
        const normalizedPrefs = mergeBillingStateIntoPreferences(nextPrefs, {
          plan: 'rookie',
          pending_plan: null,
          payment_pending: false,
          payment_approved: false,
        });
        delete (normalizedPrefs as any).pending_plan;
        delete (normalizedPrefs as any).payment_pending;
        delete (normalizedPrefs as any).payment_approved;

        resetUsers.push({
          email: user.email,
          name: user.display_name,
          previousPlan: user.plan,
        });

        // cache-invalidation-exempt: invalidateMeCacheForUsers called below once all updates resolve
        return prisma.user.update({
          where: { id: user.id },
          data: {
            preferences: normalizedPrefs,
            ...buildBillingStateColumns({
              plan: 'rookie',
              pending_plan: null,
              payment_pending: false,
              payment_approved: false,
            }),
          },
        });
      });

      try {
        await prisma.$transaction(updateOps);
        await invalidateMeCacheForUsers(usersToReset.map(user => user.id));
        resetCount = usersToReset.length;
        for (const u of resetUsers) {
          debugLog(`✅ Admin reset: ${u.email} to rookie plan`);
        }
      } catch (error) {
        console.error('[payments] Failed to batch reset users:', (error as any)?.message || error);
        // Partial failure info not available with $transaction, report total attempted
      }

      debugLog(`[payments] Admin bulk reset completed: ${resetCount}/${usersToReset.length} users`);

      return res.json({
        ok: true,
        message: `Successfully reset ${resetCount} users to rookie plan`,
        usersReset: resetCount,
        usersFound: usersToReset.length,
        resetUsers,
      });
    } catch (err) {
      console.error('Error in admin bulk reset:', (err as any)?.message || err);
      return res.status(500).json({ error: 'Server error' });
    }
  })
);

// Authenticated helper to finalize a Checkout Session by id when webhooks are unavailable
paymentsRouter.post(
  '/finalize-session',
  expressPkg.json(),
  requireVerified as any,
  paymentLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const finalizeSchema = z.object({
        session_id: z.string().min(1),
      });
      const parsed = finalizeSchema.safeParse(req.body || {});
      if (!parsed.success)
        return res
          .status(400)
          .json({ error: 'Invalid payload', details: parsed.error.flatten().fieldErrors });
      const { session_id } = parsed.data;
      if (!process.env.STRIPE_SECRET_KEY)
        return res.status(500).json({ error: 'Stripe not configured' });
      const session = await stripe.checkout.sessions.retrieve(session_id);

      if (!session) return res.status(404).json({ error: 'Session not found' });
      const metaUserId = session.metadata?.user_id;
      if (!metaUserId) {
        return res.status(403).json({ error: 'Session metadata missing user' });
      }
      if (String(metaUserId) !== String(req.user!.id)) {
        return res.status(403).json({ error: 'Session does not belong to this user' });
      }
      if (session.payment_status !== 'paid') {
        return res
          .status(202)
          .json({ pending: true, payment_status: session.payment_status, status: session.status });
      }
      await finalizeFromSession(session as Stripe.Checkout.Session);

      // Return ad details for the confirmation screen
      const sessionMeta = session.metadata || {};
      const adId = sessionMeta.ad_id || '';
      let adDates: string[] = [];
      try {
        adDates = JSON.parse(String(sessionMeta.dates || '[]'));
      } catch {
        /* ignore */
      }
      let adDetails: any = null;
      if (adId) {
        const ad = await prisma.ad.findUnique({
          where: { id: adId },
          select: {
            id: true,
            business_name: true,
            status: true,
            payment_status: true,
            target_zip_code: true,
          },
        });
        if (ad) {
          adDetails = {
            id: ad.id,
            business_name: ad.business_name,
            status: ad.status,
            payment_status: ad.payment_status,
            zip_code: ad.target_zip_code,
            dates: adDates,
          };
        }
      }
      const amountPaid = typeof session.amount_total === 'number' ? session.amount_total : 0;
      return res.json({ ok: true, ad: adDetails, amount_cents: amountPaid });
    } catch (err) {
      console.error('Finalize-session error:', (err as any)?.message || err);
      return res.status(500).json({ error: 'Server error' });
    }
  })
);

paymentsRouter.post(
  '/finalize-subscription',
  expressPkg.json(),
  requireVerified as any,
  paymentLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const finalizeSchema = z.object({
        subscription_id: z.string().min(1),
      });
      const parsed = finalizeSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: 'Invalid payload', details: parsed.error.flatten().fieldErrors });
      }

      const { subscription_id } = parsed.data;
      if (!subscription_id.startsWith('sub_')) {
        return res.status(400).json({ error: 'Invalid subscription reference' });
      }
      if (!process.env.STRIPE_SECRET_KEY)
        return res.status(500).json({ error: 'Stripe not configured' });

      const user = await prisma.user.findUnique({
        where: { id: req.user!.id },
        select: { stripe_customer_id: true, paid_by_owner: true },
      });
      if (user?.paid_by_owner === true) {
        return res.status(403).json({ error: OWNER_MANAGED_SUBSCRIPTION_ERROR });
      }
      if (!user?.stripe_customer_id) {
        return res.status(400).json({ error: 'No Stripe customer found for this user' });
      }

      let subscription: Stripe.Subscription;
      try {
        subscription = await stripe.subscriptions.retrieve(subscription_id);
      } catch (err: any) {
        return res
          .status(404)
          .json({ error: 'Subscription not found in Stripe', detail: err?.message });
      }

      const subCustomerId =
        typeof subscription.customer === 'string'
          ? subscription.customer
          : subscription.customer?.id;
      if (!subCustomerId || String(subCustomerId) !== String(user.stripe_customer_id)) {
        console.warn('[payments] refusing to finalize subscription for non-owner', {
          userId: req.user!.id,
          subscriptionId: subscription_id,
          subCustomerId,
          stripeCustomerId: user.stripe_customer_id,
        });
        return res.status(403).json({ error: 'Subscription does not belong to this user' });
      }

      const syncResult = await syncStripeSubscriptionState(subscription, 'subscription.finalize');
      if (!syncResult.entitlementActive) {
        return res.status(202).json({
          pending: true,
          status: subscription.status,
        });
      }

      return res.json({
        ok: true,
        status: subscription.status,
        plan: syncResult.plan,
      });
    } catch (err) {
      console.error('Finalize-subscription error:', (err as any)?.message || err);
      return res.status(500).json({ error: 'Server error' });
    }
  })
);

// Per-session lock to prevent concurrent finalization (H2 — client/webhook race).
// Uses local promise dedupe + Redis distributed lock (when REDIS_URL is configured).
const finalizeSessionLocks = new Map<string, Promise<void>>();

// Optional helper to finalize payment based on a Checkout Session's metadata (fallback if webhook is not configured)
async function finalizeFromSession(session: Stripe.Checkout.Session) {
  await withDistributedLock(
    {
      namespace: 'payments:finalize-session',
      key: session.id,
      ttlMs: 10 * 60 * 1000,
      acquireTimeoutMs: 45 * 1000,
      retryDelayMs: 150,
      localLocks: finalizeSessionLocks,
    },
    async () => {
      await runFinalizeFromSession(session);
    }
  );
}

// Human-facing pages for success/cancel, with success also attempting confirmation if session_id present
// v1.0.2 pass 11: /success is a PUBLIC GET that triggers Stripe + DB writes via finalizeFromSession.
// Without a rate limit, an attacker spamming arbitrary session_id values forces real Stripe API
// calls per request. paymentLimiter caps abuse without breaking legitimate post-checkout redirects.
paymentsRouter.get(
  '/success',
  paymentLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    const appScheme = process.env.APP_SCHEME || 'varsityhubmobile';
    const appReturnPath = process.env.APP_RETURN_PATH || '';
    const returnUrl = `${appScheme}://${appReturnPath}`;
    const sessionId = typeof req.query.session_id === 'string' ? req.query.session_id : undefined;
    // PAY-3: Validate session_id format before hitting Stripe API (prevent enumeration)
    if (
      sessionId &&
      process.env.STRIPE_SECRET_KEY &&
      /^cs_(test_|live_)[a-zA-Z0-9]+$/.test(sessionId)
    ) {
      try {
        // Dedup: only finalize if not already processed by webhook
        const alreadyProcessed = await prisma.processedStripeEvent.findFirst({
          where: { event_id: `success_page_${sessionId}` },
        });
        if (!alreadyProcessed) {
          const session = await stripe.checkout.sessions.retrieve(sessionId);
          // PAY-3: Verify session metadata contains a valid user_id before finalizing
          const sessionUserId = (session.metadata as any)?.user_id;
          if (!sessionUserId) {
            console.warn('[payments] Success page: session has no user_id in metadata', {
              session_id: sessionId,
            });
          } else if (!req.user?.id || String(sessionUserId) !== String(req.user.id)) {
            console.warn('[payments] refusing to finalize session for non-owner', {
              session_id: sessionId,
              session_user_id: sessionUserId,
              requester_user_id: req.user?.id || null,
            });
          } else if (session.payment_status === 'paid') {
            await finalizeFromSession(session);
            await prisma.processedStripeEvent
              .create({
                data: {
                  event_id: `success_page_${sessionId}`,
                  event_type: 'success_page_finalize',
                },
              })
              .catch(() => {}); // Ignore duplicate key
          }
        }
      } catch (e) {
        console.error('[payments] Post-payment finalization failed:', {
          session_id: sessionId,
          error: (e as any)?.message || e,
        });
      }
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Payment Successful</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif; background: #f8fafc; color: #0f172a; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
      .box { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 20px; max-width: 520px; box-shadow: 0 6px 20px rgba(2,6,23,0.06); text-align: center; }
      .title { font-size: 20px; font-weight: 800; margin-bottom: 6px; }
      .muted { color: #64748b; }
      .btn { display: inline-block; margin-top: 12px; padding: 10px 14px; border-radius: 10px; background: #111827; color: #fff; font-weight: 800; text-decoration: none; }
    </style>
  </head>
  <body>
    <div class="box">
      <div class="title">Payment successful</div>
      <div class="muted">Your ad dates will appear shortly. You can return to the app now.</div>
      <a href="${returnUrl}" class="btn">Return to app</a>
      <br/>
      <a href="#" class="btn" onclick="window.close(); return false;">Close</a>
    </div>
    <script>
      setTimeout(function(){ try { window.location = '${returnUrl}'; } catch (e) {} }, 400);
    </script>
  </body>
</html>`);
  })
);

// ── Apple IAP Receipt Verification ──────────────────────────────────
const APPLE_SHARED_SECRET = process.env.APPLE_IAP_SHARED_SECRET || '';
const APPLE_VERIFY_URL_PRODUCTION = 'https://buy.itunes.apple.com/verifyReceipt';
const APPLE_VERIFY_URL_SANDBOX = 'https://sandbox.itunes.apple.com/verifyReceipt';

const APPLE_AD_PRODUCTS = ['MOND_THURS', 'FRI_SUN'] as const;

async function markStripeEventProcessed(eventId: string) {
  await prisma.processedStripeEvent.update({
    where: { event_id: eventId },
    data: {
      processed: true,
      processed_at: new Date(),
      processing_started_at: null,
      last_error: null,
    },
  });
}

async function markStripeEventFailed(eventId: string, error: unknown) {
  await prisma.processedStripeEvent
    .update({
      where: { event_id: eventId },
      data: {
        processed: false,
        processing_started_at: null,
        last_error: String((error as any)?.message || error || 'unknown_error').slice(0, 2000),
      },
    })
    .catch(updateErr => {
      console.warn(
        '[webhook] Failed to record event processing error:',
        (updateErr as any)?.message || updateErr
      );
    });
}

async function verifyAppleReceipt(receiptData: string, useSandbox = false): Promise<any> {
  const url = useSandbox ? APPLE_VERIFY_URL_SANDBOX : APPLE_VERIFY_URL_PRODUCTION;
  const body = JSON.stringify({
    'receipt-data': receiptData,
    password: APPLE_SHARED_SECRET,
    'exclude-old-transactions': true,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    // Breaker fails fast when Apple's verify endpoint is down; the
    // AbortController still cancels the in-flight request on timeout.
    const resp = await runWithBreaker(
      'apple-verify',
      () =>
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: controller.signal,
        }),
      { timeout: 12000 }
    );
    return resp.json();
  } finally {
    clearTimeout(timeout);
  }
}

// Apple IAP receipt validation
paymentsRouter.post(
  '/apple/verify-receipt',
  expressPkg.json(),
  requireVerified as any,
  paymentLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    req.log?.info({ userId: req.user?.id, path: '/apple/verify-receipt' }, '[apple-iap] start');
    try {
      const appleReceiptSchema = z.object({
        jws: z.string().min(1).optional().nullable(),
        receipt: z.string().min(1).optional(),
        productId: z.string().min(1),
      });
      const parsed = appleReceiptSchema.safeParse(req.body);
      if (!parsed.success)
        return res
          .status(400)
          .json({ error: 'Invalid payload', details: parsed.error.flatten().fieldErrors });
      const { jws, receipt, productId } = parsed.data;

      if (!jws && !receipt) {
        return res
          .status(400)
          .json({ error: 'Apple verification requires a signed transaction or receipt' });
      }
      if (!jws && process.env.NODE_ENV === 'production') {
        return res
          .status(400)
          .json({ error: 'Legacy Apple receipts are no longer accepted. Please update the app.' });
      }
      if (!jws && !APPLE_SHARED_SECRET) {
        console.warn('[apple-iap] APPLE_IAP_SHARED_SECRET not configured — cannot verify receipts');
        return res
          .status(503)
          .json({ error: 'IAP verification not configured. Please contact support.' });
      }
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'AUTH_REQUIRED' });
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { preferences: true, email: true, paid_by_owner: true },
      });
      if (user?.paid_by_owner === true) {
        return res.status(403).json({ error: OWNER_MANAGED_SUBSCRIPTION_ERROR });
      }

      const plan = APPLE_PRODUCT_TO_PLAN[productId];
      if (!plan) {
        return res.status(400).json({ error: `Unknown product: ${productId}` });
      }

      let originalTransactionId = '';
      let expiresMs = 0;
      let appleTransactionId = '';

      if (jws) {
        let signedTransaction: any;
        try {
          signedTransaction = await verifyAppleSignedJws(jws);
        } catch (error: any) {
          console.error('[payments] Apple JWS verification failed (subscription):', error?.message);
          captureException(error, { context: 'apple_jws_verify_subscription' });
          return res.status(400).json({ error: 'Invalid Apple transaction signature' });
        }

        const signedProductId = String(
          signedTransaction.productId || signedTransaction.product_id || ''
        ).trim();
        if (signedProductId !== productId) {
          return res
            .status(400)
            .json({ error: 'Signed Apple transaction does not match requested product' });
        }

        originalTransactionId = String(
          signedTransaction.originalTransactionId ||
            signedTransaction.originalTransactionIdentifierIOS ||
            signedTransaction.original_transaction_id ||
            signedTransaction.transactionId ||
            ''
        ).trim();
        appleTransactionId = String(
          signedTransaction.transactionId || signedTransaction.id || originalTransactionId
        ).trim();
        expiresMs = Number(
          signedTransaction.expiresDate ||
            signedTransaction.expires_date_ms ||
            signedTransaction.expirationDateIOS ||
            0
        );
      } else {
        let result = await verifyAppleReceipt(receipt!, false);
        if (result.status === 21007) {
          result = await verifyAppleReceipt(receipt!, true);
        }

        if (result.status !== 0) {
          console.error('[apple-iap] Verification failed, status:', result.status);
          return res
            .status(400)
            .json({ error: 'Receipt verification failed', appleStatus: result.status });
        }

        const latestReceipts = result.latest_receipt_info || [];
        const matchingReceipt = latestReceipts.find((r: any) => r.product_id === productId);

        if (!matchingReceipt) {
          return res.status(400).json({ error: 'No matching subscription found in receipt' });
        }

        originalTransactionId = String(matchingReceipt.original_transaction_id || '').trim();
        appleTransactionId = String(
          matchingReceipt.transaction_id || matchingReceipt.original_transaction_id || ''
        ).trim();
        expiresMs = parseInt(matchingReceipt.expires_date_ms, 10);
      }

      if (expiresMs < Date.now()) {
        return res.status(400).json({ error: 'Subscription has expired' });
      }

      if (!originalTransactionId) {
        return res.status(400).json({ error: 'Missing original transaction id' });
      }
      const existingApplePurchase = await prisma.transactionLog.findFirst({
        where: {
          order_id: originalTransactionId,
          transaction_type: 'SUBSCRIPTION_PURCHASE',
          status: 'COMPLETED',
        } as any,
        select: { user_id: true },
      });
      if (existingApplePurchase?.user_id && existingApplePurchase.user_id !== userId) {
        return res.status(409).json({ error: 'Receipt already used by another account' });
      }
      const expiresAtIso = new Date(expiresMs).toISOString();
      await ensureApplePendingTransactionLog({
        transactionType: 'SUBSCRIPTION_PURCHASE',
        userId,
        userEmail: user?.email,
        orderId: originalTransactionId,
        appleTransactionId: appleTransactionId || null,
        metadata: {
          source: jws ? 'apple_iap_jws' : 'apple_iap_receipt',
          productId,
          plan,
          apple_expires_date: expiresAtIso,
        },
      });

      const result = await finalizeAppleSubscriptionPurchase({
        userId,
        userEmail: user?.email,
        productId,
        originalTransactionId,
        appleTransactionId: appleTransactionId || null,
        expiresAtIso,
        source: jws ? 'apple_iap_jws' : 'apple_iap_receipt',
      });

      debugLog('apple-iap', `User ${userId} subscribed to ${plan} via Apple IAP`);

      return res.json(result);
    } catch (err: any) {
      if (err?.statusCode && err?.body) {
        return res.status(err.statusCode).json(err.body);
      }
      console.error('[apple-iap] verify-receipt error:', err);
      captureException(err, { context: 'apple-iap-verify', provider: 'apple_iap' });
      return res.status(500).json({ error: 'Receipt verification failed' });
    }
  })
);

// Durable Apple ad checkout: establish account-bound intent before StoreKit.
function adIntentHandler(fn: (req: AuthedRequest, res: Response) => Promise<unknown>) {
  return asyncHandler(async (req: AuthedRequest, res: Response) => {
    try {
      await fn(req, res);
    } catch (error: any) {
      if (error instanceof z.ZodError)
        return sendError(res, 400, 'Invalid purchase intent payload', {
          code: 'INVALID_PURCHASE_INTENT',
        });
      if (error instanceof AdIntentError) {
        const messages: Record<string, string> = {
          REPLACEMENT_PRODUCT_MISMATCH:
            'Select the same number of weekday and weekend blocks as your saved purchase.',
          PURCHASE_DATES_CHANGED:
            'This purchase was updated elsewhere. Refresh it before changing dates.',
          PURCHASE_ALREADY_COMPLETED: 'This purchase is already booked and cannot be moved here.',
          INVALID_BOOKING_DATES: 'Select future dates within the next eight weeks.',
          SLOT_FULL: 'Some selected dates are full. Choose other dates; your payment is saved.',
          AD_DATES_ALREADY_BOOKED:
            'This ad already has a booking on some selected dates. Choose other dates.',
          AD_NOT_APPROVED: 'This ad needs approval before it can be booked.',
        };
        return sendError(res, error.statusCode, messages[error.code] || error.message, {
          code: error.code,
        });
      }
      captureException(new Error('Ad intent request failed'), {
        context: 'ad_intent_request',
        failure_code: error?.code || 'unknown',
      });
      return sendError(res, 503, 'Purchase recovery will retry. Do not purchase again.', {
        code: 'PURCHASE_RECOVERY_RETRY',
      });
    }
  });
}
paymentsRouter.post(
  '/apple/ad-intents',
  requireAuth as any,
  paymentLimiter,
  // async-handler-exempt: adIntentHandler wraps this callback in asyncHandler and maps intent errors.
  adIntentHandler(async (req, res) => {
    if (!(await enforceVerifiedForAdPaymentFlow(req, res, String(req.body?.ad_id || '')))) return;
    res.json(await createAdPurchaseIntent(req.user!.id, req.body));
  })
);
paymentsRouter.get(
  '/apple/ad-intents',
  requireAuth as any,
  // async-handler-exempt: adIntentHandler wraps this callback in asyncHandler and maps intent errors.
  adIntentHandler(async (req, res) => {
    res.json({ items: await listAdPurchaseIntents(req.user!.id) });
  })
);
paymentsRouter.post(
  '/apple/ad-intents/reconcile',
  requireAuth as any,
  paymentLimiter,
  // async-handler-exempt: adIntentHandler wraps this callback in asyncHandler and maps intent errors.
  adIntentHandler(async (req, res) => {
    res.json(await reconcileReadyAdPurchases(req.user!.id));
  })
);
paymentsRouter.post(
  '/apple/ad-intents/:id/dates',
  requireAuth as any,
  paymentLimiter,
  // async-handler-exempt: adIntentHandler wraps this callback in asyncHandler and maps intent errors.
  adIntentHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    res.json(await reviseAdPurchaseIntentDates(req.user!.id, id, req.body));
  })
);
paymentsRouter.post(
  '/apple/ad-intents/:id/receipts',
  requireAuth as any,
  paymentLimiter,
  // async-handler-exempt: adIntentHandler wraps this callback in asyncHandler and maps intent errors.
  adIntentHandler(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    const { jws } = z
      .object({ jws: z.string().min(1).max(100000) })
      .strict()
      .parse(req.body);
    res.json(await recordAdPurchaseReceipt(req.user!.id, id, jws));
  })
);

// Apple IAP ad receipt verification (consumable products: MOND_THURS, FRI_SUN)
paymentsRouter.post(
  '/apple/verify-ad-receipt',
  expressPkg.json(),
  requireAuth as any,
  paymentLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'AUTH_REQUIRED' });

      const appleAdReceiptSchema = z.object({
        ad_id: z.string().min(1),
        dates: z.array(adDateSchema).min(1),
        receipts: z
          .array(
            z.object({
              jws: z.string().min(1).optional().nullable(),
              receipt: z.string().min(1).optional(),
              productId: z.string().min(1),
              quantity: z.number().optional(),
            })
          )
          .min(1),
      });
      const parsed = appleAdReceiptSchema.safeParse(req.body);
      if (!parsed.success)
        return res
          .status(400)
          .json({ error: 'Invalid payload', details: parsed.error.flatten().fieldErrors });
      const { ad_id, dates, receipts } = parsed.data;
      if (!(await enforceVerifiedForAdPaymentFlow(req, res, ad_id))) return;
      if (receipts.some(entry => !entry.jws && !entry.receipt)) {
        return res
          .status(400)
          .json({ error: 'Each Apple purchase must include a signed transaction or receipt' });
      }
      if (receipts.some(entry => !entry.jws) && process.env.NODE_ENV === 'production') {
        return res
          .status(400)
          .json({ error: 'Legacy Apple receipts are no longer accepted. Please update the app.' });
      }
      if (receipts.some(entry => !entry.jws) && !APPLE_SHARED_SECRET) {
        return res
          .status(503)
          .json({ error: 'IAP verification not configured. Please contact support.' });
      }

      const isoDateStrings: string[] = dates.map((d: any) => String(d));
      // Enforce booking horizon — no dates beyond 56 days from today
      const MAX_BOOKING_HORIZON_DAYS = 56;
      const pastHorizon = getDatesPastBookingHorizon(
        isoDateStrings,
        new Date(),
        MAX_BOOKING_HORIZON_DAYS
      );
      if (pastHorizon.length > 0) {
        return res.status(400).json({
          error: `Dates must be within ${MAX_BOOKING_HORIZON_DAYS} days from today`,
          dates: pastHorizon,
        });
      }

      const ad = await prisma.ad.findUnique({ where: { id: String(ad_id) } });
      if (!ad) return res.status(404).json({ error: 'Ad not found' });
      if (ad.user_id !== userId) return res.status(403).json({ error: 'Not authorized' });
      if (ad.status !== 'approved' && ad.status !== 'active' && ad.status !== 'archived') {
        return res.status(403).json({ error: 'Ad must be approved before payment' });
      }

      const expectedPricing = calculateAdPriceCents(dates);
      let verifiedCents = 0;
      const appleTransactionIds: string[] = [];

      for (const r of receipts) {
        const { jws, receipt, productId } = r;
        if (
          (!jws && !receipt) ||
          !productId ||
          !(APPLE_AD_PRODUCTS as readonly string[]).includes(productId)
        ) {
          return res.status(400).json({ error: `Invalid receipt: unknown product ${productId}` });
        }
        if (!jws && process.env.NODE_ENV === 'production') {
          return res.status(400).json({
            error: 'Legacy Apple receipts are no longer accepted. Please update the app.',
          });
        }
        const unitCents = AD_PRODUCT_CENTS[productId];
        if (!unitCents) return res.status(400).json({ error: `Unknown ad product: ${productId}` });

        let purchasedQty: number;
        let transactionId: string;
        if (jws) {
          let signedTransaction: any;
          try {
            signedTransaction = await verifyAppleSignedJws(jws);
          } catch (error: any) {
            console.error('[payments] Apple JWS verification failed (ad):', error?.message);
            captureException(error, { context: 'apple_jws_verify_ad' });
            return res.status(400).json({ error: 'Invalid Apple transaction signature' });
          }
          // A valid Apple signature also authenticates refunds/revocations; it
          // does not mean that the transaction can still fund a new booking.
          const signedAd = appleAdTransactionSchema.safeParse(signedTransaction);
          if (!signedAd.success) {
            captureException(new Error('Invalid signed Apple ad payment data'), {
              context: 'apple_ad_receipt_boundary',
              failure_code:
                signedTransaction.revocationDate !== undefined
                  ? 'REVOKED_TRANSACTION'
                  : 'INVALID_SIGNED_TRANSACTION',
            });
            return sendError(res, 400, 'This Apple transaction cannot fund an ad booking', {
              code: 'INVALID_SIGNED_AD_TRANSACTION',
            });
          }
          if (signedTransaction.appAccountToken) {
            const token = z.string().uuid().safeParse(signedTransaction.appAccountToken);
            if (
              token.success &&
              (await prisma.adPurchaseIntent.findUnique({
                where: { id: token.data },
                select: { id: true },
              }))
            ) {
              return sendError(res, 409, 'Continue this purchase through its saved intent', {
                code: 'PURCHASE_INTENT_REQUIRED',
              });
            }
          }
          const signedProductId = signedAd.data.productId;
          if (signedProductId !== productId) {
            return res
              .status(400)
              .json({ error: 'Signed Apple transaction does not match requested product' });
          }
          purchasedQty = signedAd.data.quantity;
          transactionId = signedAd.data.transactionId;
        } else {
          let result = await verifyAppleReceipt(receipt!, false);
          if (result.status === 21007) result = await verifyAppleReceipt(receipt!, true);
          if (result.status !== 0) {
            return res
              .status(400)
              .json({ error: 'Receipt verification failed', appleStatus: result.status });
          }

          const inApp = result.receipt?.in_app || [];
          const matching = inApp.filter((t: any) => t.product_id === productId);
          if (matching.length === 0) {
            return res.status(400).json({
              error: 'No matching transactions in receipt for product',
              product_id: productId,
            });
          }
          purchasedQty = parseInt(matching[0]?.quantity || '1', 10) || 1;

          transactionId = String(
            matching[0]?.transaction_id || matching[0]?.original_transaction_id || ''
          ).trim();
        }
        if (!transactionId) {
          return sendError(res, 400, 'Missing Apple transaction ID in receipt', {
            code: 'APPLE_TRANSACTION_ID_REQUIRED',
          });
        }
        // Settlement deduplicates claims. Valuation must use the same identity
        // boundary so repeating a receipt cannot pay for a larger booking.
        if (appleTransactionIds.includes(transactionId)) continue;
        appleTransactionIds.push(transactionId);
        verifiedCents += unitCents * purchasedQty;
      }

      if (verifiedCents < expectedPricing.totalCents) {
        return res.status(400).json({ error: 'Receipt total does not match expected amount' });
      }

      if (ad.target_zip_code) {
        const fullDates = await getFullAdSlotDates(prisma, {
          adId: String(ad_id),
          targetZipCode: ad.target_zip_code,
          isoDates: dates,
        });
        if (fullDates.length > 0) {
          return res.status(409).json({
            error: 'One or more dates are fully booked',
            dates: fullDates,
          });
        }
      }

      // SECURITY: Only activate ads that have been approved by admin
      if (ad.status !== 'approved' && ad.status !== 'active' && ad.status !== 'archived') {
        return res
          .status(403)
          .json({ error: 'Ad must be approved before payment', current_status: ad.status });
      }

      try {
        await ensureApplePendingTransactionLog({
          transactionType: 'AD_PURCHASE',
          userId,
          userEmail: ad.contact_email || null,
          orderId: String(ad_id),
          appleTransactionId: appleTransactionIds.length === 1 ? appleTransactionIds[0] : null,
          metadata: {
            source: 'apple_iap',
            ad_id: String(ad_id),
            dates,
            receipts_count: receipts.length,
            apple_transaction_ids: normalizeAppleTransactionIds(appleTransactionIds),
          },
        });

        const finalizeResult = await finalizeAppleAdPurchase({
          userId,
          userEmail: ad.contact_email,
          adId: String(ad_id),
          dates,
          appleTransactionIds,
          receiptsCount: receipts.length,
        });
        debugLog('apple-iap-ad', `User ${userId} paid for ad ${ad_id} via Apple IAP`);
        return res.json(finalizeResult);
      } catch (error: any) {
        if (error?.statusCode && error?.body) {
          return res.status(error.statusCode).json(error.body);
        }
        if (isUniqueConstraintError(error, 'apple_transaction_id')) {
          return res.status(409).json({
            error: 'APPLE_TRANSACTION_ALREADY_CLAIMED',
            message:
              'One or more Apple purchase receipts were already used by a different purchase.',
          });
        }
        throw error;
      }
    } catch (err: any) {
      console.error('[apple-iap] verify-ad-receipt error:', err);
      captureException(err, { context: 'apple-iap-verify-ad', provider: 'apple_iap' });
      return res.status(500).json({ error: 'Receipt verification failed' });
    }
  })
);

// ── Apple Server-to-Server (S2S) Notifications V2 ──────────────────
// Apple sends JWS-signed payloads for subscription lifecycle events.
// Configure this URL in App Store Connect → App → App Store Server Notifications.
paymentsRouter.post(
  ['/apple/notifications', '/apple/server-notifications'],
  expressPkg.json(),
  asyncHandler(async (req, res) => {
    try {
      const { signedPayload } = req.body || {};
      if (!signedPayload) {
        console.warn('[apple-s2s] Missing signedPayload');
        return res.sendStatus(200); // Always 200 to Apple
      }

      let payload: any;
      try {
        payload = await verifyAppleNotificationJws(signedPayload);
      } catch {
        return sendError(res, 403, 'Invalid Apple notification signature', {
          code: 'INVALID_APPLE_SIGNATURE',
        });
      }

      if (!payload) {
        console.error('[apple-s2s] Decoded payload is null');
        return res.sendStatus(503);
      }

      // Step 7: Validate payload claims — bundleId and environment
      const EXPECTED_BUNDLE_ID = process.env.APPLE_BUNDLE_ID || 'com.varsithub.varsityhub-ios';
      const data = payload.data || {};
      const notificationType: string = payload.notificationType || '';
      const subtype: string = payload.subtype || '';
      const notificationUUID: string = payload.notificationUUID || '';

      // Verify bundleId matches our app (prevents cross-app replay)
      if (data.bundleId && data.bundleId !== EXPECTED_BUNDLE_ID) {
        console.error(
          '[apple-s2s] bundleId mismatch:',
          data.bundleId,
          'expected:',
          EXPECTED_BUNDLE_ID
        );
        return res.status(403).json({ error: 'Bundle ID mismatch' });
      }

      const environment: string = data.environment || payload.environment || 'Production';
      if (environment !== 'Sandbox' && environment !== 'Production') {
        console.warn('[apple-s2s] Unexpected Apple notification environment:', environment);
      }

      // A verified outer envelope cannot authorize unverified inner transaction data.
      let transactionInfo: any = {};
      let renewalInfo: any = {};
      try {
        if (data.signedTransactionInfo)
          transactionInfo = await verifyAppleSignedJws(data.signedTransactionInfo);
        if (data.signedRenewalInfo)
          renewalInfo = await verifyAppleRenewalJws(data.signedRenewalInfo);
      } catch {
        return sendError(res, 403, 'Invalid Apple notification contents', {
          code: 'INVALID_APPLE_SIGNATURE',
        });
      }

      const appleTransactionId: string = transactionInfo.transactionId || '';
      const originalTransactionId: string = transactionInfo.originalTransactionId || '';
      const productId: string = transactionInfo.productId || '';
      const expiresDate: number = transactionInfo.expiresDate || 0; // ms timestamp

      debugLog('[apple-s2s] Notification received:', {
        notificationUUID: redactIdentifier(notificationUUID),
        notificationType,
        subtype,
        originalTransactionId: redactIdentifier(originalTransactionId),
        productId,
        environment,
      });

      if (notificationType === 'ONE_TIME_CHARGE' && APPLE_AD_PRODUCTS.includes(productId as any)) {
        const token = z.string().uuid().safeParse(transactionInfo.appAccountToken);
        if (!token.success || !data.signedTransactionInfo) {
          captureException(new Error('Apple ad notification has no purchase intent'), {
            context: 'ad_intent_notification_unbound',
          });
          return res.sendStatus(200); // Legacy unbound purchases remain on their existing path.
        }
        try {
          await recordAdPurchaseReceipt(undefined, token.data, data.signedTransactionInfo);
          return res.sendStatus(200);
        } catch {
          captureException(new Error('Apple ad notification recovery failed'), {
            context: 'ad_intent_notification',
            intent_id: token.data,
          });
          return res.sendStatus(503);
        }
      }

      const receiptState = await recordAppleNotificationReceipt(prisma, {
        notificationUUID,
        originalTransactionId,
        productId,
        environment,
        expiresDate,
        notificationType,
        subtype,
      }).catch(err => {
        console.error('[apple-s2s] Failed to record notification receipt:', err);
        return null;
      });

      if (receiptState === 'duplicate') {
        addBreadcrumb('Apple server notification duplicate skipped', 'payments.apple_s2s', 'info', {
          notification_type: notificationType,
          notification_uuid: redactIdentifier(notificationUUID),
        });
        return res.sendStatus(200);
      }

      if (receiptState === 'missing_uuid') {
        // Without a notificationUUID we cannot deduplicate — processing it risks
        // applying the same lifecycle event multiple times on repeated delivery.
        // Return 200 to acknowledge receipt; Apple will not retry a 200 response.
        console.warn(
          '[apple-s2s] Missing notificationUUID — acknowledging without processing to prevent duplicate application'
        );
        captureException(new Error('apple-s2s: missing notificationUUID'), {
          context: 'apple_s2s_missing_uuid',
          notificationType,
        });
        return res.sendStatus(200);
      }

      if (receiptState === null) {
        // The dedup WRITE itself failed (transient DB error, caught above → null).
        // We can't prove this notification isn't a redelivery, so processing it
        // could double-apply a lifecycle event. Return 503 so Apple retries once
        // the dedup path recovers, rather than processing it un-deduplicated.
        console.warn('[apple-s2s] Dedup write failed — 503 for Apple retry rather than process');
        captureException(new Error('apple-s2s: dedup write failed'), {
          context: 'apple_s2s_dedup_write_failed',
          notificationType,
        });
        return res.sendStatus(503);
      }

      if (!originalTransactionId) {
        console.warn('[apple-s2s] No originalTransactionId — cannot match user');
        return res.sendStatus(200);
      }

      // Find user by apple_original_transaction_id stored in preferences JSON
      // Uses PostgreSQL JSON path query — exact match, indexed, no LIKE needed
      const matchedUser = await prisma.user.findFirst({
        where: {
          preferences: {
            path: ['apple_original_transaction_id'],
            equals: originalTransactionId,
          },
        },
        select: {
          id: true,
          preferences: true,
          plan: true,
          pending_plan: true,
          payment_pending: true,
          payment_approved: true,
        },
      });

      if (!matchedUser) {
        console.warn(
          '[apple-s2s] No user found for originalTransactionId:',
          redactIdentifier(originalTransactionId)
        );
        return res.sendStatus(200);
      }

      const userId: string = matchedUser.id;
      const prefs =
        matchedUser.preferences && typeof matchedUser.preferences === 'object'
          ? (matchedUser.preferences as any)
          : {};

      debugLog('apple-s2s', `Processing ${notificationType}/${subtype} for user ${userId}`);

      // ── Handle notification types ──
      if (notificationType === 'DID_RENEW' || notificationType === 'SUBSCRIBED') {
        // Renewal or new subscription — activate and extend expiry
        // Security audit 2026-06 #12 (P3): an unmapped product id must never silently
        // grant or downgrade a paid tier (the old fallback defaulted to 'veteran').
        // Log loudly, capture to Sentry, and leave the user's current entitlement
        // untouched. The dedup receipt recorded above makes an Apple redelivery of
        // this notification a no-op, so acknowledging with 200 is safe.
        const plan = APPLE_PRODUCT_TO_PLAN[productId];
        if (!plan) {
          console.error(
            `[payments] Apple ${notificationType} notification for unmapped productId '${productId}' — leaving user plan unchanged`,
            { userId }
          );
          captureException(new Error(`apple-s2s: unmapped productId on ${notificationType}`), {
            context: 'apple_s2s_unmapped_product',
            notificationType,
            subtype,
            productId,
          });
          return res.sendStatus(200);
        }
        const newExpiry = expiresDate
          ? new Date(expiresDate).toISOString()
          : prefs.apple_expires_date;
        const nextPrefs = mergeBillingStateIntoPreferences(
          {
            ...prefs,
            apple_expires_date: newExpiry,
            apple_original_transaction_id: originalTransactionId,
          },
          {
            plan: plan as 'veteran' | 'legend',
            pending_plan: null,
            payment_pending: false,
            payment_approved: false,
          }
        );

        await prisma.$transaction([
          // cache-invalidation-exempt: invalidateMeCacheForUser called after this transaction resolves
          prisma.user.update({
            where: { id: userId },
            data: {
              subscription_tier: plan === 'legend' ? 'pro' : 'premium',
              subscription_status: 'active',
              preferences: nextPrefs as any,
              ...buildBillingStateColumns({
                plan: plan as 'veteran' | 'legend',
                pending_plan: null,
                payment_pending: false,
                payment_approved: false,
              }),
            },
          }),
          prisma.transactionLog.create({
            data: {
              transaction_type: 'SUBSCRIPTION_RENEWAL',
              status: 'COMPLETED',
              user_id: userId,
              order_id: originalTransactionId,
              apple_transaction_id: appleTransactionId || null,
              metadata: { source: 'apple_s2s', notificationType, subtype, productId, plan },
            } as any,
          }),
        ]);
        await invalidateMeCacheForUser(userId);
        debugLog('apple-s2s', `User ${userId} renewed/subscribed — plan: ${plan}`);
      } else if (
        notificationType === 'DID_FAIL_TO_RENEW' ||
        notificationType === 'GRACE_PERIOD' ||
        subtype === 'GRACE_PERIOD'
      ) {
        // v1.0.2 pass 8: previously we marked past_due but never recorded WHEN the grace period
        // expires. If Apple's EXPIRED notification was lost (network failure, missed delivery),
        // the user kept Premium access indefinitely. Now we record an explicit cutoff so a
        // safety net check (in requireOnboarded or middleware) can downgrade users whose
        // grace period has elapsed without an EXPIRED arriving.
        const APPLE_GRACE_PERIOD_MS = 16 * 24 * 60 * 60 * 1000; // Apple billing grace ≈ 16 days
        const graceExpiresAt = new Date(Date.now() + APPLE_GRACE_PERIOD_MS);
        const updatedPrefs = { ...prefs, grace_period_expires_at: graceExpiresAt.toISOString() };
        await prisma.$transaction([
          // cache-invalidation-exempt: invalidateMeCacheForUser called after this transaction resolves
          prisma.user.update({
            where: { id: userId },
            data: {
              subscription_status: 'past_due',
              preferences: updatedPrefs,
            },
          }),
          prisma.transactionLog.create({
            data: {
              transaction_type: 'SUBSCRIPTION_RENEWAL_FAILED',
              status: 'FAILED',
              user_id: userId,
              order_id: originalTransactionId,
              metadata: {
                source: 'apple_s2s',
                notificationType,
                subtype,
                grace_expires_at: graceExpiresAt.toISOString(),
              },
            },
          }),
        ]);
        await invalidateMeCacheForUser(userId);
        console.warn('[apple-s2s] Marked user as past_due with grace period expiry:', {
          userId,
          graceExpiresAt,
        });
      } else if (
        notificationType === 'EXPIRED' ||
        notificationType === 'GRACE_PERIOD_EXPIRED' ||
        notificationType === 'REVOKE' ||
        notificationType === 'REFUND'
      ) {
        // Expired, revoked, or refunded — downgrade to rookie
        const previousPlan = getCanonicalPlan(matchedUser as any);
        const downgradedPrefs = { ...prefs };
        delete downgradedPrefs.apple_product_id;
        delete downgradedPrefs.apple_expires_date;
        // Keep apple_original_transaction_id for audit trail
        const nextPrefs = mergeBillingStateIntoPreferences(downgradedPrefs, {
          plan: 'rookie',
          pending_plan: null,
          payment_pending: false,
          payment_approved: false,
        });

        await prisma.$transaction([
          // cache-invalidation-exempt: invalidateMeCacheForUser called after this transaction resolves
          prisma.user.update({
            where: { id: userId },
            data: {
              subscription_tier: 'free',
              subscription_status: 'canceled',
              preferences: nextPrefs as any,
              ...buildBillingStateColumns({
                plan: 'rookie',
                pending_plan: null,
                payment_pending: false,
                payment_approved: false,
              }),
            },
          }),
          prisma.transactionLog.create({
            data: {
              transaction_type: 'SUBSCRIPTION_CANCEL',
              status: 'COMPLETED',
              user_id: userId,
              order_id: originalTransactionId,
              metadata: {
                source: 'apple_s2s',
                notificationType,
                subtype,
                reason: notificationType.toLowerCase(),
                previous_plan: previousPlan,
              },
            } as any,
          }),
        ]);
        await invalidateMeCacheForUser(userId);
        debugLog('apple-s2s', `User ${userId} downgraded to rookie — reason: ${notificationType}`);
      } else {
        debugLog(
          'apple-s2s',
          `Unhandled notification type: ${notificationType}/${subtype} for user ${userId}`
        );
      }

      return res.sendStatus(200);
    } catch (err: any) {
      console.error('[apple-s2s] Error processing notification:', err);
      captureException(err, { context: 'apple-s2s-notification', provider: 'apple_iap' });
      // Return 500 so Apple retries DB/processing failures. Signature and
      // validation errors are caught earlier and return 200/403 directly.
      return res.sendStatus(500);
    }
  })
);

// ── Google Play Billing verification ────────────────────────────────
// Security audit 2026-06 #4 (P2): the unverified-fallback flag is a hard no-op in
// production — resolveGooglePlayUnverifiedFallback() ignores it (with a console.warn)
// when NODE_ENV === 'production', so this constant is always false in prod and the
// no-credentials path below fails closed with 503. This supersedes the old M3 block
// that crashed the server at boot when the flag was set in prod without credentials.
const GOOGLE_PLAY_ALLOW_UNVERIFIED_FALLBACK = resolveGooglePlayUnverifiedFallback(process.env);
const GOOGLE_PLAY_STRICT_VERIFY = process.env.GOOGLE_PLAY_STRICT_VERIFY === '1';

// Google Play purchase verification
paymentsRouter.post(
  '/google/verify-purchase',
  expressPkg.json(),
  requireVerified as any,
  paymentLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: 'AUTH_REQUIRED' });
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { preferences: true, email: true, paid_by_owner: true },
      });
      if (user?.paid_by_owner === true) {
        return res.status(403).json({ error: OWNER_MANAGED_SUBSCRIPTION_ERROR });
      }

      const googlePurchaseSchema = z.object({
        purchase_token: z.string().min(16, 'Invalid purchase_token'),
        product_id: z.string().min(1),
        package_name: z.string().optional(),
      });
      const parsed = googlePurchaseSchema.safeParse(req.body || {});
      if (!parsed.success)
        return res
          .status(400)
          .json({ error: 'Invalid payload', details: parsed.error.flatten().fieldErrors });
      const { purchase_token, product_id, package_name } = parsed.data;

      const plan = GOOGLE_PRODUCT_TO_PLAN[product_id];
      if (!plan) {
        return res.status(400).json({ error: `Unknown product: ${product_id}` });
      }

      if (process.env.NODE_ENV === 'production') {
        if (!package_name) {
          return res.status(400).json({ error: 'Missing package_name' });
        }
        if (
          GOOGLE_ALLOWED_PACKAGES.length > 0 &&
          !GOOGLE_ALLOWED_PACKAGES.includes(String(package_name))
        ) {
          return res.status(400).json({ error: 'Package mismatch for Google Play purchase' });
        }
      }

      const orderId = getGooglePurchaseOrderId(purchase_token);
      const legacyOrderId = String(purchase_token).substring(0, 40);
      const existingCompletedPurchase = await prisma.transactionLog.findFirst({
        where: {
          order_id: { in: [orderId, legacyOrderId] },
          transaction_type: 'SUBSCRIPTION_PURCHASE',
          status: 'COMPLETED',
        } as any,
        select: { id: true, user_id: true },
      });
      if (existingCompletedPurchase) {
        if (existingCompletedPurchase.user_id === userId) {
          return res.json({ ok: true, plan, idempotent: true, verified: false });
        }
        return res.status(409).json({ error: 'Purchase token already used by another account' });
      }

      const packageForVerification = String(
        package_name || GOOGLE_ALLOWED_PACKAGES[0] || ''
      ).trim();
      let verifiedByStore = false;
      let verificationMode: 'google_play_api' | 'client_fallback' = 'client_fallback';
      let googleExpiresAtIso: string | null = null;
      if (hasGooglePlayVerifierConfig()) {
        const verifyResult = await verifyGooglePurchaseWithPlayApi({
          packageName: packageForVerification,
          productId: String(product_id),
          purchaseToken: String(purchase_token),
        });
        if (!verifyResult.verified) {
          return res.status(400).json({
            error: 'Google Play purchase verification failed',
            reason: verifyResult.reason,
          });
        }
        verifiedByStore = true;
        verificationMode = 'google_play_api';
        // Persist the store-reported expiry so the entitlement can actually
        // expire server-side (see subscription.ts expiry chain + the Google
        // reconciliation job). Previously this value was computed and discarded.
        googleExpiresAtIso = verifyResult.expiresAt ?? null;
      } else if (
        GOOGLE_PLAY_STRICT_VERIFY ||
        (process.env.NODE_ENV === 'production' && !GOOGLE_PLAY_ALLOW_UNVERIFIED_FALLBACK)
      ) {
        return res.status(503).json({ error: 'Google Play verification not configured on server' });
      } else {
        console.warn(
          '[google-iap] Proceeding without Play API verification (fallback mode enabled)'
        );
      }

      // Update user's plan in database
      const currentPrefs =
        user?.preferences && typeof user.preferences === 'object' ? (user.preferences as any) : {};

      // Clear pending flags after successful payment (same as Apple flow)
      const {
        payment_pending,
        payment_approved,
        pending_plan,
        join_request_pending,
        ...restPrefs
      } = currentPrefs;
      const nextPrefs = mergeBillingStateIntoPreferences(
        {
          ...restPrefs,
          google_purchase_token: purchase_token,
          google_product_id: product_id,
          subscription_platform: 'google',
          ...(googleExpiresAtIso ? { google_expires_date: googleExpiresAtIso } : {}),
        },
        {
          plan: plan as 'veteran' | 'legend',
          pending_plan: null,
          payment_pending: false,
          payment_approved: false,
        }
      );

      await prisma.$transaction([
        // cache-invalidation-exempt: invalidateMeCacheForUser called after this transaction resolves
        prisma.user.update({
          where: { id: userId },
          data: {
            subscription_tier: plan === 'legend' ? 'pro' : 'premium',
            subscription_status: 'active',
            preferences: nextPrefs as any,
            ...buildBillingStateColumns({
              plan: plan as 'veteran' | 'legend',
              pending_plan: null,
              payment_pending: false,
              payment_approved: false,
            }),
          },
        }),
        prisma.transactionLog.create({
          data: {
            transaction_type: 'SUBSCRIPTION_PURCHASE',
            status: 'COMPLETED',
            user_id: userId,
            order_id: orderId,
            metadata: {
              source: 'google_play',
              product_id,
              plan,
              package_name,
              verified_by_store: verifiedByStore,
              verification_mode: verificationMode,
            },
          } as any,
        }),
      ]);
      await invalidateMeCacheForUser(userId);

      debugLog('google-iap', `User ${userId} subscribed to ${plan} via Google Play Billing`);

      return res.json({ ok: true, plan, verified: verifiedByStore });
    } catch (err: any) {
      console.error('[google-iap] verify-purchase error:', err);
      captureException(err, { context: 'google-iap-verify', provider: 'google_iap' });
      return res.status(500).json({ error: 'Verification failed' });
    }
  })
);

paymentsRouter.get('/cancel', (_req, res) => {
  const appScheme = process.env.APP_SCHEME || 'varsityhubmobile';
  const appReturnPath = process.env.APP_RETURN_PATH || '';
  const returnUrl = `${appScheme}://${appReturnPath}`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Payment Canceled</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial, sans-serif; background: #f8fafc; color: #0f172a; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
      .box { background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; padding: 20px; max-width: 520px; box-shadow: 0 6px 20px rgba(2,6,23,0.06); text-align: center; }
      .title { font-size: 20px; font-weight: 800; margin-bottom: 6px; }
      .muted { color: #64748b; }
      .btn { display: inline-block; margin-top: 12px; padding: 10px 14px; border-radius: 10px; background: #111827; color: #fff; font-weight: 800; text-decoration: none; }
    </style>
  </head>
  <body>
    <div class="box">
      <div class="title">Payment canceled</div>
      <div class="muted">Your payment was canceled. You may return to the app to try again.</div>
      <a href="${returnUrl}" class="btn">Return to app</a>
      <br/>
      <a href="#" class="btn" onclick="window.close(); return false;">Close</a>
    </div>
    <script>
      setTimeout(function(){ try { window.location = '${returnUrl}'; } catch (e) {} }, 400);
    </script>
  </body>
</html>`);
});

// Test-only internals for finalize-session verification.
export const __paymentsInternal = {
  finalizeFromSession,
  runFinalizeFromSession,
  finalizeAppleSubscriptionPurchase,
  finalizeAppleAdPurchase,
  getVeteranBillingSnapshot,
  releaseAdInventoryAfterSlotFullRefund,
  releaseAdInventoryAfterSlotFullRefundWithRetry,
};
