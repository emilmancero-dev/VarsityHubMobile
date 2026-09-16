import { describe, expect, it } from '@jest/globals';

import {
  serializeGameCard,
  serializeEventCard,
  type SerializeCtx,
} from '../lib/eventCardSerializer.js';

const now = new Date('2026-09-01T12:00:00.000Z');
const ctx: SerializeCtx = {
  now,
  from: new Date('2026-09-01T12:00:00.000Z'),
  to: new Date('2026-09-06T12:00:00.000Z'),
  viewerState: {
    viewerId: null,
    designatedEventIds: new Set<string>(),
    unlocks: new Map<string, Date>(),
    now,
  },
};

describe('serializeGameCard', () => {
  const game = {
    id: 'game-1',
    title: 'Varsity Final',
    date: new Date('2026-09-02T20:00:00.000Z'),
    location: 'Main Field',
    latitude: 40,
    longitude: -73,
    banner_url: null,
    cover_image_url: null,
    events: [
      {
        id: 'ev-1',
        date: new Date('2026-09-02T20:00:00.000Z'),
        location: 'Main Field',
        banner_url: null,
        exclusive_poster_id: null,
        live_window_hours_after_start: 4,
        proHomeTeam: null,
        proAwayTeam: null,
      },
    ],
    homeTeam: { sport: 'football', primary_color: '#003594' },
    awayTeam: { sport: 'football', primary_color: '#A71930' },
  };

  it('serializes a game into the canonical card shape', () => {
    const card = serializeGameCard(game, ctx);
    expect(card).toMatchObject({
      id: 'game-1',
      source_type: 'game',
      event_id: 'ev-1',
      game_id: 'game-1',
      title: 'Varsity Final',
      date: '2026-09-02T20:00:00.000Z',
      location: 'Main Field',
      latitude: 40,
      longitude: -73,
      sport: 'football',
      pro_home_color: '#003594',
      pro_away_color: '#A71930',
      status: null,
    });
    expect(card.map_visibility).toMatchObject({ visible: true, reason_code: null });
    expect(card.map_visibility.surface_window).toEqual({
      from: '2026-09-01T12:00:00.000Z',
      to: '2026-09-06T12:00:00.000Z',
    });
    expect(typeof card.feed_priority).toBe('number');
    expect(card.posting_capabilities).toBeDefined();
  });
});

describe('serializeEventCard', () => {
  const baseEvent = {
    id: 'event-only',
    title: 'NCAA Fixture',
    date: new Date('2026-09-03T00:00:00.000Z'),
    location: 'Arena',
    latitude: 41,
    longitude: -74,
    banner_url: null,
    status: 'published',
    exclusive_poster_id: null,
    live_window_hours_after_start: 12,
    team: { sport: 'basketball', primary_color: '#7C3AED' },
    proHomeTeam: null,
    proAwayTeam: null,
  };

  it('serializes a standalone event into the canonical card shape', () => {
    const card = serializeEventCard(baseEvent, ctx);
    expect(card).toMatchObject({
      id: 'event-only',
      source_type: 'event',
      event_id: 'event-only',
      game_id: null,
      title: 'NCAA Fixture',
      date: '2026-09-03T00:00:00.000Z',
      location: 'Arena',
      latitude: 41,
      longitude: -74,
      sport: 'basketball',
      pro_home_color: '#7C3AED',
      status: 'published',
    });
    expect(card.map_visibility.visible).toBe(true);
  });

  it('marks coordinate-less events as not map-visible', () => {
    const card = serializeEventCard(
      { ...baseEvent, latitude: null, longitude: null, location: null },
      ctx
    );
    expect(card.map_visibility).toMatchObject({
      visible: false,
      reason_code: 'NO_COORDINATES',
    });
  });
});
