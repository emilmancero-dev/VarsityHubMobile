/**
 * Database Backup Sync
 *
 * Periodically replicates all data from the primary Postgres (Postgres-TnGR)
 * to the backup Postgres instance. Uses Prisma raw SQL to dump and restore
 * table-by-table in dependency order.
 *
 * Requires: DATABASE_BACKUP_URL env var pointing to the backup Postgres.
 */

import { Prisma, PrismaClient } from '@prisma/client';
import { debugLog } from './debugLog.js';
import { captureException } from './sentry.js';
import { buildRowValuesClause, enumCastTypeName } from './dbBackupSql.js';
import { TABLES_IN_ORDER, DEFERRED_FK_COLUMNS, BACKUP_EXCLUDED_TABLES } from './dbBackupTables.js';
import { withBackupSyncEvidence } from './backupSyncEvidence.js';

/**
 * Replay the primary's enum catalog onto the backup.
 *
 * The backup Postgres never receives `prisma migrate deploy` (start.sh only
 * migrates DATABASE_URL), so enum TYPES and VALUES drift: new migrations add
 * enums the backup has never seen (sync fails with 42704 `type "X" does not
 * exist`) or add labels to existing enums (22P02 `invalid enum value`).
 * Idempotent: CREATE TYPE is wrapped in a DO block that swallows
 * duplicate_object, and each label uses ADD VALUE IF NOT EXISTS.
 */
async function reconcileBackupEnums(primary: PrismaClient, backup: PrismaClient): Promise<void> {
  try {
    const enumRows = await primary.$queryRaw<Array<{ type_name: string; label: string }>>`
      SELECT t.typname AS type_name, e.enumlabel AS label
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'public'
      ORDER BY t.typname ASC, e.enumsortorder ASC
    `;

    const labelsByType = new Map<string, string[]>();
    for (const row of enumRows) {
      if (!labelsByType.has(row.type_name)) labelsByType.set(row.type_name, []);
      labelsByType.get(row.type_name)!.push(row.label);
    }

    const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
    for (const [typeName, labels] of labelsByType) {
      // CREATE TYPE has no IF NOT EXISTS — swallow duplicate_object instead.
      await backup.$executeRawUnsafe(
        `DO $$ BEGIN CREATE TYPE "${typeName}" AS ENUM (${labels.map(quote).join(', ')}); EXCEPTION WHEN duplicate_object THEN NULL; END $$`
      );
      // Type may pre-exist with a stale label set — append any missing values.
      for (const label of labels) {
        await backup.$executeRawUnsafe(
          `ALTER TYPE "${typeName}" ADD VALUE IF NOT EXISTS ${quote(label)}`
        );
      }
    }
    debugLog(`[db-backup] Enum reconciliation complete: ${labelsByType.size} type(s) checked`);
  } catch (err: any) {
    // Degrade gracefully — a failed reconciliation just means enum drift (if
    // any) surfaces as per-table sync failures below, same as before.
    console.error(
      '[db-backup] Enum reconciliation failed — continuing with table sync:',
      String(err?.message || err).slice(0, 300)
    );
  }
}

interface BackupSyncResult {
  success: boolean;
  tablesSync: number;
  totalRows: number;
  error?: string;
}

// Hard wall-clock cap on a single sync. A healthy run is ~25s; if the primary
// or backup Postgres stalls mid-run, the copy has no per-statement timeout and
// would otherwise hang FOREVER — which is exactly what silently wedged the
// db-backup-sync scheduler job (its heartbeat stamps in a `finally` that a hung
// run never reaches, so /health/scheduler went 503 for ~22h before anyone
// noticed). Aborting here turns that silent hang into a fast failure result:
// the job throws, the scheduler stamps an error heartbeat, and /health/scheduler
// + the freshness check alert within one cycle instead of going dark.
const BACKUP_SYNC_TIMEOUT_MS = 5 * 60_000;

async function withHardTimeout(
  work: Promise<BackupSyncResult>,
  ms: number
): Promise<BackupSyncResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<BackupSyncResult>(resolve => {
    timer = setTimeout(
      () =>
        resolve({
          success: false,
          tablesSync: 0,
          totalRows: 0,
          error: `db backup sync exceeded hard timeout of ${Math.round(
            ms / 1000
          )}s — aborted so the scheduler alerts instead of hanging silently`,
        }),
      ms
    );
    // Never keep the process alive just for this watchdog.
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function syncDatabaseBackup(): Promise<BackupSyncResult> {
  const backupUrl = process.env.DATABASE_BACKUP_URL;
  if (!backupUrl) {
    debugLog('[db-backup] DATABASE_BACKUP_URL not set, skipping sync');
    return {
      success: false,
      tablesSync: 0,
      totalRows: 0,
      error: 'DATABASE_BACKUP_URL not configured',
    };
  }

  const primaryUrl = process.env.DATABASE_URL || '';
  return withBackupSyncEvidence(primaryUrl, backupUrl, () =>
    withHardTimeout(copyDatabaseBackup(primaryUrl, backupUrl), BACKUP_SYNC_TIMEOUT_MS)
  );
}

async function copyDatabaseBackup(
  primaryUrl: string,
  backupUrl: string
): Promise<BackupSyncResult> {
  const primary = new PrismaClient({ datasourceUrl: primaryUrl });
  const backup = new PrismaClient({ datasourceUrl: backupUrl });

  let tablesSync = 0;
  let totalRows = 0;
  const failedTables: string[] = [];
  // Capture WHY each table failed, not just its name — the per-table error was
  // previously console-only, so the recurring "6 table(s) not synced" Sentry
  // issue carried no actionable cause.
  const failedTableReasons: Array<{ table: string; reason: string }> = [];

  try {
    // Test connectivity
    await primary.$queryRaw`SELECT 1`;
    await backup.$queryRaw`SELECT 1`;
    debugLog('[db-backup] Connected to both primary and backup databases');

    // Get all table names from the public schema on primary
    const tableNames = await primary.$queryRaw<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename != '_prisma_migrations'
    `;
    const existingTables = new Set(tableNames.map(t => t.tablename));

    // Bring the backup's enum catalog up to date with the primary before
    // touching any tables — missing types/values are the root cause of the
    // recurring 42704/22P02 per-table sync failures.
    await reconcileBackupEnums(primary, backup);

    // NOTE: no `SET session_replication_role = replica` here. It only ever
    // applied to one pooled Prisma connection while inserts ran on others, so
    // it never disabled FK checks reliably — and making it stick would be
    // worse: inserts would "succeed" against tables emptied by a later
    // TRUNCATE CASCADE, producing a silently orphaned, unrestorable backup.
    // Inserts run with FKs enforced; a violation is the alarm we want.

    // Build a map of backup table → set of existing columns.
    // This lets us skip columns that haven't been migrated on the backup DB yet
    // (schema drift between primary and backup after recent migrations).
    const backupColumnCache = new Map<string, Set<string>>();
    const primaryColumnCache = new Map<string, string[]>();
    // Enum (USER-DEFINED) columns must be inserted with an explicit ::"<EnumType>"
    // cast — $executeRawUnsafe binds params as text, and Postgres won't implicitly
    // coerce text → enum (error 42804). Maps table → column → {dataType, udtName}.
    const primaryColumnTypeCache = new Map<
      string,
      Map<string, { dataType: string; udtName: string }>
    >();
    const enumCastForColumn = (table: string, col: string): string =>
      enumCastTypeName(primaryColumnTypeCache.get(table)?.get(col));
    const resolvePrimaryColumns = async (table: string): Promise<string[]> => {
      const cached = primaryColumnCache.get(table);
      if (cached && cached.length > 0) return cached;
      const rows = await primary.$queryRawUnsafe<Array<{ column_name: string }>>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${table}' ORDER BY ordinal_position ASC`
      );
      const columns = rows.map(row => row.column_name);
      primaryColumnCache.set(table, columns);
      return columns;
    };
    try {
      const backupCols = await backup.$queryRaw<Array<{ table_name: string; column_name: string }>>`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
      `;
      for (const row of backupCols) {
        if (!backupColumnCache.has(row.table_name))
          backupColumnCache.set(row.table_name, new Set());
        backupColumnCache.get(row.table_name)!.add(row.column_name);
      }

      const primaryCols = await primary.$queryRaw<
        Array<{
          table_name: string;
          column_name: string;
          ordinal_position: number;
          data_type: string;
          udt_name: string;
        }>
      >`
        SELECT table_name, column_name, ordinal_position, data_type, udt_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name ASC, ordinal_position ASC
      `;
      for (const row of primaryCols) {
        if (!primaryColumnCache.has(row.table_name)) primaryColumnCache.set(row.table_name, []);
        primaryColumnCache.get(row.table_name)!.push(row.column_name);
        if (!primaryColumnTypeCache.has(row.table_name))
          primaryColumnTypeCache.set(row.table_name, new Map());
        primaryColumnTypeCache
          .get(row.table_name)!
          .set(row.column_name, { dataType: row.data_type, udtName: row.udt_name });
      }
    } catch (colErr: any) {
      console.error(
        '[db-backup] Failed to read backup column info — will attempt sync without column filtering:',
        colErr.message?.slice(0, 200)
      );
    }

    // A primary table missing from TABLES_IN_ORDER never reaches the backup
    // (and, if anything references it, gets wiped by the TRUNCATE CASCADE
    // below) — alarm instead of skipping silently. New models are caught in
    // CI by db-backup-table-order.test.ts; this guards live schema drift.
    const unlistedTables = [...existingTables]
      .filter(t => !TABLES_IN_ORDER.includes(t) && !BACKUP_EXCLUDED_TABLES.has(t))
      .sort();
    if (unlistedTables.length > 0) {
      const msg = `DB backup sync: ${unlistedTables.length} primary table(s) not in TABLES_IN_ORDER, not backed up: ${unlistedTables.join(', ')}`;
      console.error('[db-backup]', msg);
      captureException(new Error(msg), { extra: { unlistedTables } });
    }

    const syncableTables = TABLES_IN_ORDER.filter(t => existingTables.has(t));

    // Empty ALL tables in one statement before inserting anything. The old
    // per-table `TRUNCATE "<table>" CASCADE` was the root cause of the
    // recurring 23503 partial failures: truncating "Game" cascaded into the
    // already-synced "Post", so every Post child (Comment, PostUpvote,
    // PostBookmark, Notification) hit an FK violation on insert — and the
    // cascade-deleted rows were never restored. Tables missing on the backup
    // (it never receives `prisma migrate deploy`) are excluded here; their
    // INSERT below fails loudly into failedTables instead.
    const truncatable =
      backupColumnCache.size > 0
        ? syncableTables.filter(t => backupColumnCache.has(t))
        : syncableTables;
    if (truncatable.length > 0) {
      await backup.$executeRawUnsafe(
        `TRUNCATE TABLE ${truncatable.map(t => `"${t}"`).join(', ')} CASCADE`
      );
    }

    // All primary reads happen inside one REPEATABLE READ transaction so every
    // table is captured from the same snapshot — otherwise rows written while
    // the sync runs can reference parents that were read out before they
    // existed, failing the child table's insert.
    await primary.$transaction(
      async tx => {
        for (const table of syncableTables) {
          try {
            // Build column list: if we have backup column info, restrict to columns
            // that exist in both primary data AND backup schema (handles schema drift
            // where backup is missing recently-added migration columns).
            const allPrimaryColumns = await resolvePrimaryColumns(table);
            const backupCols = backupColumnCache.get(table);
            // Deferred FK columns (cycles / self-references) are inserted as
            // NULL by omission and back-filled after every table is loaded.
            const deferredCols = DEFERRED_FK_COLUMNS[table] ?? [];
            const columns = (
              backupCols ? allPrimaryColumns.filter(c => backupCols.has(c)) : allPrimaryColumns
            ).filter(c => !deferredCols.includes(c));

            if (columns.length === 0) {
              console.error(
                `[db-backup] Table "${table}" has no matching columns in backup — skipping`
              );
              failedTables.push(table);
              failedTableReasons.push({ table, reason: 'no matching columns in backup' });
              continue;
            }

            const skippedCols = allPrimaryColumns.filter(
              c => !columns.includes(c) && !deferredCols.includes(c)
            );
            if (skippedCols.length > 0) {
              debugLog(
                `[db-backup] "${table}": skipping ${skippedCols.length} column(s) missing from backup: ${skippedCols.join(', ')}`
              );
            }

            const colList = columns.map(c => `"${c}"`).join(', ');
            const orderBy = columns.map(c => `"${c}"`).join(', ');
            const [{ count: totalCountRaw }] = await tx.$queryRawUnsafe<
              Array<{ count: bigint | number | string }>
            >(`SELECT COUNT(*) AS count FROM "${table}"`);
            const totalTableRows = Number(totalCountRaw);

            if (totalTableRows === 0) {
              tablesSync++;
              continue;
            }

            // Insert in batches of 500 to avoid query size limits
            const batchSize = 500;
            for (let offset = 0; offset < totalTableRows; offset += batchSize) {
              const batch = await tx.$queryRawUnsafe<Record<string, unknown>[]>(
                `SELECT ${colList} FROM "${table}" ORDER BY ${orderBy} LIMIT ${batchSize} OFFSET ${offset}`
              );
              if (batch.length === 0) break;
              const valueClauses: string[] = [];
              const params: unknown[] = [];
              let paramIdx = 1;

              for (const row of batch) {
                const { clause, nextParamIdx } = buildRowValuesClause(columns, paramIdx, col =>
                  enumCastForColumn(table, col)
                );
                paramIdx = nextParamIdx;
                valueClauses.push(clause);
                for (const col of columns) {
                  params.push(row[col]);
                }
              }

              const sql = `INSERT INTO "${table}" (${colList}) VALUES ${valueClauses.join(', ')}`;
              await backup.$executeRawUnsafe(sql, ...params);
            }

            totalRows += totalTableRows;
            tablesSync++;
            debugLog(`[db-backup] ${table}: ${totalTableRows} rows synced`);
          } catch (err: any) {
            const reason = String(err?.message || err).slice(0, 300);
            console.error(`[db-backup] Failed to sync table "${table}":`, reason);
            failedTables.push(table);
            failedTableReasons.push({ table, reason });
          }
        }

        // Back-fill the deferred FK columns now that every table's rows exist.
        // These form FK shapes no insert order can satisfy: the
        // User.organization_id <-> Organization.league_owner_id cycle and
        // Comment.parent_id self-references.
        for (const [table, cols] of Object.entries(DEFERRED_FK_COLUMNS)) {
          if (!existingTables.has(table) || failedTables.includes(table)) continue;
          const backupCols = backupColumnCache.get(table);
          for (const col of cols) {
            if (backupCols && !backupCols.has(col)) continue; // backup schema drift
            try {
              const batchSize = 500;
              for (let offset = 0; ; offset += batchSize) {
                const rows = await tx.$queryRawUnsafe<Array<{ id: unknown; value: unknown }>>(
                  `SELECT "id", "${col}" AS value FROM "${table}" WHERE "${col}" IS NOT NULL ORDER BY "id" LIMIT ${batchSize} OFFSET ${offset}`
                );
                if (rows.length === 0) break;
                const valueClauses: string[] = [];
                const params: unknown[] = [];
                let paramIdx = 1;
                for (const row of rows) {
                  valueClauses.push(`($${paramIdx++}, $${paramIdx++})`);
                  params.push(row.id, row.value);
                }
                await backup.$executeRawUnsafe(
                  `UPDATE "${table}" AS t SET "${col}" = v.value FROM (VALUES ${valueClauses.join(', ')}) AS v(id, value) WHERE t."id" = v.id`,
                  ...params
                );
                if (rows.length < batchSize) break;
              }
            } catch (err: any) {
              const reason = String(err?.message || err).slice(0, 300);
              console.error(`[db-backup] Failed to back-fill "${table}"."${col}":`, reason);
              if (!failedTables.includes(table)) failedTables.push(table);
              failedTableReasons.push({ table: `${table}.${col}`, reason });
            }
          }
        }
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        // Prisma's default interactive-transaction timeout is 5s — far too
        // short for a full-database read. The snapshot only holds reads on
        // the primary; 15 minutes is a generous ceiling, not an expectation.
        timeout: 15 * 60_000,
        maxWait: 60_000,
      }
    );

    if (failedTables.length > 0) {
      const backupErr = new Error(
        `DB backup sync partially failed — ${failedTables.length} table(s) not synced: ${failedTables.join(', ')}`
      );
      console.error('[db-backup]', backupErr.message);
      // Stringify the reasons — Sentry flattens raw object arrays in `extra`
      // to "[Array]", which is how the cause got lost in the first place.
      captureException(backupErr, {
        extra: {
          failedTables,
          failedTableReasons: JSON.stringify(failedTableReasons),
          tablesSync,
          totalRows,
        },
      });
    }

    // Reset sequences to match primary
    try {
      const sequences = await primary.$queryRaw<Array<{ sequence_name: string }>>`
        SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema = 'public'
      `;
      for (const seq of sequences) {
        try {
          const [val] = await primary.$queryRawUnsafe<[{ last_value: bigint }]>(
            `SELECT last_value FROM "${seq.sequence_name}"`
          );
          await backup.$executeRawUnsafe(
            `SELECT setval('"${seq.sequence_name}"', ${val.last_value}, true)`
          );
        } catch {
          // Sequence may not exist on backup yet
        }
      }
    } catch {
      debugLog('[db-backup] Sequence sync skipped');
    }

    // A partial sync is a failure — the old unconditional `success: true` made
    // the scheduler log a green "sync complete" over 30 days of missing tables.
    if (failedTables.length > 0) {
      return {
        success: false,
        tablesSync,
        totalRows,
        error: `${failedTables.length} table(s) not synced: ${failedTables.join(', ')}`,
      };
    }

    console.log(`[db-backup] Sync complete: ${tablesSync} tables, ${totalRows} total rows`);
    return { success: true, tablesSync, totalRows };
  } catch (err: any) {
    console.error('[db-backup] Sync failed:', err.message);
    return { success: false, tablesSync, totalRows, error: err.message };
  } finally {
    await primary.$disconnect();
    await backup.$disconnect();
  }
}
