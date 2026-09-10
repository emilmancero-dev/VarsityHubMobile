import { describe, expect, it } from '@jest/globals';
import { findNearestDatedMatches } from '../lib/searchTemporalRanking.js';

describe('nearest dated search', () => {
  it('queries both sides before limiting, retaining the nearest match despite many future fixtures', async () => {
    const now = new Date('2026-09-10T12:00:00Z');
    const rows = [-1, 2, 3, 4, 100].map(days => ({
      id: String(days),
      date: new Date(+now + days * 86400000),
    }));
    const calls: any[] = [];
    const result = await findNearestDatedMatches(
      async query => {
        calls.push(query);
        return rows
          .filter(row => (query.direction === 'future' ? row.date >= now : row.date < now))
          .sort((a, b) => (query.direction === 'future' ? +a.date - +b.date : +b.date - +a.date))
          .slice(0, query.take);
      },
      2,
      now
    );
    expect(result.map(row => row.id)).toEqual(['-1', '2']);
    expect(calls).toHaveLength(2);
    expect(calls.every(query => query.take === 2)).toBe(true);
  });
  it('prefers upcoming on equal distance and keeps a deterministic order', async () => {
    const now = new Date('2026-09-10T12:00:00Z');
    const result = await findNearestDatedMatches(
      async ({ direction }) =>
        direction === 'future'
          ? [
              { id: 'b', date: new Date(+now + 1000) },
              { id: 'a', date: new Date(+now + 1000) },
            ]
          : [{ id: 'past', date: new Date(+now - 1000) }],
      3,
      now
    );
    expect(result.map(row => row.id)).toEqual(['a', 'b', 'past']);
  });
});
