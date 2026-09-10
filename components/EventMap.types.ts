import type { Region } from 'react-native-maps';

export interface EventMapData {
  id: string;
  /** Canonical standalone event page id, when the marker represents or links to one. */
  event_id?: string | null;
  /** Canonical game id, when the marker represents a game-backed event page. */
  game_id?: string | null;
  /** Viewer-visible, non-deleted posts exist on this page. */
  has_posts?: boolean;
  title: string;
  date: string;
  location?: string;
  latitude?: number;
  longitude?: number;
  type?: 'game' | 'event' | 'post';
  /** Canonical sport slug (see constants/sports.ts) — drives the map sport filter. */
  sport?: string | null;
  /** League metadata for map search/filter display. */
  league_slug?: string | null;
  league_name?: string | null;
  league_level?: string | null;
  league_gender?: string | null;
  /** Optional accent colors from linked teams/leagues, used before generic type colors. */
  pro_home_color?: string | null;
  pro_away_color?: string | null;
  marker_color?: string | null;
  upload_access?: {
    can_upload_post?: boolean;
    can_upload_story?: boolean;
    needs_live_geofence_check?: boolean;
  } | null;
}

export interface EventMapProps {
  events: EventMapData[];
  onEventPress?: (eventId: string, eventType?: 'game' | 'event' | 'post') => void;
  initialRegion?: Region;
  showUserLocation?: boolean;
  /** Set to true once the parent has finished loading its data. The empty state is suppressed until then. */
  dataLoaded?: boolean;
  /** Show the user dot without automatically zooming the first render into the user's exact location. */
  preventAutoCenterOnUser?: boolean;
  /** When provided, renders a refresh control button that re-runs the parent's data load (e.g. so games added mid-event appear without leaving the map). */
  onRefresh?: () => void;
  /** When provided, renders a composer shortcut from the selected marker preview. */
  onCreatePostPress?: (event: EventMapData) => void;
  /** Hide the "center on user" (navigate) control button. Owner note 8: the map's
   *  middle button is replaced by the dates tracker on the Nearby Games page. */
  hideCenterOnUser?: boolean;
  /** When provided, renders a calendar/dates-tracker control button (in place of
   *  the removed center-on-user button) that opens the parent's date picker. */
  onCalendarPress?: () => void;
  /** Highlights the calendar control when a specific date is being viewed. */
  calendarActive?: boolean;
  /** When false, the map does NOT auto-zoom to fit the loaded pins on data load —
   *  it stays on `initialRegion`. The feed map uses this so it opens USA-wide and
   *  shows all event pages nationwide instead of zooming into whichever pins
   *  happened to load near the user. The manual "fit to events" button still works.
   *  Defaults to true to preserve the zoom-to-pins behavior other callers rely on. */
  autoFitPins?: boolean;
}
