import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from './prisma.js';
import { reserveAdSlots } from './adInventory.js';
import { AD_PRODUCT_CENTS, finalizeAppleAdPurchase } from './paymentInternals.js';
import { verifyAppleSignedJws } from './appleSignedJws.js';
import { appleAdTransactionSchema } from './appleAdTransaction.js';
import { adDateSchema, calculateAdPriceCents } from '../utils/adPricing.js';
import { getDatesPastBookingHorizon } from '../utils/bookingHorizon.js';
import { captureException } from './sentry.js';

export class AdIntentError extends Error {
  constructor(
    public code: string,
    public statusCode = 409
  ) {
    super(code);
  }
}
const intentInclude = { items: { include: { receipts: true } } } as const;
type Intent = Prisma.AdPurchaseIntentGetPayload<{ include: typeof intentInclude }>;
export function serializeAdIntent(intent: Intent) {
  return {
    id: intent.id,
    ad_id: intent.ad_id,
    status: intent.status,
    dates: intent.dates,
    last_error_code: intent.last_error_code,
    items: intent.items.map(item => ({
      sku: item.sku,
      quantity: item.quantity,
      remaining: Math.max(
        0,
        item.quantity - item.receipts.reduce((sum, row) => sum + row.quantity, 0)
      ),
    })),
  };
}
async function serializable<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(fn, { isolationLevel: 'Serializable', timeout: 15000 });
    } catch (error: any) {
      if (
        (error?.code !== 'P2034' && !(error?.code === 'P2010' && error?.meta?.code === '40001')) ||
        attempt >= 4
      )
        throw error;
    }
  }
}
export async function createAdPurchaseIntent(userId: string, input: unknown) {
  const body = z
    .object({
      ad_id: z.string().min(1),
      client_transaction_id: z.string().uuid(),
      dates: z.array(adDateSchema).min(1).max(56),
    })
    .strict()
    .parse(input);
  const dates = [...new Set(body.dates)].sort();
  const today = new Date().toISOString().slice(0, 10);
  if (dates.some(date => date < today) || getDatesPastBookingHorizon(dates, new Date(), 56).length)
    throw new AdIntentError('INVALID_BOOKING_DATES', 400);
  const pricing = calculateAdPriceCents(dates);
  return serializable(async tx => {
    await tx.$queryRaw`SELECT id FROM "Ad" WHERE id=${body.ad_id} FOR UPDATE`;
    const ad = await tx.ad.findUnique({ where: { id: body.ad_id } });
    if (!ad || ad.user_id !== userId) throw new AdIntentError('AD_NOT_FOUND', 404);
    if (!['approved', 'active', 'archived'].includes(ad.status))
      throw new AdIntentError('AD_NOT_APPROVED', 403);
    const reusedId = await tx.adPurchaseIntent.findUnique({
      where: { client_transaction_id: body.client_transaction_id },
      include: intentInclude,
    });
    if (
      reusedId &&
      (reusedId.user_id !== userId ||
        reusedId.ad_id !== ad.id ||
        JSON.stringify(reusedId.dates) !== JSON.stringify(dates))
    )
      throw new AdIntentError('PURCHASE_INTENT_CONFLICT');
    if (reusedId) return serializeAdIntent(reusedId);
    const existing = await tx.adPurchaseIntent.findFirst({
      where: { ad_id: ad.id, status: { in: ['pending', 'needs_action'] } },
      include: intentInclude,
    });
    if (existing) {
      if (existing.user_id !== userId) throw new AdIntentError('PURCHASE_INTENT_CONFLICT');
      if (JSON.stringify(existing.dates) !== JSON.stringify(dates))
        throw new AdIntentError('RESUME_EXISTING_PURCHASE_DATES');
      return serializeAdIntent(existing);
    }
    const id = randomUUID();
    // Make concurrent create snapshots conflict even when this ad is already paid.
    await tx.ad.update({ where: { id: ad.id }, data: { updated_at: new Date() } });
    await reserveAdSlots(tx, {
      adId: ad.id,
      isoDates: dates,
      paymentStatus: 'hold',
      purchaseReference: `apple-intent:${id}`,
    });
    const items = [
      {
        sku: 'MOND_THURS',
        quantity: pricing.weekdayBlocks,
        unit_cents: AD_PRODUCT_CENTS.MOND_THURS,
      },
      { sku: 'FRI_SUN', quantity: pricing.weekendBlocks, unit_cents: AD_PRODUCT_CENTS.FRI_SUN },
    ].filter(item => item.quantity > 0);
    const intent = await tx.adPurchaseIntent.create({
      data: {
        id,
        user_id: userId,
        ad_id: ad.id,
        client_transaction_id: body.client_transaction_id,
        dates,
        items: { create: items },
      },
      include: intentInclude,
    });
    return serializeAdIntent(intent);
  });
}
async function lockedIntent(tx: Prisma.TransactionClient, id: string, userId?: string) {
  await tx.$queryRaw`SELECT id FROM "AdPurchaseIntent" WHERE id=${id}::uuid FOR UPDATE`;
  const intent = await tx.adPurchaseIntent.findUnique({ where: { id }, include: intentInclude });
  if (!intent || (userId && intent.user_id !== userId))
    throw new AdIntentError('PURCHASE_INTENT_NOT_FOUND', 404);
  return intent;
}

/** Explicit owner action: reuse the same purchased products on replacement dates. */
export async function reviseAdPurchaseIntentDates(userId: string, id: string, input: unknown) {
  const body = z
    .object({
      dates: z.array(adDateSchema).min(1).max(56),
      expected_dates: z.array(adDateSchema).min(1).max(56),
    })
    .strict()
    .parse(input);
  const dates = [...new Set(body.dates)].sort();
  const expectedDates = [...new Set(body.expected_dates)].sort();
  const today = new Date().toISOString().slice(0, 10);
  if (dates.some(date => date < today) || getDatesPastBookingHorizon(dates, new Date(), 56).length)
    throw new AdIntentError('INVALID_BOOKING_DATES', 400);
  const pricing = calculateAdPriceCents(dates);
  try {
    await serializable(async tx => {
      const intent = await lockedIntent(tx, id, userId);
      // A retry after a lost response must not charge or revise history again.
      if (JSON.stringify(intent.dates) === JSON.stringify(dates)) return;
      if (intent.status === 'completed') throw new AdIntentError('PURCHASE_ALREADY_COMPLETED');
      if (JSON.stringify(intent.dates) !== JSON.stringify(expectedDates))
        throw new AdIntentError('PURCHASE_DATES_CHANGED');
      const quantities = new Map(intent.items.map(item => [item.sku, item.quantity]));
      if (
        pricing.weekdayBlocks !== (quantities.get('MOND_THURS') || 0) ||
        pricing.weekendBlocks !== (quantities.get('FRI_SUN') || 0)
      )
        throw new AdIntentError('REPLACEMENT_PRODUCT_MISMATCH', 400);
      await tx.$queryRaw`SELECT id FROM "Ad" WHERE id=${intent.ad_id} FOR UPDATE`;
      const ad = await tx.ad.findUnique({ where: { id: intent.ad_id } });
      if (!ad || ad.user_id !== userId) throw new AdIntentError('AD_NOT_FOUND', 404);
      if (!['approved', 'active', 'archived'].includes(ad.status))
        throw new AdIntentError('AD_NOT_APPROVED', 403);
      const purchaseReference = `apple-intent:${id}`;
      // Only this unfinished intent's holds move. Paid reservations remain untouched.
      // On capacity failure the transaction restores the original holds and dates.
      await tx.adSlotHold.deleteMany({
        where: { ad_id: intent.ad_id, purchase_reference: purchaseReference },
      });
      await reserveAdSlots(tx, {
        adId: intent.ad_id,
        isoDates: dates,
        paymentStatus: 'hold',
        purchaseReference,
      });
      await tx.adPurchaseIntentRevision.create({
        data: { intent_id: id, before_dates: intent.dates, after_dates: dates },
      });
      await tx.adPurchaseIntent.update({
        where: { id },
        data: { dates, status: 'pending', last_error_code: null },
      });
    });
  } catch (error: any) {
    if (!(error instanceof AdIntentError)) {
      captureException(new Error('Ad purchase date revision failed'), {
        context: 'ad_intent_date_revision',
        intent_id: id,
        failure_code: error?.code || (error?.slotFull ? 'SLOT_FULL' : 'unknown'),
      });
    }
    if (error?.slotFull) throw new AdIntentError(error.code || 'SLOT_FULL');
    throw error;
  }
  // Full payment settles here without another StoreKit request. Partial payments
  // retain their receipts and await an explicit checkout for remaining products.
  return reconcileAdPurchaseIntent(id, userId);
}

export async function reconcileAdPurchaseIntent(id: string, userId?: string) {
  try {
    return await serializable(async tx => {
      const intent = await lockedIntent(tx, id, userId);
      const serialized = serializeAdIntent(intent);
      if (intent.status === 'completed' || serialized.items.some(item => item.remaining > 0))
        return serialized;
      if (intent.dates.some(date => date < new Date().toISOString().slice(0, 10)))
        throw new AdIntentError('BOOKING_DATES_EXPIRED');
      const receipts = intent.items.flatMap(item => item.receipts);
      const result = await finalizeAppleAdPurchase(
        {
          userId: intent.user_id,
          adId: intent.ad_id,
          dates: intent.dates,
          appleTransactionIds: receipts.map(receipt => receipt.apple_transaction_id),
          receiptsCount: receipts.length,
        },
        tx
      );
      if (!result.transactionLogId)
        throw new Error('Fulfillment did not return a durable transaction');
      await tx.adSlotHold.deleteMany({
        where: { ad_id: intent.ad_id, purchase_reference: `apple-intent:${intent.id}` },
      });
      const complete = await tx.adPurchaseIntent.update({
        where: { id },
        data: {
          status: 'completed',
          completed_transaction_id: result.transactionLogId,
          last_error_code: null,
          attempt_count: { increment: 1 },
        },
        include: intentInclude,
      });
      return serializeAdIntent(complete);
    });
  } catch (error: any) {
    if (error?.statusCode === 404) throw error;
    const needsAction = [
      'SLOT_FULL',
      'AD_DATES_ALREADY_BOOKED',
      'BOOKING_DATES_EXPIRED',
      'AD_NOT_APPROVED',
    ].includes(error?.code || error?.message);
    await prisma.adPurchaseIntent.updateMany({
      where: { id, ...(userId ? { user_id: userId } : {}), status: { not: 'completed' } },
      data: {
        status: needsAction ? 'needs_action' : 'pending',
        last_error_code: needsAction ? error.code || error.message : 'RECONCILIATION_RETRY',
        attempt_count: { increment: 1 },
      },
    });
    captureException(new Error('Ad intent reconciliation failed'), {
      context: 'ad_intent_reconciliation',
      intent_id: id,
      failure_class: needsAction ? 'needs_action' : 'retry',
    });
    throw error;
  }
}
const signedReceiptSchema = appleAdTransactionSchema.extend({
  appAccountToken: z.string().uuid(),
});
export async function recordAdPurchaseReceipt(
  userId: string | undefined,
  intentId: string,
  jws: string
) {
  const verified = signedReceiptSchema.parse(await verifyAppleSignedJws(jws));
  if (verified.appAccountToken.toLowerCase() !== intentId.toLowerCase())
    throw new AdIntentError('INVALID_INTENT_RECEIPT', 400);
  await serializable(async tx => {
    const intent = await lockedIntent(tx, intentId, userId);
    if (!intent.items.some(item => item.sku === verified.productId))
      throw new AdIntentError('UNEXPECTED_PURCHASE_PRODUCT', 400);
    const existing = await tx.adPurchaseReceipt.findUnique({
      where: { apple_transaction_id: verified.transactionId },
    });
    if (existing) {
      if (
        existing.intent_id !== intent.id ||
        existing.sku !== verified.productId ||
        existing.quantity !== verified.quantity
      )
        throw new AdIntentError('APPLE_TRANSACTION_ALREADY_CLAIMED');
      return;
    }
    if (intent.status === 'completed') throw new AdIntentError('PURCHASE_ALREADY_COMPLETED');
    await tx.adPurchaseReceipt.create({
      data: {
        apple_transaction_id: verified.transactionId,
        intent_id: intent.id,
        sku: verified.productId,
        quantity: verified.quantity,
      },
    });
    await tx.adPurchaseIntent.update({
      where: { id: intent.id },
      data: { updated_at: new Date() },
    });
  });
  // Receipt durability is independent of later inventory/fulfillment availability.
  return reconcileAdPurchaseIntent(intentId, userId);
}
export async function listAdPurchaseIntents(userId: string) {
  return (
    await prisma.adPurchaseIntent.findMany({
      where: { user_id: userId, status: { not: 'completed' } },
      include: intentInclude,
      orderBy: { created_at: 'asc' },
      take: 100,
    })
  ).map(serializeAdIntent);
}
export async function reconcileReadyAdPurchases(userId?: string) {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT p.id FROM "AdPurchaseIntent" p WHERE p.status='pending'
    ${userId ? Prisma.sql`AND p.user_id=${userId}` : Prisma.empty}
    AND EXISTS (SELECT 1 FROM "AdPurchaseIntentItem" i WHERE i.intent_id=p.id)
    AND NOT EXISTS (SELECT 1 FROM "AdPurchaseIntentItem" i WHERE i.intent_id=p.id AND i.quantity >
      (SELECT coalesce(sum(r.quantity),0) FROM "AdPurchaseReceipt" r WHERE r.intent_id=i.intent_id AND r.sku=i.sku))
    ORDER BY p.updated_at ASC LIMIT 100`;
  let failed = 0;
  for (const row of rows) {
    try {
      await reconcileAdPurchaseIntent(row.id, userId);
    } catch {
      failed++;
    }
  }
  if (failed) throw new Error(`Ad purchase reconciliation incomplete: ${failed}`);
  return { reconciled: rows.length };
}
