// The default Live map is shorter to limit pin crowding. Explicit calendar
// browsing retains the public discovery horizon and historical access rules.
export const DISCOVERY_UPCOMING_DAYS = 14;
export const DISCOVERY_MAP_LIVE_DAYS = 3;
export const DISCOVERY_MAP_LIVE_MS = DISCOVERY_MAP_LIVE_DAYS * 86400000;
export const DISCOVERY_LIVE_LOOKBACK_HOURS = 18;
export const DISCOVERY_UPCOMING_MS = DISCOVERY_UPCOMING_DAYS * 86400000;
export const DISCOVERY_LIVE_LOOKBACK_MS = DISCOVERY_LIVE_LOOKBACK_HOURS * 3600000;

export function matchesDiscoveryLevel(level, selected) {
  if (!selected) return true;
  return selected === 'other' ? !['major', 'minor', 'college'].includes(level) : level === selected;
}
