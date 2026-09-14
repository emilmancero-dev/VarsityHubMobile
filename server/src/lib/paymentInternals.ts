import { AppError } from './errors/AppError.js';
import type { AdStatus, Prisma } from '@prisma/client';
import type { Stripe } from 'stripe';
import { debugLog } from './debugLog.js';
import { AD_GEOFENCE_RADIUS_MILES, getAdBoundingBoxDegrees } from './adGeofencing.js';
import { getZipCoordinates, haversineDistance } from './geoUtils.js';
import {
  SERVER_ROOKIE_PROGRAM_LIMIT,
  SERVER_ROOKIE_TEAM_LIMIT,
  SERVER_VETERAN_MIN_TOTAL_TEAMS,
} from './planDefinitions.js';
import { getMaxTeamsForPlan } from './planLimits.js';
import { prisma } from './prisma.js';
import { captureException, captureMessage } from './sentry.js';
import { buildBillingStateColumns, mergeBillingStateIntoPreferences } from './userBillingState.js';
import { invalidateMeCacheForUser } from './userCache.js';
import { WEEKDAY_BLOCK_PRICE_CENTS, WEEKEND_BLOCK_PRICE_CENTS } from '../utils/adPricing.js';
const MAX_AD_SLOTS = 2;
// Two ads' 9km geofence circles "touch" when their zip centroids are within
// 2x the radius of each other. Owner "commandments" rule (2026-09-14): "make
// sure they aren't touching neighboring radiuses for fairness" — the 2-slot
// cap must span any zip whose ad radius would overlap this one's, not just
// an exact zip-code match.
const NEIGHBORING_RADIUS_TOUCH_MILES = AD_GEOFENCE_RADIUS_MILES * 2;
const isJestRuntime = process.env.JEST_WORKER_ID != null;

/**
 * Encode ISO date strings into a compact format safe for Stripe's 500-char metadata limit.
 * 56 dates × 7 chars = 392 chars max — well under the 500-char limit.
 * Format: "YYMMDD,YYMMDD,..." e.g. "240315,240316"
 */
export function encodeAdDates(isoDates: string[]): string {
  return isoDates.map(d => d.replace(/-/g, '').slice(2)).join(',');
}

/**
 * Decode ad dates from Stripe metadata. Backward-compatible:
 * - Compact format: "240315,240316" (new, post-fix sessions)
 * - JSON array:     '["2024-03-15","2024-03-16"]' (legacy, in-flight sessions pre-fix)
 */
export function decodeAdDates(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const s = String(raw).trim();
  if (s.startsWith('[')) {
    try {
      return JSON.parse(s);
    } catch {
      return [];
    }
  }
  return s
    .split(',')
    .filter(Boolean)
    .map(d => `20${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4, 6)}`);
}

const formatUsd = (cents?: number | null) => {
  if (typeof cents !== 'number' || Number.isNaN(cents)) return '';
  return `$${(cents / 100).toFixed(2)}`;
};

let stripePromise: Promise<Stripe> | null = null;

async function getStripe(): Promise<Stripe> {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  // Fail loud with one clear cause instead of constructing a client with a fake
  // placeholder key — the old `|| 'sk_test_not_configured'` fallback turned a
  // missing/placeholder key into hundreds of opaque "Invalid API Key provided:
  // sk_test_…" errors from Stripe on every downstream call.
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY is not configured — cannot initialize Stripe client');
  }
  if (!stripePromise) {
    stripePromise = import('stripe').then(
      ({ default: StripeCtor }) =>
        new StripeCtor(secretKey, {
          apiVersion: '2024-06-20',
          timeout: 20000,
          maxNetworkRetries: 2,
        })
    );
  }
  return stripePromise;
}

async function getEmailFns() {
  const mod = await import('./email.js');
  return {
    sendAdPaymentConfirmedEmail: mod.sendAdPaymentConfirmedEmail,
    sendBillingNoticeEmail: mod.sendBillingNoticeEmail,
  };
}

async function getTransactionLoggerFns() {
  const mod = await import('./transactionLogger.js');
  return {
    getTransactionBySession: mod.getTransactionBySession,
    updateTransactionStatus: mod.updateTransactionStatus,
  };
}

async function getPromoFns() {
  const mod = await import('./promos.js');
  return { redeemPromo: mod.redeemPromo };
}

async function getUserEmail(userId?: string | null, fallbackEmail?: string | null) {
  if (fallbackEmail && fallbackEmail.includes('@')) return fallbackEmail;
  if (!userId) return null;
  const user = await prisma.user.findUnique({
    where: { id: String(userId) },
    select: { email: true },
  });
  return user?.email || null;
}

export async function sendAdPaymentEmail({
  userId,
  fallbackEmail,
  contactEmail,
  adId,
  dates,
  totalCents,
  businessName,
  zipCode,
}: {
  userId?: string | null;
  fallbackEmail?: string | null;
  contactEmail?: string | null;
  adId: string;
  dates: string[];
  totalCents?: number | null;
  businessName?: string | null;
  zipCode?: string | null;
}) {
  // Recipient: the advertiser's account email, falling back to the ad's own
  // contact_email. Ad.user_id is nullable (onDelete: SetNull) and web/guest
  // advertisers may have no linked account, so account email can be absent —
  // contact_email (entered at booking) is then the only address we have.
  const accountEmail = await getUserEmail(userId, fallbackEmail);
  const email =
    accountEmail || (contactEmail && contactEmail.includes('@') ? contactEmail.trim() : null);
  if (!email) {
    // Previously a silent return — the invisible failure behind "advertiser got
    // no receipt". Surface it so the next occurrence is diagnosable.
    const msg = `[payments] Ad payment receipt skipped — no recipient email (adId=${adId}, userId=${userId ?? 'none'})`;
    console.warn(msg);
    captureMessage(msg, 'warning', { context: 'ad_receipt_no_recipient', provider: 'sendgrid' });
    return;
  }
  const amount = formatUsd(totalCents);

  let hoursLabel = '';
  let hoursRemaining = 0;
  const totalHoursBooked = dates.length * 24;
  if (dates.length) {
    const sorted = [...dates].sort();
    const lastEnd = new Date(sorted[sorted.length - 1] + 'T23:59:59Z');
    hoursRemaining = Math.max(0, Math.round((lastEnd.getTime() - Date.now()) / 3600000));
    hoursLabel = `${hoursRemaining} hrs (${dates.length} day${dates.length !== 1 ? 's' : ''})`;
  }

  const formattedDates = [...dates].sort().map(d => {
    try {
      return new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    } catch {
      return d;
    }
  });

  try {
    const { sendAdPaymentConfirmedEmail } = await getEmailFns();
    await sendAdPaymentConfirmedEmail({
      to: email,
      businessName: businessName || undefined,
      zipCode: zipCode || undefined,
      amount: amount || undefined,
      hoursLabel: hoursLabel || undefined,
      totalHoursBooked,
      hoursRemaining,
      dates: formattedDates,
      adId,
    });
  } catch (err) {
    console.warn('[payments] Unable to send ad payment receipt:', (err as any)?.message || err);
  }
}

async function sendSubscriptionEmail({
  userId,
  fallbackEmail,
  plan,
  totalCents,
}: {
  userId?: string | null;
  fallbackEmail?: string | null;
  plan: string;
  totalCents?: number | null;
}) {
  const email = await getUserEmail(userId, fallbackEmail);
  if (!email) return;
  void plan;
  void totalCents;
}

function resolvePlanFromStripeSubscription(
  subscription: Stripe.Subscription
): 'veteran' | 'legend' | null {
  const priceId = subscription.items?.data?.[0]?.price?.id;
  if (priceId === process.env.STRIPE_PRICE_VETERAN) return 'veteran';
  if (priceId === process.env.STRIPE_PRICE_LEGEND) return 'legend';

  const metadataPlan =
    typeof subscription.metadata?.plan === 'string'
      ? subscription.metadata.plan.trim().toLowerCase()
      : '';
  if (metadataPlan === 'veteran' || metadataPlan === 'legend') return metadataPlan;

  return null;
}

function mapStripeSubscriptionStatus(status: string): string {
  const statusMap: Record<string, string> = {
    active: 'active',
    past_due: 'past_due',
    unpaid: 'unpaid',
    canceled: 'canceled',
    incomplete: 'incomplete',
    incomplete_expired: 'canceled',
    trialing: 'active',
    paused: 'paused',
  };

  return statusMap[status] || status;
}

function mapStripeSubscriptionTransactionStatus(
  status: string
): 'PENDING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' {
  if (status === 'active' || status === 'trialing') return 'COMPLETED';
  if (status === 'canceled') return 'CANCELLED';
  if (status === 'incomplete_expired') return 'FAILED';
  return 'PENDING';
}

export async function syncStripeSubscriptionState(
  subscription: Stripe.Subscription,
  source: 'subscription.updated' | 'subscription.finalize' = 'subscription.updated'
) {
  const { updateTransactionStatus } = await getTransactionLoggerFns();
  const subCustomerId =
    typeof subscription.customer === 'string'
      ? subscription.customer
      : subscription.customer?.id || null;

  if (!subCustomerId) {
    throw new Error('Missing customer ID');
  }

  const rawStatus = subscription.status || 'unknown';
  const normalizedStatus = mapStripeSubscriptionStatus(rawStatus);
  const transactionStatus = mapStripeSubscriptionTransactionStatus(rawStatus);
  const resolvedPlan = resolvePlanFromStripeSubscription(subscription);
  const entitlementActive = rawStatus === 'active' || rawStatus === 'trialing';

  const subUser = await prisma.user.findFirst({
    where: { stripe_customer_id: subCustomerId },
    select: {
      id: true,
      email: true,
      preferences: true,
      subscription_tier: true,
    },
  });

  if (!subUser) {
    await updateTransactionStatus(subscription.id, transactionStatus, {
      stripeSubscriptionId: subscription.id,
      metadata: {
        event: source,
        status: rawStatus,
        user_missing: true,
      },
    });
    return {
      userId: null,
      plan: resolvedPlan,
      normalizedStatus,
      entitlementActive,
      transactionStatus,
    };
  }

  const existingPrefs =
    subUser.preferences && typeof subUser.preferences === 'object'
      ? (subUser.preferences as any)
      : {};
  const oldSubId =
    typeof existingPrefs.subscription_id === 'string' ? existingPrefs.subscription_id : null;

  const nextPrefsBase: any = {
    ...existingPrefs,
    stripe_customer_id: subCustomerId,
    subscription_id: subscription.id,
  };
  if (subscription.current_period_end) {
    nextPrefsBase.subscription_period_end = new Date(
      Number(subscription.current_period_end) * 1000
    ).toISOString();
  } else {
    delete nextPrefsBase.subscription_period_end;
  }

  const nextTier =
    resolvedPlan === 'legend'
      ? 'pro'
      : resolvedPlan === 'veteran'
        ? 'premium'
        : subUser.subscription_tier || 'free';

  const updateData: any = {
    stripe_customer_id: subCustomerId,
    preferences: nextPrefsBase,
    subscription_tier: nextTier,
    subscription_status: normalizedStatus,
  };

  if (entitlementActive && resolvedPlan) {
    const {
      pending_plan: _pp,
      payment_approved: _pa,
      join_request_pending: _jrp,
      ...cleanPrefs
    } = nextPrefsBase;
    void _pp;
    void _pa;
    void _jrp;

    const syncedPrefs = mergeBillingStateIntoPreferences(cleanPrefs, {
      plan: resolvedPlan,
      pending_plan: null,
      payment_pending: false,
      payment_approved: false,
    });

    updateData.preferences = syncedPrefs;
    Object.assign(
      updateData,
      buildBillingStateColumns({
        plan: resolvedPlan,
        pending_plan: null,
        payment_pending: false,
        payment_approved: false,
      })
    );

    const maxTeams = getMaxTeamsForPlan(resolvedPlan);
    updateData.max_teams = maxTeams ?? 999;
  }

  await prisma.user.update({
    where: { id: subUser.id },
    data: updateData,
  });
  await invalidateMeCacheForUser(subUser.id);

  await updateTransactionStatus(subscription.id, transactionStatus, {
    stripeSubscriptionId: subscription.id,
    metadata: {
      event: source,
      status: rawStatus,
      plan: resolvedPlan || undefined,
    },
  });

  if (
    entitlementActive &&
    oldSubId &&
    oldSubId !== subscription.id &&
    String(oldSubId).startsWith('sub_')
  ) {
    try {
      const stripe = await getStripe();
      await stripe.subscriptions.cancel(String(oldSubId));
    } catch (cancelErr: any) {
      console.warn(
        '[payments] Old subscription cancel failed after new entitlement activated:',
        oldSubId,
        cancelErr?.message || cancelErr
      );
    }
  }

  return {
    userId: subUser.id,
    plan: resolvedPlan,
    normalizedStatus,
    entitlementActive,
    transactionStatus,
  };
}

export async function getVeteranBillingSnapshot(
  userId: string,
  organizationId?: string | null
): Promise<{ programCount: number; billableQuantity: number }> {
  const programCount = organizationId
    ? await (async () => {
        // Programs with an active team, PLUS ungrouped (null-program) active
        // teams — each ungrouped team is its own billable unit (matches the
        // personal branch below); omitting them let a paid_by_owner coach create
        // unlimited program_id-less teams for free.
        const [programs, ungrouped] = await Promise.all([
          prisma.sportProgram.count({
            where: { organization_id: organizationId, teams: { some: { status: 'active' } } },
          }),
          prisma.team.count({
            where: { organization_id: organizationId, status: 'active', program_id: null },
          }),
        ]);
        return programs + ungrouped;
      })()
    : await (async () => {
        const owned = await prisma.teamMembership.findMany({
          where: { user_id: userId, role: 'owner', status: 'active', team: { status: 'active' } },
          select: { team: { select: { program_id: true } } },
          take: 5000,
        });
        const ids = new Set<string>();
        let ungrouped = 0;
        for (const r of owned) r.team?.program_id ? ids.add(r.team.program_id) : (ungrouped += 1);
        return ids.size + ungrouped;
      })();

  return {
    programCount,
    billableQuantity: Math.max(0, programCount - SERVER_ROOKIE_PROGRAM_LIMIT),
  };
}

export function getVeteranTotalTeamAllowance(billableQuantity: number): number {
  return SERVER_ROOKIE_PROGRAM_LIMIT + Math.max(0, Math.trunc(billableQuantity || 0));
}

/**
 * For Veteran billing, an org owner's subscription covers the ORG they own — so
 * checkout, the create-gate, and the quantity-update must all scope to the same
 * org-wide program count, never just the owner's personally-owned teams.
 * Otherwise the three paths diverge (checkout org-wide, gate personal) and an
 * owner can create programs for their coaches past the paid allowance without
 * ever tripping the limit gate.
 *
 * Returns the org id to scope Veteran billing by, or null for a genuinely
 * personal context (the user owns no org, or owns several and no explicit org
 * was supplied to disambiguate — the caller stays personal rather than guess).
 * Server-authoritative: derived from `league_owner_id`, never a client field.
 */
export async function resolveOwnerBillingOrgId(
  userId: string,
  explicitOrgId?: string | null
): Promise<string | null> {
  const trimmed = typeof explicitOrgId === 'string' ? explicitOrgId.trim() : '';
  if (trimmed) {
    const owned = await prisma.organization.findFirst({
      where: { id: trimmed, league_owner_id: userId },
      select: { id: true },
    });
    if (owned) return owned.id;
  }
  // No (valid) explicit org: fall back only when ownership is unambiguous.
  const owned = await prisma.organization.findMany({
    where: { league_owner_id: userId },
    select: { id: true },
    take: 2,
  });
  return owned.length === 1 ? owned[0]!.id : null;
}

export function resolveVeteranQuantityUpdate(
  actualTeamCount: number,
  requestedTeamCount: number
): {
  actualTotal: number;
  requestedTotal: number;
  minAllowedTotal: number;
  maxAllowedTotal: number;
  billableQuantity: number;
  allowed: boolean;
} {
  const actualTotal = Math.max(0, Math.trunc(actualTeamCount || 0));
  const requestedTotal = Math.max(0, Math.trunc(requestedTeamCount || 0));
  const minAllowedTotal = Math.max(SERVER_VETERAN_MIN_TOTAL_TEAMS, actualTotal);
  const maxAllowedTotal = actualTotal + 1;

  return {
    actualTotal,
    requestedTotal,
    minAllowedTotal,
    maxAllowedTotal,
    billableQuantity: Math.max(0, requestedTotal - SERVER_ROOKIE_PROGRAM_LIMIT),
    allowed: requestedTotal >= minAllowedTotal && requestedTotal <= maxAllowedTotal,
  };
}

export async function releaseAdInventoryAfterSlotFullRefund(adId: string) {
  await prisma.$transaction([
    prisma.adReservation.deleteMany({ where: { ad_id: adId } }),
    prisma.ad.updateMany({
      where: {
        id: adId,
        payment_status: { in: ['hold', 'pending_approval'] },
      },
      data: { payment_status: 'unpaid' },
    }),
  ]);
}

export async function releaseAdInventoryAfterSlotFullRefundWithRetry(adId: string) {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await releaseAdInventoryAfterSlotFullRefund(adId);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 250 * attempt));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function isUniqueConstraintError(error: unknown, fieldName?: string): boolean {
  const err = error as { code?: string; meta?: { target?: unknown } } | undefined;
  if (err?.code !== 'P2002') return false;
  if (!fieldName) return true;
  const target = err.meta?.target;
  if (Array.isArray(target)) return target.includes(fieldName);
  return String(target || '').includes(fieldName);
}

function buildAppleTransactionClaimConflictError() {
  return new AppError(409, 'APPLE_TRANSACTION_ALREADY_CLAIMED', {
    errorCode: 'APPLE_TRANSACTION_ALREADY_CLAIMED',
  });
}

function buildAppleReceiptReuseError() {
  return new AppError(409, 'Receipt already used by another account', {
    errorCode: 'APPLE_RECEIPT_ALREADY_USED',
  });
}

export function normalizeAppleTransactionIds(ids: Array<string | null | undefined>) {
  return Array.from(new Set(ids.map(id => String(id || '').trim()).filter(Boolean))).sort();
}

export function mergeTransactionMetadata(existing: unknown, next: Record<string, unknown>) {
  return {
    ...(existing && typeof existing === 'object' ? (existing as Record<string, unknown>) : {}),
    ...next,
  };
}

export const APPLE_PRODUCT_TO_PLAN: Record<string, string> = {
  MIDTIER: 'veteran',
  TOPTIER: 'legend',
};

// Apple ad-IAP prices must equal the Stripe/Android ad prices; derive from the
// single ad-pricing source (utils/adPricing) so the two rails cannot diverge.
export const AD_PRODUCT_CENTS: Record<string, number> = {
  MOND_THURS: WEEKDAY_BLOCK_PRICE_CENTS,
  FRI_SUN: WEEKEND_BLOCK_PRICE_CENTS,
};

function buildSlotFullError(dates: string[]) {
  const err = new Error('SLOT_FULL') as any;
  err.slotFull = true;
  err.dates = dates;
  return err;
}

type AdSlotAvailabilityDb = Pick<Prisma.TransactionClient, 'ad' | 'adReservation'>;

export async function getFullAdSlotDates(
  db: AdSlotAvailabilityDb,
  params: {
    adId: string;
    targetZipCode?: string | null;
    isoDates: string[];
  }
): Promise<string[]> {
  if (!params.targetZipCode) return [];

  const sameZipAds = await db.ad.findMany({
    where: {
      target_zip_code: params.targetZipCode,
      payment_status: { in: ['paid', 'hold', 'pending_approval'] },
      NOT: { id: params.adId },
    },
    select: { id: true },
    take: 100,
  });

  // Fairness rule: two ads in DIFFERENT zip codes still compete for the same
  // 2-slot cap if their 9km ad-radius circles would overlap. Pre-filter with
  // a bounding box (cheap, indexable) around the target zip's centroid, then
  // confirm with the real great-circle distance.
  let nearbyZipAds: { id: string }[] = [];
  const targetCoords = getZipCoordinates(params.targetZipCode);
  if (targetCoords) {
    const box = getAdBoundingBoxDegrees(targetCoords.lat, 2.15);
    const candidates = await db.ad.findMany({
      where: {
        target_zip_code: { not: params.targetZipCode },
        payment_status: { in: ['paid', 'hold', 'pending_approval'] },
        NOT: { id: params.adId },
        target_lat: { gte: targetCoords.lat - box.lat, lte: targetCoords.lat + box.lat },
        target_lng: { gte: targetCoords.lon - box.lng, lte: targetCoords.lon + box.lng },
      },
      select: { id: true, target_lat: true, target_lng: true },
      take: 100,
    });
    nearbyZipAds = candidates.filter(
      ad =>
        ad.target_lat != null &&
        ad.target_lng != null &&
        haversineDistance(targetCoords.lat, targetCoords.lon, ad.target_lat, ad.target_lng) <
          NEIGHBORING_RADIUS_TOUCH_MILES
    );
  }

  const competingAds = [...sameZipAds, ...nearbyZipAds];
  if (competingAds.length === 0) return [];

  const dateObjects = params.isoDates.map(s => new Date(s + 'T00:00:00.000Z'));
  const bookedSlots = await db.adReservation.groupBy({
    by: ['date'],
    where: { ad_id: { in: competingAds.map(a => a.id) }, date: { in: dateObjects } },
    _count: { date: true },
  });

  return bookedSlots
    .filter(slot => slot._count.date >= MAX_AD_SLOTS)
    .map(slot => slot.date.toISOString().slice(0, 10));
}

export async function reserveAdSlots(
  tx: Prisma.TransactionClient,
  params: {
    adId: string;
    targetZipCode?: string | null;
    isoDates: string[];
    paymentStatus: 'hold' | 'paid';
    status?: AdStatus;
  }
) {
  const fullDates = await getFullAdSlotDates(tx, params);
  if (fullDates.length > 0) {
    throw buildSlotFullError(fullDates);
  }

  await tx.ad.update({
    where: { id: params.adId },
    data: {
      payment_status: params.paymentStatus,
      ...(params.status ? { status: params.status } : {}),
    },
  });
  await tx.adReservation.createMany({
    data: params.isoDates.map(s => ({ ad_id: params.adId, date: new Date(s + 'T00:00:00.000Z') })),
    skipDuplicates: true,
  });
}

export async function ensureApplePendingTransactionLog(params: {
  transactionType: 'SUBSCRIPTION_PURCHASE' | 'AD_PURCHASE';
  userId: string;
  userEmail?: string | null;
  orderId: string;
  appleTransactionId?: string | null;
  metadata: Record<string, unknown>;
}) {
  const normalizedAppleTransactionId = String(params.appleTransactionId || '').trim() || null;
  const completed = await prisma.transactionLog.findFirst({
    where: {
      transaction_type: params.transactionType,
      user_id: params.userId,
      order_id: params.orderId,
      status: 'COMPLETED',
    } as any,
    select: { id: true },
  });
  if (completed) {
    return { id: completed.id, status: 'COMPLETED' as const };
  }

  const existingPending = await prisma.transactionLog.findFirst({
    where: {
      transaction_type: params.transactionType,
      user_id: params.userId,
      order_id: params.orderId,
      status: { in: ['PENDING', 'NEEDS_REVIEW'] },
    } as any,
    select: { id: true, apple_transaction_id: true, metadata: true },
    orderBy: { created_at: 'desc' },
  });

  if (existingPending) {
    await prisma.transactionLog.update({
      where: { id: existingPending.id },
      data: {
        status: 'PENDING',
        user_email: params.userEmail ?? undefined,
        apple_transaction_id:
          existingPending.apple_transaction_id || normalizedAppleTransactionId || undefined,
        metadata: mergeTransactionMetadata(existingPending.metadata, params.metadata),
      } as any,
    });
    return { id: existingPending.id, status: 'PENDING' as const };
  }

  try {
    const created = await prisma.transactionLog.create({
      data: {
        transaction_type: params.transactionType,
        status: 'PENDING',
        user_id: params.userId,
        user_email: params.userEmail ?? undefined,
        order_id: params.orderId,
        apple_transaction_id: normalizedAppleTransactionId,
        metadata: params.metadata as any,
      } as any,
    });
    return { id: created.id, status: 'PENDING' as const };
  } catch (error) {
    if (normalizedAppleTransactionId && isUniqueConstraintError(error, 'apple_transaction_id')) {
      const existing = await prisma.transactionLog.findUnique({
        where: { apple_transaction_id: normalizedAppleTransactionId },
        select: {
          id: true,
          transaction_type: true,
          user_id: true,
          order_id: true,
          status: true,
        },
      });
      if (
        existing &&
        existing.transaction_type === params.transactionType &&
        existing.user_id === params.userId &&
        existing.order_id === params.orderId
      ) {
        return {
          id: existing.id,
          status: existing.status as 'PENDING' | 'COMPLETED' | 'NEEDS_REVIEW',
        };
      }
      throw params.transactionType === 'SUBSCRIPTION_PURCHASE'
        ? buildAppleReceiptReuseError()
        : buildAppleTransactionClaimConflictError();
    }
    throw error;
  }
}

export async function finalizeAppleSubscriptionPurchase(params: {
  userId: string;
  userEmail?: string | null;
  productId: string;
  originalTransactionId: string;
  appleTransactionId?: string | null;
  expiresAtIso?: string | null;
  source: string;
}) {
  const plan = APPLE_PRODUCT_TO_PLAN[params.productId];
  if (!plan) {
    const error = new Error(`Unknown Apple product: ${params.productId}`);
    (error as any).statusCode = 400;
    throw error;
  }

  const existingCompleted = await prisma.transactionLog.findFirst({
    where: {
      order_id: params.originalTransactionId,
      transaction_type: 'SUBSCRIPTION_PURCHASE',
      status: 'COMPLETED',
    } as any,
    select: { user_id: true },
  });
  if (existingCompleted?.user_id && existingCompleted.user_id !== params.userId) {
    throw buildAppleReceiptReuseError();
  }
  if (existingCompleted?.user_id === params.userId) {
    return {
      ok: true,
      plan,
      expires: params.expiresAtIso || null,
      idempotent: true,
    };
  }

  const user = await prisma.user.findUnique({
    where: { id: params.userId },
    select: { preferences: true },
  });
  const currentPrefs =
    user?.preferences && typeof user.preferences === 'object' ? (user.preferences as any) : {};
  const { payment_pending, payment_approved, pending_plan, join_request_pending, ...restPrefs } =
    currentPrefs;
  void payment_pending;
  void payment_approved;
  void pending_plan;
  void join_request_pending;

  const nextPrefsBase: Record<string, unknown> = {
    ...restPrefs,
    apple_product_id: params.productId,
    apple_original_transaction_id: params.originalTransactionId,
  };
  if (params.expiresAtIso) nextPrefsBase.apple_expires_date = params.expiresAtIso;
  const nextPrefs = mergeBillingStateIntoPreferences(nextPrefsBase, {
    plan: plan as 'veteran' | 'legend',
    pending_plan: null,
    payment_pending: false,
    payment_approved: false,
  });

  try {
    await prisma.$transaction(async tx => {
      await tx.user.update({
        where: { id: params.userId },
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
      });

      const pendingTx = await tx.transactionLog.findFirst({
        where: {
          transaction_type: 'SUBSCRIPTION_PURCHASE',
          user_id: params.userId,
          order_id: params.originalTransactionId,
          status: { in: ['PENDING', 'NEEDS_REVIEW'] },
        } as any,
        select: { id: true, metadata: true },
        orderBy: { created_at: 'desc' },
      });

      const metadata = mergeTransactionMetadata(pendingTx?.metadata, {
        source: params.source,
        productId: params.productId,
        plan,
        ...(params.expiresAtIso ? { apple_expires_date: params.expiresAtIso } : {}),
      });

      if (pendingTx) {
        await tx.transactionLog.update({
          where: { id: pendingTx.id },
          data: {
            status: 'COMPLETED',
            user_email: params.userEmail ?? undefined,
            apple_transaction_id: String(params.appleTransactionId || '').trim() || undefined,
            metadata: metadata as any,
          } as any,
        });
      } else {
        await tx.transactionLog.create({
          data: {
            transaction_type: 'SUBSCRIPTION_PURCHASE',
            status: 'COMPLETED',
            user_id: params.userId,
            user_email: params.userEmail ?? undefined,
            order_id: params.originalTransactionId,
            apple_transaction_id: String(params.appleTransactionId || '').trim() || null,
            metadata: metadata as any,
          } as any,
        });
      }
    });
  } catch (error) {
    if (params.appleTransactionId && isUniqueConstraintError(error, 'apple_transaction_id')) {
      const existing = await prisma.transactionLog.findUnique({
        where: { apple_transaction_id: params.appleTransactionId },
        select: { user_id: true },
      });
      if (existing?.user_id === params.userId) {
        return {
          ok: true,
          plan,
          expires: params.expiresAtIso || null,
          idempotent: true,
        };
      }
      if (existing?.user_id && existing.user_id !== params.userId) {
        throw buildAppleReceiptReuseError();
      }
    }
    throw error;
  }

  await invalidateMeCacheForUser(params.userId);
  return {
    ok: true,
    plan,
    expires: params.expiresAtIso || null,
    idempotent: false,
  };
}

function claimMatchesPurchase(
  claim: {
    transaction_type: string;
    user_id: string | null;
    ad_id: string | null;
    order_id: string | null;
  },
  expected: {
    transactionType: string;
    userId: string;
    adId?: string | null;
    orderId?: string | null;
  }
) {
  return (
    claim.transaction_type === expected.transactionType &&
    claim.user_id === expected.userId &&
    (expected.adId == null || claim.ad_id === expected.adId) &&
    (expected.orderId == null || claim.order_id === expected.orderId)
  );
}

async function reserveAppleTransactionClaims(
  tx: Prisma.TransactionClient,
  params: {
    appleTransactionIds: string[];
    transactionType: 'AD_PURCHASE';
    userId: string;
    adId: string;
    orderId: string;
    metadata?: Record<string, unknown>;
  }
) {
  const normalizedIds = Array.from(
    new Set(params.appleTransactionIds.map(id => String(id).trim()).filter(Boolean))
  ).sort();
  if (normalizedIds.length === 0) {
    throw new AppError(400, 'APPLE_TRANSACTION_IDS_REQUIRED', {
      errorCode: 'APPLE_TRANSACTION_IDS_REQUIRED',
    });
  }

  const existingClaims = await tx.appleTransactionClaim.findMany({
    where: { apple_transaction_id: { in: normalizedIds } },
    select: {
      apple_transaction_id: true,
      transaction_type: true,
      user_id: true,
      ad_id: true,
      order_id: true,
    },
    take: normalizedIds.length,
  });

  const conflictingClaim = existingClaims.find(claim => !claimMatchesPurchase(claim, params));
  if (conflictingClaim) {
    throw buildAppleTransactionClaimConflictError();
  }

  const existingIds = new Set(existingClaims.map(claim => claim.apple_transaction_id));
  const missingIds = normalizedIds.filter(id => !existingIds.has(id));

  for (const appleTransactionId of missingIds) {
    try {
      await tx.appleTransactionClaim.create({
        data: {
          apple_transaction_id: appleTransactionId,
          transaction_type: params.transactionType as any,
          user_id: params.userId,
          ad_id: params.adId,
          order_id: params.orderId,
          metadata: params.metadata as any,
        },
      });
    } catch (error) {
      if (isUniqueConstraintError(error, 'apple_transaction_id')) {
        const concurrentClaim = await tx.appleTransactionClaim.findUnique({
          where: { apple_transaction_id: appleTransactionId },
          select: {
            transaction_type: true,
            user_id: true,
            ad_id: true,
            order_id: true,
          },
        });
        if (!concurrentClaim || !claimMatchesPurchase(concurrentClaim, params)) {
          throw buildAppleTransactionClaimConflictError();
        }
        continue;
      }
      throw error;
    }
  }

  return {
    appleTransactionIds: normalizedIds,
    idempotent: missingIds.length === 0,
  };
}

export async function finalizeAppleAdPurchase(params: {
  userId: string;
  userEmail?: string | null;
  adId: string;
  dates: string[];
  appleTransactionIds: string[];
  receiptsCount: number;
}) {
  return prisma.$transaction(
    async tx => {
      const orderId = String(params.adId);
      const claimResult = await reserveAppleTransactionClaims(tx, {
        appleTransactionIds: params.appleTransactionIds,
        transactionType: 'AD_PURCHASE',
        userId: params.userId,
        adId: String(params.adId),
        orderId,
        metadata: {
          source: 'apple_iap',
          receipts_count: params.receiptsCount,
        },
      });

      const existingTx = await tx.transactionLog.findFirst({
        where: {
          user_id: params.userId,
          order_id: orderId,
          transaction_type: 'AD_PURCHASE',
          status: 'COMPLETED',
        } as any,
        select: { id: true },
      });
      const pendingTx = await tx.transactionLog.findFirst({
        where: {
          user_id: params.userId,
          order_id: orderId,
          transaction_type: 'AD_PURCHASE',
          status: { in: ['PENDING', 'NEEDS_REVIEW'] },
        } as any,
        select: { id: true, metadata: true },
        orderBy: { created_at: 'desc' },
      });

      const adRecord = await tx.ad.findUnique({
        where: { id: String(params.adId) },
        select: { target_zip_code: true },
      });

      await reserveAdSlots(tx, {
        adId: String(params.adId),
        targetZipCode: adRecord?.target_zip_code,
        isoDates: params.dates,
        paymentStatus: 'paid',
        status: 'active',
      });

      if (!existingTx) {
        const metadata = mergeTransactionMetadata(pendingTx?.metadata, {
          source: 'apple_iap',
          ad_id: String(params.adId),
          dates: params.dates,
          receipts_count: params.receiptsCount,
          apple_transaction_ids: claimResult.appleTransactionIds,
        });

        if (pendingTx) {
          await tx.transactionLog.update({
            where: { id: pendingTx.id },
            data: {
              status: 'COMPLETED',
              user_email: params.userEmail ?? undefined,
              apple_transaction_id:
                claimResult.appleTransactionIds.length === 1
                  ? claimResult.appleTransactionIds[0]
                  : undefined,
              metadata: metadata as any,
            } as any,
          });
        } else {
          await tx.transactionLog.create({
            data: {
              transaction_type: 'AD_PURCHASE',
              status: 'COMPLETED',
              user_id: params.userId,
              user_email: params.userEmail ?? undefined,
              order_id: orderId,
              apple_transaction_id:
                claimResult.appleTransactionIds.length === 1
                  ? claimResult.appleTransactionIds[0]
                  : null,
              metadata: metadata as any,
            } as any,
          });
        }
      }

      return {
        ok: true,
        idempotent: !!existingTx && claimResult.idempotent,
        appleTransactionIds: claimResult.appleTransactionIds,
      };
    },
    { isolationLevel: 'Serializable' }
  );
}

export async function runFinalizeFromSession(session: Stripe.Checkout.Session) {
  debugLog('[payments] finalizeFromSession called', {
    session_id: session.id,
    payment_status: session.payment_status,
    status: session.status,
    metadata: session.metadata,
  });

  const meta = session.metadata || {};
  const { getTransactionBySession, updateTransactionStatus } = await getTransactionLoggerFns();
  const transactionLog = await getTransactionBySession(session.id);
  if (transactionLog?.status === 'COMPLETED') {
    debugLog('[payments] finalizeFromSession skipped — already COMPLETED', {
      session_id: session.id,
    });
    return;
  }
  const metadataUserId = meta.user_id ? String(meta.user_id) : null;
  const inferredUserId =
    metadataUserId || (transactionLog?.user_id ? String(transactionLog.user_id) : null);
  const fallbackEmail =
    transactionLog?.user?.email ||
    transactionLog?.user_email ||
    (session.customer_details?.email ?? null);
  const totalCents =
    typeof session.amount_total === 'number'
      ? session.amount_total
      : Number(meta.total_cents || transactionLog?.total_cents || 0) || 0;
  const ad_id = meta.ad_id || '';
  const dates = decodeAdDates(meta.dates);
  if (ad_id && Array.isArray(dates) && dates.length) {
    debugLog('[payments] Processing ad reservation payment', {
      ad_id,
      dates,
      session_id: session.id,
      payment_status: session.payment_status,
    });
    try {
      await prisma.$transaction(
        async tx => {
          const adRecord = await tx.ad.findUnique({
            where: { id: ad_id },
            select: { target_zip_code: true },
          });
          if (adRecord?.target_zip_code) {
            const fullDates = await getFullAdSlotDates(tx, {
              adId: ad_id,
              targetZipCode: adRecord.target_zip_code,
              isoDates: dates,
            });
            if (fullDates.length > 0) {
              const err = new Error('SLOT_FULL') as any;
              err.slotFull = true;
              err.dates = fullDates;
              throw err;
            }
          }

          const adCheck = await tx.ad.findUnique({
            where: { id: ad_id },
            select: { status: true, payment_status: true },
          });
          if (adCheck?.payment_status === 'paid') {
            console.log(
              `[payments] Idempotent: ad ${ad_id} already paid, skipping duplicate activation`
            );
            return;
          }
          if (!adCheck || (adCheck.status !== 'approved' && adCheck.status !== 'active')) {
            throw new Error(
              `AD_NOT_APPROVED: Ad ${ad_id} status is ${adCheck?.status}, cannot activate`
            );
          }

          const updated = await tx.ad.updateMany({
            where: { id: ad_id, status: { in: ['approved', 'active'] } },
            data: { payment_status: 'paid', status: 'active' },
          });
          if (updated.count === 0) {
            throw new Error(
              `AD_NOT_APPROVED: Ad ${ad_id} was no longer approved at activation time`
            );
          }
          await tx.adReservation.createMany({
            data: dates.map(s => ({ ad_id, date: new Date(s + 'T00:00:00.000Z') })),
            skipDuplicates: true,
          });
        },
        { isolationLevel: 'Serializable' }
      );

      await updateTransactionStatus(session.id, 'COMPLETED', {
        stripePaymentIntentId: session.payment_intent ? String(session.payment_intent) : undefined,
      });
      const adForEmail = await prisma.ad.findUnique({
        where: { id: ad_id },
        select: {
          business_name: true,
          target_zip_code: true,
          user_id: true,
          contact_email: true,
        },
      });
      sendAdPaymentEmail({
        userId: adForEmail?.user_id || null,
        contactEmail: adForEmail?.contact_email || null,
        adId: String(ad_id),
        dates: decodeAdDates(session.metadata?.dates),
        totalCents: session.amount_total ?? null,
        businessName: adForEmail?.business_name,
        zipCode: adForEmail?.target_zip_code,
      }).catch(err =>
        console.warn(
          '[payments] Stripe webhook ad payment receipt failed:',
          (err as any)?.message || err
        )
      );
    } catch (e: any) {
      if (e?.slotFull) {
        try {
          const piId = session.payment_intent ? String(session.payment_intent) : '';
          if (piId) {
            const stripe = await getStripe();
            const refund = await stripe.refunds.create({
              payment_intent: piId,
              reason: 'requested_by_customer',
            });
            try {
              await releaseAdInventoryAfterSlotFullRefundWithRetry(ad_id);
              await updateTransactionStatus(session.id, 'REFUNDED', {
                metadata: {
                  reason: 'slot_full',
                  overbooked_dates: e.dates,
                  stripe_refund_id: refund.id,
                  refunded_amount_cents: refund.amount ?? totalCents,
                  refund_currency: refund.currency || 'usd',
                  refund_status: refund.status || 'pending',
                  refunded_at: new Date().toISOString(),
                },
              });
            } catch (releaseErr: any) {
              captureException(releaseErr as Error, {
                context: 'slot_full_release_after_refund_failed_session',
                adId: ad_id,
                sessionId: session.id,
                refundId: refund.id,
              });
              await updateTransactionStatus(session.id, 'NEEDS_REVIEW', {
                metadata: {
                  reason: 'slot_full_release_failed',
                  overbooked_dates: e.dates,
                  stripe_refund_id: refund.id,
                  refunded_amount_cents: refund.amount ?? totalCents,
                  refund_currency: refund.currency || 'usd',
                  refund_status: refund.status || 'pending',
                  refunded_at: new Date().toISOString(),
                  release_pending: true,
                  release_error: releaseErr?.message || 'release_failed',
                },
              });
            }
            if (fallbackEmail) {
              const { sendBillingNoticeEmail } = await getEmailFns();
              const adForRefund = await prisma.ad.findUnique({
                where: { id: ad_id },
                select: { business_name: true, target_zip_code: true },
              });
              sendBillingNoticeEmail({
                to: fallbackEmail,
                type: 'payment_failed',
                planName: `Ad Reservation for ${adForRefund?.business_name || 'your ad'}`,
                amount: `$${(totalCents / 100).toFixed(2)}`,
                perks: [
                  `Your selected dates in zip code ${adForRefund?.target_zip_code || 'N/A'} were fully booked. You have been fully refunded $${(totalCents / 100).toFixed(2)}.`,
                ],
              }).catch(err => {
                captureException(err as Error, {
                  context: 'slot_full_refund_email_session',
                  sessionId: session.id,
                });
              });
            }
          } else {
            await updateTransactionStatus(session.id, 'FAILED', {
              metadata: {
                reason: 'slot_full_refund_missing_payment_intent',
                overbooked_dates: e.dates,
                refund_failed: true,
              },
            }).catch(() => {});
            throw new Error('SLOT_FULL_REFUND_MISSING_PAYMENT_INTENT');
          }
        } catch (refundErr: any) {
          captureException(refundErr as Error, {
            context: 'slot_full_auto_refund_failed_session',
            sessionId: session.id,
          });
          await updateTransactionStatus(session.id, 'FAILED', {
            metadata: {
              reason: 'slot_full_refund_failed',
              overbooked_dates: e.dates,
              refund_failed: true,
            },
          }).catch(() => {});
          throw refundErr;
        }
        return;
      }
      throw e;
    }
  }

  const code = (meta.promo_code || '').trim();
  const userId = meta.user_id || '';
  const subtotalCents = Number(meta.subtotal_cents || 0) || 0;

  const plan = typeof meta.plan === 'string' ? meta.plan.trim() : '';
  const metaMembership = String(meta.membership || '').trim();
  const isMembership = metaMembership === '1' || metaMembership === 'true' || plan.length > 0;
  if (isMembership && userId && plan.length > 0) {
    const paid = session.payment_status === 'paid';
    if (!paid) {
      return;
    } else {
      try {
        if (!isJestRuntime) {
          try {
            const stripe = await getStripe();
            const fresh = await stripe.checkout.sessions.retrieve(String(session.id));
            if (fresh?.payment_status !== 'paid') {
              return;
            }
          } catch (reverifyErr: any) {
            captureException(reverifyErr as Error, {
              context: 'finalize_reverify_failed',
              sessionId: String(session.id),
              userId,
            });
            try {
              await updateTransactionStatus(session.id, 'NEEDS_REVIEW', {
                metadata: {
                  reason: 'session_reverify_api_failed',
                  reverify_error: String(reverifyErr?.message || reverifyErr),
                  webhook_payment_status: session.payment_status,
                  flagged_at: new Date().toISOString(),
                },
              });
            } catch {
              // Ignore follow-on transaction status failures here.
            }
            return;
          }
        }
        const current = await prisma.user.findUnique({
          where: { id: userId },
          select: { preferences: true },
        });
        if (!current) return;
        const existingPrefs =
          current?.preferences && typeof current.preferences === 'object'
            ? (current.preferences as any)
            : {};
        const {
          pending_plan: _pp,
          payment_approved: _pa,
          join_request_pending: _jrp,
          ...cleanPrefs
        } = existingPrefs;
        void _pp;
        void _pa;
        void _jrp;
        const prefs: any = mergeBillingStateIntoPreferences(cleanPrefs, {
          plan: plan as 'rookie' | 'veteran' | 'legend',
          pending_plan: null,
          payment_pending: false,
          payment_approved: false,
        });
        if (session.subscription) {
          try {
            const stripe = await getStripe();
            const sub = await stripe.subscriptions.retrieve(String(session.subscription));
            if (sub && sub.id) {
              prefs.subscription_id = String(sub.id);
              if (sub.current_period_end) {
                prefs.subscription_period_end = new Date(
                  Number(sub.current_period_end) * 1000
                ).toISOString();
              }
            }
          } catch {
            // Ignore subscription detail enrichment failures.
          }
        }
        if (session.customer) {
          prefs.stripe_customer_id = String(session.customer);
        }

        const maxTeams = getMaxTeamsForPlan(plan);
        const subscriptionTier =
          plan === 'rookie' ? 'free' : plan === 'veteran' ? 'premium' : 'pro';

        await prisma.$transaction([
          prisma.user.update({
            where: { id: userId },
            data: {
              preferences: prefs,
              ...buildBillingStateColumns({
                plan: plan as 'rookie' | 'veteran' | 'legend',
                pending_plan: null,
                payment_pending: false,
                payment_approved: false,
              }),
              max_teams: maxTeams ?? 999,
              subscription_tier: subscriptionTier,
              subscription_status: 'active',
            },
          }),
          prisma.transactionLog.update({
            where: { stripe_session_id: session.id },
            data: {
              status: 'COMPLETED',
              updated_at: new Date(),
              stripe_payment_intent_id: session.payment_intent
                ? String(session.payment_intent)
                : undefined,
              stripe_subscription_id: session.subscription
                ? String(session.subscription)
                : undefined,
            },
          }),
        ]);
        await invalidateMeCacheForUser(userId);

        const oldSubId = existingPrefs.subscription_id;
        if (
          oldSubId &&
          prefs.subscription_id &&
          oldSubId !== prefs.subscription_id &&
          String(oldSubId).startsWith('sub_')
        ) {
          try {
            const stripe = await getStripe();
            await stripe.subscriptions.cancel(String(oldSubId));
          } catch {
            // Ignore old subscription cancel failures after entitlement is active.
          }
        }

        sendSubscriptionEmail({
          userId,
          fallbackEmail,
          plan,
          totalCents,
        }).catch(() => {});
      } catch (err) {
        captureException(err as Error, {
          context: 'finalize_membership_from_session',
          sessionId: session.id,
          userId,
          plan,
        });
        throw err;
      }
    }
  }

  if (code && userId && subtotalCents > 0) {
    let redeemed = false;
    const { redeemPromo } = await getPromoFns();
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await redeemPromo({ code, userId, subtotalCents, service: 'booking', orderId: session.id });
        redeemed = true;
        break;
      } catch {
        if (attempt < 3) await new Promise(r => setTimeout(r, 500 * attempt));
      }
    }
    if (!redeemed) {
      await updateTransactionStatus(session.id, 'NEEDS_REVIEW', {
        metadata: { promo_redemption_failed: true, promo_code: code, needs_review: true },
      }).catch(() => {});
    }
  }
}
