import type { EventMapData } from '@/components/EventMap.types';

const SPORT_MARKER_COLORS: Record<string, string> = {
  football: '#2563EB',
  basketball: '#EA580C',
  beach_volleyball: '#0EA5E9',
  bowling: '#7E22CE',
  baseball: '#16A34A',
  softball: '#84CC16',
  soccer: '#059669',
  ice_hockey: '#0891B2',
  water_polo: '#2563EB',
  skiing: '#0369A1',
  fencing: '#475569',
  field_hockey: '#0D9488',
  lacrosse: '#7C3AED',
  mma: '#B91C1C',
  auto_racing: '#111827',
  stunt: '#E11D48',
  acrobatics_tumbling: '#BE123C',
  volleyball: '#DB2777',
  wrestling: '#B45309',
  tennis: '#65A30D',
  golf: '#15803D',
  track_field: '#DC2626',
  cross_country: '#9333EA',
  swimming: '#0284C7',
  cheerleading: '#E11D48',
  dance: '#C026D3',
  gymnastics: '#BE123C',
  crew: '#0F766E',
  esports: '#4F46E5',
};

function isHexColor(value?: string | null): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value.trim());
}

export function resolveMarkerColor(
  event: Pick<
    EventMapData,
    'has_posts' | 'marker_color' | 'pro_home_color' | 'pro_away_color' | 'sport' | 'type'
  >,
  fallback: string
): string {
  if (event.has_posts === true) return '#D4AF37';
  if (isHexColor(event.marker_color)) return event.marker_color;
  if (isHexColor(event.pro_home_color)) return event.pro_home_color;
  if (isHexColor(event.pro_away_color)) return event.pro_away_color;
  if (event.sport && SPORT_MARKER_COLORS[event.sport]) return SPORT_MARKER_COLORS[event.sport];
  switch (event.type) {
    case 'game':
      return '#FF6B6B';
    case 'event':
      return '#4ECDC4';
    case 'post':
      return '#95E1D3';
    default:
      return fallback;
  }
}
