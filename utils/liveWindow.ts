/**
 * The live posting window is a SERVER rule (server/src/lib/geofencing.ts): it
 * opens 12h before the event starts (game day) and closes `live_window_hours_after_start`
 * hours after (default 3, per-event override — the Fanatics Fest day events run
 * 18h so fans can post all day).
 *
 * The app used to re-derive this from a game's own `date` with a hardcoded
 * cutoff — 2h in feed.tsx, 3h in create-post.tsx — and had no way to learn
 * about an override. At Fanatics Fest 2026 Day 1 that meant the event stopped
 * being LIVE in the app at 4:00 PM ET and dropped out of the feed entirely,
 * while the server happily accepted posts until 7:00 AM. It also read the
 * game's date, which can disagree with its event's.
 *
 * `GET /games` now ships the computed `starts_at`/`live_from`/`live_until`
 * bounds. Use them. Only fall back to a local guess for a payload old enough to
 * lack them.
 */

/** Matches REGULAR_POST_OPEN_BEFORE_MS in server/src/lib/geofencing.ts (12h / game day). */
const OPEN_BEFORE_MS = 12 * 60 * 60 * 1000;
/**
 * Only for payloads predating the server-computed bounds. Mirrors the server's
 * DEFAULT_LIVE_WINDOW_HOURS_AFTER_START (3h) rather than the old 2h feed
 * constant, which matched nothing on the server.
 */
const FALLBACK_WINDOW_AFTER_MS = 3 * 60 * 60 * 1000;

export interface LiveWindowFields {
  date?: string | Date | null;
  starts_at?: string | null;
  live_from?: string | null;
  live_until?: string | null;
}

interface Bounds {
  startsAt: number;
  liveFrom: number;
  liveUntil: number;
}

const parse = (v: string | Date | null | undefined): number => {
  if (!v) return NaN;
  return v instanceof Date ? v.getTime() : Date.parse(v);
};

export function getLiveBounds(game: LiveWindowFields | null | undefined): Bounds | null {
  if (!game) return null;

  const startsAt = parse(game.starts_at);
  const liveFrom = parse(game.live_from);
  const liveUntil = parse(game.live_until);
  if (!Number.isNaN(startsAt) && !Number.isNaN(liveFrom) && !Number.isNaN(liveUntil)) {
    return { startsAt, liveFrom, liveUntil };
  }

  const date = parse(game.date);
  if (Number.isNaN(date)) return null;
  return {
    startsAt: date,
    liveFrom: date - OPEN_BEFORE_MS,
    liveUntil: date + FALLBACK_WINDOW_AFTER_MS,
  };
}

/** Started and not yet past its live cutoff — drives the LIVE badge. */
export function isGameLive(game: LiveWindowFields | null | undefined, now = Date.now()): boolean {
  const b = getLiveBounds(game);
  if (!b) return false;
  return now >= b.startsAt && now <= b.liveUntil;
}

/**
 * Geofenced posting is open (opens 12h before start / game day, unlike the LIVE
 * badge which only lights once the event has started). A user at the venue can
 * post during this window.
 */
export function isPostingWindowOpen(
  game: LiveWindowFields | null | undefined,
  now = Date.now()
): boolean {
  const b = getLiveBounds(game);
  if (!b) return false;
  return now >= b.liveFrom && now <= b.liveUntil;
}

/** Past its live cutoff — the event is over for posting purposes. */
export function isGameOver(game: LiveWindowFields | null | undefined, now = Date.now()): boolean {
  const b = getLiveBounds(game);
  if (!b) return false;
  return now > b.liveUntil;
}

/**
 * Great-circle distance in km. Mirrors calculateDistance() in
 * server/src/lib/geofencing.ts.
 */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * The radius within which a first geofenced post is accepted. Mirrors the
 * client-side warning threshold in create-post.tsx.
 */
export const AT_VENUE_RADIUS_KM = 3;

export interface VenueFields {
  latitude?: number | null;
  longitude?: number | null;
  venue_lat?: number | null;
  venue_lng?: number | null;
}

/** Is the viewer physically at this game's venue? Unknown coords → false. */
export function isAtVenue(
  game: VenueFields | null | undefined,
  viewer: { latitude?: number | null; longitude?: number | null } | null | undefined,
  radiusKm = AT_VENUE_RADIUS_KM
): boolean {
  if (!game || !viewer) return false;
  const venueLat = game.latitude ?? game.venue_lat;
  const venueLng = game.longitude ?? game.venue_lng;
  if (
    typeof venueLat !== 'number' ||
    typeof venueLng !== 'number' ||
    typeof viewer.latitude !== 'number' ||
    typeof viewer.longitude !== 'number'
  ) {
    return false;
  }
  return distanceKm(viewer.latitude, viewer.longitude, venueLat, venueLng) <= radiusKm;
}

/**
 * The owner rule (2026-07-16): "If an event is live and the user is at the
 * location it should basically be pinned on the feed page."
 */
export function shouldPinToFeed(
  game: (LiveWindowFields & VenueFields) | null | undefined,
  viewer: { latitude?: number | null; longitude?: number | null } | null | undefined,
  now = Date.now()
): boolean {
  return isGameLive(game, now) && isAtVenue(game, viewer);
}
