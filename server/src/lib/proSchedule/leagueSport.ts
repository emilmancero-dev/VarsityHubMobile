import type { ProLeague } from '@prisma/client';

/**
 * Pro league → canonical sport slug (matches shared/sports-taxonomy.json).
 *
 * Pro events carry no team/game to borrow a sport from — only a `ProTeam.league`.
 * This is the single place that maps a league to the sport the map filter groups
 * by, so an NFL event surfaces under 🏈, an NBA event under 🏀, and so on.
 */
export const PRO_LEAGUE_SPORT: Record<ProLeague, string> = {
  nfl: 'football',
  nba: 'basketball',
  wnba: 'basketball',
  mlb: 'baseball',
  wwe: 'wrestling',
  ncaa: 'other',
  minor: 'other',
  other: 'other',
};

/** Sport slug for a pro league, or null when the league is absent/unknown. */
export function proLeagueToSport(league?: ProLeague | null): string | null {
  if (!league) return null;
  return PRO_LEAGUE_SPORT[league] ?? null;
}
