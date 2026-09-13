/**
 * Reliability: in fallback (no-Redis) mode the scheduler must drain gracefully.
 *
 * setupFallbackCron() schedules every job via node-cron, which fires
 * independently of BullMQ. Before this fix the ScheduledTask handles were
 * discarded and drainScheduler() only closed the BullMQ worker/queue — so on a
 * deploy/SIGTERM the cron tasks were never stopped and an in-flight fallback
 * job was killed mid-operation when Prisma disconnected and the process exited.
 *
 * Guarantees proven here:
 *  - stopSchedulerWorker() stops every fallback cron task (no NEW job starts).
 *  - It awaits an in-flight fallback run so it finishes against a live DB
 *    BEFORE the drain resolves (index.ts then tears down queues/Prisma).
 */
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

type Captured = { cb: () => unknown; stop: ReturnType<typeof jest.fn> };
const capturedTasks: Captured[] = [];

const scheduleMock = jest.fn((_expr: string, cb: () => unknown) => {
  const stop = jest.fn();
  capturedTasks.push({ cb, stop });
  return { stop };
});

const runMonitoredJobMock = jest.fn<(job: unknown) => Promise<void>>().mockResolvedValue(undefined);

jest.unstable_mockModule('../lib/prisma.js', () => ({ prisma: {} }));
jest.unstable_mockModule('../lib/sentry.js', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  captureSchedulerCheckIn: jest.fn(),
}));
jest.unstable_mockModule('node-cron', () => ({ default: { schedule: scheduleMock } }));
jest.unstable_mockModule('../lib/schedulerMonitoring.js', () => ({
  runMonitoredJob: runMonitoredJobMock,
}));

const { setupScheduler, stopSchedulerWorker, SCHEDULED_JOBS } =
  await import('../jobs/scheduler.js');

const originalRedis = process.env.REDIS_URL;
afterAll(() => {
  if (originalRedis === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = originalRedis;
});
beforeEach(() => {
  capturedTasks.length = 0;
  scheduleMock.mockClear();
  runMonitoredJobMock.mockReset().mockResolvedValue(undefined);
  delete process.env.REDIS_URL; // force fallback (node-cron) mode
});

describe('scheduler fallback-cron drain', () => {
  it('arms one node-cron task per scheduled job', async () => {
    await setupScheduler();
    expect(capturedTasks).toHaveLength(SCHEDULED_JOBS.length);
    await stopSchedulerWorker();
  });

  it('stops every fallback cron task on shutdown', async () => {
    await setupScheduler();
    await stopSchedulerWorker();
    expect(capturedTasks.length).toBeGreaterThan(0);
    for (const task of capturedTasks) {
      expect(task.stop).toHaveBeenCalledTimes(1);
    }
  });

  it('awaits an in-flight fallback job before the drain resolves', async () => {
    let release!: () => void;
    runMonitoredJobMock.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          release = resolve;
        })
    );

    await setupScheduler();
    // Fire one job tick — runMonitoredJob now hangs, so the run is in-flight.
    capturedTasks[0].cb();
    expect(runMonitoredJobMock).toHaveBeenCalledTimes(1);

    let drained = false;
    const drainP = stopSchedulerWorker().then(() => {
      drained = true;
    });

    // The task was stopped immediately, but the drain must NOT resolve while
    // the in-flight run is still pending.
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(capturedTasks[0].stop).toHaveBeenCalledTimes(1);
    expect(drained).toBe(false);

    release();
    await drainP;
    expect(drained).toBe(true);
  });

  it('is a safe no-op when nothing was armed', async () => {
    await expect(stopSchedulerWorker()).resolves.toBeUndefined();
    expect(capturedTasks).toHaveLength(0);
  });
});
