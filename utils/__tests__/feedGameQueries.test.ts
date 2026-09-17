import {
  buildFeedGameQueries,
  mergeFeedGames,
  FEED_PAST_WINDOW_MS,
  FEED_LIVE_LOOKBACK_MS,
  FEED_UPCOMING_WINDOW_MS,
} from '@/utils/feedGameQueries';

describe('buildFeedGameQueries', () => {
  const now = new Date('2026-07-12T20:00:00.000Z').getTime();

  it('reuses the same query boundaries within a freshness window', () => {
    expect(buildFeedGameQueries(now + 1)).toEqual(buildFeedGameQueries(now + 29_999));
    expect(buildFeedGameQueries(now + 30_000)).not.toEqual(buildFeedGameQueries(now));
  });

  it('anchors the upcoming query at now minus the live window so in-progress games stay in the rail', () => {
    const q = buildFeedGameQueries(now);
    expect(q.upcoming.sort).toBe('date');
    expect(q.upcoming.options.dateFrom).toBe(new Date(now - FEED_LIVE_LOOKBACK_MS).toISOString());
    expect(q.upcoming.options.dateTo).toBe(new Date(now + FEED_UPCOMING_WINDOW_MS).toISOString());
    expect(q.upcoming.options.limit).toBe(30);
  });

  // Asserted against a real date, not the constant: the feed's upcoming rail must
  // end at the SAME +14-day horizon the map enforces server-side (games.ts
  // map_view), or the two drift back out of sync. now = 2026-07-12T20:00Z, so the
  // window must close on 2026-07-26T20:00Z.
  it('caps the upcoming rail at a rolling two-week horizon so it matches the map window', () => {
    const q = buildFeedGameQueries(now);
    expect(q.upcoming.options.dateTo).toBe('2026-07-26T20:00:00.000Z');
    expect(q.marquee.options.dateTo).toBe('2026-07-26T20:00:00.000Z');
  });

  it('bounds the past recap query to the past window ending now, newest first', () => {
    const q = buildFeedGameQueries(now);
    expect(q.past.sort).toBe('-date');
    expect(q.past.options.dateFrom).toBe(new Date(now - FEED_PAST_WINDOW_MS).toISOString());
    expect(q.past.options.dateTo).toBe(new Date(now).toISOString());
    expect(q.past.options.limit).toBe(30);
  });

  // Asserted against a real date rather than the constant: a test that derives
  // its expectation FROM the constant passes no matter what the constant is, so
  // it cannot catch a regression of the thing we actually care about.
  it('still reaches Day 1 of a four-day festival from its final day', () => {
    // Fanatics Fest: Day 1 Thu Jul 16 1pm EDT, Day 4 Sun Jul 19. A fan opening
    // the feed on the last day must still be able to look back at Day 1 — at a
    // 3-day window it had already dropped out.
    const day1Start = new Date('2026-07-16T17:00:00.000Z').getTime();
    const day4Evening = new Date('2026-07-19T21:00:00.000Z').getTime();

    const q = buildFeedGameQueries(day4Evening);
    const reachesBackTo = new Date(q.past.options.dateFrom).getTime();

    expect(reachesBackTo).toBeLessThanOrEqual(day1Start);
  });

  it('makes the marquee query upcoming-only so curated events cannot be crowded out by past games', () => {
    const q = buildFeedGameQueries(now);
    expect(q.marquee.sort).toBe('date');
    expect(q.marquee.options.teamless).toBe(true);
    expect(q.marquee.options.dateFrom).toBe(new Date(now - FEED_LIVE_LOOKBACK_MS).toISOString());
    expect(q.marquee.options.limit).toBe(10);
  });

  it('threads viewer coords into all three queries so the server selects nearest-first', () => {
    const q = buildFeedGameQueries(now, { lat: 40.71, lng: -74.01 });
    expect(q.upcoming.options.lat).toBe(40.71);
    expect(q.upcoming.options.lng).toBe(-74.01);
    expect(q.past.options.lat).toBe(40.71);
    expect(q.past.options.lng).toBe(-74.01);
    expect(q.marquee.options.lat).toBe(40.71);
    expect(q.marquee.options.lng).toBe(-74.01);
  });

  it('requests a global feed when no coords are passed, bypassing profile-zip proximity', () => {
    const q = buildFeedGameQueries(now);
    expect(q.upcoming.options.lat).toBeUndefined();
    expect(q.upcoming.options.lng).toBeUndefined();
    expect(q.upcoming.options.showAll).toBe(true);
    expect(q.past.options.showAll).toBe(true);
    expect(q.marquee.options.showAll).toBe(true);
  });
});

describe('mergeFeedGames', () => {
  const g = (id: string, date: string | null) => ({ id, date });

  it('keeps upcoming games even when the past page is full (the map-but-not-feed bug)', () => {
    const past = Array.from({ length: 30 }, (_, i) =>
      g(`past-${i}`, `2026-07-1${i % 2}T00:00:00.000Z`)
    );
    const upcoming = [g('up-1', '2026-07-25T00:00:00.000Z'), g('up-2', '2026-08-01T00:00:00.000Z')];
    const merged = mergeFeedGames(past, upcoming, []);
    expect(merged.map(x => x.id)).toEqual(expect.arrayContaining(['up-1', 'up-2']));
    expect(merged).toHaveLength(32);
  });

  it('dedupes by id across pages', () => {
    const merged = mergeFeedGames(
      [g('a', '2026-07-11T00:00:00.000Z')],
      [g('a', '2026-07-11T00:00:00.000Z'), g('b', '2026-07-25T00:00:00.000Z')],
      [g('b', '2026-07-25T00:00:00.000Z')]
    );
    expect(merged.map(x => x.id)).toEqual(['a', 'b']);
  });

  it('sorts ascending by date with dateless games last', () => {
    const merged = mergeFeedGames(
      [g('later', '2026-08-01T00:00:00.000Z')],
      [g('none', null), g('sooner', '2026-07-13T00:00:00.000Z')],
      []
    );
    expect(merged.map(x => x.id)).toEqual(['sooner', 'later', 'none']);
  });
});
