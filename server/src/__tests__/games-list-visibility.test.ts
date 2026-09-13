import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Regression tests for GET /games approval-status visibility.
 *
 * A 2026-03 hardening pass silently inverted show_pending=true from
 * "approved + pending" to "pending only", which emptied the Team Schedule
 * screen (manage-season) for every team whose games had been approved.
 * These tests pin the contract:
 *   - show_pending=true      -> approved AND pending (my full schedule)
 *   - approval_status=pending -> pending only (event approvals)
 *   - default                 -> approved only
 */

const mockCacheDelPattern = jest.fn(async () => undefined);
const mockCacheGet = jest.fn(async () => null);
const mockCacheSet = jest.fn(async () => undefined);
const mockGameFindMany = jest.fn(async () => []);
const mockUserFindUnique = jest.fn();
const mockTeamFollowFindMany = jest.fn(async () => [] as Array<{ team_id: string }>);

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
      findMany: mockTeamFollowFindMany,
    },
    user: {
      findUnique: mockUserFindUnique,
    },
    post: {
      findMany: jest.fn(async () => []),
    },
  },
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
  isEmailAdmin: jest.fn(() => true),
  getIsAdmin: jest.fn(async () => true),
  isVerifiedAdminUser: jest.fn(async () => true),
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
  buildPrivateTeamGameVisibilityWhere: jest.fn(() => null),
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
  mergeAndWhere: jest.fn((where: any, clause: any) => {
    if (!clause) return where;
    where.AND = where.AND || [];
    where.AND.push(clause);
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

const TEAM_ID = 'c123456789012345678901234';

const app = express();
app.use(express.json());
app.use((req: any, _res, next) => {
  req.user = { id: 'coach-1' };
  next();
});
app.use('/games', gamesRouter);

const guestApp = express();
guestApp.use(express.json());
guestApp.use('/games', gamesRouter);

const lastFindManyWhere = () => {
  const calls = mockGameFindMany.mock.calls as unknown as Array<[{ where?: any }]>;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0]?.where;
};

describe('GET /games approval-status visibility', () => {
  beforeEach(() => {
    mockGameFindMany.mockClear();
    mockCacheGet.mockClear();
    mockUserFindUnique.mockReset();
    mockUserFindUnique.mockResolvedValue({ email: 'admin@example.com' });
  });

  it('show_pending=true returns the full schedule: approved AND pending', async () => {
    await request(app).get('/games?show_pending=true').expect(200);

    const where = lastFindManyWhere();
    expect(where.approval_status).toEqual({ in: ['approved', 'pending'] });
  });

  it('show_pending=true keeps the team_id scope (home OR away)', async () => {
    await request(app).get(`/games?show_pending=true&team_id=${TEAM_ID}`).expect(200);

    const where = lastFindManyWhere();
    expect(where.approval_status).toEqual({ in: ['approved', 'pending'] });
    expect(where.AND).toEqual([{ OR: [{ home_team_id: TEAM_ID }, { away_team_id: TEAM_ID }] }]);
  });

  it('approval_status=pending stays pending-only for the approvals screen', async () => {
    await request(app).get('/games?approval_status=pending').expect(200);

    const where = lastFindManyWhere();
    expect(where.approval_status).toBe('pending');
  });

  it('defaults to approved-only when neither flag is set', async () => {
    await request(app).get('/games').expect(200);

    const where = lastFindManyWhere();
    expect(where.approval_status).toBe('approved');
  });

  it('show_all=true bypasses the signed-in viewer zip proximity fallback', async () => {
    mockUserFindUnique.mockClear();
    await request(app).get('/games?show_all=true').expect(200);

    expect(mockUserFindUnique).not.toHaveBeenCalled();
  });

  it('organization_id scopes approved games in one query and bypasses zip proximity', async () => {
    mockUserFindUnique.mockClear();
    const orgId = 'org-coach-tools';

    await request(app).get(`/games?organization_id=${orgId}&sort=date&show_all=true`).expect(200);

    const where = lastFindManyWhere();
    expect(where.approval_status).toBe('approved');
    expect(where.AND).toContainEqual({
      OR: [{ homeTeam: { organization_id: orgId } }, { awayTeam: { organization_id: orgId } }],
    });
    expect(mockGameFindMany).toHaveBeenCalledTimes(1);
    expect(mockUserFindUnique).not.toHaveBeenCalled();
  });
});

describe('GET /games?following=true (followed-teams calendar)', () => {
  beforeEach(() => {
    mockGameFindMany.mockClear();
    mockTeamFollowFindMany.mockReset();
    mockTeamFollowFindMany.mockResolvedValue([]);
    mockUserFindUnique.mockReset();
    mockUserFindUnique.mockResolvedValue({ email: 'coach@example.com' });
  });

  it('scopes approved games to the viewer followed teams (home OR away)', async () => {
    mockTeamFollowFindMany.mockResolvedValue([{ team_id: TEAM_ID }]);
    await request(app).get('/games?following=true').expect(200);

    const where = lastFindManyWhere();
    expect(where.approval_status).toBe('approved');
    expect(where.AND).toEqual([
      { OR: [{ home_team_id: { in: [TEAM_ID] } }, { away_team_id: { in: [TEAM_ID] } }] },
    ]);
  });

  it('returns [] without querying games when the viewer follows nothing', async () => {
    mockTeamFollowFindMany.mockResolvedValue([]);
    const res = await request(app).get('/games?following=true').expect(200);

    expect(res.body).toEqual([]);
    expect(mockGameFindMany).not.toHaveBeenCalled();
  });

  it('returns [] for signed-out users without touching the DB', async () => {
    const res = await request(guestApp).get('/games?following=true').expect(200);

    expect(res.body).toEqual([]);
    expect(mockTeamFollowFindMany).not.toHaveBeenCalled();
    expect(mockGameFindMany).not.toHaveBeenCalled();
  });
});
