import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const readEvidence = jest.fn<(...args: string[]) => Promise<any>>();
jest.unstable_mockModule('../lib/backupSyncEvidence.js', () => ({
  readBackupSyncEvidence: readEvidence,
}));
const query = jest.fn<() => Promise<any>>().mockResolvedValue([{ c: 100n }]);
const disconnect = jest.fn<() => Promise<void>>().mockResolvedValue();
const constructed = jest.fn();
jest.unstable_mockModule('@prisma/client', () => ({
  PrismaClient: class {
    constructor() {
      constructed();
    }
    $queryRaw = query;
    $queryRawUnsafe = query;
    $disconnect = disconnect;
  },
}));
jest.unstable_mockModule('../lib/dbBackupTables.js', () => ({ TABLES_IN_ORDER: ['User'] }));
const { checkBackupFreshness } = await import('../lib/backupFreshness.js');
const originalEnv = { ...process.env };
const now = Date.parse('2026-09-09T12:00:00Z');
const recent = () => ({
  status: 'succeeded',
  successfulRunId: 'verified-run-1',
  lastSuccessfulSyncStartedAt: now - 60 * 60_000,
  lastSuccessfulSyncAt: now - 30 * 60_000,
});
beforeEach(() => {
  jest.useFakeTimers().setSystemTime(now);
  process.env.DATABASE_URL = 'postgresql://test@localhost/primary';
  process.env.DATABASE_BACKUP_URL = 'postgresql://test@localhost/backup';
  delete process.env.BACKUP_MAX_SUCCESS_AGE_HOURS;
  constructed.mockClear();
  disconnect.mockClear();
  query.mockReset().mockResolvedValue([{ c: 100n }]);
  readEvidence.mockReset().mockImplementation(async () => recent());
});
afterAll(() => {
  jest.useRealTimers();
  process.env = originalEnv;
});

describe('backup freshness requires successful sync evidence', () => {
  it.each(['missing', 'running', 'failed'])(
    'equal counts cannot hide %s evidence',
    async status => {
      readEvidence.mockResolvedValue({ ...recent(), status });
      expect((await checkBackupFreshness()).ok).toBe(false);
    }
  );

  it('uses the start of the successful copy, not its recent completion, for age', async () => {
    readEvidence.mockResolvedValue({
      ...recent(),
      lastSuccessfulSyncStartedAt: now - 13 * 60 * 60_000,
    });
    const result = await checkBackupFreshness();
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/older|age|stale/i);
  });

  it.each([null, NaN, Infinity, now + 1])(
    'rejects invalid/future start timestamp %s',
    async timestamp => {
      readEvidence.mockResolvedValue({ ...recent(), lastSuccessfulSyncStartedAt: timestamp });
      expect((await checkBackupFreshness()).ok).toBe(false);
    }
  );

  it('fails closed and sanitizes unavailable evidence storage', async () => {
    readEvidence.mockRejectedValue(new Error('redis://private-credentials@host'));
    const result = await checkBackupFreshness();
    expect(result.ok).toBe(false);
    expect(result.reason).not.toContain('private-credentials');
  });

  it('accepts recent success and equal counts without claiming a verified restore', async () => {
    const result = await checkBackupFreshness();
    expect(result.ok).toBe(true);
    expect(result.reason).toMatch(/successful sync/i);
    expect(result.reason).toMatch(/not.*restore|not.*content/i);
    expect(readEvidence).toHaveBeenCalledTimes(2);
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it('does not accept a new destructive attempt that starts during table counting', async () => {
    readEvidence
      .mockResolvedValueOnce(recent())
      .mockResolvedValueOnce({ ...recent(), status: 'running' });
    expect((await checkBackupFreshness()).ok).toBe(false);
  });

  it('rejects evidence changed by another completed run during table counting', async () => {
    readEvidence.mockResolvedValueOnce(recent()).mockResolvedValueOnce({
      ...recent(),
      lastSuccessfulSyncAt: now - 1,
    });
    expect((await checkBackupFreshness()).ok).toBe(false);
  });

  it('rejects a different successful run even when timestamps match', async () => {
    readEvidence.mockResolvedValueOnce(recent()).mockResolvedValueOnce({
      ...recent(),
      successfulRunId: 'verified-run-2',
    });
    expect((await checkBackupFreshness()).ok).toBe(false);
  });

  it.each(['NaN', 'Infinity', '0', '-1'])(
    'rejects invalid success age budget %s before DB access',
    async value => {
      process.env.BACKUP_MAX_SUCCESS_AGE_HOURS = value;
      expect((await checkBackupFreshness()).ok).toBe(false);
      expect(constructed).not.toHaveBeenCalled();
    }
  );
});
