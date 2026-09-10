import { describe, expect, it, jest } from '@jest/globals';
import { listEventDiscoveryItems } from '../lib/eventDiscovery.js';

const now = new Date('2026-09-10T12:00:00Z');
const fixture = (id: string, posts: number, date = '2026-09-08T12:00:00Z') => ({
  id,
  title: id,
  date: new Date(date),
  latitude: 40,
  longitude: -73,
  _count: { posts },
  events: [],
});

describe('map content visibility', () => {
  it('keeps past game and event pages only with visible posts, including linked event posts', async () => {
    const db: any = {
      game: {
        findMany: jest.fn(async () => [
          fixture('empty-game', 0),
          fixture('posted-game', 1),
          { ...fixture('linked-game', 0), events: [fixture('linked', 1)] },
        ]),
      },
      event: {
        findMany: jest.fn(async () => [fixture('empty-event', 0), fixture('posted-event', 1)]),
      },
    };
    const result = await listEventDiscoveryItems(db, {
      surface: 'map',
      from: new Date('2026-09-08T00:00:00Z'),
      to: new Date('2026-09-09T00:00:00Z'),
      now,
      visiblePostWhere: { deleted_at: null, author_id: { notIn: ['blocked-author'] } },
    });
    expect(result.items.map(item => item.id).sort()).toEqual([
      'linked-game',
      'posted-event',
      'posted-game',
    ]);
    expect(result.items.every(item => item.has_posts)).toBe(true);
    const args = db.game.findMany.mock.calls[0][0];
    expect(args.include._count.select.posts.where.author_id.notIn).toEqual(['blocked-author']);
    expect(args.include.events.include._count.select.posts.where.author_id.notIn).toEqual([
      'blocked-author',
    ]);
    expect(
      db.event.findMany.mock.calls[0][0].include._count.select.posts.where.author_id.notIn
    ).toEqual(['blocked-author']);
  });
  it('does not hide upcoming empty pages or infer content when visibility is unavailable', async () => {
    const db: any = {
      game: { findMany: jest.fn(async () => [fixture('upcoming', 0, '2026-09-11T12:00:00Z')]) },
      event: { findMany: jest.fn(async () => []) },
    };
    const result = await listEventDiscoveryItems(db, { surface: 'map', now });
    expect(result.items.map(item => item.id)).toEqual(['upcoming']);
    expect(result.items[0].has_posts).toBe(false);
    expect(db.game.findMany.mock.calls[0][0].include._count.select.posts.where).toEqual({
      id: { in: [] },
    });
  });
});
