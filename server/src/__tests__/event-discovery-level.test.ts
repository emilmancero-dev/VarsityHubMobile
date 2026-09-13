import { describe, expect, it, jest } from '@jest/globals';
import { listEventDiscoveryItems } from '../lib/eventDiscovery.js';

const now = new Date('2026-09-10T12:00:00Z');
describe('league filters precede discovery limits', () => {
  it('scopes both queries and exposes linked-game league metadata', async () => {
    const db: any = {
      game: {
        findMany: jest.fn(async () => [
          {
            id: 'minor-game',
            title: 'Minor game',
            date: new Date(+now + 3600000),
            latitude: 40,
            longitude: -73,
            events: [
              {
                id: 'linked',
                date: new Date(+now + 3600000),
                sportsLeague: {
                  slug: 'milb_aaa',
                  name: 'Triple-A',
                  level: 'minor',
                  sport_slug: 'baseball',
                },
              },
            ],
          },
        ]),
      },
      event: { findMany: jest.fn(async () => []) },
    };
    const result = await listEventDiscoveryItems(db, {
      surface: 'map',
      level: 'minor',
      limit: 1,
      now,
    });
    expect(db.event.findMany.mock.calls[0][0].where).toMatchObject({
      sportsLeague: { is: { level: 'minor' } },
    });
    expect(JSON.stringify(db.game.findMany.mock.calls[0][0].where)).toContain('"level":"minor"');
    expect(result.items[0]).toMatchObject({
      id: 'minor-game',
      league_level: 'minor',
      sport: 'baseball',
    });
  });
  it('includes uncatalogued events in Other without mixing in major, minor or college', async () => {
    const db: any = {
      game: { findMany: jest.fn(async () => []) },
      event: { findMany: jest.fn(async () => []) },
    };
    await listEventDiscoveryItems(db, { level: 'other', now });
    expect(JSON.stringify(db.event.findMany.mock.calls[0][0].where)).toContain(
      '"notIn":["major","minor","college"]'
    );
    expect(JSON.stringify(db.event.findMany.mock.calls[0][0].where)).toContain('"is":null');
  });
});
