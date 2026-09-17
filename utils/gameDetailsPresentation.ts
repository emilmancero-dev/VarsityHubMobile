import { format } from 'date-fns';
import type { ColorValue } from 'react-native';

import { isEventPastEndOfDay } from '@/utils/eventPresentation';
import { isPostingWindowOpen, type LiveWindowFields } from '@/utils/liveWindow';
import type { MediaItem } from '../app/game-details/StoriesViewer';

export const PLACEHOLDER_GRADIENT: readonly [ColorValue, ColorValue, ...ColorValue[]] = [
  '#1E1E1E',
  '#121212',
];

export type TeamInfo = {
  id: string;
  name: string;
  avatarUrl?: string | null;
  color?: string | null;
};

// PDF commandments: "When a NCAA game doesn't have a stadium image, include
// a sport emoji in the center as well as a gradient background of the home
// team's colors." Team.primary_color is a single hex accent (deliberately not
// paired with logo/wordmark art, see schema.prisma's trademark-posture note) —
// darken it for the second stop so the gradient reads as a surface, not a flat
// color swatch. Falls back to the neutral placeholder when no team color exists.
export function buildTeamColorGradient(
  color: string | null | undefined
): readonly [ColorValue, ColorValue] {
  const hex = typeof color === 'string' ? color.trim() : '';
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return [PLACEHOLDER_GRADIENT[0], PLACEHOLDER_GRADIENT[1]];
  const num = parseInt(match[1], 16);
  const r = (num >> 16) & 0xff;
  const g = (num >> 8) & 0xff;
  const b = num & 0xff;
  const darken = (channel: number) => Math.round(channel * 0.45);
  const shadow = `#${[darken(r), darken(g), darken(b)]
    .map(c => c.toString(16).padStart(2, '0'))
    .join('')}`;
  return [hex, shadow];
}

export type GameVM = {
  id: string;
  gameId: string | null;
  eventId: string | null;
  title: string;
  date: string;
  location: string | null;
  description?: string | null;
  bannerUrl?: string | null;
  venuePhotoUrl?: string | null;
  venuePhotoCredit?: string | null;
  homeTeam?: string | null;
  awayTeam?: string | null;
  // Sport / league for the no-image banner placeholder emoji (owner rule: a
  // centered sport emoji on the gradient when there's no stadium photo).
  sport?: string | null;
  proLeague?: string | null;
  appearance?: string | null;
  coverImageUrl?: string | null;
  capacity?: number | null;
  rsvpCount?: number | null;
  userRsvped?: boolean;
  teams: TeamInfo[];
  posts: any[];
  media: MediaItem[];
  reviewsCount?: number | null;
  isPast: boolean;
  eventType?: string | null;
  home_score?: number | null;
  away_score?: number | null;
  winner?: string | null;
  can_edit_result?: boolean;
  /**
   * Server-authoritative story override for THIS viewer on an event page: true
   * when they are a designated poster with an active unlock (or the exclusive
   * poster), so "Add Story" is enabled and the geofence/live-window is skipped
   * for them — mirroring the server's story permission. Source:
   * GET /events/:id can_upload_story.
   */
  canUploadStory?: boolean;
  venueLat?: number | null;
  venueLng?: number | null;
  // Server-computed posting-window bounds (GET /games/:id[/summary]); used to
  // gate story posting on the real per-event window instead of a 3h fallback.
  starts_at?: string | null;
  live_from?: string | null;
  live_until?: string | null;
};

export const ensureIso = (value: any) => {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return null;
};

export const getVenuePhoto = (value: unknown): { url: string | null; credit: string | null } => {
  if (!value || typeof value !== 'object') {
    return { url: null, credit: null };
  }
  const record = value as { url?: unknown; credit?: unknown };
  return {
    url: typeof record.url === 'string' ? record.url : null,
    credit: typeof record.credit === 'string' ? record.credit : null,
  };
};

export const formatDateLabel = (iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return format(d, 'EEE, MMM d, yyyy');
};

export const formatTimeLabel = (iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return format(d, 'h:mm a');
};

export const computeIsPast = (iso?: string | null) => {
  return isEventPastEndOfDay(iso);
};

// Kept in sync with server/scripts/seed-demo-matchups.ts DEMO_TAG and the
// carve-out in server/src/routes/gameStories.ts -- changing this string
// silently breaks the client gate for seeded promo matchups.
export const DEMO_MATCHUP_TAG = '[DEMO_MATCHUP]';

export const canAddStory = (
  eventIso?: string | null,
  _gameId?: string | null,
  description?: string | null,
  liveWindow?: LiveWindowFields | null
) => {
  // Seeded demo matchups (Duke v UNC, Cavs v Warriors) bypass the day-of gate
  // to match the server-side [DEMO_MATCHUP] carve-out in gameStories.ts.
  if (typeof description === 'string' && description.includes(DEMO_MATCHUP_TAG)) return true;

  // Without an event date, allow uploading -- no window to enforce client-side.
  if (!eventIso) return true;

  // Mirrors the server's isStoryPostingWindowOpen (geofencing.ts): stories are
  // live-only. Prefer server-computed bounds when present so per-event overrides
  // such as festival days are honored.
  return isPostingWindowOpen({ ...(liveWindow ?? {}), date: eventIso });
};

export const capCount = (count?: number | null, capacity?: number | null) => {
  if (typeof count !== 'number') return null;
  if (typeof capacity === 'number' && capacity >= 0) return Math.min(count, capacity);
  return count;
};

// No special-case banner -- kept generic for any matchup.
export const finalsBannerForTeams = (
  _home?: string | null,
  _away?: string | null,
  _title?: string | null
) => {
  return null;
};

export const pickBannerFromArrays = (vm: Partial<GameVM>) => {
  const finalsBanner = finalsBannerForTeams(vm.homeTeam, vm.awayTeam, vm.title as any);
  const result = vm.bannerUrl || vm.coverImageUrl || finalsBanner || null;
  return result;
};
