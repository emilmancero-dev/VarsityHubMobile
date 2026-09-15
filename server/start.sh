#!/bin/sh
set -e

echo "[startup] Validating environment variables..."
for var in DATABASE_URL NODE_ENV; do
  if [ -z "$(eval echo \\$$var)" ]; then
    echo "[startup] ❌ ERROR: Required env var missing: $var"
    exit 1
  fi
done
echo "[startup] ✓ Required env vars present"

MASKED_DB_URL="$(printf "%s" "$DATABASE_URL" | sed -E 's#://([^:/]+):[^@]*@#://\1:***@#')"
DB_HOSTPORT="$(printf "%s" "$DATABASE_URL" | sed -E 's#^[^@]*@([^/]+).*#\1#')"
echo "[startup] DATABASE_URL: $MASKED_DB_URL"
echo "[startup] DB host:port: ${DB_HOSTPORT:-unknown}"
echo "[startup] NODE_ENV: $NODE_ENV"

STARTUP_PLACEHOLDER_PID=""

start_startup_placeholder() {
  node <<'EOF' &
const http = require('http');

const port = Number(process.env.PORT || 4000);
const host = process.env.HOST || '0.0.0.0';

const server = http.createServer((req, res) => {
  const isHealthRequest =
    req.url === '/health' || req.url === '/health/' || String(req.url || '').startsWith('/health?');

  res.setHeader('Content-Type', 'application/json');

  if (isHealthRequest) {
    res.statusCode = 200;
    res.end(
      JSON.stringify({
        status: 'starting',
        message: 'API startup in progress',
        timestamp: new Date().toISOString(),
      })
    );
    return;
  }

  res.statusCode = 503;
  res.setHeader('Retry-After', '15');
  res.end(
    JSON.stringify({
      status: 'starting',
      message: 'API startup in progress',
    })
  );
});

server.listen(port, host, () => {
  console.log(`[startup] Placeholder server listening on http://${host}:${port}`);
});

const shutdown = () => {
  server.close(() => process.exit(0));
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
EOF
  STARTUP_PLACEHOLDER_PID=$!
}

stop_startup_placeholder() {
  if [ -n "${STARTUP_PLACEHOLDER_PID:-}" ] && kill -0 "$STARTUP_PLACEHOLDER_PID" 2>/dev/null; then
    echo "[startup] Stopping placeholder server..."
    kill "$STARTUP_PLACEHOLDER_PID" 2>/dev/null || true
    wait "$STARTUP_PLACEHOLDER_PID" 2>/dev/null || true
  fi
  STARTUP_PLACEHOLDER_PID=""
}

trap 'stop_startup_placeholder' EXIT INT TERM

start_startup_placeholder

echo "[startup] Resolving known stale Prisma history rows..."
./node_modules/.bin/prisma migrate resolve --rolled-back add_severity_to_reports 2>/dev/null || true

PRISMA_MIGRATE_RETRIES="${PRISMA_MIGRATE_RETRIES:-3}"
PRISMA_MIGRATE_SLEEP_SECS="${PRISMA_MIGRATE_SLEEP_SECS:-5}"
PRISMA_MIGRATE_TIMEOUT_SECS="${PRISMA_MIGRATE_TIMEOUT_SECS:-90}"

attempt=1
migrate_ok=0
while [ "$attempt" -le "$PRISMA_MIGRATE_RETRIES" ]; do
  echo "[startup] Running prisma migrate deploy (attempt $attempt/$PRISMA_MIGRATE_RETRIES, timeout ${PRISMA_MIGRATE_TIMEOUT_SECS}s)..."
  if timeout "$PRISMA_MIGRATE_TIMEOUT_SECS" ./node_modules/.bin/prisma migrate deploy; then
    migrate_ok=1
    echo "[startup] ✓ Migrations applied successfully"
    break
  fi

  status=$?
  if [ "$status" -eq 124 ]; then
    echo "[startup] ⚠️  prisma migrate deploy timed out after ${PRISMA_MIGRATE_TIMEOUT_SECS}s"
  else
    echo "[startup] ⚠️  prisma migrate deploy exited with status $status"
  fi

  attempt=$((attempt + 1))
  if [ "$attempt" -le "$PRISMA_MIGRATE_RETRIES" ]; then
    echo "[startup] Retrying in ${PRISMA_MIGRATE_SLEEP_SECS}s..."
    sleep "$PRISMA_MIGRATE_SLEEP_SECS"
  fi
done

if [ "$migrate_ok" -ne 1 ]; then
  echo "[startup] ⚠️  Migration step did not complete successfully; capturing Prisma status and continuing startup."
  ./node_modules/.bin/prisma migrate status || true
fi

# The backup Postgres never receives `prisma migrate deploy` — its schema only
# changes here. Without this step, every new migration adding a table/column
# makes the 6-hourly db-backup-sync fail that table with 42P01 until someone
# reconciles by hand (Sentry VARSITYHUB-1D: SportProgram, CoachApplication).
# `db push` (not `migrate deploy`) because the backup has no migration
# history — it diffs the live schema against schema.prisma and converges.
# --accept-data-loss is safe here: the backup is a mirror whose rows are
# rewritten from the primary on every sync. Non-fatal: a backup outage must
# never block API startup; the sync job reports per-table failures instead.
if [ -n "${DATABASE_BACKUP_URL:-}" ]; then
  # Pre-push reconcile. The v1.0.2 migration created
  # TransactionLog_apple_transaction_id_key as a PARTIAL unique index
  # (WHERE apple_transaction_id IS NOT NULL). Prisma's `@unique` models a FULL
  # unique index of the same name, so `db push` (which DIFFS schema.prisma against
  # the live DB, unlike `migrate deploy` which just replays SQL and never notices)
  # tries to CREATE that index and collides on the name — `relation
  # "TransactionLog_apple_transaction_id_key" already exists` — aborting the ENTIRE
  # push and silently freezing all NEWER Prisma schema on the backup replica.
  # Drop ONLY the partial variant so the push below recreates it as the full unique
  # index it expects; a no-op once converged (verified 2026-09-14). Backup-only +
  # schema-only (backup rows are rewritten from primary every 6h) → safe. This must
  # NEVER touch the primary — its partial index matches its migration history.
  echo "[startup] Reconciling backup TransactionLog unique index (pre-push)..."
  DATABASE_URL="$DATABASE_BACKUP_URL" timeout 60 ./node_modules/.bin/prisma db execute --url "$DATABASE_BACKUP_URL" --stdin <<'SQL' || echo "[startup] ⚠️  Backup index reconcile skipped (non-fatal)"
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'TransactionLog_apple_transaction_id_key'
      AND indexdef LIKE '%WHERE%'
  ) THEN
    EXECUTE 'DROP INDEX "TransactionLog_apple_transaction_id_key"';
  END IF;
END $$;
SQL
  echo "[startup] Reconciling backup DB schema (prisma db push)..."
  if DATABASE_URL="$DATABASE_BACKUP_URL" timeout 180 ./node_modules/.bin/prisma db push --skip-generate --accept-data-loss; then
    echo "[startup] ✓ Backup DB schema in sync"
  else
    echo "[startup] ⚠️  Backup schema push failed (non-fatal); db-backup-sync will surface per-table failures"
  fi
fi

# Ensure the raw-SQL ad-purchase tables exist. These five (AdPurchaseIntent,
# AdPurchaseIntentItem, AdPurchaseIntentRevision, AdPurchaseReceipt, AdSlotHold)
# are NOT Prisma models — they have no schema.prisma / migrations entry, so
# neither `migrate deploy` (primary) nor `db push` (backup) creates them. Worse,
# the backup `db push --accept-data-loss` above actively DROPS them (verified
# 2026-09-14), so this reconciliation MUST run AFTER it. The DDL
# (prisma/raw-sql/ad-purchase-tables.sql) is fully idempotent (CREATE ... IF NOT
# EXISTS) and is the only version-controlled definition of these tables.
#   - primary: no-op today (tables already present); guarantees a
#     rebuilt-from-migrations primary still gets them.
#   - backup: gives the ad-purchase financial history DR coverage — once the
#     tables exist, the 6-hourly db-backup-sync replicates their rows
#     (RAW_SQL_BACKUP_TABLES in src/lib/dbBackupTables.ts).
# Non-fatal: a raw-SQL apply failure must never block API startup.
RAW_SQL_FILE="prisma/raw-sql/ad-purchase-tables.sql"
if [ -f "$RAW_SQL_FILE" ]; then
  echo "[startup] Ensuring raw-SQL ad-purchase tables on primary..."
  if timeout 120 ./node_modules/.bin/prisma db execute --url "$DATABASE_URL" --file "$RAW_SQL_FILE"; then
    echo "[startup] ✓ Raw-SQL ad-purchase tables ensured on primary"
  else
    echo "[startup] ⚠️  Raw-SQL apply to primary failed/timed out (non-fatal)"
  fi
  if [ -n "${DATABASE_BACKUP_URL:-}" ]; then
    echo "[startup] Ensuring raw-SQL ad-purchase tables on backup replica..."
    if timeout 120 ./node_modules/.bin/prisma db execute --url "$DATABASE_BACKUP_URL" --file "$RAW_SQL_FILE"; then
      echo "[startup] ✓ Raw-SQL ad-purchase tables ensured on backup replica"
    else
      echo "[startup] ⚠️  Raw-SQL apply to backup failed/timed out (non-fatal); db-backup-sync will surface per-table failures"
    fi
  fi
fi

stop_startup_placeholder
echo "[startup] 🚀 Starting API server..."
exec node dist/index.js
