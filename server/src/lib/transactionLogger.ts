/**
 * Transaction Logger
 *
 * Centralized logging for all financial transactions
 * Ensures compliance with 7-year retention requirements
 */

import { TransactionStatus, TransactionType } from '@prisma/client';
import { debugLog } from './debugLog.js';
import { prisma } from './prisma.js';

export interface TransactionLogData {
  // Transaction identification
  transactionType: TransactionType;
  status?: TransactionStatus;
  stripeSessionId?: string;
  stripePaymentIntentId?: string;
  stripeSubscriptionId?: string;

  // User and order
  userId?: string;
  userEmail?: string;
  orderId?: string;

  // Financial details (in cents)
  subtotalCents?: number;
  taxCents?: number;
  stripeFeeeCents?: number;
  discountCents?: number;
  totalCents?: number;
  netCents?: number;

  // Promo code
  promoCode?: string;
  promoDiscountCents?: number;

  // Metadata
  currency?: string;
  paymentMethod?: string;
  metadata?: Record<string, any>;

  // Audit trail
  ipAddress?: string;
  userAgent?: string;
}

/**
 * Log a transaction
 */
export async function logTransaction(data: TransactionLogData) {
  try {
    const log = await prisma.transactionLog.create({
      data: {
        transaction_type: data.transactionType,
        status: data.status || 'PENDING',
        stripe_session_id: data.stripeSessionId,
        stripe_payment_intent_id: data.stripePaymentIntentId,
        stripe_subscription_id: data.stripeSubscriptionId,

        user_id: data.userId,
        user_email: data.userEmail,
        order_id: data.orderId,

        subtotal_cents: data.subtotalCents || 0,
        tax_cents: data.taxCents || 0,
        stripe_fee_cents: data.stripeFeeeCents || 0,
        discount_cents: data.discountCents || 0,
        total_cents: data.totalCents || 0,
        net_cents: data.netCents || (data.totalCents || 0) - (data.stripeFeeeCents || 0),

        promo_code: data.promoCode,
        promo_discount_cents: data.promoDiscountCents || 0,

        currency: data.currency || 'usd',
        payment_method: data.paymentMethod,
        metadata: data.metadata ? JSON.parse(JSON.stringify(data.metadata)) : null,

        ip_address: data.ipAddress,
        user_agent: data.userAgent,
      },
    });

    debugLog(`[transaction-log] Created log ${log.id} for ${data.transactionType}`);
    return log;
  } catch (error) {
    console.error('[transaction-log] Failed to log transaction:', error);
    // Don't throw - logging failures shouldn't break the transaction flow
    return null;
  }
}

/**
 * Update transaction status
 */
export async function updateTransactionStatus(
  transactionReferenceId: string,
  status: TransactionStatus,
  additionalData?: Partial<TransactionLogData>
) {
  try {
    const updateData: any = {
      status,
      updated_at: new Date(),
    };

    if (additionalData) {
      if (additionalData.stripePaymentIntentId)
        updateData.stripe_payment_intent_id = additionalData.stripePaymentIntentId;
      if (additionalData.stripeSubscriptionId)
        updateData.stripe_subscription_id = additionalData.stripeSubscriptionId;
      if (additionalData.stripeFeeeCents !== undefined)
        updateData.stripe_fee_cents = additionalData.stripeFeeeCents;
      if (additionalData.totalCents !== undefined) {
        updateData.total_cents = additionalData.totalCents;
        updateData.net_cents = additionalData.totalCents - (additionalData.stripeFeeeCents || 0);
      }
      if (additionalData.metadata)
        updateData.metadata = JSON.parse(JSON.stringify(additionalData.metadata));
    }

    // Accept session IDs, payment-intent IDs, and subscription IDs so callers
    // can update transaction status regardless of Stripe flow type.
    const matchingLog = await prisma.transactionLog.findFirst({
      where: {
        OR: [
          { stripe_session_id: transactionReferenceId },
          { stripe_payment_intent_id: transactionReferenceId },
          { stripe_subscription_id: transactionReferenceId },
        ],
      },
      orderBy: { created_at: 'desc' },
      select: { id: true },
    });

    if (!matchingLog) {
      debugLog(`[transaction-log] No transaction found for reference ${transactionReferenceId}`);
      return null;
    }

    const log = await prisma.transactionLog.update({
      where: { id: matchingLog.id },
      data: updateData,
    });

    debugLog(`[transaction-log] Updated log ${log.id} to ${status}`);
    return log;
  } catch (error) {
    console.error('[transaction-log] Failed to update transaction:', error);
    return null;
  }
}

/**
 * Get transaction by Stripe session ID
 */
export async function getTransactionBySession(stripeSessionId: string) {
  try {
    return await prisma.transactionLog.findUnique({
      where: { stripe_session_id: stripeSessionId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            display_name: true,
          },
        },
      },
    });
  } catch (error) {
    console.error('[transaction-log] Failed to get transaction:', error);
    return null;
  }
}

/**
 * Get user's transactions
 */
export async function getUserTransactions(userId: string, limit = 50) {
  try {
    return await prisma.transactionLog.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
      take: limit,
    });
  } catch (error) {
    console.error('[transaction-log] Failed to get user transactions:', error);
    return [];
  }
}

/**
 * Get all transactions (admin)
 */
export async function getAllTransactions(
  filters?: {
    type?: TransactionType;
    status?: TransactionStatus;
    startDate?: Date;
    endDate?: Date;
    userId?: string;
  },
  limit = 100,
  offset = 0
) {
  try {
    const where: any = {};

    if (filters?.type) where.transaction_type = filters.type;
    if (filters?.status) where.status = filters.status;
    if (filters?.userId) where.user_id = filters.userId;
    if (filters?.startDate || filters?.endDate) {
      where.created_at = {};
      if (filters.startDate) where.created_at.gte = filters.startDate;
      if (filters.endDate) where.created_at.lte = filters.endDate;
    }

    const [transactions, total] = await Promise.all([
      prisma.transactionLog.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              email: true,
              display_name: true,
            },
          },
        },
        orderBy: { created_at: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.transactionLog.count({ where }),
    ]);

    return { transactions, total };
  } catch (error) {
    console.error('[transaction-log] Failed to get transactions:', error);
    return { transactions: [], total: 0 };
  }
}

/**
 * Calculate Stripe fee (approximate)
 * Stripe charges 2.9% + $0.30 per successful card charge
 */
export function calculateStripeFee(totalCents: number): number {
  return Math.round(totalCents * 0.029 + 30);
}

/**
 * Get transaction summary stats
 */
export async function getTransactionSummary(startDate?: Date, endDate?: Date) {
  try {
    const where: any = {};
    if (startDate || endDate) {
      where.created_at = {};
      if (startDate) where.created_at.gte = startDate;
      if (endDate) where.created_at.lte = endDate;
    }

    const [totalTransactions, completedTransactions, totalRevenue, totalFees, totalDiscounts] =
      await Promise.all([
        prisma.transactionLog.count({ where }),
        prisma.transactionLog.count({
          where: { ...where, status: 'COMPLETED' },
        }),
        prisma.transactionLog.aggregate({
          where: { ...where, status: 'COMPLETED' },
          _sum: { total_cents: true },
        }),
        prisma.transactionLog.aggregate({
          where: { ...where, status: 'COMPLETED' },
          _sum: { stripe_fee_cents: true },
        }),
        prisma.transactionLog.aggregate({
          where: { ...where, status: 'COMPLETED' },
          _sum: { discount_cents: true },
        }),
      ]);

    return {
      totalTransactions,
      completedTransactions,
      totalRevenueCents: totalRevenue._sum.total_cents || 0,
      totalFeesCents: totalFees._sum.stripe_fee_cents || 0,
      totalDiscountsCents: totalDiscounts._sum.discount_cents || 0,
      netRevenueCents:
        (totalRevenue._sum.total_cents || 0) - (totalFees._sum.stripe_fee_cents || 0),
    };
  } catch (error) {
    console.error('[transaction-log] Failed to get summary:', error);
    return {
      totalTransactions: 0,
      completedTransactions: 0,
      totalRevenueCents: 0,
      totalFeesCents: 0,
      totalDiscountsCents: 0,
      netRevenueCents: 0,
    };
  }
}

/**
 * Get transaction breakdown by type
 */
export async function getTransactionBreakdownByType(startDate?: Date, endDate?: Date) {
  try {
    const where: any = { status: 'COMPLETED' };
    if (startDate || endDate) {
      where.created_at = {};
      if (startDate) where.created_at.gte = startDate;
      if (endDate) where.created_at.lte = endDate;
    }

    const transactions = await prisma.transactionLog.groupBy({
      by: ['transaction_type'],
      where,
      _count: { id: true },
      _sum: {
        total_cents: true,
        stripe_fee_cents: true,
        discount_cents: true,
      },
    });

    return transactions.map(t => ({
      type: t.transaction_type,
      count: t._count.id,
      revenueCents: t._sum.total_cents || 0,
      feesCents: t._sum.stripe_fee_cents || 0,
      discountsCents: t._sum.discount_cents || 0,
      netCents: (t._sum.total_cents || 0) - (t._sum.stripe_fee_cents || 0),
    }));
  } catch (error) {
    console.error('[transaction-log] Failed to get breakdown:', error);
    return [];
  }
}

/**
 * Ad revenue aggregate report — VARSITYHUB COMMANDMENTS: "Revenue tracking by:
 * zip code, time window (M-Th vs F-Su), business, impressions and clicks per ad."
 * `Ad` has no `price_cents`/`zip_code` columns of its own — the real money record
 * is the completed AD_PURCHASE `TransactionLog` row (`order_id` = ad id,
 * `total_cents`), joined here to the `Ad` row for zip/business, and to
 * `AdReservation` dates (via the existing weekday/weekend block pricing model)
 * for the M-Th vs F-Su split, since one purchase can span both blocks.
 */
export async function getAdRevenueReport(startDate?: Date, endDate?: Date) {
  const { calculateAdPriceCents, WEEKDAY_BLOCK_PRICE_CENTS, WEEKEND_BLOCK_PRICE_CENTS } =
    await import('../utils/adPricing.js');

  const where: any = { transaction_type: 'AD_PURCHASE', status: 'COMPLETED' };
  if (startDate || endDate) {
    where.created_at = {};
    if (startDate) where.created_at.gte = startDate;
    if (endDate) where.created_at.lte = endDate;
  }

  const transactions = await prisma.transactionLog.findMany({
    where,
    select: { order_id: true, total_cents: true, user_id: true, user_email: true },
    take: 5000,
  });

  const adIds = [...new Set(transactions.map(t => t.order_id).filter(Boolean))] as string[];
  const ads = adIds.length
    ? await prisma.ad.findMany({
        where: { id: { in: adIds } },
        select: {
          id: true,
          target_zip_code: true,
          business_name: true,
          impression_count: true,
          click_count: true,
        },
      })
    : [];
  const adById = new Map(ads.map(a => [a.id, a]));

  const byZipCode = new Map<string, number>();
  const byBusiness = new Map<string, number>();
  let totalRevenueCents = 0;

  for (const t of transactions) {
    const cents = t.total_cents || 0;
    totalRevenueCents += cents;
    const ad = t.order_id ? adById.get(t.order_id) : undefined;
    const zipKey = ad?.target_zip_code || 'unknown';
    byZipCode.set(zipKey, (byZipCode.get(zipKey) || 0) + cents);
    const businessKey = ad?.business_name || t.user_email || 'unknown';
    byBusiness.set(businessKey, (byBusiness.get(businessKey) || 0) + cents);
  }

  // Time-window split from actual reserved dates, not the transaction total —
  // a single purchase can cover both a Mon-Thu block and a Fri-Sun block.
  const reservations = adIds.length
    ? await prisma.adReservation.findMany({
        where: { ad_id: { in: adIds } },
        select: { ad_id: true, date: true },
        take: 20000,
      })
    : [];
  const datesByAd = new Map<string, string[]>();
  for (const r of reservations) {
    const iso = r.date.toISOString().slice(0, 10);
    const arr = datesByAd.get(r.ad_id) || [];
    arr.push(iso);
    datesByAd.set(r.ad_id, arr);
  }
  let monThuCents = 0;
  let friSunCents = 0;
  for (const adId of adIds) {
    const { weekdayBlocks, weekendBlocks } = calculateAdPriceCents(datesByAd.get(adId) || []);
    monThuCents += weekdayBlocks * WEEKDAY_BLOCK_PRICE_CENTS;
    friSunCents += weekendBlocks * WEEKEND_BLOCK_PRICE_CENTS;
  }

  const totalImpressions = ads.reduce((sum, a) => sum + (a.impression_count || 0), 0);
  const totalClicks = ads.reduce((sum, a) => sum + (a.click_count || 0), 0);

  return {
    totalRevenueCents,
    adCount: adIds.length,
    byZipCode: Object.fromEntries(byZipCode),
    byBusiness: Object.fromEntries(byBusiness),
    byTimeWindow: { mon_thu_cents: monThuCents, fri_sun_cents: friSunCents },
    totalImpressions,
    totalClicks,
  };
}

/**
 * Get end-of-day transaction report
 */
export async function getEndOfDayReport(date?: Date) {
  const targetDate = date || new Date();
  const startOfDay = new Date(targetDate);
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date(targetDate);
  endOfDay.setHours(23, 59, 59, 999);

  const [summary, breakdown, statusBreakdown] = await Promise.all([
    getTransactionSummary(startOfDay, endOfDay),
    getTransactionBreakdownByType(startOfDay, endOfDay),
    // Get breakdown by status
    prisma.transactionLog
      .groupBy({
        by: ['status'],
        where: {
          created_at: {
            gte: startOfDay,
            lte: endOfDay,
          },
        },
        _count: { id: true },
      })
      .catch(() => []),
  ]);

  return {
    date: targetDate.toISOString().split('T')[0],
    summary,
    breakdownByType: breakdown,
    breakdownByStatus: statusBreakdown.map(s => ({
      status: s.status,
      count: s._count.id,
    })),
  };
}
