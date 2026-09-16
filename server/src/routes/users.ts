import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';
import { assertCanSelfDeleteUser, softDeleteUserAccount } from '../lib/accountDeletion.js';
import { getAccountDeletionConfirmationRequirements } from '../lib/accountDeletionConfirmation.js';
import { sendError } from '../lib/http/sendError.js';
import { detectMediaType, resolvePreviewUrl } from '../lib/mediaUtils.js';
import { notifyNewFollower, sendPushNotification } from '../lib/notifications.js';
import { prisma } from '../lib/prisma.js';
import {
  formatDobYmd,
  getUserAge,
  parseDobLocal,
  requiresParentalConsent,
} from '../lib/userAge.js';
import { invalidateMeCacheForUser, updateUserAndInvalidate } from '../lib/userCache.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import type { AuthedRequest } from '../middleware/auth.js';
import {
  followLimiter,
  mentionsSearchLimiter,
  userLookupLimiter,
  usernameAvailableLimiter,
} from '../middleware/rateLimiters.js';
import { getIsAdmin, requireAdmin } from '../middleware/requireAdmin.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireVerified } from '../middleware/requireVerified.js';
import { registerIdValidation } from '../middleware/validateParams.js';
import {
  buildPrivateTeamPostVisibilityWhere,
  getBlockedUserIds,
  getExcludedPrivateAuthorIds,
  getExcludedPrivateTeamIds,
  getRequestBlockedCache,
  invalidateBlockedIdsCache,
  isTeamHiddenFromViewer,
} from '../lib/privacyUtils.js';
import { isReservedUsername } from '../lib/reservedUsernames.js';
import { serializeLiveWindow } from '../lib/geofencing.js';

export const usersRouter = Router();
registerIdValidation(usersRouter);
const publicUserSelect = {
  id: true,
  username: true,
  display_name: true,
  avatar_url: true,
};

async function invalidateFollowCaches(...userIds: Array<string | null | undefined>) {
  await Promise.all(userIds.map(userId => invalidateMeCacheForUser(userId)));
}

async function loadUserAdsWithReservationDates(userId: string) {
  const ads = await prisma.ad.findMany({
    where: { user_id: userId },
    orderBy: { created_at: 'desc' },
    take: 100,
  });
  const adIds = ads.map(ad => ad.id);
  const reservations = adIds.length
    ? await prisma.adReservation.findMany({
        where: { ad_id: { in: adIds } },
        orderBy: { date: 'asc' },
        take: 1000,
      })
    : [];
  const datesByAd: Record<string, string[]> = {};
  for (const reservation of reservations) {
    const key = reservation.ad_id;
    if (!datesByAd[key]) datesByAd[key] = [];
    datesByAd[key].push(reservation.date.toISOString().slice(0, 10));
  }
  return { ads, datesByAd };
}

function parseFollowListLimit(limit: unknown) {
  return Math.max(1, Math.min(parseInt(String(limit || '20'), 10) || 20, 50));
}

async function decoratePublicUsersWithFollowState(users: any[], currentUserId?: string) {
  if (!currentUserId) return;

  const userIds = users.map(user => user.id);
  const [followingSet, followsViewerSet] = await Promise.all([
    prisma.follows
      .findMany({
        where: {
          follower_id: currentUserId,
          following_id: { in: userIds },
          status: 'accepted',
        },
        select: { following_id: true },
        take: Math.max(userIds.length, 1),
      })
      .then(rows => new Set(rows.map(follow => follow.following_id))),
    prisma.follows
      .findMany({
        where: {
          follower_id: { in: userIds },
          following_id: currentUserId,
          status: 'accepted',
        },
        select: { follower_id: true },
        take: Math.max(userIds.length, 1),
      })
      .then(rows => new Set(rows.map(follow => follow.follower_id))),
  ]);
  users.forEach(user => {
    user.is_following = followingSet.has(user.id);
    user.is_following_viewer = followsViewerSet.has(user.id);
  });
}

async function loadProfileFollowList({
  profileUserId,
  currentUserId,
  limit,
  cursor,
  mode,
  req,
}: {
  profileUserId: string;
  currentUserId?: string;
  limit: number;
  cursor?: string;
  mode: 'followers' | 'following';
  req: AuthedRequest;
}) {
  const hidden = await isProfileHiddenFromViewer(profileUserId, currentUserId || null);
  if (hidden) return { items: [], nextCursor: null };

  const blockedIds = currentUserId
    ? await getBlockedUserIds(currentUserId, getRequestBlockedCache(req))
    : [];
  const listingFollowers = mode === 'followers';
  const follows = (await prisma.follows.findMany({
    where: listingFollowers
      ? {
          following_id: profileUserId,
          status: 'accepted',
          ...(blockedIds.length ? { follower_id: { notIn: blockedIds } } : {}),
        }
      : {
          follower_id: profileUserId,
          status: 'accepted',
          ...(blockedIds.length ? { following_id: { notIn: blockedIds } } : {}),
        },
    take: limit + 1,
    cursor: cursor
      ? {
          follower_id_following_id: listingFollowers
            ? { follower_id: cursor, following_id: profileUserId }
            : { follower_id: profileUserId, following_id: cursor },
        }
      : undefined,
    include: listingFollowers
      ? { follower: { select: publicUserSelect } }
      : { following: { select: publicUserSelect } },
  })) as any[];

  const page = follows.slice(0, limit);
  const users = page.map(follow => (listingFollowers ? follow.follower : follow.following));
  const nextCursor =
    follows.length > limit
      ? listingFollowers
        ? follows[limit].follower_id
        : follows[limit].following_id
      : null;

  await decoratePublicUsersWithFollowState(users, currentUserId);

  return { items: users, nextCursor };
}

function registerProfileFollowListRoute(path: string, mode: 'followers' | 'following') {
  usersRouter.get(
    path,
    requireAuth as any,
    requireVerified as any,
    asyncHandler(async (req: AuthedRequest, res) => {
      const { id } = req.params;
      const currentUserId = req.user?.id;
      const limit = parseFollowListLimit(req.query.limit);
      const cursor = (req.query.cursor as string | undefined) || undefined;

      res.json(
        await loadProfileFollowList({
          profileUserId: id,
          currentUserId,
          limit,
          cursor,
          mode,
          req,
        })
      );
    })
  );
}

async function readProfileContentRequest(req: AuthedRequest) {
  const id = String(req.params.id);
  const currentUserId = req.user?.id || null;
  const hidden = await isProfileHiddenFromViewer(id, currentUserId);
  const limit = Math.max(1, Math.min(parseInt(String(req.query.limit || '10'), 10) || 10, 50));
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
  const sort = typeof req.query.sort === 'string' ? req.query.sort : 'newest';
  return { id, currentUserId, hidden, limit, cursor, sort };
}

// List users (admin only)
usersRouter.get(
  '/',
  requireAdmin as any,
  asyncHandler(async (req, res) => {
    try {
      const q = String((req.query as any).q || '')
        .trim()
        .toLowerCase();
      const banned = String((req.query as any).banned || '') === '1';
      const limit = Math.max(
        1,
        Math.min(parseInt(String((req.query as any).limit || '100'), 10) || 100, 100)
      );
      const where: any = {};
      if (q)
        where.OR = [
          { email: { contains: q, mode: 'insensitive' } },
          { display_name: { contains: q, mode: 'insensitive' } },
          { username: { contains: q, mode: 'insensitive' } }, // Search by username only
        ];
      if (banned) where.banned = true;
      const rows = await prisma.user.findMany({
        where,
        take: limit,
        orderBy: { created_at: 'desc' },
        select: {
          id: true,
          email: true,
          display_name: true,
          username: true,
          email_verified: true,
          banned: true,
          created_at: true,
        },
      });
      return res.json(rows);
    } catch (err) {
      console.error('[users] GET / error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// Ban/unban routes are handled by the admin router at POST /admin/users/:id/ban
// and POST /admin/users/:id/unban — those versions include audit logging and
// ban notification emails. The redundant routes here have been removed to avoid
// a dual-path that bypasses the audit trail.

usersRouter.patch(
  '/:id/date-of-birth',
  requireAdmin as any,
  asyncHandler(async (req, res) => {
    const schema = z.object({ dob: z.string().min(1) });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid payload',
        issues: parsed.error.issues.map(issue => ({ path: issue.path, message: issue.message })),
      });
    }

    const dob = parsed.data.dob.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
      return res
        .status(400)
        .json({ error: 'INVALID_DOB', message: 'Date of birth must be YYYY-MM-DD.' });
    }
    // Route the parse through the shared helper so the stored date matches what
    // every other DOB write path produces. Using `new Date(y, m, d)` here
    // silently corrupted the stored date by one day on positive-offset servers;
    // `parseDobLocal` returns a UTC-midnight Date that is Postgres-safe.
    const parsedDob = parseDobLocal(dob);
    if (!parsedDob) {
      return res
        .status(400)
        .json({ error: 'INVALID_DOB', message: 'Date of birth is not a valid date.' });
    }
    // Age check uses the same UTC-based helper as every other consumer.
    const age = getUserAge({ date_of_birth: parsedDob });
    if (age !== null && age < 13) {
      return res.status(403).json({
        error: 'COPPA_UNDER_13',
        message: 'VarsityHub is not available for users under 13.',
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: String(req.params.id) },
      select: { id: true, preferences: true, dob_set_at: true },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const prefs =
      user.preferences && typeof user.preferences === 'object' && !Array.isArray(user.preferences)
        ? { ...(user.preferences as Record<string, unknown>) }
        : {};
    prefs.dob = dob;

    const updated = await updateUserAndInvalidate(prisma, {
      where: { id: user.id },
      data: {
        preferences: prefs as any,
        date_of_birth: parsedDob,
        dob_set_at: user.dob_set_at ?? new Date(),
        parental_consent_status: requiresParentalConsent({ date_of_birth: parsedDob })
          ? 'pending'
          : 'not_required',
        parental_consent_at: null,
      },
    });

    return res.json({
      ok: true,
      id: updated.id,
      date_of_birth: formatDobYmd(updated.date_of_birth),
      parental_consent_status: updated.parental_consent_status,
    });
  })
);

// Full user detail with ads and their reservation dates (admin only)
usersRouter.get(
  '/:id/full',
  requireAdmin as any,
  asyncHandler(async (req, res) => {
    try {
      const id = String(req.params.id);
      const user = await prisma.user.findUnique({
        where: { id },
        select: {
          id: true,
          email: true,
          display_name: true,
          username: true,
          email_verified: true,
          banned: true,
          created_at: true,
        },
      });
      if (!user) return res.status(404).json({ error: 'Not found' });
      const { ads, datesByAd } = await loadUserAdsWithReservationDates(id);
      return res.json({ user, ads, datesByAd });
    } catch (err) {
      console.error('[users] GET /:id/full error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// GET /users/me/export - GDPR/CCPA data portability: export all user data as JSON
// GDPR requires COMPLETE data — no truncation. Ceiling of 50k per category prevents OOM.
usersRouter.get(
  '/me/export',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = req.user!.id;
    const EXPORT_LIMIT = 50000; // Safety ceiling — no real user hits this
    try {
      const [user, posts, comments, messagesSent, following, followers, ads] = await Promise.all([
        prisma.user.findUnique({
          where: { id },
          select: {
            id: true,
            email: true,
            display_name: true,
            username: true,
            avatar_url: true,
            bio: true,
            created_at: true,
            email_verified: true,
            preferences: true,
          },
        }),
        prisma.post.findMany({
          where: { author_id: id },
          orderBy: { created_at: 'desc' },
          take: EXPORT_LIMIT,
          select: {
            id: true,
            title: true,
            content: true,
            type: true,
            media_url: true,
            upvotes_count: true,
            created_at: true,
            deleted_at: true,
            game_id: true,
            team_id: true,
          },
        }),
        prisma.comment.findMany({
          where: { author_id: id } as any,
          orderBy: { created_at: 'desc' },
          take: EXPORT_LIMIT,
          select: {
            id: true,
            post_id: true,
            content: true,
            created_at: true,
          },
        }),
        prisma.message.findMany({
          where: { sender_id: id },
          orderBy: { created_at: 'desc' },
          take: EXPORT_LIMIT,
          select: {
            id: true,
            recipient_id: true,
            content: true,
            read: true,
            created_at: true,
          },
        }),
        prisma.follows.findMany({
          where: { follower_id: id },
          take: EXPORT_LIMIT,
          select: { following_id: true, created_at: true },
        }),
        prisma.follows.findMany({
          where: { following_id: id },
          take: EXPORT_LIMIT,
          select: { follower_id: true, created_at: true },
        }),
        prisma.ad.findMany({
          where: { user_id: id },
          orderBy: { created_at: 'desc' },
          take: EXPORT_LIMIT,
          select: {
            id: true,
            contact_name: true,
            contact_email: true,
            business_name: true,
            banner_url: true,
            target_url: true,
            target_zip_code: true,
            radius: true,
            description: true,
            status: true,
            payment_status: true,
            created_at: true,
            updated_at: true,
          },
        }),
      ]);
      const adIds = ads.map(ad => ad.id);
      const adReservations =
        adIds.length > 0
          ? await prisma.adReservation.findMany({
              where: { ad_id: { in: adIds } },
              orderBy: { date: 'asc' },
              take: EXPORT_LIMIT,
              select: { ad_id: true, date: true, created_at: true },
            })
          : [];
      const reservationDatesByAdId = new Map<string, string[]>();
      for (const reservation of adReservations) {
        const list = reservationDatesByAdId.get(reservation.ad_id) || [];
        list.push(
          reservation.date instanceof Date
            ? reservation.date.toISOString()
            : String(reservation.date)
        );
        reservationDatesByAdId.set(reservation.ad_id, list);
      }

      const exportData = {
        exported_at: new Date().toISOString(),
        profile: user
          ? {
              id: user.id,
              email: user.email,
              display_name: user.display_name,
              username: user.username,
              avatar_url: user.avatar_url,
              bio: user.bio,
              created_at:
                user.created_at instanceof Date ? user.created_at.toISOString() : user.created_at,
              email_verified: user.email_verified,
            }
          : null,
        preferences: (user?.preferences as object) ?? {},
        posts: posts.map(p => ({
          ...p,
          created_at: p.created_at instanceof Date ? p.created_at.toISOString() : p.created_at,
          deleted_at: p.deleted_at instanceof Date ? p.deleted_at.toISOString() : p.deleted_at,
        })),
        comments: comments.map(c => ({
          ...c,
          created_at: c.created_at instanceof Date ? c.created_at.toISOString() : c.created_at,
        })),
        // v1.0.2 audit fix: scrub recipient_id from the exported messages payload.
        // GDPR is about the requester's own data; exposing which specific accounts they
        // messaged (even just IDs) leaks relationship data about third parties.
        messages_sent: messagesSent.map((m: any) => {
          const { recipient_id, recipient, ...rest } = m;
          return {
            ...rest,
            recipient_id_hash: recipient_id
              ? crypto.createHash('sha256').update(String(recipient_id)).digest('hex').slice(0, 16)
              : null,
            created_at: m.created_at instanceof Date ? m.created_at.toISOString() : m.created_at,
          };
        }),
        following: following.map(f => ({
          user_id: f.following_id,
          created_at: f.created_at instanceof Date ? f.created_at.toISOString() : f.created_at,
        })),
        followers: followers.map(f => ({
          user_id: f.follower_id,
          created_at: f.created_at instanceof Date ? f.created_at.toISOString() : f.created_at,
        })),
        ads: ads.map(ad => ({
          ...ad,
          created_at: ad.created_at instanceof Date ? ad.created_at.toISOString() : ad.created_at,
          updated_at: ad.updated_at instanceof Date ? ad.updated_at.toISOString() : ad.updated_at,
          reservation_dates: reservationDatesByAdId.get(ad.id) || [],
        })),
      };

      const json = JSON.stringify(exportData, null, 2);
      const filename = `varsityhub-data-export-${new Date().toISOString().slice(0, 10)}.json`;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(json);
    } catch (e: any) {
      console.error('Data export error:', e);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// CSV export of user's ads and reservations (admin only)
usersRouter.get(
  '/:id/export',
  requireAdmin as any,
  asyncHandler(async (req, res) => {
    try {
      const id = String(req.params.id);
      const user = await prisma.user.findUnique({
        where: { id },
        select: { id: true, email: true, username: true },
      });
      if (!user) return res.status(404).send('Not found');
      const { ads, datesByAd } = await loadUserAdsWithReservationDates(id);
      let csv = 'ad_id,business_name,status,payment_status,created_at,reservation_dates\n';
      for (const a of ads) {
        const dates = (datesByAd[a.id] || []).join(';');
        const row = [
          a.id,
          a.business_name || '',
          a.status || '',
          a.payment_status || '',
          a.created_at.toISOString(),
          dates,
        ]
          .map(v => '"' + String(v).replace(/"/g, '""') + '"')
          .join(',');
        csv += row + '\n';
      }
      const filename = `user-${user.id}-ads.csv`;
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(csv);
    } catch (err) {
      console.error('[users] GET /:id/export error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// =============================
// Profile: Posts & Interactions
// =============================

const sortParamToOrder = (sort?: string) => {
  switch (sort) {
    case 'most_upvoted':
      return [{ upvotes_count: 'desc' as const }, { created_at: 'desc' as const }];
    case 'most_commented':
      return [{ comments: { _count: 'desc' as any } } as any, { created_at: 'desc' as const }];
    default:
      return [{ created_at: 'desc' as const }];
  }
};

/** Returns true if profile owner has profile_private and viewer is not owner/follower */
async function isProfileHiddenFromViewer(
  ownerId: string,
  viewerId: string | null
): Promise<boolean> {
  if (viewerId === ownerId) return false;

  // A block (either direction) hides the profile regardless of privacy setting.
  // The feed already block-filters; the profile-scoped endpoints (profile GET,
  // /posts, /interactions, /followers, /following) all route through this helper
  // but previously only checked profile_private, so a blocked user could still
  // read the blocker's whole profile + posts. Audit 2026-07-14.
  if (viewerId) {
    const block = await prisma.blockedUser.findFirst({
      where: {
        OR: [
          { blocker_id: viewerId, blocked_id: ownerId },
          { blocker_id: ownerId, blocked_id: viewerId },
        ],
      },
      select: { blocker_id: true },
    });
    if (block) return true;
  }

  const owner = await prisma.user.findUnique({
    where: { id: ownerId },
    select: { preferences: true },
  });
  const prefs = (owner?.preferences || {}) as any;
  if (prefs?.profile_private !== true) return false;
  // Unauthenticated users cannot see private profiles
  if (!viewerId) return true;
  const rel = await prisma.follows.findUnique({
    where: { follower_id_following_id: { follower_id: viewerId, following_id: ownerId } },
    select: { follower_id: true, status: true },
  });
  // Hidden if not a follower OR if follow is still pending
  return !rel || rel.status !== 'accepted';
}

function mapPostForPayload(post: any) {
  return {
    id: post.id,
    media_url: post.media_url ?? null,
    media_type: detectMediaType(post.media_url),
    // resolvePreviewUrl, not getVideoPreviewUrl: the latter only derives a
    // poster from a Cloudinary URL, so every R2-hosted video (all media since
    // the 2026-07-13 migration) serialized preview_url: null and the profile
    // post grid rendered a black tile with a play button. Both callers use an
    // `include:` query, so poster_url is present on the row.
    preview_url: resolvePreviewUrl(post),
    // Event/game linkage — every post surface must be able to offer
    // "open the event page" (EventChip); mirrors serializeFeedPost.
    game_id: post.game_id ?? null,
    event_id: post.event_id ?? null,
    caption: post.content ?? null,
    upvotes_count: post.upvotes_count ?? 0,
    comments_count: post._count?.comments ?? 0,
    bookmarks_count: post._count?.bookmarks ?? 0,
    created_at: post.created_at instanceof Date ? post.created_at.toISOString() : post.created_at,
    author: post.author
      ? { id: post.author.id, username: post.author.username, avatar_url: post.author.avatar_url }
      : null,
  };
}

// GET /users/:id/posts?cursor=...&limit=...&sort=...
usersRouter.get(
  '/:id/posts',
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const { id, currentUserId, hidden, limit, cursor, sort } =
        await readProfileContentRequest(req);
      if (hidden) {
        return res.status(404).json({ error: 'User not found' });
      }

      const orderBy = sortParamToOrder(sort);
      const isAdmin = currentUserId ? await getIsAdmin(req as any) : false;
      const privateTeamPostWhere = buildPrivateTeamPostVisibilityWhere(
        isAdmin ? [] : await getExcludedPrivateTeamIds(currentUserId)
      );
      const query: any = {
        where: {
          author_id: id,
          deleted_at: null,
          ...(privateTeamPostWhere ? { AND: [privateTeamPostWhere] } : {}),
        },
        take: limit + 1,
        orderBy,
        include: {
          author: { select: { id: true, username: true, avatar_url: true } },
          _count: { select: { comments: true, bookmarks: true } },
        },
      };
      if (cursor) {
        query.cursor = { id: cursor };
        query.skip = 1;
      }
      // audit-allow unbounded: query object already includes take: limit + 1
      const rows = await prisma.post.findMany(query);
      const items = rows.slice(0, limit);
      const nextCursor = rows.length > limit ? rows[limit].id : null;

      // Per-viewer interaction flags — without these the profile post viewer
      // renders every post as un-upvoted, so tapping upvote on an
      // already-upvoted post silently toggled it OFF. Audit 2026-07-14.
      const postIds = items.map(p => p.id);
      const [viewerUpvotes, viewerBookmarks] =
        currentUserId && postIds.length
          ? await Promise.all([
              prisma.postUpvote.findMany({
                where: { user_id: currentUserId, post_id: { in: postIds } },
                select: { post_id: true },
                take: postIds.length,
              }),
              prisma.postBookmark.findMany({
                where: { user_id: currentUserId, post_id: { in: postIds } },
                select: { post_id: true },
                take: postIds.length,
              }),
            ])
          : [[], []];
      const upSet = new Set(viewerUpvotes.map(u => u.post_id));
      const bmSet = new Set(viewerBookmarks.map(b => b.post_id));
      const payload = items.map(p => ({
        ...mapPostForPayload(p),
        has_upvoted: upSet.has(p.id),
        has_bookmarked: bmSet.has(p.id),
      }));
      const [postsCount, likesCount, commentsCount, savesCount] = await Promise.all([
        prisma.post.count({ where: query.where }),
        prisma.postUpvote.count({ where: { user_id: id } }),
        prisma.comment.count({ where: { author_id: id } as any }),
        prisma.postBookmark.count({ where: { user_id: id } }),
      ]);
      const counts = {
        posts: postsCount,
        likes: likesCount,
        comments: commentsCount,
        reposts: 0,
        saves: savesCount,
      };

      return res.json({ items: payload, nextCursor, counts });
    } catch (err) {
      console.error('[users] GET /:id/posts error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// GET /users/:id/interactions?type=like|comment|repost|save|all&cursor=...&limit=...&sort=...
usersRouter.get(
  '/:id/interactions',
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const { id, currentUserId, hidden, limit, cursor, sort } =
        await readProfileContentRequest(req);
      if (hidden) {
        return res.status(404).json({ error: 'User not found' });
      }
      const type = typeof req.query.type === 'string' ? req.query.type : 'all';

      // Collect interactions (capped at 200 per type to prevent OOM on prolific users)
      const interactionLimit = 200;
      const likeRows =
        type === 'all' || type === 'like'
          ? await prisma.postUpvote.findMany({
              where: { user_id: id },
              select: { post_id: true, created_at: true },
              orderBy: { created_at: 'desc' },
              take: interactionLimit,
            })
          : [];
      const commentRows =
        type === 'all' || type === 'comment'
          ? await prisma.comment.findMany({
              where: { author_id: id } as any,
              select: { post_id: true, created_at: true },
              orderBy: { created_at: 'desc' },
              take: interactionLimit,
            })
          : [];
      // No repost model yet
      const saveRows =
        type === 'all' || type === 'save'
          ? await prisma.postBookmark.findMany({
              where: { user_id: id },
              select: { post_id: true, created_at: true },
              orderBy: { created_at: 'desc' },
              take: interactionLimit,
            })
          : [];

      type Item = { post_id: string; ts: Date };
      const merged: Record<string, Item> = {};
      for (const r of likeRows) {
        const k = r.post_id;
        const ts = r.created_at as Date;
        if (!merged[k] || merged[k].ts < ts) merged[k] = { post_id: k, ts };
      }
      for (const r of commentRows) {
        const k = r.post_id!;
        const ts = r.created_at as Date;
        if (!merged[k] || merged[k].ts < ts) merged[k] = { post_id: k, ts };
      }
      for (const r of saveRows) {
        const k = r.post_id;
        const ts = r.created_at as Date;
        if (!merged[k] || merged[k].ts < ts) merged[k] = { post_id: k, ts };
      }
      let list = Object.values(merged);

      const isAdmin = currentUserId ? await getIsAdmin(req as any) : false;
      const [privateAuthorIds, blockedAuthorIds, excludedTeamIds] = await Promise.all([
        getExcludedPrivateAuthorIds(currentUserId),
        getBlockedUserIds(currentUserId, getRequestBlockedCache(req)),
        isAdmin ? Promise.resolve([]) : getExcludedPrivateTeamIds(currentUserId),
      ]);
      const excludedAuthorIds = [...new Set([...privateAuthorIds, ...blockedAuthorIds])];
      const privateTeamPostWhere = buildPrivateTeamPostVisibilityWhere(excludedTeamIds);

      if (list.length > 0) {
        const visiblePosts = await prisma.post.findMany({
          where: {
            id: { in: list.map(i => i.post_id) },
            deleted_at: null,
            ...(excludedAuthorIds.length ? { author_id: { notIn: excludedAuthorIds } } : {}),
            ...(privateTeamPostWhere ? { AND: [privateTeamPostWhere] } : {}),
          },
          select: { id: true },
          take: Math.max(list.length, 1),
        });
        const visiblePostIds = new Set(visiblePosts.map(post => post.id));
        list = list.filter(item => visiblePostIds.has(item.post_id));
      }

      // Sorting
      if (sort === 'most_upvoted') {
        const likeCounts = await prisma.post.findMany({
          where: { id: { in: list.map(i => i.post_id) }, deleted_at: null },
          select: { id: true, upvotes_count: true },
          take: Math.max(list.length, 1),
        });
        const likeMap = new Map(likeCounts.map(p => [p.id, p.upvotes_count || 0]));
        list.sort((a, b) => likeMap.get(b.post_id)! - likeMap.get(a.post_id)!);
      } else if (sort === 'most_commented') {
        const commentCounts = await prisma.comment.groupBy({
          by: ['post_id'],
          _count: { _all: true },
          where: { post_id: { in: list.map(i => i.post_id) } },
        });
        const cMap = new Map(commentCounts.map(c => [c.post_id!, c._count._all]));
        list.sort((a, b) => cMap.get(b.post_id)! - cMap.get(a.post_id)!);
      } else {
        list.sort((a, b) => b.ts.getTime() - a.ts.getTime());
      }

      // Cursor pagination (keyset on (ts, post_id))
      let start = 0;
      if (cursor) {
        const [tsStr, pid] = cursor.split('::');
        const ts = new Date(tsStr);
        const idx = list.findIndex(i => i.ts.getTime() === ts.getTime() && i.post_id === pid);
        start = idx >= 0 ? idx + 1 : 0;
      }
      const slice = list.slice(start, start + limit + 1);
      const page = slice.slice(0, limit);
      const next = slice.length > limit ? slice[limit] : null;
      const nextCursor = next ? `${next.ts.toISOString()}::${next.post_id}` : null;

      const postIds = page.map(i => i.post_id);
      const posts = postIds.length
        ? await prisma.post.findMany({
            where: {
              id: { in: postIds },
              deleted_at: null,
              ...(excludedAuthorIds.length ? { author_id: { notIn: excludedAuthorIds } } : {}),
              ...(privateTeamPostWhere ? { AND: [privateTeamPostWhere] } : {}),
            },
            // mapPostForPayload serializes author.username — without selecting it here
            // every interaction post rendered as "Anonymous" in the vertical viewer.
            include: {
              author: {
                select: { id: true, username: true, display_name: true, avatar_url: true },
              },
              _count: { select: { comments: true, bookmarks: true } },
            },
            take: postIds.length,
          })
        : [];
      // Preserve order of page
      const byId = new Map(posts.map(p => [p.id, p]));
      const ordered = postIds
        .map(id => byId.get(id))
        .filter(Boolean)
        .map(mapPostForPayload);

      // `await` inside an object literal serializes: these four independent
      // counts each waited for the previous one, so the endpoint paid four
      // round trips (~65ms each — the API is us-west2 while Postgres is
      // us-east4) for work that has no ordering requirement.
      const [postCount, likeCount, commentCount, saveCount] = await Promise.all([
        prisma.post.count({
          where: {
            author_id: id,
            deleted_at: null,
            ...(privateTeamPostWhere ? { AND: [privateTeamPostWhere] } : {}),
          },
        }),
        prisma.postUpvote.count({ where: { user_id: id } }),
        prisma.comment.count({ where: { author_id: id } as any }),
        prisma.postBookmark.count({ where: { user_id: id } }),
      ]);

      const counts = {
        posts: postCount,
        likes: likeCount,
        comments: commentCount,
        reposts: 0,
        saves: saveCount,
      };

      return res.json({ items: ordered, nextCursor, counts });
    } catch (err) {
      console.error('[users] GET /:id/interactions error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// GET /users/:id/event-pages — event pages this user was verified at. The
// EventPostingUnlock ledger is written by the first geofence-passing post/story
// and survives content deletion, so this is actual presence rather than an RSVP
// or an arbitrary post association. readProfileContentRequest and the team
// checks below keep profile/team privacy server-authoritative.
usersRouter.get(
  '/:id/event-pages',
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const { id, currentUserId, hidden } = await readProfileContentRequest(req);
      if (hidden) {
        return res.status(404).json({ error: 'User not found' });
      }

      const isAdmin = currentUserId ? await getIsAdmin(req as any) : false;
      const rows = await prisma.eventPostingUnlock.findMany({
        where: {
          user_id: id,
          event: {
            date: { lte: new Date() },
            approval_status: 'approved',
            status: { not: 'cancelled' },
          },
        },
        select: {
          event: {
            select: {
              id: true,
              title: true,
              date: true,
              location: true,
              banner_url: true,
              event_type: true,
              team_id: true,
              game_id: true,
              live_window_hours_after_start: true,
              team: { select: { sport: true, primary_color: true } },
              sportsLeague: { select: { sport_slug: true } },
              proHomeTeam: { select: { league: true, primary_color: true } },
              proAwayTeam: { select: { league: true, primary_color: true } },
              game: {
                select: {
                  id: true,
                  cover_image_url: true,
                  banner_url: true,
                  home_team_id: true,
                  away_team_id: true,
                  homeTeam: { select: { sport: true, primary_color: true } },
                  awayTeam: { select: { sport: true, primary_color: true } },
                },
              },
            },
          },
        },
        orderBy: { unlocked_at: 'desc' },
        take: 50,
      });

      const items = (
        await Promise.all(
          rows.map(async row => {
            const e = row.event;
            if (!isAdmin) {
              const teamIds = [e.team_id, e.game?.home_team_id, e.game?.away_team_id].filter(
                (teamId): teamId is string => !!teamId
              );
              const hidden = await Promise.all(
                teamIds.map(teamId => isTeamHiddenFromViewer(teamId, currentUserId))
              );
              if (hidden.some(Boolean)) return null;
            }
            const liveWindow = serializeLiveWindow(e.date, e.live_window_hours_after_start);
            return {
              id: e.id,
              game_id: e.game_id,
              event_id: e.id,
              type: 'event' as const,
              source_type: 'event' as const,
              title: e.title,
              date: e.date instanceof Date ? e.date.toISOString() : e.date,
              location: e.location ?? null,
              banner_url: e.banner_url ?? e.game?.banner_url ?? null,
              cover_image_url: e.game?.cover_image_url ?? null,
              event_type: e.event_type,
              sport:
                e.team?.sport ??
                e.game?.homeTeam?.sport ??
                e.game?.awayTeam?.sport ??
                e.sportsLeague?.sport_slug ??
                null,
              pro_league: e.proHomeTeam?.league ?? e.proAwayTeam?.league ?? null,
              pro_home_color:
                e.proHomeTeam?.primary_color ??
                e.game?.homeTeam?.primary_color ??
                e.team?.primary_color ??
                null,
              pro_away_color:
                e.proAwayTeam?.primary_color ?? e.game?.awayTeam?.primary_color ?? null,
              ...liveWindow,
            };
          })
        )
      ).filter((item): item is NonNullable<typeof item> => item !== null);

      return res.json({ items, count: items.length });
    } catch (err) {
      console.error('[users] GET /:id/event-pages error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// GET /users/:id/teams - Teams the user is a member of (for athlete profile)
usersRouter.get(
  '/:id/teams',
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const id = String(req.params.id);
      const currentUserId = req.user?.id || null;
      const hidden = await isProfileHiddenFromViewer(id, currentUserId);
      if (hidden) return res.status(404).json({ error: 'User not found' });

      const memberships = await prisma.teamMembership.findMany({
        where: { user_id: id, status: 'active' },
        include: {
          team: {
            select: {
              id: true,
              name: true,
              logo_url: true,
              avatar_url: true,
              sport: true,
              season_start: true,
              season_end: true,
            },
          },
        },
        orderBy: { created_at: 'asc' },
        take: 100,
      });

      const formatSeason = (start?: Date | null, end?: Date | null): string | null => {
        if (!start && !end) return null;
        const toLabel = (d?: Date | null) =>
          d ? d.toLocaleString(undefined, { month: 'short', year: 'numeric' }) : null;
        const s = toLabel(start);
        const e = toLabel(end);
        if (s && e) return s === e ? s : `${s} - ${e}`;
        return s ?? e ?? null;
      };

      const isAdmin = currentUserId ? await getIsAdmin(req as any) : false;
      const visibleMemberships = isAdmin
        ? memberships
        : (
            await Promise.all(
              memberships.map(async membership => {
                const teamId = (membership as any).team?.id;
                if (!teamId) return null;
                if (await isTeamHiddenFromViewer(teamId, currentUserId)) return null;
                return membership;
              })
            )
          ).filter((membership): membership is (typeof memberships)[number] => Boolean(membership));

      const teams = visibleMemberships.map(m => {
        const t = (m as any).team;
        return {
          id: t.id,
          name: t.name,
          logo_url: t.logo_url ?? null,
          avatar_url: t.avatar_url ?? null,
          sport: t.sport ?? null,
          season: formatSeason(t.season_start, t.season_end) ?? null,
          role: m.role,
          position: (m as any).custom_position ?? null,
          jersey_number: null,
        };
      });

      return res.json(teams);
    } catch (err) {
      console.error('[users] GET /:id/teams error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// Delete own account (soft-delete + anonymize)
// All users must type DELETE. Accounts with a password must also provide it.
const deleteAccountSchema = z.object({
  password: z.string().min(1, 'Password is required').optional(),
  delete_confirmation: z.string().optional(),
});
usersRouter.delete(
  '/me',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = req.user!.id;
    const parsed = deleteAccountSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid confirmation payload',
        message: 'Type DELETE and provide your password if your account uses one.',
      });
    }
    const { password } = parsed.data;
    try {
      const user = await prisma.user.findUnique({
        where: { id },
        select: {
          email: true,
          password_hash: true,
          google_id: true,
          apple_id: true,
          deleted_at: true,
          deletion_anonymized: true,
        },
      });
      if (!user) return res.status(404).json({ error: 'User not found' });

      if (user.deleted_at || user.deletion_anonymized) {
        return res.status(202).json({
          deleted: true,
          already_deleted: true,
          deleted_at: user.deleted_at?.toISOString(),
        });
      }

      const confirmationCheck = getAccountDeletionConfirmationRequirements(user, parsed.data);
      if (!confirmationCheck.ok) {
        return res.status(confirmationCheck.status).json(confirmationCheck.body);
      }

      if (confirmationCheck.requiresPassword) {
        const isValid = await bcrypt.compare(
          String(password || ''),
          String(user.password_hash || '')
        );
        if (!isValid) {
          return res.status(403).json({
            error: 'Invalid password',
            message: 'Password does not match.',
          });
        }
      }

      try {
        await assertCanSelfDeleteUser(id);
      } catch (err) {
        if ((err as any)?.code === 'SOLE_ORG_OWNER') {
          return res.status(400).json({
            error:
              'You are the sole owner of an organization. Transfer ownership before deleting your account.',
            code: 'SOLE_ORG_OWNER',
            organization_id: (err as any).organization_id,
          });
        }
        if ((err as any)?.code === 'SOLE_TEAM_OWNER') {
          return sendError(
            res,
            400,
            'You are the sole owner of a team. Transfer ownership before deleting your account.',
            { code: 'SOLE_TEAM_OWNER', details: { team_id: (err as any).team_id } }
          );
        }
        throw err;
      }

      const userEmail = user.email;
      const result = await softDeleteUserAccount(id);

      // Send deletion confirmation email (best-effort, user record already deleted)
      if (userEmail) {
        try {
          const { sendEmail } = await import('../lib/email.js');
          await (sendEmail as any)({
            to: userEmail,
            subject: 'VarsityHub Account Deleted',
            text: 'Your VarsityHub account has been permanently deleted. Your profile and the content you created — your posts, media, comments, and messages you sent — have been removed immediately. This cannot be undone. If you did not request this, contact support@varsityhub.app immediately.',
          });
        } catch {
          /* best-effort */
        }
      }

      return res.status(202).json({
        deleted: true,
        deleted_at: result.deletedAt.toISOString(),
        message: 'Account deletion accepted',
      });
    } catch (e: any) {
      console.error('Account deletion error:', e);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// Username availability check (public - no auth required)
// authMiddleware still populates req.user if a token is present, allowing exclusion of current user
usersRouter.get(
  '/username-available',
  usernameAvailableLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    const username = String((req.query as any).username || '').trim();
    const valid = /^[a-z0-9_.]{3,20}$/.test(username);
    if (!valid) return res.json({ available: false, valid: false });

    // Must agree with the write-side refine in auth.ts, or the UI reports a
    // reserved handle as available and the save then fails.
    if (isReservedUsername(username)) {
      return res.json({ available: false, valid: true, reason: 'reserved' });
    }

    // Exclude current user so their own username doesn't appear as taken
    const currentUserId = req.user?.id;
    const exists = await prisma.user.findFirst({
      where: {
        OR: [
          { username: { equals: username, mode: 'insensitive' } },
          { display_name: { equals: username, mode: 'insensitive' } },
        ],
        ...(currentUserId ? { NOT: { id: currentUserId } } : {}),
      },
      select: { id: true },
    });

    return res.json({ available: !exists, valid: true });
  })
);

// Lookup user by username. Email-based lookup is intentionally restricted to
// admins so normal users cannot enumerate whether other users exist by email.
usersRouter.get(
  '/lookup',
  requireAuth as any,
  userLookupLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    const email = String((req.query as any).email || '')
      .trim()
      .toLowerCase();
    const username = String((req.query as any).username || '')
      .trim()
      .toLowerCase();

    if (username) {
      const u = await prisma.user.findFirst({
        where: { username: { equals: username, mode: 'insensitive' } },
        select: { id: true, display_name: true, username: true, avatar_url: true },
      });
      if (!u) return res.status(404).json({ error: 'Not found' });
      return res.json(u);
    }

    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Invalid email or username required' });
    }

    const isAdmin = await getIsAdmin(req);
    if (!isAdmin) {
      return res.status(403).json({
        error: 'EMAIL_LOOKUP_FORBIDDEN',
        message: 'Email-based user lookup is restricted.',
      });
    }

    const u = await prisma.user.findUnique({
      where: { email },
      select: { id: true, display_name: true },
    });

    if (!u) return res.status(404).json({ error: 'Not found' });
    return res.json(u);
  })
);

// Follow a user
usersRouter.post(
  '/:id/follow',
  requireAuth as any,
  requireVerified as any,
  followLimiter as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const follower_id = req.user!.id;
    const following_id = req.params.id;

    if (follower_id === following_id) {
      return res.status(400).json({ error: 'You cannot follow yourself.' });
    }

    // Verify target user exists and isn't soft-deleted BEFORE any writes.
    // Previously the handler fell through to a Follows.create on a bogus
    // following_id, leaving a dangling row that breaks referential integrity
    // assumptions downstream (follower-details joins N+1, orphaned rows).
    const targetUser = await prisma.user.findUnique({
      where: { id: following_id },
      select: { id: true, deleted_at: true, preferences: true },
    });
    if (!targetUser || targetUser.deleted_at) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // Prevent following if either user has blocked the other
    const block = await prisma.blockedUser.findFirst({
      where: {
        OR: [
          { blocker_id: follower_id, blocked_id: following_id },
          { blocker_id: following_id, blocked_id: follower_id },
        ],
      },
    });
    if (block) {
      return res.status(403).json({ error: 'Cannot follow this user.' });
    }

    try {
      // Target profile visibility. The pre-fetched targetUser above already
      // pulled preferences; reuse it rather than a second SELECT.
      const targetPrefs = (targetUser.preferences || {}) as any;
      const isPrivate = targetPrefs?.profile_private === true;

      // Check if there's already a follow record
      const existing = await prisma.follows.findUnique({
        where: { follower_id_following_id: { follower_id, following_id } },
      });

      if (existing) {
        // Already following or pending — return current status (idempotent)
        return res.status(200).json({
          is_following_author: existing.status === 'accepted',
          follow_status: existing.status,
        });
      }

      const followStatus = isPrivate ? 'pending' : 'accepted';

      try {
        // Re-check block inside a transaction so a block that committed between
        // our earlier check and this insert is caught. Without this, user B
        // blocking user A mid-flight would still leave a live Follows row after
        // the race completes, contradicting the block on read.
        await prisma.$transaction(async tx => {
          const raceBlock = await tx.blockedUser.findFirst({
            where: {
              OR: [
                { blocker_id: follower_id, blocked_id: following_id },
                { blocker_id: following_id, blocked_id: follower_id },
              ],
            },
            select: { id: true },
          });
          if (raceBlock) {
            // Throw a sentinel so the outer handler returns 403 cleanly.
            throw Object.assign(new Error('BLOCKED_RACE'), { code: 'FOLLOW_BLOCKED_RACE' });
          }
          await tx.follows.create({
            data: { follower_id, following_id, status: followStatus },
          });
        });
        await invalidateFollowCaches(follower_id, following_id);

        // Create notification
        try {
          if (follower_id !== following_id) {
            const notificationType = isPrivate ? 'FOLLOW_REQUEST' : 'FOLLOW';
            await (prisma as any).notification.create({
              data: {
                user_id: following_id,
                actor_id: follower_id,
                type: notificationType as any,
                meta: isPrivate ? { requires_action: true } : undefined,
              },
            });

            // Send push notification
            const follower = await prisma.user.findUnique({
              where: { id: follower_id },
              select: { display_name: true },
            });
            if (follower) {
              await notifyNewFollower(
                following_id,
                follower_id,
                isPrivate
                  ? `${follower.display_name || 'Someone'} requested to follow you`
                  : follower.display_name || 'Someone'
              );
            }
          }
        } catch (e) {
          console.error('Failed to send follow notification:', e);
        }
        res.status(201).json({
          is_following_author: followStatus === 'accepted',
          follow_status: followStatus,
        });
      } catch (createErr: any) {
        // Block landed inside the transaction — surface as 403 instead of 500.
        if (createErr?.code === 'FOLLOW_BLOCKED_RACE') {
          return res.status(403).json({ error: 'Cannot follow this user.' });
        }
        // P2002 = unique constraint violation (race: duplicate follow request)
        if (createErr?.code === 'P2002') {
          const dup = await prisma.follows.findUnique({
            where: { follower_id_following_id: { follower_id, following_id } },
          });
          return res.status(200).json({
            is_following_author: dup?.status === 'accepted',
            follow_status: dup?.status ?? 'accepted',
          });
        }
        throw createErr;
      }
    } catch (error) {
      console.error('Follow error:', error);
      res.status(500).json({ error: 'Something went wrong.' });
    }
  })
);

// Unfollow a user
usersRouter.delete(
  '/:id/follow',
  requireAuth as any,
  requireVerified as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const follower_id = req.user!.id;
    const following_id = req.params.id;

    try {
      await prisma.follows.deleteMany({
        where: { follower_id, following_id },
      });
      await invalidateFollowCaches(follower_id, following_id);
      res.status(200).json({ success: true, is_following_author: false });
    } catch (error) {
      console.error('Unfollow error:', error);
      res.status(500).json({ error: 'Something went wrong.' });
    }
  })
);

// Accept a follow request (for private profiles)
usersRouter.post(
  '/:id/accept-follow',
  requireAuth as any,
  requireVerified as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const currentUserId = req.user!.id;
    const followerId = req.params.id;

    try {
      const follow = await prisma.follows.findUnique({
        where: {
          follower_id_following_id: { follower_id: followerId, following_id: currentUserId },
        },
      });
      if (!follow) return res.status(404).json({ error: 'Follow request not found' });
      if (follow.status === 'accepted') return res.json({ ok: true, status: 'accepted' });

      // Don't accept a follow request from a soft-deleted account — the row
      // exists (pre-delete) but the user no longer does. Accepting would
      // fire a notification + push to a deleted account and leave a live
      // follow relationship pointing at an anonymized user.
      const follower = await prisma.user.findUnique({
        where: { id: followerId },
        select: { id: true, deleted_at: true },
      });
      if (!follower || follower.deleted_at) {
        // Clean up the stale pending row so it can't be accepted later.
        await prisma.follows
          .deleteMany({
            where: { follower_id: followerId, following_id: currentUserId },
          })
          .catch(() => {});
        return res.status(404).json({ error: 'Follower account no longer exists.' });
      }

      await prisma.follows.update({
        where: {
          follower_id_following_id: { follower_id: followerId, following_id: currentUserId },
        },
        data: { status: 'accepted' },
      });
      await invalidateFollowCaches(followerId, currentUserId);

      // Notify the follower that their request was accepted
      try {
        await (prisma as any).notification.create({
          data: {
            user_id: followerId,
            actor_id: currentUserId,
            type: 'FOLLOW' as any,
          },
        });

        // Send push notification that follow request was accepted
        const currentUser = await prisma.user.findUnique({
          where: { id: currentUserId },
          select: { display_name: true, username: true },
        });
        const actorLabel =
          currentUser?.display_name ||
          (currentUser?.username ? `@${currentUser.username}` : 'Someone');
        sendPushNotification(
          followerId,
          'Follow Request Accepted',
          `${actorLabel} accepted your follow request`,
          { type: 'new_follower', screen: 'user-profile', user_id: currentUserId }
        ).catch(err => console.warn('Failed to send follow accept push:', err));
      } catch (e) {
        console.error('Failed to send follow accept notification:', e);
      }

      res.json({ ok: true, status: 'accepted' });
    } catch (error) {
      console.error('Accept follow error:', error);
      res.status(500).json({ error: 'Something went wrong.' });
    }
  })
);

// Reject a follow request (for private profiles)
usersRouter.post(
  '/:id/reject-follow',
  requireAuth as any,
  requireVerified as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const currentUserId = req.user!.id;
    const followerId = req.params.id;

    try {
      const deleted = await prisma.follows.deleteMany({
        where: { follower_id: followerId, following_id: currentUserId, status: 'pending' },
      });
      if (deleted.count > 0) {
        await invalidateFollowCaches(followerId, currentUserId);
      }

      // Notify the requester that their follow request was declined
      if (deleted.count > 0) {
        try {
          await prisma.notification.create({
            data: {
              user_id: followerId,
              actor_id: currentUserId,
              type: 'FOLLOW',
              meta: { follow_rejected: true },
            },
          });
        } catch (e) {
          console.error('Failed to create follow rejection notification:', e);
        }
      }

      res.json({ ok: true });
    } catch (error) {
      console.error('Reject follow error:', error);
      res.status(500).json({ error: 'Something went wrong.' });
    }
  })
);

// Suggested users to follow — people the current user doesn't follow yet
// Ordered by: mutual connections first, then follower count
usersRouter.get(
  '/me/suggested',
  requireAuth as any,
  requireVerified as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const currentUserId = req.user!.id;
    const limit = Math.max(1, Math.min(parseInt(String(req.query.limit || '10'), 10) || 10, 20));

    // Get IDs the current user already follows + their own ID to exclude
    const alreadyFollowing = await prisma.follows.findMany({
      where: { follower_id: currentUserId },
      select: { following_id: true },
      take: 2000,
    });
    const excludeIds = new Set([currentUserId, ...alreadyFollowing.map(f => f.following_id)]);

    // Get blocked user IDs (both directions)
    const blocks = await prisma.blockedUser.findMany({
      where: { OR: [{ blocker_id: currentUserId }, { blocked_id: currentUserId }] },
      select: { blocker_id: true, blocked_id: true },
      take: 1000,
    });
    for (const b of blocks) {
      excludeIds.add(b.blocker_id);
      excludeIds.add(b.blocked_id);
    }
    const privateAuthorIds = await getExcludedPrivateAuthorIds(currentUserId);
    for (const id of privateAuthorIds) excludeIds.add(id);

    const adultCutoff = new Date();
    adultCutoff.setFullYear(adultCutoff.getFullYear() - 18);

    // Get IDs of people the current user follows, to find mutual connections
    const myFollowingIds = alreadyFollowing.map(f => f.following_id);

    // Find users who follow at least one person the current user follows (mutual connection signal)
    // Also pull in active onboarded users ordered by follower count as a fallback
    const candidates = await prisma.user.findMany({
      where: {
        id: { notIn: Array.from(excludeIds) },
        onboarding_completed: true,
        banned: false,
        deleted_at: null,
        OR: [{ date_of_birth: null }, { date_of_birth: { lte: adultCutoff } }],
      },
      select: {
        ...publicUserSelect,
        role: true,
        approval_status: true,
        _count: { select: { followers: { where: { status: 'accepted' } } } },
      },
      orderBy: { followers: { _count: 'desc' } },
      take: 50,
    });

    // Score by mutual connections: count how many of their followers also follow me or I follow
    const myFollowingSet = new Set(myFollowingIds);
    const candidateIds = candidates.map(c => c.id);

    let mutualScores: Map<string, number> = new Map();
    if (myFollowingSet.size > 0 && candidateIds.length > 0) {
      const mutuals = await prisma.follows.findMany({
        where: {
          follower_id: { in: candidateIds },
          following_id: { in: myFollowingIds },
          status: 'accepted',
        },
        select: { follower_id: true },
        take: 500,
      });
      for (const m of mutuals) {
        mutualScores.set(m.follower_id, (mutualScores.get(m.follower_id) ?? 0) + 1);
      }
    }

    // Sort: mutual score desc, then follower count desc
    const scored = candidates
      .map(c => ({ ...c, mutualScore: mutualScores.get(c.id) ?? 0 }))
      .sort((a, b) => b.mutualScore - a.mutualScore || b._count.followers - a._count.followers)
      .slice(0, limit);

    res.json({
      items: scored.map(u => ({
        id: u.id,
        username: u.username,
        display_name: u.display_name,
        avatar_url: u.avatar_url,
        role: u.role,
        followers_count: u._count.followers,
        mutual_count: u.mutualScore,
        is_following: false,
      })),
    });
  })
);

// Get followers/following
registerProfileFollowListRoute('/:id/followers', 'followers');
registerProfileFollowListRoute('/:id/following', 'following');

// Search users for mentions/tagging
usersRouter.get(
  '/search/mentions',
  requireAuth as any,
  mentionsSearchLimiter as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const currentUserId = req.user!.id;
    const query = String((req.query as any).q || '')
      .trim()
      .toLowerCase();
    const limit = Math.max(
      1,
      Math.min(parseInt(String((req.query as any).limit || '10'), 10) || 10, 20)
    );

    if (!query) {
      return res.json({ users: [] });
    }

    // Search users by public profile fields only. Email matching here turns an
    // @mention helper into a directory-enumeration surface for authenticated users.
    const users = await prisma.user.findMany({
      where: {
        AND: [
          { banned: false },
          {
            OR: [
              // Search by username
              { username: { contains: query, mode: 'insensitive' } },
              { display_name: { contains: query, mode: 'insensitive' } },
            ],
          },
        ],
      },
      select: {
        id: true,
        username: true,
        display_name: true,
        avatar_url: true,
        preferences: true,
      },
      take: limit,
      orderBy: [{ display_name: 'asc' }],
    });

    // Filter out organization accounts and ensure safe defaults
    const safeUsers = users
      .filter(user => (user.preferences as any)?.account_type !== 'organization')
      .map(user => ({
        id: user.id,
        username: user.username || null,
        display_name: user.display_name || user.username || 'User',
        avatar_url: user.avatar_url,
      }));

    res.json(safeUsers);
  })
);

// Get blocked users
// NOTE: Must be defined BEFORE the /:id catch-all route, otherwise Express
// matches "blocked" as an :id parameter and returns 404.
usersRouter.get(
  '/blocked',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      // Accept a caller-supplied `limit` (clamped 1..500 default 100) and an
      // optional cursor of the blocked user id to paginate past. Previously the
      // endpoint hardcoded take: 500 with no pagination, silently truncating
      // the list for anyone with more than 500 blocks.
      const rawLimit = Number.parseInt(String(req.query.limit ?? ''), 10);
      const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100;
      const cursorId =
        typeof req.query.cursor === 'string' && req.query.cursor.length > 0
          ? String(req.query.cursor)
          : null;

      const blocks = await prisma.blockedUser.findMany({
        where: { blocker_id: req.user!.id },
        include: {
          blocked: {
            select: {
              id: true,
              display_name: true,
              username: true,
              avatar_url: true,
            },
          },
        },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        take: limit + 1, // one extra to determine if there's another page
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      });

      const hasMore = blocks.length > limit;
      const page = hasMore ? blocks.slice(0, limit) : blocks;
      const nextCursor = hasMore ? page[page.length - 1].id : null;

      return res.json({
        items: page.map(b => b.blocked),
        next_cursor: nextCursor,
        // Keep a flat array at the root too so existing clients that expect
        // the old shape (list of users directly) keep working until they
        // migrate to the paginated shape.
        blocked: page.map(b => b.blocked),
      });
    } catch (error) {
      console.error('Get blocked users error:', error);
      return res.status(500).json({ error: 'Failed to get blocked users' });
    }
  })
);

// Public profile: basic user info plus counts and is_following flag
// When profile_private is true, non-followers see only display_name and avatar_url.
// NOTE: Keep this AFTER more specific routes like /:id/full, /:id/posts, etc.,
// so it doesn't shadow them.
usersRouter.get(
  '/:id',
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = String(req.params.id);
    const currentUserId = req.user?.id || null;

    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        username: true,
        display_name: true,
        avatar_url: true,
        bio: true,
        created_at: true,
        preferences: true,
      },
    });
    if (!user) return res.status(404).json({ error: 'Not found' });

    const prefs = (user.preferences || {}) as any;
    const profile_private = prefs?.profile_private === true;

    // Check if viewer is the profile owner or a follower
    let isFollower = false;
    let viewerFollowStatus: string | null = null;
    if (currentUserId === id) {
      isFollower = true; // Owner always sees full profile
    } else if (currentUserId) {
      const rel = await prisma.follows.findUnique({
        where: { follower_id_following_id: { follower_id: currentUserId, following_id: id } },
        select: { follower_id: true, status: true },
      });
      isFollower = Boolean(rel) && rel?.status === 'accepted';
      viewerFollowStatus = rel?.status || null;
    }

    // A block (either direction) hides the full profile — a blocked user must
    // not be able to monitor the blocker's profile even when it's public.
    // Audit 2026-07-14 (the feed block-filters; this route did not).
    if (currentUserId && currentUserId !== id) {
      const block = await prisma.blockedUser.findFirst({
        where: {
          OR: [
            { blocker_id: currentUserId, blocked_id: id },
            { blocker_id: id, blocked_id: currentUserId },
          ],
        },
        select: { blocker_id: true },
      });
      if (block) {
        return res.json({
          id: user.id,
          display_name: user.display_name,
          avatar_url: user.avatar_url,
          profile_private,
          profile_restricted: true,
          profile_restricted_reason: 'blocked',
          is_following: false,
          follow_status: null,
        });
      }
    }

    // Private profile: non-followers get only basic info
    if (profile_private && !isFollower) {
      return res.json({
        id: user.id,
        display_name: user.display_name,
        avatar_url: user.avatar_url,
        profile_private: true,
        profile_restricted: true,
        profile_restricted_reason: 'private',
        is_following: false,
        follow_status: viewerFollowStatus,
      });
    }

    // The viewer's follow relationship was already read above (`rel` ->
    // viewerFollowStatus); re-querying it here was a second identical
    // findUnique on the same unique key. viewerFollowStatus is exactly
    // equivalent in all three cases: viewing yourself (null, since a self-follow
    // row never exists), viewing someone else (the same row), and signed-out
    // (null).
    const [posts_count, followers_count, following_count] = await Promise.all([
      prisma.post.count({ where: { author_id: id, deleted_at: null } }),
      prisma.follows.count({ where: { following_id: id, status: 'accepted' } }),
      prisma.follows.count({ where: { follower_id: id, status: 'accepted' } }),
    ]);

    return res.json({
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      avatar_url: user.avatar_url,
      bio: user.bio,
      created_at: user.created_at,
      posts_count,
      followers_count,
      following_count,
      is_following: viewerFollowStatus === 'accepted',
      follow_status: viewerFollowStatus,
    });
  })
);

// Block a user
usersRouter.post(
  '/:id/block',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const blocker_id = req.user!.id;
    const blocked_id = req.params.id;

    if (blocker_id === blocked_id) {
      return res.status(400).json({ error: 'Cannot block yourself' });
    }

    try {
      await prisma.blockedUser.create({
        data: {
          blocker_id,
          blocked_id,
        },
      });

      // Remove follow relationships in both directions
      await prisma.follows.deleteMany({
        where: {
          OR: [
            { follower_id: blocker_id, following_id: blocked_id },
            { follower_id: blocked_id, following_id: blocker_id },
          ],
        },
      });

      await invalidateFollowCaches(blocker_id, blocked_id);
      invalidateBlockedIdsCache(blocker_id);
      invalidateBlockedIdsCache(blocked_id);

      return res.status(201).json({ success: true });
    } catch (error: any) {
      // Handle duplicate blocking
      if (error.code === 'P2002') {
        return res.status(200).json({ success: true, message: 'User already blocked' });
      }
      console.error('Block user error:', error);
      return res.status(500).json({ error: 'Failed to block user' });
    }
  })
);

// Unblock a user
usersRouter.delete(
  '/:id/block',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const blocker_id = req.user!.id;
    const blocked_id = req.params.id;

    try {
      await prisma.blockedUser.deleteMany({
        where: {
          blocker_id,
          blocked_id,
        },
      });
      invalidateBlockedIdsCache(blocker_id);
      invalidateBlockedIdsCache(blocked_id);
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('Unblock user error:', error);
      return res.status(500).json({ error: 'Failed to unblock user' });
    }
  })
);
