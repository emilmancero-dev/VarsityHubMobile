import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { describeDb } from './helpers/dbTestSuite.js';
import { getAdRevenueReport } from '../lib/transactionLogger.js';

let prisma: any;
let dbReady = false;

// VARSITYHUB COMMANDMENTS: "Revenue tracking by: zip code, time window (M-Th
// vs F-Su), business, impressions and clicks per ad." This pins the
// aggregation logic against a real ad + reservations + completed transaction.
describeDb('getAdRevenueReport', () => {
  const adIds: string[] = [];
  const txIds: string[] = [];
  const ts = Date.now();

  beforeAll(async () => {
    ({ prisma } = await import('../lib/prisma.js'));
    try {
      await prisma.$queryRawUnsafe('SELECT 1');
      dbReady = true;
    } catch {
      dbReady = false;
    }
  });

  afterAll(async () => {
    if (!prisma || !dbReady) return;
    if (txIds.length) {
      await prisma.transactionLog.deleteMany({ where: { id: { in: txIds } } }).catch(() => {});
    }
    if (adIds.length) {
      await prisma.adReservation.deleteMany({ where: { ad_id: { in: adIds } } }).catch(() => {});
      await prisma.ad.deleteMany({ where: { id: { in: adIds } } }).catch(() => {});
    }
  });

  it('aggregates revenue by zip code, business, and time window from real purchase rows', async () => {
    if (!dbReady) return;

    const ad = await prisma.ad.create({
      data: {
        business_name: `Revenue Report Test Biz ${ts}`,
        target_zip_code: '90210',
        impression_count: 10,
        click_count: 2,
        status: 'approved',
        payment_status: 'paid',
      },
    });
    adIds.push(ad.id);

    // Monday (weekday) + Saturday (weekend) of the same week — one purchase
    // spanning both pricing blocks, per the PDF's per-window pricing model.
    await prisma.adReservation.create({ data: { ad_id: ad.id, date: new Date('2026-09-14') } }); // Mon
    await prisma.adReservation.create({ data: { ad_id: ad.id, date: new Date('2026-09-19') } }); // Sat

    const tx = await prisma.transactionLog.create({
      data: {
        transaction_type: 'AD_PURCHASE',
        status: 'COMPLETED',
        order_id: ad.id,
        user_email: 'advertiser@example.com',
        total_cents: 1298, // 499 (weekday block) + 799 (weekend block)
      },
    });
    txIds.push(tx.id);

    const report = await getAdRevenueReport();

    expect(report.totalRevenueCents).toBeGreaterThanOrEqual(1298);
    expect(report.byZipCode['90210']).toBeGreaterThanOrEqual(1298);
    expect(report.byBusiness[ad.business_name]).toBeGreaterThanOrEqual(1298);
    // One Mon-Thu block ($4.99) and one Fri-Sun block ($7.99) — both windows present.
    expect(report.byTimeWindow.mon_thu_cents).toBeGreaterThanOrEqual(499);
    expect(report.byTimeWindow.fri_sun_cents).toBeGreaterThanOrEqual(799);
    expect(report.totalImpressions).toBeGreaterThanOrEqual(10);
    expect(report.totalClicks).toBeGreaterThanOrEqual(2);
  });

  it('excludes non-completed and non-ad-purchase transactions', async () => {
    if (!dbReady) return;

    const before = await getAdRevenueReport();

    const pendingTx = await prisma.transactionLog.create({
      data: {
        transaction_type: 'AD_PURCHASE',
        status: 'PENDING',
        order_id: 'irrelevant-pending',
        total_cents: 999999,
      },
    });
    txIds.push(pendingTx.id);

    const subTx = await prisma.transactionLog.create({
      data: {
        transaction_type: 'SUBSCRIPTION_PURCHASE',
        status: 'COMPLETED',
        order_id: 'irrelevant-sub',
        total_cents: 999999,
      },
    });
    txIds.push(subTx.id);

    const after = await getAdRevenueReport();
    expect(after.totalRevenueCents).toBe(before.totalRevenueCents);
  });
});
