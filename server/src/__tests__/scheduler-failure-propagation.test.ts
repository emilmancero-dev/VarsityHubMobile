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
const syncDatabaseBackup =
  jest.fn<
    () => Promise<{ success: boolean; tablesSync: number; totalRows: number; error?: string }>
  >();
jest.unstable_mockModule('../lib/dbBackupSync.js', () => ({ syncDatabaseBackup }));
const recordHeartbeat = jest.fn<() => Promise<void>>().mockResolvedValue();
jest.unstable_mockModule('../lib/schedulerHeartbeat.js', () => ({
  recordHeartbeat,
  closeHeartbeatStore: jest.fn<() => Promise<void>>().mockResolvedValue(),
}));
const capture = jest.fn();
const captureCheckIn = jest.fn<(...args: any[]) => string>().mockReturnValue('check-in-id');
jest.unstable_mockModule('../lib/sentry.js', () => ({
  captureException: capture,
  captureSchedulerCheckIn: captureCheckIn,
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
const { runMonitoredJob } = await import('../lib/schedulerMonitoring.js');
const originalRedis = process.env.REDIS_URL;
const originalBackupUrl = process.env.DATABASE_BACKUP_URL;
afterAll(() => {
  jest.useRealTimers();
  if (originalRedis === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = originalRedis;
  if (originalBackupUrl === undefined) delete process.env.DATABASE_BACKUP_URL;
  else process.env.DATABASE_BACKUP_URL = originalBackupUrl;
});
beforeEach(() => {
  capture.mockClear();
  captureCheckIn.mockClear();
  recordHeartbeat.mockClear();
  syncDatabaseBackup.mockReset();
  workerConstruct.mockReset();
  process.env.REDIS_URL = 'redis://isolated-test';
  process.env.DATABASE_BACKUP_URL = 'postgresql://test:test@127.0.0.1:1/backup';
});

describe('backup sync reports its actual outcome', () => {
  const backupJob = SCHEDULED_JOBS.find(job => job.name === 'db-backup-sync')!;

  it('rejects a returned backup failure', async () => {
    syncDatabaseBackup.mockResolvedValue({
      success: false,
      tablesSync: 1,
      totalRows: 10,
      error: 'Post table could not be copied',
    });
    await expect(backupJob.handler()).rejects.toThrow('Post table could not be copied');
  });

  it('preserves a thrown backup dependency error', async () => {
    syncDatabaseBackup.mockRejectedValue(failure);
    await expect(backupJob.handler()).rejects.toBe(failure);
  });

  it.each(['Backup schema not configured', 'DATABASE_BACKUP_URL not configured'])(
    'rejects configuration failure %s when backup storage is configured',
    async error => {
      syncDatabaseBackup.mockResolvedValue({ success: false, tablesSync: 0, totalRows: 0, error });
      await expect(backupJob.handler()).rejects.toThrow(error);
    }
  );

  it.each(['returned failure', 'thrown error'] as const)(
    'reports an error check-in and heartbeat for %s',
    async outcome => {
      if (outcome === 'returned failure') {
        syncDatabaseBackup.mockResolvedValue({
          success: false,
          tablesSync: 0,
          totalRows: 0,
          error: 'Backup connection failed',
        });
      } else {
        syncDatabaseBackup.mockRejectedValue(failure);
      }
      await expect(runMonitoredJob(backupJob)).rejects.toThrow();
      expect(captureCheckIn.mock.calls.map(([checkIn]) => checkIn.status)).toEqual([
        'in_progress',
        'error',
      ]);
      expect(recordHeartbeat).toHaveBeenCalledWith('db-backup-sync', 'error');
    }
  );

  it('reports a successful backup as successful', async () => {
    syncDatabaseBackup.mockResolvedValue({ success: true, tablesSync: 2, totalRows: 10 });
    await expect(runMonitoredJob(backupJob)).resolves.toBeUndefined();
    expect(captureCheckIn.mock.calls.map(([checkIn]) => checkIn.status)).toEqual([
      'in_progress',
      'ok',
    ]);
    expect(recordHeartbeat).toHaveBeenCalledWith('db-backup-sync', 'ok');
  });

  it('preserves the unconfigured skip without claiming monitoring success', async () => {
    delete process.env.DATABASE_BACKUP_URL;
    syncDatabaseBackup.mockResolvedValue({
      success: false,
      tablesSync: 0,
      totalRows: 0,
      error: 'DATABASE_BACKUP_URL not configured',
    });
    await expect(runMonitoredJob(backupJob)).resolves.toBeUndefined();
    expect(captureCheckIn).not.toHaveBeenCalled();
    expect(recordHeartbeat).not.toHaveBeenCalled();
  });
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
