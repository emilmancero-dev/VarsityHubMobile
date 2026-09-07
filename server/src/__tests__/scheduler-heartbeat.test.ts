import { beforeEach, describe, expect, it } from '@jest/globals';
import {
  evaluateSchedulerHeartbeat,
  expectedIntervalMs,
  overdueThresholdMs,
  readHeartbeats,
  recordHeartbeat,
  type EvaluateInput,
} from '../lib/schedulerHeartbeat.js';
import { SCHEDULED_JOBS } from '../jobs/scheduler.js';

const MIN = 60_000;

describe('expectedIntervalMs — cron cadence', () => {
  it.each([
    ['*/5 * * * *', 5 * MIN],
    ['*/15 * * * *', 15 * MIN],
    ['0 * * * *', 60 * MIN],
    ['30 * * * *', 60 * MIN],
    ['20 * * * *', 60 * MIN],
    ['17,47 * * * *', 30 * MIN],
    ['23,53 * * * *', 30 * MIN],
    ['0 */6 * * *', 6 * 60 * MIN],
    ['0 3,9,15,21 * * *', 6 * 60 * MIN],
    ['0 8 * * *', 24 * 60 * MIN],
    ['59 23 * * *', 24 * 60 * MIN],
    ['45 9 * * *', 24 * 60 * MIN],
    ['13 4 * * *', 24 * 60 * MIN],
  ])('%s -> %i ms', (cron, expected) => {
    expect(expectedIntervalMs(cron)).toBe(expected);
  });

  it('returns Infinity for an unparseable expression', () => {
    expect(expectedIntervalMs('not a cron')).toBe(Infinity);
  });

  it('produces a finite cadence for every real scheduled job', () => {
    for (const job of SCHEDULED_JOBS) {
      const interval = expectedIntervalMs(job.cron);
      expect(Number.isFinite(interval)).toBe(true);
      expect(interval).toBeGreaterThan(0);
      // nothing in the set runs less often than daily
      expect(interval).toBeLessThanOrEqual(24 * 60 * MIN);
    }
  });
});

describe('evaluateSchedulerHeartbeat', () => {
  const base = (over: Partial<EvaluateInput> = {}): EvaluateInput => ({
    jobs: [{ name: 'fast', cron: '*/5 * * * *' }],
    now: 1_000_000_000_000,
    processStartedAt: 0, // long-running process
    heartbeats: {},
    isEnabled: () => true,
    ...over,
  });

  it('is ok when a job ran within its window', () => {
    const now = 1_000_000_000_000;
    const report = evaluateSchedulerHeartbeat(
      base({ now, heartbeats: { fast: { lastRunAt: now - 4 * MIN, lastStatus: 'ok' } } })
    );
    expect(report.ok).toBe(true);
    expect(report.overdueCount).toBe(0);
    expect(report.jobs[0].overdue).toBe(false);
  });

  it('flags a job that has been silent past 2 cycles + slack', () => {
    const now = 1_000_000_000_000;
    // threshold for a 5-min job = 2*5 + 5 = 15 min
    const report = evaluateSchedulerHeartbeat(
      base({ now, heartbeats: { fast: { lastRunAt: now - 20 * MIN, lastStatus: 'ok' } } })
    );
    expect(report.ok).toBe(false);
    expect(report.stale).toEqual(['fast']);
    expect(report.reason).toMatch(/overdue: fast/);
  });

  it('never flags a disabled job, even with no record', () => {
    const report = evaluateSchedulerHeartbeat(base({ isEnabled: () => false, heartbeats: {} }));
    expect(report.ok).toBe(true);
    expect(report.jobs[0].disabled).toBe(true);
    expect(report.jobs[0].overdue).toBe(false);
  });

  it('does not flag a never-recorded job on a freshly-started process', () => {
    const now = 1_000_000_000_000;
    const report = evaluateSchedulerHeartbeat(
      base({ now, processStartedAt: now - 2 * MIN, heartbeats: {} }) // up 2 min < 15 min threshold
    );
    expect(report.ok).toBe(true);
    expect(report.jobs[0].overdue).toBe(false);
  });

  it('flags a never-recorded job once uptime exceeds the threshold', () => {
    const now = 1_000_000_000_000;
    const report = evaluateSchedulerHeartbeat(
      base({ now, processStartedAt: now - 30 * MIN, heartbeats: {} }) // up 30 min > 15 min
    );
    expect(report.ok).toBe(false);
    expect(report.stale).toEqual(['fast']);
  });

  it('fails closed when the store is unreachable', () => {
    const now = 1_000_000_000_000;
    const report = evaluateSchedulerHeartbeat(
      base({ now, storeError: true, heartbeats: { fast: { lastRunAt: now - 1 * MIN } } })
    );
    expect(report.ok).toBe(false);
    expect(report.reason).toMatch(/store unreachable/);
  });

  it('overdueThresholdMs = 2*interval + 5min', () => {
    expect(overdueThresholdMs(5 * MIN)).toBe(15 * MIN);
    expect(overdueThresholdMs(60 * MIN)).toBe(125 * MIN);
  });
});

describe('store round-trip (in-memory fallback, no REDIS_URL)', () => {
  beforeEach(() => {
    delete process.env.REDIS_URL;
  });

  it('records and reads a heartbeat without Redis, storeError false', async () => {
    await recordHeartbeat('data-export-cleanup', 'ok');
    const { data, storeError } = await readHeartbeats();
    expect(storeError).toBe(false);
    expect(data['data-export-cleanup']?.lastStatus).toBe('ok');
    expect(typeof data['data-export-cleanup']?.lastRunAt).toBe('number');
  });
});
