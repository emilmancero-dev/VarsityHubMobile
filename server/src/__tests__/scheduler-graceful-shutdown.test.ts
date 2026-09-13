/**
 * Reliability: the scheduler worker must shut down gracefully on deploy/SIGTERM.
 *
 * Before this, startSchedulerWorker() created a local `worker` that was never
 * returned or closed, and its three dedicated Redis connections (worker, queue,
 * dedup) were never quit. On a Railway deploy the worker was killed mid-job and
 * the DB was disconnected out from under in-flight work.
 *
 * Guarantees proven here:
 *  - stopSchedulerWorker() closes the worker (BullMQ close() drains active jobs)
 *    and quits every dedicated Redis connection it opened.
 *  - It is idempotent (safe to call when nothing started, and to call twice).
 *  - index.ts stops the scheduler worker BEFORE it disconnects Prisma, so
 *    in-flight jobs finish against a live DB.
 */
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const workerConstruct = jest.fn();
const workerClose = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const queueClose = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
const redisQuit = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

jest.unstable_mockModule('../lib/prisma.js', () => ({ prisma: {} }));
jest.unstable_mockModule('../lib/sentry.js', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  captureSchedulerCheckIn: jest.fn(),
}));
jest.unstable_mockModule('bullmq', () => ({
  Queue: class {
    getRepeatableJobs = jest.fn<() => Promise<unknown[]>>().mockResolvedValue([]);
    removeRepeatableByKey = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    add = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    close = queueClose;
  },
  Worker: class {
    constructor(...args: unknown[]) {
      workerConstruct(...args);
    }
    on() {
      return this;
    }
    close = workerClose;
  },
}));
jest.unstable_mockModule('ioredis', () => ({
  default: class {
    connect = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    quit = redisQuit;
    set = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    exists = jest.fn<() => Promise<number>>().mockResolvedValue(0);
  },
}));

const { setupScheduler, startSchedulerWorker, stopSchedulerWorker } =
  await import('../jobs/scheduler.js');

const originalRedis = process.env.REDIS_URL;
afterAll(() => {
  if (originalRedis === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = originalRedis;
});
beforeEach(() => {
  workerConstruct.mockClear();
  workerClose.mockReset().mockResolvedValue(undefined);
  queueClose.mockClear();
  redisQuit.mockClear();
  process.env.REDIS_URL = 'redis://isolated-test';
});

describe('scheduler graceful shutdown', () => {
  it('closes the worker and quits its Redis connection', async () => {
    await startSchedulerWorker();
    await stopSchedulerWorker();
    expect(workerClose).toHaveBeenCalledTimes(1);
    // worker connection must be quit so it is drained before DB teardown
    expect(redisQuit).toHaveBeenCalled();
  });

  it('closes the queue and quits its connection when setup ran', async () => {
    await setupScheduler();
    await startSchedulerWorker();
    redisQuit.mockClear();
    await stopSchedulerWorker();
    expect(queueClose).toHaveBeenCalledTimes(1);
    // worker + queue connections both quit
    expect(redisQuit.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('is idempotent — a second stop is a no-op and never throws', async () => {
    await startSchedulerWorker();
    await stopSchedulerWorker();
    workerClose.mockClear();
    await expect(stopSchedulerWorker()).resolves.toBeUndefined();
    expect(workerClose).not.toHaveBeenCalled();
  });

  it('is a safe no-op when nothing was started', async () => {
    await expect(stopSchedulerWorker()).resolves.toBeUndefined();
    expect(workerClose).not.toHaveBeenCalled();
  });

  it('shares an in-flight drain across concurrent shutdown calls', async () => {
    let release!: () => void;
    workerClose.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          release = resolve;
        })
    );
    await startSchedulerWorker();
    const first = stopSchedulerWorker();
    const second = stopSchedulerWorker();
    try {
      expect(workerClose).toHaveBeenCalledTimes(1);
      expect(redisQuit).not.toHaveBeenCalled();
    } finally {
      release();
      await Promise.all([first, second]);
    }
  });

  it('rejects a failed drain without disconnecting an active worker', async () => {
    const error = new Error('worker drain failed');
    workerClose.mockRejectedValueOnce(error);
    await startSchedulerWorker();
    try {
      await expect(stopSchedulerWorker()).rejects.toBe(error);
      expect(redisQuit).not.toHaveBeenCalled();
    } finally {
      // The retained worker can be closed on a subsequent attempt.
      await stopSchedulerWorker();
    }
  });
});

describe('index.ts wires scheduler shutdown before DB teardown', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8');
  const start = src.indexOf('const shutdown = async');
  const shutdownBody = src.slice(start, src.indexOf('};', start));

  it('calls stopSchedulerWorker inside the graceful shutdown handler', () => {
    expect(start).toBeGreaterThan(-1);
    expect(shutdownBody).toMatch(/stopSchedulerWorker\(\)/);
  });

  it('stops the scheduler worker BEFORE disconnecting Prisma', () => {
    const stopIdx = shutdownBody.indexOf('stopSchedulerWorker()');
    const disconnectIdx = shutdownBody.indexOf('prisma.$disconnect()');
    expect(stopIdx).toBeGreaterThan(-1);
    expect(disconnectIdx).toBeGreaterThan(-1);
    expect(stopIdx).toBeLessThan(disconnectIdx);
  });
});
