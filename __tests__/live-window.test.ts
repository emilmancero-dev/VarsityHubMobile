/**
 * Live window + at-venue pinning (2026-07-16 Fanatics Fest).
 *
 * Real prod data for Fanatics Fest NYC 2026 Day 1, which is what these numbers
 * are drawn from:
 *   Event.date                          = 2026-07-16T17:00:00Z  (1:00 PM ET)
 *   Event.live_window_hours_after_start = 18
 *   venue (Javits Center)               = 40.75687, -74.001762
 * The server serializes starts_at/live_from/live_until from those.
 *
 * Under the old hardcoded client cutoffs (2h in feed.tsx, 3h in
 * create-post.tsx) the event stopped reading as live at 3:00/4:00 PM ET and
 * fell out of the feed, while the server accepted posts until 7:00 AM ET.
 */

import {
  AT_VENUE_RADIUS_KM,
  getLiveBounds,
  isAtVenue,
  isGameLive,
  isGameOver,
  isPostingWindowOpen,
  shouldPinToFeed,
} from '../utils/liveWindow';

const JAVITS = { latitude: 40.75687, longitude: -74.001762 };

// The exact payload GET /games now returns for the Day 1 fest game. Note the
// game's own `date` disagrees with its event's start — that is real prod data,
// and the server-computed bounds are the authority.
const FEST_DAY1 = {
  date: '2026-07-17T03:39:26.960Z',
  starts_at: '2026-07-16T17:00:00.000Z',
  live_from: null, // no early cutoff — posting open up to live_until (owner rule 2026-08-28)
  live_until: '2026-07-17T11:00:00.000Z',
  ...JAVITS,
};

const at = (iso: string) => new Date(iso).getTime();

describe('server-computed bounds win over the game row date', () => {
  it('uses starts_at/live_until, not the disagreeing game date', () => {
    const b = getLiveBounds(FEST_DAY1)!;
    expect(new Date(b.startsAt).toISOString()).toBe('2026-07-16T17:00:00.000Z');
    expect(new Date(b.liveUntil).toISOString()).toBe('2026-07-17T11:00:00.000Z');
  });

  it('is LIVE at 8:46 PM ET — the moment the owner reported it had "ended"', () => {
    expect(isGameLive(FEST_DAY1, at('2026-07-17T00:46:00Z'))).toBe(true);
    expect(isGameOver(FEST_DAY1, at('2026-07-17T00:46:00Z'))).toBe(false);
  });

  it('stays live across the whole 18h window and ends exactly at the cutoff', () => {
    expect(isGameLive(FEST_DAY1, at('2026-07-16T20:00:01Z'))).toBe(true); // past the old 3h
    expect(isGameLive(FEST_DAY1, at('2026-07-17T10:59:00Z'))).toBe(true);
    expect(isGameLive(FEST_DAY1, at('2026-07-17T11:00:01Z'))).toBe(false);
    expect(isGameOver(FEST_DAY1, at('2026-07-17T11:00:01Z'))).toBe(true);
  });

  it('is not LIVE before it starts, but posting has no early cutoff (open before start)', () => {
    // The LIVE badge only lights at start, but posting is open well before it —
    // no early cutoff (owner rule 2026-08-28), geofence is the only presence gate.
    expect(isGameLive(FEST_DAY1, at('2026-07-16T16:30:00Z'))).toBe(false);
    expect(isPostingWindowOpen(FEST_DAY1, at('2026-07-16T16:30:00Z'))).toBe(true);
    expect(isPostingWindowOpen(FEST_DAY1, at('2026-07-16T05:30:00Z'))).toBe(true);
    // Even a full day early, posting is open (it only closes at live_until).
    expect(isPostingWindowOpen(FEST_DAY1, at('2026-07-15T12:00:00Z'))).toBe(true);
    // Past the cutoff it closes.
    expect(isPostingWindowOpen(FEST_DAY1, at('2026-07-17T11:00:01Z'))).toBe(false);
  });
});

describe('fallback for payloads without server bounds', () => {
  const legacy = { date: '2026-07-16T17:00:00.000Z' };

  it('falls back to the server default (3h), not the old 2h feed constant', () => {
    expect(isGameLive(legacy, at('2026-07-16T19:30:00Z'))).toBe(true); // 2.5h in
    expect(isGameLive(legacy, at('2026-07-16T20:30:00Z'))).toBe(false); // past 3h
  });

  it('returns null bounds when there is no usable date at all', () => {
    expect(getLiveBounds({})).toBeNull();
    expect(getLiveBounds({ date: 'not-a-date' })).toBeNull();
    expect(isGameLive(null)).toBe(false);
    expect(isGameLive(undefined)).toBe(false);
  });
});

describe('at-venue detection', () => {
  it('is true standing at the Javits Center', () => {
    expect(isAtVenue(FEST_DAY1, JAVITS)).toBe(true);
  });

  it('is false across town and true a few blocks away', () => {
    expect(isAtVenue(FEST_DAY1, { latitude: 40.6782, longitude: -73.9442 })).toBe(false); // Brooklyn
    expect(isAtVenue(FEST_DAY1, { latitude: 40.7527, longitude: -73.9772 })).toBe(true); // Grand Central ~2km
  });

  it('fails closed on unknown coords rather than guessing', () => {
    expect(isAtVenue(FEST_DAY1, null)).toBe(false);
    expect(isAtVenue(FEST_DAY1, { latitude: null, longitude: null })).toBe(false);
    expect(isAtVenue({ latitude: null, longitude: null }, JAVITS)).toBe(false);
  });

  it('honors venue_lat/venue_lng when latitude/longitude are absent', () => {
    expect(isAtVenue({ venue_lat: JAVITS.latitude, venue_lng: JAVITS.longitude }, JAVITS)).toBe(
      true
    );
  });

  it('uses the same 3km radius the composer warns on', () => {
    expect(AT_VENUE_RADIUS_KM).toBe(3);
  });
});

describe('pin rule: live AND at the location', () => {
  const during = at('2026-07-17T00:46:00Z');
  const after = at('2026-07-17T12:00:00Z');

  it('pins for a fan at the venue while it is live', () => {
    expect(shouldPinToFeed(FEST_DAY1, JAVITS, during)).toBe(true);
  });

  it('does not pin once the window closes, even at the venue', () => {
    expect(shouldPinToFeed(FEST_DAY1, JAVITS, after)).toBe(false);
  });

  it('does not pin for someone live-but-elsewhere', () => {
    expect(shouldPinToFeed(FEST_DAY1, { latitude: 34.0522, longitude: -118.2437 }, during)).toBe(
      false
    );
  });

  it('does not pin when location is unknown', () => {
    expect(shouldPinToFeed(FEST_DAY1, null, during)).toBe(false);
  });
});
