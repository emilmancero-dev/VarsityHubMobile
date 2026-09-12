/**
 * Event posting permissions — exclusive-poster lock (owner one-off feature,
 * 2026-07-14): when an event designates a single poster via exclusive_poster_id,
 * ONLY that user may post; everyone else is blocked outright, and the
 * designated poster bypasses the window/geofence.
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockEventFindUnique = jest.fn();
const mockGameFindUnique = jest.fn();
const mockDesignatedFindUnique = jest.fn();

jest.unstable_mockModule('../lib/prisma.js', () => ({
  prisma: {
    event: { findUnique: mockEventFindUnique },
    game: { findUnique: mockGameFindUnique },
    eventDesignatedPoster: { findUnique: mockDesignatedFindUnique },
  },
}));

const { verifyEventPostingPermission, verifyStoryPostingPermission } =
  await import('../lib/geofencing.js');

const baseEvent = (over: Record<string, unknown>) => ({
  id: 'ev1',
  title: 'Match',
  date: new Date(),
  latitude: 40,
  longitude: -74,
  location: 'Stadium',
  game_id: null,
  exclusive_poster_id: null,
  ...over,
});

describe('verifyEventPostingPermission — exclusive poster lock', () => {
  beforeEach(() => {
    mockEventFindUnique.mockReset();
    mockGameFindUnique.mockReset();
    mockDesignatedFindUnique.mockReset();
    mockDesignatedFindUnique.mockResolvedValue(null); // no additive grant by default
  });
  afterEach(() => jest.restoreAllMocks());

  it('allows the designated exclusive poster, bypassing window + geofence (no coords, past date)', async () => {
    mockEventFindUnique.mockResolvedValue(
      baseEvent({
        exclusive_poster_id: 'nico',
        date: new Date('2020-01-01'),
        latitude: null,
        longitude: null,
      })
    );
    const res = await verifyEventPostingPermission('ev1', 'nico', null, null);
    expect(res.allowed).toBe(true);
  });

  it('blocks a NON-designated user with EXCLUSIVE_POSTER_ONLY, even standing at the venue during the live window', async () => {
    mockEventFindUnique.mockResolvedValue(baseEvent({ exclusive_poster_id: 'nico' }));
    const res = await verifyEventPostingPermission('ev1', 'someone-else', 40, -74);
    expect(res.allowed).toBe(false);
    expect(res.code).toBe('EXCLUSIVE_POSTER_ONLY');
  });

  it('falls through to normal posting logic when no exclusive poster is set', async () => {
    // No exclusive lock + long-past event => normal window logic closes it.
    mockEventFindUnique.mockResolvedValue(
      baseEvent({ exclusive_poster_id: null, date: new Date('2020-01-01') })
    );
    const res = await verifyEventPostingPermission('ev1', 'anyone', 40, -74);
    expect(res.allowed).toBe(false);
    expect(res.code).not.toBe('EXCLUSIVE_POSTER_ONLY');
  });
});

describe('verifyStoryPostingPermission — exclusive poster lock', () => {
  beforeEach(() => {
    mockEventFindUnique.mockReset();
    mockGameFindUnique.mockReset();
    mockDesignatedFindUnique.mockReset();
    mockDesignatedFindUnique.mockResolvedValue(null);
  });
  afterEach(() => jest.restoreAllMocks());

  it('allows the designated exclusive poster to add a story outside the live window', async () => {
    mockEventFindUnique.mockResolvedValue(
      baseEvent({
        exclusive_poster_id: 'nico',
        date: new Date('2020-01-01'),
        latitude: null,
        longitude: null,
      })
    );

    const res = await verifyStoryPostingPermission('ev1', 'nico', null, null);

    expect(res.allowed).toBe(true);
  });

  it('blocks non-designated users from adding stories to an exclusive event', async () => {
    mockEventFindUnique.mockResolvedValue(baseEvent({ exclusive_poster_id: 'nico' }));

    const res = await verifyStoryPostingPermission('ev1', 'someone-else', 40, -74);

    expect(res.allowed).toBe(false);
    expect(res.code).toBe('EXCLUSIVE_POSTER_ONLY');
  });
});
