import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockEventFindUnique = jest.fn();
const mockGameFindUnique = jest.fn();
const mockPostFindFirst = jest.fn();
const mockStoryFindFirst = jest.fn();
const mockUnlockFindUnique = jest.fn();
const mockUnlockCreateMany = jest.fn();
const mockDesignatedFindUnique = jest.fn();

jest.unstable_mockModule('../lib/prisma.js', () => ({
  prisma: {
    event: {
      findUnique: mockEventFindUnique,
    },
    game: {
      findUnique: mockGameFindUnique,
    },
    post: {
      findFirst: mockPostFindFirst,
    },
    story: {
      findFirst: mockStoryFindFirst,
    },
    eventPostingUnlock: {
      findUnique: mockUnlockFindUnique,
      createMany: mockUnlockCreateMany,
    },
    eventDesignatedPoster: {
      findUnique: mockDesignatedFindUnique,
    },
  },
}));

const {
  EVENT_ENDED_NOT_PRESENT_REASON,
  isStoryPostingWindowOpen,
  verifyEventPostingPermission,
  verifyStoryPostingPermission,
} = await import('../lib/geofencing.js');

const EVENT_DATE = new Date('2026-05-10T18:00:00.000Z');
// Default live window: opens 2h before start, closes 6h after (owner rule
// 2026-09-14 — the standard 8-hour shape: 2h before, 4h during, 2h after).
const WINDOW_START = new Date(EVENT_DATE.getTime() - 2 * 60 * 60 * 1000);
const LIVE_CUTOFF = new Date(EVENT_DATE.getTime() + 6 * 60 * 60 * 1000);
const GRACE_END = new Date(LIVE_CUTOFF.getTime() + 7 * 24 * 60 * 60 * 1000);
const BASE_EVENT = {
  id: 'event-1',
  title: 'Championship',
  date: EVENT_DATE,
  latitude: 40.7128,
  longitude: -74.006,
  location: 'Stadium',
  game_id: 'game-1',
  exclusive_poster_id: null,
  live_window_hours_after_start: null as number | null,
};
// All-day festival override (Fanatics Fest day events set 18).
const FEST_EVENT = { ...BASE_EVENT, live_window_hours_after_start: 18 };

// Venue is NYC; LA is ~3900 km away.
const VENUE = { lat: 40.7128, lon: -74.006 };
const FAR_AWAY = { lat: 34.0522, lon: -118.2437 };

describe('first-post-unlocks-7-days posting rule', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockEventFindUnique.mockReset();
    mockGameFindUnique.mockReset();
    mockPostFindFirst.mockReset();
    mockStoryFindFirst.mockReset();
    mockUnlockFindUnique.mockReset();
    mockUnlockCreateMany.mockReset();
    mockDesignatedFindUnique.mockReset();
    global.fetch = jest.fn() as any;
    mockEventFindUnique.mockResolvedValue(BASE_EVENT);
    mockGameFindUnique.mockResolvedValue(null);
    mockPostFindFirst.mockResolvedValue(null);
    mockStoryFindFirst.mockResolvedValue(null);
    mockUnlockFindUnique.mockResolvedValue(null);
    mockUnlockCreateMany.mockResolvedValue({ count: 1 });
    mockDesignatedFindUnique.mockResolvedValue(null);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('regular posts — live window (geofenced first posts)', () => {
    it('blocks a post half a day BEFORE start — the window has not opened yet (owner rule 2026-09-14)', async () => {
      jest.setSystemTime(new Date(EVENT_DATE.getTime() - 12 * 60 * 60 * 1000 - 1));

      const result = await verifyEventPostingPermission('event-1', 'user-1', VENUE.lat, VENUE.lon);

      expect(result.allowed).toBe(false);
      expect(result.code).toBe('POSTING_WINDOW_CLOSED');
      expect(mockUnlockCreateMany).not.toHaveBeenCalled();
    });

    it('blocks a post on game-day morning, hours BEFORE the 2h-before window opens', async () => {
      jest.setSystemTime(new Date(EVENT_DATE.getTime() - 8 * 60 * 60 * 1000));

      const result = await verifyEventPostingPermission('event-1', 'user-1', VENUE.lat, VENUE.lon);

      expect(result.allowed).toBe(false);
      expect(result.code).toBe('POSTING_WINDOW_CLOSED');
    });

    it('blocks an early post by time before the geofence is even checked', async () => {
      // The window hasn't opened yet, so this is a time gate — it fires before
      // location is evaluated at all, regardless of where the user is.
      jest.setSystemTime(new Date(EVENT_DATE.getTime() - 8 * 60 * 60 * 1000));

      const result = await verifyEventPostingPermission(
        'event-1',
        'user-1',
        FAR_AWAY.lat,
        FAR_AWAY.lon
      );

      expect(result.allowed).toBe(false);
      expect(result.code).toBe('POSTING_WINDOW_CLOSED');
    });

    it('allows a geofenced post within the 2h-before window and grants the unlock', async () => {
      jest.setSystemTime(new Date(EVENT_DATE.getTime() - 60 * 60 * 1000));

      const result = await verifyEventPostingPermission('event-1', 'user-1', VENUE.lat, VENUE.lon);

      expect(result.allowed).toBe(true);
      expect(mockUnlockCreateMany).toHaveBeenCalled();
    });

    it('allows a geofenced first post during the event and grants the unlock', async () => {
      jest.setSystemTime(new Date(EVENT_DATE.getTime() + 30 * 60 * 1000));

      const result = await verifyEventPostingPermission('event-1', 'user-1', VENUE.lat, VENUE.lon);

      expect(result.allowed).toBe(true);
      expect(mockUnlockCreateMany).toHaveBeenCalledWith({
        data: [{ user_id: 'user-1', event_id: 'event-1' }],
        skipDuplicates: true,
      });
    });

    it('stays open 5h after start (inside the 6h default) for first-time posters at the venue', async () => {
      jest.setSystemTime(new Date(EVENT_DATE.getTime() + 5 * 60 * 60 * 1000));

      const result = await verifyEventPostingPermission('event-1', 'user-1', VENUE.lat, VENUE.lon);

      expect(result.allowed).toBe(true);
    });

    it('closes the default live window 6h after start for first-time posters, even at the venue', async () => {
      jest.setSystemTime(new Date(EVENT_DATE.getTime() + 7 * 60 * 60 * 1000));

      const result = await verifyEventPostingPermission('event-1', 'user-1', VENUE.lat, VENUE.lon);

      expect(result.allowed).toBe(false);
      expect(result.code).toBe('POSTING_WINDOW_CLOSED');
    });

    it('the live_window_hours_after_start override keeps geofenced first posts open all day (Fanatics Fest)', async () => {
      // Fest day events set 18h: a first-time poster standing at the Javits
      // Center at +17h can still post (and earns their unlock).
      mockEventFindUnique.mockResolvedValue(FEST_EVENT);
      jest.setSystemTime(new Date(EVENT_DATE.getTime() + 17 * 60 * 60 * 1000));

      const result = await verifyEventPostingPermission('event-1', 'user-1', VENUE.lat, VENUE.lon);

      expect(result.allowed).toBe(true);
      expect(mockUnlockCreateMany).toHaveBeenCalled();
    });

    it('the override still enforces the geofence for first posts', async () => {
      mockEventFindUnique.mockResolvedValue(FEST_EVENT);
      jest.setSystemTime(new Date(EVENT_DATE.getTime() + 17 * 60 * 60 * 1000));

      const result = await verifyEventPostingPermission(
        'event-1',
        'user-1',
        FAR_AWAY.lat,
        FAR_AWAY.lon
      );

      expect(result.allowed).toBe(false);
      expect(result.code).toBe('TOO_FAR_FROM_VENUE');
    });

    it('still enforces the 3km geofence for a FIRST post during the event', async () => {
      jest.setSystemTime(new Date(EVENT_DATE.getTime() + 30 * 60 * 1000));

      const result = await verifyEventPostingPermission(
        'event-1',
        'user-1',
        FAR_AWAY.lat,
        FAR_AWAY.lon
      );

      expect(result.allowed).toBe(false);
      expect(result.code).toBe('TOO_FAR_FROM_VENUE');
      expect(mockUnlockCreateMany).not.toHaveBeenCalled();
    });

    it('still requires location for a FIRST post during the event', async () => {
      jest.setSystemTime(new Date(EVENT_DATE.getTime() + 30 * 60 * 1000));

      const result = await verifyEventPostingPermission('event-1', 'user-1', null, null);

      expect(result.allowed).toBe(false);
      expect(result.code).toBe('LOCATION_REQUIRED');
    });

    it('allows an unlocked user to post from FAR AWAY during the live window (no re-geofence)', async () => {
      jest.setSystemTime(new Date(EVENT_DATE.getTime() + 2 * 60 * 60 * 1000));
      mockUnlockFindUnique.mockResolvedValue({ unlocked_at: new Date(EVENT_DATE) });

      const result = await verifyEventPostingPermission(
        'event-1',
        'user-1',
        FAR_AWAY.lat,
        FAR_AWAY.lon
      );

      expect(result.allowed).toBe(true);
    });

    it('allows an unlocked user to post with NO location during the live window', async () => {
      jest.setSystemTime(new Date(EVENT_DATE.getTime() + 2 * 60 * 60 * 1000));
      mockUnlockFindUnique.mockResolvedValue({ unlocked_at: new Date(EVENT_DATE) });

      const result = await verifyEventPostingPermission('event-1', 'user-1', null, null);

      expect(result.allowed).toBe(true);
    });

    it('allows an unlocked fest attendee to keep posting mid-day without location (flaky indoor GPS)', async () => {
      mockEventFindUnique.mockResolvedValue(FEST_EVENT);
      jest.setSystemTime(new Date(EVENT_DATE.getTime() + 6 * 60 * 60 * 1000));
      mockUnlockFindUnique.mockResolvedValue({
        unlocked_at: new Date(EVENT_DATE.getTime() + 30 * 60 * 1000),
      });

      const result = await verifyEventPostingPermission('event-1', 'user-1', null, null);

      expect(result.allowed).toBe(true);
    });
  });

  describe('regular posts — post-event grace window (unlock only)', () => {
    const GRACE_TIME = new Date(LIVE_CUTOFF.getTime() + 24 * 60 * 60 * 1000);

    it('allows an unlocked user to post from anywhere during grace', async () => {
      jest.setSystemTime(GRACE_TIME);
      mockUnlockFindUnique.mockResolvedValue({ unlocked_at: new Date(EVENT_DATE) });

      const result = await verifyEventPostingPermission(
        'event-1',
        'user-1',
        FAR_AWAY.lat,
        FAR_AWAY.lon
      );

      expect(result.allowed).toBe(true);
    });

    it('denies grace posting without an unlock or any prior contribution, even from the venue', async () => {
      jest.setSystemTime(GRACE_TIME);

      const result = await verifyEventPostingPermission('event-1', 'user-1', VENUE.lat, VENUE.lon);

      expect(result.allowed).toBe(false);
      expect(result.code).toBe('POSTING_WINDOW_CLOSED');
      // Owner wording (2026-07-16): tell them presence was the price of entry,
      // not that they should come back later.
      expect(result.reason).toBe(EVENT_ENDED_NOT_PRESENT_REASON);
    });

    it('falls back to a prior surviving post (pre-ledger uploads) and persists the anchor', async () => {
      jest.setSystemTime(GRACE_TIME);
      const priorCreatedAt = new Date(EVENT_DATE.getTime() + 60 * 60 * 1000);
      mockPostFindFirst.mockResolvedValue({ created_at: priorCreatedAt });

      const result = await verifyEventPostingPermission('event-1', 'user-1', null, null);

      expect(result.allowed).toBe(true);
      expect(mockPostFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            author_id: 'user-1',
            deleted_at: null,
            OR: [{ event_id: 'event-1' }, { game_id: 'game-1' }],
          }),
          orderBy: { created_at: 'asc' },
        })
      );
      // The fallback anchor is persisted with the ORIGINAL created_at so the
      // 7-day window never slides forward.
      expect(mockUnlockCreateMany).toHaveBeenCalledWith({
        data: [{ user_id: 'user-1', event_id: 'event-1', unlocked_at: priorCreatedAt }],
        skipDuplicates: true,
      });
    });

    it('a prior STORY also unlocks post uploads (stories and posts share the unlock)', async () => {
      jest.setSystemTime(GRACE_TIME);
      mockStoryFindFirst.mockResolvedValue({
        created_at: new Date(EVENT_DATE.getTime() + 60 * 60 * 1000),
      });

      const result = await verifyEventPostingPermission('event-1', 'user-1', null, null);

      expect(result.allowed).toBe(true);
      // Stories anchor the unlock on either surface: a game-backed event matches
      // by game_id OR its own event_id.
      expect(mockStoryFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            user_id: 'user-1',
            OR: expect.arrayContaining([{ event_id: 'event-1' }, { game_id: 'game-1' }]),
          }),
        })
      );
    });

    it('event-only pages (no game) anchor on prior posts OR event stories by event_id', async () => {
      jest.setSystemTime(GRACE_TIME);
      mockEventFindUnique.mockResolvedValue({ ...BASE_EVENT, game_id: null });
      mockPostFindFirst.mockResolvedValue({ created_at: new Date(EVENT_DATE) });

      const result = await verifyEventPostingPermission('event-1', 'user-1', null, null);

      expect(result.allowed).toBe(true);
      expect(mockPostFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ OR: [{ event_id: 'event-1' }] }),
        })
      );
      // Event-page stories now exist and anchor the unlock too — keyed on
      // event_id only (there is no game to match).
      expect(mockStoryFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ user_id: 'user-1', OR: [{ event_id: 'event-1' }] }),
        })
      );
    });

    it('denies once the unlock is older than 7 days, even inside the grace window', async () => {
      // Unlock earned 1h before start (inside the game-day window); exactly 7 days after
      // event start the personal week is up (anchor + 7d passed 1h ago), while
      // the event-level grace window (LIVE_CUTOFF + 7d) is still open.
      jest.setSystemTime(new Date(EVENT_DATE.getTime() + 7 * 24 * 60 * 60 * 1000));
      mockUnlockFindUnique.mockResolvedValue({
        unlocked_at: new Date(EVENT_DATE.getTime() - 60 * 60 * 1000),
      });

      const result = await verifyEventPostingPermission('event-1', 'user-1', null, null);

      expect(result.allowed).toBe(false);
      expect(result.code).toBe('POSTING_WINDOW_CLOSED');
    });

    it('allows just before the grace window closes for a late unlock', async () => {
      jest.setSystemTime(new Date(GRACE_END.getTime() - 60 * 1000));
      mockUnlockFindUnique.mockResolvedValue({ unlocked_at: LIVE_CUTOFF });

      const result = await verifyEventPostingPermission('event-1', 'user-1', null, null);

      expect(result.allowed).toBe(true);
    });

    it('denies past the grace window boundary (+1ms) for everyone, without querying the ledger', async () => {
      jest.setSystemTime(new Date(GRACE_END.getTime() + 1));
      mockUnlockFindUnique.mockResolvedValue({ unlocked_at: LIVE_CUTOFF });

      const result = await verifyEventPostingPermission('event-1', 'user-1', VENUE.lat, VENUE.lon);

      expect(result.allowed).toBe(false);
      expect(result.code).toBe('POSTING_WINDOW_CLOSED');
      expect(mockUnlockFindUnique).not.toHaveBeenCalled();
    });

    it('tells a user on a long-finished event they missed it — not "posting opens <past date>"', async () => {
      // Regression: `closed` shared the `before_open` branch, so opening an
      // event page a week after the fact answered "Posting opens
      // May 10, 5:00 PM" — a date already in the past. Same rejection,
      // opposite meaning.
      jest.setSystemTime(new Date(GRACE_END.getTime() + 24 * 60 * 60 * 1000));

      const result = await verifyEventPostingPermission('event-1', 'user-1', VENUE.lat, VENUE.lon);

      expect(result.allowed).toBe(false);
      expect(result.code).toBe('POSTING_WINDOW_CLOSED');
      expect(result.reason).toBe(EVENT_ENDED_NOT_PRESENT_REASON);
      expect(result.reason).not.toContain('Posting opens');
    });

    it('blocks an at-venue post a full day before start — the window has not opened', async () => {
      // Owner rule 2026-09-14: the window opens 2h before start, so a user who
      // shows up a full day early is told "Posting opens <future date>", not
      // let straight in.
      jest.setSystemTime(new Date(EVENT_DATE.getTime() - 24 * 60 * 60 * 1000));

      const result = await verifyEventPostingPermission('event-1', 'user-1', VENUE.lat, VENUE.lon);

      expect(result.allowed).toBe(false);
      expect(result.code).toBe('POSTING_WINDOW_CLOSED');
      expect(result.reason).toContain('Posting opens');
    });
  });

  describe('stories', () => {
    // Story window rules:
    // - LIVE window: a story is always geofenced — an unlock does NOT skip the
    //   geofence while the event is live (you must actually be there to add a
    //   live story). This is stricter than regular posts.
    // - POST-EVENT grace: owner rule (Sep 2026, supersedes the 2026-07-16
    //   "stories get no grace" rule) — a user who ALREADY posted/storied here
    //   (holds an active 7-day unlock) may keep adding stories from anywhere
    //   through the grace window, exactly like regular posts. Everyone else is
    //   blocked once the live window closes.
    const STORY_TIME = new Date('2026-05-10T19:00:00.000Z'); // 1h into the event

    it('opens 2h before start and closes at the live cutoff — not +48h', () => {
      // Owner rule 2026-09-14: stories open 2h before start and stay open all
      // the way up to the +6h live cutoff.
      jest.setSystemTime(new Date('2026-05-09T18:00:00.000Z')); // a full day before
      expect(isStoryPostingWindowOpen(EVENT_DATE)).toBe(false);

      jest.setSystemTime(new Date('2026-05-10T06:30:00.000Z')); // game-day morning
      expect(isStoryPostingWindowOpen(EVENT_DATE)).toBe(false);

      jest.setSystemTime(new Date('2026-05-10T16:30:00.000Z')); // 1h30m before (inside 2h window)
      expect(isStoryPostingWindowOpen(EVENT_DATE)).toBe(true);

      jest.setSystemTime(new Date('2026-05-10T17:30:00.000Z')); // 30m before
      expect(isStoryPostingWindowOpen(EVENT_DATE)).toBe(true);

      jest.setSystemTime(STORY_TIME);
      expect(isStoryPostingWindowOpen(EVENT_DATE)).toBe(true);

      jest.setSystemTime(new Date('2026-05-11T00:00:01.000Z')); // past +6h
      expect(isStoryPostingWindowOpen(EVENT_DATE)).toBe(false);

      // The old (2026-08-28..09-13) rule kept this open for two more days.
      jest.setSystemTime(new Date('2026-05-11T12:00:00.000Z'));
      expect(isStoryPostingWindowOpen(EVENT_DATE)).toBe(false);
    });

    it('honors the per-event override so fest stories run all day', () => {
      jest.setSystemTime(new Date('2026-05-11T11:00:00.000Z')); // +17h
      expect(isStoryPostingWindowOpen(EVENT_DATE, 18)).toBe(true);
      expect(isStoryPostingWindowOpen(EVENT_DATE, null)).toBe(false);

      jest.setSystemTime(new Date('2026-05-11T12:00:01.000Z')); // +18h01m
      expect(isStoryPostingWindowOpen(EVENT_DATE, 18)).toBe(false);
    });

    it('a geofenced first story is allowed and grants the unlock', async () => {
      jest.setSystemTime(STORY_TIME);

      const result = await verifyStoryPostingPermission(
        'event-1',
        'user-1',
        VENUE.lat,
        VENUE.lon,
        null
      );

      expect(result.allowed).toBe(true);
      // Posting a story from the venue proves presence, so it still earns the
      // unlock that keeps regular POSTS open for a week.
      expect(mockUnlockCreateMany).toHaveBeenCalledWith({
        data: [{ user_id: 'user-1', event_id: 'event-1' }],
        skipDuplicates: true,
      });
    });

    it('blocks a story from too far away', async () => {
      jest.setSystemTime(STORY_TIME);

      const result = await verifyStoryPostingPermission(
        'event-1',
        'user-1',
        FAR_AWAY.lat,
        FAR_AWAY.lon,
        null
      );

      expect(result.allowed).toBe(false);
      expect(result.code).toBe('TOO_FAR_FROM_VENUE');
    });

    it('requires location for a story', async () => {
      jest.setSystemTime(STORY_TIME);

      const result = await verifyStoryPostingPermission('event-1', 'user-1', null, null, null);

      expect(result.allowed).toBe(false);
      expect(result.code).toBe('LOCATION_REQUIRED');
    });

    it('the unlock does NOT admit a story with no location', async () => {
      jest.setSystemTime(STORY_TIME);
      mockUnlockFindUnique.mockResolvedValue({ unlocked_at: new Date(EVENT_DATE) });

      const result = await verifyStoryPostingPermission('event-1', 'user-1', null, null, null);

      expect(result.allowed).toBe(false);
      expect(result.code).toBe('LOCATION_REQUIRED');
    });

    it('the unlock does NOT admit a story from far away — they have left the game', async () => {
      jest.setSystemTime(STORY_TIME);
      mockUnlockFindUnique.mockResolvedValue({ unlocked_at: new Date(EVENT_DATE) });

      const result = await verifyStoryPostingPermission(
        'event-1',
        'user-1',
        FAR_AWAY.lat,
        FAR_AWAY.lon,
        null
      );

      expect(result.allowed).toBe(false);
      expect(result.code).toBe('TOO_FAR_FROM_VENUE');
    });

    it('rejects stories when client coordinates conflict with network location', async () => {
      jest.setSystemTime(STORY_TIME);
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({ latitude: 34.0522, longitude: -118.2437 }),
      });

      const result = await verifyStoryPostingPermission(
        'event-1',
        'user-1',
        VENUE.lat,
        VENUE.lon,
        '8.8.8.8'
      );

      expect(result.allowed).toBe(false);
      expect(result.code).toBe('LOCATION_SPOOF_SUSPECTED');
    });

    it('the unlock no longer overrides an IP mismatch', async () => {
      jest.setSystemTime(STORY_TIME);
      (global.fetch as any).mockResolvedValue({
        ok: true,
        json: async () => ({ latitude: 34.0522, longitude: -118.2437 }),
      });
      mockUnlockFindUnique.mockResolvedValue({ unlocked_at: new Date(EVENT_DATE) });

      const result = await verifyStoryPostingPermission(
        'event-1',
        'user-1',
        VENUE.lat,
        VENUE.lon,
        '8.8.8.8'
      );

      expect(result.allowed).toBe(false);
      expect(result.code).toBe('LOCATION_SPOOF_SUSPECTED');
    });

    it('allows an unlocked user to add a story during the post-event grace window, from anywhere', async () => {
      // Owner rule (Sep 2026): already posted/storied here → keep adding stories
      // through the grace window, matching regular posts. No location needed.
      jest.setSystemTime(new Date('2026-05-11T00:00:01.000Z')); // past +6h, in grace
      mockUnlockFindUnique.mockResolvedValue({ unlocked_at: new Date(EVENT_DATE) });

      const result = await verifyStoryPostingPermission('event-1', 'user-1', null, null, null);

      expect(result.allowed).toBe(true);
    });

    it('blocks a story after the live window for a user WITHOUT an unlock', async () => {
      jest.setSystemTime(new Date('2026-05-11T00:00:01.000Z')); // past +6h, in grace
      mockUnlockFindUnique.mockResolvedValue(null);

      const result = await verifyStoryPostingPermission(
        'event-1',
        'user-1',
        VENUE.lat,
        VENUE.lon,
        null
      );

      expect(result.allowed).toBe(false);
      expect(result.code).toBe('POSTING_WINDOW_CLOSED');
    });

    it('blocks stories once the grace window has fully closed, even with an unlock', async () => {
      jest.setSystemTime(new Date('2026-05-18T21:00:01.000Z')); // > 7 days after start
      mockUnlockFindUnique.mockResolvedValue({ unlocked_at: new Date(EVENT_DATE) });

      const result = await verifyStoryPostingPermission('event-1', 'user-1', null, null, null);

      expect(result.allowed).toBe(false);
      expect(result.code).toBe('POSTING_WINDOW_CLOSED');
    });
  });

  // Additive designated-poster marker (owner rule, 2026-07-19 Fanatics Fest):
  // paired with an active EventPostingUnlock row, it lets one user post and
  // upload stories from anywhere for the same capped 7-day grant, without
  // affecting any other user. Contrast exclusive_poster_id, which blocks
  // everyone else.
  describe('additive designated-poster grant', () => {
    const AT_VENUE_LIVE = () => jest.setSystemTime(new Date(EVENT_DATE.getTime() + 30 * 60 * 1000));
    const AFTER_LIVE_WITHIN_GRACE = () =>
      jest.setSystemTime(new Date(EVENT_DATE.getTime() + 7 * 60 * 60 * 1000));
    const LONG_AFTER_CLOSE = () =>
      jest.setSystemTime(new Date(GRACE_END.getTime() + 24 * 60 * 60 * 1000));

    it('allows explicit designated-poster access only while the 7-day unlock is active', async () => {
      AFTER_LIVE_WITHIN_GRACE();
      mockDesignatedFindUnique.mockResolvedValue({ user_id: 'nicon' });
      mockUnlockFindUnique.mockResolvedValue({ unlocked_at: new Date(EVENT_DATE) });

      const result = await verifyEventPostingPermission('event-1', 'nicon', null, null);

      expect(result.allowed).toBe(true);
      expect(mockDesignatedFindUnique).toHaveBeenCalledWith({
        where: { event_id_user_id: { event_id: 'event-1', user_id: 'nicon' } },
        select: { user_id: true },
      });
    });

    it('does not let a designated-poster row become permanent access by itself', async () => {
      AFTER_LIVE_WITHIN_GRACE();
      mockDesignatedFindUnique.mockResolvedValue({ user_id: 'nicon' });
      mockUnlockFindUnique.mockResolvedValue(null);

      const result = await verifyEventPostingPermission('event-1', 'nicon', null, null);

      expect(result.allowed).toBe(false);
      expect(result.code).toBe('POSTING_WINDOW_CLOSED');
    });

    it('allows designated-poster story uploads during the active 7-day grant', async () => {
      AFTER_LIVE_WITHIN_GRACE();
      mockDesignatedFindUnique.mockResolvedValue({ user_id: 'nicon' });
      mockUnlockFindUnique.mockResolvedValue({ unlocked_at: new Date(EVENT_DATE) });

      const result = await verifyStoryPostingPermission('event-1', 'nicon', null, null, null);

      expect(result.allowed).toBe(true);
    });

    it('does not block other attendees during the live window', async () => {
      AT_VENUE_LIVE();
      mockDesignatedFindUnique.mockResolvedValue(null);

      const result = await verifyStoryPostingPermission(
        'event-1',
        'someone-else',
        VENUE.lat,
        VENUE.lon,
        null
      );

      expect(result.allowed).toBe(true);
    });

    it('does NOT block other users — a normal attendee at the venue during the live window still posts', async () => {
      AT_VENUE_LIVE();
      // The event has a designated poster (nicon), but this is a different user
      // standing at the venue. Additive means they follow the normal rules.
      mockDesignatedFindUnique.mockResolvedValue(null); // this user is not on the list

      const result = await verifyEventPostingPermission(
        'event-1',
        'someone-else',
        VENUE.lat,
        VENUE.lon
      );

      expect(result.allowed).toBe(true);
    });

    it('a non-designated user is still blocked far from a closed event', async () => {
      LONG_AFTER_CLOSE();
      mockDesignatedFindUnique.mockResolvedValue(null);

      const result = await verifyEventPostingPermission(
        'event-1',
        'random',
        FAR_AWAY.lat,
        FAR_AWAY.lon
      );

      expect(result.allowed).toBe(false);
      expect(result.code).toBe('POSTING_WINDOW_CLOSED');
    });
  });
});
