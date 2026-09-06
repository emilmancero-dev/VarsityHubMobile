/**
 * Apple IAP reconciliation + recovery.
 *
 * Without App Store Server API credentials we still cannot poll Apple
 * for purchases the app never reported to us. What we *can* recover is
 * the narrower local-orphan case:
 *   1. Receipt verification reached our server
 *   2. We persisted a PENDING transaction row
 *   3. Finalization failed before user/ad state was committed
 *
 * This job replays those stale local rows through the same canonical
 * Apple finalize helpers used by the live verify endpoints.
 *
 * It still retains the Apple S2S dry-spell probe so we notice when the
 * App Store server notification webhook goes dark.
 */

import { prisma } from './prisma.js';
import { captureException, captureMessage } from './sentry.js';
import { APPLE_PRODUCT_TO_PLAN } from './paymentInternals.js';

const PENDING_STALE_THRESHOLD_MIN = 30;
const NOTIFICATION_DRYSPELL_HOURS = 24;
const STUCK_ROW_REPORT_LIMIT = 50;
// Derived inverse of the canonical APPLE_PRODUCT_TO_PLAN so the plan→product
// direction can never drift from product→plan when a SKU is renamed.
const APPLE_PLAN_TO_PRODUCT: Record<string, string> = Object.fromEntries(
  Object.entries(APPLE_PRODUCT_TO_PLAN).map(([product, plan]) => [plan, product])
);

export type AppleIapReconciliationResult = {
  stuckPending: number;
  recovered: number;
  recoveryFailed: number;
  manualReviewNeeded: number;
  s2sNotificationsLast24h: number;
  notificationDrySpell: boolean;
  durationMs: number;
};

function readString(value: unknown) {
  const normalized = String(value ?? '').trim();
  return normalized.length > 0 ? normalized : null;
}

function readStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map(entry => String(entry ?? '').trim()).filter(Boolean);
}

export async function reconcileAppleIapOrphans(): Promise<AppleIapReconciliationResult> {
  const startedAt = Date.now();
  const pendingCutoff = new Date(Date.now() - PENDING_STALE_THRESHOLD_MIN * 60 * 1000);
  const dryspellCutoff = new Date(Date.now() - NOTIFICATION_DRYSPELL_HOURS * 60 * 60 * 1000);
  const recentSubscriptionActivityCutoff = dryspellCutoff;
  const paymentInternals = await import('./paymentInternals.js');

  // Recover stale, locally-visible Apple purchases. Excludes APPLE_S2S_NOTIFICATION
  // rows because those are dedup markers, not user-facing purchases.
  const stuck = await prisma.transactionLog.findMany({
    where: {
      status: 'PENDING',
      created_at: { lt: pendingCutoff },
      transaction_type: { in: ['SUBSCRIPTION_PURCHASE', 'AD_PURCHASE'] },
      // Filter by payment rail BEFORE taking the bounded batch. Otherwise 50
      // abandoned Stripe checkouts permanently starve every later Apple orphan
      // and emit misleading Apple manual-review alerts for Stripe purchases.
      stripe_session_id: null,
      stripe_payment_intent_id: null,
      OR: [
        { apple_transaction_id: { not: null } },
        ...['apple_iap', 'apple_iap_jws', 'apple_iap_receipt'].map(source => ({
          metadata: { path: ['source'], equals: source },
        })),
      ],
    },
    select: {
      id: true,
      apple_transaction_id: true,
      transaction_type: true,
      user_id: true,
      user_email: true,
      total_cents: true,
      created_at: true,
      order_id: true,
      metadata: true,
      updated_at: true,
    },
    orderBy: [{ updated_at: 'asc' }, { id: 'asc' }],
    take: STUCK_ROW_REPORT_LIMIT,
  });

  let recovered = 0;
  let recoveryFailed = 0;
  let manualReviewNeeded = 0;

  for (const row of stuck) {
    const ageMin = Math.round((Date.now() - row.created_at.getTime()) / 60000);
    const meta =
      row.metadata && typeof row.metadata === 'object'
        ? (row.metadata as Record<string, unknown>)
        : {};
    const requireReview = async (reason: string) => {
      // Do not overwrite fresh evidence or a completion from another worker.
      const result = await prisma.transactionLog.updateMany({
        where: { id: row.id, status: 'PENDING', updated_at: row.updated_at },
        data: { status: 'NEEDS_REVIEW', metadata: { ...meta, recovery_reason: reason } as any },
      });
      return result.count > 0;
    };

    try {
      if (row.transaction_type === 'SUBSCRIPTION_PURCHASE') {
        const productId =
          readString(meta.productId) ||
          (readString(meta.plan) ? APPLE_PLAN_TO_PRODUCT[String(meta.plan)] || null : null);
        const source = readString(meta.source) || 'apple_iap_reconciliation';
        const expiresAtIso = readString(meta.apple_expires_date);

        if (!row.user_id || !row.order_id || !productId) {
          if (!(await requireReview('missing_subscription_metadata'))) continue;
          manualReviewNeeded++;
          captureMessage(
            'Apple IAP reconciliation could not auto-recover subscription purchase',
            'error',
            {
              context: 'apple_iap_reconciliation_manual_review',
              transaction_log_id: row.id,
              transaction_type: row.transaction_type,
              user_id: row.user_id,
              order_id: row.order_id,
              apple_transaction_id: row.apple_transaction_id,
              age_minutes: ageMin,
              reason: 'missing_subscription_metadata',
            }
          );
          continue;
        }

        await paymentInternals.finalizeAppleSubscriptionPurchase({
          userId: row.user_id,
          userEmail: row.user_email,
          productId,
          originalTransactionId: row.order_id,
          appleTransactionId: row.apple_transaction_id,
          expiresAtIso,
          source: `${source}_reconciliation`,
        });
      } else {
        const dates = readStringArray(meta.dates);
        const appleTransactionIds = Array.from(
          new Set(
            [
              ...readStringArray(meta.apple_transaction_ids),
              ...readStringArray(meta.appleTransactionIds),
              ...[readString(row.apple_transaction_id)],
            ].filter(Boolean) as string[]
          )
        ).sort();
        const receiptsCount =
          Number(meta.receipts_count ?? appleTransactionIds.length) || appleTransactionIds.length;

        if (
          !row.user_id ||
          !row.order_id ||
          dates.length === 0 ||
          appleTransactionIds.length === 0
        ) {
          if (!(await requireReview('missing_ad_metadata'))) continue;
          manualReviewNeeded++;
          captureMessage('Apple IAP reconciliation could not auto-recover ad purchase', 'error', {
            context: 'apple_iap_reconciliation_manual_review',
            transaction_log_id: row.id,
            transaction_type: row.transaction_type,
            user_id: row.user_id,
            order_id: row.order_id,
            apple_transaction_id: row.apple_transaction_id,
            age_minutes: ageMin,
            reason: 'missing_ad_metadata',
          });
          continue;
        }

        await paymentInternals.finalizeAppleAdPurchase({
          userId: row.user_id,
          userEmail: row.user_email,
          adId: row.order_id,
          dates,
          appleTransactionIds,
          receiptsCount,
        });
      }

      recovered++;
      captureMessage('Apple IAP reconciliation auto-recovered stuck purchase', 'warning', {
        context: 'apple_iap_reconciliation_recovered',
        transaction_log_id: row.id,
        transaction_type: row.transaction_type,
        user_id: row.user_id,
        order_id: row.order_id,
        apple_transaction_id: row.apple_transaction_id,
        age_minutes: ageMin,
      });
      console.warn(
        `[apple-iap-reconcile] RECOVERED ${row.transaction_type} txlog=${row.id} apple_tx=${row.apple_transaction_id ?? '-'} age=${ageMin}min`
      );
    } catch (error) {
      recoveryFailed++;
      captureException(error instanceof Error ? error : new Error(String(error)), {
        context: 'apple_iap_reconciliation_recovery_failed',
        transaction_log_id: row.id,
        transaction_type: row.transaction_type,
        user_id: row.user_id,
        order_id: row.order_id,
        apple_transaction_id: row.apple_transaction_id,
        age_minutes: ageMin,
      });
      console.error(
        `[apple-iap-reconcile] FAILED ${row.transaction_type} txlog=${row.id} apple_tx=${row.apple_transaction_id ?? '-'} age=${ageMin}min`,
        error
      );
      // Keep transient failures retryable but rotate them behind other pending
      // purchases. Failure to record the attempt must not hide the original error.
      await prisma.transactionLog
        .updateMany({
          where: { id: row.id, status: 'PENDING', updated_at: row.updated_at },
          data: { updated_at: new Date() },
        })
        .catch(() => {
          captureException(new Error('Apple reconciliation attempt could not be recorded'), {
            context: 'apple_iap_reconciliation_attempt_write',
            transaction_log_id: row.id,
          });
        });
    }
  }

  // Probe B — Apple S2S notification dry-spell.
  const s2sCount = await prisma.transactionLog.count({
    where: {
      transaction_type: 'APPLE_S2S_NOTIFICATION',
      created_at: { gte: dryspellCutoff },
    },
  });

  const recentAppleSubscriptionActivity = await prisma.transactionLog.count({
    where: {
      transaction_type: 'SUBSCRIPTION_PURCHASE',
      created_at: { gte: recentSubscriptionActivityCutoff },
      apple_transaction_id: { not: null },
    },
  });

  const notificationDrySpell = s2sCount === 0 && recentAppleSubscriptionActivity > 0;
  if (notificationDrySpell) {
    captureMessage(
      `No Apple S2S notifications received in last ${NOTIFICATION_DRYSPELL_HOURS}h — webhook URL may be misconfigured`,
      'error',
      {
        context: 'apple_iap_reconciliation_notification_dryspell',
        lookback_hours: NOTIFICATION_DRYSPELL_HOURS,
        notifications_seen: s2sCount,
        recent_apple_subscription_activity: recentAppleSubscriptionActivity,
      }
    );
    console.error(
      `[apple-iap-reconcile] DRYSPELL no APPLE_S2S_NOTIFICATION rows in last ${NOTIFICATION_DRYSPELL_HOURS}h — check App Store Connect webhook URL`
    );
  }

  const durationMs = Date.now() - startedAt;
  console.log(
    `[apple-iap-reconcile] stuck_pending=${stuck.length} recovered=${recovered} recovery_failed=${recoveryFailed} manual_review=${manualReviewNeeded} s2s_24h=${s2sCount} dryspell=${notificationDrySpell} duration_ms=${durationMs}`
  );

  return {
    stuckPending: stuck.length,
    recovered,
    recoveryFailed,
    manualReviewNeeded,
    s2sNotificationsLast24h: s2sCount,
    notificationDrySpell,
    durationMs,
  };
}
