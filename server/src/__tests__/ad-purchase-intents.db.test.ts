import { beforeAll, afterAll, afterEach, describe, expect, it, jest } from '@jest/globals';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
const capture = jest.fn();
jest.unstable_mockModule('../lib/sentry.js', () => ({
  captureException: capture,
  addBreadcrumb: jest.fn(),
  captureMessage: jest.fn(),
}));
// Provider signature verification has a separate real-crypto forgery regression.
// Only this external boundary is substituted; storage, constraints and fulfillment are real PostgreSQL.
jest.unstable_mockModule('../lib/appleSignedJws.js', () => ({
  verifyAppleSignedJws: async (jws: string) => JSON.parse(jws),
}));
const { prisma } = await import('../lib/prisma.js');
const service = await import('../lib/adPurchaseIntents.js');
const users: string[] = [],
  ads: string[] = [];
const monday = new Date();
monday.setUTCDate(monday.getUTCDate() + ((8 - monday.getUTCDay()) % 7 || 7));
const friday = new Date(monday);
friday.setUTCDate(friday.getUTCDate() + 4);
const dates = [monday, friday].map(date => date.toISOString().slice(0, 10));
const replacementDates = [monday, friday].map(date => {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + 7);
  return next.toISOString().slice(0, 10);
});
async function fixture() {
  const user = await prisma.user.create({
    data: { email: `intent-${randomUUID()}@example.invalid`, email_verified: true },
  });
  users.push(user.id);
  const ad = await prisma.ad.create({
    data: {
      user_id: user.id,
      status: 'approved',
      business_name: 'Isolated purchase test',
      target_zip_code: `T${randomUUID().slice(0, 8)}`,
    },
  });
  ads.push(ad.id);
  const intent = await service.createAdPurchaseIntent(user.id, {
    ad_id: ad.id,
    client_transaction_id: randomUUID(),
    dates,
  });
  const receipt = (sku: string) =>
    JSON.stringify({
      appAccountToken: intent.id,
      transactionId: `${intent.id}-${sku}`,
      productId: sku,
      quantity: 1,
    });
  return { user, ad, intent, receipt };
}
beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  expect(['localhost', '127.0.0.1', '[::1]']).toContain(url.hostname);
  const [marker] = await prisma.$queryRawUnsafe<Array<{ value: string }>>(
    "SELECT current_setting('varsity.restore_isolated', true) AS value"
  );
  expect(marker.value).toBe('on');
});
afterEach(async () => {
  await prisma.$executeRawUnsafe(
    'DROP TRIGGER IF EXISTS intent_test_failure ON "AdPurchaseIntent"'
  );
  await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS intent_test_failure()');
  await prisma.adPurchaseIntent.deleteMany({ where: { ad_id: { in: ads } } });
  await prisma.appleTransactionClaim.deleteMany({ where: { ad_id: { in: ads } } });
  await prisma.transactionLog.deleteMany({ where: { user_id: { in: users } } });
  await prisma.ad.deleteMany({ where: { id: { in: ads } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  users.length = 0;
  ads.length = 0;
});
afterAll(async () => {
  await prisma.$disconnect();
});
describe('durable ad purchase recovery against PostgreSQL', () => {
  it('rotates a failing Apple batch so a later recoverable purchase still completes', async () => {
    const failing = await fixture(),
      healthy = await fixture();
    const prefix = randomUUID();
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const expiry = new Date(Date.now() + 86400000).toISOString();
    await prisma.transactionLog.createMany({
      data: Array.from({ length: 50 }, (_, n) => ({
        user_id: failing.user.id,
        transaction_type: 'SUBSCRIPTION_PURCHASE',
        status: 'PENDING',
        order_id: `retry-original-${prefix}-${n}`,
        apple_transaction_id: `retry-${prefix}-${n}`,
        metadata: { source: 'apple_iap_jws', productId: 'MIDTIER', apple_expires_date: expiry },
        created_at: old,
        updated_at: old,
      })),
    });
    const pending = await prisma.transactionLog.create({
      data: {
        user_id: healthy.user.id,
        transaction_type: 'SUBSCRIPTION_PURCHASE',
        status: 'PENDING',
        order_id: `retry-original-${prefix}`,
        apple_transaction_id: `retry-${prefix}`,
        metadata: { source: 'apple_iap_jws', productId: 'MIDTIER', apple_expires_date: expiry },
        created_at: new Date(Date.now() - 2 * 60 * 60 * 1000),
        updated_at: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
    });
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION recovery_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${failing.user.id}' THEN RAISE EXCEPTION 'injected account write failure'; END IF; RETURN NEW; END $$`
    );
    try {
      await prisma.$executeRawUnsafe(
        'CREATE TRIGGER recovery_test_failure BEFORE UPDATE ON "User" FOR EACH ROW EXECUTE FUNCTION recovery_test_failure()'
      );
      const { reconcileAppleIapOrphans } = await import('../lib/appleIapReconciliation.js');
      await reconcileAppleIapOrphans();
      await reconcileAppleIapOrphans();
      expect(
        (await prisma.transactionLog.findUniqueOrThrow({ where: { id: pending.id } })).status
      ).toBe('COMPLETED');
      expect(
        await prisma.transactionLog.count({
          where: { user_id: failing.user.id, status: 'PENDING' },
        })
      ).toBe(50);
      expect(capture).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ context: 'apple_iap_reconciliation_recovery_failed' })
      );
    } finally {
      await prisma.$executeRawUnsafe('DROP TRIGGER IF EXISTS recovery_test_failure ON "User"');
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS recovery_test_failure()');
    }
  });
  it('quarantines legacy rows with missing evidence so they cannot starve recoverable purchases', async () => {
    const { user } = await fixture();
    const prefix = randomUUID();
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    await prisma.transactionLog.createMany({
      data: Array.from({ length: 50 }, (_, n) => ({
        user_id: user.id,
        transaction_type: 'AD_PURCHASE',
        status: 'PENDING',
        order_id: `missing-evidence-${prefix}-${n}`,
        metadata: { source: 'apple_iap' },
        created_at: old,
        updated_at: old,
      })),
    });
    const orphan = await prisma.transactionLog.create({
      data: {
        user_id: user.id,
        transaction_type: 'SUBSCRIPTION_PURCHASE',
        status: 'PENDING',
        apple_transaction_id: `apple-${prefix}`,
        order_id: `apple-original-${prefix}`,
        metadata: {
          source: 'apple_iap_jws',
          productId: 'MIDTIER',
          apple_expires_date: new Date(Date.now() + 86400000).toISOString(),
        },
        created_at: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
    });
    const { reconcileAppleIapOrphans } = await import('../lib/appleIapReconciliation.js');
    await reconcileAppleIapOrphans();
    await reconcileAppleIapOrphans();
    expect(
      (await prisma.transactionLog.findUniqueOrThrow({ where: { id: orphan.id } })).status
    ).toBe('COMPLETED');
    expect(
      await prisma.transactionLog.count({
        where: {
          user_id: user.id,
          order_id: { startsWith: `missing-evidence-${prefix}-` },
          status: 'NEEDS_REVIEW',
        },
      })
    ).toBe(50);
  });
  it('recovers an Apple orphan even when more than one batch of older Stripe purchases is pending', async () => {
    const { user } = await fixture();
    const prefix = randomUUID();
    await prisma.transactionLog.createMany({
      data: Array.from({ length: 55 }, (_, n) => ({
        user_id: user.id,
        transaction_type: 'SUBSCRIPTION_PURCHASE',
        status: 'PENDING',
        stripe_session_id: `stripe-pending-${prefix}-${n}`,
        metadata: { plan: 'veteran' },
        created_at: new Date(Date.now() - 3 * 60 * 60 * 1000),
      })),
    });
    const orphan = await prisma.transactionLog.create({
      data: {
        user_id: user.id,
        transaction_type: 'SUBSCRIPTION_PURCHASE',
        status: 'PENDING',
        apple_transaction_id: `apple-${prefix}`,
        order_id: `apple-original-${prefix}`,
        metadata: {
          source: 'apple_iap_jws',
          productId: 'MIDTIER',
          apple_expires_date: new Date(Date.now() + 86400000).toISOString(),
        },
        created_at: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
    });
    const { reconcileAppleIapOrphans } = await import('../lib/appleIapReconciliation.js');
    await reconcileAppleIapOrphans();
    expect(
      (await prisma.transactionLog.findUniqueOrThrow({ where: { id: orphan.id } })).status
    ).toBe('COMPLETED');
    expect(
      await prisma.transactionLog.count({
        where: {
          user_id: user.id,
          stripe_session_id: { startsWith: `stripe-pending-${prefix}-` },
          status: 'PENDING',
        },
      })
    ).toBe(55);
  });
  it('moves an expired fully paid intent and five concurrent retries fulfill only once', async () => {
    const { user, ad, intent, receipt } = await fixture();
    await service.recordAdPurchaseReceipt(user.id, intent.id, receipt('MOND_THURS'));
    const expired = dates.map(date => {
      const past = new Date(`${date}T00:00:00Z`);
      past.setUTCDate(past.getUTCDate() - 28);
      return past.toISOString().slice(0, 10);
    });
    await prisma.adPurchaseIntent.update({ where: { id: intent.id }, data: { dates: expired } });
    await expect(
      service.recordAdPurchaseReceipt(user.id, intent.id, receipt('FRI_SUN'))
    ).rejects.toMatchObject({ code: 'BOOKING_DATES_EXPIRED' });
    expect(await prisma.adPurchaseReceipt.count({ where: { intent_id: intent.id } })).toBe(2);
    // Original checkout cannot recover this purchase: it refuses replacement dates.
    await expect(
      service.createAdPurchaseIntent(user.id, {
        ad_id: ad.id,
        dates: replacementDates,
        client_transaction_id: randomUUID(),
      })
    ).rejects.toMatchObject({ code: 'RESUME_EXISTING_PURCHASE_DATES' });
    const recovered = await Promise.all(
      Array.from({ length: 5 }, () =>
        service.reviseAdPurchaseIntentDates(user.id, intent.id, {
          dates: replacementDates,
          expected_dates: expired,
        })
      )
    );
    expect(recovered.every(row => row.status === 'completed')).toBe(true);
    expect(await prisma.adPurchaseReceipt.count({ where: { intent_id: intent.id } })).toBe(2);
    expect(await prisma.adPurchaseIntentRevision.count({ where: { intent_id: intent.id } })).toBe(
      1
    );
    expect(
      await prisma.transactionLog.count({ where: { order_id: ad.id, status: 'COMPLETED' } })
    ).toBe(1);
    const booked = await prisma.adReservation.findMany({
      where: { ad_id: ad.id },
      orderBy: { date: 'asc' },
    });
    expect(booked.map(row => row.date.toISOString().slice(0, 10))).toEqual(replacementDates);
  });
  it('preserves partial payment and rejects account, price and stale-date changes', async () => {
    const { user, ad, intent, receipt } = await fixture();
    await service.recordAdPurchaseReceipt(user.id, intent.id, receipt('MOND_THURS'));
    const change = { dates: replacementDates, expected_dates: dates };
    await expect(
      service.reviseAdPurchaseIntentDates(`not-${user.id}`, intent.id, change)
    ).rejects.toMatchObject({ code: 'PURCHASE_INTENT_NOT_FOUND' });
    await expect(
      service.reviseAdPurchaseIntentDates(user.id, intent.id, {
        dates: [replacementDates[1]],
        expected_dates: dates,
      })
    ).rejects.toMatchObject({ code: 'REPLACEMENT_PRODUCT_MISMATCH' });
    const updated = await service.reviseAdPurchaseIntentDates(user.id, intent.id, change);
    expect(updated.items.find(row => row.sku === 'MOND_THURS')?.remaining).toBe(0);
    expect(updated.items.find(row => row.sku === 'FRI_SUN')?.remaining).toBe(1);
    expect(updated.status).toBe('pending');
    expect(await prisma.adReservation.count({ where: { ad_id: ad.id } })).toBe(0);
    await expect(
      service.reviseAdPurchaseIntentDates(user.id, intent.id, {
        dates,
        expected_dates: dates,
      })
    ).rejects.toMatchObject({ code: 'PURCHASE_DATES_CHANGED' });
    await service.recordAdPurchaseReceipt(user.id, intent.id, receipt('FRI_SUN'));
    await expect(
      service.reviseAdPurchaseIntentDates(user.id, intent.id, {
        dates,
        expected_dates: replacementDates,
      })
    ).rejects.toMatchObject({ code: 'PURCHASE_ALREADY_COMPLETED' });
  });
  it('rolls back changed holds and dates when replacement inventory is unavailable', async () => {
    const { user, ad, intent } = await fixture();
    const competitors = await Promise.all([fixture(), fixture()]);
    for (const other of competitors) {
      await prisma.ad.update({
        where: { id: other.ad.id },
        data: { target_zip_code: ad.target_zip_code },
      });
      await prisma.adSlotHold.createMany({
        data: replacementDates.map(date => ({
          ad_id: other.ad.id,
          date: new Date(`${date}T00:00:00Z`),
          purchase_reference: `capacity-${other.intent.id}`,
          expires_at: new Date(Date.now() + 600000),
        })),
      });
    }
    await expect(
      service.reviseAdPurchaseIntentDates(user.id, intent.id, {
        dates: replacementDates,
        expected_dates: dates,
      })
    ).rejects.toThrow('SLOT_FULL');
    const preserved = await prisma.adPurchaseIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(preserved.dates).toEqual(dates);
    const holds = await prisma.adSlotHold.findMany({
      where: { ad_id: ad.id },
      orderBy: { date: 'asc' },
    });
    expect(holds.map(row => row.date.toISOString().slice(0, 10))).toEqual(dates);
    expect(await prisma.adPurchaseIntentRevision.count({ where: { intent_id: intent.id } })).toBe(
      0
    );
    expect(capture).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        context: 'ad_intent_date_revision',
        intent_id: intent.id,
      })
    );
  });
  it('recovers in a fresh process after receipts commit but fulfillment is interrupted', async () => {
    const { user, ad, intent, receipt } = await fixture();
    await service.recordAdPurchaseReceipt(user.id, intent.id, receipt('MOND_THURS'));
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION intent_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${intent.id}' AND NEW.status='completed' THEN RAISE EXCEPTION 'injected fulfillment interruption'; END IF; RETURN NEW; END $$`
    );
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER intent_test_failure BEFORE UPDATE ON "AdPurchaseIntent" FOR EACH ROW EXECUTE FUNCTION intent_test_failure()'
    );
    await expect(
      service.recordAdPurchaseReceipt(user.id, intent.id, receipt('FRI_SUN'))
    ).rejects.toThrow();
    expect(await prisma.adPurchaseReceipt.count({ where: { intent_id: intent.id } })).toBe(2);
    expect(await prisma.adReservation.count({ where: { ad_id: ad.id } })).toBe(0);
    expect(await prisma.appleTransactionClaim.count({ where: { ad_id: ad.id } })).toBe(0);
    expect(capture).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ context: 'ad_intent_reconciliation', intent_id: intent.id })
    );
    await prisma.$executeRawUnsafe('DROP TRIGGER intent_test_failure ON "AdPurchaseIntent"');
    await prisma.$executeRawUnsafe('DROP FUNCTION intent_test_failure()');
    // A new Node process has no checkout ref, promises, mock verifier or receipt memory.
    await promisify(execFile)(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `const {reconcileReadyAdPurchases}=await import('./src/lib/adPurchaseIntents.ts'); const {prisma}=await import('./src/lib/prisma.ts'); await reconcileReadyAdPurchases(${JSON.stringify(user.id)}); await prisma.$disconnect();`,
      ],
      { cwd: process.cwd(), env: process.env, timeout: 30000 }
    );
    const recovered = await prisma.adPurchaseIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(recovered.status).toBe('completed');
    expect(recovered.completed_transaction_id).not.toBeNull();
    expect(await prisma.adReservation.count({ where: { ad_id: ad.id } })).toBe(2);
  });
  it('five concurrent deliveries fulfill exactly once', async () => {
    const { user, ad, intent, receipt } = await fixture();
    await service.recordAdPurchaseReceipt(user.id, intent.id, receipt('MOND_THURS'));
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        service.recordAdPurchaseReceipt(user.id, intent.id, receipt('FRI_SUN'))
      )
    );
    expect(results.every(result => result.status === 'completed')).toBe(true);
    expect(await prisma.adPurchaseReceipt.count({ where: { intent_id: intent.id } })).toBe(2);
    expect(await prisma.appleTransactionClaim.count({ where: { ad_id: ad.id } })).toBe(2);
    expect(
      await prisma.transactionLog.count({
        where: { user_id: user.id, order_id: ad.id, status: 'COMPLETED' },
      })
    ).toBe(1);
    expect(await prisma.adReservation.count({ where: { ad_id: ad.id } })).toBe(2);
  });
  it('rejects a different account and rejects completion without a ledger row', async () => {
    const { user, intent, receipt } = await fixture();
    await expect(
      service.recordAdPurchaseReceipt(`not-${user.id}`, intent.id, receipt('MOND_THURS'))
    ).rejects.toMatchObject({ code: 'PURCHASE_INTENT_NOT_FOUND' });
    expect(await prisma.adPurchaseReceipt.count({ where: { intent_id: intent.id } })).toBe(0);
    await expect(
      prisma.adPurchaseIntent.update({ where: { id: intent.id }, data: { status: 'completed' } })
    ).rejects.toThrow();
    await expect(
      prisma.adPurchaseIntent.update({
        where: { id: intent.id },
        data: { status: 'completed', completed_transaction_id: 'missing-ledger' },
      })
    ).rejects.toThrow();
  });
});
