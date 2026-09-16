import { MembershipStatus, type Prisma } from '@prisma/client';
import { prisma } from './prisma.js';
import { getTeamState } from './teamState.js';
import { cacheGet, cacheSet, cacheDel } from './cache.js';

// Cache TTLs (seconds for Redis, milliseconds for in-process fallback)
const PRIVATE_IDS_CACHE_TTL_S = 60;
const BLOCKED_IDS_CACHE_TTL_S = 30;
const PRIVATE_TEAM_IDS_CACHE_TTL_S = 60;
const PRIVATE_IDS_CACHE_TTL_MS = PRIVATE_IDS_CACHE_TTL_S * 1000;
const PRIVATE_TEAM_IDS_CACHE_TTL_MS = PRIVATE_TEAM_IDS_CACHE_TTL_S * 1000;

// In-process fallback for when Redis is unavailable (single-instance dev/cold start)
let _privateIdsCache: { ids: string[]; expires: number } | null = null;
let _privateTeamIdsCache: {
  teams: Array<{ id: string; organization_id: string | null }>;
  expires: number;
} | null = null;

/** Invalidate the private-IDs cache (call when a user toggles profile_private). */
export function invalidatePrivateIdsCache(): void {
  _privateIdsCache = null;
  void cacheDel('privacy:private_ids');
}

/** Invalidate the private-team cache (call when team privacy/status/org changes). */
export function invalidatePrivateTeamIdsCache(): void {
  _privateTeamIdsCache = null;
  void cacheDel('privacy:private_team_ids');
}

/**
 * Returns IDs of private-profile users whose content should be hidden from the viewer.
 * Excludes the viewer themselves and users the viewer already follows.
 */
export function getExcludedPrivateAuthorIds(
  viewerId: string | null,
  cache?: BlockedCache
): Promise<string[]> {
  return reuseRequestDecision(cache, `private-authors:${JSON.stringify(viewerId)}`, () =>
    loadExcludedPrivateAuthorIds(viewerId)
  );
}

async function loadExcludedPrivateAuthorIds(viewerId: string | null): Promise<string[]> {
  let privateUsers: { id: string }[];

  // Try Redis first (distributed — works across multiple Railway instances)
  const cached = await cacheGet<string[]>('privacy:private_ids');
  if (cached) {
    privateUsers = cached.map(id => ({ id }));
  } else if (_privateIdsCache && Date.now() < _privateIdsCache.expires) {
    // In-process fallback (Redis unavailable)
    privateUsers = _privateIdsCache.ids.map(id => ({ id }));
  } else {
    // v1.0.2 pass 12: bound the scan. 50k private-profile users is ~10x today's peak and
    // the result is cached for 60s, so cold-start cost stays constant regardless of growth.
    privateUsers = await prisma.user.findMany({
      where: {
        preferences: { path: ['profile_private'], equals: true },
      },
      select: { id: true },
      take: 50000,
    });
    _privateIdsCache = {
      ids: privateUsers.map(u => u.id),
      expires: Date.now() + PRIVATE_IDS_CACHE_TTL_MS,
    };
    void cacheSet('privacy:private_ids', _privateIdsCache.ids, PRIVATE_IDS_CACHE_TTL_S);
  }

  if (privateUsers.length === 0) return [];

  const privateIds = privateUsers.map(u => u.id);

  if (!viewerId) return privateIds;

  const followed = await prisma.follows.findMany({
    where: {
      follower_id: viewerId,
      following_id: { in: privateIds },
      status: 'accepted',
    },
    select: { following_id: true },
    take: Math.min(privateIds.length, 50000),
  });

  const allowedSet = new Set(followed.map(f => f.following_id));
  allowedSet.add(viewerId); // Never exclude own posts

  return privateIds.filter(id => !allowedSet.has(id));
}

/**
 * Returns IDs of private teams whose profile/listing should be hidden from the
 * viewer. Team members, team followers, and org admins are allowed through.
 */
export function getExcludedPrivateTeamIds(
  viewerId: string | null,
  cache?: BlockedCache
): Promise<string[]> {
  return reuseRequestDecision(cache, `private-teams:${JSON.stringify(viewerId)}`, () =>
    loadExcludedPrivateTeamIds(viewerId)
  );
}

async function loadExcludedPrivateTeamIds(viewerId: string | null): Promise<string[]> {
  let privateTeams: Array<{ id: string; organization_id: string | null }>;

  const cached = await cacheGet<Array<{ id: string; organization_id: string | null }>>(
    'privacy:private_team_ids'
  );
  if (cached) {
    privateTeams = cached;
  } else if (_privateTeamIdsCache && Date.now() < _privateTeamIdsCache.expires) {
    privateTeams = _privateTeamIdsCache.teams;
  } else {
    privateTeams = await prisma.team.findMany({
      where: { is_private: true, status: 'active' },
      select: { id: true, organization_id: true },
      take: 50000,
    });
    _privateTeamIdsCache = {
      teams: privateTeams,
      expires: Date.now() + PRIVATE_TEAM_IDS_CACHE_TTL_MS,
    };
    void cacheSet('privacy:private_team_ids', privateTeams, PRIVATE_TEAM_IDS_CACHE_TTL_S);
  }

  if (privateTeams.length === 0) return [];
  const privateTeamIds = privateTeams.map(team => team.id);

  if (!viewerId) return privateTeamIds;

  const organizationIds = [
    ...new Set(privateTeams.map(team => team.organization_id).filter(Boolean)),
  ];
  const [follows, memberships, orgMemberships] = await Promise.all([
    prisma.teamFollow.findMany({
      where: { user_id: viewerId, team_id: { in: privateTeamIds } },
      select: { team_id: true },
      take: Math.min(privateTeamIds.length, 50000),
    }),
    prisma.teamMembership.findMany({
      where: {
        user_id: viewerId,
        team_id: { in: privateTeamIds },
        status: MembershipStatus.active,
      },
      select: { team_id: true },
      take: Math.min(privateTeamIds.length, 50000),
    }),
    organizationIds.length > 0
      ? prisma.organizationMembership.findMany({
          where: {
            user_id: viewerId,
            organization_id: {
              in: organizationIds.filter(
                (id): id is string => typeof id === 'string' && id.length > 0
              ),
            },
            role: { in: ['owner', 'manager'] },
            status: MembershipStatus.active,
          },
          select: { organization_id: true },
          take: Math.min(organizationIds.length, 50000),
        })
      : Promise.resolve([]),
  ]);

  const allowedTeamIds = new Set<string>([
    ...follows.map(row => row.team_id),
    ...memberships.map(row => row.team_id),
  ]);
  const allowedOrgIds = new Set(orgMemberships.map(row => row.organization_id));
  for (const team of privateTeams) {
    if (team.organization_id && allowedOrgIds.has(team.organization_id)) {
      allowedTeamIds.add(team.id);
    }
  }

  return privateTeamIds.filter(teamId => !allowedTeamIds.has(teamId));
}

const buildGameTeamVisibilityAnd = (excludedTeamIds: string[]): Prisma.GameWhereInput[] => [
  { OR: [{ home_team_id: null }, { home_team_id: { notIn: excludedTeamIds } }] },
  { OR: [{ away_team_id: null }, { away_team_id: { notIn: excludedTeamIds } }] },
];

/**
 * Prisma post visibility clause for posts attached to private teams directly,
 * through a linked game, or through a linked event. Keep null relations
 * explicitly; SQL NOT IN does not match NULL rows.
 */
export function buildPrivateTeamPostVisibilityWhere(
  excludedTeamIds: string[]
): Prisma.PostWhereInput | null {
  if (excludedTeamIds.length === 0) return null;
  return {
    AND: [
      { OR: [{ team_id: null }, { team_id: { notIn: excludedTeamIds } }] },
      {
        OR: [
          { game_id: null },
          {
            game: {
              AND: buildGameTeamVisibilityAnd(excludedTeamIds),
            },
          },
        ],
      },
      {
        OR: [
          { event_id: null },
          {
            event: {
              is: buildPrivateTeamEventVisibilityWhere(excludedTeamIds) ?? undefined,
            },
          },
        ],
      },
    ],
  };
}

export function buildPrivateTeamGameVisibilityWhere(
  excludedTeamIds: string[]
): Prisma.GameWhereInput | null {
  if (excludedTeamIds.length === 0) return null;
  return {
    AND: buildGameTeamVisibilityAnd(excludedTeamIds),
  };
}

export function buildPrivateTeamEventVisibilityWhere(
  excludedTeamIds: string[]
): Prisma.EventWhereInput | null {
  if (excludedTeamIds.length === 0) return null;
  return {
    AND: [
      { OR: [{ team_id: null }, { team_id: { notIn: excludedTeamIds } }] },
      {
        OR: [
          { game_id: null },
          {
            game: {
              is: {
                AND: buildGameTeamVisibilityAnd(excludedTeamIds),
              },
            },
          },
        ],
      },
    ],
  };
}

export function mergeAndWhere<T extends { AND?: unknown }>(where: T, clause: object | null): T {
  if (!clause) return where;
  const existingAnd = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];
  where.AND = [...existingAnd, clause];
  return where;
}

/**
 * Check if a single user's private profile is hidden from the viewer.
 */
/**
 * Optional per-request cache for `getBlockedUserIds` results, keyed by viewerId.
 * Pass an instance into each call for the same request so repeated lookups
 * (feed → posts → comments → upvote/bookmark/share filters) share one DB hit
 * instead of N. The values are the in-flight promise itself, so concurrent
 * callers in the same request also dedupe instead of racing.
 *
 * Use `getRequestBlockedCache(req)` below to grab/lazy-init the cache off
 * the Express request object — that gives you per-request lifetime with
 * automatic cleanup when the request ends.
 */
export type BlockedCache = Map<string, Promise<string[]>>;

// Extend the existing request-local map, not a new cross-request cache. Keep a
// rejection for the entire request so every sibling fails closed consistently.
function reuseRequestDecision(
  cache: BlockedCache | undefined,
  key: string,
  load: () => Promise<string[]>
): Promise<string[]> {
  if (!cache) return load();
  const existing = cache.get(key);
  if (existing) return existing;
  const pending = load();
  cache.set(key, pending);
  return pending;
}

// Short-lived cross-request in-process fallback for blocked-user lists (used when Redis unavailable).
// With Redis, invalidation is distributed across all Railway instances.
const _blockedIdsFallback = new Map<string, { promise: Promise<string[]>; expires: number }>();

/** Invalidate a specific user's blocked-ids cache entry (call on block/unblock). */
export function invalidateBlockedIdsCache(viewerId: string): void {
  _blockedIdsFallback.delete(viewerId);
  void cacheDel(`privacy:blocked:${viewerId}`);
}

/**
 * Returns IDs of users the viewer has blocked or been blocked by (bidirectional).
 * Used to filter posts and comments from blocked users out of feeds.
 *
 * Pass `cache` (from `getRequestBlockedCache(req)`) to share results across
 * sibling lookups in the same request. Without it, each call hits the DB.
 */
export async function getBlockedUserIds(
  viewerId: string | null,
  cache?: BlockedCache
): Promise<string[]> {
  if (!viewerId) return [];

  // Per-request cache takes priority — already resolved for this request.
  if (cache) {
    const existing = cache.get(viewerId);
    if (existing) return existing;
  }

  // Cross-request in-process fallback (Redis unavailable)
  const fallback = _blockedIdsFallback.get(viewerId);
  if (fallback && Date.now() < fallback.expires) {
    if (cache) cache.set(viewerId, fallback.promise);
    return fallback.promise;
  }

  // The Redis check lives INSIDE the promise so the in-flight promise can be
  // registered synchronously below. Awaiting cacheGet before registration
  // opened an async gap where concurrent same-viewer calls each fired their
  // own DB query (the dedupe race blocked-cache-dedup.test.ts guards).
  const redisKey = `privacy:blocked:${viewerId}`;
  const promise = (async (): Promise<string[]> => {
    // Try Redis distributed cache — works across all Railway instances
    const redisHit = await cacheGet<string[]>(redisKey);
    if (redisHit) return redisHit;

    // v1.0.2 pass 12: bound the scan. A single user's bidirectional block set is tiny in
    // practice; 10k is orders of magnitude beyond real use and keeps the query bounded.
    const blocks = await prisma.blockedUser.findMany({
      where: {
        OR: [{ blocker_id: viewerId }, { blocked_id: viewerId }],
      },
      select: { blocker_id: true, blocked_id: true },
      take: 10000,
    });
    const ids = new Set<string>();
    for (const b of blocks) {
      if (b.blocker_id !== viewerId) ids.add(b.blocker_id);
      if (b.blocked_id !== viewerId) ids.add(b.blocked_id);
    }
    const result = Array.from(ids);
    // Write to Redis for cross-instance sharing (fire-and-forget, non-blocking)
    void cacheSet(redisKey, result, BLOCKED_IDS_CACHE_TTL_S);
    return result;
  })();

  // Register before any await so concurrent callers share this in-flight
  // promise. A rejected lookup must not poison the TTL window — clear it so
  // the next caller retries.
  _blockedIdsFallback.set(viewerId, {
    promise,
    expires: Date.now() + BLOCKED_IDS_CACHE_TTL_S * 1000,
  });
  promise.catch(() => {
    invalidateBlockedIdsCache(viewerId);
  });
  if (cache) cache.set(viewerId, promise);
  return promise;
}

/**
 * Lazily attach a per-request blocked-user cache to the Express request and
 * return it. Each request gets its own Map; it's collected when the request
 * goes out of scope. No middleware needed at the app level — just call this
 * at the top of any handler that uses `getBlockedUserIds` more than once.
 */
export function getRequestBlockedCache(req: object): BlockedCache {
  // Mutate the request object to attach the cache. Express requests are
  // routinely augmented this way (e.g. req.user); using an explicit
  // namespaced key avoids collision with any other middleware.
  const slot = req as { _blockedCache?: BlockedCache };
  if (!slot._blockedCache) slot._blockedCache = new Map();
  return slot._blockedCache;
}

export async function isAuthorHiddenFromViewer(
  authorId: string,
  viewerId: string | null
): Promise<boolean> {
  if (viewerId === authorId) return false;

  const author = await prisma.user.findUnique({
    where: { id: authorId },
    select: { preferences: true },
  });

  const prefs = (author?.preferences || {}) as any;
  if (prefs?.profile_private !== true) return false;

  if (!viewerId) return true;

  const rel = await prisma.follows.findFirst({
    where: {
      follower_id: viewerId,
      following_id: authorId,
      status: 'accepted',
    },
    select: { follower_id: true },
  });

  return !rel;
}

export async function getPostVisibilityFilters(
  viewerId: string | null,
  options: { includePrivateAuthors?: boolean; includePrivateTeams?: boolean } = {}
): Promise<{
  excludedAuthorIds: string[];
  excludedTeamIds: string[];
  authorWhere: Prisma.PostWhereInput | null;
  privateTeamWhere: Prisma.PostWhereInput | null;
}> {
  const [privateAuthorIds, blockedIds, privateTeamIds] = await Promise.all([
    options.includePrivateAuthors ? Promise.resolve([]) : getExcludedPrivateAuthorIds(viewerId),
    getBlockedUserIds(viewerId),
    options.includePrivateTeams ? Promise.resolve([]) : getExcludedPrivateTeamIds(viewerId),
  ]);
  const excludedAuthorIds = [...new Set([...privateAuthorIds, ...blockedIds])];
  return {
    excludedAuthorIds,
    excludedTeamIds: privateTeamIds,
    authorWhere: excludedAuthorIds.length ? { author_id: { notIn: excludedAuthorIds } } : null,
    privateTeamWhere: buildPrivateTeamPostVisibilityWhere(privateTeamIds),
  };
}

export async function isPostHiddenFromViewer(
  post: {
    author_id?: string | null;
    team_id?: string | null;
    game?: { home_team_id?: string | null; away_team_id?: string | null } | null;
  },
  viewerId: string | null,
  cache?: BlockedCache
): Promise<boolean> {
  if (post.author_id) {
    if (await isAuthorHiddenFromViewer(post.author_id, viewerId)) return true;
    const blockedIds = await getBlockedUserIds(viewerId, cache);
    if (blockedIds.includes(post.author_id)) return true;
  }

  const teamIds = [post.team_id, post.game?.home_team_id, post.game?.away_team_id].filter(
    (id): id is string => typeof id === 'string' && id.length > 0
  );
  for (const teamId of [...new Set(teamIds)]) {
    if (await isTeamHiddenFromViewer(teamId, viewerId)) return true;
  }

  return false;
}

/**
 * Check if a single team's private profile is hidden from the viewer.
 * Team members, followers, and org admins can still see it.
 */
export async function isTeamHiddenFromViewer(
  teamId: string,
  viewerId: string | null
): Promise<boolean> {
  const team = await getTeamState(teamId, prisma);
  if (!team || team.status !== 'active') return true;
  if (!team.is_private) return false;
  if (!viewerId) return true;

  const [follow, membership, orgMembership] = await Promise.all([
    prisma.teamFollow.findFirst({
      where: { user_id: viewerId, team_id: teamId },
      select: { team_id: true },
    }),
    prisma.teamMembership.findFirst({
      where: { user_id: viewerId, team_id: teamId, status: MembershipStatus.active },
      select: { team_id: true },
    }),
    team.organization_id
      ? prisma.organizationMembership.findFirst({
          where: {
            user_id: viewerId,
            organization_id: team.organization_id,
            role: { in: ['owner', 'manager'] },
            status: MembershipStatus.active,
          },
          select: { organization_id: true },
        })
      : Promise.resolve(null),
  ]);

  return !follow && !membership && !orgMembership;
}
