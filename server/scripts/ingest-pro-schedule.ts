#!/usr/bin/env npx tsx
/**
 * ingest-pro-schedule.ts
 *
 * Pulls pro fixtures from the configured provider and upserts them as Event
 * rows. Idempotent on Event.pro_external_ref — safe to re-run, and re-running is
 * how postponed and relocated games get corrected.
 *
 * Requires ProTeam rows to exist first (scripts/seed-pro-teams.ts --apply):
 * a fixture whose team is missing is reported and skipped, never invented.
 *
 * Dry run by default. Use --apply to write.
 *   cd server
 *   PRO_SCHEDULE_JSON_PATH=./nba-2026.json npx tsx scripts/ingest-pro-schedule.ts --league=nba
 *   PRO_SCHEDULE_JSON_PATH=./nba-2026.json npx tsx scripts/ingest-pro-schedule.ts --league=nba --apply
 *   ... --days=120     # horizon, default 60
 */
import type { ProLeague } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { NO_ADAPTER_MESSAGE, resolveConfiguredAdapter } from '../src/lib/proSchedule/adapters.js';
import { ingestLeague } from '../src/lib/proSchedule/ingest.js';

const ALL_LEAGUES: ProLeague[] = ['nfl', 'nba', 'wnba', 'mlb', 'wwe', 'ncaa', 'minor', 'other'];

const apply = process.argv.includes('--apply');
const leagueArg = process.argv.find(a => a.startsWith('--league='))?.split('=')[1];
const daysArg = process.argv.find(a => a.startsWith('--days='))?.split('=')[1];

async function main() {
  const adapter = resolveConfiguredAdapter();
  if (!adapter) {
    console.warn(NO_ADAPTER_MESSAGE);
    return;
  }

  if (leagueArg && !ALL_LEAGUES.includes(leagueArg as ProLeague)) {
    console.error(
      `[ingest-pro-schedule] unknown league "${leagueArg}". Valid: ${ALL_LEAGUES.join(', ')}`
    );
    process.exitCode = 1;
    return;
  }

  const leagues = leagueArg ? [leagueArg as ProLeague] : ALL_LEAGUES;
  const days = daysArg ? Number(daysArg) : 60;
  if (!Number.isFinite(days) || days <= 0) {
    console.error(`[ingest-pro-schedule] --days must be a positive number, got "${daysArg}"`);
    process.exitCode = 1;
    return;
  }

  const from = new Date();
  const to = new Date(from.getTime() + days * 24 * 60 * 60 * 1000);

  console.log(
    `[ingest-pro-schedule] ${apply ? 'APPLY' : 'DRY RUN'} via ${adapter.name}, ` +
      `${leagues.join(',')} over ${days}d (${from.toISOString()} → ${to.toISOString()})`
  );

  let totalFailures = 0;
  for (const league of leagues) {
    if (!adapter.leagues.includes(league)) {
      console.log(`  ${league}: adapter does not serve this league, skipping`);
      continue;
    }
    try {
      const stats = await ingestLeague(adapter, league, from, to, { dryRun: !apply });
      totalFailures += stats.failures.length;
    } catch (err) {
      // One league's provider failure must not abort the others.
      totalFailures += 1;
      console.error(
        `[ingest-pro-schedule] ${league} failed:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  if (!apply)
    console.log('\n[ingest-pro-schedule] dry run — nothing written. Re-run with --apply.');
  if (totalFailures > 0) process.exitCode = 1;
}

main()
  .catch(err => {
    console.error('[ingest-pro-schedule] failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
