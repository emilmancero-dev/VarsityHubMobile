import escapeHtml from 'escape-html';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { authMiddleware, type AuthedRequest } from '../middleware/auth.js';
import { requireAdmin, isEmailAdmin, getIsAdmin } from '../middleware/requireAdmin.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireVerified } from '../middleware/requireVerified.js';
import { requireOnboarded } from '../middleware/requireOnboarded.js';
import { makeCreateStoryHandler, makeListMediaHandler, serializeMedia } from './gameStories.js';
import { debugLog } from '../lib/debugLog.js';
import { gameCreationLimiter, voteLimiter } from '../middleware/rateLimiters.js';
import { detectMediaType, getVideoPreviewUrl } from '../lib/mediaUtils.js';
import { getExcludedPrivateAuthorIds } from '../lib/privacyUtils.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { registerIdValidation } from '../middleware/validateParams.js';
import { cacheDelPattern, cacheGet, cacheSet } from '../lib/cache.js';
import { isAdminEmail } from '../lib/adminEmails.js';
import { canManageAnyTeam, canManageTeam as canManageTeamScoped } from '../lib/teamAuthorization.js';
import { sendError } from '../lib/http/sendError.js';
import { notifyPendingEventReviewers } from '../lib/eventReviewNotifications.js';
import { sendEventApprovedEmail, sendEventDeniedEmail } from '../lib/email.js';
import { consumeReviewToken, verifyReviewToken } from '../lib/reviewTokens.js';

export const gamesRouter = Router();
registerIdValidation(gamesRouter);
const shouldRunStartupBackfills =
  process.env.NODE_ENV !== 'test' && process.env.JEST_WORKER_ID == null;

async function invalidateGamesListCache(): Promise<void> {
  await cacheDelPattern('games:*');
}

function renderGameReviewPage(action: 'approve' | 'reject', title: string, token: string) {
  const headline = action === 'approve' ? 'Approve Game' : 'Reject Game';
  const button = action === 'approve' ? 'Approve Game' : 'Reject Game';
  const color = action === 'approve' ? '#16A34A' : '#DC2626';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${headline}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:60px auto;padding:20px;text-align:center;">
<h2>${headline}?</h2>
<p style="color:#374151;">Game: <strong>${escapeHtml(title || 'Unknown')}</strong></p>
<form method="POST" action="?token=${encodeURIComponent(token)}">
<button type="submit" style="background:${color};color:#fff;border:none;padding:12px 32px;border-radius:8px;font-size:16px;cursor:pointer;">${button}</button>
</form>
</body></html>`;
}

function renderGameResultPage(title: string, message: string, success: boolean) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:60px auto;padding:20px;text-align:center;">
<h2 style="color:${success ? '#16A34A' : '#DC2626'};">${escapeHtml(title)}</h2>
<p style="color:#374151;">${escapeHtml(message)}</p>
</body></html>`;
}

async function applyGameApprovalDecision(
  id: string,
  approvalStatus: 'approved' | 'rejected',
  actingUserId: string | null,
  reason?: string | null
) {
  const isApproved = approvalStatus === 'approved';
  const approvalAppliedAt = isApproved ? new Date() : null;
  const updatedGame = await prisma.$transaction(async (tx) => {
    const transition = await (tx.game.updateMany as any)({
      where: { id, approval_status: 'pending' },
      data: {
        approval_status: approvalStatus,
        approved_by_id: isApproved ? actingUserId : null,
        approved_at: approvalAppliedAt,
      },
    });
    if (transition.count === 0) return null;

    await tx.event.updateMany({
      where: { game_id: id },
      data: {
        approval_status: approvalStatus,
        status: isApproved ? 'approved' : 'rejected',
        ...(isApproved
          ? { approved_at: approvalAppliedAt, rejected_reason: null }
          : { approved_at: null, rejected_reason: reason || null }),
      },
    });

    return (tx.game.findUnique as any)({
      where: { id },
    });
  });

  if (!updatedGame) {
    return { error: 'Game approval status changed before this action completed', status: 409 as const };
  }
  await invalidateGamesListCache();

  if (updatedGame.created_by_id && updatedGame.created_by_id !== actingUserId) {
    try {
      const [linkedEvent, creator] = await Promise.all([
        prisma.event.findFirst({
          where: { game_id: id },
          select: { id: true },
          orderBy: { date: 'asc' },
        }),
        prisma.user.findUnique({
          where: { id: updatedGame.created_by_id },
          select: { email: true, display_name: true },
        }),
      ]);
      const eventId = linkedEvent?.id || null;
      const eventDate = updatedGame.date ? new Date(updatedGame.date) : null;

      const { sendPushNotification } = await import('../lib/notifications.js');
      if (approvalStatus === 'approved') {
        sendPushNotification(
          updatedGame.created_by_id,
          'Event Approved!',
          `Your event "${updatedGame.title}" has been approved and is now live.`,
          { type: 'event_approved', game_id: id, event_id: eventId }
        ).catch(() => {});
        await prisma.notification.create({
          data: {
            user_id: updatedGame.created_by_id,
            type: 'EVENT_APPROVED' as any,
            meta: { game_id: id, event_id: eventId, event_title: updatedGame.title },
          },
        });
        if (creator?.email) {
          await sendEventApprovedEmail({
            to: creator.email,
            recipientName: creator.display_name || 'User',
            eventTitle: updatedGame.title,
            eventDate: eventDate
              ? eventDate.toLocaleDateString('en-US', {
                  weekday: 'long',
                  month: 'long',
                  day: 'numeric',
                  year: 'numeric',
                })
              : undefined,
            eventTime: eventDate
              ? eventDate.toLocaleTimeString('en-US', {
                  hour: 'numeric',
                  minute: '2-digit',
                })
              : undefined,
            eventLocation: updatedGame.location || undefined,
            eventId: eventId || undefined,
          });
        }
      } else {
        sendPushNotification(
          updatedGame.created_by_id,
          'Event Not Approved',
          `Your event "${updatedGame.title}" was not approved.${reason ? ` Reason: ${reason}` : ''}`,
          { type: 'event_rejected', game_id: id, event_id: eventId }
        ).catch(() => {});
        await prisma.notification.create({
          data: {
            user_id: updatedGame.created_by_id,
            type: 'EVENT_REJECTED' as any,
            meta: {
              game_id: id,
              event_id: eventId,
              event_title: updatedGame.title,
              reason: reason || undefined,
            },
          },
        });
        if (creator?.email) {
          await sendEventDeniedEmail({
            to: creator.email,
            recipientName: creator.display_name || 'User',
            eventTitle: updatedGame.title,
            eventDate: eventDate
              ? eventDate.toLocaleDateString('en-US', {
                  weekday: 'long',
                  month: 'long',
                  day: 'numeric',
                  year: 'numeric',
                })
              : undefined,
            reason: reason || undefined,
          });
        }
      }
    } catch (notifErr) {
      console.warn('[games] Failed to notify creator of approval decision:', notifErr);
    }
  }

  return { game: updatedGame };
}

async function handleGameTokenReview(req: AuthedRequest, res: Response, action: 'approve' | 'reject') {
  const id = String(req.params.id);
  const token = typeof req.query?.token === 'string' ? req.query.token : undefined;
  const payload = token
    ? verifyReviewToken<{ reviewId: string; reviewKind: string; action: string }>(token)
    : null;
  const expectedAction = action === 'approve' ? 'approve_game' : 'reject_game';

  if (!token || !payload || payload.reviewId !== id || payload.reviewKind !== 'game' || payload.action !== expectedAction) {
    return res
      .status(401)
      .send(renderGameResultPage('Invalid Link', `This ${action} link is invalid or has expired.`, false));
  }

  const game = await (prisma.game.findUnique as any)({
    where: { id },
    select: { title: true },
  });
  if (!game) {
    return res.status(404).send(renderGameResultPage('Not Found', 'Game not found.', false));
  }

  if (req.method === 'GET') {
    return res.send(renderGameReviewPage(action, game.title || 'Unknown', token));
  }

  const consumeResult = await consumeReviewToken(token, payload);
  if (consumeResult === 'already_used') {
    return res
      .status(409)
      .send(renderGameResultPage('Link Already Used', `This ${action} link has already been used.`, false));
  }
  if (consumeResult === 'store_unavailable') {
    return res
      .status(503)
      .send(renderGameResultPage('Temporarily Unavailable', `This ${action} link cannot be completed right now. Please use the admin dashboard instead.`, false));
  }

  const reason = typeof (req.body as any)?.reason === 'string' ? String((req.body as any).reason).trim() : undefined;
  const reviewerUserId = req.user?.id ?? null;
  const result = await applyGameApprovalDecision(
    id,
    action === 'approve' ? 'approved' : 'rejected',
    reviewerUserId,
    reason
  );
  if ('error' in result) {
    return res
      .status(result.status!)
      .send(renderGameResultPage('Error', result.error!, false));
  }

  return res.send(
    renderGameResultPage(
      action === 'approve' ? 'Game Approved' : 'Game Rejected',
      `${game.title || 'This game'} has been ${action === 'approve' ? 'approved' : 'rejected'}.`,
      true
    )
  );
}

// One-time startup backfill: geocode games that have a location string but no coordinates.
// Fire-and-forget — safe to run repeatedly (skips games already populated).
if (shouldRunStartupBackfills) {
  void (async () => {
    try {
      const missing = await (prisma.game.findMany as any)({
        where: { location: { not: null }, latitude: null, venue_lat: null },
        select: { id: true, location: true },
        take: 1000,
      });
      if (missing.length === 0) return;
      console.log(`[games] backfill: geocoding ${missing.length} games without coordinates`);
      const { geocodeLocation } = await import('../lib/geocoding.js');
      let success = 0;
      let failed = 0;
      for (const game of missing) {
        try {
          const coords = await geocodeLocation(game.location!);
          if (coords) {
            await (prisma.game.update as any)({
              where: { id: game.id },
              data: { latitude: coords.latitude, longitude: coords.longitude },
            });
            await prisma.event.updateMany({
              where: { game_id: game.id, latitude: null },
              data: { latitude: coords.latitude, longitude: coords.longitude },
            });
            success++;
          } else {
            failed++;
            console.warn(
              `[games] backfill: geocode returned null for game ${game.id} location="${game.location}"`
            );
          }
        } catch (err: any) {
          failed++;
          console.error(
            `[games] backfill: failed game ${game.id} location="${game.location}":`,
            err?.message || err
          );
        }
      }
      console.log(
        `[games] backfill: done — ${success} geocoded, ${failed} failed out of ${missing.length}`
      );
    } catch (err) {
      console.warn('[games] backfill failed:', err);
    }
  })();
}

// Helper function to generate Google Maps links
const generateMapsLink = (
  location?: string | null,
  lat?: number | null,
  lng?: number | null,
  placeId?: string | null
): string | null => {
  if (!location && !lat && !lng && !placeId) return null;

  // If we have a place ID, use that for the most accurate link
  if (placeId) {
    return `https://www.google.com/maps/place/?q=place_id:${placeId}`;
  }

  // If we have coordinates, use those
  if (lat !== null && lng !== null) {
    return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
  }

  // Fall back to location text search
  if (location) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location)}`;
  }

  return null;
};

const serializePost = (post: any) => ({
  ...post,
  created_at: post.created_at instanceof Date ? post.created_at.toISOString() : post.created_at,
  media_type: detectMediaType(post.media_url),
  preview_url: getVideoPreviewUrl(post.media_url),
  // username MUST be included so the vertical feed can tap through to @username
  // profile and caption overlays can render "@username" correctly. Omitting it
  // here meant GameVerticalFeedScreen's avatar/caption taps silently no-op'd.
  author: post.author
    ? {
        id: post.author.id,
        username: post.author.username,
        display_name: post.author.display_name,
        avatar_url: post.author.avatar_url,
      }
    : null,
});

const serializeEvent = (event: any | null) =>
  event
    ? {
        id: event.id,
        date: event.date instanceof Date ? event.date.toISOString() : event.date,
        location: event.location,
        banner_url: event.banner_url,
        capacity: event.capacity,
      }
    : null;

const pickBannerUrl = (game: any, event: any | null, media: Array<{ url: string }>) => {
  // Fixed: Prioritize game.banner_url first, then fallback to others
  if (game?.banner_url) return game.banner_url;
  if (game?.cover_image_url) return game.cover_image_url;
  if (event?.banner_url) return event.banner_url;
  return media.length > 0 ? (media[0]?.url ?? null) : null;
};

const summarizeVotes = async (gameId: string, userId?: string | null) => {
  const [teamA, teamB, mine] = await Promise.all([
    prisma.gameVote.count({ where: { game_id: gameId, team: 'A' } }),
    prisma.gameVote.count({ where: { game_id: gameId, team: 'B' } }),
    userId
      ? prisma.gameVote.findUnique({
          where: { game_id_user_id: { game_id: gameId, user_id: userId } },
        })
      : Promise.resolve(null),
  ]);
  const total = teamA + teamB;
  const pctA = total ? Math.round((teamA / total) * 100) : 0;
  const pctB = total ? 100 - pctA : 0;
  return { teamA, teamB, total, pctA, pctB, userVote: mine?.team ?? null };
};

type GameVisibilityRecord = {
  approval_status?: string | null;
  created_by_id?: string | null;
  home_team_id?: string | null;
  away_team_id?: string | null;
};

async function canViewGameRecord(
  record: GameVisibilityRecord,
  viewerId?: string | null
): Promise<boolean> {
  if (record.approval_status === 'approved') return true;
  if (!viewerId) return false;
  if (record.created_by_id && record.created_by_id === viewerId) return true;

  const viewer = await prisma.user.findUnique({
    where: { id: viewerId },
    select: { email: true },
  });
  if (isEmailAdmin(viewer?.email)) return true;

  const teamIds = [record.home_team_id, record.away_team_id].filter(Boolean) as string[];
  if (teamIds.length === 0) return false;

  const teamMembership = await prisma.teamMembership.findFirst({
    where: {
      user_id: viewerId,
      team_id: { in: teamIds },
      role: { in: ['owner', 'manager', 'coach', 'assistant_coach'] },
      status: 'active',
    },
    select: { id: true },
  });
  if (teamMembership) return true;

  const teams = await prisma.team.findMany({
    where: { id: { in: teamIds } },
    select: { organization_id: true },
  });
  const organizationIds = teams.map(team => team.organization_id).filter(Boolean) as string[];
  if (organizationIds.length === 0) return false;

  const orgMembership = await prisma.organizationMembership.findFirst({
    where: {
      user_id: viewerId,
      organization_id: { in: organizationIds },
      role: { in: ['owner', 'manager'] },
      status: 'active',
    },
    select: { id: true },
  });
  return !!orgMembership;
}

gamesRouter.get('/', asyncHandler(async (req, res) => {
  try {
    const sort = String(req.query.sort || '').trim();
    const orderBy =
      sort === '-date'
        ? { date: 'desc' as const }
        : sort === 'date'
          ? { date: 'asc' as const }
          : { created_at: 'desc' as const };

    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor.trim() : null;
    const limitRaw = Number.parseInt(String(req.query.limit ?? ''), 10);
    // Default to 20 when no limit is provided; cap at 100 to prevent unbounded fetches
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 20;
    const lat = Number.parseFloat(String(req.query.lat ?? ''));
    const lng = Number.parseFloat(String(req.query.lng ?? ''));
    const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
    const dateFromRaw = req.query.from ? new Date(String(req.query.from)) : null;
    const dateToRaw = req.query.to ? new Date(String(req.query.to)) : null;

    const authedReq = req as AuthedRequest;

    // By default, only show approved games unless specifically requested otherwise
    const showPending = req.query.show_pending === 'true';
    const approvalStatus = req.query.approval_status as string;
    const normalizedApprovalStatus =
      typeof approvalStatus === 'string' ? approvalStatus.trim().toLowerCase() : '';
    const wantsNonApproved =
      showPending || (normalizedApprovalStatus !== '' && normalizedApprovalStatus !== 'approved');
    const shouldUseGamesCache = !wantsNonApproved;
    const viewerScope = authedReq.user?.id ? `user:${authedReq.user.id}` : 'anon';
    const cacheRequestUrl = req.originalUrl || req.url;
    const gameCacheKey = `games:${viewerScope}:${cacheRequestUrl}`;

    if (shouldUseGamesCache) {
      const cachedGames = await cacheGet(gameCacheKey);
      if (cachedGames) return res.json(cachedGames);
    }

    let canViewNonApproved = false;
    if (wantsNonApproved) {
      if (!authedReq.user?.id) {
        return res
          .status(403)
          .json({ error: 'Only coaches and admins can view non-approved games' });
      }

      const requester = await prisma.user.findUnique({
        where: { id: authedReq.user.id },
        select: { email: true },
      });
      const isAdmin = isEmailAdmin(requester?.email);
      if (isAdmin) {
        canViewNonApproved = true;
      } else {
        const [teamRole, orgRole] = await Promise.all([
          prisma.teamMembership.findFirst({
            where: {
              user_id: authedReq.user.id,
              role: { in: ['owner', 'manager', 'coach', 'assistant_coach'] },
              status: 'active',
            },
            select: { id: true },
          }),
          prisma.organizationMembership.findFirst({
            where: {
              user_id: authedReq.user.id,
              role: { in: ['owner', 'manager'] },
              status: 'active',
            },
            select: { id: true },
          }),
        ]);
        canViewNonApproved = !!teamRole || !!orgRole;
      }

      if (!canViewNonApproved) {
        return res
          .status(403)
          .json({ error: 'Only coaches and admins can view non-approved games' });
      }
    }

    // Build where clause
    let whereClause: any = {};
    if (
      normalizedApprovalStatus &&
      ['pending', 'approved', 'rejected'].includes(normalizedApprovalStatus)
    ) {
      whereClause.approval_status = normalizedApprovalStatus;
    } else if (showPending) {
      whereClause.approval_status = 'pending';
    } else {
      whereClause.approval_status = 'approved';
    }

    // Scope non-approved games to the coach's managed teams/orgs (prevent data leak).
    // Admins see all; regular coaches only see pending games for their teams.
    if (wantsNonApproved && canViewNonApproved && authedReq.user?.id) {
      const requester = await prisma.user.findUnique({
        where: { id: authedReq.user.id },
        select: { email: true },
      });
      const isAdmin = isEmailAdmin(requester?.email);
      if (!isAdmin) {
        // Get team IDs and org IDs the coach manages
        const [managedTeams, managedOrgs] = await Promise.all([
          prisma.teamMembership.findMany({
            where: {
              user_id: authedReq.user.id,
              role: { in: ['owner', 'manager', 'coach', 'assistant_coach'] },
              status: 'active',
            },
            select: { team_id: true },
          }),
          prisma.organizationMembership.findMany({
            where: {
              user_id: authedReq.user.id,
              role: { in: ['owner', 'manager'] },
              status: 'active',
            },
            select: { organization_id: true },
          }),
        ]);
        const teamIds = managedTeams.map(m => m.team_id);
        const orgIds = managedOrgs.map(m => m.organization_id);

        // Also include teams that belong to managed orgs
        let orgTeamIds: string[] = [];
        if (orgIds.length > 0) {
          const orgTeams = await prisma.team.findMany({
            where: { organization_id: { in: orgIds } },
            select: { id: true },
          });
          orgTeamIds = orgTeams.map(t => t.id);
        }

        const allTeamIds = [...new Set([...teamIds, ...orgTeamIds])];
        if (allTeamIds.length > 0) {
          whereClause.OR = [
            { home_team_id: { in: allTeamIds } },
            { away_team_id: { in: allTeamIds } },
          ];
        } else {
          // Coach has no teams — return no pending games
          whereClause.id = '__no_managed_teams__';
        }
      }
    }

    // Filter by team_id (matches home OR away team). Uses AND to not conflict with show_pending OR scoping.
    const teamIdFilter = typeof req.query.team_id === 'string' ? req.query.team_id.trim() : null;
    if (teamIdFilter) {
      if (!whereClause.AND) whereClause.AND = [];
      whereClause.AND.push({
        OR: [{ home_team_id: teamIdFilter }, { away_team_id: teamIdFilter }],
      });
    }

    if (
      (dateFromRaw && !Number.isNaN(dateFromRaw.getTime())) ||
      (dateToRaw && !Number.isNaN(dateToRaw.getTime()))
    ) {
      whereClause.date = {};
      if (dateFromRaw && !Number.isNaN(dateFromRaw.getTime())) {
        whereClause.date.gte = dateFromRaw;
      }
      if (dateToRaw && !Number.isNaN(dateToRaw.getTime())) {
        whereClause.date.lte = dateToRaw;
      }
    }

    // v1.0.2: map_view=true restricts to "games this week" (today through +7 days).
    // Test note: once a game is in the past it should drop off the map. Map should only
    // reflect games the week of in real time. This filter is opt-in so list views still work as before.
    if (req.query.map_view === 'true' || req.query.map_view === '1') {
      const now = new Date();
      const weekFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      whereClause.date = { ...(whereClause.date || {}), gte: now, lte: weekFromNow };
    }

    const games = await (prisma.game.findMany as any)({
      where: Object.keys(whereClause).length > 0 ? whereClause : undefined,
      orderBy,
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: {
        events: { orderBy: { date: 'asc' }, take: 1 },
        _count: { select: { events: true } },
        // Load the creator so Event Approvals can show a "submitted by" label
        // on pending game cards. Without this, the client-side filter at
        // event-approvals.tsx `g.created_by ? {...} : undefined` always hits
        // the `undefined` branch and the submitter name is dropped.
        created_by: {
          select: { id: true, display_name: true, username: true, avatar_url: true },
        },
      },
    });

    const hasMore = games.length > limit;
    const results = hasMore ? games.slice(0, limit) : games;

    // Get RSVP counts for all games with events
    const eventIds = results.map((g: any) => g.events[0]?.id).filter(Boolean);

    const rsvpCounts =
      eventIds.length > 0
        ? await prisma.eventRsvp.groupBy({
            by: ['event_id'],
            _count: { _all: true },
            where: { event_id: { in: eventIds } },
          })
        : [];

    const rsvpMap = new Map(rsvpCounts.map(r => [r.event_id, r._count._all]));

    const payload = results.map((game: any) => {
      const event = game.events[0] ?? null;
      const { events, _count, created_by: createdByUser, ...rest } = game as any;
      let distance: number | null = null;
      if (hasCoords && typeof rest.latitude === 'number' && typeof rest.longitude === 'number') {
        const dLat = ((rest.latitude - lat) * Math.PI) / 180;
        const dLng = ((rest.longitude - lng) * Math.PI) / 180;
        const a =
          Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos((lat * Math.PI) / 180) *
            Math.cos((rest.latitude * Math.PI) / 180) *
            Math.sin(dLng / 2) *
            Math.sin(dLng / 2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        distance = 6371 * c; // km
      }
      return {
        ...rest,
        appearance: rest.appearance ?? null,
        event_id: event?.id ?? null,
        // Fixed: Prioritize game.banner_url over other sources
        banner_url: rest.banner_url || rest.cover_image_url || event?.banner_url || null,
        rsvpCount: event ? rsvpMap.get(event.id) || 0 : 0,
        // Include coordinates for map display
        latitude: rest.latitude,
        longitude: rest.longitude,
        distance,
        // Creator info for Event Approvals "submitted by" label. `created_by`
        // is the full object (truthy when a creator is present); the flat
        // created_by_name alias matches the client shape in event-approvals.tsx.
        created_by: createdByUser ?? null,
        created_by_name: createdByUser?.display_name ?? createdByUser?.username ?? null,
      };
    });

    if (hasCoords) {
      payload.sort((a: any, b: any) => {
        if (typeof a.distance !== 'number' && typeof b.distance !== 'number') return 0;
        if (typeof a.distance !== 'number') return 1;
        if (typeof b.distance !== 'number') return -1;
        return a.distance - b.distance;
      });
    }

    const lastId = payload.length > 0 ? payload[payload.length - 1].id : null;
    const gamesResponse = { games: payload, nextCursor: hasMore ? lastId : null };
    if (shouldUseGamesCache) {
      void cacheSet(gameCacheKey, gamesResponse, 120); // 120s TTL
    }
    res.json(gamesResponse);
  } catch (err) {
    console.error('[games] GET / error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}));

// Create a new game
gamesRouter.post(
  '/',
  requireVerified as any,
  requireOnboarded as any,
  gameCreationLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    const schema = z.object({
      title: z.string().trim().min(1).max(200),
      home_team: z.string().trim().optional(), // Home team name for display
      away_team: z.string().trim().optional(), // Away team name for display
      home_team_id: z.string().trim().optional(), // Team ID for home team
      away_team_id: z.string().trim().optional(), // Team ID if opponent exists in system
      away_team_name: z.string().trim().optional(), // Manual opponent name if not in system
      date: z.string().datetime().optional(),
      location: z.string().trim().min(1, 'Location is required'),
      description: z.string().trim().optional(),
      cover_image_url: z.string().url().optional(),
      banner_url: z.string().url().optional(),
      // Optional appearance preset chosen by coach (e.g. 'classic','sparkle','sporty')
      appearance: z.string().optional(),
      // Expected attendance for events
      expected_attendance: z.number().int().min(1).max(99999).optional(),
      // Event type (game, fundraiser, watch_party, team_trip, meeting, other)
      event_type: z
        .enum([
          'game',
          'fundraiser',
          'watch_party',
          'team_trip',
          'meeting',
          'team_meal',
          'tryout',
          'bbq',
          'team_meeting',
          'host_request',
          'other',
        ])
        .optional(),
      // Event type-specific fields
      donation_goal: z.number().min(0).optional(), // For fundraisers
      watch_location: z.string().trim().max(200).optional(), // For watch parties
      watch_location_lat: z.number().min(-90).max(90).optional(), // Watch party latitude
      watch_location_lng: z.number().min(-180).max(180).optional(), // Watch party longitude
      watch_location_place_id: z.string().optional(), // Watch party Google Place ID
      destination: z.string().trim().max(200).optional(), // For team trips
      // Coordinate options
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
      autoGeocode: z.boolean().optional(),
      // Venue information for opponent's location
      venue_place_id: z.string().optional(),
      venue_address: z.string().trim().optional(),
      venue_lat: z.number().optional(),
      venue_lng: z.number().optional(),
      is_neutral: z.boolean().optional(),
    });

    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      console.warn('create game validation failed', {
        body: req.body,
        issues: parsed.error.issues,
      });
      return res.status(400).json({
        error: 'Invalid game data',
        issues: parsed.error.issues,
      });
    }

    try {
      // Prepare game data
      let gameData: any = {
        title: parsed.data.title,
        date: parsed.data.date ? new Date(parsed.data.date) : new Date(),
        location: parsed.data.location,
        description: parsed.data.description,
        banner_url: parsed.data.banner_url ?? null,
        cover_image_url: parsed.data.cover_image_url ?? null,
        appearance: parsed.data.appearance ?? null,
        expected_attendance: parsed.data.expected_attendance ?? null,
        event_type: parsed.data.event_type ?? 'game',
        donation_goal: parsed.data.donation_goal ?? null,
        watch_location: parsed.data.watch_location ?? null,
        watch_location_lat: parsed.data.watch_location_lat ?? null,
        watch_location_lng: parsed.data.watch_location_lng ?? null,
        watch_location_place_id: parsed.data.watch_location_place_id ?? null,
        destination: parsed.data.destination ?? null,
        latitude: parsed.data.latitude ?? null,
        longitude: parsed.data.longitude ?? null,
        home_team: parsed.data.home_team ?? null,
        away_team: parsed.data.away_team ?? null,
        home_team_id: parsed.data.home_team_id ?? null,
        away_team_id: parsed.data.away_team_id ?? null,
        away_team_name: parsed.data.away_team_name ?? null,
        venue_place_id: parsed.data.venue_place_id ?? null,
        venue_address: parsed.data.venue_address ?? null,
        venue_lat: parsed.data.venue_lat ?? null,
        venue_lng: parsed.data.venue_lng ?? null,
        is_neutral: parsed.data.is_neutral ?? false,
      };

      // If home_team_id is provided, use that team's venue as default location
      if (parsed.data.home_team_id && !parsed.data.location) {
        const homeTeam = await prisma.team.findUnique({
          where: { id: parsed.data.home_team_id },
          select: {
            venue_address: true,
            venue_lat: true,
            venue_lng: true,
            city: true,
            state: true,
            name: true,
          },
        });

        if (homeTeam) {
          gameData.location =
            homeTeam.venue_address || `${homeTeam.city || ''}, ${homeTeam.state || ''}`.trim();
          gameData.latitude = homeTeam.venue_lat;
          gameData.longitude = homeTeam.venue_lng;
          debugLog(`✅ Using home team location: ${gameData.location}`);
        }
      }

      // Auto-geocode when location text is present but no coordinates were supplied
      // (either directly or via home team venue). Always attempt — no flag required.
      if (gameData.location && !gameData.latitude && !gameData.longitude) {
        try {
          const { geocodeLocation } = await import('../lib/geocoding.js');
          const coords = await geocodeLocation(gameData.location);
          if (coords) {
            gameData.latitude = coords.latitude;
            gameData.longitude = coords.longitude;
            debugLog(
              `✅ Auto-geocoded game location: ${gameData.location} → ${coords.latitude}, ${coords.longitude}`
            );
          }
        } catch (geocodeError) {
          console.warn('Auto-geocoding failed, continuing without coordinates:', geocodeError);
          // Non-fatal — game is still created, just without map pin
        }
      }

      // Approval workflow: Check if user is a coach/manager OR if user is admin
      let isCoach = false;

      // Check if user is super admin (can create events for ANY team)
      const currentUser = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { email: true, display_name: true },
      });
      const isAdmin = isEmailAdmin(currentUser?.email);

      // Require team association for non-admin users
      if (!parsed.data.home_team_id && !isAdmin) {
        return res
          .status(400)
          .json({ error: 'home_team_id is required. Games must be associated with a team.' });
      }

      if (parsed.data.home_team_id && !isAdmin) {
        isCoach = await canManageTeamScoped(req.user.id, parsed.data.home_team_id);

        // Verify the team's org is admin-approved (if team has an org)
        if (isCoach) {
          const team = await prisma.team.findUnique({
            where: { id: parsed.data.home_team_id },
            select: { organization_id: true },
          });
          if (team?.organization_id) {
            const org = await prisma.organization.findUnique({
              where: { id: team.organization_id },
              select: { admin_approved: true },
            });
            if (org && !org.admin_approved) {
              return res
                .status(403)
                .json({ error: 'Your organization must be approved before creating events.' });
            }
          }
        }
      } else if (isAdmin) {
        // Admin can create events for any team
        isCoach = true;
        debugLog(
          `✅ Admin ${currentUser?.email} creating event for team ${parsed.data.home_team_id || 'N/A'}`
        );
      }

      // Auto-approve if coach/admin, otherwise set to pending
      gameData.approval_status = isCoach || isAdmin ? 'approved' : 'pending';
      gameData.created_by_id = req.user.id;

      // Enforce fan pending event limit (matches POST /events limit of 3)
      if (gameData.approval_status === 'pending') {
        const pendingCount = await prisma.game.count({
          where: { created_by_id: req.user.id, approval_status: 'pending' },
        });
        if (pendingCount >= 3) {
          return res.status(403).json({
            error: 'Event limit reached',
            message:
              "You've reached your limit of 3 pending events. Wait for one to be approved or rejected before submitting another.",
            code: 'EVENT_LIMIT_EXCEEDED',
            limit: 3,
            current: pendingCount,
          });
        }
      }

      if (isCoach || isAdmin) {
        gameData.approved_by_id = req.user.id;
        gameData.approved_at = new Date();
      }

      const game = (await (prisma.game.create as any)({
        data: gameData,
        include: {
          events: { orderBy: { date: 'asc' }, take: 1 },
          homeTeam: { select: { id: true, name: true, venue_address: true } },
          awayTeam: { select: { id: true, name: true, venue_address: true } },
        },
      })) as any;

      // Automatically create an associated Event for RSVP functionality
      // Copy venue coordinates from game so geofencing can enforce location-based posting
      const eventLat = game.venue_lat ?? game.latitude ?? null;
      const eventLng = game.venue_lng ?? game.longitude ?? null;
      const event = await prisma.event.create({
        data: {
          title: game.title,
          date: game.date,
          location: game.location || null,
          latitude: eventLat,
          longitude: eventLng,
          game_id: game.id,
          team_id: game.home_team_id || null,
          status: gameData.approval_status || 'pending',
          approval_status: gameData.approval_status || 'pending',
          creator_id: req.user!.id,
          creator_role: isCoach ? 'coach' : 'fan',
          event_type: parsed.data.event_type || 'game',
          capacity: null,
        } as any,
      });

      // Games appear in the feed via the games carousel (GET /games) — no separate
      // text post needed. The game card links directly to the game detail page with
      // stories, polls, RSVP, and all features.

      // Generate Google Maps link for venue
      const venueMapsLink = generateMapsLink(
        game.venue_address || game.location,
        game.venue_lat || game.latitude,
        game.venue_lng || game.longitude,
        game.venue_place_id
      );

      // Warn if location string is present but no coordinates were resolved
      const warnings: string[] = [];
      if (game.location && game.latitude == null && game.longitude == null) {
        warnings.push(
          'No coordinates resolved for location — geofencing will be disabled for this event'
        );
      }

      const response = {
        ...game,
        event_id: event.id,
        banner_url: game.banner_url,
        venue_maps_link: venueMapsLink,
        ...(warnings.length > 0 ? { warnings } : {}),
        // Include team info with linking capability
        home_team: game.homeTeam
          ? {
              id: game.homeTeam.id,
              name: game.homeTeam.name,
              profile_link: `/teams/${game.homeTeam.id}`, // Frontend can use this to link to team page
            }
          : null,
        away_team: game.awayTeam
          ? {
              id: game.awayTeam.id,
              name: game.awayTeam.name,
              profile_link: `/teams/${game.awayTeam.id}`, // Link to opponent's page if they exist
            }
          : game.away_team_name
            ? {
                name: game.away_team_name, // Manual opponent name
                profile_link: null, // No link available
              }
            : null,
      };

      if (gameData.approval_status === 'pending') {
        void notifyPendingEventReviewers(prisma, {
          reviewId: game.id,
          reviewKind: 'game',
          teamId: game.home_team_id || null,
          requesterName: currentUser?.display_name || 'VarsityHub User',
          requesterEmail: currentUser?.email || '',
          eventTitle: game.title,
          eventType: parsed.data.event_type || 'game',
          eventDate: game.date,
          eventLocation: game.location || game.venue_address || undefined,
          teamName: game.homeTeam?.name || undefined,
        }).catch((err) => {
          console.warn('[games] pending review email failed:', (err as any)?.message || err);
        });
      }

      await invalidateGamesListCache();
      res.status(201).json(response);
    } catch (error) {
      console.error('Error creating game:', error);
      res.status(500).json({ error: 'Failed to create game' });
    }
  })
);

// v1.0.2: POST /games/bulk — atomic bulk create for season scheduling.
// Replaces the client-side loop in manage-season.tsx that had no rollback on partial failure.
// Max 30 games per call (same cap as single endpoint's monthly batch).
const bulkGameSchema = z.object({
  title: z.string().trim().min(1).max(200),
  home_team: z.string().trim().optional(),
  away_team: z.string().trim().optional(),
  home_team_id: z.string().trim().optional(),
  away_team_id: z.string().trim().optional(),
  date: z.string().datetime(),
  location: z.string().trim().min(1),
  description: z.string().trim().optional(),
  event_type: z
    .enum([
      'game',
      'fundraiser',
      'watch_party',
      'team_trip',
      'meeting',
      'team_meal',
      'tryout',
      'bbq',
      'team_meeting',
      'host_request',
      'other',
    ])
    .optional(),
  is_neutral: z.boolean().optional(),
});
gamesRouter.post(
  '/bulk',
  requireAuth as any,
  requireVerified as any,
  requireOnboarded as any,
  gameCreationLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    const schema = z.object({ games: z.array(bulkGameSchema).min(1).max(30) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Invalid bulk games payload', issues: parsed.error.issues });
    }
    const userId = req.user!.id;
    try {
      // All-or-nothing: one failure rolls back the whole batch.
      const created = await prisma.$transaction(async tx => {
        const rows: any[] = [];
        for (const g of parsed.data.games) {
          const row = await tx.game.create({
            data: {
              title: g.title,
              date: new Date(g.date),
              location: g.location,
              description: g.description ?? null,
              home_team: g.home_team ?? null,
              away_team: g.away_team ?? null,
              home_team_id: g.home_team_id ?? null,
              away_team_id: g.away_team_id ?? null,
              event_type: g.event_type ?? 'game',
              is_neutral: g.is_neutral ?? false,
              created_by_id: userId,
              approval_status: 'approved' as any, // coaches creating for their own team auto-approve (mirrors single endpoint)
            },
            select: { id: true, title: true, date: true, location: true },
          });
          rows.push(row);
        }
        return rows;
      });
      await invalidateGamesListCache();
      return res.status(201).json({ ok: true, created_count: created.length, games: created });
    } catch (err: any) {
      console.error('[games/bulk] failed — rolled back:', err?.message || err);
      return res.status(500).json({
        error: 'Bulk game creation failed and was rolled back.',
        detail: err?.message || 'unknown',
      });
    }
  })
);

// Seed sample games as real DB records so stories/polls work (idempotent)
gamesRouter.post(
  '/seed-samples',
  requireAdmin as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const SAMPLE_GAMES = [
      {
        title: 'Westhill Vikings vs. Stamford Knights',
        location: 'Westhill High School, Stamford, CT',
        cover_image_url:
          'https://images.unsplash.com/photo-1546519638-68e109498ffc?q=80&w=1280&auto=format&fit=crop',
        days_ahead: 2,
      },
      {
        title: 'Riverside Eagles vs. Greenwich Cardinals',
        location: 'Greenwich High School, Greenwich, CT',
        cover_image_url:
          'https://images.unsplash.com/photo-1461896836934-ffe607ba8211?q=80&w=1280&auto=format&fit=crop',
        days_ahead: 4,
      },
      {
        title: 'Trinity Crusaders vs. Fairfield Prep Jesuits',
        location: 'Trinity Catholic, Stamford, CT',
        cover_image_url:
          'https://images.unsplash.com/photo-1517649763962-0c623066013b?q=80&w=1280&auto=format&fit=crop',
        days_ahead: 6,
      },
    ];

    const now = new Date();
    const created: any[] = [];

    for (const sample of SAMPLE_GAMES) {
      // Check if already seeded (by exact title match)
      const existing = await prisma.game.findFirst({
        where: { title: sample.title, approval_status: 'approved' },
        select: { id: true },
      });
      if (existing) {
        created.push(existing);
        continue;
      }
      const gameDate = new Date(now.getTime() + sample.days_ahead * 86400000);
      const game = await (prisma.game.create as any)({
        data: {
          title: sample.title,
          date: gameDate,
          location: sample.location,
          cover_image_url: sample.cover_image_url,
          banner_url: sample.cover_image_url,
          approval_status: 'approved',
          approved_at: now,
          created_by_id: req.user!.id,
          approved_by_id: req.user!.id,
          event_type: 'game',
        },
      });
      // Create associated event for RSVP
      await prisma.event.create({
        data: {
          title: sample.title,
          date: gameDate,
          location: sample.location,
          game_id: game.id,
          status: 'approved',
          approval_status: 'approved',
          creator_id: req.user!.id,
          creator_role: 'organizer',
          event_type: 'game',
        } as any,
      });
      // Geocode the location so the game appears as a map pin
      try {
        const { geocodeLocation } = await import('../lib/geocoding.js');
        const coords = await geocodeLocation(sample.location);
        if (coords) {
          await (prisma.game.update as any)({
            where: { id: game.id },
            data: { latitude: coords.latitude, longitude: coords.longitude },
          });
          await prisma.event.updateMany({
            where: { game_id: game.id },
            data: { latitude: coords.latitude, longitude: coords.longitude },
          });
        }
      } catch (geocodeErr) {
        console.warn('[seed-samples] geocoding failed for', sample.title, ':', geocodeErr);
      }
      // Games appear as cards in the feed carousel — no text post needed
      created.push(game);
    }

    await invalidateGamesListCache();
    return res.json({ ok: true, games: created });
  })
);

// Batch vote summaries - avoids N+1 when loading feed with many games (must be before /:id)
gamesRouter.get('/votes-summary', authMiddleware as any, asyncHandler(async (req: AuthedRequest, res) => {
  try {
    const idsParam = String(req.query.ids || '').trim();
    if (!idsParam)
      return res.status(400).json({ error: 'ids required (comma-separated game IDs)' });
    const ids = idsParam
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    if (ids.length === 0) return res.json({});
    if (ids.length > 50) return res.status(400).json({ error: 'Max 50 ids per request' });
    const userId = req.user?.id ?? null;

    // Batch: 1 groupBy query for all vote counts + 1 query for user votes (instead of 3N queries)
    const [voteCounts, userVotes] = await Promise.all([
      prisma.gameVote.groupBy({
        by: ['game_id', 'team'],
        _count: { _all: true },
        where: { game_id: { in: ids } },
      }),
      userId
        ? prisma.gameVote.findMany({
            where: { game_id: { in: ids }, user_id: userId },
            select: { game_id: true, team: true },
          })
        : Promise.resolve([]),
    ]);

    // Build lookup maps
    const countMap = new Map<string, { A: number; B: number }>();
    for (const row of voteCounts) {
      if (!countMap.has(row.game_id)) countMap.set(row.game_id, { A: 0, B: 0 });
      const entry = countMap.get(row.game_id)!;
      if (row.team === 'A') entry.A = row._count._all;
      else if (row.team === 'B') entry.B = row._count._all;
    }
    const userVoteMap = new Map(userVotes.map(v => [v.game_id, v.team]));

    const result: Record<string, Awaited<ReturnType<typeof summarizeVotes>>> = {};
    for (const id of ids) {
      const counts = countMap.get(id) || { A: 0, B: 0 };
      const total = counts.A + counts.B;
      const pctA = total ? Math.round((counts.A / total) * 100) : 0;
      const pctB = total ? 100 - pctA : 0;
      result[id] = {
        teamA: counts.A,
        teamB: counts.B,
        total,
        pctA,
        pctB,
        userVote: userVoteMap.get(id) ?? null,
      };
    }
    return res.json(result);
  } catch (err) {
    console.error('[games] votes-summary error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}));

// Get single game by id
gamesRouter.get('/:id', asyncHandler(async (req, res) => {
  try {
    const id = String(req.params.id);
    const authedReq = req as AuthedRequest;
    const game = await (prisma.game.findUnique as any)({
      where: { id },
      include: {
        events: { orderBy: { date: 'asc' }, take: 1 },
        homeTeam: { select: { id: true, name: true, avatar_url: true } },
        awayTeam: { select: { id: true, name: true, avatar_url: true } },
      },
    });
    if (!game) return res.status(404).json({ error: 'Not found' });
    if (!(await canViewGameRecord(game as GameVisibilityRecord, authedReq.user?.id ?? null))) {
      return res.status(404).json({ error: 'Not found' });
    }
    const gameData = game as any; // Type assertion for relation fields
    const event = gameData.events[0] ?? null;
    const { events, ...rest } = gameData;
    return res.json({ ...rest, appearance: rest.appearance ?? null, event_id: event?.id ?? null });
  } catch (err) {
    console.error('[games] get-by-id error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}));

// Compact summary payload for the Game Details screen.
// Posts and stories are intentionally excluded here — the client fetches them
// separately via GET /games/:id/posts and GET /games/:id/stories so this
// endpoint stays fast (no heavy joins on potentially large post tables).
gamesRouter.get('/:id/summary', asyncHandler(async (req: AuthedRequest, res) => {
  try {
    const id = String(req.params.id);
    const game = await (prisma.game.findUnique as any)({
      where: { id },
      include: {
        events: { orderBy: { date: 'asc' }, take: 1 },
        homeTeam: { select: { id: true, name: true, avatar_url: true } },
        awayTeam: { select: { id: true, name: true, avatar_url: true } },
      },
    });
    if (!game) return res.status(404).json({ error: 'Not found' });
    if (!(await canViewGameRecord(game as GameVisibilityRecord, req.user?.id ?? null))) {
      return res.status(404).json({ error: 'Not found' });
    }

    const g = game as any; // Type assertion for relation fields
    const event = g.events[0] ?? null;
    // Posts and media are no longer bundled in the summary — return empty arrays
    // so the client can fetch them in parallel without blocking the metadata load.
    const posts: any[] = [];
    const media: any[] = [];
    const bannerUrl = pickBannerUrl(game, event, media);
    const location = game.location || event?.location || null;
    const anchorDate = event?.date ?? game.date;
    const isPast =
      anchorDate instanceof Date
        ? anchorDate.getTime() < Date.now()
        : new Date(anchorDate).getTime() < Date.now();

    const [reviewsCount, rsvpCount, userRsvped] = await (async () => {
      const reviewPromise = prisma.post.count({
        where: { game_id: id, type: 'review', deleted_at: null },
      });
      if (!event) {
        const [reviewTotal] = await Promise.all([reviewPromise]);
        return [reviewTotal, 0, false] as const;
      }
      const countPromise = prisma.eventRsvp.count({ where: { event_id: event.id } });
      const userPromise = req.user
        ? prisma.eventRsvp.findUnique({
            where: { event_id_user_id: { event_id: event.id, user_id: req.user.id } } as any,
            select: { id: true },
          })
        : Promise.resolve(null);
      const [reviewTotal, count, userRow] = await Promise.all([
        reviewPromise,
        countPromise,
        userPromise,
      ]);
      return [reviewTotal, count, Boolean(userRow)] as const;
    })();

    const gameData = game as any; // Type assertion for updated schema

    // Compute can_edit_result for coaches/owners/admins
    let canEditResult = false;
    if (req.user) {
      const teamIds = [gameData.home_team_id, gameData.away_team_id].filter(Boolean) as string[];
      if (teamIds.length > 0) {
        canEditResult = await canManageAnyTeam(req.user.id, teamIds);
      }
      if (!canEditResult && gameData.created_by_id === req.user.id) canEditResult = true;
      if (!canEditResult) {
        const user = await prisma.user.findUnique({
          where: { id: req.user.id },
          select: { email: true },
        });
        if (isAdminEmail(user?.email)) canEditResult = true;
      }
    }

    // Generate Google Maps link for venue
    const venueMapsLink = generateMapsLink(
      gameData.venue_address || location,
      gameData.venue_lat || gameData.latitude,
      gameData.venue_lng || gameData.longitude,
      gameData.venue_place_id
    );

    return res.json({
      id: gameData.id,
      title: gameData.title,
      appearance: gameData.appearance ?? null,
      home_team: gameData.homeTeam || gameData.home_team, // Return relation object or string fallback
      away_team: gameData.awayTeam || gameData.away_team, // Return relation object or string fallback
      homeTeam: gameData.homeTeam
        ? {
            id: gameData.homeTeam.id,
            name: gameData.homeTeam.name,
            avatar_url: gameData.homeTeam.avatar_url,
            profile_link: `/teams/${gameData.homeTeam.id}`,
          }
        : gameData.home_team
          ? { name: gameData.home_team }
          : null,
      awayTeam: gameData.awayTeam
        ? {
            id: gameData.awayTeam.id,
            name: gameData.awayTeam.name,
            avatar_url: gameData.awayTeam.avatar_url,
            profile_link: `/teams/${gameData.awayTeam.id}`,
          }
        : gameData.away_team || gameData.away_team_name
          ? {
              name: gameData.away_team || gameData.away_team_name,
            }
          : null,
      date: gameData.date instanceof Date ? gameData.date.toISOString() : gameData.date,
      timeLocal: null,
      location,
      venueMapsLink, // Google Maps link for the venue
      description: gameData.description,
      bannerUrl,
      coverImageUrl: gameData.cover_image_url,
      eventId: event?.id ?? null,
      capacity: event?.capacity ?? null,
      rsvpCount,
      userRsvped,
      teams: [gameData.homeTeam, gameData.awayTeam].filter(Boolean), // Include team relations
      posts,
      media,
      reviewsCount,
      isPast,
      event: serializeEvent(event),
      home_score: gameData.home_score ?? null,
      away_score: gameData.away_score ?? null,
      winner: gameData.winner ?? null,
      can_edit_result: canEditResult,
    });
  } catch (err) {
    console.error('[games] summary error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}));

gamesRouter.get('/:id/votes/summary', asyncHandler(async (req: AuthedRequest, res) => {
  try {
    const gameId = String(req.params.id);
    const summary = await summarizeVotes(gameId, req.user?.id);
    res.json(summary);
  } catch (err) {
    console.error('[games] votes-summary-single error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}));

gamesRouter.post('/:id/votes', requireAuth as any, voteLimiter, asyncHandler(async (req: AuthedRequest, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const gameId = String(req.params.id);
    const teamInput = String(req.body?.team ?? '')
      .trim()
      .toUpperCase();
    if (teamInput !== 'A' && teamInput !== 'B') {
      return res.status(400).json({ error: 'Invalid team option' });
    }

    await prisma.gameVote.upsert({
      where: { game_id_user_id: { game_id: gameId, user_id: req.user.id } },
      update: { team: teamInput },
      create: { game_id: gameId, user_id: req.user.id, team: teamInput },
    });

    const summary = await summarizeVotes(gameId, req.user.id);
    res.json(summary);
  } catch (err) {
    console.error('[games] cast-vote error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}));

gamesRouter.delete('/:id/votes', requireAuth as any, asyncHandler(async (req: AuthedRequest, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const gameId = String(req.params.id);
    await prisma.gameVote.deleteMany({ where: { game_id: gameId, user_id: req.user.id } });
    const summary = await summarizeVotes(gameId, req.user.id);
    res.json(summary);
  } catch (err) {
    console.error('[games] delete-vote error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}));

// Delete a game
gamesRouter.delete(
  '/:id',
  requireAuth as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const id = String(req.params.id);

    try {
      // Check if game exists
      const game = await prisma.game.findUnique({
        where: { id },
        select: { id: true, created_by_id: true, home_team_id: true, away_team_id: true },
      });

      if (!game) return res.status(404).json({ error: 'Game not found' });

      // CRITICAL: Check authorization before allowing deletion
      // Only allow: game creator, team coaches, or admins
      const isCreator = game.created_by_id === req.user.id;

      // Check if user is admin
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { email: true },
      });
      const isAdmin = isAdminEmail(user?.email);

      // Check if user is coach/manager of either team
      const deleteTeamIds = [game.home_team_id, game.away_team_id].filter(Boolean) as string[];
      const isCoach = await canManageAnyTeam(req.user.id, deleteTeamIds);

      // Deny access if user is not authorized
      if (!isCreator && !isCoach && !isAdmin) {
        return res.status(403).json({
          error: 'Not authorized',
          message: 'Only game creators, team coaches, or admins can delete games.',
        });
      }

      // Notify RSVPed users before deleting
      try {
        const gameForNotif = await prisma.game.findUnique({
          where: { id },
          select: { id: true, title: true, date: true },
        });
        const gameTitle = gameForNotif?.title || 'A game';

        // Find events linked to this game and their RSVPs
        const linkedEvents = await prisma.event.findMany({
          where: { game_id: id },
          select: { id: true, rsvps: { select: { user_id: true } } },
        });
        const rsvpUserIds = new Set<string>();
        for (const evt of linkedEvents) {
          for (const rsvp of evt.rsvps) {
            if (rsvp.user_id !== req.user!.id) rsvpUserIds.add(rsvp.user_id);
          }
        }

        // Also notify team members of home/away teams
        if (deleteTeamIds.length > 0) {
          const teamMembers = await prisma.teamMembership.findMany({
            where: {
              team_id: { in: deleteTeamIds },
              status: 'active',
              user_id: { not: req.user!.id },
            },
            select: { user_id: true },
          });
          for (const m of teamMembers) rsvpUserIds.add(m.user_id);
        }

        const { sendPushNotification } = await import('../lib/notifications.js');
        for (const uid of rsvpUserIds) {
          await prisma.notification.create({
            data: {
              user_id: uid,
              actor_id: req.user!.id,
              type: 'GAME_CANCELLED',
              meta: { game_id: id, game_title: gameTitle },
            },
          });

          sendPushNotification(uid, `Game cancelled`, `${gameTitle} has been cancelled`, {
            type: 'game_cancelled',
            game_id: id,
            screen: 'games',
          }).catch(() => {});
        }
      } catch (notifErr) {
        console.error('[games] Failed to send game cancelled notifications:', notifErr);
      }

      // Delete the game (cascade deletes will handle related records)
      await prisma.game.delete({ where: { id } });
      await invalidateGamesListCache();

      res.json({ message: 'Game deleted successfully' });
    } catch (error) {
      console.error('Error deleting game:', error);
      res.status(500).json({ error: 'Failed to delete game' });
    }
  })
);

// Posts tied to a game
gamesRouter.get('/:id/posts', authMiddleware as any, asyncHandler(async (req: AuthedRequest, res) => {
  try {
    const id = String(req.params.id);
    const limit = Math.max(1, Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 100));
    // Privacy: exclude posts from private-profile authors the viewer doesn't follow
    const excludedIds = await getExcludedPrivateAuthorIds(req.user?.id ?? null);
    const posts = await prisma.post.findMany({
      where: {
        game_id: id,
        deleted_at: null,
        ...(excludedIds.length ? { author_id: { notIn: excludedIds } } : {}),
      },
      orderBy: [{ upvotes_count: 'desc' }, { created_at: 'desc' }],
      take: limit,
      include: {
        author: { select: { id: true, username: true, display_name: true, avatar_url: true } },
        _count: { select: { comments: true } },
      },
    });
    res.json(posts.map(serializePost));
  } catch (err) {
    console.error('[games] get-posts error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}));

// Media (stories) tied to a game
gamesRouter.get('/:id/media', makeListMediaHandler({ prisma }));

// Delete a specific media/story from a game
gamesRouter.delete(
  '/:id/media/:mediaId',
  requireAuth as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    const gameId = String(req.params.id);
    const mediaId = String(req.params.mediaId);

    try {
      // Find the story first to check ownership
      const story = await prisma.story.findUnique({
        where: { id: mediaId },
        select: { id: true, user_id: true, game_id: true },
      });

      if (!story) {
        return res.status(404).json({ error: 'Story not found' });
      }

      // Verify the story belongs to this game
      if (story.game_id !== gameId) {
        return res.status(400).json({ error: 'Story does not belong to this game' });
      }

      // Verify the user owns this story
      if (story.user_id !== req.user.id) {
        return res.status(403).json({ error: 'You can only delete your own stories' });
      }

      // Delete the story
      await prisma.story.delete({ where: { id: mediaId } });

      debugLog(`✅ User ${req.user.id} deleted story ${mediaId} from game ${gameId}`);
      res.json({ message: 'Story deleted successfully' });
    } catch (error) {
      console.error('Error deleting story:', error);
      res.status(500).json({ error: 'Failed to delete story' });
    }
  })
);

// Legacy stories endpoints (kept for backwards compatibility)
gamesRouter.get('/:id/stories', makeListMediaHandler({ prisma }));

gamesRouter.post(
  '/:id/stories',
  requireAuth as any,
  requireOnboarded as any,
  makeCreateStoryHandler({ prisma })
);

// Update game result (scores) - coaches and team owners only
gamesRouter.patch(
  '/:id/result',
  requireAuth as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
      const actingUserId = req.user.id;

      const id = String(req.params.id);
      const schema = z.object({
        home_score: z.number().int().min(0).optional(),
        away_score: z.number().int().min(0).optional(),
        winner: z.enum(['home', 'away', 'tie']).optional().nullable(),
      });
      const parsed = schema.safeParse(req.body || {});
      if (!parsed.success)
        return res.status(400).json({ error: 'Invalid payload', details: parsed.error });

      const game = await prisma.game.findUnique({
        where: { id },
        select: {
          id: true,
          created_by_id: true,
          home_team_id: true,
          away_team_id: true,
          date: true,
          home_score: true,
          away_score: true,
        },
      });

      if (!game) return res.status(404).json({ error: 'Game not found' });

      const teamIds = [game.home_team_id, game.away_team_id].filter(Boolean) as string[];
      const isCoach = await canManageAnyTeam(req.user.id, teamIds);

      const isCreator = game.created_by_id === req.user.id;
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { email: true },
      });
      const isAdmin = isAdminEmail(user?.email);

      if (!isCreator && !isCoach && !isAdmin) {
        return res
          .status(403)
          .json({ error: 'Only coaches or team owners can update game results' });
      }

      // Score edit window: once a game has been scored (either score set) and
      // more than 48 hours have passed since the game date, normal users lose
      // edit access. This is the data-integrity baseline — a league can't
      // re-litigate results weeks later. Platform admins retain override so
      // legitimate correction requests still have an escape hatch.
      const SCORE_EDIT_WINDOW_MS = 48 * 60 * 60 * 1000;
      const gameWasScored =
        game.home_score !== null || game.away_score !== null;
      const windowClosesAt = game.date
        ? new Date(game.date.getTime() + SCORE_EDIT_WINDOW_MS)
        : null;
      const windowExpired =
        windowClosesAt !== null && Date.now() > windowClosesAt.getTime();
      if (gameWasScored && windowExpired && !isAdmin) {
        return res.status(403).json({
          error: 'SCORE_EDIT_WINDOW_CLOSED',
          message:
            'Scores can only be edited for 48 hours after the game. Contact support if you need a correction.',
          window_closed_at: windowClosesAt?.toISOString(),
        });
      }

      const data: Record<string, any> = {};
      if (typeof parsed.data.home_score === 'number') data.home_score = parsed.data.home_score;
      if (typeof parsed.data.away_score === 'number') data.away_score = parsed.data.away_score;
      if (parsed.data.winner !== undefined) data.winner = parsed.data.winner;

      if (Object.keys(data).length === 0) {
        return res
          .status(400)
          .json({ error: 'At least one of home_score, away_score, or winner is required' });
      }

      const updated = await prisma.game.update({
        where: { id },
        data,
      });
      await invalidateGamesListCache();
      return res.json(updated);
    } catch (err) {
      console.error('[games] update-result error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// Update cover image
gamesRouter.patch(
  '/:id',
  requireAuth as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    const id = String(req.params.id);
    const schema = z.object({
      cover_image_url: z.string().url().optional(),
      appearance: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' });

    try {
      // CRITICAL: Check authorization before allowing updates
      const game = await prisma.game.findUnique({
        where: { id },
        select: { id: true, created_by_id: true, home_team_id: true, away_team_id: true },
      });

      if (!game) return res.status(404).json({ error: 'Game not found' });

      // Only allow: game creator, team coaches, or admins
      const isCreator = game.created_by_id === req.user.id;

      // Check if user is admin
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { email: true },
      });
      const isAdmin = isAdminEmail(user?.email);

      // Check if user is coach/manager of either team
      const teamIds = [game.home_team_id, game.away_team_id].filter(Boolean) as string[];
      const isCoach = await canManageAnyTeam(req.user.id, teamIds);

      // Deny access if user is not authorized
      if (!isCreator && !isCoach && !isAdmin) {
        return res.status(403).json({
          error: 'Not authorized',
          message: 'Only game creators, team coaches, or admins can update games.',
        });
      }

      // Update the game
      const updatedGame = await prisma.game.update({
        where: { id },
        data: {
          cover_image_url: parsed.data.cover_image_url,
          appearance: parsed.data.appearance ?? undefined,
        },
      });

      await invalidateGamesListCache();
      return res.json(updatedGame);
    } catch (error) {
      console.error('Error updating game:', error);
      return res.status(500).json({ error: 'Failed to update game' });
    }
  })
);

// Full update of a game (coaches, creators, admins)
gamesRouter.put(
  '/:id',
  requireAuth as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    const id = String(req.params.id);

    const schema = z.object({
      title: z.string().trim().min(1).max(200).optional(),
      home_team: z.string().trim().optional(),
      away_team: z.string().trim().optional(),
      home_team_id: z.string().trim().optional(),
      away_team_id: z.string().trim().optional().nullable(),
      away_team_name: z.string().trim().optional().nullable(),
      date: z.string().datetime().optional(),
      location: z.string().trim().optional().nullable(),
      description: z.string().trim().optional().nullable(),
      cover_image_url: z.string().url().optional().nullable(),
      banner_url: z.string().url().optional().nullable(),
      appearance: z.string().optional().nullable(),
      expected_attendance: z.number().int().min(1).max(99999).optional().nullable(),
      event_type: z
        .enum([
          'game',
          'fundraiser',
          'watch_party',
          'team_trip',
          'meeting',
          'team_meal',
          'tryout',
          'bbq',
          'team_meeting',
          'host_request',
          'other',
        ])
        .optional(),
      donation_goal: z.number().min(0).optional().nullable(),
      watch_location: z.string().trim().max(200).optional().nullable(),
      watch_location_lat: z.number().min(-90).max(90).optional().nullable(),
      watch_location_lng: z.number().min(-180).max(180).optional().nullable(),
      watch_location_place_id: z.string().optional().nullable(),
      destination: z.string().trim().max(200).optional().nullable(),
      latitude: z.number().min(-90).max(90).optional().nullable(),
      longitude: z.number().min(-180).max(180).optional().nullable(),
      venue_place_id: z.string().optional().nullable(),
      venue_address: z.string().trim().optional().nullable(),
      venue_lat: z.number().min(-90).max(90).optional().nullable(),
      venue_lng: z.number().min(-180).max(180).optional().nullable(),
      is_neutral: z.boolean().optional(),
    });

    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid game data', issues: parsed.error.issues });
    }

    try {
      const game = await prisma.game.findUnique({
        where: { id },
        select: { id: true, created_by_id: true, home_team_id: true, away_team_id: true },
      });

      if (!game) return res.status(404).json({ error: 'Game not found' });

      const isCreator = game.created_by_id === req.user.id;

      const currentUser = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { email: true },
      });
      const isAdmin = isEmailAdmin(currentUser?.email);

      const gameTeamIds = [game.home_team_id, game.away_team_id].filter(Boolean) as string[];
      const isCoach = await canManageAnyTeam(req.user.id, gameTeamIds);

      if (!isCreator && !isCoach && !isAdmin) {
        return res
          .status(403)
          .json({ error: 'Only the game creator, team coaches, or admins can update this event' });
      }

      // Build update payload — only include fields that were explicitly provided
      const updateData: any = {};
      const d = parsed.data;
      if (d.title !== undefined) updateData.title = d.title;
      if (d.home_team !== undefined) updateData.home_team = d.home_team;
      if (d.away_team !== undefined) updateData.away_team = d.away_team;
      if (d.home_team_id !== undefined) updateData.home_team_id = d.home_team_id;
      if (d.away_team_id !== undefined) updateData.away_team_id = d.away_team_id;
      if (d.away_team_name !== undefined) updateData.away_team_name = d.away_team_name;
      if (d.date !== undefined) updateData.date = new Date(d.date);
      if (d.location !== undefined) updateData.location = d.location;
      if (d.description !== undefined) updateData.description = d.description;
      if (d.cover_image_url !== undefined) updateData.cover_image_url = d.cover_image_url;
      if (d.banner_url !== undefined) updateData.banner_url = d.banner_url;
      if (d.appearance !== undefined) updateData.appearance = d.appearance;
      if (d.expected_attendance !== undefined)
        updateData.expected_attendance = d.expected_attendance;
      if (d.event_type !== undefined) updateData.event_type = d.event_type;
      if (d.donation_goal !== undefined) updateData.donation_goal = d.donation_goal;
      if (d.watch_location !== undefined) updateData.watch_location = d.watch_location;
      if (d.watch_location_lat !== undefined) updateData.watch_location_lat = d.watch_location_lat;
      if (d.watch_location_lng !== undefined) updateData.watch_location_lng = d.watch_location_lng;
      if (d.watch_location_place_id !== undefined)
        updateData.watch_location_place_id = d.watch_location_place_id;
      if (d.destination !== undefined) updateData.destination = d.destination;
      if (d.latitude !== undefined) updateData.latitude = d.latitude;
      if (d.longitude !== undefined) updateData.longitude = d.longitude;
      if (d.venue_place_id !== undefined) updateData.venue_place_id = d.venue_place_id;
      if (d.venue_address !== undefined) updateData.venue_address = d.venue_address;
      if (d.venue_lat !== undefined) updateData.venue_lat = d.venue_lat;
      if (d.venue_lng !== undefined) updateData.venue_lng = d.venue_lng;
      if (d.is_neutral !== undefined) updateData.is_neutral = d.is_neutral;

      const updated = await (prisma.game.update as any)({
        where: { id },
        data: updateData,
        include: { events: { orderBy: { date: 'asc' }, take: 1 } },
      });

      // Keep the associated Event in sync when date/title/location change
      const event = (updated as any).events?.[0];
      if (event) {
        const eventUpdate: any = {};
        if (d.date !== undefined) eventUpdate.date = new Date(d.date);
        if (d.title !== undefined) eventUpdate.title = d.title;
        if (d.location !== undefined) eventUpdate.location = d.location;
        if (Object.keys(eventUpdate).length > 0) {
          await prisma.event.update({ where: { id: event.id }, data: eventUpdate });
        }
      }

      const { events, ...rest } = updated as any;
      await invalidateGamesListCache();
      return res.json({ ...rest, event_id: event?.id ?? null });
    } catch (error) {
      console.error('Error updating game:', error);
      return res.status(500).json({ error: 'Failed to update game' });
    }
  })
);

// Approve or reject event
gamesRouter.get(
  '/:id/approve',
  asyncHandler(async (req: AuthedRequest, res: Response) => handleGameTokenReview(req, res, 'approve'))
);
gamesRouter.post(
  '/:id/approve',
  asyncHandler(async (req: AuthedRequest, res: Response) => handleGameTokenReview(req, res, 'approve'))
);
gamesRouter.put(
  '/:id/approve',
  requireAuth as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
      const actingUserId = req.user.id;

      const id = String(req.params.id);
      const schema = z.object({
        approval_status: z.enum(['approved', 'rejected']),
      });

      const parsed = schema.safeParse(req.body || {});
      if (!parsed.success)
        return res.status(400).json({ error: 'Invalid payload', details: parsed.error });

      // Get the game to check permissions
      const game = await (prisma.game.findUnique as any)({
        where: { id },
        select: { id: true, home_team_id: true, away_team_id: true, approval_status: true },
      });

      if (!game) return res.status(404).json({ error: 'Event not found' });

      // Check if user is coach/manager of either the home or away team,
      // or an owner/manager of the organization that owns either team.
      const gameTeamIds = [game.home_team_id, game.away_team_id].filter(Boolean) as string[];
      const canApprove = await canManageAnyTeam(req.user.id, gameTeamIds);

      const isAdmin = await getIsAdmin(req as any);

      if (!canApprove && !isAdmin) {
        return res.status(403).json({ error: 'Only coaches, org admins, and platform admins can approve events' });
      }

      const result = await applyGameApprovalDecision(
        id,
        parsed.data.approval_status,
        actingUserId,
        (req.body as any)?.reason || null
      );
      if ('error' in result) {
        return sendError(res, result.status!, result.error!);
      }

      return res.json(result.game);
    } catch (err) {
      console.error('[games] approve error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

gamesRouter.get(
  '/:id/reject',
  asyncHandler(async (req: AuthedRequest, res: Response) => handleGameTokenReview(req, res, 'reject'))
);
gamesRouter.post(
  '/:id/reject',
  asyncHandler(async (req: AuthedRequest, res: Response) => handleGameTokenReview(req, res, 'reject'))
);
