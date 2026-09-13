// A lower bound of exactly `now` drops a game the instant kickoff passes even
// though it's still in progress (the server already vetted the item before
// sending it, so this is purely a stale-cache guard). Grace-period the floor
// by the platform's default live-window duration so an in-progress game
// doesn't vanish off the map between refetches — mirrors
// DEFAULT_LIVE_WINDOW_HOURS_AFTER_START in server/src/lib/geofencing.ts.
const DEFAULT_LIVE_GRACE_MS = 3 * 60 * 60 * 1000;

export function shouldShowEventOnMap(
  dateValue: string | null | undefined,
  now = new Date(),
  maxFutureDays = 14
): boolean {
  if (!dateValue) return true;
  const parsed = new Date(dateValue);
  if (Number.isNaN(parsed.getTime())) return true;
  const earliestAllowed = new Date(now.getTime() - DEFAULT_LIVE_GRACE_MS);
  const latestAllowed = new Date(now.getTime() + maxFutureDays * 24 * 60 * 60 * 1000);
  return parsed >= earliestAllowed && parsed <= latestAllowed;
}
