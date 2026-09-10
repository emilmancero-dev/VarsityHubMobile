/**
 * Canonical client-side event-card contract.
 *
 * Mirrors the server's `/event-discovery` item shape (server/src/lib/
 * eventDiscovery.ts). This is the single client-side definition of "an event
 * card" — every surface that renders games/events should consume `EventCard`
 * instead of re-deriving the Game/Event blend. The schema is deliberately
 * lenient (only id + source_type required; everything else nullable/optional;
 * unknown fields pass through) so the server can add fields without breaking
 * clients, and so per-item validation only drops genuinely unrenderable items.
 */
import { z } from 'zod';
import { captureException } from '@/utils/sentry';

const mapVisibilitySchema = z
  .object({
    visible: z.boolean().optional(),
    reason_code: z.string().nullable().optional(),
    surface_window: z
      .object({ from: z.string().optional(), to: z.string().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const venuePhotoSchema = z
  .union([
    z.string(),
    z
      .object({
        url: z.string(),
        credit: z.string().nullable().optional(),
      })
      .passthrough(),
  ])
  .nullable()
  .optional();

const uploadAccessSchema = z
  .object({
    can_upload_post: z.boolean().optional(),
    can_upload_story: z.boolean().optional(),
    needs_live_geofence_check: z.boolean().optional(),
  })
  .passthrough();

export const eventCardSchema = z
  .object({
    // Identity
    id: z.string(),
    source_type: z.enum(['game', 'event']),
    event_id: z.string().nullable().optional(),
    game_id: z.string().nullable().optional(),
    // Display
    has_posts: z.boolean().optional(),
    title: z.string().nullable().optional(),
    date: z.string().nullable().optional(),
    location: z.string().nullable().optional(),
    banner_url: z.string().nullable().optional(),
    sport: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    sports_league_id: z.string().nullable().optional(),
    league_slug: z.string().nullable().optional(),
    league_name: z.string().nullable().optional(),
    league_level: z.string().nullable().optional(),
    league_gender: z.string().nullable().optional(),
    pro_home_color: z.string().nullable().optional(),
    pro_away_color: z.string().nullable().optional(),
    pro_league: z.string().nullable().optional(),
    venue_photo: venuePhotoSchema,
    // Location
    latitude: z.number().nullable().optional(),
    longitude: z.number().nullable().optional(),
    map_visibility: mapVisibilitySchema.nullable().optional(),
    // Ranking
    feed_priority: z.number().nullable().optional(),
    // Capabilities — kept opaque so capability drift never fails the parse.
    live_window: z.unknown().optional(),
    posting_capabilities: z.unknown().optional(),
    upload_access: uploadAccessSchema.nullable().optional(),
  })
  .passthrough();

export type EventCard = z.infer<typeof eventCardSchema>;

const discoveryWrapperSchema = z
  .object({
    items: z.array(z.unknown()),
    surface: z.string().optional(),
    counts: z.unknown().optional(),
  })
  .passthrough();

/**
 * Parse a `/event-discovery` response into typed cards. Never throws into a
 * screen. A malformed wrapper degrades to `[]`; individual malformed items are
 * dropped (keeping the valid subset). Both paths capture drift to Sentry.
 *
 * NB: this deliberately differs from `event.ts`'s pass-through-on-failure — a
 * keyed list feeding the map is safer dropping an unrenderable item than
 * passing a card with no `id`.
 */
export function validateEventCards(endpoint: string, payload: unknown): EventCard[] {
  const normalized = Array.isArray(payload) ? { items: payload } : payload;
  const wrapper = discoveryWrapperSchema.safeParse(normalized);
  if (!wrapper.success) {
    captureException(new Error('[eventCard] malformed discovery payload'), {
      endpoint,
      issue: wrapper.error.issues[0]?.message ?? 'invalid wrapper',
    });
    return [];
  }

  const cards: EventCard[] = [];
  let dropped = 0;
  let firstIssue: string | null = null;
  for (const raw of wrapper.data.items) {
    const parsed = eventCardSchema.safeParse(raw);
    if (parsed.success) {
      cards.push(parsed.data);
    } else {
      dropped += 1;
      if (!firstIssue) firstIssue = parsed.error.issues[0]?.message ?? 'invalid item';
    }
  }
  if (dropped > 0) {
    captureException(new Error(`[eventCard] dropped ${dropped} invalid item(s)`), {
      endpoint,
      dropped,
      firstIssue,
    });
  }
  return cards;
}
