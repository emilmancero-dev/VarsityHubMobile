/**
 * Scheduler Service
 *
 * Sets up repeatable jobs for scheduled tasks:
 * - Game reminders (12hr and 1hr before)
 * - Daily digest emails
 * - Cleanup old notifications
 * - Push receipt verification
 *
 * Run with: npx ts-node server/src/jobs/scheduler.ts
 * Or configure as a Railway cron service
 *
 * @module jobs/scheduler
 */

import { Queue } from 'bullmq';
import { captureException, captureMessage } from '../lib/sentry.js';
import { runMonitoredJob } from '../lib/schedulerMonitoring.js';

// In-memory dedup for event reminder emails — used as fallback when Redis is unavailable
const eventRemindersSentFallback = new Set<string>();

// Clear fallback dedup cache daily to prevent unbounded memory growth
setInterval(
  () => {
    const size = eventRemindersSentFallback.size;
    if (size > 0) {
      eventRemindersSentFallback.clear();
      console.log(`[Scheduler] Cleared ${size} event reminder dedup entries (fallback set)`);
    }
  },
  24 * 60 * 60 * 1000
);

let _redisForDedup: any = null;
async function getRedisForDedup(): Promise<any | null> {
  if (_redisForDedup) return _redisForDedup;
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return null;
  try {
    const { default: Redis } = await import('ioredis');
    const RedisCtor = Redis as unknown as new (url: string, options?: any) => any;
    _redisForDedup = new RedisCtor(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true });
    await _redisForDedup.connect();
    return _redisForDedup;
  } catch {
    return null;
  }
}

async function isEventReminderSent(key: string): Promise<boolean> {
  try {
    const redis = await getRedisForDedup();
    if (redis) {
      const exists = await redis.exists(`event_reminder:${key}`);
      return exists === 1;
    }
  } catch {
    console.warn('[Scheduler] Redis dedup check failed — falling back to in-memory set');
  }
  return eventRemindersSentFallback.has(key);
}

async function markEventReminderSent(key: string): Promise<void> {
  try {
    const redis = await getRedisForDedup();
    if (redis) {
      await redis.set(`event_reminder:${key}`, '1', 'EX', 86400);
      return;
    }
  } catch {
    console.warn('[Scheduler] Redis dedup write failed — falling back to in-memory set');
  }
  eventRemindersSentFallback.add(key);
}

interface ScheduledJob {
  name: string;
  cron: string;
  handler: () => Promise<void>;
  description: string;
}

function withJobTags(jobName: string, context: Record<string, any> = {}) {
  return {
    ...context,
    job: jobName,
    tags: {
      ...(context.tags && typeof context.tags === 'object' ? context.tags : {}),
      job: jobName,
    },
  };
}

const SCHEDULED_JOBS: ScheduledJob[] = [
  {
    name: 'data-export-cleanup',
    cron: '*/15 * * * *',
    description: 'Expire private export archives, retry deletion and reap abandoned builds',
    handler: async () => {
      const { runDataExportCleanupSweep } = await import('../lib/dataExport/cleanup.js');
      const result = await runDataExportCleanupSweep();
      console.log('[data-export-cleanup]', result);
    },
  },
  {
    name: 'game-reminders-12hr',
    cron: '0 * * * *', // Every hour at minute 0
    description: 'Send 12-hour game reminders',
    handler: async () => {
      const { notifyUpcomingGames } = await import('../lib/notifications.js');
      await notifyUpcomingGames(12);
    },
  },
  {
    name: 'game-reminders-1hr',
    cron: '30 * * * *', // Every hour at minute 30
    description: 'Send 1-hour game reminders',
    handler: async () => {
      const { notifyUpcomingGames } = await import('../lib/notifications.js');
      await notifyUpcomingGames(1);
    },
  },
  {
    name: 'pro-schedule-rolling',
    cron: '0 8 * * *', // Daily 8am — keeps the configured pro-events window fresh
    description: 'Populate pro league (NFL/NBA/WNBA/MLB) event pages for the configured window',
    handler: async () => {
      const { runRollingScheduleIngest } = await import('../cron/pro-schedule-rolling.js');
      // Double-gated so a deploy never silently writes to prod: the adapter is
      // null unless PRO_SCHEDULE_PROVIDER=espn, and writes happen only when
      // PRO_SCHEDULE_ROLLING_ENABLED=1. Otherwise this is a safe dry-run/no-op.
      await runRollingScheduleIngest({ apply: process.env.PRO_SCHEDULE_ROLLING_ENABLED === '1' });
    },
  },
  {
    name: 'cleanup-old-notifications',
    cron: '0 3 * * *', // Every day at 3am
    description: 'Clean up old read notifications',
    handler: async () => {
      const { prisma } = await import('../lib/prisma.js');
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      const result = await prisma.notification.deleteMany({
        where: {
          read_at: { not: null },
          created_at: { lt: thirtyDaysAgo },
        },
      });

      console.log(`[Scheduler] Cleaned up ${result.count} old notifications`);
    },
  },
  // Stories persist forever — no cleanup job. BullMQ rejects the "Feb 31" pattern
  // that used to park this as a disabled stub, so the entry is removed entirely.
  {
    name: 'verify-push-receipts',
    cron: '*/15 * * * *', // Every 15 minutes
    description: 'Check push notification delivery receipts',
    handler: async () => {
      const { verifyPushReceipts } = await import('../lib/notifications.js');
      await verifyPushReceipts();
    },
  },
  {
    name: 'end-of-day-transaction-report',
    cron: '59 23 * * *', // Every day at 11:59 PM
    description: 'End-of-day transaction report (email removed, logs only)',
    handler: async () => {
      try {
        const { getEndOfDayReport } = await import('../lib/transactionLogger.js');
        const report = await getEndOfDayReport();
        console.log(`[Scheduler] End-of-day transaction report for ${report.date}`);
      } catch (error) {
        console.error('[Scheduler] Failed to generate end-of-day transaction report:', error);
        throw error;
      }
    },
  },
  // Event reminder email job removed — non-mandatory engagement email
  {
    name: 'ad-purchase-reconciliation',
    cron: '*/5 * * * *',
    description: 'Reconcile durably received Apple ad purchases',
    handler: async () => {
      const { reconcileReadyAdPurchases } = await import('../lib/adPurchaseIntents.js');
      const result = await reconcileReadyAdPurchases();
      console.log(`[Scheduler] Reconciled ${result.reconciled} ready ad purchase intents`);
    },
  },
  {
    name: 'db-backup-sync',
    cron: '0 */6 * * *', // Every 6 hours
    description: 'Sync primary database to backup Postgres instance',
    handler: async () => {
      try {
        const { syncDatabaseBackup } = await import('../lib/dbBackupSync.js');
        const result = await syncDatabaseBackup();
        if (result.success) {
          console.log(
            `[Scheduler] DB backup sync: ${result.tablesSync} tables, ${result.totalRows} rows`
          );
        } else if (result.error?.includes('not configured')) {
          // Silent skip — no backup URL set
        } else {
          throw new Error(`DB backup sync failed: ${result.error || 'unknown failure'}`);
        }
      } catch (error) {
        // Let the scheduler worker record failure and report it through Sentry.
        throw error;
      }
    },
  },
  {
    // Closes the gap the db-backup-sync job can't: if that sync SILENTLY stops
    // (errors mid-run, backup unreachable, replica falls behind), nothing notices
    // until a disaster or the next manual drill. This runs the same freshness
    // check as `npm run verify:backup-freshness` a few hours after each 6h sync
    // and captures to Sentry the moment the backup drifts past budget — so a
    // stalled sync surfaces within one cycle instead of at restore time.
    name: 'db-backup-freshness-check',
    cron: '0 3,9,15,21 * * *', // 3h after each 6-hourly db-backup-sync (00/06/12/18)
    description: 'Alert (Sentry) if the DR backup replica falls behind the primary',
    handler: async () => {
      try {
        const { checkBackupFreshness } = await import('../lib/backupFreshness.js');
        const result = await checkBackupFreshness();
        if (!result.configured) {
          // No backup configured — the sync skips too, so there is nothing to
          // alert on. Silent, same as db-backup-sync.
          return;
        }
        if (result.ok) {
          console.log(
            `[Scheduler] DB backup freshness OK — ${result.reason} (${result.primaryTotal} primary rows)`
          );
          return;
        }
        console.error(`[Scheduler] DB backup freshness ALERT: ${result.reason}`);
        captureException(new Error(`DR backup is stale: ${result.reason}`), {
          ...withJobTags('db-backup-freshness-check', {
            context: 'db_backup_freshness_stale',
          }),
          missing: result.missing,
          deficit: result.deficit,
          driftPct: Number(result.driftPct.toFixed(2)),
          maxDriftPct: result.maxDriftPct,
          primaryTotal: result.primaryTotal,
          backupTotal: result.backupTotal,
        });
        throw new Error(`DR backup is stale: ${result.reason}`);
      } catch (error) {
        console.error('[Scheduler] DB backup freshness check error:', error);
        captureException(
          error instanceof Error ? error : new Error(String(error)),
          withJobTags('db-backup-freshness-check', {
            context: 'db_backup_freshness_check_failed',
          })
        );
        throw error;
      }
    },
  },
  // Founder metrics job removed — non-mandatory internal report email
  // subscription-expiry-check removed — the handler was a no-op stub and the
  // renewal reminder email was intentionally dropped as non-mandatory marketing.
  // Scheduling a daily no-op misleads anyone reading the startup log into
  // thinking renewal reminders are going out.
  {
    name: 'coach-approval-drift-probe',
    cron: '45 9 * * *',
    description: 'Detect drift between CoachApplication.status and User.approval_status',
    handler: async () => {
      try {
        const { prisma } = await import('../lib/prisma.js');
        const { findCoachApprovalDrift } = await import('../lib/coachApprovalDrift.js');
        const drift = await findCoachApprovalDrift(prisma, 25);
        if (drift.length === 0) {
          console.log('[Scheduler] Coach approval drift probe clean');
          return;
        }
        console.error(`[Scheduler] Coach approval drift detected (${drift.length} rows)`);
        captureException(new Error(`Coach approval drift detected (${drift.length} rows)`), {
          ...withJobTags('coach-approval-drift-probe', {
            context: 'coach_approval_drift_probe',
          }),
          mismatches: drift,
        });
      } catch (error) {
        console.error('[Scheduler] Coach approval drift probe failed:', error);
        captureException(
          error instanceof Error ? error : new Error(String(error)),
          withJobTags('coach-approval-drift-probe', {
            context: 'coach_approval_drift_probe_failed',
          })
        );
        throw error;
      }
    },
  },
  {
    name: 'coach-approval-reminder',
    cron: '30 9 * * *', // Every day at 9:30 AM
    description: 'Log reminder about coaches pending > 7 days',
    handler: async () => {
      try {
        const { prisma } = await import('../lib/prisma.js');
        const { remindPendingCoachApprovals } = await import('../lib/approvalService.js');
        await remindPendingCoachApprovals(prisma);
      } catch (error) {
        console.error('[Scheduler] Coach approval reminder failed:', error);
        throw error;
      }
    },
  },
  {
    name: 'coach-approval-auto-expire',
    cron: '0 10 * * *', // Every day at 10:00 AM
    description: 'Auto-reject coaches pending > 30 days',
    handler: async () => {
      try {
        const { prisma } = await import('../lib/prisma.js');
        const { autoExpirePendingCoaches } = await import('../lib/approvalService.js');
        await autoExpirePendingCoaches(prisma);
      } catch (error) {
        console.error('[Scheduler] Coach approval auto-expire failed:', error);
        throw error;
      }
    },
  },
  {
    name: 'stale-event-auto-reject',
    cron: '30 3 * * *', // Every day at 3:30 AM
    description: 'Auto-reject pending events past their event date',
    handler: async () => {
      try {
        const { prisma } = await import('../lib/prisma.js');
        const { autoExpireStaleEvents } = await import('../lib/approvalService.js');
        await autoExpireStaleEvents(prisma);
      } catch (error) {
        console.error('[Scheduler] Stale event auto-reject failed:', error);
        throw error;
      }
    },
  },
  {
    name: 'ad-refund-reconcile',
    cron: '20 * * * *', // Hourly at :20 — recover stranded ad refunds
    description:
      "Re-issue refunds for ads stuck in payment_status:'refund_pending'; alarm on any still stuck",
    handler: async () => {
      try {
        const { prisma } = await import('../lib/prisma.js');
        const { reconcileStuckAdRefunds } = await import('../lib/approvalService.js');
        await reconcileStuckAdRefunds(prisma);
      } catch (error) {
        console.error('[Scheduler] Ad refund reconcile failed:', error);
        throw error;
      }
    },
  },
  {
    name: 'coach-state-drift-probe',
    cron: '45 3 * * *', // Every day at 3:45 AM — after stale-event-auto-reject
    description:
      'Detect drift between User.approval_status and CoachApplication.status; report findings to Sentry',
    handler: async () => {
      try {
        const { prisma } = await import('../lib/prisma.js');
        const { runCoachStateDriftProbe } = await import('../lib/coachStateDriftProbe.js');
        const result = await runCoachStateDriftProbe(prisma);
        console.log(
          `[Scheduler] coach-state-drift-probe: total=${result.total} buckets=${result.buckets.length}`
        );
      } catch (error) {
        console.error('[Scheduler] coach-state-drift-probe failed:', error);
        const { captureException } = await import('../lib/sentry.js');
        captureException(
          error as Error,
          withJobTags('coach-state-drift-probe', { context: 'coach_state_drift_probe_failed' })
        );
        throw error;
      }
    },
  },
  {
    name: 'stripe-webhook-reconciliation',
    // Off-clock minutes to avoid the :00/:30 herd. Effectively every ~30
    // minutes. The handler is idempotent (it only reads + alerts), so a
    // missed fire is fine.
    cron: '17,47 * * * *',
    description:
      'Detect Stripe checkout sessions paid in last 4h with no matching TransactionLog row; alert via Sentry',
    handler: async () => {
      try {
        const { reconcileStripeWebhookOrphans } = await import('../lib/stripeReconciliation.js');
        const result = await reconcileStripeWebhookOrphans();
        if (result.orphans > 0) {
          console.error(
            `[Scheduler] stripe-webhook-reconciliation FOUND ${result.orphans} orphan(s) in ${result.scanned} scanned sessions`
          );
        }
      } catch (error) {
        console.error('[Scheduler] stripe-webhook-reconciliation failed:', error);
        captureException(
          error instanceof Error ? error : new Error(String(error)),
          withJobTags('stripe-webhook-reconciliation', {
            context: 'stripe_webhook_reconciliation_failed',
          })
        );
        throw error;
      }
    },
  },
  {
    name: 'apple-iap-reconciliation',
    // Off-clock minutes, twice an hour. Uses only local data because we
    // still do not have App Store Server API credentials provisioned.
    cron: '23,53 * * * *',
    description:
      'Auto-recover stale local Apple IAP purchases when possible and alert on Apple S2S dry-spells',
    handler: async () => {
      try {
        const { reconcileAppleIapOrphans } = await import('../lib/appleIapReconciliation.js');
        const result = await reconcileAppleIapOrphans();
        if (
          result.stuckPending > 0 ||
          result.recovered > 0 ||
          result.recoveryFailed > 0 ||
          result.manualReviewNeeded > 0 ||
          result.notificationDrySpell
        ) {
          console.error(
            `[Scheduler] apple-iap-reconciliation: stuck=${result.stuckPending} recovered=${result.recovered} failed=${result.recoveryFailed} manual_review=${result.manualReviewNeeded} dryspell=${result.notificationDrySpell}`
          );
        }
      } catch (error) {
        console.error('[Scheduler] apple-iap-reconciliation failed:', error);
        captureException(
          error instanceof Error ? error : new Error(String(error)),
          withJobTags('apple-iap-reconciliation', {
            context: 'apple_iap_reconciliation_failed',
          })
        );
        throw error;
      }
    },
  },
  {
    name: 'google-play-reconciliation',
    // Google Play sends no renewal RTDN, so re-verify active Google subscribers
    // to refresh expiry on renewal and downgrade on cancel/expiry. Off-clock
    // minutes, hourly.
    cron: '37 * * * *',
    description:
      'Re-verify active Google Play subscribers to refresh expiry on renewal and downgrade on lapse',
    handler: async () => {
      try {
        const { reconcileGooglePlaySubscriptions } =
          await import('../lib/googlePlayReconciliation.js');
        const result = await reconcileGooglePlaySubscriptions();
        if (result.downgraded > 0 || result.errors > 0) {
          console.error(
            `[Scheduler] google-play-reconciliation: checked=${result.checked} refreshed=${result.refreshed} downgraded=${result.downgraded} errors=${result.errors}`
          );
        }
      } catch (error) {
        console.error('[Scheduler] google-play-reconciliation failed:', error);
        captureException(
          error instanceof Error ? error : new Error(String(error)),
          withJobTags('google-play-reconciliation', {
            context: 'google_play_reconciliation_failed',
          })
        );
        throw error;
      }
    },
  },
  {
    name: 'veteran-quantity-reconciliation',
    // Metered-Veteran Stripe item quantity ratchets up on team create but was
    // never lowered on archive (archival is terminal — no restore path), so
    // owners over-paid for archived sports. Re-align DOWN to the actual billable
    // program count nightly. Down-only + idempotent — a missed fire is fine.
    cron: '13 4 * * *', // Daily at 4:13 AM, off-clock
    description:
      "Re-align metered Veterans' Stripe item quantity down to their active billable-program count",
    handler: async () => {
      try {
        const { runVeteranQuantityReconciliation } =
          await import('../lib/veteranQuantityReconciliation.js');
        const result = await runVeteranQuantityReconciliation();
        if (result.lowered > 0 || result.flagged > 0 || result.errors > 0) {
          console.error(
            `[Scheduler] veteran-quantity-reconciliation: scanned=${result.scanned} lowered=${result.lowered} flagged=${result.flagged} errors=${result.errors} truncated=${result.truncated}`
          );
        }
      } catch (error) {
        console.error('[Scheduler] veteran-quantity-reconciliation failed:', error);
        captureException(
          error instanceof Error ? error : new Error(String(error)),
          withJobTags('veteran-quantity-reconciliation', {
            context: 'veteran_quantity_reconciliation_failed',
          })
        );
        throw error;
      }
    },
  },
];

let schedulerQueue: Queue | null = null;

/**
 * Setup all scheduled jobs
 */
export async function setupScheduler(): Promise<boolean> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.log('[Scheduler] No REDIS_URL configured, using fallback cron');
    return setupFallbackCron();
  }

  try {
    const { default: Redis } = await import('ioredis');
    const RedisCtor = Redis as unknown as new (url: string, options?: any) => any;
    const connection = new RedisCtor(redisUrl, {
      maxRetriesPerRequest: null,
    });

    schedulerQueue = new Queue('scheduler', { connection });

    // Remove existing repeatable jobs and add fresh ones
    const existingJobs = await schedulerQueue.getRepeatableJobs();
    for (const job of existingJobs) {
      await schedulerQueue.removeRepeatableByKey(job.key);
    }

    // Add scheduled jobs
    for (const job of SCHEDULED_JOBS) {
      await schedulerQueue.add(
        job.name,
        { description: job.description },
        {
          repeat: { pattern: job.cron, tz: 'UTC' },
          removeOnComplete: true,
          removeOnFail: { count: 10 },
        }
      );
      console.log(`[Scheduler] Added job: ${job.name} (${job.cron})`);
    }

    console.log('[Scheduler] All scheduled jobs configured');
    return true;
  } catch (error) {
    console.error('[Scheduler] Failed to setup:', error);
    throw error;
  }
}

// Both setupScheduler() and startSchedulerWorker() route here when REDIS_URL
// is unset — guard so the cron jobs are only registered once per process.
let fallbackCronArmed = false;

/**
 * Fallback cron using node-cron (for when Redis is not available)
 */
async function setupFallbackCron(): Promise<boolean> {
  if (fallbackCronArmed) {
    console.log('[Scheduler] Fallback cron already armed — skipping duplicate registration');
    return true;
  }
  fallbackCronArmed = true;

  // No Redis/BullMQ available — schedule every job from the single
  // SCHEDULED_JOBS list via node-cron. This function previously hand-copied
  // each job as a timed handler and had silently dropped five newer jobs
  // (2026-07-13 audit). Deriving from the array means a job added to
  // SCHEDULED_JOBS can never be missing here again.
  const { default: cron } = await import('node-cron');
  for (const job of SCHEDULED_JOBS) {
    cron.schedule(
      job.cron,
      async () => {
        try {
          console.log(`[Scheduler] (fallback) Running ${job.name}: ${job.description}`);
          await runMonitoredJob(job);
        } catch (error) {
          console.error(`[Scheduler] (fallback) ${job.name} failed:`, error);
          captureException(
            error instanceof Error ? error : new Error(String(error)),
            withJobTags(job.name, { context: 'scheduler_fallback_job_failed', cron: job.cron })
          );
        }
      },
      { timezone: 'UTC' }
    );
  }
  console.log(`[Scheduler] Fallback cron armed for ${SCHEDULED_JOBS.length} jobs via node-cron`);
  return true;
}

/**
 * Start the scheduler worker to process scheduled jobs
 */
export async function startSchedulerWorker(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.log('[Scheduler] No Redis - using fallback mode');
    await setupFallbackCron();
    return;
  }

  try {
    const { Worker } = await import('bullmq');
    const { default: Redis } = await import('ioredis');
    const RedisCtor = Redis as unknown as new (url: string, options?: any) => any;
    const connection = new RedisCtor(redisUrl, {
      maxRetriesPerRequest: null,
    });

    const worker = new Worker(
      'scheduler',
      async job => {
        const scheduledJob = SCHEDULED_JOBS.find(j => j.name === job.name);
        if (scheduledJob) {
          console.log(`[Scheduler] Running ${job.name}: ${scheduledJob.description}`);
          try {
            await runMonitoredJob(scheduledJob);
          } catch (error) {
            captureException(
              error instanceof Error ? error : new Error(String(error)),
              withJobTags(job.name, {
                context: 'scheduler_job_failed',
                cron: scheduledJob.cron,
              })
            );
            throw error;
          }
        } else {
          console.warn(`[Scheduler] Unknown job: ${job.name}`);
        }
      },
      { connection }
    );

    worker.on('completed', job => {
      console.log(`[Scheduler] Job ${job.name} completed`);
    });

    worker.on('failed', (job, err) => {
      console.error(`[Scheduler] Job ${job?.name} failed:`, err);
      if (job?.name) {
        captureException(err, withJobTags(job.name, { context: 'scheduler_worker_failed' }));
      }
    });

    console.log('[Scheduler] Worker started');
  } catch (error) {
    console.error('[Scheduler] Failed to start worker:', error);
    throw error;
  }
}

/**
 * List all scheduled jobs
 */
export async function listScheduledJobs(): Promise<
  Array<{ name: string; cron: string; description: string }>
> {
  return SCHEDULED_JOBS.map(({ name, cron, description }) => ({ name, cron, description }));
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    await setupScheduler();
    await startSchedulerWorker();
    console.log('Scheduler running. Press Ctrl+C to stop.');
  })();

  process.on('SIGTERM', () => {
    console.log('Scheduler shutting down...');
    process.exit(0);
  });
}

export { SCHEDULED_JOBS };
