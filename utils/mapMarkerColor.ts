import type { EventMapData } from '@/components/EventMap.types';

/**
 * Map-pin color system.
 *
 * ONE consistent rule: a pin's color tells you its league TIER — Major / Minor /
 * NCAA / Other — matching the map's league-level filter chips (game-map.tsx) and
 * the on-map legend. It no longer varies by sport/team/type (that was the
 * inconsistent "colors vary" system owners flagged).
 *
 * Two overrides, highest precedence first:
 *  1. `isPresent`: the VIEWER is currently at this event's venue while it's
 *     live (owner ask, Sept 2026 — "if a user is at a sporting event it
 *     should pin"). This is per-viewer, computed client-side from the
 *     device's own location — never shared with other users — so it only
 *     ever lights up on that one person's map.
 *  2. `has_posts`: a page that already has viewer-visible posts is
 *     highlighted GOLD regardless of tier, so people can spot pages worth
 *     opening.
 * Cluster ("Multiple — tap to choose") pins are colored separately by
 * EventMap with the app tint, not here.
 *
 * Keep this in sync with the legend rows in components/EventMap.tsx and the
 * tier classification in app/game-map.tsx (Other = level ∉ {major,minor,college}).
 */
export const PRESENT_AT_VENUE_COLOR = '#0EA5E9'; // sky blue — you're here right now

export const HAS_POSTS_COLOR = '#D4AF37'; // gold — page has posts (override)

export const LEAGUE_LEVEL_COLORS = {
  major: '#1E3A8A', // navy — top tier
  minor: '#DC2626', // red — minor league (owner note, Sep 2026)
  college: '#9CA3AF', // silver — NCAA
  other: '#16A34A', // green — local / high-school / league-less / uncatalogued
} as const;

export function resolveMarkerColor(
  event: Pick<EventMapData, 'has_posts' | 'league_level'>,
  isPresent?: boolean
): string {
  if (isPresent) return PRESENT_AT_VENUE_COLOR;
  if (event.has_posts === true) return HAS_POSTS_COLOR;
  switch (event.league_level) {
    case 'major':
      return LEAGUE_LEVEL_COLORS.major;
    case 'minor':
      return LEAGUE_LEVEL_COLORS.minor;
    case 'college':
      return LEAGUE_LEVEL_COLORS.college;
    default:
      // Everything without a tiered league — the "Other" chip's set.
      return LEAGUE_LEVEL_COLORS.other;
  }
}
