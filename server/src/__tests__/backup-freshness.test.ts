/**
 * Unit tests for the DR backup freshness verdict + silent-skip guards.
 *
 * Pure/DB-free: evaluateFreshness is the single pass/fail definition shared by
 * the runnable drill and the db-backup-freshness-check scheduler alert, and the
 * env guards decide when the alert must STAY SILENT (no backup configured) vs.
 * fire. Getting either wrong means a false page or, worse, a silently missing DR
 * backup that never alerts.
 */
import { describe, expect, it } from '@jest/globals';
import {
  evaluateFreshness,
  checkBackupFreshness,
  type PerTableCount,
} from '../lib/backupFreshness.js';

const row = (table: string, primary: number, backup: number | null): PerTableCount => ({
  table,
  primary,
  backup,
});

describe('evaluateFreshness (shared pass/fail definition)', () => {
  it('equal row counts → within budget without proving content or freshness', () => {
    const r = evaluateFreshness([row('User', 100, 100), row('Post', 50, 50)], 10);
    expect(r.ok).toBe(true);
    expect(r.deficit).toBe(0);
    expect(r.driftPct).toBe(0);
    expect(r.reason).toMatch(/row counts/i);
    expect(r.reason).toMatch(/does not prove content equality or freshness/i);
  });

  it('trails by a few rows within budget → ok (expected between 6h syncs)', () => {
    // 5 rows behind out of 1000 = 0.5%, under the 10% budget.
    const r = evaluateFreshness([row('User', 800, 798), row('Post', 200, 197)], 10);
    expect(r.ok).toBe(true);
    expect(r.deficit).toBe(5);
    expect(r.driftPct).toBeCloseTo(0.5, 5);
    expect(r.reason).toMatch(/within budget/i);
  });

  it('deficit past the drift budget → NOT ok (stalled/erroring sync)', () => {
    // 200 behind out of 1000 = 20%, over the 10% budget.
    const r = evaluateFreshness([row('User', 1000, 800)], 10);
    expect(r.ok).toBe(false);
    expect(r.driftPct).toBeCloseTo(20, 5);
    expect(r.reason).toMatch(/behind the primary/i);
    expect(r.reason).toMatch(/10% budget/);
  });

  it('a missing backup table → NOT ok, regardless of drift', () => {
    const r = evaluateFreshness([row('User', 100, 100), row('Post', 50, null)], 10);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(['Post']);
    expect(r.reason).toMatch(/missing/i);
  });

  it('empty primary → ok, no divide-by-zero', () => {
    const r = evaluateFreshness([row('User', 0, 0)], 10);
    expect(r.ok).toBe(true);
    expect(r.driftPct).toBe(0);
  });

  it('backup ahead → no deficit, without claiming content equality or freshness', () => {
    const r = evaluateFreshness([row('User', 100, 103)], 10);
    expect(r.ok).toBe(true);
    expect(r.deficit).toBe(0);
    expect(r.reason).toMatch(/does not prove content equality or freshness/i);
  });

  it('surplus rows in one table cannot cancel another table deficit', () => {
    const r = evaluateFreshness([row('User', 100, 0), row('Post', 100, 200)], 10);
    expect(r.primaryTotal).toBe(r.backupTotal);
    expect(r.deficit).toBe(100);
    expect(r.driftPct).toBe(50);
    expect(r.ok).toBe(false);
  });

  it.each([NaN, Infinity, -Infinity, -1])('invalid drift budget %s fails closed', budget => {
    const r = evaluateFreshness([row('User', 100, 100)], budget);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/finite non-negative/i);
  });

  it('zero drift budget accepts equal counts and rejects any deficit', () => {
    expect(evaluateFreshness([row('User', 100, 100)], 0).ok).toBe(true);
    expect(evaluateFreshness([row('User', 100, 99)], 0).ok).toBe(false);
  });
});

describe('checkBackupFreshness env guards (the alert must stay SILENT when unconfigured)', () => {
  const orig = { url: process.env.DATABASE_URL, backup: process.env.DATABASE_BACKUP_URL };
  const restore = () => {
    if (orig.url === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = orig.url;
    if (orig.backup === undefined) delete process.env.DATABASE_BACKUP_URL;
    else process.env.DATABASE_BACKUP_URL = orig.backup;
  };

  it('no DATABASE_BACKUP_URL → configured:false, ok:true (silent skip, no DB touched)', async () => {
    process.env.DATABASE_URL = 'postgresql://user@localhost:5432/primary';
    delete process.env.DATABASE_BACKUP_URL;
    const r = await checkBackupFreshness();
    restore();
    expect(r.configured).toBe(false);
    expect(r.ok).toBe(true); // NOT an alert — the sync skips too
    expect(r.perTable).toEqual([]);
  });

  it('backup URL equals primary → configured:true, ok:false (a configuration failure)', async () => {
    process.env.DATABASE_URL = 'postgresql://user@localhost:5432/same';
    process.env.DATABASE_BACKUP_URL = 'postgresql://user@localhost:5432/same';
    const r = await checkBackupFreshness();
    restore();
    expect(r.configured).toBe(true);
    expect(r.ok).toBe(false);
  });

  it('invalid budget fails before connecting to a configured database', async () => {
    process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/primary';
    process.env.DATABASE_BACKUP_URL = 'postgresql://test:test@127.0.0.1:1/backup';
    try {
      const r = await checkBackupFreshness({ maxDriftPct: NaN });
      expect(r.configured).toBe(true);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/finite non-negative/i);
    } finally {
      restore();
    }
  });
});
