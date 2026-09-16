/**
 * Client-side types matching server Zod schemas.
 * These compile independently from the server — keep in sync manually.
 * When in doubt, check server/src/routes/*.ts for the canonical Zod schema.
 */

// ── User ──────────────────────────────────────────────────────────────

export type FeedBundleSection =
  | 'posts'
  | 'posts_followed_teams'
  | 'highlights'
  | 'ads'
  | 'unread_notifications'
  | 'unread_messages';

export interface UpdateMePayload {
  display_name?: string | null;
  username?: string | null;
  avatar_url?: string | null;
  bio?: string | null;
}

export interface UpdatePreferencesPayload {
  push_token?: string;
  notifications_enabled?: boolean;
  onboarding_completed?: boolean;
  role?: 'fan' | 'coach';
  plan?: 'rookie' | 'veteran' | 'legend';
  pending_plan?: 'rookie' | 'veteran' | 'legend';
  payment_pending?: boolean;
  payment_approved?: boolean;
  join_request_pending?: boolean;
  proceeding_as_fan?: boolean;
  coach_agreement_accepted_at?: string;
  organization_id?: string;
  organization_name?: string;
  subscription_tier?: string;
  [key: string]: unknown; // server stores preferences as JSON — allow extension
}

export interface CompleteOnboardingPayload {
  role?: 'fan' | 'coach';
  username?: string;
  display_name?: string;
  avatar_url?: string;
  bio?: string;
  dob?: string;
  zip_code?: string;
  plan?: 'rookie' | 'veteran' | 'legend';
  sport?: string;
  team_name?: string;
  team_id?: string;
  organization_id?: string;
  organization_name?: string;
  sports_interests?: string[];
  primary_intents?: string[];
  personalization_goals?: string[];
  season_start?: string;
  season_end?: string;
  location_enabled?: boolean;
  notifications_enabled?: boolean;
  messaging_policy_accepted?: boolean;
  proceeding_as_fan?: boolean;
  [key: string]: unknown;
}

// ── Game ──────────────────────────────────────────────────────────────

export type EventType =
  | 'game'
  | 'fundraiser'
  | 'watch_party'
  | 'team_trip'
  | 'meeting'
  | 'team_meal'
  | 'other';

export interface CreateGamePayload {
  title: string;
  home_team?: string;
  away_team?: string;
  home_team_id?: string;
  away_team_id?: string;
  away_team_name?: string;
  date?: string;
  location: string;
  description?: string;
  cover_image_url?: string;
  banner_url?: string;
  appearance?: string;
  expected_attendance?: number;
  event_type?: EventType;
  donation_goal?: number;
  watch_location?: string;
  destination?: string;
  venue_place_id?: string;
  venue_address?: string;
  venue_lat?: number;
  venue_lng?: number;
  is_neutral?: boolean;
}

export interface UpdateGamePayload extends Omit<Partial<CreateGamePayload>, 'location'> {
  title?: string;
  location?: string | null;
  status?: string;
}

export interface SetGameResultPayload {
  home_score?: number;
  away_score?: number;
  winner?: 'home' | 'away' | 'tie' | null;
}

// ── Post ──────────────────────────────────────────────────────────────

export interface CreatePostPayload {
  title?: string;
  content?: string;
  type?: string;
  media_url?: string;
  game_id?: string;
  event_id?: string;
  team_id?: string;
  location?: {
    lat?: number | null;
    lng?: number | null;
    place_id?: string | null;
    place_name?: string | null;
    locality?: string | null;
    admin_area?: string | null;
    country?: string | null;
    country_code?: string | null;
    source?: 'device' | 'places' | 'zip' | 'derived' | null;
    zip?: string | null;
  };
}

export interface UpdatePostPayload {
  content?: string;
  title?: string;
}

// ── Event ─────────────────────────────────────────────────────────────

export interface CreateEventPayload {
  title: string;
  date: string;
  location: string;
  latitude?: number;
  longitude?: number;
  banner_url?: string;
  cover_image_url?: string;
  game_id?: string;
  event_type?:
    | 'game'
    | 'fundraiser'
    | 'watch_party'
    | 'team_trip'
    | 'meeting'
    | 'team_meal'
    | 'tryout'
    | 'bbq'
    | 'team_meeting'
    | 'host_request'
    | 'other';
  description?: string;
  linked_league?: string;
  max_attendees?: number;
  contact_info?: string;
  team_id?: string;
}

export interface UpdateEventPayload extends Partial<CreateEventPayload> {}

// ── Ad ────────────────────────────────────────────────────────────────

export interface CreateAdPayload {
  contact_name: string;
  contact_email: string;
  business_name: string;
  banner_url?: string;
  banner_fit_mode?: 'cover' | 'contain' | 'fill';
  target_url?: string;
  cta_text?: string;
  target_zip_code: string;
  radius?: number;
  description?: string;
}

export interface UpdateAdPayload extends Partial<CreateAdPayload> {}
