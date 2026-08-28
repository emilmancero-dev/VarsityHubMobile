/**
 * Geofencing utilities for location-based event posting
 *
 * BUSINESS RULES (owner rules 2026-07-14 + Fanatics Fest punch list 2026-07-15):
 * - The geofence is strict for a user's FIRST upload to an event page: they
 *   must be within 3km of the venue with device-origin coordinates. That first
 *   pass writes an EventPostingUnlock row; for the next 7 days they may keep
 *   uploading (stories AND posts) to that same event page without re-passing
 *   the geofence.
 * - Story Posts: window opens on game day (UTC) and stays open until +48h.
 * - Regular Posts: the geofenced live window opens 12 hours before event start
 *   (owner rule 2026-08-28 — posting is open on game day so fans already at the
 *   venue can post the moment they arrive, not just an hour before kickoff) and
 *   closes `live_window_hours_after_start` hours after start (default 3;
 *   the Fanatics Fest day events set 18 so fans can post geofenced all day).
 *   After the live window, a 7-day grace window remains open only for
 *   unlocked users (posting recaps from anywhere); then it closes for everyone.
 * - Sample events/games (IDs starting with "sample-") bypass all geofencing checks
 *
 * This maintains authenticity and prevents users from different states from trolling games.
 */

import { prisma } from './prisma.js';

const EARTH_RADIUS_KM = 6371;
const EARTH_RADIUS_MILES = 3959;
// Owner rule (2026-08-28): live post window is -12h → +3h around event start by
// default. It opens on game day (12h before start) so fans already at the venue
// can post as soon as they arrive — the earlier "-1h" locked out everyone who
// showed up before the final hour. The 3km geofence is unchanged and remains
// the real authenticity gate; only the TIME the window opens moved. Events may
// still lengthen the after-start bound via the live_window_hours_after_start
// column (Fanatics Fest day events: 18h) so all-day festivals keep geofenced
// first posts working the whole day.
export const REGULAR_POST_OPEN_BEFORE_HOURS = 12;
const REGULAR_POST_OPEN_BEFORE_MS = REGULAR_POST_OPEN_BEFORE_HOURS * 60 * 60 * 1000;
export const DEFAULT_LIVE_WINDOW_HOURS_AFTER_START = 3;
// Product rule (2026-07-14, owner decision, verbatim): "When a user posts to
// an event while they are there, they can continue to post to the event for
// up to a week. After that week they no longer can." Applied per user via
// EventPostingUnlock (unlocked_at + 7d) and as the outer cap on the window.
export const REGULAR_POST_GRACE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const EVENT_POSTING_UNLOCK_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

export type PostingPermissionErrorCode =
  | 'EVENT_NOT_FOUND'
  | 'NO_EVENT_LOCATION'
  | 'POSTING_WINDOW_CLOSED'
  | 'TOO_FAR_FROM_VENUE'
  | 'LOCATION_REQUIRED'
  | 'LOCATION_SPOOF_SUSPECTED'
  | 'EXCLUSIVE_POSTER_ONLY';

/**
 * Rejection shown to a user who opens a finished event page having never posted
 * from the venue while it was live. Owner wording, 2026-07-16: "sorry. You
 * didn't post while there so do not have access to post afterwards."
 *
 * Shared by the `closed` and unlock-less `grace` branches — one string, because
 * they are the same rejection to the user and drifted apart once already.
 */
export const EVENT_ENDED_NOT_PRESENT_REASON =
  "Sorry — you didn't post to this event while you were there, so you don't have access to post to it afterwards.";

export type PostingPermissionResult = {
  allowed: boolean;
  code?: PostingPermissionErrorCode;
  reason?: string;
  distance?: number;
};

export type PostPostingWindowState = 'before_open' | 'live' | 'grace' | 'closed';

const postingEventSelect = {
  id: true,
  title: true,
  date: true,
  latitude: true,
  longitude: true,
  location: true,
  game_id: true,
  exclusive_poster_id: true,
  live_window_hours_after_start: true,
} as const;

type PostingEvent = Awaited<ReturnType<typeof loadPostingEvent>>;

const formatWindowDateTime = (date: Date) =>
  date.toLocaleString('en-US', {
    month: 'numeric',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

/**
 * Calculate distance between two coordinates using Haversine formula
 * @param lat1 Latitude of first point
 * @param lon1 Longitude of first point
 * @param lat2 Latitude of second point
 * @param lon2 Longitude of second point
 * @param unit 'km' or 'miles'
 * @returns Distance in specified unit
 */
export function calculateDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
  unit: 'km' | 'miles' = 'miles'
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  const radius = unit === 'km' ? EARTH_RADIUS_KM : EARTH_RADIUS_MILES;
  return radius * c;
}

/**
 * Check if a user is within the geofence of an event location
 * @param radiusKm Radius in kilometers (default: 0.5 miles for legacy compatibility)
 */
export function isWithinGeofence(
  userLat: number,
  userLon: number,
  eventLat: number,
  eventLon: number,
  radiusKm: number = 0.8 // Default: 0.8km (roughly 0.5 miles) for backwards compatibility
): boolean {
  const distance = calculateDistance(userLat, userLon, eventLat, eventLon, 'km');
  return distance <= radiusKm;
}

/**
 * Check if the posting window is open for stories.
 *
 * Stories are LIVE-ONLY (owner rule, 2026-07-16 — Fanatics Fest):
 *   "STORY POST HAVE TO BE STRICTLY FOR WHEN THEY ARE AT THE GEO FENCED
 *    LOCATION", "USERS CANT UPLOAD TO STORIES AFTER THEY HAVE LEFT THE GAME",
 *   "STORY POST, do not get the same 7 days after the fact".
 *
 * So a story uses exactly the same live window as a regular post — opening on
 * game day (12h before start) and closing `liveWindowHoursAfterStart` after
 * (per-event override; the fest day events run 18h) — and never the 'grace'
 * state that keeps regular posting open for a week.
 *
 * This previously opened at UTC midnight on the event's day and ran for 48h
 * after start, which both let people post before the event and kept stories
 * open for two days after they had gone home.
 */
export function isStoryPostingWindowOpen(
  eventDate: Date,
  liveWindowHoursAfterStart?: number | null,
  now: Date = new Date()
): boolean {
  return getPostPostingWindowState(eventDate, now, liveWindowHoursAfterStart) === 'live';
}

/**
 * Check if posting window is open for regular posts
 * Posts: the live window opens 12 hours before event start (game day) and closes
 * `liveWindowHoursAfterStart` hours after (default 3; per-event override).
 * After that, posting remains open for a 7-day grace window only for users
 * holding a posting unlock.
 */
export function isPostPostingWindowOpen(
  eventDate: Date,
  liveWindowHoursAfterStart?: number | null
): boolean {
  const now = new Date();
  const state = getPostPostingWindowState(eventDate, now, liveWindowHoursAfterStart);
  return state !== 'before_open' && state !== 'closed';
}

export function getPostPostingWindowBounds(
  eventDate: Date,
  liveWindowHoursAfterStart?: number | null
) {
  const eventTime = new Date(eventDate);
  const windowStart = new Date(eventTime.getTime() - REGULAR_POST_OPEN_BEFORE_MS);
  const afterStartHours =
    typeof liveWindowHoursAfterStart === 'number' && liveWindowHoursAfterStart > 0
      ? liveWindowHoursAfterStart
      : DEFAULT_LIVE_WINDOW_HOURS_AFTER_START;
  const liveCutoff = new Date(eventTime.getTime() + afterStartHours * 60 * 60 * 1000);

  return {
    eventTime,
    windowStart,
    liveCutoff,
  };
}

export function getPostPostingWindowState(
  eventDate: Date,
  now: Date = new Date(),
  liveWindowHoursAfterStart?: number | null
): PostPostingWindowState {
  const { windowStart, liveCutoff } = getPostPostingWindowBounds(
    eventDate,
    liveWindowHoursAfterStart
  );
  if (now < windowStart) return 'before_open';
  // 'live' = geofenced posting allowed: anyone at the venue can post (and earn
  // their 7-day unlock); unlocked users can post from anywhere.
  if (now <= liveCutoff) return 'live';
  // Post-event uploads stay open for a 7-day grace window, gated by the
  // per-user posting unlock. After that the window is closed for everyone,
  // regardless of posting history.
  if (now <= new Date(liveCutoff.getTime() + REGULAR_POST_GRACE_WINDOW_MS)) return 'grace';
  return 'closed';
}

/**
 * Serialize a game/event's live posting window for the client.
 *
 * The client used to re-derive this from the game's own date with a hardcoded
 * 3h cutoff (create-post.tsx) or a hardcoded 2h one (feed.tsx), so an event
 * carrying a `live_window_hours_after_start` override — the Fanatics Fest day
 * events run 18h — read as "ended" in the app while the server was still
 * happily accepting posts. The window is a server rule; ship the computed
 * bounds instead of the inputs so there is exactly one implementation.
 *
 * `eventDate` must be the EVENT's date when a linked event exists: that is what
 * the posting checks in this file enforce against, and a game row's own date
 * can disagree with it.
 */
export type SerializedLiveWindow = {
  /** Authoritative event start — a linked game row's own `date` can disagree. */
  starts_at: string | null;
  /** Geofenced posting opens (start − 12h, i.e. game day). */
  live_from: string | null;
  /** Geofenced posting closes (start + the per-event window, default 3h). */
  live_until: string | null;
};

const EMPTY_LIVE_WINDOW: SerializedLiveWindow = {
  starts_at: null,
  live_from: null,
  live_until: null,
};

export function serializeLiveWindow(
  eventDate: Date | string | null | undefined,
  liveWindowHoursAfterStart?: number | null
): SerializedLiveWindow {
  if (!eventDate) return EMPTY_LIVE_WINDOW;
  const parsed = eventDate instanceof Date ? eventDate : new Date(eventDate);
  if (Number.isNaN(parsed.getTime())) return EMPTY_LIVE_WINDOW;
  const { eventTime, windowStart, liveCutoff } = getPostPostingWindowBounds(
    parsed,
    liveWindowHoursAfterStart
  );
  return {
    starts_at: eventTime.toISOString(),
    live_from: windowStart.toISOString(),
    live_until: liveCutoff.toISOString(),
  };
}

/**
 * View-access counterpart to the posting grace window. A user who posted to a
 * game/event while it was live keeps read access to that game/event's detail
 * page for the same grace window that lets them keep posting (product rule,
 * 2026-07-14: "up to a week" after they posted while there). This is
 * READ-only — it never grants approval/moderation power, only visibility.
 *
 * Purely additive: callers should only consult this as a fallback after their
 * existing visibility checks (creator/admin/staff) have failed.
 */
/**
 * Read-access helper: has this viewer posted to this game/event? Viewing is
 * PERMANENT and never expires (owner rule, 2026-07-14: "any user can view any
 * past game at any time; it'll lock posting but viewing is always on"). This
 * is the additive contributor fallback for the niche case of a not-yet-public
 * entity (e.g. a future game still awaiting opponent consent) — a contributor
 * who posted there can always see it. Read-only; grants no approval power.
 * The 7-day cap applies ONLY to POSTING (getPostPostingWindowState), never to
 * viewing.
 */
export async function viewerHasPostedOnEntity({
  userId,
  gameId,
  eventId,
}: {
  userId?: string | null;
  gameId?: string | null;
  eventId?: string | null;
}): Promise<boolean> {
  if (!userId) return false;
  if (!gameId && !eventId) return false;

  const orClauses: Array<{ game_id: string } | { event_id: string }> = [];
  if (gameId) orClauses.push({ game_id: gameId });
  if (eventId) orClauses.push({ event_id: eventId });

  const priorPost = await prisma.post.findFirst({
    where: {
      author_id: userId,
      deleted_at: null,
      OR: orClauses,
    },
    select: { id: true },
  });

  return !!priorPost;
}

/**
 * First-post-unlocks-7-days ledger (owner rule, 2026-07-15 Fanatics Fest punch
 * list): a user's first geofence-passing upload to an event page grants them 7
 * days of geofence-free uploads (stories AND posts) to that same page.
 *
 * The anchor lives in EventPostingUnlock, written when the strict geofence
 * passes. For contributions made before the ledger existed we fall back to the
 * user's earliest surviving Post/Story row on that page and persist it as the
 * anchor — persisting matters because Story rows are deleted 24h after they
 * expire, and a lazily-recreated anchor from a NEWER row would silently slide
 * the 7-day window forward.
 */
export async function grantEventPostingUnlock(
  userId: string,
  eventId: string,
  unlockedAt?: Date
): Promise<void> {
  try {
    // createMany + skipDuplicates: first write wins, so the original anchor is
    // never refreshed by later uploads (the window must not slide).
    await prisma.eventPostingUnlock.createMany({
      data: [
        { user_id: userId, event_id: eventId, ...(unlockedAt ? { unlocked_at: unlockedAt } : {}) },
      ],
      skipDuplicates: true,
    });
  } catch (error) {
    // Never block a geofence-passed upload on ledger bookkeeping.
    console.warn('[geofencing] Failed to persist posting unlock:', error);
  }
}

async function getEventPostingUnlockAnchor(
  userId: string,
  event: { id: string; game_id: string | null }
): Promise<Date | null> {
  const row = await prisma.eventPostingUnlock.findUnique({
    where: { user_id_event_id: { user_id: userId, event_id: event.id } },
    select: { unlocked_at: true },
  });
  if (row) return row.unlocked_at;

  // Legacy fallback: uploads made before the unlock ledger shipped. Any
  // surviving post/story on this page passed the geofence when it was created
  // (or was an admin/demo bypass, which needs no unlock anyway).
  const orClauses: Array<{ event_id: string } | { game_id: string }> = [{ event_id: event.id }];
  if (event.game_id) orClauses.push({ game_id: event.game_id });

  const earliestPost = await prisma.post.findFirst({
    where: { author_id: userId, deleted_at: null, OR: orClauses },
    orderBy: { created_at: 'asc' },
    select: { created_at: true },
  });
  const earliestStory = event.game_id
    ? await prisma.story.findFirst({
        where: { user_id: userId, game_id: event.game_id },
        orderBy: { created_at: 'asc' },
        select: { created_at: true },
      })
    : null;

  const candidates = [earliestPost?.created_at, earliestStory?.created_at].filter(
    (d): d is Date => d instanceof Date
  );
  if (!candidates.length) return null;

  const anchor = new Date(Math.min(...candidates.map(d => d.getTime())));
  await grantEventPostingUnlock(userId, event.id, anchor);
  return anchor;
}

export async function hasActiveEventPostingUnlock(
  userId: string,
  event: { id: string; game_id: string | null },
  now: Date = new Date()
): Promise<boolean> {
  const anchor = await getEventPostingUnlockAnchor(userId, event);
  if (!anchor) return false;
  return now.getTime() - anchor.getTime() <= EVENT_POSTING_UNLOCK_DURATION_MS;
}

/**
 * Check if posting window is open for an event (legacy - kept for backwards compatibility)
 * @deprecated Use isStoryPostingWindowOpen or isPostPostingWindowOpen instead
 */
export function isPostingWindowOpen(eventDate: Date): boolean {
  const now = new Date();
  const eventTime = new Date(eventDate);
  const windowOpenTime = new Date(eventTime.getTime() - 24 * 60 * 60 * 1000);
  return now >= windowOpenTime;
}

async function loadPostingEvent(eventId: string) {
  return prisma.event.findUnique({
    where: { id: eventId },
    select: postingEventSelect,
  });
}

/**
 * Additive designated-poster allowlist (owner rule, 2026-07-19 Fanatics Fest):
 * a user granted here may post AND upload stories to the event page at any
 * time, from anywhere — bypassing the live window and the venue geofence —
 * WITHOUT blocking any other user (normal attendees keep the standard rules).
 * This is the post-event "give a specific person continued access for
 * marketing/continuity" grant. Contrast `exclusive_poster_id`, which is
 * single-user and blocks everyone else. Grant/revoke via
 * `server/scripts/set-event-designated-poster.ts`.
 */
export async function isDesignatedEventPoster(
  userId: string,
  eventId: string
): Promise<boolean> {
  const row = await prisma.eventDesignatedPoster.findUnique({
    where: { event_id_user_id: { event_id: eventId, user_id: userId } },
    select: { user_id: true },
  });
  return !!row;
}

async function resolveVenueCoordinates(event: PostingEvent) {
  let venueLat = typeof event?.latitude === 'number' ? event.latitude : null;
  let venueLon = typeof event?.longitude === 'number' ? event.longitude : null;
  if (venueLat == null || venueLon == null) {
    const game = event?.game_id
      ? await prisma.game.findUnique({
          where: { id: event.game_id },
          select: { latitude: true, longitude: true, venue_lat: true, venue_lng: true },
        })
      : null;
    venueLat = venueLat ?? game?.latitude ?? game?.venue_lat ?? null;
    venueLon = venueLon ?? game?.longitude ?? game?.venue_lng ?? null;
  }
  return { venueLat, venueLon };
}

/**
 * Verify user can post a story to an event based on location and time
 * Stories: event day through +48h, 3km radius
 * @returns { allowed: boolean; reason?: string; distance?: number }
 */
// v1.0.2 pass 9: server-side anti-spoof for client-supplied geofence coords. We can't fully
// trust GPS from the client (rooted device, mock locations, modified app binary), so we add
// a coarse IP-geo cross-check. If client coords differ from IP region by >250 miles, reject.
// Won't stop a determined attacker with VPN at the venue's region, but raises the bar for
// trivial spoofing.
async function verifyClientCoordsVsIp(
  userLat: number,
  userLon: number,
  ipAddress: string | null
): Promise<{ ok: boolean; reason?: string }> {
  // v1.0.2 pass 10: ops escape hatch. If ipapi.co rate-limits or has an outage, set
  // DISABLE_GEOFENCE_IP_CHECK=1 in Railway env to skip the cross-check and let stories through.
  if (
    process.env.DISABLE_GEOFENCE_IP_CHECK === '1' ||
    process.env.DISABLE_GEOFENCE_IP_CHECK === 'true'
  ) {
    return { ok: true };
  }
  if (
    !ipAddress ||
    ipAddress === '::1' ||
    ipAddress === '127.0.0.1' ||
    ipAddress.startsWith('10.') ||
    ipAddress.startsWith('192.168.')
  ) {
    // Local/private IP — skip check (dev / VPN through corporate net are common false positives)
    return { ok: true };
  }
  try {
    // ipapi.co is free for ~1k req/day; fall through silently if it fails so we don't break the feature
    const resp = await fetch(`https://ipapi.co/${ipAddress}/json/`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!resp.ok) return { ok: true };
    const data: any = await resp.json();
    if (typeof data?.latitude !== 'number' || typeof data?.longitude !== 'number')
      return { ok: true };
    const distMi = calculateDistance(userLat, userLon, data.latitude, data.longitude, 'miles');
    if (distMi > 250) {
      return {
        ok: false,
        reason: `Reported location is ${Math.round(distMi)}mi from your network location. If you're using a VPN, please disable it.`,
      };
    }
    return { ok: true };
  } catch {
    // Network failure or rate limit — don't block legitimate users; let geofence proceed
    return { ok: true };
  }
}

export async function verifyStoryPostingPermission(
  eventId: string,
  userId: string,
  userLat: number | null,
  userLon: number | null,
  ipAddress?: string | null
): Promise<PostingPermissionResult> {
  const event = await loadPostingEvent(eventId);

  if (!event) {
    return { allowed: false, code: 'EVENT_NOT_FOUND', reason: 'Event not found' };
  }

  // Additive designated-poster grant also covers stories — this closes the gap
  // where the allowlist/exclusive mechanism only ever affected regular posts.
  // Allowlisted users upload stories from anywhere at any time; everyone else
  // must still re-pass the geofence on every story (owner rule, 2026-07-16).
  if (await isDesignatedEventPoster(userId, event.id)) {
    return { allowed: true };
  }

  // Stories are live-only: the same window regular posts get, never the 7-day
  // grace (owner rule, 2026-07-16 — see isStoryPostingWindowOpen).
  if (!isStoryPostingWindowOpen(event.date, event.live_window_hours_after_start)) {
    const { windowStart, liveCutoff } = getPostPostingWindowBounds(
      event.date,
      event.live_window_hours_after_start
    );
    const isBeforeOpen = new Date() < windowStart;
    return {
      allowed: false,
      code: 'POSTING_WINDOW_CLOSED',
      reason: isBeforeOpen
        ? `Stories open at ${formatWindowDateTime(windowStart)}, on game day before the event starts.`
        : `Stories could be posted from the venue until ${formatWindowDateTime(liveCutoff)}. That window has closed.`,
    };
  }

  const { venueLat, venueLon } = await resolveVenueCoordinates(event);

  // Strict first-post path: device coords within 3km of the venue, plus the
  // IP anti-spoof cross-check. Passing it earns the 7-day posting unlock. A
  // failure is held (not returned) so the unlock fallback below can still
  // admit users who already proved presence.
  let strictFailure: PostingPermissionResult;
  if (venueLat == null || venueLon == null) {
    console.warn(`Event ${eventId} and game missing coordinates - blocking story upload`);
    strictFailure = {
      allowed: false,
      code: 'NO_EVENT_LOCATION',
      reason:
        'This event has no venue coordinates, so story uploads are disabled until the location is configured.',
    };
  } else if (userLat === null || userLon === null) {
    strictFailure = {
      allowed: false,
      code: 'LOCATION_REQUIRED',
      reason: 'Stories require current device location within 3 km of the venue.',
    };
  } else {
    const distance = calculateDistance(userLat, userLon, venueLat, venueLon, 'km');
    const isWithin = isWithinGeofence(userLat, userLon, venueLat, venueLon, 3.0); // 3km for stories

    if (!isWithin) {
      strictFailure = {
        allowed: false,
        code: 'TOO_FAR_FROM_VENUE',
        reason: 'You must be within 3 km of the venue to post a story.',
        distance,
      };
    } else {
      // v1.0.2 pass 9: anti-spoof — IP cross-check. If client says "I'm at venue X" but their
      // network IP is in a different region, reject. Best-effort; never blocks on API failure.
      const ipCheck = ipAddress
        ? await verifyClientCoordsVsIp(userLat, userLon, ipAddress)
        : { ok: true as const };
      if (!ipCheck.ok) {
        strictFailure = {
          allowed: false,
          code: 'LOCATION_SPOOF_SUSPECTED',
          reason: ipCheck.reason || 'Reported location does not match your network location.',
        };
      } else {
        await grantEventPostingUnlock(userId, event.id);
        return { allowed: true, distance };
      }
    }
  }

  // NO unlock fallback for stories. A story must re-pass the geofence every
  // time — "USERS CANT UPLOAD TO STORIES AFTER THEY HAVE LEFT THE GAME"
  // (owner rule, 2026-07-16). The 7-day unlock still exists and still admits
  // regular POSTS from anywhere; it just never admits a story. Passing the
  // geofence above still GRANTS that unlock, because posting a story from the
  // venue proves presence just as well as a regular post does.
  return strictFailure;
}

/**
 * Verify user can post to an event based on location and time
 * Posts: the geofenced live window runs -12h → +Nh around event start (N =
 * live_window_hours_after_start, default 3; fest all-day events use 18). A
 * first geofence pass earns a 7-day unlock; unlocked users post without
 * location from anywhere, including through the post-event grace window.
 * After the grace window: closed.
 * @returns { allowed: boolean; reason?: string; distance?: number }
 */
export async function verifyEventPostingPermission(
  eventId: string,
  userId: string,
  userLat: number | null,
  userLon: number | null
): Promise<PostingPermissionResult> {
  const event = await loadPostingEvent(eventId);

  if (!event) {
    return { allowed: false, code: 'EVENT_NOT_FOUND', reason: 'Event not found' };
  }

  // Additive designated-poster grant (see isDesignatedEventPoster): allowlisted
  // users post from anywhere at any time. Checked before the exclusive lock so
  // a grant always admits, and before the window/geofence so it survives event
  // close — all without affecting any other user.
  if (await isDesignatedEventPoster(userId, event.id)) {
    return { allowed: true };
  }

  // Exclusive-poster lock (owner one-off feature, 2026-07-14): when an event
  // designates a single poster, ONLY that user may post — bypassing the window
  // and geofence for them, and blocking everyone else outright (even attendees
  // who were there). Null = normal multi-fan posting (falls through below).
  if (event.exclusive_poster_id) {
    if (event.exclusive_poster_id === userId) {
      return { allowed: true };
    }
    return {
      allowed: false,
      code: 'EXCLUSIVE_POSTER_ONLY',
      reason: 'Only the designated poster can post to this event.',
    };
  }

  const { windowStart } = getPostPostingWindowBounds(
    event.date,
    event.live_window_hours_after_start
  );
  const postingWindowState = getPostPostingWindowState(
    event.date,
    new Date(),
    event.live_window_hours_after_start
  );

  if (postingWindowState === 'before_open') {
    return {
      allowed: false,
      code: 'POSTING_WINDOW_CLOSED',
      reason: `Posting opens ${formatWindowDateTime(windowStart)}.`,
    };
  }

  // The event is over and this user never posted from the venue while it was
  // live, so they never earned an unlock. Owner wording (2026-07-16): they get
  // told plainly that presence at the event was the price of admission — not a
  // "come back later", because there is no later.
  //
  // `closed` used to share the `before_open` branch, which told someone opening
  // a week-old event page "Posting opens <a date in the past>". Same rejection,
  // opposite meaning.
  if (postingWindowState === 'closed') {
    return {
      allowed: false,
      code: 'POSTING_WINDOW_CLOSED',
      reason: EVENT_ENDED_NOT_PRESENT_REASON,
    };
  }

  if (postingWindowState === 'grace') {
    // Post-event grace window: only users holding an active posting unlock —
    // they passed the geofence on this page (post OR story) within the last 7
    // days — may keep uploading, from anywhere.
    if (await hasActiveEventPostingUnlock(userId, event)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      code: 'POSTING_WINDOW_CLOSED',
      reason: EVENT_ENDED_NOT_PRESENT_REASON,
    };
  }

  // Live window: strict geofence for a first post; a pass earns the 7-day
  // unlock. Failures are held so the unlock fallback can still admit users
  // who already proved presence (e.g. flaky GPS indoors, or posting later
  // in the day from across town).
  const { venueLat, venueLon } = await resolveVenueCoordinates(event);
  let strictFailure: PostingPermissionResult;
  if (venueLat == null || venueLon == null) {
    console.warn(`Event ${eventId} and game missing coordinates - blocking post upload`);
    strictFailure = {
      allowed: false,
      code: 'NO_EVENT_LOCATION',
      reason:
        'This event has no venue coordinates, so posting is disabled until the location is configured.',
    };
  } else if (userLat === null || userLon === null) {
    strictFailure = {
      allowed: false,
      code: 'LOCATION_REQUIRED',
      reason: 'Live event posts require current device location within 3 km of the venue.',
    };
  } else {
    const distance = calculateDistance(userLat, userLon, venueLat, venueLon, 'km');
    const isWithin = isWithinGeofence(userLat, userLon, venueLat, venueLon, 3.0); // 3km for posts

    if (!isWithin) {
      strictFailure = {
        allowed: false,
        code: 'TOO_FAR_FROM_VENUE',
        reason: 'You must be within 3 km of the venue to post.',
        distance,
      };
    } else {
      await grantEventPostingUnlock(userId, event.id);
      return { allowed: true, distance };
    }
  }

  if (await hasActiveEventPostingUnlock(userId, event)) {
    return { allowed: true };
  }

  return strictFailure;
}
