import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { describeDb } from './helpers/dbTestSuite.js';
import bcrypt from 'bcrypt';

let prisma: any;
let runFinalizeFromSession: (session: any) => Promise<void>;
let syncStripeSubscriptionState: (
  subscription: any,
  source?: 'subscription.updated' | 'subscription.finalize'
) => Promise<any>;
let finalizeAppleSubscriptionPurchase: (params: {
  userId: string;
  userEmail?: string | null;
  productId: string;
  originalTransactionId: string;
  appleTransactionId?: string | null;
  expiresAtIso?: string | null;
  source: string;
}) => Promise<{ ok: true; plan: string; expires: string | null; idempotent: boolean }>;
let finalizeAppleAdPurchase: (params: {
  userId: string;
  userEmail?: string | null;
  adId: string;
  dates: string[];
  appleTransactionIds: string[];
  receiptsCount: number;
}) => Promise<{ ok: true; idempotent: boolean; appleTransactionIds: string[] }>;
let releaseAdInventoryAfterSlotFullRefund: (adId: string) => Promise<void>;
let releaseAdInventoryAfterSlotFullRefundWithRetry: (adId: string) => Promise<void>;
let recoverSlotFullRefundReleaseFailures: (referenceTime?: Date) => Promise<number>;
let dbReady = false;

describeDb('Checkout session finalization', () => {
  const createdUserIds: string[] = [];
  const createdAdIds: string[] = [];
  const createdSessionIds: string[] = [];
  const createdAppleTransactionIds: string[] = [];

  beforeAll(async () => {
    ({ prisma } = await import('../lib/prisma.js'));
    const paymentsModule = await import('../lib/paymentInternals.js');
    const overnightTasksModule = await import('../cron/overnightTasks.js');
    runFinalizeFromSession = paymentsModule.runFinalizeFromSession;
    syncStripeSubscriptionState = paymentsModule.syncStripeSubscriptionState;
    finalizeAppleSubscriptionPurchase = paymentsModule.finalizeAppleSubscriptionPurchase;
    finalizeAppleAdPurchase = paymentsModule.finalizeAppleAdPurchase;
    releaseAdInventoryAfterSlotFullRefund = paymentsModule.releaseAdInventoryAfterSlotFullRefund;
    releaseAdInventoryAfterSlotFullRefundWithRetry =
      paymentsModule.releaseAdInventoryAfterSlotFullRefundWithRetry;
    recoverSlotFullRefundReleaseFailures =
      overnightTasksModule.recoverSlotFullRefundReleaseFailures;
    try {
      await prisma.$queryRawUnsafe('SELECT 1');
      dbReady = true;
    } catch {
      throw new Error(
        'Payment finalization tests require a reachable test database. The database connectivity check failed; no payment assertions ran.'
      );
    }
  });

  afterAll(async () => {
    if (!prisma || !dbReady) return;

    if (createdSessionIds.length) {
      await prisma.transactionLog
        .deleteMany({
          where: { stripe_session_id: { in: createdSessionIds } },
        })
        .catch(() => {});
    }

    if (createdAppleTransactionIds.length) {
      await prisma.transactionLog
        .deleteMany({
          where: { apple_transaction_id: { in: createdAppleTransactionIds } },
        })
        .catch(() => {});
      await prisma.appleTransactionClaim
        .deleteMany({
          where: { apple_transaction_id: { in: createdAppleTransactionIds } },
        })
        .catch(() => {});
    }

    if (createdAdIds.length || createdUserIds.length) {
      await prisma.transactionLog
        .deleteMany({
          where: {
            OR: [
              createdAdIds.length ? { order_id: { in: createdAdIds } } : undefined,
              createdUserIds.length
                ? {
                    user_id: { in: createdUserIds },
                    transaction_type: { in: ['SUBSCRIPTION_PURCHASE', 'AD_PURCHASE'] },
                  }
                : undefined,
            ].filter(Boolean) as any,
          },
        })
        .catch(() => {});
    }

    if (createdAdIds.length) {
      await prisma.adReservation
        .deleteMany({
          where: { ad_id: { in: createdAdIds } },
        })
        .catch(() => {});
      await prisma.ad
        .deleteMany({
          where: { id: { in: createdAdIds } },
        })
        .catch(() => {});
    }

    if (createdUserIds.length) {
      await prisma.user
        .deleteMany({
          where: { id: { in: createdUserIds } },
        })
        .catch(() => {});
    }
  });

  it('finalizes membership checkout and marks subscription transaction completed', async () => {
    const sessionId = `sess_membership_finalize_${Date.now()}`;
    createdSessionIds.push(sessionId);

    const user = await prisma.user.create({
      data: {
        email: `membership-finalize-${Date.now()}@example.com`,
        password_hash: await bcrypt.hash('TestPassword123!', 10),
        display_name: 'Membership Finalize User',
        email_verified: true,
        approval_status: 'APPROVED',
        preferences: {
          role: 'coach',
          plan: 'rookie',
          pending_plan: 'veteran',
          payment_pending: true,
          payment_approved: true,
          onboarding_completed: true,
        },
      },
    });
    createdUserIds.push(user.id);

    await prisma.transactionLog.create({
      data: {
        transaction_type: 'SUBSCRIPTION_PURCHASE',
        status: 'PENDING',
        stripe_session_id: sessionId,
        user_id: user.id,
        user_email: user.email,
        subtotal_cents: 1000,
        total_cents: 1000,
        currency: 'usd',
      },
    });

    await runFinalizeFromSession({
      id: sessionId,
      payment_status: 'paid',
      status: 'complete',
      amount_total: 1000,
      payment_intent: 'pi_membership_finalize_test',
      metadata: {
        user_id: user.id,
        plan: 'veteran',
        membership: '1',
        total_cents: '1000',
      },
      customer_details: { email: user.email },
    });

    const refreshedUser = await prisma.user.findUnique({ where: { id: user.id } });
    const tx = await prisma.transactionLog.findUnique({
      where: { stripe_session_id: sessionId },
    });

    const prefs =
      refreshedUser?.preferences && typeof refreshedUser.preferences === 'object'
        ? (refreshedUser.preferences as any)
        : {};

    expect(refreshedUser?.subscription_tier).toBe('premium');
    expect(refreshedUser?.subscription_status).toBe('active');
    expect(prefs.plan).toBe('veteran');
    expect(prefs.pending_plan).toBeNull();
    expect(prefs.payment_pending).toBe(false);
    expect(tx?.status).toBe('COMPLETED');
    expect(tx?.stripe_payment_intent_id).toBe('pi_membership_finalize_test');
  });

  it('syncs an active Stripe subscription into user entitlements and completion state', async () => {
    const now = Date.now();
    const subscriptionId = `sub_sync_finalize_${now}`;
    const customerId = `cus_sync_finalize_${now}`;
    createdSessionIds.push(subscriptionId);

    const user = await prisma.user.create({
      data: {
        email: `sub-sync-${now}@example.com`,
        password_hash: await bcrypt.hash('TestPassword123!', 10),
        display_name: 'Subscription Sync User',
        email_verified: true,
        approval_status: 'APPROVED',
        stripe_customer_id: customerId,
        preferences: {
          role: 'coach',
          plan: 'rookie',
          pending_plan: 'legend',
          payment_pending: true,
          payment_approved: true,
          onboarding_completed: true,
        },
      },
    });
    createdUserIds.push(user.id);

    await prisma.transactionLog.create({
      data: {
        transaction_type: 'SUBSCRIPTION_PURCHASE',
        status: 'PENDING',
        stripe_session_id: subscriptionId,
        user_id: user.id,
        user_email: user.email,
        subtotal_cents: 25000,
        total_cents: 25000,
        currency: 'usd',
      },
    });

    const result = await syncStripeSubscriptionState(
      {
        id: subscriptionId,
        customer: customerId,
        status: 'active',
        current_period_end: Math.floor(Date.now() / 1000) + 86400,
        metadata: { plan: 'legend' },
        items: {
          data: [
            {
              price: {
                id: 'inline_price_for_test',
              },
            },
          ],
        },
      },
      'subscription.finalize'
    );

    const refreshedUser = await prisma.user.findUnique({ where: { id: user.id } });
    const tx = await prisma.transactionLog.findUnique({
      where: { stripe_session_id: subscriptionId },
    });

    const prefs =
      refreshedUser?.preferences && typeof refreshedUser.preferences === 'object'
        ? (refreshedUser.preferences as any)
        : {};

    expect(result.entitlementActive).toBe(true);
    expect(result.plan).toBe('legend');
    expect(refreshedUser?.subscription_tier).toBe('pro');
    expect(refreshedUser?.subscription_status).toBe('active');
    expect(prefs.plan).toBe('legend');
    expect(prefs.subscription_id).toBe(subscriptionId);
    expect(prefs.payment_pending).toBe(false);
    expect(tx?.status).toBe('COMPLETED');
    expect(tx?.stripe_subscription_id).toBe(subscriptionId);
  });

  it('replays a pending Apple subscription purchase into a completed entitlement', async () => {
    const now = Date.now();
    const originalTransactionId = `apple-sub-original-${now}`;
    const appleTransactionId = `apple-sub-transaction-${now}`;
    createdAppleTransactionIds.push(appleTransactionId);

    const user = await prisma.user.create({
      data: {
        email: `apple-sub-finalize-${now}@example.com`,
        password_hash: await bcrypt.hash('TestPassword123!', 10),
        display_name: 'Apple Subscription Finalize User',
        email_verified: true,
        approval_status: 'APPROVED',
        preferences: {
          role: 'coach',
          plan: 'rookie',
          pending_plan: 'veteran',
          payment_pending: true,
          payment_approved: true,
          onboarding_completed: true,
        },
      },
    });
    createdUserIds.push(user.id);

    await prisma.transactionLog.create({
      data: {
        transaction_type: 'SUBSCRIPTION_PURCHASE',
        status: 'PENDING',
        user_id: user.id,
        user_email: user.email,
        order_id: originalTransactionId,
        apple_transaction_id: appleTransactionId,
        metadata: {
          source: 'apple_iap_jws',
          productId: 'MIDTIER',
          plan: 'veteran',
        },
      } as any,
    });

    const expiresAtIso = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const result = await finalizeAppleSubscriptionPurchase({
      userId: user.id,
      userEmail: user.email,
      productId: 'MIDTIER',
      originalTransactionId,
      appleTransactionId,
      expiresAtIso,
      source: 'apple_iap_reconciliation',
    });

    expect(result.ok).toBe(true);
    expect(result.idempotent).toBe(false);
    expect(result.plan).toBe('veteran');

    const refreshedUser = await prisma.user.findUnique({ where: { id: user.id } });
    const tx = await prisma.transactionLog.findUnique({
      where: { apple_transaction_id: appleTransactionId },
    });
    const prefs =
      refreshedUser?.preferences && typeof refreshedUser.preferences === 'object'
        ? (refreshedUser.preferences as any)
        : {};

    expect(refreshedUser?.subscription_tier).toBe('premium');
    expect(refreshedUser?.subscription_status).toBe('active');
    expect(prefs.plan).toBe('veteran');
    expect(prefs.pending_plan).toBeNull();
    expect(prefs.payment_pending).toBe(false);
    expect(prefs.apple_original_transaction_id).toBe(originalTransactionId);
    expect(prefs.apple_expires_date).toBe(expiresAtIso);
    expect(tx?.status).toBe('COMPLETED');
    expect((tx?.metadata as any)?.source).toBe('apple_iap_reconciliation');
  });

  it('finalizes ad checkout and marks ad transaction completed', async () => {
    const now = Date.now();
    const sessionId = `sess_ad_finalize_${now}`;
    createdSessionIds.push(sessionId);

    const user = await prisma.user.create({
      data: {
        email: `ad-finalize-${now}@example.com`,
        password_hash: await bcrypt.hash('TestPassword123!', 10),
        display_name: 'Ad Finalize User',
        email_verified: true,
        approval_status: 'APPROVED',
        preferences: { role: 'coach', plan: 'veteran', onboarding_completed: true },
      },
    });
    createdUserIds.push(user.id);

    const ad = await prisma.ad.create({
      data: {
        user_id: user.id,
        business_name: 'Finalize Test Ad',
        contact_email: user.email,
        target_zip_code: '10001',
        status: 'approved',
        payment_status: 'hold',
      },
    });
    createdAdIds.push(ad.id);

    const adDates = ['2035-01-02', '2035-01-03'];

    await prisma.transactionLog.create({
      data: {
        transaction_type: 'AD_PURCHASE',
        status: 'PENDING',
        stripe_session_id: sessionId,
        user_id: user.id,
        user_email: user.email,
        order_id: ad.id,
        subtotal_cents: 1300,
        total_cents: 1300,
        currency: 'usd',
      },
    });

    await runFinalizeFromSession({
      id: sessionId,
      payment_status: 'paid',
      status: 'complete',
      amount_total: 1300,
      payment_intent: 'pi_ad_finalize_test',
      metadata: {
        ad_id: ad.id,
        user_id: user.id,
        dates: JSON.stringify(adDates),
        total_cents: '1300',
      },
      customer_details: { email: user.email },
    });

    const refreshedAd = await prisma.ad.findUnique({ where: { id: ad.id } });
    const reservations = await prisma.adReservation.findMany({ where: { ad_id: ad.id } });
    const tx = await prisma.transactionLog.findUnique({
      where: { stripe_session_id: sessionId },
    });

    expect(refreshedAd?.payment_status).toBe('paid');
    expect(refreshedAd?.status).toBe('active');
    expect(reservations).toHaveLength(2);
    expect(tx?.status).toBe('COMPLETED');
    expect(tx?.stripe_payment_intent_id).toBe('pi_ad_finalize_test');
  });

  it('releases slot-full ad inventory back to unpaid in one DB step', async () => {
    const now = Date.now();
    const user = await prisma.user.create({
      data: {
        email: `ad-release-${now}@example.com`,
        password_hash: await bcrypt.hash('TestPassword123!', 10),
        display_name: 'Ad Release User',
        email_verified: true,
        approval_status: 'APPROVED',
        preferences: { role: 'coach', plan: 'veteran', onboarding_completed: true },
      },
    });
    createdUserIds.push(user.id);

    const ad = await prisma.ad.create({
      data: {
        user_id: user.id,
        business_name: 'Release Test Ad',
        contact_email: user.email,
        target_zip_code: '10009',
        status: 'approved',
        payment_status: 'hold',
      },
    });
    createdAdIds.push(ad.id);

    await prisma.adReservation.createMany({
      data: [
        { ad_id: ad.id, date: new Date('2035-05-01T00:00:00.000Z') },
        { ad_id: ad.id, date: new Date('2035-05-02T00:00:00.000Z') },
      ],
      skipDuplicates: true,
    });

    await releaseAdInventoryAfterSlotFullRefund(ad.id);

    const [refreshedAd, reservations] = await Promise.all([
      prisma.ad.findUnique({ where: { id: ad.id } }),
      prisma.adReservation.findMany({ where: { ad_id: ad.id } }),
    ]);

    expect(refreshedAd?.status).toBe('approved');
    expect(refreshedAd?.payment_status).toBe('unpaid');
    expect(reservations).toHaveLength(0);
  });

  it('retries slot-full inventory release successfully when the ad is still recoverable', async () => {
    const now = Date.now();
    const user = await prisma.user.create({
      data: {
        email: `ad-release-retry-${now}@example.com`,
        password_hash: await bcrypt.hash('TestPassword123!', 10),
        display_name: 'Ad Release Retry User',
        email_verified: true,
        approval_status: 'APPROVED',
        preferences: { role: 'coach', plan: 'veteran', onboarding_completed: true },
      },
    });
    createdUserIds.push(user.id);

    const ad = await prisma.ad.create({
      data: {
        user_id: user.id,
        business_name: 'Release Retry Test Ad',
        contact_email: user.email,
        target_zip_code: '10010',
        status: 'approved',
        payment_status: 'pending_approval',
      },
    });
    createdAdIds.push(ad.id);

    await prisma.adReservation.create({
      data: { ad_id: ad.id, date: new Date('2035-05-03T00:00:00.000Z') },
    });

    await releaseAdInventoryAfterSlotFullRefundWithRetry(ad.id);

    const [refreshedAd, reservations] = await Promise.all([
      prisma.ad.findUnique({ where: { id: ad.id } }),
      prisma.adReservation.findMany({ where: { ad_id: ad.id } }),
    ]);

    expect(refreshedAd?.payment_status).toBe('unpaid');
    expect(reservations).toHaveLength(0);
  });

  it('cron recovers slot-full refunds that were refunded but left marked release_pending', async () => {
    const now = Date.now();
    const user = await prisma.user.create({
      data: {
        email: `ad-release-recover-${now}@example.com`,
        password_hash: await bcrypt.hash('TestPassword123!', 10),
        display_name: 'Ad Release Recover User',
        email_verified: true,
        approval_status: 'APPROVED',
        preferences: { role: 'coach', plan: 'veteran', onboarding_completed: true },
      },
    });
    createdUserIds.push(user.id);

    const ad = await prisma.ad.create({
      data: {
        user_id: user.id,
        business_name: 'Release Recover Test Ad',
        contact_email: user.email,
        target_zip_code: '10011',
        status: 'approved',
        payment_status: 'hold',
      },
    });
    createdAdIds.push(ad.id);

    await prisma.adReservation.create({
      data: { ad_id: ad.id, date: new Date('2035-05-04T00:00:00.000Z') },
    });

    const tx = await prisma.transactionLog.create({
      data: {
        transaction_type: 'AD_PURCHASE',
        status: 'NEEDS_REVIEW',
        user_id: user.id,
        user_email: user.email,
        order_id: ad.id,
        metadata: {
          reason: 'slot_full_release_failed',
          stripe_refund_id: `re_${now}`,
          refunded_at: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
          release_pending: true,
        },
      } as any,
    });

    const recovered = await recoverSlotFullRefundReleaseFailures(
      new Date(now + 2 * 60 * 60 * 1000)
    );

    const [refreshedAd, reservations, refreshedTx] = await Promise.all([
      prisma.ad.findUnique({ where: { id: ad.id } }),
      prisma.adReservation.findMany({ where: { ad_id: ad.id } }),
      prisma.transactionLog.findUnique({ where: { id: tx.id } }),
    ]);

    expect(recovered).toBeGreaterThanOrEqual(1);
    expect(refreshedAd?.payment_status).toBe('unpaid');
    expect(reservations).toHaveLength(0);
    expect(refreshedTx?.status).toBe('REFUNDED');
    expect((refreshedTx?.metadata as any)?.release_pending).toBe(false);
    expect((refreshedTx?.metadata as any)?.release_recovered_at).toBeTruthy();
  });

  it('claims each Apple ad receipt transaction id and treats same-user retries as idempotent', async () => {
    const now = Date.now();
    const user = await prisma.user.create({
      data: {
        email: `apple-ad-claim-${now}@example.com`,
        password_hash: await bcrypt.hash('TestPassword123!', 10),
        display_name: 'Apple Ad Claim User',
        email_verified: true,
        approval_status: 'APPROVED',
        preferences: { role: 'coach', plan: 'veteran', onboarding_completed: true },
      },
    });
    createdUserIds.push(user.id);

    const ad = await prisma.ad.create({
      data: {
        user_id: user.id,
        business_name: 'Apple Claim Ad',
        contact_email: user.email,
        target_zip_code: '10002',
        status: 'approved',
        payment_status: 'hold',
      },
    });
    createdAdIds.push(ad.id);

    const appleTransactionIds = [`apple-ad-${now}-1`, `apple-ad-${now}-2`];
    createdAppleTransactionIds.push(...appleTransactionIds);

    const first = await finalizeAppleAdPurchase({
      userId: user.id,
      userEmail: user.email,
      adId: ad.id,
      dates: ['2035-02-01', '2035-02-02'],
      appleTransactionIds,
      receiptsCount: 2,
    });

    expect(first.ok).toBe(true);
    expect(first.idempotent).toBe(false);

    const claims = await prisma.appleTransactionClaim.findMany({
      where: { apple_transaction_id: { in: appleTransactionIds } },
      orderBy: { apple_transaction_id: 'asc' },
    });
    expect(claims).toHaveLength(2);
    expect(claims.every((claim: any) => claim.ad_id === ad.id && claim.order_id === ad.id)).toBe(
      true
    );

    const tx = await prisma.transactionLog.findFirst({
      where: {
        user_id: user.id,
        order_id: ad.id,
        transaction_type: 'AD_PURCHASE',
        status: 'COMPLETED',
      },
      orderBy: { created_at: 'desc' },
    });
    expect(tx).toBeTruthy();
    expect(tx?.apple_transaction_id).toBeNull();
    expect((tx?.metadata as any)?.apple_transaction_ids).toEqual(appleTransactionIds);

    const second = await finalizeAppleAdPurchase({
      userId: user.id,
      userEmail: user.email,
      adId: ad.id,
      dates: ['2035-02-01', '2035-02-02'],
      appleTransactionIds,
      receiptsCount: 2,
    });

    expect(second.ok).toBe(true);
    expect(second.idempotent).toBe(true);

    const txCount = await prisma.transactionLog.count({
      where: {
        user_id: user.id,
        order_id: ad.id,
        transaction_type: 'AD_PURCHASE',
        status: 'COMPLETED',
      },
    });
    expect(txCount).toBe(1);
  });

  it('rejects Apple ad receipt replay across different purchases', async () => {
    const now = Date.now();
    const [firstUser, secondUser] = await Promise.all([
      prisma.user.create({
        data: {
          email: `apple-ad-replay-a-${now}@example.com`,
          password_hash: await bcrypt.hash('TestPassword123!', 10),
          display_name: 'Apple Replay A',
          email_verified: true,
          approval_status: 'APPROVED',
          preferences: { role: 'coach', plan: 'veteran', onboarding_completed: true },
        },
      }),
      prisma.user.create({
        data: {
          email: `apple-ad-replay-b-${now}@example.com`,
          password_hash: await bcrypt.hash('TestPassword123!', 10),
          display_name: 'Apple Replay B',
          email_verified: true,
          approval_status: 'APPROVED',
          preferences: { role: 'coach', plan: 'veteran', onboarding_completed: true },
        },
      }),
    ]);
    createdUserIds.push(firstUser.id, secondUser.id);

    const [firstAd, secondAd] = await Promise.all([
      prisma.ad.create({
        data: {
          user_id: firstUser.id,
          business_name: 'Apple Replay Ad A',
          contact_email: firstUser.email,
          target_zip_code: '10003',
          status: 'approved',
          payment_status: 'hold',
        },
      }),
      prisma.ad.create({
        data: {
          user_id: secondUser.id,
          business_name: 'Apple Replay Ad B',
          contact_email: secondUser.email,
          target_zip_code: '10004',
          status: 'approved',
          payment_status: 'hold',
        },
      }),
    ]);
    createdAdIds.push(firstAd.id, secondAd.id);

    const sharedAppleTransactionId = `apple-ad-replay-${now}`;
    createdAppleTransactionIds.push(sharedAppleTransactionId);

    await finalizeAppleAdPurchase({
      userId: firstUser.id,
      userEmail: firstUser.email,
      adId: firstAd.id,
      dates: ['2035-03-01'],
      appleTransactionIds: [sharedAppleTransactionId],
      receiptsCount: 1,
    });

    await expect(
      finalizeAppleAdPurchase({
        userId: secondUser.id,
        userEmail: secondUser.email,
        adId: secondAd.id,
        dates: ['2035-03-02'],
        appleTransactionIds: [sharedAppleTransactionId],
        receiptsCount: 1,
      })
    ).rejects.toMatchObject({
      message: 'APPLE_TRANSACTION_ALREADY_CLAIMED',
      statusCode: 409,
    });
  });

  it('upgrades a pending Apple ad transaction log to completed instead of duplicating it', async () => {
    const now = Date.now();
    const appleTransactionId = `apple-ad-pending-${now}`;
    createdAppleTransactionIds.push(appleTransactionId);

    const user = await prisma.user.create({
      data: {
        email: `apple-ad-pending-${now}@example.com`,
        password_hash: await bcrypt.hash('TestPassword123!', 10),
        display_name: 'Apple Ad Pending User',
        email_verified: true,
        approval_status: 'APPROVED',
        preferences: { role: 'coach', plan: 'veteran', onboarding_completed: true },
      },
    });
    createdUserIds.push(user.id);

    const ad = await prisma.ad.create({
      data: {
        user_id: user.id,
        business_name: 'Apple Pending Ad',
        contact_email: user.email,
        target_zip_code: '10005',
        status: 'approved',
        payment_status: 'hold',
      },
    });
    createdAdIds.push(ad.id);

    const pendingTx = await prisma.transactionLog.create({
      data: {
        transaction_type: 'AD_PURCHASE',
        status: 'PENDING',
        user_id: user.id,
        user_email: user.email,
        order_id: ad.id,
        apple_transaction_id: appleTransactionId,
        metadata: {
          source: 'apple_iap',
          ad_id: ad.id,
          dates: ['2035-04-01'],
          receipts_count: 1,
          apple_transaction_ids: [appleTransactionId],
        },
      } as any,
    });

    const result = await finalizeAppleAdPurchase({
      userId: user.id,
      userEmail: user.email,
      adId: ad.id,
      dates: ['2035-04-01'],
      appleTransactionIds: [appleTransactionId],
      receiptsCount: 1,
    });

    expect(result.ok).toBe(true);
    expect(result.idempotent).toBe(false);

    const tx = await prisma.transactionLog.findUnique({ where: { id: pendingTx.id } });
    const txCount = await prisma.transactionLog.count({
      where: { user_id: user.id, order_id: ad.id, transaction_type: 'AD_PURCHASE' },
    });
    const reservations = await prisma.adReservation.findMany({ where: { ad_id: ad.id } });
    const refreshedAd = await prisma.ad.findUnique({ where: { id: ad.id } });

    expect(txCount).toBe(1);
    expect(tx?.status).toBe('COMPLETED');
    expect((tx?.metadata as any)?.apple_transaction_ids).toEqual([appleTransactionId]);
    expect(reservations).toHaveLength(1);
    expect(refreshedAd?.payment_status).toBe('paid');
    expect(refreshedAd?.status).toBe('active');
  });

  it('rejects Apple ad finalization when the target slot is already full and rolls back claims', async () => {
    const now = Date.now();
    const targetDate = '2035-04-01';
    const [buyer, competingUserA, competingUserB] = await Promise.all([
      prisma.user.create({
        data: {
          email: `apple-ad-slot-full-buyer-${now}@example.com`,
          password_hash: await bcrypt.hash('TestPassword123!', 10),
          display_name: 'Apple Slot Full Buyer',
          email_verified: true,
          approval_status: 'APPROVED',
          preferences: { role: 'coach', plan: 'veteran', onboarding_completed: true },
        },
      }),
      prisma.user.create({
        data: {
          email: `apple-ad-slot-full-a-${now}@example.com`,
          password_hash: await bcrypt.hash('TestPassword123!', 10),
          display_name: 'Apple Slot Full A',
          email_verified: true,
          approval_status: 'APPROVED',
          preferences: { role: 'coach', plan: 'veteran', onboarding_completed: true },
        },
      }),
      prisma.user.create({
        data: {
          email: `apple-ad-slot-full-b-${now}@example.com`,
          password_hash: await bcrypt.hash('TestPassword123!', 10),
          display_name: 'Apple Slot Full B',
          email_verified: true,
          approval_status: 'APPROVED',
          preferences: { role: 'coach', plan: 'veteran', onboarding_completed: true },
        },
      }),
    ]);
    createdUserIds.push(buyer.id, competingUserA.id, competingUserB.id);

    const [targetAd, competingAdA, competingAdB] = await Promise.all([
      prisma.ad.create({
        data: {
          user_id: buyer.id,
          business_name: 'Apple Slot Full Target',
          contact_email: buyer.email,
          target_zip_code: '10005',
          status: 'approved',
          payment_status: 'hold',
        },
      }),
      prisma.ad.create({
        data: {
          user_id: competingUserA.id,
          business_name: 'Apple Slot Full Existing A',
          contact_email: competingUserA.email,
          target_zip_code: '10005',
          status: 'active',
          payment_status: 'paid',
        },
      }),
      prisma.ad.create({
        data: {
          user_id: competingUserB.id,
          business_name: 'Apple Slot Full Existing B',
          contact_email: competingUserB.email,
          target_zip_code: '10005',
          status: 'approved',
          payment_status: 'hold',
        },
      }),
    ]);
    createdAdIds.push(targetAd.id, competingAdA.id, competingAdB.id);

    await prisma.adReservation.createMany({
      data: [
        { ad_id: competingAdA.id, date: new Date(`${targetDate}T00:00:00.000Z`) },
        { ad_id: competingAdB.id, date: new Date(`${targetDate}T00:00:00.000Z`) },
      ],
      skipDuplicates: true,
    });

    const appleTransactionIds = [`apple-ad-slot-full-${now}-1`, `apple-ad-slot-full-${now}-2`];
    createdAppleTransactionIds.push(...appleTransactionIds);

    await expect(
      finalizeAppleAdPurchase({
        userId: buyer.id,
        userEmail: buyer.email,
        adId: targetAd.id,
        dates: [targetDate],
        appleTransactionIds,
        receiptsCount: 2,
      })
    ).rejects.toMatchObject({
      message: 'SLOT_FULL',
      slotFull: true,
      dates: [targetDate],
    });

    const [refreshedTargetAd, targetReservations, tx, claims] = await Promise.all([
      prisma.ad.findUnique({ where: { id: targetAd.id } }),
      prisma.adReservation.findMany({ where: { ad_id: targetAd.id } }),
      prisma.transactionLog.findFirst({
        where: {
          user_id: buyer.id,
          order_id: targetAd.id,
          transaction_type: 'AD_PURCHASE',
        },
      }),
      prisma.appleTransactionClaim.findMany({
        where: { apple_transaction_id: { in: appleTransactionIds } },
      }),
    ]);

    expect(refreshedTargetAd?.payment_status).toBe('hold');
    expect(refreshedTargetAd?.status).toBe('approved');
    expect(targetReservations).toHaveLength(0);
    expect(tx).toBeNull();
    expect(claims).toHaveLength(0);
  });
});
