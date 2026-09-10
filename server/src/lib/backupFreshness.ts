/**
 * backupFreshness — successful-sync evidence and row-count checks for the DR backup.
 *
 * The `db-backup-sync` scheduler job (every 6h) replicates the primary Postgres
 * into the backup instance (DATABASE_BACKUP_URL). This module connects to BOTH
 * and compares them table-by-table, summing positive row deficits. It is the
 * shared core behind two callers:
 *   - the runnable drill (`scripts/verify-backup-freshness.ts`, on-demand / CI), and
 *   - the `db-backup-freshness-check` scheduler job, which captures to Sentry when
 *     the backup falls behind — so a SILENTLY stopped sync is noticed between drills.
 *
 * Both share this logic so the pass/fail definition can never drift between them.
 *
 * A missing table, unreachable backup, or summed row deficit past the budget
 * (default 10%, override with BACKUP_MAX_DRIFT_PCT) fails this check. Counts are
 * a heuristic: equal counts or surplus backup rows do not prove content equality
 * or restorability. Updates and deletes can be invisible to the count check.
 * Separately, target-specific Redis evidence must show a successful copy started
 * within BACKUP_MAX_SUCCESS_AGE_HOURS (default 12), with no newer pending/failed
 * attempt. Evidence is rechecked after counts to detect concurrent copies.
 */
import { PrismaClient } from '@prisma/client';
import { TABLES_IN_ORDER } from './dbBackupTables.js';
import { readBackupSyncEvidence, type BackupSyncEvidence } from './backupSyncEvidence.js';

export const DEFAULT_MAX_DRIFT_PCT = Number(process.env.BACKUP_MAX_DRIFT_PCT ?? '10');

export type PerTableCount = { table: string; primary: number; backup: number | null };

export type BackupFreshnessResult = {
  /** false when DATABASE_BACKUP_URL is unset; identical configured targets are a failure. */
  configured: boolean;
  /** true when recent successful-sync evidence and the table-count checks pass; not a restore proof. */
  ok: boolean;
  /** Human-readable pass/fail summary (also used as the Sentry message when !ok). */
  reason: string;
  perTable: PerTableCount[];
  missing: string[];
  primaryTotal: number;
  backupTotal: number;
  deficit: number;
  driftPct: number;
  maxDriftPct: number;
  lastSuccessfulSyncAt?: number | null;
  lastSuccessfulSyncStartedAt?: number | null;
  maxSuccessAgeHours?: number;
};

function evidenceFailure(evidence: BackupSyncEvidence, maxAgeHours: number): string | null {
  if (evidence.status !== 'succeeded') {
    return `Backup successful sync evidence is ${evidence.status}; freshness cannot be verified`;
  }
  const started = evidence.lastSuccessfulSyncStartedAt;
  const completed = evidence.lastSuccessfulSyncAt;
  const now = Date.now();
  if (
    typeof started !== 'number' ||
    !Number.isFinite(started) ||
    started <= 0 ||
    typeof completed !== 'number' ||
    !Number.isFinite(completed) ||
    completed < started ||
    completed > now
  ) {
    return 'Backup successful sync timestamps are invalid or in the future';
  }
  if (now - started > maxAgeHours * 60 * 60_000) {
    return `Last successful sync started more than ${maxAgeHours} hours ago; backup is stale`;
  }
  return null;
}

/**
 * Pure verdict over already-counted tables — the single place the pass/fail
 * definition lives. `backup: null` in a row means the table is missing from the
 * backup. Exported so it can be unit-tested without a database.
 */
export function evaluateFreshness(
  perTable: PerTableCount[],
  maxDriftPct: number = DEFAULT_MAX_DRIFT_PCT
): Omit<BackupFreshnessResult, 'configured'> {
  const missing = perTable.filter(r => r.backup === null).map(r => r.table);
  const primaryTotal = perTable.reduce((sum, r) => sum + r.primary, 0);
  const backupTotal = perTable.reduce((sum, r) => sum + (r.backup ?? 0), 0);
  const deficit = perTable.reduce((sum, r) => sum + Math.max(0, r.primary - (r.backup ?? 0)), 0);
  const driftPct = primaryTotal === 0 ? 0 : (deficit / primaryTotal) * 100;
  const base = { perTable, missing, primaryTotal, backupTotal, deficit, driftPct, maxDriftPct };

  if (!Number.isFinite(maxDriftPct) || maxDriftPct < 0) {
    return {
      ok: false,
      reason: 'BACKUP_MAX_DRIFT_PCT must be a finite non-negative number',
      ...base,
    };
  }
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `${missing.length} table(s) missing from the backup: ${missing.join(', ')}`,
      ...base,
    };
  }
  if (driftPct > maxDriftPct) {
    return {
      ok: false,
      reason: `Backup row counts are ${driftPct.toFixed(1)}% behind the primary (${deficit} rows across deficient tables), past the ${maxDriftPct}% budget`,
      ...base,
    };
  }
  return {
    ok: true,
    reason:
      deficit > 0
        ? `Backup row counts within budget — ${deficit} row(s) missing across deficient tables (${driftPct.toFixed(2)}%); this does not prove content equality or freshness`
        : 'Backup row counts within budget — no per-table row deficit; this does not prove content equality or freshness',
    ...base,
  };
}

function makeClient(url: string): PrismaClient {
  return new PrismaClient({ datasources: { db: { url } } });
}

async function countTable(client: PrismaClient, table: string): Promise<number> {
  // `table` is drawn only from the TABLES_IN_ORDER whitelist — never user input —
  // so interpolating it into the identifier is safe.
  const rows = await client.$queryRawUnsafe<Array<{ c: bigint }>>(
    `SELECT count(*)::bigint AS c FROM "${table}"`
  );
  return Number(rows[0]?.c ?? 0);
}

/**
 * Connect to the primary + backup and evaluate freshness. Never throws for the
 * "not configured" case (returns configured:false); a connectivity failure to
 * either database returns ok:false with a reason (it is a real DR failure). Only
 * unexpected, non-connectivity errors propagate.
 */
export async function checkBackupFreshness(
  opts: { maxDriftPct?: number } = {}
): Promise<BackupFreshnessResult> {
  const maxDriftPct = opts.maxDriftPct ?? DEFAULT_MAX_DRIFT_PCT;
  // Two six-hour cycles; measured from copy start, not a potentially much later completion.
  const maxSuccessAgeHours = Number(process.env.BACKUP_MAX_SUCCESS_AGE_HOURS ?? '12');
  const primaryUrl = process.env.DATABASE_URL;
  const backupUrl = process.env.DATABASE_BACKUP_URL;

  const empty = {
    perTable: [] as PerTableCount[],
    missing: [] as string[],
    primaryTotal: 0,
    backupTotal: 0,
    deficit: 0,
    driftPct: 0,
    maxDriftPct,
    maxSuccessAgeHours,
    lastSuccessfulSyncAt: null,
    lastSuccessfulSyncStartedAt: null,
  };

  if (!primaryUrl) {
    return { configured: false, ok: false, reason: 'DATABASE_URL is not set', ...empty };
  }
  // Not configured (silent skip) — the db-backup-sync job skips too, so there is
  // no backup to be stale. This is not an alert-worthy condition.
  if (!backupUrl) {
    return { configured: false, ok: true, reason: 'DATABASE_BACKUP_URL not configured', ...empty };
  }
  if (primaryUrl === backupUrl) {
    return {
      configured: true,
      ok: false,
      reason: 'DATABASE_BACKUP_URL equals DATABASE_URL (no separate backup)',
      ...empty,
    };
  }

  if (!Number.isFinite(maxDriftPct) || maxDriftPct < 0) {
    return { configured: true, ...evaluateFreshness([], maxDriftPct) };
  }

  if (!Number.isFinite(maxSuccessAgeHours) || maxSuccessAgeHours <= 0) {
    return {
      configured: true,
      ...empty,
      ok: false,
      reason: 'BACKUP_MAX_SUCCESS_AGE_HOURS must be a finite positive number',
    };
  }
  let evidence: BackupSyncEvidence;
  try {
    evidence = await readBackupSyncEvidence(primaryUrl, backupUrl);
  } catch {
    return {
      configured: true,
      ...empty,
      ok: false,
      reason: 'Backup sync evidence store is unavailable or invalid',
    };
  }
  const successDetails = {
    lastSuccessfulSyncAt: evidence.lastSuccessfulSyncAt,
    lastSuccessfulSyncStartedAt: evidence.lastSuccessfulSyncStartedAt,
    maxSuccessAgeHours,
  };
  const failure = evidenceFailure(evidence, maxSuccessAgeHours);
  if (failure) return { configured: true, ...empty, ...successDetails, ok: false, reason: failure };

  const primary = makeClient(primaryUrl);
  const backup = makeClient(backupUrl);
  try {
    try {
      await primary.$queryRaw`SELECT 1`;
    } catch (e: any) {
      return {
        configured: true,
        ok: false,
        reason: `Cannot connect to PRIMARY database: ${e?.message || e}`,
        ...empty,
      };
    }
    try {
      await backup.$queryRaw`SELECT 1`;
    } catch (e: any) {
      return {
        configured: true,
        ok: false,
        reason: `Backup is unreachable — cannot be restored from: ${e?.message || e}`,
        ...empty,
      };
    }

    const perTable: PerTableCount[] = [];
    for (const table of TABLES_IN_ORDER) {
      const p = await countTable(primary, table);
      let b: number | null;
      try {
        b = await countTable(backup, table);
      } catch {
        b = null; // table missing from the backup
      }
      perTable.push({ table, primary: p, backup: b });
    }

    const counts = evaluateFreshness(perTable, maxDriftPct);
    let after: BackupSyncEvidence;
    try {
      after = await readBackupSyncEvidence(primaryUrl, backupUrl);
    } catch {
      return {
        configured: true,
        ...counts,
        ...successDetails,
        ok: false,
        reason: 'Backup sync evidence store is unavailable or invalid',
      };
    }
    const afterFailure = evidenceFailure(after, maxSuccessAgeHours);
    if (
      afterFailure ||
      after.successfulRunId !== evidence.successfulRunId ||
      after.lastSuccessfulSyncAt !== evidence.lastSuccessfulSyncAt ||
      after.lastSuccessfulSyncStartedAt !== evidence.lastSuccessfulSyncStartedAt
    ) {
      return {
        configured: true,
        ...counts,
        ...successDetails,
        ok: false,
        reason:
          afterFailure || 'Backup sync evidence changed during the count check; retry the check',
      };
    }
    return {
      configured: true,
      ...counts,
      ...successDetails,
      reason: counts.ok
        ? `Recent helper-reported successful sync and row counts within budget; this does not prove content equality or a successful restore`
        : counts.reason,
    };
  } finally {
    await primary.$disconnect().catch(() => {});
    await backup.$disconnect().catch(() => {});
  }
}
