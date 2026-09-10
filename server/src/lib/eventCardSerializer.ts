/**
 * Canonical server-side event-card serializer.
 *
 * Single source of truth for turning a `Game` (with its linked event) or a
 * standalone `Event` into the discovery "event card" shape. Extracted from
 * `eventDiscovery.ts` so other endpoints (followed/managed, feed) can emit the
 * exact same card without re-deriving the Game/Event blend. The output shape is
 * mirrored client-side by `apiclient/schemas/eventCard.ts` (`eventCardSchema`).
 */
import {
  EVENT_POSTING_UNLOCK_DURATION_MS,
  getPostPostingWindowState,
  serializeLiveWindow,
} from './geofencing.js';
import { proLeagueToSport } from './proSchedule/leagueSport.js';
import { venuePhotoFor } from './proSchedule/venuePhotos.js';

const GEOFENCE_RADIUS_KM = 3;

/** Per-request viewer context: designated-poster grants and posting unlocks. */
export type ViewerState = {
  viewerId?: string | null;
  designatedEventIds: Set<string>;
  unlocks: Map<string, Date>;
  now: Date;
};

/** Serialization context shared across a single discovery/list request. */
export type SerializeCtx = {
  now: Date;
  from: Date;
  to: Date;
  viewerState: ViewerState;
};

export function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function resolveCoords(item: any): { latitude: number | null; longitude: number | null } {
  return {
    latitude: item.latitude ?? item.venue_lat ?? item.watch_location_lat ?? null,
    longitude: item.longitude ?? item.venue_lng ?? item.watch_location_lng ?? null,
  };
}

export function feedPriority(dateValue: Date | string | null | undefined, now: Date): number {
  const parsed = dateValue ? new Date(dateValue) : null;
  if (!parsed || Number.isNaN(parsed.getTime())) return 90;
  const state = getPostPostingWindowState(parsed, now);
  if (state === 'live') return 0;
  if (parsed.getTime() > now.getTime()) return 10;
  return 20;
}

export function buildCapabilities(
  event: {
    id: string | null;
    game_id: string | null;
    date: Date | string | null;
    exclusive_poster_id?: string | null;
    live_window_hours_after_start?: number | null;
  },
  viewerState: ViewerState
) {
  const liveWindow = serializeLiveWindow(event.date, event.live_window_hours_after_start);
  const state = event.date
    ? getPostPostingWindowState(
        event.date instanceof Date ? event.date : new Date(event.date),
        viewerState.now,
        event.live_window_hours_after_start
      )
    : 'closed';
  const isDesignated = !!event.id && viewerState.designatedEventIds.has(event.id);
  const isExclusivePoster =
    !!event.exclusive_poster_id && event.exclusive_poster_id === viewerState.viewerId;
  const blockedByExclusive =
    !!event.exclusive_poster_id && event.exclusive_poster_id !== viewerState.viewerId;
  const unlockAnchor = event.id ? (viewerState.unlocks.get(event.id) ?? null) : null;
  const unlockExpiresAt = unlockAnchor
    ? new Date(unlockAnchor.getTime() + EVENT_POSTING_UNLOCK_DURATION_MS)
    : null;
  const hasActiveUnlock =
    !!unlockExpiresAt && unlockExpiresAt.getTime() >= viewerState.now.getTime();

  const activeDesignatedGrant = isDesignated && hasActiveUnlock;
  const overrideAllowed = activeDesignatedGrant || isExclusivePoster;
  const canPostWithoutFreshGeofence = overrideAllowed || hasActiveUnlock;
  const windowLive = state === 'live';
  const closedCode = 'POSTING_WINDOW_CLOSED';
  const liveNeedsLocationCode = 'LOCATION_REQUIRED';

  return {
    live_window: liveWindow,
    posting_capabilities: {
      window_state: state,
      requires_location: !canPostWithoutFreshGeofence,
      geofence_radius_km: GEOFENCE_RADIUS_KM,
      designated_poster: isDesignated,
      exclusive_poster: !!event.exclusive_poster_id,
      unlock_expires_at: iso(unlockExpiresAt),
      post: {
        allowed_now: canPostWithoutFreshGeofence,
        reason_code: canPostWithoutFreshGeofence
          ? null
          : blockedByExclusive
            ? 'EXCLUSIVE_POSTER_ONLY'
            : windowLive
              ? liveNeedsLocationCode
              : closedCode,
      },
      story: {
        allowed_now: overrideAllowed,
        reason_code: overrideAllowed
          ? null
          : blockedByExclusive
            ? 'EXCLUSIVE_POSTER_ONLY'
            : windowLive
              ? liveNeedsLocationCode
              : closedCode,
      },
    },
    upload_access: {
      can_upload_post: canPostWithoutFreshGeofence,
      can_upload_story: overrideAllowed,
      needs_live_geofence_check: !canPostWithoutFreshGeofence && windowLive,
    },
  };
}

function mapVisibility(
  coords: { latitude: number | null; longitude: number | null },
  ctx: SerializeCtx
) {
  const visible = coords.latitude != null && coords.longitude != null;
  return {
    visible,
    reason_code: visible ? null : 'NO_COORDINATES',
    surface_window: { from: ctx.from.toISOString(), to: ctx.to.toISOString() },
  };
}

/** Serialize a `Game` (with its optional linked event) into an event card. */
export function serializeGameCard(game: any, ctx: SerializeCtx) {
  const linkedEvent = game.events?.[0] ?? null;
  const coords = resolveCoords(game);
  const eventDate = linkedEvent?.date ?? game.date;
  const eventId = linkedEvent?.id ?? null;
  const capabilityEvent = {
    id: eventId,
    game_id: game.id,
    date: eventDate,
    exclusive_poster_id: linkedEvent?.exclusive_poster_id ?? null,
    live_window_hours_after_start: linkedEvent?.live_window_hours_after_start ?? null,
  };
  return {
    id: game.id,
    source_type: 'game',
    event_id: eventId,
    game_id: game.id,
    title: game.title,
    date: iso(eventDate),
    location: linkedEvent?.location ?? game.location ?? game.venue_address ?? null,
    latitude: coords.latitude,
    longitude: coords.longitude,
    sport:
      game.homeTeam?.sport ??
      game.awayTeam?.sport ??
      linkedEvent?.sportsLeague?.sport_slug ??
      proLeagueToSport(linkedEvent?.proHomeTeam?.league ?? linkedEvent?.proAwayTeam?.league) ??
      null,
    league_slug: linkedEvent?.sportsLeague?.slug ?? null,
    league_name: linkedEvent?.sportsLeague?.name ?? null,
    league_level: linkedEvent?.sportsLeague?.level ?? null,
    league_gender: linkedEvent?.sportsLeague?.gender ?? null,
    status: null,
    banner_url: game.banner_url ?? game.cover_image_url ?? linkedEvent?.banner_url ?? null,
    pro_home_color: linkedEvent?.proHomeTeam?.primary_color ?? null,
    pro_away_color: linkedEvent?.proAwayTeam?.primary_color ?? null,
    pro_league: linkedEvent?.proHomeTeam?.league ?? linkedEvent?.proAwayTeam?.league ?? null,
    venue_photo: venuePhotoFor(linkedEvent?.location ?? game.location),
    map_visibility: mapVisibility(coords, ctx),
    feed_priority: feedPriority(eventDate, ctx.now),
    ...buildCapabilities(capabilityEvent, ctx.viewerState),
  };
}

/** Serialize a standalone `Event` (pro/NCAA fixture or event page) into a card. */
export function serializeEventCard(event: any, ctx: SerializeCtx) {
  const coords = resolveCoords(event);
  return {
    id: event.id,
    source_type: 'event',
    event_id: event.id,
    game_id: null,
    title: event.title,
    date: iso(event.date),
    location: event.location,
    latitude: coords.latitude,
    longitude: coords.longitude,
    sport:
      event.team?.sport ??
      event.sportsLeague?.sport_slug ??
      proLeagueToSport(event.proHomeTeam?.league ?? event.proAwayTeam?.league) ??
      null,
    status: event.status,
    banner_url: event.banner_url ?? null,
    sports_league_id: event.sports_league_id ?? event.sportsLeague?.id ?? null,
    league_slug: event.sportsLeague?.slug ?? null,
    league_name: event.sportsLeague?.name ?? null,
    league_level: event.sportsLeague?.level ?? null,
    league_gender: event.sportsLeague?.gender ?? null,
    pro_home_color: event.proHomeTeam?.primary_color ?? null,
    pro_away_color: event.proAwayTeam?.primary_color ?? null,
    pro_league: event.proHomeTeam?.league ?? event.proAwayTeam?.league ?? null,
    venue_photo: venuePhotoFor(event.location),
    map_visibility: mapVisibility(coords, ctx),
    feed_priority: feedPriority(event.date, ctx.now),
    ...buildCapabilities(
      {
        id: event.id,
        game_id: null,
        date: event.date,
        exclusive_poster_id: event.exclusive_poster_id ?? null,
        live_window_hours_after_start: event.live_window_hours_after_start ?? null,
      },
      ctx.viewerState
    ),
  };
}
