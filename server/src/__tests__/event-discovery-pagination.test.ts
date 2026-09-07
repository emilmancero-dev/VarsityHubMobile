import { describe, expect, it, jest } from '@jest/globals';
import { listEventDiscoveryItems } from '../lib/eventDiscovery.js';
import { decodeDiscoveryCursor, encodeDiscoveryCursor } from '../lib/discoveryCursor.js';

const now = new Date('2026-09-06T12:00:00Z');
const date = new Date('2026-09-07T20:00:00Z');
function game(id: string, sport = 'baseball') {
  return {
    id,
    title: id,
    date,
    latitude: 40,
    longitude: -74,
    home_team_id: 'public-team',
    homeTeam: { sport },
    events: [],
  };
}
function database(rows: any[]) {
  return {
    game: {
      findMany: jest.fn(async (args: any) => {
        const after = args.where.AND?.[1]?.OR?.[1]?.id?.gt;
        const window = args.where.date ?? args.where.AND[0].date;
        return rows
          .filter(
            row => (!after || row.id > after) && row.date >= window.gte && row.date <= window.lte
          )
          .slice(0, args.take);
      }),
    },
    event: { findMany: jest.fn(async () => []) },
  } as any;
}

describe('complete bounded discovery traversal', () => {
  it('reaches matches beyond 300 rejected candidates, including empty intermediate pages', async () => {
    const rows = Array.from({ length: 405 }, (_, i) => game(`g-${String(i).padStart(4, '0')}`));
    rows.push(game('g-9999', 'basketball'));
    const db = database(rows);
    const found: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const result = await listEventDiscoveryItems(db, {
        now,
        surface: 'map',
        sport: 'basketball',
        paginated: true,
        limit: 200,
        cursor,
      });
      found.push(...result.items.map(item => item.id));
      cursor = result.next_cursor ?? null;
      pages++;
      expect(pages).toBeLessThan(10);
    } while (cursor);
    expect(found).toEqual(['g-9999']);
    expect(pages).toBe(5);
    for (const [args] of db.game.findMany.mock.calls) expect(args.take).toBeLessThanOrEqual(101);
  });

  it('uses three days for the Live map and fourteen for feed, excluding missing-coordinate pins', async () => {
    const db = database([
      game('a', 'football'),
      { ...game('b'), latitude: null },
      { ...game('c'), date: new Date('2026-09-09T12:00:00Z') },
      { ...game('d'), date: new Date('2026-09-09T12:00:00.001Z') },
    ]);
    const feed = await listEventDiscoveryItems(db, { now, surface: 'feed', paginated: true });
    const map = await listEventDiscoveryItems(db, { now, surface: 'map', paginated: true });
    expect(feed.items.map(item => item.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(map.items.map(item => item.id)).toEqual(['a', 'c']);
    expect(map.meta.to).toBe('2026-09-09T12:00:00.000Z');
    expect(feed.meta.to).toBe('2026-09-20T12:00:00.000Z');
    const calendar = await listEventDiscoveryItems(db, {
      now,
      surface: 'map',
      paginated: true,
      from: new Date('2026-09-09T00:00:00Z'),
      to: new Date('2026-09-09T23:59:59.999Z'),
    });
    expect(calendar.items.map(item => item.id)).toEqual(['c', 'd']);
  });

  it('anchors the window across pages and rejects a different viewer or filter', async () => {
    const db = database(Array.from({ length: 6 }, (_, i) => game(`g-${i}`)));
    const first = await listEventDiscoveryItems(db, {
      now,
      surface: 'map',
      paginated: true,
      limit: 4,
      viewerId: null,
    });
    const next = await listEventDiscoveryItems(db, {
      now: new Date(now.getTime() + 60000),
      surface: 'map',
      paginated: true,
      limit: 4,
      cursor: first.next_cursor,
    });
    expect(next.meta.from).toBe(first.meta.from);
    expect(next.items.map(item => item.id)).toEqual(['g-2', 'g-3']);
    await expect(
      listEventDiscoveryItems(db, {
        now,
        surface: 'map',
        paginated: true,
        cursor: first.next_cursor,
        sport: 'football',
      })
    ).rejects.toThrow('cursor');
    await expect(
      listEventDiscoveryItems(db, {
        now,
        surface: 'map',
        paginated: true,
        cursor: first.next_cursor,
        viewerId: 'another',
      })
    ).rejects.toThrow('cursor');
  });

  it('does not expose private candidate IDs or accept a tampered/expired continuation', () => {
    const token = encodeDiscoveryCursor({
      version: 1,
      anchor: now.toISOString(),
      fingerprint: 'viewer',
      games: { id: 'private-id', date: date.toISOString() },
      events: null,
    });
    expect(Buffer.from(token, 'base64url').toString()).not.toContain('private-id');
    expect(() =>
      decodeDiscoveryCursor(`${token.slice(0, 20)}A${token.slice(21)}`, 'viewer', now)
    ).toThrow();
    expect(() =>
      decodeDiscoveryCursor(token, 'viewer', new Date(now.getTime() + 16 * 60000))
    ).toThrow();
  });

  it('keeps Other explicit and emits linked-game league metadata', async () => {
    const ncaa = {
      ...game('ncaa', ''),
      homeTeam: null,
      events: [
        {
          date,
          sportsLeague: {
            slug: 'ncaaf',
            name: 'NCAA football',
            sport_slug: 'football',
            level: 'college',
          },
        },
      ],
    };
    const db = database([game('community'), ncaa]);
    const college = await listEventDiscoveryItems(db, {
      now,
      paginated: true,
      level: 'college',
      sport: 'football',
    });
    expect(college.items).toHaveLength(1);
    expect(college.items[0]).toMatchObject({ id: 'ncaa', league_slug: 'ncaaf', sport: 'football' });
    const other = await listEventDiscoveryItems(db, { now, paginated: true, level: 'other' });
    expect(other.items.map(item => item.id)).toEqual(['community']);
  });
});
