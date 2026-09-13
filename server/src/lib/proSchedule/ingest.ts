import type { EventStatus, ProLeague } from '@prisma/client';
import { prisma } from '../prisma.js';
import {
  attachTouringPromotion,
  type ResolvedFixture,
  resolveFixture,
  TOURING_LEAGUES,
  type ProTeamVenue,
} from './resolveFixture.js';
import type { ProFixture, ProScheduleAdapter } from './types.js';

/**
 * Upserts normalized fixtures into Event rows.
 *
 * Idempotent on Event.pro_external_ref: a re-run updates a moved or relocated
 * fixture in place rather than creating a second event page. This matters more
 * than it sounds — a duplicate page splits the fans posting from one game
 * across two feeds, and the first one to exist owns the EventPostingUnlock rows.
 *
 * Per-fixture failures are collected and reported, never fatal: one malformed
 * record in a 2,430-game MLB feed must not abort the other 2,429.
 */

export type IngestStats = {
  league: ProLeague;
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
  failures: Array<{ external_ref: string; reason: string }>;
};

export type IngestOptions = {
  /** Report what would change without writing. */
  dryRun?: boolean;
};

type ExistingEventSnapshot = {
  id: string;
  pro_external_ref: string | null;
  title: string;
  date: Date;
  timezone: string | null;
  location: string | null;
  latitude: number | null;
  longitude: number | null;
  pro_home_team_id: string | null;
  pro_away_team_id: string | null;
  pro_league: ProLeague | null;
  live_window_hours_after_start: number | null;
  status: EventStatus;
};

function hasProviderFieldChanges(existing: ExistingEventSnapshot, next: ResolvedFixture): boolean {
  return (
    existing.title !== next.title ||
    existing.date.getTime() !== next.date.getTime() ||
    existing.timezone !== next.timezone ||
    existing.location !== next.location ||
    existing.latitude !== next.latitude ||
    existing.longitude !== next.longitude ||
    existing.pro_home_team_id !== next.pro_home_team_id ||
    existing.pro_away_team_id !== next.pro_away_team_id ||
    existing.pro_league !== next.league ||
    existing.live_window_hours_after_start !== next.live_window_hours_after_start ||
    existing.status !== next.status
  );
}

async function loadTeams(league: ProLeague): Promise<Map<string, ProTeamVenue>> {
  const teams = await prisma.proTeam.findMany({
    where: { league, active: true },
    select: {
      id: true,
      external_ref: true,
      name: true,
      short_name: true,
      venue_name: true,
      venue_address: true,
      venue_lat: true,
      venue_lng: true,
      timezone: true,
    },
    take: 1000,
  });
  return new Map(teams.map(t => [t.external_ref, t]));
}

export async function ingestFixtures(
  league: ProLeague,
  fixtures: ProFixture[],
  options: IngestOptions = {}
): Promise<IngestStats> {
  const stats: IngestStats = {
    league,
    fetched: fixtures.length,
    created: 0,
    updated: 0,
    skipped: 0,
    failures: [],
  };

  if (fixtures.length === 0) return stats;

  const teamsByRef = await loadTeams(league);

  const refs = fixtures.map(f => f.external_ref);
  const existing = await prisma.event.findMany({
    where: { pro_external_ref: { in: refs } },
    select: {
      id: true,
      pro_external_ref: true,
      title: true,
      date: true,
      timezone: true,
      location: true,
      latitude: true,
      longitude: true,
      pro_home_team_id: true,
      pro_away_team_id: true,
      pro_league: true,
      live_window_hours_after_start: true,
      status: true,
    },
    take: 10000,
  });
  const existingByRef = new Map(
    existing.flatMap(e => (e.pro_external_ref ? [[e.pro_external_ref, e] as const] : []))
  );

  // A touring promotion's shows name no teams, so they must be pinned to the
  // promotion row or its page would render empty while its events existed.
  const promotionRefs = new Map<ProLeague, string>();
  if (TOURING_LEAGUES.has(league)) {
    const first = [...teamsByRef.values()][0];
    if (first) promotionRefs.set(league, first.external_ref);
  }

  const createRows: Array<{
    pro_external_ref: string;
    title: string;
    date: Date;
    timezone: string | null;
    location: string | null;
    latitude: number | null;
    longitude: number | null;
    pro_home_team_id: string | null;
    pro_away_team_id: string | null;
    pro_league: ProLeague;
    live_window_hours_after_start: number | null;
    status: EventStatus;
    approval_status: 'approved';
    event_type: 'game';
  }> = [];
  const updates: Array<{
    id: string;
    externalRef: string;
    data: {
      title: string;
      date: Date;
      timezone: string | null;
      location: string | null;
      latitude: number | null;
      longitude: number | null;
      pro_home_team_id: string | null;
      pro_away_team_id: string | null;
      pro_league: ProLeague;
      live_window_hours_after_start: number | null;
      status: EventStatus;
    };
  }> = [];

  for (const rawFixture of fixtures) {
    const fixture = attachTouringPromotion(rawFixture, promotionRefs);
    const resolved = resolveFixture(fixture, teamsByRef);

    if (!resolved.ok) {
      stats.skipped += 1;
      const reason =
        resolved.error.code === 'UNKNOWN_HOME_TEAM' || resolved.error.code === 'UNKNOWN_AWAY_TEAM'
          ? `${resolved.error.code} (${resolved.error.ref}) — pro team seed is stale, run seed-pro-teams`
          : resolved.error.code;
      stats.failures.push({ external_ref: fixture.external_ref, reason });
      continue;
    }

    const v = resolved.value;
    const existingEvent = existingByRef.get(v.pro_external_ref);
    const isUpdate = Boolean(existingEvent);

    if (options.dryRun) {
      if (isUpdate) stats.updated += 1;
      else stats.created += 1;
      continue;
    }

    if (existingEvent) {
      if (hasProviderFieldChanges(existingEvent, v)) {
        updates.push({
          id: existingEvent.id,
          externalRef: fixture.external_ref,
          data: {
            // Deliberately narrow. Only provider-owned fields are refreshed —
            // banner_url, description, and the poster grants are set by staff on
            // our side and must survive a re-ingest.
            title: v.title,
            date: v.date,
            timezone: v.timezone,
            location: v.location,
            latitude: v.latitude,
            longitude: v.longitude,
            pro_home_team_id: v.pro_home_team_id,
            pro_away_team_id: v.pro_away_team_id,
            pro_league: v.league,
            live_window_hours_after_start: v.live_window_hours_after_start,
            status: v.status,
          },
        });
      }
      stats.updated += 1;
      continue;
    }

    createRows.push({
      pro_external_ref: v.pro_external_ref,
      title: v.title,
      date: v.date,
      timezone: v.timezone,
      location: v.location,
      latitude: v.latitude,
      longitude: v.longitude,
      pro_home_team_id: v.pro_home_team_id,
      pro_away_team_id: v.pro_away_team_id,
      pro_league: v.league,
      live_window_hours_after_start: v.live_window_hours_after_start,
      status: v.status,
      // System-ingested: no creator, and pre-approved because there is no human
      // submission to review. creator_id stays null, which marks these apart
      // from fan-pitched events.
      approval_status: 'approved',
      event_type: 'game',
    });
    stats.created += 1;
  }

  if (!options.dryRun && createRows.length > 0) {
    try {
      await prisma.event.createMany({
        data: createRows,
        skipDuplicates: true,
      });
    } catch (err) {
      for (const row of createRows) {
        try {
          await prisma.event.create({ data: row });
        } catch (createErr) {
          stats.skipped += 1;
          stats.created = Math.max(0, stats.created - 1);
          stats.failures.push({
            external_ref: row.pro_external_ref,
            reason: createErr instanceof Error ? createErr.message : String(createErr),
          });
        }
      }
      if (err instanceof Error) {
        console.warn(
          '[proScheduleIngest] createMany failed, fell back to per-row create:',
          err.message
        );
      }
    }
  }

  for (const update of updates) {
    try {
      await prisma.event.update({
        where: { id: update.id },
        data: update.data,
      });
    } catch (err) {
      stats.skipped += 1;
      stats.updated = Math.max(0, stats.updated - 1);
      stats.failures.push({
        external_ref: update.externalRef,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return stats;
}

export async function ingestLeague(
  adapter: ProScheduleAdapter,
  league: ProLeague,
  from: Date,
  to: Date,
  options: IngestOptions = {}
): Promise<IngestStats> {
  const fixtures = await adapter.fetchFixtures(league, from, to);
  const stats = await ingestFixtures(league, fixtures, options);

  if (stats.failures.length > 0) {
    console.warn(
      `[proScheduleIngest] ${adapter.name}/${league}: ${stats.failures.length} fixture(s) skipped`
    );
    for (const f of stats.failures.slice(0, 25)) {
      console.warn(`  ! ${f.external_ref}: ${f.reason}`);
    }
  }

  console.log(
    `[proScheduleIngest] ${adapter.name}/${league}${options.dryRun ? ' (dry run)' : ''}: ` +
      `fetched=${stats.fetched} created=${stats.created} updated=${stats.updated} skipped=${stats.skipped}`
  );

  return stats;
}
