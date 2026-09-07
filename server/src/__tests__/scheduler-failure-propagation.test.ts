import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const cases = [
  ['end-of-day-transaction-report', 'transactionLogger', 'getEndOfDayReport'],
  ['db-backup-freshness-check', 'backupFreshness', 'checkBackupFreshness'],
  ['coach-approval-drift-probe', 'coachApprovalDrift', 'findCoachApprovalDrift'],
  ['coach-approval-reminder', 'approvalService', 'remindPendingCoachApprovals'],
  ['coach-approval-auto-expire', 'approvalService', 'autoExpirePendingCoaches'],
  ['stale-event-auto-reject', 'approvalService', 'autoExpireStaleEvents'],
  ['ad-refund-reconcile', 'approvalService', 'reconcileStuckAdRefunds'],
  ['coach-state-drift-probe', 'coachStateDriftProbe', 'runCoachStateDriftProbe'],
  ['stripe-webhook-reconciliation', 'stripeReconciliation', 'reconcileStripeWebhookOrphans'],
  ['apple-iap-reconciliation', 'appleIapReconciliation', 'reconcileAppleIapOrphans'],
  ['google-play-reconciliation', 'googlePlayReconciliation', 'reconcileGooglePlaySubscriptions'],
  [
    'veteran-quantity-reconciliation',
    'veteranQuantityReconciliation',
    'runVeteranQuantityReconciliation',
  ],
] as const;
const failure = new Error('injected dependency failure');
const modules: Record<string, Record<string, ReturnType<typeof jest.fn>>> = {};
for (const [, module, method] of cases) {
  modules[module] ??= {};
  modules[module][method] = jest.fn<() => Promise<never>>().mockRejectedValue(failure);
}
for (const [module, exports] of Object.entries(modules)) {
  jest.unstable_mockModule(`../lib/${module}.js`, () => exports);
}
jest.unstable_mockModule('../lib/prisma.js', () => ({ prisma: {} }));
const capture = jest.fn();
jest.unstable_mockModule('../lib/sentry.js', () => ({
  captureException: capture,
  captureSchedulerCheckIn: jest.fn(),
  captureMessage: jest.fn(),
}));
const getRepeatableJobs = jest.fn<() => Promise<unknown[]>>();
const workerConstruct = jest.fn();
jest.unstable_mockModule('bullmq', () => ({
  Queue: class {
    getRepeatableJobs = getRepeatableJobs;
  },
  Worker: class {
    constructor(...args: unknown[]) {
      workerConstruct(...args);
    }
    on() {}
  },
}));
jest.unstable_mockModule('ioredis', () => ({ default: class {} }));
jest.useFakeTimers();
const { SCHEDULED_JOBS, setupScheduler, startSchedulerWorker } =
  await import('../jobs/scheduler.js');
const originalRedis = process.env.REDIS_URL;
afterAll(() => {
  jest.useRealTimers();
  if (originalRedis === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = originalRedis;
});
beforeEach(() => {
  capture.mockClear();
  workerConstruct.mockReset();
  process.env.REDIS_URL = 'redis://isolated-test';
});

describe('scheduler failures remain failures', () => {
  it.each(cases)('%s rejects when its dependency fails', async name => {
    const job = SCHEDULED_JOBS.find(job => job.name === name)!;
    await expect(job.handler()).rejects.toBe(failure);
  });

  it('rejects setup failure so startup can report it', async () => {
    getRepeatableJobs.mockRejectedValueOnce(failure);
    await expect(setupScheduler()).rejects.toBe(failure);
  });

  it('rejects worker construction failure so startup can report it', async () => {
    workerConstruct.mockImplementationOnce(() => {
      throw failure;
    });
    await expect(startSchedulerWorker()).rejects.toBe(failure);
  });

  it('reports a failed handler with job tags and rejects the worker processor', async () => {
    await startSchedulerWorker();
    const processor = workerConstruct.mock.calls[0][1] as (job: { name: string }) => Promise<void>;
    await expect(processor({ name: 'ad-refund-reconcile' })).rejects.toBe(failure);
    expect(capture).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({
        tags: { job: 'ad-refund-reconcile' },
        context: 'scheduler_job_failed',
      })
    );
  });
});
