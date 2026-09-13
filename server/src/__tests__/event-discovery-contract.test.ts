import { describe, expect, it, jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { listEventDiscoveryItems } from '../lib/eventDiscovery.js';

describe('event discovery contract', () => {
  it('returns game-backed and event-only fixtures through one payload', async () => {
    const now = new Date('2026-08-31T12:00:00.000Z');
    const db: any = {
      game: {
        findMany: jest.fn(async () => [
          {
            id: 'game-1',
            title: 'Varsity Final',
            date: new Date('2026-08-31T20:00:00.000Z'),
            location: 'Main Field',
            latitude: 40,
            longitude: -73,
            banner_url: null,
            cover_image_url: null,
            events: [
              {
                id: 'event-linked',
                date: new Date('2026-08-31T20:00:00.000Z'),
                location: 'Main Field',
                banner_url: null,
                game_id: 'game-1',
                exclusive_poster_id: null,
                live_window_hours_after_start: 4,
                proHomeTeam: null,
                proAwayTeam: null,
              },
            ],
            homeTeam: { sport: 'football' },
            awayTeam: null,
          },
        ]),
      },
      event: {
        findMany: jest.fn(async () => [
          {
            id: 'event-only',
            title: 'NCAA Fixture',
            date: new Date('2026-09-01T00:00:00.000Z'),
            location: 'Arena',
            latitude: 41,
            longitude: -74,
            banner_url: null,
            status: 'published',
            game_id: null,
            exclusive_poster_id: null,
            live_window_hours_after_start: 12,
            team: null,
            proHomeTeam: { league: 'ncaamb', primary_color: '#123456' },
            proAwayTeam: null,
          },
        ]),
      },
      eventDesignatedPoster: { findMany: jest.fn(async () => []) },
      eventPostingUnlock: { findMany: jest.fn(async () => []) },
    };

    const result = await listEventDiscoveryItems(db, {
      surface: 'map',
      now,
      viewerId: 'viewer-1',
    });

    expect(result.items.map(item => `${item.source_type}:${item.id}`)).toEqual([
      'game:game-1',
      'event:event-only',
    ]);
    // The map surface projects each card down to a lean marker (only what the
    // client map renders). Marker fields survive...
    expect(result.items[0]).toMatchObject({
      source_type: 'game',
      event_id: 'event-linked',
      game_id: 'game-1',
    });
    expect(result.items[1]).toMatchObject({
      source_type: 'event',
      event_id: 'event-only',
      game_id: null,
      sport: 'basketball',
    });
    // ...and the heavy card-only fields are stripped, so a pin is not a ~1KB card.
    const MARKER_KEYS = new Set([
      'id',
      'source_type',
      'event_id',
      'game_id',
      'has_posts',
      'title',
      'date',
      'location',
      'latitude',
      'longitude',
      'sport',
      'league_slug',
      'league_name',
      'league_level',
      'league_gender',
      'pro_home_color',
      'pro_away_color',
      'upload_access',
    ]);
    for (const item of result.items) {
      for (const key of Object.keys(item)) {
        expect(MARKER_KEYS.has(key)).toBe(true);
      }
      expect(item).not.toHaveProperty('map_visibility');
      expect(item).not.toHaveProperty('posting_capabilities');
      expect(item).not.toHaveProperty('live_window');
      expect(item).not.toHaveProperty('banner_url');
      expect(item).not.toHaveProperty('feed_priority');
    }
  });

  it('enforces the map discovery window server-side by default', async () => {
    const now = new Date('2026-08-31T12:00:00.000Z');
    const db: any = {
      game: { findMany: jest.fn(async () => []) },
      event: { findMany: jest.fn(async () => []) },
      eventDesignatedPoster: { findMany: jest.fn(async () => []) },
      eventPostingUnlock: { findMany: jest.fn(async () => []) },
    };

    await listEventDiscoveryItems(db, { surface: 'map', now });

    // The DB fetch floor is widened 24h back of `now` (MAP_LIVE_LOOKBACK_MS) so an
    // already-started-but-still-live fixture (e.g. an NFL game mid-broadcast)
    // isn't excluded before the precise per-item live-window filter runs. This is
    // a fetch-only safety margin, not the visibility gate — see the "still shows
    // an in-progress game" / "still hides a long-finished game" tests below for
    // the actual gate.
    expect(db.game.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          date: {
            gte: new Date('2026-08-30T12:00:00.000Z'),
            lte: new Date('2026-09-05T12:00:00.000Z'),
          },
        }),
      })
    );
    expect(db.event.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          game_id: null,
          date: {
            gte: new Date('2026-08-30T12:00:00.000Z'),
            lte: new Date('2026-09-05T12:00:00.000Z'),
          },
        }),
      })
    );
  });

  it('still shows an in-progress game on the default live map (kickoff already passed, live window has not ended)', async () => {
    const now = new Date('2026-09-13T19:30:00.000Z');
    const kickoff = new Date('2026-09-13T17:00:00.000Z'); // started 2.5h ago
    const db: any = {
      game: {
        findMany: jest.fn(async () => [
          {
            id: 'game-live',
            title: 'Bills at Texans',
            date: kickoff,
            location: 'NRG Stadium',
            latitude: 29.6847,
            longitude: -95.4107,
            banner_url: null,
            cover_image_url: null,
            events: [
              {
                id: 'event-live',
                date: kickoff,
                location: 'NRG Stadium',
                banner_url: null,
                game_id: 'game-live',
                exclusive_poster_id: null,
                live_window_hours_after_start: 3,
                proHomeTeam: null,
                proAwayTeam: null,
              },
            ],
            homeTeam: { sport: 'football' },
            awayTeam: null,
          },
        ]),
      },
      event: { findMany: jest.fn(async () => []) },
      eventDesignatedPoster: { findMany: jest.fn(async () => []) },
      eventPostingUnlock: { findMany: jest.fn(async () => []) },
    };

    const result = await listEventDiscoveryItems(db, { surface: 'map', now });

    expect(result.items.map(item => item.id)).toContain('game-live');
  });

  it('still hides a long-finished game with no posts from the default live map', async () => {
    const now = new Date('2026-09-13T19:30:00.000Z');
    const kickoff = new Date('2026-09-13T09:00:00.000Z'); // started 10.5h ago, 3h window long over
    const db: any = {
      game: {
        findMany: jest.fn(async () => [
          {
            id: 'game-finished',
            title: 'Early Kickoff at Somewhere',
            date: kickoff,
            location: 'Old Stadium',
            latitude: 29.6847,
            longitude: -95.4107,
            banner_url: null,
            cover_image_url: null,
            events: [
              {
                id: 'event-finished',
                date: kickoff,
                location: 'Old Stadium',
                banner_url: null,
                game_id: 'game-finished',
                exclusive_poster_id: null,
                live_window_hours_after_start: 3,
                proHomeTeam: null,
                proAwayTeam: null,
              },
            ],
            homeTeam: { sport: 'football' },
            awayTeam: null,
          },
        ]),
      },
      event: { findMany: jest.fn(async () => []) },
      eventDesignatedPoster: { findMany: jest.fn(async () => []) },
      eventPostingUnlock: { findMany: jest.fn(async () => []) },
    };

    const result = await listEventDiscoveryItems(db, { surface: 'map', now });

    expect(result.items.map(item => item.id)).not.toContain('game-finished');
  });

  it('caps the map window to the five-day range even when the pick is in the past', async () => {
    const now = new Date('2026-08-31T12:00:00.000Z');
    const db: any = {
      game: { findMany: jest.fn(async () => []) },
      event: { findMany: jest.fn(async () => []) },
      eventDesignatedPoster: { findMany: jest.fn(async () => []) },
      eventPostingUnlock: { findMany: jest.fn(async () => []) },
    };

    // The date-picker can now reach arbitrarily far into the past, so the past floor
    // is gone — but a single request still can't span more than the 5-day policy: an
    // over-wide window keeps the first five days from the requested start.
    await listEventDiscoveryItems(db, {
      surface: 'map',
      now,
      from: new Date('2026-08-01T00:00:00.000Z'),
      to: new Date('2026-12-31T00:00:00.000Z'),
    });

    expect(db.game.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          date: {
            gte: new Date('2026-08-01T00:00:00.000Z'),
            lte: new Date('2026-08-06T00:00:00.000Z'),
          },
        }),
      })
    );
  });

  it('still clamps the map forward edge to +5 days', async () => {
    const now = new Date('2026-08-31T12:00:00.000Z');
    const db: any = {
      game: { findMany: jest.fn(async () => []) },
      event: { findMany: jest.fn(async () => []) },
      eventDesignatedPoster: { findMany: jest.fn(async () => []) },
      eventPostingUnlock: { findMany: jest.fn(async () => []) },
    };

    await listEventDiscoveryItems(db, {
      surface: 'map',
      now,
      from: now,
      to: new Date('2026-12-31T00:00:00.000Z'),
    });

    expect(db.game.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          date: { gte: now, lte: new Date('2026-09-05T12:00:00.000Z') },
        }),
      })
    );
  });

  it('default map surface requires viewer-visible posts before surfacing past pages', async () => {
    const now = new Date('2026-08-31T12:00:00.000Z');
    const db: any = {
      game: { findMany: jest.fn(async () => []) },
      event: { findMany: jest.fn(async () => []) },
      eventDesignatedPoster: { findMany: jest.fn(async () => []) },
      eventPostingUnlock: { findMany: jest.fn(async () => []) },
    };

    await listEventDiscoveryItems(db, {
      surface: 'map',
      now,
    });

    // Default map loads avoid stale empty event-only pins. Upcoming/today events
    // are always shown; past event-only pages need media.
    expect(db.event.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ date: { gte: now } }, { posts: { some: { id: { in: [] } } } }],
        }),
      })
    );
  });

  it('explicit past-date map surface hides empty event pages', async () => {
    const now = new Date('2026-09-02T19:30:00.000Z');
    const eventDate = new Date('2026-08-29T17:05:00.000Z');
    const db: any = {
      game: { findMany: jest.fn(async () => []) },
      event: {
        findMany: jest.fn(async () => [
          {
            id: 'yankees-event',
            title: 'Red Sox at Yankees',
            date: eventDate,
            location: 'Yankee Stadium, Bronx, New York',
            latitude: 40.8296,
            longitude: -73.9262,
            banner_url: null,
            status: 'approved',
            game_id: null,
            exclusive_poster_id: null,
            live_window_hours_after_start: 4,
            team_id: null,
            team: null,
            proHomeTeam: { league: 'mlb', primary_color: '#0c2340' },
            proAwayTeam: null,
          },
        ]),
      },
      eventDesignatedPoster: { findMany: jest.fn(async () => []) },
      eventPostingUnlock: { findMany: jest.fn(async () => []) },
    };

    const result = await listEventDiscoveryItems(db, {
      surface: 'map',
      now,
      from: new Date('2026-08-29T00:00:00.000Z'),
      to: new Date('2026-08-29T23:59:59.999Z'),
    });

    expect(db.event.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ date: { gte: now } }, { posts: { some: { id: { in: [] } } } }],
        }),
      })
    );
    expect(result.items).toEqual([]);
  });

  it('keeps standalone sports-league events in sport-filtered discovery', async () => {
    const now = new Date('2026-09-02T20:30:00.000Z');
    const db: any = {
      game: { findMany: jest.fn(async () => []) },
      event: {
        findMany: jest.fn(async () => [
          {
            id: 'atp-event',
            title: 'Player One - Player Two',
            date: new Date('2026-09-02T21:00:00.000Z'),
            location: 'USTA Billie Jean King National Tennis Center',
            latitude: 40.7499,
            longitude: -73.8476,
            banner_url: null,
            status: 'approved',
            game_id: null,
            exclusive_poster_id: null,
            live_window_hours_after_start: 4,
            sports_league_id: 'sports_league_atp',
            team: null,
            sportsLeague: {
              id: 'sports_league_atp',
              slug: 'atp',
              name: 'ATP Tour',
              sport_slug: 'tennis',
              level: 'major',
              gender: 'men',
            },
            proHomeTeam: null,
            proAwayTeam: null,
          },
        ]),
      },
      eventDesignatedPoster: { findMany: jest.fn(async () => []) },
      eventPostingUnlock: { findMany: jest.fn(async () => []) },
    };

    const result = await listEventDiscoveryItems(db, {
      surface: 'map',
      sport: 'tennis',
      now,
      viewerId: null,
    });

    expect(db.event.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          sportsLeague: expect.objectContaining({
            select: expect.objectContaining({ sport_slug: true }),
          }),
        }),
      })
    );
    // Lean map marker: league metadata the client filter needs survives the
    // projection; the card-only sports_league_id / map_visibility do not.
    expect(result.items).toEqual([
      expect.objectContaining({
        id: 'atp-event',
        sport: 'tennis',
        league_slug: 'atp',
        league_name: 'ATP Tour',
      }),
    ]);
    expect(result.items[0]).not.toHaveProperty('sports_league_id');
    expect(result.items[0]).not.toHaveProperty('map_visibility');
  });

  it('does not report designated-poster upload access after the 7-day unlock expires', async () => {
    const now = new Date('2026-09-10T12:00:00.000Z');
    const eventDate = new Date('2026-09-01T00:00:00.000Z');
    const db: any = {
      game: { findMany: jest.fn(async () => []) },
      event: {
        findMany: jest.fn(async () => [
          {
            id: 'event-only',
            title: 'Expired Grant',
            date: eventDate,
            location: 'Arena',
            latitude: 41,
            longitude: -74,
            banner_url: null,
            status: 'published',
            game_id: null,
            exclusive_poster_id: null,
            live_window_hours_after_start: 4,
            team: null,
            proHomeTeam: null,
            proAwayTeam: null,
          },
        ]),
      },
      eventDesignatedPoster: { findMany: jest.fn(async () => [{ event_id: 'event-only' }]) },
      eventPostingUnlock: {
        findMany: jest.fn(async () => [{ event_id: 'event-only', unlocked_at: eventDate }]),
      },
    };

    const result = await listEventDiscoveryItems(db, {
      surface: 'feed',
      now,
      viewerId: 'viewer-1',
      from: new Date('2026-08-31T00:00:00.000Z'),
      to: new Date('2026-09-14T00:00:00.000Z'),
    });

    expect(result.items[0].posting_capabilities.designated_poster).toBe(true);
    expect(result.items[0].posting_capabilities.post.allowed_now).toBe(false);
    expect(result.items[0].posting_capabilities.story.allowed_now).toBe(false);
    expect(result.items[0].upload_access.can_upload_post).toBe(false);
    expect(result.items[0].upload_access.can_upload_story).toBe(false);
  });

  it('filters private-team fixtures from public discovery', async () => {
    const now = new Date('2026-08-31T12:00:00.000Z');
    const db: any = {
      game: {
        findMany: jest.fn(async () => [
          {
            id: 'private-game',
            title: 'Private Team Game',
            date: new Date('2026-09-01T20:00:00.000Z'),
            location: 'Private Field',
            latitude: 40,
            longitude: -73,
            home_team_id: 'private-team',
            away_team_id: null,
            banner_url: null,
            cover_image_url: null,
            events: [],
            homeTeam: { sport: 'football' },
            awayTeam: null,
          },
          {
            id: 'public-game',
            title: 'Public Team Game',
            date: new Date('2026-09-01T21:00:00.000Z'),
            location: 'Public Field',
            latitude: 41,
            longitude: -74,
            home_team_id: 'public-team',
            away_team_id: null,
            banner_url: null,
            cover_image_url: null,
            events: [],
            homeTeam: { sport: 'football' },
            awayTeam: null,
          },
        ]),
      },
      event: {
        findMany: jest.fn(async () => [
          {
            id: 'private-event',
            title: 'Private Event',
            date: new Date('2026-09-02T20:00:00.000Z'),
            location: 'Private Field',
            latitude: 42,
            longitude: -75,
            team_id: 'private-team',
            banner_url: null,
            status: 'published',
            game_id: null,
            exclusive_poster_id: null,
            live_window_hours_after_start: 4,
            team: { sport: 'football' },
            proHomeTeam: null,
            proAwayTeam: null,
          },
        ]),
      },
      team: {
        findMany: jest.fn(async () => [{ id: 'private-team', organization_id: 'org-1' }]),
      },
      eventDesignatedPoster: { findMany: jest.fn(async () => []) },
      eventPostingUnlock: { findMany: jest.fn(async () => []) },
    };

    const result = await listEventDiscoveryItems(db, {
      surface: 'map',
      now,
      viewerId: null,
    });

    expect(result.items.map(item => item.id)).toEqual(['public-game']);
    expect(result.meta.filtered.private_team_items).toBe(2);
    expect(db.team.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ['private-team', 'public-team'] },
        }),
        take: 2,
      })
    );
  });

  it('allows a private-team fixture when the viewer follows that team', async () => {
    const now = new Date('2026-08-31T12:00:00.000Z');
    const db: any = {
      game: {
        findMany: jest.fn(async () => [
          {
            id: 'private-game',
            title: 'Private Team Game',
            date: new Date('2026-09-01T20:00:00.000Z'),
            location: 'Private Field',
            latitude: 40,
            longitude: -73,
            home_team_id: 'private-team',
            away_team_id: null,
            banner_url: null,
            cover_image_url: null,
            events: [],
            homeTeam: { sport: 'football' },
            awayTeam: null,
          },
        ]),
      },
      event: { findMany: jest.fn(async () => []) },
      team: {
        findMany: jest.fn(async () => [{ id: 'private-team', organization_id: 'org-1' }]),
      },
      teamFollow: { findMany: jest.fn(async () => [{ team_id: 'private-team' }]) },
      teamMembership: { findMany: jest.fn(async () => []) },
      organizationMembership: { findMany: jest.fn(async () => []) },
      eventDesignatedPoster: { findMany: jest.fn(async () => []) },
      eventPostingUnlock: { findMany: jest.fn(async () => []) },
    };

    const result = await listEventDiscoveryItems(db, {
      surface: 'map',
      now,
      viewerId: 'viewer-1',
    });

    expect(result.items.map(item => item.id)).toEqual(['private-game']);
  });

  it('does not scan private teams when the current discovery window has no team candidates', async () => {
    const now = new Date('2026-08-31T12:00:00.000Z');
    const db: any = {
      game: { findMany: jest.fn(async () => []) },
      event: {
        findMany: jest.fn(async () => [
          {
            id: 'pro-event',
            title: 'Pro Fixture',
            date: new Date('2026-09-02T20:00:00.000Z'),
            location: 'Arena',
            latitude: 42,
            longitude: -75,
            team_id: null,
            banner_url: null,
            status: 'published',
            game_id: null,
            exclusive_poster_id: null,
            live_window_hours_after_start: 4,
            team: null,
            proHomeTeam: { league: 'ncaamb', primary_color: '#123456' },
            proAwayTeam: null,
          },
        ]),
      },
      team: {
        findMany: jest.fn(async () => {
          throw new Error('team privacy scan should not run without candidate ids');
        }),
      },
      eventDesignatedPoster: { findMany: jest.fn(async () => []) },
      eventPostingUnlock: { findMany: jest.fn(async () => []) },
    };

    const result = await listEventDiscoveryItems(db, {
      surface: 'map',
      now,
      viewerId: null,
    });

    expect(result.items.map(item => item.id)).toEqual(['pro-event']);
    expect(db.team.findMany).not.toHaveBeenCalled();
  });

  it('is mounted in both production and test app route bundles', () => {
    expect(readFileSync(join(process.cwd(), 'src', 'app.ts'), 'utf8')).toMatch(
      /parent\.use\('\/event-discovery', eventDiscoveryRouter\)/
    );
    expect(readFileSync(join(process.cwd(), 'src', 'testApp.ts'), 'utf8')).toMatch(
      /parent\.use\('\/event-discovery', eventDiscoveryRouter\)/
    );
  });
});
