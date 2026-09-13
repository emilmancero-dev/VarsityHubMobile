import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue, QueueEvents } from 'bullmq';
import Redis from 'ioredis';
import { SCHEDULED_JOBS, startSchedulerWorker, stopSchedulerWorker } from '../jobs/scheduler.js';

let redis: ChildProcess;
let directory: string;
let connection: InstanceType<typeof Redis>;
let queue: Queue;
let events: QueueEvents;
let releaseActive: (() => void) | undefined;
const originalRedis = process.env.REDIS_URL;
const jobName = 'isolated-shutdown-proof';

beforeAll(async () => {
  // Always create our own Redis. Never connect to configured local/prod data.
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('No isolated Redis port');
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  directory = await mkdtemp(join(tmpdir(), 'vh-scheduler-redis-'));
  redis = spawn(
    'redis-server',
    [
      '--bind',
      '127.0.0.1',
      '--port',
      String(address.port),
      '--save',
      '',
      '--appendonly',
      'no',
      '--dir',
      directory,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('Isolated Redis startup timed out')), 5000);
    redis.once('error', error => {
      clearTimeout(deadline);
      reject(error);
    });
    redis.once('exit', code => {
      clearTimeout(deadline);
      reject(new Error(`Redis exited ${code}`));
    });
    redis.stdout!.on('data', chunk => {
      if (String(chunk).includes('Ready to accept connections')) {
        clearTimeout(deadline);
        resolve();
      }
    });
  });
  process.env.REDIS_URL = `redis://127.0.0.1:${address.port}`;
  connection = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
  queue = new Queue('scheduler', { connection });
  events = new QueueEvents('scheduler', { connection });
  await events.waitUntilReady();
});

afterAll(async () => {
  releaseActive?.();
  try {
    await stopSchedulerWorker();
    await events?.close();
    await queue?.close();
    await connection?.quit();
  } finally {
    if (redis && redis.exitCode === null) {
      const exited = once(redis, 'exit');
      redis.kill('SIGTERM');
      await exited;
    }
    if (directory) await rm(directory, { recursive: true, force: true });
    const index = SCHEDULED_JOBS.findIndex(job => job.name === jobName);
    if (index >= 0) SCHEDULED_JOBS.splice(index, 1);
    if (originalRedis === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedis;
  }
});

describe('scheduler drain and restart with real isolated Redis', () => {
  it('finishes active work, preserves queued work, and processes it once after restart', async () => {
    let entered!: () => void;
    const active = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      releaseActive = resolve;
    });
    const completed: number[] = [];
    let runs = 0;
    SCHEDULED_JOBS.push({
      name: jobName,
      cron: '* * * * *',
      description: 'Isolated test only',
      handler: async () => {
        const run = ++runs;
        if (run === 1) {
          entered();
          await gate;
        }
        completed.push(run);
      },
    });
    await startSchedulerWorker();
    const first = await queue.add(jobName, {}, { jobId: 'active-proof' });
    await active;
    const second = await queue.add(jobName, {}, { jobId: 'queued-proof' });
    let stopped = false;
    const stopping = stopSchedulerWorker().then(() => {
      stopped = true;
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(stopped).toBe(false);
    expect(completed).toEqual([]);
    releaseActive!();
    await stopping;
    await first.waitUntilFinished(events, 5000);
    expect(completed).toEqual([1]);
    expect(await second.getState()).toBe('waiting');

    await startSchedulerWorker();
    await second.waitUntilFinished(events, 5000);
    await stopSchedulerWorker();
    expect(completed).toEqual([1, 2]);
    expect(await first.getState()).toBe('completed');
    expect(await second.getState()).toBe('completed');
  });
});
