import type { ProLeague } from '@prisma/client';

/**
 * A single fixture, normalized away from any one provider's response shape.
 *
 * Adapters translate their provider into this; the ingester only ever sees
 * this. That boundary is the point: the schedule provider is a purchasing
 * decision that may change, and swapping it must not touch ingestion logic.
 */
export type ProFixture = {
  /** Stable upstream key, `{league}:{providerFixtureId}`. Drives idempotency. */
  external_ref: string;
  league: ProLeague;
  /** Scheduled start, absolute. */
  starts_at: Date;

  /**
   * ProTeam.external_ref for each side. Null for touring promotions (WWE),
   * which have a venue and no matchup.
   */
  home_team_ref: string | null;
  away_team_ref: string | null;

  /**
   * Display title. Optional for two-team fixtures (derived as "Away at Home");
   * required in practice for WWE, where the show name is the only title.
   */
  title?: string | null;

  /**
   * Venue as reported by the provider. When null, the ingester falls back to
   * the home team's venue. Neutral-site and international games are exactly why
   * this exists — a London NFL game must not pin to the home stadium.
   */
  venue_name?: string | null;
  venue_address?: string | null;
  venue_lat?: number | null;
  venue_lng?: number | null;
  timezone?: string | null;

  /**
   * True when the game is NOT at the home team's stadium (neutral-site /
   * international). Such a fixture must never inherit the home stadium's
   * geofence — if it has no coords of its own it is quarantined instead. Home
   * games leave this false/undefined and keep the home-stadium fallback.
   */
  venue_is_neutral?: boolean;

  status: 'scheduled' | 'postponed' | 'cancelled';
};

export type ProScheduleAdapter = {
  /** Provider name, for logs. */
  readonly name: string;
  /** Leagues this adapter can serve. */
  readonly leagues: readonly ProLeague[];
  /**
   * Fetch fixtures for a league in [from, to]. Adapters must not throw for an
   * empty result — an empty array is a valid answer and must not be confused
   * with a failure, which throws.
   */
  fetchFixtures(league: ProLeague, from: Date, to: Date): Promise<ProFixture[]>;
};

/**
 * Hours after start that the geofenced posting window stays open, per league.
 * The window always opens 12 hours before start / game day (server/src/lib/geofencing.ts);
 * only the after-start bound is tunable, via Event.live_window_hours_after_start.
 *
 * Football gets the longest tail because tailgating outlasts the game itself;
 * baseball runs long and extra innings are unbounded in principle; basketball
 * fits the platform default.
 */
export const LIVE_WINDOW_HOURS_BY_LEAGUE: Record<ProLeague, number> = {
  nfl: 5,
  mlb: 4,
  wwe: 4,
  nba: 3,
  wnba: 3,
};
