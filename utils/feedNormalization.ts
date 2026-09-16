import { normalizeSportSlug } from '@/constants/sports';
import type { FeedBundleSection } from '@/api/types';

export type GameItem = {
  id: string;
  title?: string;
  date?: string;
  location?: string;
  cover_image_url?: string;
  banner_url?: string | null;
  event_id?: string | null;
  source_type?: 'game' | 'event';
  venue_photo?: { url: string; credit: string } | null;
  pro_home_color?: string | null;
  pro_away_color?: string | null;
  pro_league?: string | null;
  sport?: string | null;
  starts_at?: string | null;
  live_from?: string | null;
  live_until?: string | null;
  home_score?: number | null;
  away_score?: number | null;
  winner?: string | null;
};

export type FeedBundleParams = {
  sections?: FeedBundleSection[];
  country?: string;
  date?: string;
  zip?: string;
  lat?: number;
  lng?: number;
  posts_limit?: number;
  highlights_limit?: number;
  ads_limit?: number;
  posts_cursor?: string;
  posts_followed_teams_cursor?: string;
};

export const normalizeGamesPage = (
  gamesData: any
): { games: GameItem[]; cursor: string | null } => {
  if (gamesData && typeof gamesData === 'object' && !Array.isArray(gamesData)) {
    const list = gamesData.games || gamesData.items || [];
    return {
      games: Array.isArray(list) ? list : [],
      cursor: gamesData.nextCursor || null,
    };
  }

  return {
    games: Array.isArray(gamesData) ? gamesData : [],
    cursor: null,
  };
};

export const normalizeFeedEvents = (
  eventsData: any,
  fallbackLeague?: NonNullable<GameItem['pro_league']>
): GameItem[] => {
  const list = Array.isArray(eventsData) ? eventsData : [];
  return list
    .filter((event: any) => event && typeof event.id === 'string')
    .map((event: any) => ({
      id: String(event.id),
      title: event.title,
      date: event.date,
      location: event.location,
      cover_image_url: event.game?.cover_image_url ?? null,
      banner_url: event.banner_url ?? null,
      event_id: event.id,
      source_type: 'event',
      venue_photo: event.venue_photo ?? null,
      pro_home_color: event.pro_home_color ?? null,
      pro_away_color: event.pro_away_color ?? null,
      pro_league: event.pro_league ?? fallbackLeague ?? null,
      sport: normalizeSportSlug(event.sport),
      starts_at: event.starts_at ?? null,
      live_from: event.live_from ?? null,
      live_until: event.live_until ?? null,
      home_score: null,
      away_score: null,
      winner: null,
    }));
};

export function getFeedEntityKey(item: GameItem): string {
  const eventId = typeof item.event_id === 'string' && item.event_id ? item.event_id : null;
  if (eventId) return `event:${eventId}`;
  return `entity:${String(item.id)}`;
}

export function dedupeFeedEntities(items: GameItem[]): GameItem[] {
  const byKey = new Map<string, GameItem>();
  for (const item of items) {
    const key = getFeedEntityKey(item);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, item);
      continue;
    }
    const existingScore =
      (existing.cover_image_url || existing.banner_url || existing.venue_photo?.url ? 1 : 0) +
      (existing.source_type === 'event' ? 1 : 0);
    const nextScore =
      (item.cover_image_url || item.banner_url || item.venue_photo?.url ? 1 : 0) +
      (item.source_type === 'event' ? 1 : 0);
    if (nextScore > existingScore) byKey.set(key, item);
  }
  return Array.from(byKey.values());
}

export function getFeedItemSport(item: GameItem): string | null {
  const direct = normalizeSportSlug(item.sport);
  if (direct) return direct;

  const record = item as any;
  return (
    normalizeSportSlug(record.homeTeam?.sport) ??
    normalizeSportSlug(record.awayTeam?.sport) ??
    normalizeSportSlug(record.home_team?.sport) ??
    normalizeSportSlug(record.away_team?.sport) ??
    null
  );
}

function parseMatchupSides(title?: string | null): [string, string] | null {
  const raw = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!raw) return null;
  const parts = raw.split(/\s+(?:at|vs|v)\s+/i);
  if (parts.length !== 2) return null;
  return [parts[0].trim(), parts[1].trim()];
}

function normalizeTeamTail(team: string): string {
  const tokens = team.split(' ').filter(Boolean);
  if (tokens.length === 0) return '';
  if (tokens.length >= 2 && ['red', 'white', 'blue', 'trail'].includes(tokens[tokens.length - 2])) {
    return `${tokens[tokens.length - 2]} ${tokens[tokens.length - 1]}`;
  }
  return tokens[tokens.length - 1];
}

function buildMatchupSignature(item: GameItem): string | null {
  const sides = parseMatchupSides(item.title);
  if (!sides) return null;
  const dateMs = Date.parse(item.date || '');
  if (!Number.isFinite(dateMs)) return null;
  const roundedThirtyMinutes = Math.floor(dateMs / (30 * 60 * 1000));
  const venue = String(item.location || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (!venue) return null;
  return `${roundedThirtyMinutes}|${venue}|${normalizeTeamTail(sides[0])}|${normalizeTeamTail(sides[1])}`;
}

export function filterProEventsAlreadyRepresentedByGames(
  gameRows: GameItem[],
  proEventRows: GameItem[]
): GameItem[] {
  const gameSignatures = new Set(
    gameRows
      .map(item => buildMatchupSignature(item))
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
  );
  return proEventRows.filter(eventRow => {
    const signature = buildMatchupSignature(eventRow);
    if (!signature) return true;
    return !gameSignatures.has(signature);
  });
}
