import { espnAdapter } from '../lib/proSchedule/espnAdapter.js';
import { ingestFixtures, ingestLeague } from '../lib/proSchedule/ingest.js';
import { seatGeekAdapter } from '../lib/proSchedule/seatGeekAdapter.js';
import { WWE_FIXTURES_2026 } from '../lib/proSchedule/wweSchedule2026.js';
import { prisma } from '../lib/prisma.js';
import { PRO_TEAM_SEED } from '../lib/proTeams.js';
import { getProScheduleWindowDays } from '../lib/proSchedule/window.js';
import type { ProLeague } from '@prisma/client';

/**
 * One-time rollout of the pro-sports data layer.
 *
 * Production shipped the pro-sports CODE and tables but was NEVER seeded — zero
 * pro teams for any league — so pro team pages, matchup colors, and WWE event
 * pages never appeared. This seeds the franchises + the WWE promotion and
 * ingests the curated WWE schedule so those pages exist.
 *
 * Runs only when PRO_SPORTS_BOOTSTRAP=1 (set deliberately for a rollout deploy),
 * on a single replica (called under runClusterOnce in index.ts), and is fully
 * idempotent — proTeam upsert on external_ref + event upsert on
 * pro_external_ref, so a re-run (or leaving the flag on) is a safe no-op. Never
 * fatal: a failure here must not take down server startup.
 */
export async function runProSportsBootstrap(): Promise<void> {
  if (process.env.PRO_SPORTS_BOOTSTRAP !== '1') return;
  try {
    // 1) Seed the pro franchises + the WWE promotion. Mirrors seed-pro-teams.ts.
    const seedRefs = PRO_TEAM_SEED.map(team => team.external_ref);
    const existingTeams = await prisma.proTeam.findMany({
      where: { external_ref: { in: seedRefs } },
      select: {
        id: true,
        external_ref: true,
        league: true,
        name: true,
        short_name: true,
        abbreviation: true,
        city: true,
        state: true,
        conference: true,
        division: true,
        venue_name: true,
        venue_address: true,
        venue_lat: true,
        venue_lng: true,
        timezone: true,
        primary_color: true,
        active: true,
      },
      take: 1000,
    });
    const existingByRef = new Map(existingTeams.map(team => [team.external_ref, team]));
    const toCreate = PRO_TEAM_SEED.filter(team => !existingByRef.has(team.external_ref));
    const toUpdate = PRO_TEAM_SEED.filter(team => {
      const existing = existingByRef.get(team.external_ref);
      if (!existing) return false;
      return (
        existing.league !== team.league ||
        existing.name !== team.name ||
        existing.short_name !== team.short_name ||
        existing.abbreviation !== team.abbreviation ||
        existing.city !== team.city ||
        existing.state !== team.state ||
        existing.conference !== team.conference ||
        existing.division !== team.division ||
        existing.venue_name !== team.venue_name ||
        existing.venue_address !== team.venue_address ||
        existing.venue_lat !== team.venue_lat ||
        existing.venue_lng !== team.venue_lng ||
        existing.timezone !== team.timezone ||
        existing.primary_color !== team.primary_color ||
        existing.active !== true
      );
    });

    if (toCreate.length > 0) {
      await prisma.proTeam.createMany({
        data: toCreate.map(team => ({ ...team, active: true })),
        skipDuplicates: true,
      });
    }

    for (const team of toUpdate) {
      await prisma.proTeam.update({
        where: { external_ref: team.external_ref },
        data: {
          league: team.league,
          name: team.name,
          short_name: team.short_name,
          abbreviation: team.abbreviation,
          city: team.city,
          state: team.state,
          conference: team.conference,
          division: team.division,
          venue_name: team.venue_name,
          venue_address: team.venue_address,
          venue_lat: team.venue_lat,
          venue_lng: team.venue_lng,
          timezone: team.timezone,
          primary_color: team.primary_color,
          active: true,
        },
      });
    }
    console.log(
      `[pro-bootstrap] seeded/updated ${PRO_TEAM_SEED.length} pro teams ` +
        `(created=${toCreate.length}, updated=${toUpdate.length})`
    );

    // 2) Ingest the curated WWE schedule (touring shows -> Event rows pinned to
    //    the WWE promotion). Idempotent on Event.pro_external_ref.
    const stats = await ingestFixtures('wwe', WWE_FIXTURES_2026);
    console.log(
      `[pro-bootstrap] WWE ingest: fetched=${stats.fetched} created=${stats.created} ` +
        `updated=${stats.updated} skipped=${stats.skipped}`
    );
    if (stats.failures.length) {
      console.warn(
        '[pro-bootstrap] WWE ingest skips:',
        stats.failures.slice(0, 10).map(f => `${f.external_ref}: ${f.reason}`)
      );
    }

    // 3) Ingest the ESPN leagues over a long enough window to cover the full
    //    NFL preseason slate instead of just the next couple of weeks. MLB
    //    remains in-season; NBA/WNBA return empty in the offseason (a valid
    //    result, not a failure). Home games resolve via the seeded team venue,
    //    so this works even if per-fixture geocoding is unavailable.
    const espn = espnAdapter();
    const windowDays = getProScheduleWindowDays();
    const from = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const to = new Date(Date.now() + windowDays * 24 * 60 * 60 * 1000);
    for (const league of ['nfl', 'mlb', 'nba', 'wnba', 'ncaa', 'minor', 'other'] as ProLeague[]) {
      try {
        const adapter =
          (league === 'ncaa' || league === 'minor' || league === 'other') &&
          ['combined', 'seatgeek'].includes(process.env.PRO_SCHEDULE_PROVIDER ?? '') &&
          process.env.SEATGEEK_CLIENT_ID
            ? seatGeekAdapter(process.env.SEATGEEK_CLIENT_ID)
            : espn;
        const s = await ingestLeague(adapter, league, from, to);
        console.log(
          `[pro-bootstrap] ${league} ingest: created=${s.created} updated=${s.updated} skipped=${s.skipped}`
        );
      } catch (e) {
        console.warn(`[pro-bootstrap] ${league} ingest failed (non-fatal):`, (e as Error).message);
      }
    }
  } catch (err) {
    console.error('[pro-bootstrap] failed (non-fatal):', err);
  }
}
