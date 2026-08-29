import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { getZipCoordinates, haversineDistance } from '../lib/geoUtils.js';
import { geocodeLocation } from '../lib/geocoding.js';
import { MEDIA_URL_MESSAGE, isAllowedMediaUrl } from '../lib/mediaHosts.js';
import { detectMediaType, resolvePreviewUrl } from '../lib/mediaUtils.js';
import {
  serializePoll,
  stripSampleGameTitle,
  loadPostInteractionSets,
  serializeFeedPost,
} from '../lib/feedPostSerializer.js';
import { prisma } from '../lib/prisma.js';
import {
  getBlockedUserIds,
  getExcludedPrivateAuthorIds,
  getExcludedPrivateTeamIds,
  getRequestBlockedCache,
  isAuthorHiddenFromViewer,
  isTeamHiddenFromViewer,
} from '../lib/privacyUtils.js';
import {
  canManageAnyTeam,
  canManageTeam as canManageTeamScoped,
} from '../lib/teamAuthorization.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import type { AuthedRequest } from '../middleware/auth.js';
import {
  commentLimiter,
  interactionLimiter,
  postCreationLimiter,
} from '../middleware/rateLimiters.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { requireOnboarded } from '../middleware/requireOnboarded.js';
import { requireVerified } from '../middleware/requireVerified.js';
import { registerIdValidation } from '../middleware/validateParams.js';
import { sendError } from '../lib/http/sendError.js';
import { captureMessage } from '../lib/sentry.js';

export const postsRouter = Router();
registerIdValidation(postsRouter);

const POST_UNDO_WINDOW_MS = 5 * 60 * 1000;

// Dedup guard: prevent identical post / comment creation within a short
// window. Key = userId:contentHash, value = timestamp. Entries expire
// after 30s.
//
// Pruning strategy: lazy expiration on get (the common read path) keeps
// growth bounded under steady state without per-request O(N) iteration —
// the prior implementation prune-scanned all entries whenever size > 1000,
// which was a synchronous lag spike on busy servers. The HARD_CAP +
// drop-oldest-N is a safety net for pathological churn that never
// re-reads (e.g., 1000+ unique users each comment exactly once and never
// again within the window).
const recentPostHashes = new Map<string, number>();
const recentCommentHashes = new Map<string, number>();
const DEDUP_WINDOW_MS = 30_000;
const DEDUP_HARD_CAP = 5_000;
const DEDUP_DROP_BATCH = 1_000;

function checkAndRecordDedup(map: Map<string, number>, key: string): boolean {
  const now = Date.now();
  const prev = map.get(key);
  if (prev !== undefined) {
    if (now - prev < DEDUP_WINDOW_MS) return true;
    // Expired — clean it up while we're here. Lazy expiration is the
    // primary memory-bound mechanism in steady state.
    map.delete(key);
  }
  map.set(key, now);

  // Safety net: if the map has grown past the hard cap (means lots of
  // entries that never get re-read within the window), drop the oldest
  // batch in insertion order. Map iterates in insertion order in V8, so
  // this is approximate-LRU.
  if (map.size > DEDUP_HARD_CAP) {
    let dropped = 0;
    for (const k of map.keys()) {
      map.delete(k);
      if (++dropped >= DEDUP_DROP_BATCH) break;
    }
  }
  return false;
}

function isDuplicateComment(userId: string, postId: string, content: string): boolean {
  const raw = `${userId}:${postId}:${content?.trim() || ''}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
  return checkAndRecordDedup(recentCommentHashes, `comment:${userId}:${hash}`);
}

function isDuplicatePost(
  userId: string,
  content: string,
  gameId?: string,
  mediaUrl?: string
): boolean {
  // Media-only posts (no text) must include the media URL in the hash — otherwise
  // two different images by the same user within 30s would share the same key
  // (both hash to `userId::gameId`) and the second would be falsely rejected.
  const raw = `${userId}:${content?.trim() || ''}:${gameId || ''}:${mediaUrl || ''}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
  return checkAndRecordDedup(recentPostHashes, `${userId}:${hash}`);
}

const isMissingPollSchemaError = (error: any): boolean => {
  if (!error || (error.code !== 'P2021' && error.code !== 'P2022')) return false;
  const table = String(error?.meta?.table ?? '');
  const column = String(error?.meta?.column ?? '');
  const message = String(error?.message ?? '');
  return /Poll/i.test(table) || /Poll/i.test(column) || /Poll/i.test(message);
};

const logPollSchemaFallback = (context: string, error: any) => {
  console.warn(`[posts] Poll schema unavailable in ${context}; serving without poll data`, {
    code: error?.code,
    table: error?.meta?.table,
    column: error?.meta?.column,
  });
};

/** Transform a Prisma poll + options into the shape the PollCard component expects. */
// serializePoll, stripSampleGameTitle, loadPostInteractionSets, and
// serializeFeedPost are imported from ../lib/feedPostSerializer.js (shared with
// routes/feed.ts).

const POLL_CONTEXT_UNAVAILABLE = {
  error: 'Polls are only available for competitive game/event posts.',
  code: 'POLL_NOT_AVAILABLE',
};

async function getPostPollEligibility(post: { game_id?: string | null }) {
  if (!post.game_id) {
    return {
      ok: false as const,
      status: 409,
      body: POLL_CONTEXT_UNAVAILABLE,
    };
  }

  const game = await prisma.game.findUnique({
    where: { id: post.game_id },
    select: { id: true, event_type: true },
  });

  if (!game) {
    return { ok: false as const, status: 404, body: { error: 'Linked game not found' } };
  }

  const normalizedEventType = String(game.event_type || 'game')
    .trim()
    .toLowerCase();
  if (normalizedEventType !== 'game') {
    return {
      ok: false as const,
      status: 409,
      body: POLL_CONTEXT_UNAVAILABLE,
    };
  }

  return { ok: true as const, gameId: game.id };
}

/** Check if user is coach/owner of any team associated with the post (team_id or game's teams) */
async function isCoachOfPostTeam(
  userId: string,
  post: { team_id?: string | null; game_id?: string | null }
): Promise<boolean> {
  const teamIds: string[] = [];
  if (post.team_id) teamIds.push(post.team_id);
  if (post.game_id) {
    const game = await prisma.game.findUnique({
      where: { id: post.game_id },
      select: { home_team_id: true, away_team_id: true },
    });
    if (game?.home_team_id) teamIds.push(game.home_team_id);
    if (game?.away_team_id) teamIds.push(game.away_team_id);
  }
  return canManageAnyTeam(userId, teamIds);
}

/** Time-decay trending score: upvotes / (hours_since_posted + 2)^1.5 */
const TRENDING_POOL_SIZE = 200;
const buildFollowedPostsWhereClause = (
  currentUserId: string,
  mode: 'followed' | 'followed_teams'
) => {
  if (mode === 'followed') {
    return [
      {
        author: {
          followers: {
            some: {
              follower_id: currentUserId,
              status: 'accepted',
            },
          },
        },
      },
      { type: 'admin_broadcast' },
    ];
  }

  return [
    {
      team: {
        is: {
          followers: {
            some: {
              user_id: currentUserId,
            },
          },
        },
      },
    },
    {
      game: {
        is: {
          OR: [
            {
              homeTeam: {
                is: {
                  followers: {
                    some: {
                      user_id: currentUserId,
                    },
                  },
                },
              },
            },
            {
              awayTeam: {
                is: {
                  followers: {
                    some: {
                      user_id: currentUserId,
                    },
                  },
                },
              },
            },
          ],
        },
      },
    },
    { type: 'admin_broadcast' },
  ];
};

const trendingScore = (upvotes: number, createdAt: Date): number => {
  const ageHours = Math.max((Date.now() - createdAt.getTime()) / 3600000, 0);
  return (upvotes || 0) / Math.pow(ageHours + 2, 1.5);
};

postsRouter.get(
  '/',
  asyncHandler(async (req: AuthedRequest, res) => {
    const sort = typeof req.query.sort === 'string' ? req.query.sort.trim() : '';
    const limit = Math.max(1, Math.min(parseInt(String(req.query.limit ?? '10'), 10) || 10, 50));
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
    const followedOnly = String(req.query.followed_only || '').toLowerCase() === 'true';
    const followedTeams = String(req.query.followed_teams || '').toLowerCase() === 'true';
    const currentUserId = req.user?.id ?? null;

    const hasTeamFilter = !!req.query.team_id;
    const orderBy =
      sort === 'trending'
        ? [{ created_at: 'desc' as const }] // Fetch by recency; we'll re-sort by score
        : hasTeamFilter
          ? [{ is_pinned: 'desc' as const }, { created_at: 'desc' as const }] // Pinned first on team feed
          : [{ created_at: 'desc' as const }];

    const where: Record<string, any> = { deleted_at: null };

    // Followed feed: only posts from users the current user follows (requires auth)
    let followedFeedMeta: { following_count: number } | undefined;
    if (followedOnly) {
      if (!currentUserId) {
        return res
          .status(401)
          .json({ items: [], nextCursor: null, followed_feed_meta: { following_count: 0 } });
      }
      const followingCount = await prisma.follows.count({
        where: { follower_id: currentUserId, status: 'accepted' },
      });
      followedFeedMeta = { following_count: followingCount };
      if (followingCount === 0) {
        return res.json({ items: [], nextCursor: null, followed_feed_meta: followedFeedMeta });
      }
      where.OR = buildFollowedPostsWhereClause(currentUserId, 'followed');
    }

    // Followed teams feed: posts from teams the user follows (team_id or game's teams)
    let followedTeamsFeedMeta: { followed_teams_count: number } | undefined;
    if (followedTeams) {
      if (!currentUserId) {
        return res.status(401).json({
          items: [],
          nextCursor: null,
          followed_teams_feed_meta: { followed_teams_count: 0 },
        });
      }
      const followedTeamsCount = await prisma.teamFollow.count({
        where: { user_id: currentUserId },
      });
      followedTeamsFeedMeta = { followed_teams_count: followedTeamsCount };
      if (followedTeamsCount === 0) {
        return res.json({
          items: [],
          nextCursor: null,
          followed_teams_feed_meta: followedTeamsFeedMeta,
        });
      }
      where.OR = buildFollowedPostsWhereClause(currentUserId, 'followed_teams');
    }

    if (req.query.game_id) {
      const gameId = String(req.query.game_id);
      // Match posts tied to the game directly (game_id) OR via one of its
      // events (event_id). Symmetric with the event_id branch below; keeps
      // legacy rows that only carry one column visible on the game feed.
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : []),
        { OR: [{ game_id: gameId }, { event: { game_id: gameId } }] },
      ];
    }
    if (req.query.team_id) {
      const teamId = String(req.query.team_id);
      // Respect team privacy — a private team's posts must not be served to a
      // viewer who isn't a member/follower/org-admin (mirrors the ?user_id=
      // private-author guard below and GET /teams/:id/screen-summary).
      const teamHidden = await isTeamHiddenFromViewer(teamId, currentUserId);
      if (teamHidden) return res.json({ items: [], nextCursor: null });
      // A team's posts are those attached to the team directly plus those
      // attached to any of its games (home or away side).
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : []),
        {
          OR: [
            { team_id: teamId },
            { game: { OR: [{ home_team_id: teamId }, { away_team_id: teamId }] } },
          ],
        },
      ];
    }
    if (req.query.program_id) {
      const programId = String(req.query.program_id);
      // ONE sport page (owner July-28): the Posts tab is SHARED across every
      // sub-team in the program — regardless of which sub-team the viewer tapped
      // in the Events tab. Match posts attached to any active sub-team directly
      // or to any of their games (home/away side). Privacy is enforced per
      // sub-team via isTeamHiddenFromViewer (mirrors the ?team_id= guard above):
      // a private sub-team the viewer can't see drops out of the union.
      const programTeams = await prisma.team.findMany({
        where: { program_id: programId, status: 'active' },
        select: { id: true },
        take: 100,
      });
      const visibleTeamIds: string[] = [];
      for (const t of programTeams) {
        if (!(await isTeamHiddenFromViewer(t.id, currentUserId))) visibleTeamIds.push(t.id);
      }
      if (visibleTeamIds.length === 0) return res.json({ items: [], nextCursor: null });
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : []),
        {
          OR: [
            { team_id: { in: visibleTeamIds } },
            {
              game: {
                OR: [
                  { home_team_id: { in: visibleTeamIds } },
                  { away_team_id: { in: visibleTeamIds } },
                ],
              },
            },
          ],
        },
      ];
    }
    if (req.query.event_id) {
      const eventId = String(req.query.event_id);
      const event = await prisma.event.findUnique({
        where: { id: eventId },
        select: { game_id: true },
      });
      if (!event) {
        // Event not found — no posts to return
        return res.json({ items: [], nextCursor: null });
      }
      // Posts attach to an event directly (event_id) or via its linked game
      // (game_id). Match both so event-only pages and legacy game-backed events
      // both return their posts.
      const eventMatch = event.game_id
        ? [{ event_id: eventId }, { game_id: event.game_id }]
        : [{ event_id: eventId }];
      where.AND = [...(Array.isArray(where.AND) ? where.AND : []), { OR: eventMatch }];
    }
    if (req.query.type) where.type = String(req.query.type);
    // Scope in OBJECT form ({ equals }) — a bare string scope was silently
    // discarded by the block-filter merge below (which treats non-objects as
    // {}), leaking the global feed + private-author posts. Audit 2026-07-14 (live).
    if (req.query.user_id) where.author_id = { equals: String(req.query.user_id) };

    // Privacy: hide posts from private-profile authors the viewer doesn't follow
    if (req.query.user_id) {
      // Specific user requested — block if private and viewer is not a follower
      const hidden = await isAuthorHiddenFromViewer(String(req.query.user_id), currentUserId);
      if (hidden) return res.json({ items: [], nextCursor: null });
    } else {
      // General feed — exclude all private authors the viewer doesn't follow
      const excludedIds = await getExcludedPrivateAuthorIds(currentUserId);
      if (excludedIds.length)
        where.author_id = {
          ...(typeof where.author_id === 'object' ? where.author_id : {}),
          notIn: excludedIds,
        };
      // Also exclude posts attached to private teams the viewer can't see.
      const excludedTeamIds = await getExcludedPrivateTeamIds(currentUserId);
      if (excludedTeamIds.length) {
        where.AND = [
          ...(Array.isArray(where.AND) ? where.AND : []),
          // notIn alone would drop null-team posts (NOT IN is NULL for NULL) —
          // explicitly keep non-team posts.
          { OR: [{ team_id: null }, { team_id: { notIn: excludedTeamIds } }] },
        ];
      }
    }

    // Block filtering: hide posts from users the viewer has blocked or been blocked by
    const blockedIds = await getBlockedUserIds(currentUserId, getRequestBlockedCache(req));
    if (blockedIds.length) {
      const existing = typeof where.author_id === 'object' ? where.author_id : {};
      const merged = [...(existing.notIn || []), ...blockedIds];
      where.author_id = { ...existing, notIn: merged };
    }

    // Location filtering: resolve user coordinates from zip or lat/lng params
    const feedRadius = Math.min(Number(req.query.radius) || 50, 500); // default 50mi, max 500mi
    let userCoords: { lat: number; lon: number } | null = null;
    if (req.query.zip && typeof req.query.zip === 'string') {
      userCoords = getZipCoordinates(req.query.zip as string);
      if (!userCoords) {
        const geo = await geocodeLocation(req.query.zip as string);
        if (geo) userCoords = { lat: geo.latitude, lon: geo.longitude };
      }
    } else if (req.query.lat && req.query.lng) {
      const pLat = Number(req.query.lat);
      const pLng = Number(req.query.lng);
      if (Number.isFinite(pLat) && Number.isFinite(pLng)) {
        userCoords = { lat: pLat, lon: pLng };
      }
    }

    // Trending: fetch pool, compute time-decay score, sort, paginate
    if (sort === 'trending') {
      const poolQuery: any = {
        where,
        orderBy: [{ created_at: 'desc' as const }],
        include: {
          author: { select: { id: true, username: true, display_name: true, avatar_url: true } },
          team: { select: { id: true, name: true, logo_url: true } },
          _count: { select: { comments: true, bookmarks: true } },
          poll: { include: { options: true } },
        },
        take: TRENDING_POOL_SIZE,
      };
      let pool: any[] = [];
      try {
        // audit-allow unbounded: poolQuery already includes take: TRENDING_POOL_SIZE
        pool = await prisma.post.findMany(poolQuery);
      } catch (error: any) {
        if (!isMissingPollSchemaError(error)) {
          console.error('[posts] Failed to fetch trending pool:', error);
          return res.status(500).json({ error: 'Failed to fetch posts' });
        }
        logPollSchemaFallback('GET /posts trending', error);
        const fallback = { ...poolQuery, include: { ...poolQuery.include } };
        delete fallback.include.poll;
        // audit-allow unbounded: fallback preserves the same take-bound as poolQuery
        pool = await prisma.post.findMany(fallback);
      }
      // Apply location filter to trending pool
      if (userCoords) {
        pool = pool.filter((post: any) => {
          if (post.lat == null || post.lng == null) return true;
          return (
            haversineDistance(userCoords!.lat, userCoords!.lon, post.lat, post.lng) <= feedRadius
          );
        });
      }

      const ranked = pool
        .map(p => ({
          post: p,
          score: trendingScore(
            p.upvotes_count ?? 0,
            p.created_at instanceof Date ? p.created_at : new Date(p.created_at)
          ),
          createdAt: p.created_at instanceof Date ? p.created_at : new Date(p.created_at),
        }))
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return (
            b.createdAt.getTime() - a.createdAt.getTime() ||
            String(b.post.id).localeCompare(String(a.post.id))
          );
        });
      let filtered = ranked;
      if (cursor && cursor.startsWith('t:')) {
        const parts = cursor.slice(2).split('|');
        if (parts.length >= 3) {
          const [scoreStr, createdAtStr, id] = parts;
          const cursorScore = parseFloat(scoreStr);
          const cursorTime = new Date(createdAtStr).getTime();
          filtered = ranked.filter(r => {
            if (r.score < cursorScore - 1e-9) return true;
            if (Math.abs(r.score - cursorScore) <= 1e-9) {
              if (r.createdAt.getTime() < cursorTime) return true;
              if (r.createdAt.getTime() === cursorTime)
                return String(r.post.id).localeCompare(id) < 0;
            }
            return false;
          });
        }
      }
      const items = filtered.slice(0, limit);
      const nextRow = filtered[limit];
      const nextCursor = nextRow
        ? `t:${nextRow.score}|${nextRow.createdAt.toISOString()}|${nextRow.post.id}`
        : null;
      const postIds = items.map((p: any) => p.post.id);
      const authorIds = items.map((p: any) => p.post.author_id).filter(Boolean);
      const pollIds = items.map((p: any) => p.post.poll?.id).filter(Boolean);
      const sets = await loadPostInteractionSets(prisma, currentUserId, {
        postIds,
        authorIds,
        pollIds,
      });
      const payload = items.map(({ post }: any) => serializeFeedPost(post, sets));
      const response: Record<string, any> = { items: payload, nextCursor };
      if (followedFeedMeta) response.followed_feed_meta = followedFeedMeta;
      if (followedTeamsFeedMeta) response.followed_teams_feed_meta = followedTeamsFeedMeta;
      return res.json(response);
    }

    const query: any = {
      where,
      orderBy,
      include: {
        author: { select: { id: true, username: true, display_name: true, avatar_url: true } },
        team: { select: { id: true, name: true, logo_url: true } },
        _count: { select: { comments: true, bookmarks: true } },
        poll: { include: { options: true } },
      },
      // Over-fetch when location filtering is active to compensate for filtered-out posts
      take: userCoords ? Math.min((limit + 1) * 3, 150) : limit + 1,
    };
    if (cursor) {
      query.cursor = { id: cursor };
      query.skip = 1;
    }

    let rows: any[] = [];
    try {
      // audit-allow unbounded: query object already includes a bounded take derived from limit
      rows = await prisma.post.findMany(query);
    } catch (error: any) {
      if (!isMissingPollSchemaError(error)) {
        console.error('[posts] Failed to fetch posts:', error);
        return res.status(500).json({ error: 'Failed to fetch posts' });
      }
      logPollSchemaFallback('GET /posts', error);
      const fallbackQuery = { ...query, include: { ...query.include } };
      delete fallbackQuery.include.poll;
      // audit-allow unbounded: fallbackQuery preserves the same take-bound as query
      rows = await prisma.post.findMany(fallbackQuery);
    }

    // Apply location filter: keep posts without coords + posts within radius
    if (userCoords) {
      rows = rows.filter((post: any) => {
        if (post.lat == null || post.lng == null) return true; // no location → always show
        return (
          haversineDistance(userCoords!.lat, userCoords!.lon, post.lat, post.lng) <= feedRadius
        );
      });
    }

    const items = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? rows[limit].id : null;

    const postIds: string[] = items.map((p: any) => p.id);
    const authorIds: string[] = items.map((p: any) => p.author_id).filter(Boolean);

    const pollIds: string[] = items.map((p: any) => p.poll?.id).filter(Boolean);
    const sets = await loadPostInteractionSets(prisma, currentUserId, {
      postIds,
      authorIds,
      pollIds,
    });

    // Debug logging for follow relationships
    debugLog('[posts] Follow debug:', {
      currentUserId,
      authorIds,
      followingIds: Array.from(sets.followingIds),
      followRecords: sets.followingIds.size,
    });

    const payload = items.map((post: any) => serializeFeedPost(post, sets));

    const response: Record<string, any> = { items: payload, nextCursor };
    if (followedFeedMeta) response.followed_feed_meta = followedFeedMeta;
    if (followedTeamsFeedMeta) response.followed_teams_feed_meta = followedTeamsFeedMeta;
    return res.json(response);
  })
);

postsRouter.get(
  '/trending',
  asyncHandler(async (req: AuthedRequest, res) => {
    // Set trending sort and reuse the main GET / handler
    req.query.sort = 'trending';
    // Re-dispatch through the router by calling the root handler directly
    // Express next() won't work across different paths, so we emit a synthetic request
    req.url = '/';
    (postsRouter as any).handle(req, res, () => res.status(404).json({ error: 'Not found' }));
  })
);

// Debug endpoint to check follow relationships (admin only)
postsRouter.get(
  '/debug/follows',
  requireAuth,
  requireAdmin as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const currentUserId = req.user!.id;

    const follows = await prisma.follows.findMany({
      where: { follower_id: currentUserId },
      select: {
        following_id: true,
        following: {
          select: { id: true, display_name: true, username: true },
        },
      },
      take: 1000,
    });

    return res.json({
      userId: currentUserId,
      followingCount: follows.length,
      following: follows.map(f => ({
        id: f.following_id,
        display_name: f.following.display_name,
        username: f.following.username,
      })),
    });
  })
);

// Count posts by simple filters (e.g., game_id, type)
postsRouter.get(
  '/count',
  asyncHandler(async (req, res) => {
    const where: any = { deleted_at: null };
    if (req.query.game_id) where.game_id = String(req.query.game_id);
    if (req.query.team_id) where.team_id = String(req.query.team_id);
    if (req.query.type) where.type = String(req.query.type);
    const count = await prisma.post.count({ where });
    res.json({ count });
  })
);

const locationSchema = z
  .object({
    lat: z.number().nullable().optional(),
    lng: z.number().nullable().optional(),
    place_id: z.string().nullable().optional(),
    place_name: z.string().nullable().optional(),
    locality: z.string().nullable().optional(),
    admin_area: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    country_code: z.string().nullable().optional(),
    source: z.enum(['device', 'places', 'zip', 'derived']).nullable().optional(),
    zip: z.string().nullable().optional(),
  })
  .optional();

const isAllowedPostMediaUrl = isAllowedMediaUrl;
const mediaUrlMessage = MEDIA_URL_MESSAGE;

const createPostSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    content: z.string().max(4000).optional(),
    type: z.string().max(50).optional(),
    media_url: z.string().trim().min(1).refine(isAllowedPostMediaUrl, mediaUrlMessage).optional(),
    // Media metadata captured client-side from the upload response. Bounded to
    // sane ranges so a malformed client can't persist absurd values. All
    // optional/additive — older clients simply omit them.
    poster_url: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .refine(isAllowedPostMediaUrl, mediaUrlMessage)
      .optional(),
    media_width: z.number().int().positive().max(100000).optional(),
    media_height: z.number().int().positive().max(100000).optional(),
    media_duration_s: z.number().nonnegative().max(86400).optional(),
    media_bytes: z.number().int().nonnegative().max(5_000_000_000).optional(),
    game_id: z.string().optional(),
    team_id: z.string().optional(), // Associate post with team page (coach-only)
    event_id: z.string().optional(), // For event-specific posts
    location: locationSchema,
  })
  // Require at least content or media_url
  .refine(
    d =>
      Boolean(
        (d.content && d.content.trim().length > 0) || (d.media_url && d.media_url.trim().length > 0)
      ),
    {
      message: 'Either content or media_url is required',
      path: ['content'],
    }
  );

import { geocodeZip, getCountryFromReqOrPrefs, reverseGeocode } from '../lib/geo.js';
import { verifyEventPostingPermission } from '../lib/geofencing.js';
import { notifyMentions } from '../lib/mentionNotifications.js';
import { notifyCommentReply, notifyPostInteraction } from '../lib/notifications.js';
import { stripHtml } from '../lib/sanitizeHtml.js';
import { getIsAdmin } from '../middleware/requireAdmin.js';
import { debugLog } from '../lib/debugLog.js';

postsRouter.post(
  '/',
  requireAuth as any,
  requireVerified as any,
  requireOnboarded as any,
  postCreationLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    // v1.0.2 pass 8: banned check (symmetric with DMs + comments)
    const banner = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { banned: true, banned_until: true },
    });
    if (banner?.banned || (banner?.banned_until && banner.banned_until > new Date())) {
      return res
        .status(403)
        .json({ error: 'Your account is suspended from posting.', code: 'USER_BANNED' });
    }

    // All authenticated, onboarded users can create posts (fans included).

    // req.user is guaranteed by requireVerified middleware
    const parsed = createPostSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid payload',
        issues: parsed.error.issues.map(i => ({ path: i.path, message: i.message })),
      });
    }
    const data = parsed.data;

    // Dedup guard: reject if identical post submitted within 30s window
    if (
      isDuplicatePost(
        req.user!.id,
        data.content || '',
        (data as any).game_id,
        (data as any).media_url
      )
    ) {
      return res.status(409).json({
        error: 'Duplicate post detected. Please wait before posting again.',
        code: 'DUPLICATE_POST',
      });
    }

    // Normalize and enrich location
    let lat: number | null = null;
    let lng: number | null = null;
    let country_code: string | null = null;
    let admin1: string | null = null;
    let place_name: string | null = null;
    // The country from an ACTUAL geocode (device GPS or zip lookup), as opposed
    // to the 'US' fallback. Only this reliable value is learned into the
    // author's preferences below — never the fallback.
    let geocodedCountry: string | null = null;

    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const prefs = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { preferences: true },
    });
    const preferCountry = getCountryFromReqOrPrefs(req as any, prefs?.preferences);
    const loc = (data as any).location || {};
    const hasDeviceOriginLocation =
      loc?.source === 'device' && typeof loc.lat === 'number' && typeof loc.lng === 'number';
    // Never leave country_code null — a null drops the post from the
    // country-scoped Highlights feed (which hard-filters country_code).
    // 'US' matches the read-side default in app/highlights.tsx.
    if (typeof loc.lat === 'number' && typeof loc.lng === 'number') {
      lat = loc.lat;
      lng = loc.lng;
      try {
        const rev = await reverseGeocode(lat as number, lng as number);
        geocodedCountry = rev.country_code || null;
        country_code = rev.country_code || preferCountry || 'US';
        admin1 = rev.admin_area || null;
        place_name = rev.place_name || null;
      } catch (err: unknown) {
        debugLog('[posts] reverseGeocode failed, using fallback:', (err as Error)?.message ?? err);
        // Don't let a geocode failure null out the country — fall back to the
        // user's preferred country so the post still qualifies for the
        // country-scoped Highlights feed (which hard-filters on country_code).
        country_code = country_code ?? preferCountry ?? 'US';
      }
    } else if (loc.zip || (prefs?.preferences as any)?.zip_code) {
      try {
        const zip = String(loc.zip || (prefs?.preferences as any)?.zip_code);
        const gg = await geocodeZip(zip, preferCountry);
        lat = gg.lat;
        lng = gg.lng;
        geocodedCountry = gg.country_code || null;
        country_code = gg.country_code || preferCountry || 'US';
      } catch (err: unknown) {
        debugLog('[posts] geocodeZip failed, using fallback:', (err as Error)?.message ?? err);
        // Same fallback as the reverseGeocode branch: a geocode failure must not
        // null out the country, or the post drops out of the Highlights feed.
        country_code = country_code ?? preferCountry ?? 'US';
      }
    } else {
      country_code = preferCountry || 'US';
    }

    // Learn the author's country from this reliable geocode so the
    // country-scoped Highlights read stops defaulting them to 'US'. Single
    // source of truth: preferences.country_code — set once here when the user
    // has no country yet, read everywhere else (post write default, Highlights
    // viewer country, geocodeZip). We never persist the 'US' fallback, which
    // would lock a non-US user (e.g. a Canadian) into the wrong country.
    if (geocodedCountry && !preferCountry) {
      try {
        const basePrefs =
          prefs?.preferences && typeof prefs.preferences === 'object'
            ? (prefs.preferences as Record<string, unknown>)
            : {};
        await prisma.user.update({
          where: { id: req.user.id },
          data: { preferences: { ...basePrefs, country_code: geocodedCountry } },
        });
      } catch (err: unknown) {
        debugLog(
          '[posts] failed to persist learned country to preferences:',
          (err as Error)?.message ?? err
        );
      }
    }

    // ⚠️ GEOFENCING CHECK FOR EVENT POSTS
    // If this is an event-specific post, verify user is at the venue.
    // (2026-07-09: the sample- demo-content carve-out is retired — sample ids
    // no longer skip geofencing or get [SAMPLE_GAME:] title markers. The
    // stripSampleGameTitle serializer stays: old DB rows still carry markers.)
    const eventId = (data as any).event_id;
    const gameId = data.game_id;

    let finalGameId: string | null = gameId ?? null;
    const finalTitle = data.title || null;
    // Event id derived from the game's primary event during the geofencing
    // lookup below — reused when denormalizing the link so we don't re-query.
    let derivedEventIdFromGame: string | null = null;
    if (eventId || gameId) {
      // Check geofencing for real events or games (games have associated events)
      if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

      let targetEventId = eventId;
      let homeTeamId: string | null = null;
      let awayTeamId: string | null = null;

      // Look up game to get event + team IDs for membership check.
      // `description` is selected so we can detect [DEMO_MATCHUP]-tagged games.
      let isDemoMatchup = false;
      if (gameId) {
        const game = await prisma.game.findUnique({
          where: { id: gameId },
          select: {
            description: true,
            home_team_id: true,
            away_team_id: true,
            events: {
              orderBy: { date: 'asc' },
              take: 1,
              select: { id: true },
            },
          },
        });
        if (game) {
          homeTeamId = game.home_team_id ?? null;
          awayTeamId = game.away_team_id ?? null;
          if (game.events?.length) {
            // Capture the game's primary event so we can denormalize the link
            // (post carries both game_id AND event_id) even when the client
            // only sent game_id.
            derivedEventIdFromGame = game.events[0].id;
            if (!targetEventId) {
              targetEventId = derivedEventIdFromGame;
              debugLog(`✅ Found associated event ${targetEventId} for game ${gameId}`);
            }
          }
          // [DEMO_MATCHUP] carve-out — one-off for Duke v UNC + Cavs v Warriors
          // promo content. See server/scripts/seed-demo-matchups.ts. This branch
          // becomes dead code once the demo rows are wiped from the DB.
          isDemoMatchup =
            typeof game.description === 'string' && game.description.includes('[DEMO_MATCHUP]');
        }
      }

      // Admins retain a bypass for moderation/testing. Normal users, including
      // team staff, must satisfy the event posting window and venue geofence.
      const isAdmin = await getIsAdmin(req as any);

      if (isDemoMatchup) {
        debugLog(`✅ [DEMO_MATCHUP] game ${gameId} — skipping geofencing`);
      } else if (isAdmin) {
        debugLog(`✅ Geofencing bypassed (isAdmin=${isAdmin})`);
      } else if (targetEventId) {
        // Only device-origin GPS may satisfy the venue geofence (anti-spoof:
        // zip-derived coords must never count). Pass null otherwise and let
        // verifyEventPostingPermission decide: a FIRST post still requires
        // real location at the venue, but users holding a 7-day posting
        // unlock (already posted/storied to this event page) post from
        // anywhere, during the event and through the post-event grace window.
        const deviceLat = hasDeviceOriginLocation ? loc.lat : null;
        const deviceLng = hasDeviceOriginLocation ? loc.lng : null;
        const verification = await verifyEventPostingPermission(
          targetEventId,
          req.user.id,
          deviceLat,
          deviceLng
        );
        if (!verification.allowed) {
          // Emit a lightweight Sentry/info message so spikes in geofence denials
          // become visible in Sentry (alerts/metrics) and include context useful
          // for debugging without exposing sensitive request bodies.
          try {
            // captureMessage is a thin wrapper that tags the event and scrubs
            // request data per lib/sentry.ts policies.
            captureMessage('Geofence denial during POST /posts', 'info', {
              context: 'geofence_denial',
              route: req.originalUrl || req.path,
              user_id: req.user.id,
              event_id: targetEventId,
              code: verification.code || null,
              reason: verification.reason || null,
              distance_km: typeof verification.distance === 'number' ? verification.distance : null,
            });
          } catch (e) {
            // Best-effort logging only; do not fail the request on Sentry errors.
            console.warn('[posts] failed to emit geofence denial telemetry', e);
          }

          return res.status(403).json({
            error: verification.code || 'LOCATION_VERIFICATION_FAILED',
            message: verification.reason,
            distance: verification.distance,
          });
        }
        debugLog(
          `✅ User ${req.user.id} verified at event location (${verification.distance?.toFixed(2)} km away)`
        );
      } else if (gameId) {
        // Game exists but has no associated event — no location data to verify against.
        // Block normal posting when geofencing cannot be enforced.
        return res.status(403).json({
          error: 'NO_EVENT_LOCATION',
          message:
            'This game has no event with location data, so posting is disabled until the event location is set.',
        });
      }
    }

    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    // If team_id provided, verify user is coach/owner of that team
    let finalTeamId: string | null = null;
    if (data.team_id) {
      const team = await prisma.team.findUnique({ where: { id: data.team_id } });
      if (!team) return res.status(404).json({ error: 'Team not found' });
      const canManage = await canManageTeamScoped(req.user.id, data.team_id);
      if (!canManage) {
        return res
          .status(403)
          .json({ error: 'Only team staff or organization admins can post to their team page' });
      }
      finalTeamId = data.team_id;
    }

    // Attach the post directly to its event (real, non-sample events only) so it
    // associates with event-only pages that have no game, and so its author can
    // qualify for the open-ended post-event upload window via event_id.
    let finalEventId = eventId ? String(eventId) : null;

    // Denormalize the event/game link in BOTH directions. A post tied to a
    // game or event must carry game_id AND event_id whenever both exist, so
    // that game-keyed and event-keyed reads are symmetric and the post-detail
    // context card always resolves. The server is the single writer of this
    // link — the client only supplies whichever id it had in hand.
    if (finalGameId && !finalEventId) {
      // Reuse the event found during geofencing; only query if we skipped it
      // (e.g. admin/demo bypass never looked the game up).
      if (derivedEventIdFromGame) {
        finalEventId = derivedEventIdFromGame;
      } else {
        const g = await prisma.game.findUnique({
          where: { id: finalGameId },
          select: { events: { orderBy: { date: 'asc' }, take: 1, select: { id: true } } },
        });
        finalEventId = g?.events?.[0]?.id ?? null;
      }
    } else if (finalEventId && !finalGameId) {
      const e = await prisma.event.findUnique({
        where: { id: finalEventId },
        select: { game_id: true },
      });
      finalGameId = e?.game_id ?? null;
    }

    // Reserved post types are privileged read-side magic values (e.g.
    // admin_broadcast fans out to EVERY user's feed, bypassing the follow graph
    // and block/private filters). Only a verified admin may create one — a fan
    // supplying the type is coerced to a normal post. Audit 2026-07-14 (live).
    const RESERVED_POST_TYPES = new Set(['admin_broadcast']);
    const requestedType = data.type || 'post';
    const isBroadcastAdmin = await getIsAdmin(req as any);
    const safeType =
      RESERVED_POST_TYPES.has(requestedType) && !isBroadcastAdmin ? 'post' : requestedType;

    const post = await prisma.post.create({
      data: {
        title: finalTitle ? stripHtml(finalTitle) : null,
        content: data.content ? stripHtml(data.content.trim()) : null,
        type: safeType,
        media_url: data.media_url,
        poster_url: data.poster_url,
        media_width: data.media_width,
        media_height: data.media_height,
        media_duration_s: data.media_duration_s,
        media_bytes: data.media_bytes,
        game_id: finalGameId,
        event_id: finalEventId || undefined,
        team_id: finalTeamId || undefined,
        author_id: req.user.id,
        country_code: country_code || undefined,
        admin1: admin1 || undefined,
        lat: typeof lat === 'number' ? lat : undefined,
        lng: typeof lng === 'number' ? lng : undefined,
      },
    });

    // Mention notifications (parse @username from content)
    const contentForMentions = data.content?.trim() ?? '';
    if (contentForMentions && req.user) {
      const actorId = req.user.id;
      prisma.user
        .findUnique({
          where: { id: actorId },
          select: { display_name: true },
        })
        .then(actor => {
          notifyMentions({
            content: contentForMentions,
            actorId,
            actorName: actor?.display_name || 'Someone',
            postId: post.id,
            context: 'post',
          }).catch(e => console.error('[notif] post mention push failed', e));
        })
        .catch(e => console.error('[notif] post mention actor lookup failed', e));
    }

    res.status(201).json({
      ...post,
      title: stripSampleGameTitle(post.title),
      preview_url: resolvePreviewUrl(post),
      location: { lat, lng, place_name, country_code },
    });
  })
);

postsRouter.post(
  '/:id/poll',
  requireAuth as any,
  requireVerified as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const postId = String(req.params.id);
    const userId = req.user!.id;

    const schema = z.object({
      options: z.array(z.string().min(1).max(100)).min(2).max(5),
      expires_at: z.string().datetime().optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid payload', issues: parsed.error.issues });
    }

    const { options, expires_at } = parsed.data;

    const post = await prisma.post.findFirst({
      where: { id: postId, deleted_at: null },
      select: { id: true, author_id: true, game_id: true },
    });
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    if (post.author_id !== userId) {
      return res.status(403).json({ error: 'Only the post author can create a poll' });
    }

    const eligibility = await getPostPollEligibility(post);
    if (!eligibility.ok) {
      return res.status(eligibility.status).json(eligibility.body);
    }

    try {
      const poll = await prisma.poll.create({
        data: {
          post_id: postId,
          expires_at: expires_at ? new Date(expires_at) : undefined,
          options: {
            create: options.map(text => ({ text: stripHtml(text) })),
          },
        },
        include: {
          options: true,
        },
      });

      res.status(201).json(poll);
    } catch (error: any) {
      if (!isMissingPollSchemaError(error)) {
        console.error('[posts] Failed to create poll:', error);
        return res.status(500).json({ error: 'Failed to create poll' });
      }
      logPollSchemaFallback('POST /posts/:id/poll', error);
      return res.status(503).json({
        error: 'POLL_FEATURE_UNAVAILABLE',
        message: 'Polls are temporarily unavailable. Please try again shortly.',
      });
    }
  })
);

postsRouter.post(
  '/:id/poll/vote',
  requireAuth as any,
  requireVerified as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const postId = String(req.params.id);
    const userId = req.user!.id;

    const schema = z.object({
      option_id: z.string(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid payload', issues: parsed.error.issues });
    }

    const { option_id } = parsed.data;

    const postExists = await prisma.post.findFirst({
      where: { id: postId, deleted_at: null },
      select: { id: true, game_id: true },
    });
    if (!postExists) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const eligibility = await getPostPollEligibility(postExists);
    if (!eligibility.ok) {
      return res.status(eligibility.status).json(eligibility.body);
    }

    let poll: any;
    try {
      poll = await prisma.poll.findUnique({
        where: { post_id: postId },
        include: { options: true },
      });
    } catch (error: any) {
      if (!isMissingPollSchemaError(error)) {
        console.error('[posts] Failed to load poll for voting:', error);
        return res.status(500).json({ error: 'Failed to load poll' });
      }
      logPollSchemaFallback('POST /posts/:id/poll/vote', error);
      return res.status(503).json({
        error: 'POLL_FEATURE_UNAVAILABLE',
        message: 'Poll voting is temporarily unavailable. Please try again shortly.',
      });
    }
    if (!poll) {
      return res.status(404).json({ error: 'Poll not found' });
    }

    // Check if poll has expired — polls stay open until midnight UTC the day after expires_at
    // (covers all US timezones, matches the game-details vote window behavior)
    if (poll.expires_at) {
      const expiresDate = new Date(poll.expires_at);
      const endOfExpiryDay = new Date(
        Date.UTC(
          expiresDate.getUTCFullYear(),
          expiresDate.getUTCMonth(),
          expiresDate.getUTCDate() + 1
        )
      );
      if (new Date() >= endOfExpiryDay) {
        return res.status(403).json({ error: 'Poll has closed', code: 'POLL_EXPIRED' });
      }
    }

    const option = poll.options.find((o: any) => o.id === option_id);
    if (!option) {
      return res.status(404).json({ error: 'Poll option not found' });
    }

    // Read existing vote AND mutate inside one Serializable transaction. The
    // DB unique is on (poll_option_id, user_id), NOT (poll_id, user_id), so a
    // plain check-then-create let two concurrent taps on DIFFERENT options both
    // succeed → two votes in one poll. Serializable makes the concurrent txns
    // conflict instead. Audit 2026-07-14.
    let alreadyCast = false;
    try {
      await prisma.$transaction(
        async tx => {
          const existingVote = await tx.pollVote.findFirst({
            where: { poll_option: { poll_id: poll.id }, user_id: userId },
          });
          if (existingVote) {
            if (existingVote.poll_option_id === option_id) {
              alreadyCast = true;
              return;
            }
            // Change vote: remove the old, add the new.
            await tx.pollVote.delete({ where: { id: existingVote.id } });
            await tx.pollOption.update({
              where: { id: existingVote.poll_option_id },
              data: { votes_count: { decrement: 1 } },
            });
            await tx.pollVote.create({ data: { poll_option_id: option_id, user_id: userId } });
            await tx.pollOption.update({
              where: { id: option_id },
              data: { votes_count: { increment: 1 } },
            });
          } else {
            await tx.pollVote.create({ data: { poll_option_id: option_id, user_id: userId } });
            await tx.pollOption.update({
              where: { id: option_id },
              data: { votes_count: { increment: 1 } },
            });
          }
        },
        { isolationLevel: 'Serializable' }
      );
    } catch (e: any) {
      // Unique collision (P2002) or serialization conflict (P2034): a concurrent
      // vote won — the invariant (one vote per poll) holds, so report success.
      if (e?.code === 'P2002' || e?.code === 'P2034') {
        return res.status(200).json({ message: 'Vote already cast' });
      }
      throw e;
    }
    if (alreadyCast) {
      return res.status(200).json({ message: 'Vote already cast' });
    }

    const updatedPoll = await prisma.poll.findUnique({
      where: { post_id: postId },
      include: {
        options: true,
      },
    });

    // Return serialized poll with the voted option
    if (!updatedPoll) {
      return res.status(404).json({ error: 'Poll not found' });
    }
    const postForQuestion = await prisma.post.findUnique({
      where: { id: postId },
      select: { content: true },
    });
    res.status(200).json(serializePoll(updatedPoll, postForQuestion?.content ?? null, option_id));
  })
);

postsRouter.get(
  '/:id',
  asyncHandler(async (req: AuthedRequest, res) => {
    const { id } = req.params;
    const currentUserId = req.user?.id ?? null;

    let post: any;
    try {
      post = await prisma.post.findFirst({
        where: { id, deleted_at: null },
        include: {
          author: { select: { id: true, username: true, display_name: true, avatar_url: true } },
          game: { select: { id: true, title: true, home_team: true, away_team: true, date: true } },
          event: { select: { id: true, title: true, date: true, location: true, game_id: true } },
          _count: { select: { comments: true, bookmarks: true } },
          poll: { include: { options: true } },
        },
      });
    } catch (error: any) {
      if (!isMissingPollSchemaError(error)) {
        console.error('[posts] Failed to fetch post:', error);
        return res.status(500).json({ error: 'Failed to fetch post' });
      }
      logPollSchemaFallback('GET /posts/:id', error);
      post = await prisma.post.findFirst({
        where: { id, deleted_at: null },
        include: {
          author: { select: { id: true, username: true, display_name: true, avatar_url: true } },
          game: { select: { id: true, title: true, home_team: true, away_team: true, date: true } },
          event: { select: { id: true, title: true, date: true, location: true, game_id: true } },
          _count: { select: { comments: true, bookmarks: true } },
        },
      });
    }

    if (!post) return res.status(404).json({ error: 'Not found' });

    // Privacy: hide posts from private-profile authors the viewer doesn't follow
    if (post.author_id) {
      const hidden = await isAuthorHiddenFromViewer(post.author_id, currentUserId);
      if (hidden) return res.status(404).json({ error: 'Not found' });
    }

    // Block filtering: hide posts from blocked users
    if (post.author_id && currentUserId) {
      const blockedIds = await getBlockedUserIds(currentUserId, getRequestBlockedCache(req));
      if (blockedIds.includes(post.author_id)) return res.status(404).json({ error: 'Not found' });
    }

    let has_upvoted = false;
    let has_bookmarked = false;
    let is_following_author = false;
    let user_vote: string | null = null;

    if (currentUserId && post) {
      const [upvotes, bookmarks, follows, pollVote] = await Promise.all([
        prisma.postUpvote.findUnique({
          where: { post_id_user_id: { post_id: id, user_id: currentUserId } },
        }),
        prisma.postBookmark.findUnique({
          where: { post_id_user_id: { post_id: id, user_id: currentUserId } },
        }),
        post.author_id
          ? prisma.follows.findUnique({
              where: {
                follower_id_following_id: {
                  follower_id: currentUserId,
                  following_id: post.author_id,
                },
              },
            })
          : null,
        post.poll
          ? prisma.pollVote.findFirst({
              where: { user_id: currentUserId, poll_option: { poll_id: post.poll.id } },
            })
          : null,
      ]);

      has_upvoted = !!upvotes;
      has_bookmarked = !!bookmarks;
      is_following_author = !!follows;
      user_vote = pollVote?.poll_option_id || null;
    }

    // Drop precise capture coordinates: `post` comes from an `include:` query
    // (all scalar columns), and lat/lng must never reach clients — they expose
    // where a user (often a minor) was filmed. country_code stays; it is coarse.
    const { lat: _lat, lng: _lng, ...postForResponse } = post;
    const response = {
      ...postForResponse,
      title: stripSampleGameTitle(post.title), // Clean sample game marker from title
      has_upvoted,
      has_bookmarked,
      is_following_author,
      media_type: detectMediaType(post.media_url),
      preview_url: resolvePreviewUrl(post),
      caption: post.content ?? null,
      bookmarks_count: post._count?.bookmarks ?? 0,
      comments_count: post._count?.comments ?? 0,
      poll: post.poll ? serializePoll(post.poll, post.content, user_vote) : null,
      game: post.game
        ? {
            id: post.game.id,
            title: post.game.title,
            home_team: post.game.home_team,
            away_team: post.game.away_team,
            date: post.game.date,
          }
        : null,
      // Event card for the post-detail context row. Present whenever the post
      // is linked to an event — including event-only posts (no game), so the
      // "vice versa" tie renders even when there is no game to show.
      event: post.event
        ? {
            id: post.event.id,
            title: post.event.title,
            date: post.event.date,
            location: post.event.location ?? null,
            game_id: post.event.game_id ?? null,
          }
        : null,
    };

    res.json(response);
  })
);

// Comments
postsRouter.get(
  '/:id/comments',
  asyncHandler(async (req: AuthedRequest, res) => {
    const { id } = req.params;
    const post = await prisma.post.findFirst({
      where: { id, deleted_at: null },
      select: { id: true, author_id: true },
    });
    if (!post) return res.status(404).json({ error: 'Post not found' });
    // Privacy: block comments on private-profile authors' posts for non-followers
    if (post.author_id) {
      const hidden = await isAuthorHiddenFromViewer(post.author_id, req.user?.id ?? null);
      if (hidden) return res.status(404).json({ error: 'Post not found' });
    }
    const limit = Math.max(1, Math.min(parseInt(String(req.query.limit ?? '20'), 10) || 20, 50));
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
    // Filter out comments from blocked users
    const blockedIds = await getBlockedUserIds(req.user?.id ?? null, getRequestBlockedCache(req));
    const commentWhere: any = { post_id: id };
    if (blockedIds.length) {
      commentWhere.author_id = { notIn: blockedIds };
    }
    const query: any = {
      where: commentWhere,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      include: {
        author: { select: { id: true, username: true, display_name: true, avatar_url: true } },
      },
      take: limit + 1,
    };
    if (cursor) {
      query.cursor = { id: cursor };
      query.skip = 1;
    }
    // audit-allow unbounded: comment query object already includes take: limit + 1
    const rows = await prisma.comment.findMany(query);
    const items = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? rows[limit].id : null;
    res.json({ items, nextCursor });
  })
);

postsRouter.post(
  '/:id/comments',
  requireAuth as any,
  requireVerified as any,
  requireOnboarded as any,
  commentLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    // req.user is guaranteed by requireAuth middleware
    const { id } = req.params;

    // v1.0.2 pass 8: banned users were blocked from DMs but could still post comments.
    // Symmetric enforcement: ban applies to all user-generated content, not just messages.
    const sender = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { banned: true, banned_until: true },
    });
    const nowTs = new Date();
    if (sender?.banned || (sender?.banned_until && sender.banned_until > nowTs)) {
      return res
        .status(403)
        .json({ error: 'Your account is suspended from posting.', code: 'USER_BANNED' });
    }

    const post = await prisma.post.findFirst({
      where: { id, deleted_at: null },
      select: { id: true, author_id: true, author: { select: { id: true, preferences: true } } },
    });
    if (!post) return res.status(404).json({ error: 'Post not found' });

    // Block interaction with hidden/blocked authors' posts
    const isHidden = await isAuthorHiddenFromViewer(post.author_id, req.user!.id);
    if (isHidden) return res.status(404).json({ error: 'Post not found' });
    const blockedIds = await getBlockedUserIds(req.user!.id, getRequestBlockedCache(req));
    if (blockedIds.includes(post.author_id))
      return res.status(404).json({ error: 'Post not found' });

    // Enforce comment_permission: everyone | following | none (post author's preference)
    const prefs = ((post as any).author?.preferences || {}) as any;
    const commentPermission = prefs?.comment_permission ?? 'everyone';
    if (commentPermission === 'none') {
      return res.status(403).json({
        error: 'Comments are disabled on this post.',
        code: 'COMMENTS_DISABLED',
      });
    }
    if (commentPermission === 'following' && post.author_id !== req.user!.id) {
      const follows = await prisma.follows.findFirst({
        where: { follower_id: req.user!.id, following_id: post.author_id, status: 'accepted' },
        select: { follower_id: true },
      });
      if (!follows) {
        return res.status(403).json({
          error: 'Only people who follow this user can comment.',
          code: 'COMMENTS_FOLLOWING_ONLY',
        });
      }
    }

    const schema = z.object({
      content: z.string().min(1).max(1000),
      parent_id: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid payload',
        issues: parsed.error.issues.map(i => ({ path: i.path, message: i.message })),
      });
    }

    const { content, parent_id } = parsed.data;
    const sanitizedContent = stripHtml(content);

    // Dedup guard: reject if identical comment submitted within 30s window
    if (isDuplicateComment(req.user!.id, id, sanitizedContent)) {
      return res.status(409).json({
        error: 'Duplicate comment detected. Please wait before commenting again.',
        code: 'DUPLICATE_COMMENT',
      });
    }

    // Validate parent_id and create the reply atomically. Doing the find +
    // create as separate awaits lets the parent be deleted in the gap, and
    // because the parent FK is `onDelete: SetNull`, Prisma won't fail the
    // insert — the new reply ends up with a parent_id pointing at a row
    // that's already gone (resolves to null on next read). Wrapping in
    // $transaction keeps the read+write tied together.
    let comment;
    try {
      comment = await prisma.$transaction(async tx => {
        if (parent_id) {
          const parentComment = await tx.comment.findFirst({
            where: { id: parent_id, post_id: id },
            select: { id: true },
          });
          if (!parentComment) {
            // Sentinel — re-thrown so the transaction rolls back. Caught
            // below and translated to a 404 response.
            throw new Error('__PARENT_NOT_FOUND__');
          }
        }
        return tx.comment.create({
          data: {
            post_id: id,
            author_id: req.user!.id,
            content: sanitizedContent,
            parent_id: parent_id || undefined,
          },
          include: {
            author: { select: { id: true, username: true, display_name: true, avatar_url: true } },
          },
        });
      });
    } catch (err: any) {
      if (err?.message === '__PARENT_NOT_FOUND__') {
        return res.status(404).json({ error: 'Parent comment not found' });
      }
      throw err;
    }

    const actorName = comment.author?.display_name || 'Someone';

    try {
      if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
      const postAuthorId = post.author_id;

      // Notify post author (if not self, and not a reply - replies notify comment author instead for COMMENT type)
      const isReply = !!parent_id;
      if (postAuthorId && postAuthorId !== req.user.id && !isReply) {
        await prisma.notification.create({
          data: {
            user_id: postAuthorId,
            actor_id: req.user.id,
            type: 'COMMENT',
            post_id: id,
            comment_id: comment.id,
          },
        });
        notifyPostInteraction(postAuthorId, 'comment', req.user.id, actorName, id).catch(e =>
          console.error('[notif] comment push failed', e)
        );
      }

      // Reply-to-comment: notify parent comment author
      if (parent_id) {
        const parentComment = await prisma.comment.findFirst({
          where: { id: parent_id },
          include: { author: { select: { id: true } } },
        });
        const parentAuthorId = parentComment?.author?.id;
        if (parentAuthorId && parentAuthorId !== req.user.id) {
          await prisma.notification.create({
            data: {
              user_id: parentAuthorId,
              actor_id: req.user.id,
              type: 'COMMENT_REPLY',
              post_id: id,
              comment_id: comment.id,
              meta: { parent_comment_id: parent_id },
            },
          });
          notifyCommentReply(parentAuthorId, req.user.id, actorName, id, comment.id).catch(e =>
            console.error('[notif] comment reply push failed', e)
          );
        }
      }

      // Mention notifications (parse @username from content)
      notifyMentions({
        content,
        actorId: req.user.id,
        actorName,
        postId: id,
        commentId: comment.id,
        context: 'comment',
      }).catch(e => console.error('[notif] comment mention push failed', e));
    } catch (e) {
      console.error('Failed to send comment notification:', e);
    }
    res.status(201).json(comment);
  })
);

// Reactions
// Toggle upvote

postsRouter.post(
  '/:id/upvote',
  requireAuth as any,
  requireVerified as any,
  interactionLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const postId = String(req.params.id);
      const userId = req.user!.id;

      const postExists = await prisma.post.findFirst({
        where: { id: postId, deleted_at: null },
        select: { id: true, author_id: true },
      });
      if (!postExists) return res.status(404).json({ error: 'Post not found' });
      const upvoteHidden = await isAuthorHiddenFromViewer(postExists.author_id, userId);
      if (upvoteHidden) return res.status(404).json({ error: 'Post not found' });
      const upvoteBlocked = await getBlockedUserIds(userId, getRequestBlockedCache(req));
      if (upvoteBlocked.includes(postExists.author_id))
        return res.status(404).json({ error: 'Post not found' });

      // Atomic upvote toggle — check + mutate inside one Serializable transaction to prevent race conditions
      const result = await prisma.$transaction(
        async tx => {
          const existing = await tx.postUpvote.findUnique({
            where: { post_id_user_id: { post_id: postId, user_id: userId } },
          });
          if (existing) {
            await tx.postUpvote.delete({
              where: { post_id_user_id: { post_id: postId, user_id: userId } },
            });
            const updated = await tx.post.update({
              where: { id: postId },
              data: { upvotes_count: { decrement: 1 } },
              select: { upvotes_count: true },
            });
            return { has_upvoted: false, upvotes_count: updated.upvotes_count };
          }
          await tx.postUpvote.create({ data: { post_id: postId, user_id: userId } });
          const updated = await tx.post.update({
            where: { id: postId },
            data: { upvotes_count: { increment: 1 } },
            select: { upvotes_count: true },
          });
          return { has_upvoted: true, upvotes_count: updated.upvotes_count };
        },
        { isolationLevel: 'Serializable' }
      );

      if (!result.has_upvoted) {
        return res.json({
          has_upvoted: false,
          upvotes_count: result.upvotes_count,
          upvoted: false,
          count: result.upvotes_count,
        });
      }
      const { upvotes_count } = result;

      // Notify post author (if not self)
      try {
        const post = await prisma.post.findFirst({
          where: { id: postId, deleted_at: null },
          select: {
            author_id: true,
            author: { select: { display_name: true } },
          },
        });
        const recipient = post?.author_id;
        if (recipient && recipient !== userId) {
          await (prisma as any).notification.create({
            data: { user_id: recipient, actor_id: userId, type: 'UPVOTE', post_id: postId },
          });

          // Send push notification
          const actor = await prisma.user.findUnique({
            where: { id: userId },
            select: { display_name: true },
          });
          if (actor) {
            notifyPostInteraction(
              recipient,
              'like',
              userId,
              actor.display_name || 'Someone',
              postId
            ).catch(e => console.error('[notif] upvote push failed', e));
          }
        }
      } catch (e) {
        console.error('Failed to send upvote notification:', e);
      }
      return res.json({ has_upvoted: true, upvotes_count, upvoted: true, count: upvotes_count });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err || '');
      const code = (err as any)?.code;
      // Concurrent toggles can hit Serializable retry errors under load. Surface the
      // settled state instead of leaking a 500 for a user double-tap.
      if (code === 'P2034' || /serialize|serialization|write conflict|deadlock/i.test(message)) {
        const [existing, post] = await Promise.all([
          prisma.postUpvote.findUnique({
            where: { post_id_user_id: { post_id: String(req.params.id), user_id: req.user!.id } },
          }),
          prisma.post.findUnique({
            where: { id: String(req.params.id) },
            select: { upvotes_count: true },
          }),
        ]);
        const upvotesCount = post?.upvotes_count ?? 0;
        return res.json({
          has_upvoted: !!existing,
          upvotes_count: upvotesCount,
          upvoted: !!existing,
          count: upvotesCount,
        });
      }
      console.error('[posts] upvote error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

postsRouter.post(
  '/:id/bookmark',
  requireAuth as any,
  requireVerified as any,
  interactionLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    const postId = String(req.params.id);
    const userId = req.user!.id;

    const postExists = await prisma.post.findFirst({
      where: { id: postId, deleted_at: null },
      select: { id: true, author_id: true },
    });
    if (!postExists) return res.status(404).json({ error: 'Post not found' });
    const bmHidden = await isAuthorHiddenFromViewer(postExists.author_id, userId);
    if (bmHidden) return res.status(404).json({ error: 'Post not found' });
    const bmBlocked = await getBlockedUserIds(userId, getRequestBlockedCache(req));
    if (bmBlocked.includes(postExists.author_id))
      return res.status(404).json({ error: 'Post not found' });

    const existing = await prisma.postBookmark.findUnique({
      where: { post_id_user_id: { post_id: postId, user_id: userId } },
    });
    if (existing) {
      // deleteMany is idempotent (no P2025 if a concurrent tap already removed it)
      await prisma.postBookmark.deleteMany({ where: { post_id: postId, user_id: userId } });
      const bookmarks_count = await prisma.postBookmark.count({ where: { post_id: postId } });
      return res.json({ has_bookmarked: false, bookmarks_count, bookmarked: false });
    }

    try {
      await prisma.postBookmark.create({ data: { post_id: postId, user_id: userId } });
    } catch (e: any) {
      // Concurrent double-tap: the unique key already exists — treat as an
      // idempotent no-op instead of a 500. (Was an unhandled P2002.)
      if (e?.code !== 'P2002') throw e;
    }
    const bookmarks_count = await prisma.postBookmark.count({ where: { post_id: postId } });
    return res.json({ has_bookmarked: true, bookmarks_count, bookmarked: true });
  })
);

// Share post (tracks share for notifications)
// v1.0.2 pass 12: interactionLimiter matches /upvote and /bookmark — without it a single
// user could spam share notifications to any author as fast as the network allows.
postsRouter.post(
  '/:id/share',
  requireAuth as any,
  requireVerified as any,
  interactionLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    const postId = String(req.params.id);
    const userId = req.user!.id;

    const post = await prisma.post.findFirst({
      where: { id: postId, deleted_at: null },
      select: { id: true, author_id: true, author: { select: { display_name: true } } },
    });
    if (!post) return res.status(404).json({ error: 'Post not found' });
    const shareHidden = await isAuthorHiddenFromViewer(post.author_id, userId);
    if (shareHidden) return res.status(404).json({ error: 'Post not found' });
    const shareBlocked = await getBlockedUserIds(userId, getRequestBlockedCache(req));
    if (shareBlocked.includes(post.author_id))
      return res.status(404).json({ error: 'Post not found' });

    const postAuthorId = post.author_id;
    if (postAuthorId && postAuthorId !== userId) {
      try {
        await prisma.notification.create({
          data: {
            user_id: postAuthorId,
            actor_id: userId,
            type: 'SHARE',
            post_id: postId,
          },
        });
        const actor = await prisma.user.findUnique({
          where: { id: userId },
          select: { display_name: true },
        });
        notifyPostInteraction(
          postAuthorId,
          'share',
          userId,
          actor?.display_name || 'Someone',
          postId
        ).catch(e => console.error('[notif] share push failed', e));
      } catch (e) {
        console.error('Failed to send share notification:', e);
      }
    }
    return res.json({ shared: true });
  })
);

// Delete post (author, or coach/owner of team the post is associated with)
postsRouter.delete(
  '/:id',
  requireAuth as any,
  // NO requireOnboarded here — on purpose.
  //
  // Deleting your own content is a data right, not a "coach feature". This route
  // used to sit behind requireOnboarded, which 403s a coach whose approval is
  // PENDING/REJECTED, and a coach whose accepted agreement version is stale
  // (requireOnboarded.ts:134-149). Those users could delete their own COMMENT
  // (that route has only requireAuth) but not their own POST — an inconsistency,
  // not a policy. Authorization is still fully enforced below: author, team coach,
  // or admin only.
  asyncHandler(async (req: AuthedRequest, res) => {
    const postId = String(req.params.id);
    const userId = req.user!.id;

    try {
      const post = await prisma.post.findFirst({
        where: { id: postId, deleted_at: null },
        select: {
          id: true,
          author_id: true,
          team_id: true,
          game_id: true,
          media_url: true,
          poster_url: true,
        },
      });

      if (!post) {
        // Idempotent retry path (2026-07-08 incident): a client that timed out and
        // retried after the delete actually landed must get a fast success, not a 404
        // it surfaces as "Failed to delete post". Authorization is re-checked so an
        // unauthorized caller still sees the same 404 as a nonexistent post.
        const alreadyDeleted = await prisma.post.findFirst({
          where: { id: postId, deleted_at: { not: null } },
          select: { id: true, author_id: true, team_id: true, game_id: true, deleted_at: true },
        });
        if (alreadyDeleted) {
          const retryIsAuthor = alreadyDeleted.author_id === userId;
          const retryIsCoach = retryIsAuthor
            ? false
            : await isCoachOfPostTeam(userId, alreadyDeleted);
          const retryIsAdmin = retryIsAuthor || retryIsCoach ? false : await getIsAdmin(req as any);
          if (retryIsAuthor || retryIsCoach || retryIsAdmin) {
            return res.json({
              message: 'Post deleted successfully',
              deleted_at: alreadyDeleted.deleted_at!.toISOString(),
              already_deleted: true,
            });
          }
        }
        return sendError(res, 404, 'Post not found');
      }

      const isAuthor = post.author_id === userId;
      const isTeamCoach = await isCoachOfPostTeam(userId, post);
      const isAdminUser = await getIsAdmin(req as any);
      if (!isAuthor && !isTeamCoach && !isAdminUser) {
        return res
          .status(403)
          .json({ error: 'You can only delete your own posts or posts on your team page' });
      }

      // Soft-delete FIRST, as a single autocommit statement — deliberately NOT an
      // interactive transaction. 2026-07-08 incident: a ~70s Postgres WAL/disk stall
      // left the old $transaction's COMMIT hanging past its 5s budget while it held
      // the Post row lock, so 23 client retries piled up behind it, all failed with
      // P2028, and the stuck transactions exhausted the connection pool (broke
      // unrelated auth checks). The notification cleanup below is cosmetic and must
      // not gate or share fate with the user-visible delete.
      const deletedAt = new Date();
      await prisma.post.update({ where: { id: postId }, data: { deleted_at: deletedAt } });

      // Best-effort cleanup: remove notifications pointing at the deleted post and
      // its comments. A failure here leaves only stale notifications (their taps
      // already handle missing posts); never fail the delete over it.
      try {
        // audit-allow unbounded: delete must enumerate every comment id on the post to clear linked notifications
        const commentIds = await prisma.comment.findMany({
          where: { post_id: postId },
          select: { id: true },
        });
        const notificationWhere: any = { post_id: postId };
        if (commentIds.length > 0) {
          notificationWhere.OR = [
            { post_id: postId },
            { comment_id: { in: commentIds.map(comment => comment.id) } },
          ];
          delete notificationWhere.post_id;
        }

        await prisma.notification.deleteMany({ where: notificationWhere });
      } catch (cleanupErr) {
        console.warn(
          '[posts] notification cleanup after delete failed for post',
          postId,
          cleanupErr
        );
      }

      // Destroy the stored media so deleted content doesn't stay publicly
      // retrievable by URL. Handles BOTH storage backends: Cloudinary assets and
      // R2 objects (media migrated to R2 2026-07; the Cloudinary-only path used
      // to leave R2 objects orphaned forever). Fire-and-forget — a storage
      // hiccup must not block the user's delete; the row is already soft-deleted.
      const mediaUrls = [
        (post as any).media_url as string | null | undefined,
        (post as any).poster_url as string | null | undefined,
      ].filter((u): u is string => Boolean(u));
      if (mediaUrls.length) {
        void (async () => {
          const [{ extractCloudinaryPublicId, destroyCloudinaryAsset }, { deleteR2ObjectByUrl }] =
            await Promise.all([import('../lib/cloudinary.js'), import('../lib/r2.js')]);
          for (const url of mediaUrls) {
            try {
              const parsed = extractCloudinaryPublicId(url);
              if (parsed) {
                const result = await destroyCloudinaryAsset(parsed.publicId, parsed.resourceType);
                if (!result.ok) {
                  console.warn(
                    '[posts] Cloudinary destroy failed',
                    postId,
                    parsed.publicId,
                    result.error
                  );
                }
                continue;
              }
              // Not a Cloudinary URL — try R2 (no-op if not an R2 URL).
              await deleteR2ObjectByUrl(url);
            } catch (err) {
              console.warn('[posts] media destroy threw for post', postId, err);
            }
          }
        })();
      }

      // Notify post author when admin takes down their post (not when they delete their own)
      if (isAdminUser && !isAuthor && post.author_id) {
        try {
          const { sendPushNotification } = await import('../lib/notifications.js');
          void sendPushNotification(
            post.author_id,
            'Post Removed',
            'Your post was removed by a moderator for violating community guidelines.',
            { type: 'post_removed', post_id: postId }
          ).catch(pushErr => {
            console.warn('[posts] Failed to send post removed push:', pushErr);
          });
          await prisma.notification.create({
            data: {
              user_id: post.author_id,
              type: 'post_removed' as any,
              meta: { post_id: postId, reason: 'Removed by moderator' },
            },
          });

          const author = await prisma.user.findUnique({
            where: { id: post.author_id },
            select: { email: true, display_name: true },
          });
          if (author?.email) {
            const { sendContentRemovedEmail } = await import('../lib/email.js');
            sendContentRemovedEmail({
              to: author.email,
              authorName: author.display_name || undefined,
              contentType: 'post',
            }).catch(err =>
              console.warn('[posts] sendContentRemovedEmail failed:', err?.message ?? err)
            );
          }
        } catch (notifErr) {
          console.warn('[posts] Failed to notify author of takedown:', notifErr);
        }
      }

      res.json({
        message: 'Post deleted successfully',
        deleted_at: deletedAt.toISOString(),
      });
    } catch (error) {
      console.error('Error deleting post:', error);
      res.status(500).json({ error: 'Failed to delete post' });
    }
  })
);

// Restore a recently deleted post (author only, within POST_UNDO_WINDOW_MS)
// v1.0.2: restore endpoint was previously stubbed with 410. Soft-delete exists (sets deleted_at),
// so the undo window is now wired up properly. Hard-delete happens via a separate cleanup path.
postsRouter.post(
  '/:id/restore',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const postId = String(req.params.id);
    const userId = req.user!.id;
    try {
      const post = await prisma.post.findFirst({
        where: { id: postId, deleted_at: { not: null } },
        select: { id: true, author_id: true, deleted_at: true },
      });
      if (!post) {
        return res.status(404).json({
          error: 'POST_NOT_FOUND',
          message: 'Post not found or not in a restorable state.',
        });
      }
      if (post.author_id !== userId) {
        return res
          .status(403)
          .json({ error: 'Only the post author can restore it.', code: 'NOT_AUTHOR' });
      }
      const elapsed = post.deleted_at ? Date.now() - new Date(post.deleted_at).getTime() : Infinity;
      if (elapsed > POST_UNDO_WINDOW_MS) {
        return res.status(410).json({
          error: 'UNDO_WINDOW_EXPIRED',
          message: 'The undo window has expired.',
          window_ms: POST_UNDO_WINDOW_MS,
        });
      }
      await prisma.post.update({ where: { id: postId }, data: { deleted_at: null } });
      return res.json({ ok: true, post_id: postId });
    } catch (error: any) {
      console.error('[posts] restore error:', error?.message || error);
      return res.status(500).json({ error: 'Failed to restore post' });
    }
  })
);

// Update post (author: content/title/is_pinned; coach of team: is_pinned only)
postsRouter.patch(
  '/:id',
  requireAuth as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const postId = String(req.params.id);
    const userId = req.user!.id;

    const schema = z.object({
      content: z.string().min(1).max(4000).optional(), // VAL-1: Aligned with frontend maxLength=4000
      title: z.string().max(200).optional(),
      is_pinned: z.boolean().optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid payload', issues: parsed.error.issues });
    }

    try {
      const post = await prisma.post.findFirst({
        where: { id: postId, deleted_at: null },
        select: { id: true, author_id: true, team_id: true, game_id: true },
      });

      if (!post) {
        return res.status(404).json({ error: 'Post not found' });
      }

      const isAuthor = post.author_id === userId;
      const isTeamCoach = await isCoachOfPostTeam(userId, post);

      let updateData: Record<string, unknown> = {};
      if (isAuthor) {
        // Sanitize user-supplied text fields to prevent XSS in edited posts
        const { content, title, ...rest } = parsed.data;
        updateData = {
          ...rest,
          ...(content !== undefined ? { content: stripHtml(content) } : {}),
          ...(title !== undefined ? { title: stripHtml(title) } : {}),
        };
      } else if (isTeamCoach && parsed.data.is_pinned !== undefined) {
        // Coach can only toggle is_pinned
        updateData = { is_pinned: parsed.data.is_pinned };
      } else {
        return res
          .status(403)
          .json({ error: 'You can only edit your own posts or pin posts on your team page' });
      }

      if (Object.keys(updateData).length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' });
      }

      const updatedPost = await prisma.post.update({
        where: { id: postId },
        data: updateData,
        include: {
          author: { select: { id: true, username: true, display_name: true, avatar_url: true } },
          _count: { select: { comments: true } },
        },
      });

      res.json({
        ...updatedPost,
        media_type: detectMediaType(updatedPost.media_url),
        preview_url: resolvePreviewUrl(updatedPost),
      });
    } catch (error) {
      console.error('Error updating post:', error);
      res.status(500).json({ error: 'Failed to update post' });
    }
  })
);

// Delete comment (author or post owner)
postsRouter.delete(
  '/:postId/comments/:commentId',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { postId, commentId } = req.params;
    const userId = req.user!.id;

    try {
      // Check if comment exists and get post owner for permission check
      const comment = await prisma.comment.findUnique({
        where: { id: commentId },
        include: { post: { select: { author_id: true } } },
      });

      if (!comment) {
        return res.status(404).json({ error: 'Comment not found' });
      }

      if (comment.post_id !== postId) {
        return res.status(400).json({ error: 'Comment does not belong to this post' });
      }

      const isCommentAuthor = comment.author_id === userId;
      const isPostOwner = comment.post?.author_id === userId;
      if (!isCommentAuthor && !isPostOwner) {
        return res
          .status(403)
          .json({ error: 'You can only delete your own comments or comments on your posts' });
      }

      await prisma.$transaction([
        prisma.notification.deleteMany({ where: { comment_id: commentId } }),
        prisma.comment.delete({ where: { id: commentId } }),
      ]);

      res.json({ message: 'Comment deleted successfully' });
    } catch (error) {
      console.error('Error deleting comment:', error);
      res.status(500).json({ error: 'Failed to delete comment' });
    }
  })
);

// Update comment (author only)
postsRouter.patch(
  '/:postId/comments/:commentId',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const { postId, commentId } = req.params;
    const userId = req.user!.id;

    const schema = z.object({
      content: z.string().min(1).max(1000),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid payload', issues: parsed.error.issues });
    }

    try {
      // Check if comment exists and user is the author
      const comment = await prisma.comment.findUnique({
        where: { id: commentId },
        select: { id: true, author_id: true, post_id: true },
      });

      if (!comment) {
        return res.status(404).json({ error: 'Comment not found' });
      }

      if (comment.post_id !== postId) {
        return res.status(400).json({ error: 'Comment does not belong to this post' });
      }

      if (comment.author_id !== userId) {
        return res.status(403).json({ error: 'You can only edit your own comments' });
      }

      // Update the comment (sanitize HTML to prevent XSS)
      const updatedComment = await prisma.comment.update({
        where: { id: commentId },
        data: { content: stripHtml(parsed.data.content) },
        include: {
          author: { select: { id: true, username: true, display_name: true, avatar_url: true } },
        },
      });

      res.json(updatedComment);
    } catch (error) {
      console.error('Error updating comment:', error);
      res.status(500).json({ error: 'Failed to update comment' });
    }
  })
);

// New route handler for creating a collage post
postsRouter.post(
  '/collage',
  requireVerified as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    return res.status(501).json({
      error: 'COLLAGE_NOT_IMPLEMENTED',
      message:
        'Collage creation is disabled until the server-side collage renderer is implemented.',
    });
  })
);
