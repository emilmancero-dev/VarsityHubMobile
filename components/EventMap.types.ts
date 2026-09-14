import type { Region } from 'react-native-maps';

export interface EventMapData {
  id: string;
  title: string;
  date: string;
  location?: string;
  latitude?: number;
  longitude?: number;
  type?: 'game' | 'event' | 'post';
  /** Canonical sport slug (see constants/sports.ts) — drives the map sport filter. */
  sport?: string | null;
  /** Map league tier used by the Major/Minor/NCAA/Other filter. */
  league_level?: 'major' | 'minor' | 'college' | 'other' | null;
}

export interface EventMapProps {
  events: EventMapData[];
  onEventPress?: (eventId: string, eventType?: 'game' | 'event' | 'post') => void;
  initialRegion?: Region;
  showUserLocation?: boolean;
  /** Set to true once the parent has finished loading its data. The empty state is suppressed until then. */
  dataLoaded?: boolean;
  /** When provided, renders a refresh control button that re-runs the parent's data load (e.g. so games added mid-event appear without leaving the map). */
  onRefresh?: () => void;
}
