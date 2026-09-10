import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const events: string[] = [];
const copyFailure = new Error('copy query failed');
let failCopy = false;
const evidence = jest.fn(async (_primary: string, _backup: string, copy: () => Promise<any>) => {
  events.push('begin');
  const result = await copy();
  events.push(result.success ? 'succeeded' : 'failed');
  return result;
});
jest.unstable_mockModule('../lib/backupSyncEvidence.js', () => ({
  withBackupSyncEvidence: evidence,
}));
jest.unstable_mockModule('../lib/sentry.js', () => ({ captureException: jest.fn() }));
jest.unstable_mockModule('@prisma/client', () => ({
  Prisma: { TransactionIsolationLevel: { RepeatableRead: 'RepeatableRead' } },
  PrismaClient: class {
    constructor() {
      events.push('client');
    }
    $queryRaw = async () => {
      if (failCopy) throw copyFailure;
      return [];
    };
    $transaction = async (copy: (tx: any) => Promise<void>) => copy(this);
    $disconnect = async () => {
      events.push('disconnect');
    };
  },
}));
const { syncDatabaseBackup } = await import('../lib/dbBackupSync.js');
const original = { primary: process.env.DATABASE_URL, backup: process.env.DATABASE_BACKUP_URL };
afterAll(() => {
  if (original.primary === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = original.primary;
  if (original.backup === undefined) delete process.env.DATABASE_BACKUP_URL;
  else process.env.DATABASE_BACKUP_URL = original.backup;
});
beforeEach(() => {
  events.length = 0;
  failCopy = false;
  evidence.mockClear();
  process.env.DATABASE_URL = 'postgresql://primary.invalid/test';
  process.env.DATABASE_BACKUP_URL = 'postgresql://backup.invalid/test';
});

describe('actual database backup helper evidence boundary', () => {
  it('starts evidence before any DB client and finishes after both disconnects', async () => {
    await expect(syncDatabaseBackup()).resolves.toMatchObject({ success: true });
    expect(events).toEqual(['begin', 'client', 'client', 'disconnect', 'disconnect', 'succeeded']);
  });

  it('passes a failed copy result to evidence without claiming success', async () => {
    failCopy = true;
    await expect(syncDatabaseBackup()).resolves.toMatchObject({
      success: false,
      error: copyFailure.message,
    });
    expect(events).toEqual(['begin', 'client', 'client', 'disconnect', 'disconnect', 'failed']);
  });

  it('never starts a copy when evidence storage fails before begin', async () => {
    evidence.mockRejectedValueOnce(new Error('Backup sync evidence store unavailable'));
    await expect(syncDatabaseBackup()).rejects.toThrow('Backup sync evidence store unavailable');
    expect(events).toEqual([]);
  });

  it('keeps unconfigured backup as a no-op without requiring Redis', async () => {
    delete process.env.DATABASE_BACKUP_URL;
    await expect(syncDatabaseBackup()).resolves.toMatchObject({
      success: false,
      error: 'DATABASE_BACKUP_URL not configured',
    });
    expect(events).toEqual([]);
    expect(evidence).not.toHaveBeenCalled();
  });
});
