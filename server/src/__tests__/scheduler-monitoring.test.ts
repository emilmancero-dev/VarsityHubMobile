import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const captureCheckIn = jest.fn<(...args: any[]) => string>();
jest.unstable_mockModule('@sentry/node', () => ({ captureCheckIn }));
const { runMonitoredJob, schedulerMonitorConfig } = await import('../lib/schedulerMonitoring.js');
const originalEnv = { ...process.env };
afterAll(() => {
  process.env = originalEnv;
});
beforeEach(() => {
  process.env.NODE_ENV = 'production';
  process.env.SENTRY_DSN = 'https://test@example.invalid/1';
  delete process.env.DATABASE_BACKUP_URL;
  captureCheckIn.mockReset().mockReturnValue('check-in-id');
});
const job = (handler: () => Promise<void>) => ({
  name: 'ad-refund-reconcile',
  cron: '20 * * * *',
  handler,
});

describe('scheduler check-ins', () => {
  it('pairs start and success with the same ID and UTC schedule', async () => {
    await runMonitoredJob(job(async () => {}));
    expect(captureCheckIn.mock.calls[0]).toEqual([
      { monitorSlug: 'varsityhub-ad-refund-reconcile', status: 'in_progress' },
      schedulerMonitorConfig(job(async () => {})),
    ]);
    expect(captureCheckIn.mock.calls[0][1].timezone).toBe('UTC');
    expect(captureCheckIn.mock.calls[1][0]).toEqual(
      expect.objectContaining({ checkInId: 'check-in-id', status: 'ok' })
    );
  });
  it('reports error and preserves the original rejection', async () => {
    const error = new Error('payment dependency unavailable');
    await expect(
      runMonitoredJob(
        job(async () => {
          throw error;
        })
      )
    ).rejects.toBe(error);
    expect(captureCheckIn.mock.calls[1][0].status).toBe('error');
  });
  it.each([1, 2])('SDK failure at capture %i does not fail business work', async phase => {
    if (phase === 2) captureCheckIn.mockReturnValueOnce('id');
    captureCheckIn.mockImplementationOnce(() => {
      throw new Error('SDK unavailable');
    });
    const handler = jest.fn<() => Promise<void>>().mockResolvedValue();
    await expect(runMonitoredJob(job(handler))).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it('preserves the business error when terminal reporting fails', async () => {
    captureCheckIn.mockReturnValueOnce('id').mockImplementationOnce(() => {
      throw new Error('SDK failed');
    });
    const error = new Error('business error');
    await expect(
      runMonitoredJob(
        job(async () => {
          throw error;
        })
      )
    ).rejects.toBe(error);
  });
  it('does not report a hung handler as completed and permits later recovery', async () => {
    let finish!: () => void;
    const pending = runMonitoredJob(
      job(
        () =>
          new Promise<void>(resolve => {
            finish = resolve;
          })
      )
    );
    await Promise.resolve();
    expect(captureCheckIn).toHaveBeenCalledTimes(1);
    expect(captureCheckIn.mock.calls[0][1].maxRuntime).toBe(30);
    finish();
    await pending;
    expect(captureCheckIn.mock.calls[1][0].status).toBe('ok');
  });
  it('does not send development check-ins', async () => {
    process.env.NODE_ENV = 'development';
    await runMonitoredJob(job(async () => {}));
    expect(captureCheckIn).not.toHaveBeenCalled();
  });
  it('does not claim a backup succeeded when storage is unconfigured', async () => {
    await runMonitoredJob({ ...job(async () => {}), name: 'db-backup-sync' });
    expect(captureCheckIn).not.toHaveBeenCalled();
  });
});
