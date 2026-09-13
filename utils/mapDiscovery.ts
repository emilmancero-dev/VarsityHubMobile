/**
 * Feed-map data model.
 *
 * The feed map (`app/game-map.tsx`) shows ALL public VarsityHub event pages
 * nationwide — not a location-scoped or pro-only slice. It reads from the
 * single `/event-discovery?surface=map` endpoint, which already returns every
 * approved, non-private game AND standalone event page in the server's map
 * window (privacy-filtered, no `lat`/`lng` gate). These helpers own the query
 * shape and the discovery-item → map-marker mapping so the "no data gates"
 * contract is pinned in one place and can't drift back into the screen.
 *
 * NOTE: this is deliberately distinct from the Discover calendar, which is a
 * separate followed/managed system. Do not fetch followed-only data here.
 */
import type { EventMapData } from '@/components/EventMap.types';
import type { EventCard } from '@/api/schemas/eventCard';
import { normalizeSportSlug } from '@/constants/sports';
import { shouldShowEventOnMap } from '@/utils/mapEventFilters';

const DEFAULT_MAP_LIMIT = 200;

/** The compact day strip shown by the feed-map calendar button. */
export interface MapDateButton {
  dateString: string;
  day: string;
  label: string;
  count: number;
}

/**
 * Build the feed-map discovery request path. Intentionally carries NO location
 * (`lat`/`lng`/`radius`), pro-only, or following gate — the feed map is every
 * public event page nationwide.
 */
export function buildMapDiscoveryPath(
  limit: number = DEFAULT_MAP_LIMIT,
  filters: { level?: string | null; from?: string; to?: string } = {}
): string {
  const query = new URLSearchParams();
  query.set('surface', 'map');
  query.set('limit', String(limit));
  if (filters.level) query.set('level', filters.level);
  if (filters.from) query.set('from', filters.from);
  if (filters.to) query.set('to', filters.to);
  return '/event-discovery?' + query.toString();
}

function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Map discovery items to the map-marker shape. `source_type` becomes the marker
 * `type` (so routing via the screen's `handleEventPress` stays correct: 'event'
 * → event detail, 'game' → game detail), and `id` is the routing id the server
 * already resolved (game id for games, event id for standalone events). Items
 * without coordinates are dropped for map pins. Default map loads are still
 * future-windowed client-side as a defensive guard; selected-date loads pass
 * `includePast` because the server already scoped that explicit day.
 */
export function toMapEvents(
  items: EventCard[] | null | undefined,
  now: Date = new Date(),
  {
    requireCoords = true,
    includePast = false,
  }: { requireCoords?: boolean; includePast?: boolean } = {}
): EventMapData[] {
  if (!Array.isArray(items)) return [];
  const out: EventMapData[] = [];
  for (const item of items) {
    const lat = item.latitude;
    const lng = item.longitude;
    const hasCoords = lat != null && lng != null;
    // Map pins need coordinates; the calendar dataset (requireCoords: false)
    // keeps every upcoming event page even without a location.
    if (requireCoords && !hasCoords) continue;
    if (!includePast && !shouldShowEventOnMap(item.date ?? undefined, now)) continue;
    out.push({
      id: String(item.id),
      event_id: item.event_id ?? (item.source_type === 'event' ? String(item.id) : null),
      game_id: item.game_id ?? (item.source_type === 'game' ? String(item.id) : null),
      has_posts: item.has_posts === true,
      title: item.title || (item.source_type === 'game' ? 'Game' : 'Event'),
      date: item.date || now.toISOString(),
      location: item.location ?? undefined,
      latitude: hasCoords ? lat : undefined,
      longitude: hasCoords ? lng : undefined,
      type: item.source_type === 'game' ? 'game' : 'event',
      sport: normalizeSportSlug(item.sport),
      league_slug: item.league_slug ?? null,
      league_name: item.league_name ?? null,
      league_level: item.league_level ?? null,
      league_gender: item.league_gender ?? null,
      pro_home_color: item.pro_home_color ?? null,
      pro_away_color: item.pro_away_color ?? null,
      upload_access: item.upload_access ?? null,
    });
  }
  return out;
}

/** Build the feed-map calendar strip as the last N days, ending today. */
export function buildRecentDateButtons(
  events: Array<{ date?: string | null }>,
  now: Date = new Date(),
  days: number = 7
): MapDateButton[] {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() - (days - 1 - index));
    const dateString = toDateKey(date);
    const count = events.filter(event => {
      if (!event.date) return false;
      const d = new Date(event.date);
      return !isNaN(d.getTime()) && toDateKey(d) === dateString;
    }).length;
    return {
      dateString,
      day: date.toLocaleDateString('en-US', { weekday: 'short' }),
      label: date.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' }),
      count,
    };
  });
}
