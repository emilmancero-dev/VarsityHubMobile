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
// Default live window: no early cutoff → +3h after start (owner rule 2026-08-28).
const LIVE_CUTOFF = new Date(EVENT_DATE.getTime() + 3 * 60 * 60 * 1000);
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
    it('allows a geofenced post half a day BEFORE start — no early cutoff (owner rule 2026-08-28)', async () => {
      // The old rule returned before_open and blocked early arrivals. There is
      // no early cutoff anymore: an at-venue post 12h+ before start is allowed
      // and earns the unlock.
      jest.setSystemTime(new Date(EVENT_DATE.getTime() - 12 * 60 * 60 * 1000 - 1));

      const result = await verifyEventPostingPermission('event-1', 'user-1', VENUE.lat, VENUE.lon);

      expect(result.allowed).toBe(true);
      expect(mockUnlockCreateMany).toHaveBeenCalled();
    });

    it('allows a geofenced post on game-day morning, hours BEFORE start', async () => {
      jest.setSystemTime(new Date(EVENT_DATE.getTime() - 8 * 60 * 60 * 1000));

      const result = await verifyEventPostingPermission('event-1', 'user-1', VENUE.lat, VENUE.lon);

      expect(result.allowed).toBe(true);
    });

    it('still enforces the geofence for an early post — far away is blocked before start', async () => {
      // No early time cutoff, but the 3km geofence is still the presence gate.
      jest.setSystemTime(new Date(EVENT_DATE.getTime() - 8 * 60 * 60 * 1000));

      const result = await verifyEventPostingPermission(
        'event-1',
        'user-1',
        FAR_AWAY.lat,
        FAR_AWAY.lon
      );

      expect(result.allowed).toBe(false);
      expect(result.code).toBe('TOO_FAR_FROM_VENUE');
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

    it('closes the default live window 3h after start for first-time posters, even at the venue', async () => {
      jest.setSystemTime(new Date(EVENT_DATE.getTime() + 5 * 60 * 60 * 1000));

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
      expect(mockStoryFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ user_id: 'user-1', game_id: 'game-1' }),
        })
      );
    });

    it('event-only pages (no game) match prior posts by event_id only and never query stories', async () => {
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
      expect(mockStoryFindFirst).not.toHaveBeenCalled();
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

    it('has no early cutoff: an at-venue post a full day before start is allowed', async () => {
      // Regression guard for the removed before_open state — a user who shows up
      // very early is never told "Posting opens <future date>"; they can post.
      jest.setSystemTime(new Date(EVENT_DATE.getTime() - 24 * 60 * 60 * 1000));

      const result = await verifyEventPostingPermission('event-1', 'user-1', VENUE.lat, VENUE.lon);

      expect(result.allowed).toBe(true);
    });
  });

  describe('stories', () => {
    // Owner rule (2026-07-16, Fanatics Fest): stories are LIVE-ONLY and always
    // geofenced. "STORY POST HAVE TO BE STRICTLY FOR WHEN THEY ARE AT THE GEO
    // FENCED LOCATION" / "USERS CANT UPLOAD TO STORIES AFTER THEY HAVE LEFT THE
    // GAME" / "STORY POST, do not get the same 7 days after the fact".
    //
    // This block previously pinned the opposite: a window running from UTC
    // midnight to +48h, and an unlock that let users post stories from
    // anywhere. Both are deliberately reversed here.
    const STORY_TIME = new Date('2026-05-10T19:00:00.000Z'); // 1h into the event

    it('has no early cutoff and closes at the live cutoff — not +48h', () => {
      // No early cutoff (owner rule 2026-08-28): stories are open any time before
      // the event, all the way up to the live cutoff. The only hard bound is +Nh.
      jest.setSystemTime(new Date('2026-05-09T18:00:00.000Z')); // a full day before
      expect(isStoryPostingWindowOpen(EVENT_DATE)).toBe(true);

      jest.setSystemTime(new Date('2026-05-10T06:30:00.000Z')); // game-day morning
      expect(isStoryPostingWindowOpen(EVENT_DATE)).toBe(true);

      jest.setSystemTime(new Date('2026-05-10T17:30:00.000Z')); // 30m before
      expect(isStoryPostingWindowOpen(EVENT_DATE)).toBe(true);

      jest.setSystemTime(STORY_TIME);
      expect(isStoryPostingWindowOpen(EVENT_DATE)).toBe(true);

      jest.setSystemTime(new Date('2026-05-10T21:00:01.000Z')); // past +3h
      expect(isStoryPostingWindowOpen(EVENT_DATE)).toBe(false);

      // The old rule kept this open for two more days.
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

    it('no stories after the live window closes, unlock or not', async () => {
      jest.setSystemTime(new Date('2026-05-10T21:00:01.000Z')); // past +3h
      mockUnlockFindUnique.mockResolvedValue({ unlocked_at: new Date(EVENT_DATE) });

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
  });

  // Additive designated-poster grant (owner rule, 2026-07-19 Fanatics Fest):
  // a user allowlisted for an event may post AND upload stories at any time,
  // from anywhere — bypassing the live window and the venue geofence — WITHOUT
  // affecting any other user. This is the post-event "give a specific person
  // continued access for marketing/continuity" grant. Contrast the single-user
  // exclusive_poster_id lock, which blocks everyone else.
  describe('additive designated-poster grant', () => {
    const AT_VENUE_LIVE = () => jest.setSystemTime(new Date(EVENT_DATE.getTime() + 30 * 60 * 1000));
    const LONG_AFTER_CLOSE = () =>
      jest.setSystemTime(new Date(GRACE_END.getTime() + 24 * 60 * 60 * 1000));

    it('lets a designated poster post from anywhere after the event has fully closed', async () => {
      LONG_AFTER_CLOSE();
      mockDesignatedFindUnique.mockResolvedValue({ user_id: 'nicon' });

      const result = await verifyEventPostingPermission('event-1', 'nicon', null, null);

      expect(result.allowed).toBe(true);
      expect(mockDesignatedFindUnique).toHaveBeenCalledWith({
        where: { event_id_user_id: { event_id: 'event-1', user_id: 'nicon' } },
        select: { user_id: true },
      });
    });

    it('lets a designated poster upload a STORY from anywhere after the event has closed (closes the story gap)', async () => {
      LONG_AFTER_CLOSE();
      mockDesignatedFindUnique.mockResolvedValue({ user_id: 'nicon' });

      const result = await verifyStoryPostingPermission('event-1', 'nicon', null, null, null);

      expect(result.allowed).toBe(true);
    });

    it('does NOT block other users — a normal attendee at the venue during the live window still posts', async () => {
      AT_VENUE_LIVE();
      // The event has a designated poster (nicon), but this is a different user
      // standing at the venue. Additive means they follow the normal rules.
      mockDesignatedFindUnique.mockResolvedValue(null); // this user is not on the list

      const result = await verifyEventPostingPermission('event-1', 'someone-else', VENUE.lat, VENUE.lon);

      expect(result.allowed).toBe(true);
    });

    it('a non-designated user is still blocked far from a closed event', async () => {
      LONG_AFTER_CLOSE();
      mockDesignatedFindUnique.mockResolvedValue(null);

      const result = await verifyEventPostingPermission('event-1', 'random', FAR_AWAY.lat, FAR_AWAY.lon);

      expect(result.allowed).toBe(false);
      expect(result.code).toBe('POSTING_WINDOW_CLOSED');
    });
  });
});
