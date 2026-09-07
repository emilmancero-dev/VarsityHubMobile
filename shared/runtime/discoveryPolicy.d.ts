export const DISCOVERY_UPCOMING_DAYS: number;
export const DISCOVERY_MAP_LIVE_DAYS: number;
export const DISCOVERY_MAP_LIVE_MS: number;
export const DISCOVERY_LIVE_LOOKBACK_HOURS: number;
export const DISCOVERY_UPCOMING_MS: number;
export const DISCOVERY_LIVE_LOOKBACK_MS: number;
export function matchesDiscoveryLevel(
  level: string | null | undefined,
  selected: string | null | undefined
): boolean;
