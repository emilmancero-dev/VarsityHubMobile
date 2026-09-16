import { Router } from 'express';
import { AD_GEOFENCE_RADIUS_MILES, getAdBoundingBoxDegrees } from '../lib/adGeofencing.js';
import { getZipCoordinates, haversineDistance } from '../lib/geoUtils.js';
import { geocodeLocation } from '../lib/geocoding.js';
import { feedHighlightPostSelect } from '../lib/highlightPostSelect.js';
import { sendError } from '../lib/http/sendError.js';
import { detectMediaType, resolvePreviewUrl } from '../lib/mediaUtils.js';
import { loadPostInteractionSets, serializeFeedPost } from '../lib/feedPostSerializer.js';
import { ensureOAuthUserVerified } from '../lib/oauthVerification.js';
import { prisma } from '../lib/prisma.js';
import { postPageResponseCursor, postPageBoundary } from '../lib/postPageCursor.js';
import {
  buildPrivateTeamPostVisibilityWhere,
  getBlockedUserIds,
  getExcludedPrivateAuthorIds,
  getExcludedPrivateTeamIds,
  getRequestBlockedCache,
  mergeAndWhere,
} from '../lib/privacyUtils.js';
import { captureException } from '../lib/sentry.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { requireAuth } from '../middleware/requireAuth.js';

export const feedRouter = Router();
type FollowedFeedMode = 'followed' | 'followed_teams';

const isMissingPollSchemaError = (error: any): boolean => {
  if (!error || (error.code !== 'P2021' && error.code !== 'P2022')) return false;
  const table = String(error?.meta?.table ?? '');
  const column = String(error?.meta?.column ?? '');
  const message = String(error?.message ?? '');
  return /Poll/i.test(table) || /Poll/i.test(column) || /Poll/i.test(message);
};

const withMediaPreview = (post: any) => {
  // Strip precise capture coordinates: lat/lng feed the isLocal ranking boost
  // above and must never reach clients — they expose where a user (often a
  // minor) was filmed. country_code stays; it is coarse.
  const { lat: _lat, lng: _lng, ...rest } = post;
  return {
    ...rest,
    media_type: detectMediaType(rest.media_url),
    // resolvePreviewUrl, not getVideoPreviewUrl: the latter only derives a
    // poster from a Cloudinary URL, so every R2-hosted video (all media since
    // the 2026-07-13 migration) serialized preview_url: null and rendered as a
    // black card. The select at the highlight-bundle query already carries
    // poster_url — this was the only thing dropping it on the floor.
    preview_url: resolvePreviewUrl(rest),
  };
};

async function getZipCoordinatesWithFallback(
  zipCode: string
): Promise<{ lat: number; lon: number } | null> {
  const staticResult = getZipCoordinates(zipCode);
  if (staticResult) return staticResult;

  const geocodeResult = await geocodeLocation(zipCode);
  if (geocodeResult) {
    return { lat: geocodeResult.latitude, lon: geocodeResult.longitude };
  }

  return null;
}

async function getFollowedPostsPage(
  req: AuthedRequest,
  mode: FollowedFeedMode,
  limit: number,
  cursor: string | null = null
) {
  const currentUserId = req.user?.id ?? null;
  if (!currentUserId) {
    return {
      items: [],
      nextCursor: null,
      ...(mode === 'followed'
        ? { followed_feed_meta: { following_count: 0 } }
        : { followed_teams_feed_meta: { followed_teams_count: 0 } }),
    };
  }

  const where: Record<string, any> = { deleted_at: null };
  let followedFeedMeta: { following_count: number } | undefined;
  let followedTeamsFeedMeta: { followed_teams_count: number } | undefined;

  if (mode === 'followed') {
    // Preload followed author IDs in one indexed query, then use IN — avoids
    // Prisma's correlated EXISTS subquery which scans per post row.
    const [followRows, excludedIds, blockedIds, excludedTeamIds] = await Promise.all([
      prisma.follows.findMany({
        where: { follower_id: currentUserId, status: 'accepted' },
        select: { following_id: true },
        take: 5000,
      }),
      getExcludedPrivateAuthorIds(currentUserId, getRequestBlockedCache(req)),
      getBlockedUserIds(currentUserId, getRequestBlockedCache(req)),
      getExcludedPrivateTeamIds(currentUserId, getRequestBlockedCache(req)),
    ]);

    const followedAuthorIds = followRows.map(r => r.following_id);
    followedFeedMeta = { following_count: followedAuthorIds.length };

    // A user's own posts always belong in their followed feed — without this,
    // anyone who follows nobody sees a permanently empty Feed (671d87d3).
    const authorPool = [...new Set([currentUserId, ...followedAuthorIds])];
    const allExcluded = [...new Set([...excludedIds, ...blockedIds])];

    where.OR = [{ author_id: { in: authorPool } }, { type: 'admin_broadcast' }];
    if (allExcluded.length) where.author_id = { notIn: allExcluded };
    mergeAndWhere(where, buildPrivateTeamPostVisibilityWhere(excludedTeamIds));
  } else {
    // Preload followed team IDs, then resolve game IDs for those teams — all
    // indexed lookups. Replaces three layers of nested EXISTS subqueries.
    const [teamFollowRows, excludedIds, blockedIds, excludedTeamIds] = await Promise.all([
      prisma.teamFollow.findMany({
        where: { user_id: currentUserId },
        select: { team_id: true },
        take: 5000,
      }),
      getExcludedPrivateAuthorIds(currentUserId, getRequestBlockedCache(req)),
      getBlockedUserIds(currentUserId, getRequestBlockedCache(req)),
      getExcludedPrivateTeamIds(currentUserId, getRequestBlockedCache(req)),
    ]);

    const followedTeamIds = teamFollowRows.map(r => r.team_id);
    followedTeamsFeedMeta = { followed_teams_count: followedTeamIds.length };

    if (followedTeamIds.length === 0) {
      return {
        items: [],
        nextCursor: null,
        followed_teams_feed_meta: followedTeamsFeedMeta,
      };
    }

    // Resolve game IDs where a followed team is home or away. Restrict to
    // publicly-visible games so posts tied to an opponent-pending/declined
    // upcoming game don't surface (nor reveal the game's existence) via game
    // linkage — mirrors isGamePubliclyVisible on the read surfaces.
    const followedGameRows = await prisma.game.findMany({
      where: {
        AND: [
          {
            OR: [
              { home_team_id: { in: followedTeamIds } },
              { away_team_id: { in: followedTeamIds } },
            ],
          },
          { approval_status: 'approved' },
          {
            OR: [
              { opponent_approval_status: { notIn: ['pending', 'declined'] } },
              { date: { lt: new Date() } },
            ],
          },
        ],
      },
      select: { id: true },
      take: 500,
    });
    const followedGameIds = followedGameRows.map(g => g.id);

    const allExcluded = [...new Set([...excludedIds, ...blockedIds])];

    where.OR = [
      { team_id: { in: followedTeamIds } },
      ...(followedGameIds.length ? [{ game_id: { in: followedGameIds } }] : []),
      { type: 'admin_broadcast' },
    ];
    if (allExcluded.length) where.author_id = { notIn: allExcluded };
    mergeAndWhere(where, buildPrivateTeamPostVisibilityWhere(excludedTeamIds));
  }

  const boundary = await postPageBoundary(cursor, id =>
    prisma.post.findFirst({
      where: { AND: [where, { id }] },
      select: { id: true, created_at: true },
    })
  );
  const query: any = {
    where: { AND: [where, boundary] },
    orderBy: [{ created_at: 'desc' as const }, { id: 'desc' as const }],
    include: {
      author: { select: { id: true, username: true, display_name: true, avatar_url: true } },
      team: { select: { id: true, name: true, logo_url: true } },
      _count: { select: { comments: true, bookmarks: true } },
      poll: { include: { options: true } },
    },
    take: limit + 1,
  };

  let rows: any[] = [];
  try {
    // audit-allow unbounded: query object already includes take: limit + 1
    rows = await prisma.post.findMany(query);
  } catch (error: any) {
    if (!isMissingPollSchemaError(error)) throw error;
    const fallbackQuery = { ...query, include: { ...query.include } };
    delete fallbackQuery.include.poll;
    // audit-allow unbounded: fallbackQuery preserves the same take-bound as query
    rows = await prisma.post.findMany(fallbackQuery);
  }

  const items = rows.slice(0, limit);
  const nextCursor = postPageResponseCursor(rows, limit);
  const postIds: string[] = items.map((post: any) => post.id);
  const authorIds: string[] = items.map((post: any) => post.author_id).filter(Boolean);
  const pollIds: string[] = items.map((post: any) => post.poll?.id).filter(Boolean);

  const sets = await loadPostInteractionSets(prisma, currentUserId, {
    postIds,
    authorIds,
    pollIds,
  });

  const payload = items.map((post: any) => serializeFeedPost(post, sets));

  return {
    items: payload,
    nextCursor,
    ...(followedFeedMeta ? { followed_feed_meta: followedFeedMeta } : {}),
    ...(followedTeamsFeedMeta ? { followed_teams_feed_meta: followedTeamsFeedMeta } : {}),
  };
}

async function getHighlightsBundle(req: AuthedRequest, limit: number) {
  const country = String((req.query as any).country || 'US').toUpperCase();
  const lat = (req.query as any).lat != null ? Number((req.query as any).lat) : undefined;
  const lng = (req.query as any).lng != null ? Number((req.query as any).lng) : undefined;
  const since = new Date(Date.now() - 90 * 864e5);
  const radiusKm = 100;

  const [excludedIds, blockedIds, excludedTeamIds] = await Promise.all([
    getExcludedPrivateAuthorIds(req.user?.id ?? null, getRequestBlockedCache(req)),
    getBlockedUserIds(req.user?.id ?? null, getRequestBlockedCache(req)),
    getExcludedPrivateTeamIds(req.user?.id ?? null, getRequestBlockedCache(req)),
  ]);
  const allExcluded = [...new Set([...excludedIds, ...blockedIds])];
  const privacyWhere: any = {};
  if (allExcluded.length) privacyWhere.author_id = { notIn: allExcluded };
  mergeAndWhere(privacyWhere, buildPrivateTeamPostVisibilityWhere(excludedTeamIds));

  // Run nationalTop and pool concurrently — dedup in JS after both resolve.
  const [nationalTopRaw, poolRaw] = await Promise.all([
    prisma.post.findMany({
      where: {
        country_code: country,
        created_at: { gte: since },
        media_url: { not: null },
        deleted_at: null,
        ...privacyWhere,
      },
      orderBy: [{ upvotes_count: 'desc' }, { created_at: 'desc' }],
      take: 10,
      select: feedHighlightPostSelect,
    }),
    prisma.post.findMany({
      where: {
        country_code: country,
        created_at: { gte: since },
        media_url: { not: null },
        deleted_at: null,
        ...privacyWhere,
      },
      orderBy: [{ created_at: 'desc' }],
      take: 150,
      select: feedHighlightPostSelect,
    }),
  ]);

  let nationalTop: typeof nationalTopRaw = nationalTopRaw;

  // Backfill nationalTop from pool if national posts are sparse
  if (nationalTop.length < 10) {
    const topIds = new Set(nationalTop.map((p: any) => p.id));
    const globalFill = poolRaw
      .filter((p: any) => !topIds.has(p.id))
      .sort((a: any, b: any) => (b.upvotes_count || 0) - (a.upvotes_count || 0))
      .slice(0, 10 - nationalTop.length);
    nationalTop = nationalTop.concat(globalFill) as typeof nationalTopRaw;
  }

  const topIds = new Set(nationalTop.map((p: any) => p.id));
  const pool = poolRaw.filter((p: any) => !topIds.has(p.id));

  let isLocal: (post: any) => boolean = () => false;
  if (lat != null && lng != null && !Number.isNaN(lat) && !Number.isNaN(lng)) {
    const kmPerDegLat = 110.574;
    const kmPerDegLng = 111.32 * Math.cos((lat * Math.PI) / 180);
    const dLat = radiusKm / kmPerDegLat;
    const dLng = radiusKm / kmPerDegLng;
    isLocal = (post: any) =>
      typeof post.lat === 'number' &&
      typeof post.lng === 'number' &&
      post.lat >= lat - dLat &&
      post.lat <= lat + dLat &&
      post.lng >= lng - dLng &&
      post.lng <= lng + dLng;
  }

  let followedSet = new Set<string>();
  if (req.user?.id && pool.length > 0) {
    const authorIds = [...new Set(pool.map((post: any) => post.author_id).filter(Boolean))];
    const follows = await prisma.follows.findMany({
      where: {
        follower_id: req.user.id,
        following_id: { in: authorIds },
      },
      select: { following_id: true },
      take: Math.max(authorIds.length, 1),
    });
    followedSet = new Set(follows.map((row: any) => row.following_id));
  }

  const recencyBoost = (date: Date) => {
    const ageDays = (Date.now() - new Date(date).getTime()) / 864e5;
    if (ageDays <= 0.5) return 12;
    if (ageDays <= 1) return 8;
    if (ageDays <= 3) return 5;
    if (ageDays <= 7) return 3;
    if (ageDays <= 14) return 2;
    return 1;
  };

  const engagementBoost = (upvotes: number, comments: number) => {
    const totalEngagement = (upvotes || 0) + (comments || 0) * 2;
    if (totalEngagement >= 100) return 10;
    if (totalEngagement >= 50) return 6;
    if (totalEngagement >= 20) return 4;
    if (totalEngagement >= 10) return 2;
    return 1;
  };

  const ranked = pool
    .map((post: any) => ({
      ...post,
      _score:
        (post.upvotes_count || 0) * 2 +
        (post._count?.comments || 0) * 3 +
        (followedSet.has(post.author_id) ? 8 : 0) +
        (isLocal(post) ? 6 : 0) +
        recencyBoost(post.created_at) +
        engagementBoost(post.upvotes_count, post._count?.comments || 0) +
        (post.media_url ? 4 : 0),
    }))
    .sort((a, b) => b._score - a._score)
    .slice(0, limit);

  return {
    nationalTop: nationalTop.map(withMediaPreview),
    ranked: ranked.map(withMediaPreview),
  };
}

async function getAdsBundle(
  viewer: { date_of_birth?: Date | null; preferences?: any } | null,
  req: AuthedRequest,
  limit: number
) {
  if (viewer) {
    const { isMinor } = await import('../lib/userAge.js');
    if (isMinor(viewer as any)) {
      return { date: new Date().toISOString().slice(0, 10), ads: [] };
    }
  }

  const dateParam = req.query.date ? String(req.query.date) : undefined;
  const zip = req.query.zip ? String(req.query.zip) : undefined;
  const lat = req.query.lat != null ? Number(req.query.lat) : undefined;
  const lng = req.query.lng != null ? Number(req.query.lng) : undefined;
  const dateISO = dateParam || new Date().toISOString().slice(0, 10);
  const start = new Date(dateISO + 'T00:00:00.000Z');
  const next = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  let userCoords: { lat: number; lon: number } | null = null;
  if (zip) {
    userCoords = await getZipCoordinatesWithFallback(zip);
  } else if (lat != null && lng != null && !Number.isNaN(lat) && !Number.isNaN(lng)) {
    userCoords = { lat, lon: lng };
  }
  // Fallback to the authenticated viewer's saved zip when the client sent no
  // usable location. Ad visibility must not depend on every client version
  // correctly forwarding location — the server already knows where the signed-in
  // viewer lives. Guests can't reach here (/bundle requires auth) and the minor
  // gate above still applies, so this never widens who sees ads.
  if (!userCoords) {
    const prefs = viewer?.preferences;
    const profileZip =
      prefs && typeof prefs === 'object' && typeof (prefs as any).zip_code === 'string'
        ? (prefs as any).zip_code.trim()
        : '';
    if (profileZip) {
      userCoords = await getZipCoordinatesWithFallback(profileZip);
    }
  }
  if (!userCoords) return { date: dateISO, ads: [] };

  const { lat: bboxLat, lng: bboxLng } = getAdBoundingBoxDegrees(userCoords.lat);
  const ads = await prisma.ad.findMany({
    where: {
      payment_status: 'paid',
      status: 'active',
      target_zip_code: { not: null },
      OR: [
        {
          target_lat: { gte: userCoords.lat - bboxLat, lte: userCoords.lat + bboxLat },
          target_lng: { gte: userCoords.lon - bboxLng, lte: userCoords.lon + bboxLng },
        },
        { target_lat: null },
      ],
      reservations: {
        some: { date: { gte: start, lt: next } },
      },
    },
    orderBy: { created_at: 'desc' },
    take: 20,
    select: {
      id: true,
      business_name: true,
      banner_url: true,
      banner_fit_mode: true,
      target_url: true,
      target_zip_code: true,
      target_lat: true,
      target_lng: true,
      radius: true,
      description: true,
      status: true,
      payment_status: true,
      created_at: true,
    },
  });

  const adZipCoords = new Map<string, { lat: number; lon: number }>();
  const legacyZips = [
    ...new Set(
      ads
        .filter((ad: any) => ad.target_zip_code && (ad.target_lat == null || ad.target_lng == null))
        .map((ad: any) => ad.target_zip_code!)
    ),
  ];
  if (legacyZips.length > 0) {
    await Promise.all(
      legacyZips.map(async zipCode => {
        const coords = await getZipCoordinatesWithFallback(zipCode);
        if (coords) adZipCoords.set(zipCode, coords);
      })
    );
  }

  const filtered = ads.filter((ad: any) => {
    if (!ad.target_zip_code) return false;
    const adCoords =
      ad.target_lat != null && ad.target_lng != null
        ? { lat: ad.target_lat, lon: ad.target_lng }
        : adZipCoords.get(ad.target_zip_code);
    if (!adCoords) return false;
    const distance = haversineDistance(
      userCoords!.lat,
      userCoords!.lon,
      adCoords.lat,
      adCoords.lon
    );
    return distance <= AD_GEOFENCE_RADIUS_MILES;
  });

  return {
    date: dateISO,
    ads: filtered.slice(0, limit).map((ad: any) => ({
      id: ad.id,
      business_name: ad.business_name,
      banner_url: ad.banner_url,
      banner_fit_mode: ad.banner_fit_mode,
      target_url: ad.target_url,
      target_zip_code: ad.target_zip_code,
      radius: ad.radius,
      description: ad.description,
      status: ad.status,
      payment_status: ad.payment_status,
      created_at: ad.created_at,
    })),
  };
}

feedRouter.get(
  '/bundle',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const sliceNames = [
        'posts',
        'posts_followed_teams',
        'highlights',
        'ads',
        'unread_notifications',
        'unread_messages',
      ] as const;
      type Slice = (typeof sliceNames)[number];
      const requested =
        req.query.sections === undefined
          ? [...sliceNames]
          : typeof req.query.sections === 'string'
            ? req.query.sections.split(',')
            : [];
      if (!requested.length || requested.some(name => !sliceNames.includes(name as Slice))) {
        return sendError(res, 400, 'Invalid feed sections', { code: 'INVALID_SECTIONS' });
      }
      const selected = new Set(requested);
      const run = <T>(name: Slice, load: () => Promise<T>) =>
        selected.has(name) ? load() : Promise.resolve(undefined);
      const postsLimit = Math.max(1, Math.min(Number(req.query.posts_limit || 20) || 20, 50));
      const highlightsLimit = Math.max(
        1,
        Math.min(Number(req.query.highlights_limit || 20) || 20, 50)
      );
      const adsLimit = Math.max(1, Math.min(Number(req.query.ads_limit || 2) || 2, 5));

      const todayISO = new Date().toISOString().slice(0, 10);
      const POSTS_FALLBACK = { items: [], nextCursor: null };
      const HIGHLIGHTS_FALLBACK = { nationalTop: [], ranked: [] };
      const ADS_FALLBACK = { date: todayISO, ads: [] };

      // Fetch viewer profile concurrently with feed slices — it's only needed
      // by getAdsBundle (age gate) and unread counts, not by the post/highlights queries.
      const viewerPromise =
        req.user?.id && (selected.has('ads') || selected.has('unread_messages'))
          ? prisma.user.findUnique({
              where: { id: req.user.id },
              select: {
                id: true,
                email_verified: true,
                google_id: true,
                apple_id: true,
                date_of_birth: true,
                preferences: true,
              },
            })
          : Promise.resolve(null);

      const settled = await Promise.allSettled([
        run('posts', () =>
          getFollowedPostsPage(
            req,
            'followed',
            postsLimit,
            typeof req.query.posts_cursor === 'string' ? req.query.posts_cursor : null
          )
        ),
        run('posts_followed_teams', () =>
          getFollowedPostsPage(
            req,
            'followed_teams',
            postsLimit,
            typeof req.query.posts_followed_teams_cursor === 'string'
              ? req.query.posts_followed_teams_cursor
              : null
          )
        ),
        run('highlights', () => getHighlightsBundle(req, highlightsLimit)),
        run('ads', () =>
          viewerPromise.then(async v => {
            const verifiedV = await ensureOAuthUserVerified(v as any);
            return getAdsBundle(verifiedV, req, adsLimit);
          })
        ),
        run('unread_notifications', () =>
          prisma.notification.count({
            where: { user_id: req.user!.id, read_at: null },
          })
        ),
        run('unread_messages', () =>
          viewerPromise.then(async v => {
            const verifiedV = await ensureOAuthUserVerified(v as any);
            return verifiedV?.email_verified
              ? prisma.message.count({ where: { recipient_id: req.user!.id, read: false } })
              : 0;
          })
        ),
      ]);
      const errors: Array<{ slice: (typeof sliceNames)[number]; code: string }> = [];
      for (let i = 0; i < settled.length; i++) {
        const r = settled[i];
        if (r.status === 'rejected') {
          const err = r.reason instanceof Error ? r.reason : new Error(String(r.reason));
          console.error(`[feed] /bundle slice "${sliceNames[i]}" failed:`, err.message);
          captureException(err, {
            context: 'feed_bundle_slice_failed',
            slice: sliceNames[i],
            user_id: req.user?.id,
          });
          errors.push({ slice: sliceNames[i], code: 'SLICE_FAILED' });
        }
      }

      const pick = <T>(idx: number, fallback: T): T =>
        settled[idx].status === 'fulfilled'
          ? ((settled[idx] as PromiseFulfilledResult<T>).value as T)
          : fallback;

      res.set('Cache-Control', 'no-store, private');
      return res.json({
        ...(selected.has('posts') ? { posts: pick(0, POSTS_FALLBACK) } : {}),
        ...(selected.has('posts_followed_teams')
          ? { posts_followed_teams: pick(1, POSTS_FALLBACK) }
          : {}),
        ...(selected.has('highlights') ? { highlights: pick(2, HIGHLIGHTS_FALLBACK) } : {}),
        ...(selected.has('ads') ? { ads: pick(3, ADS_FALLBACK) } : {}),
        ...(selected.has('unread_notifications') ? { unread_notifications: pick(4, 0) } : {}),
        ...(selected.has('unread_messages') ? { unread_messages: pick(5, 0) } : {}),
        errors,
      });
    } catch (error: any) {
      console.error('[feed] GET /bundle error:', error);
      return sendError(res, 500, 'FEED_BUNDLE_FAILED', {
        message: 'Failed to load feed bundle',
      });
    }
  })
);
