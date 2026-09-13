import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Regression tests for GET /games proximity selection.
 *
 * The feed complaint: users saw the 30 soonest games NATIONWIDE while local
 * games sat on the map — the date-ordered page crowded out nearby games.
 * These tests pin the contract:
 *   - lat/lng in the query -> candidate pool is widened, the `limit` nearest
 *     games are returned (distance ascending), and nextCursor continues the
 *     DATE-ordered scan (not the distance-sorted payload).
 *   - signed-in viewer with no coords but a zip_code preference -> zip is
 *     resolved to coordinates and the same nearest-first selection applies.
 *   - no coords and no zip -> original date-ordered behavior, take = limit+1.
 */

const mockCacheDelPattern = jest.fn(async () => undefined);
const mockCacheGet = jest.fn(async () => null);
const mockCacheSet = jest.fn(async () => undefined);
const mockGameFindMany = jest.fn(async () => [] as any[]);
const mockUserFindUnique = jest.fn(async (): Promise<any> => null);
const mockGetZipCoordinates = jest.fn((): { lat: number; lon: number } | null => null);
const mockGeocodeLocation = jest.fn(async (): Promise<any> => null);

jest.unstable_mockModule('../lib/cache.js', () => ({
  cacheGet: mockCacheGet,
  cacheSet: mockCacheSet,
  cacheDel: jest.fn(async () => undefined),
  cacheDelPattern: mockCacheDelPattern,
}));

jest.unstable_mockModule('../lib/prisma.js', () => ({
  prisma: {
    game: {
      findMany: mockGameFindMany,
      findUnique: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(async () => ({ count: 1 })),
      count: jest.fn(async () => 0),
      delete: jest.fn(),
    },
    event: {
      create: jest.fn(),
      updateMany: jest.fn(async () => ({ count: 1 })),
      findFirst: jest.fn(async () => null),
      update: jest.fn(),
    },
    eventRsvp: {
      groupBy: jest.fn(async () => []),
    },
    teamMembership: {
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
    },
    organizationMembership: {
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
    },
    team: {
      findMany: jest.fn(async () => []),
    },
    teamFollow: {
      findMany: jest.fn(async () => []),
    },
    user: {
      findUnique: mockUserFindUnique,
    },
    post: {
      findMany: jest.fn(async () => []),
    },
  },
}));

jest.unstable_mockModule('../lib/geoUtils.js', () => ({
  getZipCoordinates: mockGetZipCoordinates,
  haversineDistance: jest.fn(() => 0),
}));

jest.unstable_mockModule('../lib/geocoding.js', () => ({
  geocodeLocation: mockGeocodeLocation,
  geocodeGame: jest.fn(async () => null),
  geocodeEvent: jest.fn(async () => null),
  geocodeAllGames: jest.fn(async () => ({})),
  geocodeAllEvents: jest.fn(async () => 0),
  clearGeocodeCache: jest.fn(),
  getCacheStats: jest.fn(() => ({})),
  bulkGeocodeLocations: jest.fn(async () => new Map()),
}));

jest.unstable_mockModule('../middleware/requireVerified.js', () => ({
  requireVerified: (_req: any, _res: any, next: any) => next(),
}));

jest.unstable_mockModule('../middleware/requireOnboarded.js', () => ({
  requireOnboarded: (_req: any, _res: any, next: any) => next(),
}));

jest.unstable_mockModule('../middleware/requireAuth.js', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));

jest.unstable_mockModule('../middleware/requireAdmin.js', () => ({
  requireAdmin: (_req: any, _res: any, next: any) => next(),
  isEmailAdmin: jest.fn(() => false),
  getIsAdmin: jest.fn(async () => false),
  isVerifiedAdminUser: jest.fn(async () => false),
}));

jest.unstable_mockModule('../middleware/rateLimiters.js', () => {
  const pass = (_req: any, _res: any, next: any) => next();
  return {
    gameCreationLimiter: pass,
    storyCreationLimiter: pass,
    voteLimiter: pass,
  };
});

jest.unstable_mockModule('../lib/privacyUtils.js', () => ({
  getExcludedPrivateAuthorIds: jest.fn(async () => []),
  getExcludedPrivateTeamIds: jest.fn(async () => []),
  getBlockedUserIds: jest.fn(async () => []),
  getRequestBlockedCache: jest.fn(() => new Map()),
  getPostVisibilityFilters: jest.fn(async () => ({
    excludedAuthorIds: [],
    excludedTeamIds: [],
    authorWhere: null,
    privateTeamWhere: null,
  })),
  buildPrivateTeamGameVisibilityWhere: jest.fn(() => null),
  buildPrivateTeamEventVisibilityWhere: jest.fn(() => null),
  mergeAndWhere: jest.fn((where: any, clause: any) => {
    if (!clause) return where;
    where.AND = [...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []), clause];
    return where;
  }),
}));

jest.unstable_mockModule('../lib/notifications.js', () => ({
  sendPushNotification: jest.fn(async () => []),
}));

jest.unstable_mockModule('../lib/debugLog.js', () => ({
  debugLog: jest.fn(),
}));

const { gamesRouter } = await import('../routes/games.js');

const app = express();
app.use(express.json());
app.use((req: any, _res, next) => {
  req.user = { id: 'viewer-1' };
  next();
});
app.use('/games', gamesRouter);

const guestApp = express();
guestApp.use(express.json());
guestApp.use('/games', gamesRouter);

// Viewer at ~NYC. Distances are dominated by longitude here, so games are
// ranked nearest-first by how close their longitude is to -74.
const VIEWER = { lat: 40.7, lng: -74.0 };

const game = (
  id: string,
  dayOffset: number,
  latitude: number | null,
  longitude: number | null
) => ({
  id,
  title: id,
  date: new Date(Date.UTC(2026, 6, 15 + dayOffset)).toISOString(),
  latitude,
  longitude,
  approval_status: 'approved',
  events: [],
  _count: { events: 0 },
  created_by: null,
});

const lastFindManyArgs = () => {
  const calls = mockGameFindMany.mock.calls as unknown as Array<[Record<string, any>]>;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0];
};

beforeEach(() => {
  mockGameFindMany.mockReset();
  mockGameFindMany.mockResolvedValue([]);
  mockCacheGet.mockClear();
  mockCacheGet.mockResolvedValue(null);
  mockUserFindUnique.mockReset();
  mockUserFindUnique.mockResolvedValue(null);
  mockGetZipCoordinates.mockReset();
  mockGetZipCoordinates.mockReturnValue(null);
  mockGeocodeLocation.mockReset();
  mockGeocodeLocation.mockResolvedValue(null);
});

describe('GET /games proximity selection (lat/lng)', () => {
  it('widens the candidate pool and returns the nearest `limit` games, distance ascending', async () => {
    // Date order: far, far, near, mid, nearest — plain date paging would
    // return the two far games first.
    mockGameFindMany.mockResolvedValue([
      game('far-1', 0, 40.7, -120.0),
      game('far-2', 1, 40.7, -110.0),
      game('near-1', 2, 40.7, -74.2),
      game('mid-1', 3, 40.7, -90.0),
      game('nearest', 4, 40.7, -74.05),
    ] as any);

    const res = await request(app)
      .get(`/games?sort=date&limit=3&lat=${VIEWER.lat}&lng=${VIEWER.lng}`)
      .expect(200);

    expect(res.body.games.map((g: any) => g.id)).toEqual(['nearest', 'near-1', 'mid-1']);
    expect(res.body.nextCursor).toBeNull();

    // Pool must be wider than limit+1 so nearby games can't be crowded out.
    const args = lastFindManyArgs();
    expect(args.take).toBeGreaterThan(4);
  });

  it('games without coordinates rank after games with a known distance', async () => {
    mockGameFindMany.mockResolvedValue([
      game('no-coords', 0, null, null),
      game('near-1', 1, 40.7, -74.2),
    ] as any);

    const res = await request(app)
      .get(`/games?sort=date&limit=5&lat=${VIEWER.lat}&lng=${VIEWER.lng}`)
      .expect(200);

    expect(res.body.games.map((g: any) => g.id)).toEqual(['near-1', 'no-coords']);
  });

  it('nextCursor continues the DATE-ordered scan, not the distance-sorted payload', async () => {
    // Return one more game than the widened pool so hasMore is true.
    // The nearest game is the LAST in date order; a cursor taken from the
    // distance-sorted payload would skip everything between.
    const pool: any[] = [];
    for (let i = 0; i < 101; i++) {
      pool.push(game(`g-${i}`, i, 40.7, -74.0 - (101 - i)));
    }
    mockGameFindMany.mockResolvedValue(pool as any);

    const res = await request(app)
      .get(`/games?sort=date&limit=3&lat=${VIEWER.lat}&lng=${VIEWER.lng}`)
      .expect(200);

    const args = lastFindManyArgs();
    const poolSize = (args.take as number) - 1;
    // Cursor = last game of the date-ordered candidate pool.
    expect(res.body.nextCursor).toBe(`g-${poolSize - 1}`);
    // Payload is still the nearest games of the pool.
    expect(res.body.games[0].id).toBe(`g-${poolSize - 1}`);
  });

  it('does not read user preferences when explicit coords are provided', async () => {
    mockGameFindMany.mockResolvedValue([game('a', 0, 40.7, -74.2)] as any);
    await request(app)
      .get(`/games?sort=date&limit=3&lat=${VIEWER.lat}&lng=${VIEWER.lng}`)
      .expect(200);
    expect(mockUserFindUnique).not.toHaveBeenCalled();
  });
});

describe('GET /games proximity fallback (viewer zip preference)', () => {
  it('resolves the signed-in viewer zip to coords and applies nearest-first selection', async () => {
    mockUserFindUnique.mockResolvedValue({ preferences: { zip_code: '10001' } });
    mockGetZipCoordinates.mockReturnValue({ lat: VIEWER.lat, lon: VIEWER.lng });
    mockGameFindMany.mockResolvedValue([
      game('far-1', 0, 40.7, -120.0),
      game('near-1', 1, 40.7, -74.2),
    ] as any);

    const res = await request(app).get('/games?sort=date&limit=2').expect(200);

    expect(mockGetZipCoordinates).toHaveBeenCalledWith('10001');
    expect(res.body.games.map((g: any) => g.id)).toEqual(['near-1', 'far-1']);
  });

  it('keeps plain date order when the viewer has no zip preference', async () => {
    mockUserFindUnique.mockResolvedValue({ preferences: {} });
    mockGameFindMany.mockResolvedValue([
      game('far-1', 0, 40.7, -120.0),
      game('near-1', 1, 40.7, -74.2),
    ] as any);

    const res = await request(app).get('/games?sort=date&limit=2').expect(200);

    expect(res.body.games.map((g: any) => g.id)).toEqual(['far-1', 'near-1']);
    const args = lastFindManyArgs();
    expect(args.take).toBe(3); // limit + 1, pool not widened
  });

  it('does not apply the zip fallback to team-scoped schedule queries', async () => {
    mockUserFindUnique.mockResolvedValue({ preferences: { zip_code: '10001' } });
    mockGetZipCoordinates.mockReturnValue({ lat: VIEWER.lat, lon: VIEWER.lng });
    mockGameFindMany.mockResolvedValue([
      game('far-1', 0, 40.7, -120.0),
      game('near-1', 1, 40.7, -74.2),
    ] as any);

    const res = await request(app)
      .get('/games?sort=date&limit=2&team_id=c123456789012345678901234')
      .expect(200);

    // Schedule stays strictly date-ordered.
    expect(res.body.games.map((g: any) => g.id)).toEqual(['far-1', 'near-1']);
    expect(mockUserFindUnique).not.toHaveBeenCalled();
  });

  it('signed-out viewers keep plain date order without touching user lookup', async () => {
    mockGameFindMany.mockResolvedValue([
      game('far-1', 0, 40.7, -120.0),
      game('near-1', 1, 40.7, -74.2),
    ] as any);

    const res = await request(guestApp).get('/games?sort=date&limit=2').expect(200);

    expect(res.body.games.map((g: any) => g.id)).toEqual(['far-1', 'near-1']);
    expect(mockUserFindUnique).not.toHaveBeenCalled();
  });
});
