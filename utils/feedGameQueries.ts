/**
 * Feed game query planning.
 *
 * The feed used to issue ONE ascending query starting 3 days in the past
 * (limit 30). Once the recent past holds more than a page of games (seeded
 * pro slates guarantee this), page one never reaches today — upcoming games
 * exist on the map but never in the feed. Splitting upcoming and past into
 * separate queries gives each section its own budget.
 *
 * Verified live 2026-07-13: production /games returns real upcoming games
 * (MLB/WNBA/FIFA/Fanatics Fest) via this split-query plan.
 */

/**
 * How far back the Past Events recap looks.
 *
 * 4 days, not 3, so a four-day event series stays referenceable from its own
 * final day. At 3 days, Fanatics Fest Day 1 (Jul 16) dropped out of the feed on
 * Day 4 (Jul 19) — the one day a fan is most likely to look back over the whole
 * weekend. A multi-day festival is the longest series the product supports
 * today; if that ever grows, this needs to become per-series rather than a
 * global constant.
 */
export const FEED_PAST_WINDOW_MS = 4 * 24 * 60 * 60 * 1000;

/**
 * Upcoming query look-back. Must cover the LONGEST live window any event can
 * have, so a still-live game arrives with the upcoming page rather than only in
 * the past recap.
 *
 * This was 2h, matching a since-removed 2h constant in app/feed.tsx. Events can
 * carry a `live_window_hours_after_start` override — the Fanatics Fest day
 * events run 18h — so a fest event stopped being fetched as upcoming two hours
 * in and disappeared from the feed while fans at the venue were still posting
 * to it (reported live, 2026-07-16).
 *
 * The look-back only decides what is FETCHED. app/feed.tsx then buckets on the
 * server-computed live_until (utils/liveWindow.ts), so a normal 3h game still
 * drops into the past recap on time — it is not held open for 18h.
 */
export const MAX_LIVE_WINDOW_HOURS = 18;
export const FEED_LIVE_LOOKBACK_MS = MAX_LIVE_WINDOW_HOURS * 60 * 60 * 1000;

/**
 * How far FORWARD the feed's upcoming rail looks. The map restricts to the same
 * rolling window server-side (games.ts map_view: now → +14 days), so the feed and
 * the map cover the same set of upcoming games and stay in sync ("heart & lungs").
 * If this changes, change the map_view window in server/src/routes/games.ts to match.
 */
export const FEED_UPCOMING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

type GameListOptions = {
  limit: number;
  dateFrom: string;
  dateTo?: string;
  teamless?: boolean;
  lat?: number;
  lng?: number;
  showAll?: boolean;
};

export type FeedViewerCoords = { lat: number; lng: number };

export interface FeedGameQueryPlan {
  /** Live + future games, soonest first. Pagination cursor continues this query. */
  upcoming: { sort: 'date'; options: GameListOptions };
  /** Recent-past recap, newest first so a dense slate keeps yesterday, not 3 days ago. */
  past: { sort: '-date'; options: GameListOptions };
  /** Curated teamless events (marquee) — upcoming only, immune to past-game crowding. */
  marquee: { sort: 'date'; options: GameListOptions };
}

export function buildFeedGameQueries(
  nowMs: number,
  coords?: FeedViewerCoords | null
): FeedGameQueryPlan {
  // Share query identities across mounts inside the cache's 30-second freshness
  // window. Millisecond-precise boundaries defeat React Query deduplication.
  nowMs = Math.floor(nowMs / 30_000) * 30_000;
  const liveFrom = new Date(nowMs - FEED_LIVE_LOOKBACK_MS).toISOString();
  const upcomingTo = new Date(nowMs + FEED_UPCOMING_WINDOW_MS).toISOString();
  const nowIso = new Date(nowMs).toISOString();
  // Feed is a VarsityHub-wide surface. Map/Discover handle local browsing; Feed
  // bypasses device/profile-zip proximity so every team's public games can
  // compete in the same timeline.
  const scope = coords ? { lat: coords.lat, lng: coords.lng } : { showAll: true };
  return {
    upcoming: {
      sort: 'date',
      options: { limit: 30, dateFrom: liveFrom, dateTo: upcomingTo, ...scope },
    },
    past: {
      sort: '-date',
      options: {
        limit: 30,
        dateFrom: new Date(nowMs - FEED_PAST_WINDOW_MS).toISOString(),
        dateTo: nowIso,
        ...scope,
      },
    },
    marquee: {
      sort: 'date',
      options: { limit: 10, dateFrom: liveFrom, dateTo: upcomingTo, teamless: true, ...scope },
    },
  };
}

/**
 * Merge the pages into one list: dedupe by id, ascending by date, dateless
 * last. The feed's own upcoming/past sectioning re-buckets the result.
 */
export function mergeFeedGames<T extends { id: string | number; date?: string | null }>(
  ...pages: T[][]
): T[] {
  const seen = new Set<string>();
  const merged: T[] = [];
  for (const page of pages) {
    for (const game of page) {
      const key = String(game.id);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(game);
    }
  }
  merged.sort((a, b) => {
    const at = a.date ? new Date(a.date).getTime() : NaN;
    const bt = b.date ? new Date(b.date).getTime() : NaN;
    if (!Number.isFinite(at)) return 1;
    if (!Number.isFinite(bt)) return -1;
    return at - bt;
  });
  return merged;
}
