import { AppError } from '../lib/errors/AppError.js';
import { storyRequestIdentity, recoverStoryRequest } from '../lib/storyRequestRecovery.js';
import type { Prisma } from '@prisma/client';
import { assertReadyMediaForOwner } from '../lib/mediaUploadOwnership.js';
import { Router } from 'express';
import { z } from 'zod';
import {
  approveEvent as approveEventService,
  rejectEvent as rejectEventService,
} from '../lib/approvalService.js';
import { logAdminActivity, logAdminActivityFromReq } from '../lib/adminActivityLogger.js';
import {
  sendEventCanceledEmail,
  sendEventSubmissionReceivedEmail,
  sendEventUpdatedEmail,
} from '../lib/email.js';
import { notifyPendingEventReviewers } from '../lib/eventReviewNotifications.js';
import { renderReviewPage, renderResultPage, renderFinalStatePage } from '../lib/reviewPage.js';
import { debugLog } from '../lib/debugLog.js';
import { sendError } from '../lib/http/sendError.js';
import { geoBoundingBox, getZipCoordinates, haversineDistance } from '../lib/geoUtils.js';
import { proLeagueToSport } from '../lib/proSchedule/leagueSport.js';
import { PRO_SCHEDULE_LEAGUES } from '../lib/proSchedule/types.js';
import { geocodeLocation } from '../lib/geocoding.js';
import {
  COACH_ALL_DAY_LIVE_WINDOW_HOURS,
  hasActiveEventPostingUnlock,
  serializeLiveWindow,
  verifyStoryPostingPermission,
  viewerHasPostedOnEntity,
} from '../lib/geofencing.js';
// Reuse the story helpers from the games router so event-page stories serialize,
// validate, and lazy-generate posters IDENTICALLY to game stories — one code
// path, no duplication. See server/src/routes/games.ts.
import {
  ensureStoryPoster,
  isMissingStoryLocationColumnError,
  serializeMedia,
  storySchema,
} from './games.js';
import {
  cancelGameReminders,
  rescheduleGameRemindersForEvent,
  scheduleGameReminders,
  sendPushNotification,
} from '../lib/notifications.js';
import { prisma } from '../lib/prisma.js';
import {
  buildPrivateTeamEventVisibilityWhere,
  getBlockedUserIds,
  getExcludedPrivateAuthorIds,
  getExcludedPrivateTeamIds,
  getRequestBlockedCache,
  mergeAndWhere,
} from '../lib/privacyUtils.js';
import { consumeReviewToken, verifyReviewToken } from '../lib/reviewTokens.js';
import { stripHtml } from '../lib/sanitizeHtml.js';
import { mustSucceed } from '../lib/sideEffect.js';
import { venuePhotoFor } from '../lib/proSchedule/venuePhotos.js';
import { SPORTS_LEAGUE_CATALOG } from '../lib/sportsLeagueCatalog.js';
import {
  canManageAnyTeam,
  canManageTeam as canManageTeamScoped,
} from '../lib/teamAuthorization.js';
import { buildBinaryVoteSummary } from '../lib/voteSummary.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { authMiddleware } from '../middleware/auth.js';
import {
  eventCreationLimiter,
  rsvpLimiter,
  storyCreationLimiter,
  voteLimiter,
} from '../middleware/rateLimiters.js';
import { getIsAdmin, isEmailAdmin } from '../middleware/requireAdmin.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireOnboarded } from '../middleware/requireOnboarded.js';
import { requireVerified } from '../middleware/requireVerified.js';
import { registerIdValidation } from '../middleware/validateParams.js';

export const eventsRouter = Router();
registerIdValidation(eventsRouter);

// Story surfaces use the same approval, contributor and private-team rules as events.
const EVENT_VISIBILITY_SELECT = {
  id: true,
  creator_id: true,
  approval_status: true,
  game_id: true,
} as const;
async function canViewEventRecord(
  event: {
    id: string;
    creator_id: string | null;
    approval_status: string | null;
    game_id: string | null;
  },
  req: AuthedRequest
): Promise<boolean> {
  const viewerId = req.user?.id ?? null;
  if (viewerId && (await getIsAdmin(req as any))) return true;
  if (event.approval_status !== 'approved' && (!viewerId || event.creator_id !== viewerId)) {
    if (
      !viewerId ||
      !(await viewerHasPostedOnEntity({
        userId: viewerId,
        eventId: event.id,
        gameId: event.game_id,
      }))
    )
      return false;
  }
  const where = mergeAndWhere<Prisma.EventWhereInput>(
    { id: event.id },
    buildPrivateTeamEventVisibilityWhere(await getExcludedPrivateTeamIds(viewerId))
  );
  mergeAndWhere(where, {
    OR: [
      { game_id: null },
      { game: { is: { opponent_approval_status: { notIn: ['pending', 'declined'] } } } },
      { game: { is: { date: { lt: new Date() } } } },
    ],
  });
  return Boolean(await prisma.event.findFirst({ where, select: { id: true } }));
}

type SportsLeagueScheduleStatus = 'provider_backed' | 'event_seeded' | 'catalog_only';

const PROVIDER_BACKED_SCHEDULE_SLUGS = new Set<string>(PRO_SCHEDULE_LEAGUES);

function getSportsLeagueScheduleStatus(
  league: { slug: string; provider: string | null; provider_league_id: string | null },
  currentEventCount: number
): SportsLeagueScheduleStatus {
  if (
    PROVIDER_BACKED_SCHEDULE_SLUGS.has(league.slug) &&
    league.provider &&
    league.provider_league_id
  ) {
    return 'provider_backed';
  }
  if (currentEventCount > 0) return 'event_seeded';
  return 'catalog_only';
}

/** Hard cap on RSVPs we'll fan out to per event update/cancel. Past this we
 *  stop and trust the next surface (re-open the event, manual notification)
 *  to catch up. 50k is ~2 orders of magnitude above today's largest event;
 *  raise if/when production traces show a real ceiling. */
const RSVP_FANOUT_LIMIT = 50_000;
const RSVP_FANOUT_BATCH = 200;
const encodeEventRsvpCursor = (row: { created_at: Date | string; id: string }) => {
  const createdAt =
    row.created_at instanceof Date
      ? row.created_at.toISOString()
      : new Date(row.created_at).toISOString();
  return `${createdAt}::${row.id}`;
};

const parseEventRsvpCursor = (cursor: string): { createdAt: Date; id: string } | null => {
  const [createdAtRaw, id] = cursor.split('::');
  if (!createdAtRaw || !id) return null;
  const createdAt = new Date(createdAtRaw);
  if (Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id };
};

const buildCreatedAtIdCursorWhere = (cursor: { createdAt: Date; id: string } | null) => {
  if (!cursor) return undefined;
  return [
    { created_at: { lt: cursor.createdAt } },
    {
      created_at: { equals: cursor.createdAt },
      id: { lt: cursor.id },
    },
  ];
};

const isCompetitivePollEventType = (eventType?: string | null) => {
  if (!eventType) return true;
  return String(eventType).trim().toLowerCase() === 'game';
};

const getEventPollEligibility = async (eventId: string) => {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { id: true, event_type: true, game_id: true },
  });
  if (!event) return { ok: false as const, status: 404, body: { error: 'Not found' } };
  if (event.game_id) {
    return {
      ok: false as const,
      status: 409,
      body: {
        error: 'Game-backed events vote through the linked game.',
        code: 'POLL_USES_GAME',
        game_id: event.game_id,
      },
    };
  }
  if (!isCompetitivePollEventType(event.event_type)) {
    return {
      ok: false as const,
      status: 409,
      body: {
        error: 'Polls are only available for competitive games.',
        code: 'POLL_NOT_AVAILABLE',
      },
    };
  }
  return { ok: true as const, event };
};

const summarizeEventVotes = async (eventId: string, userId?: string | null) => {
  const [teamA, teamB, mine] = await Promise.all([
    prisma.eventVote.count({ where: { event_id: eventId, team: 'A' } }),
    prisma.eventVote.count({ where: { event_id: eventId, team: 'B' } }),
    userId
      ? prisma.eventVote.findUnique({
          where: { event_id_user_id: { event_id: eventId, user_id: userId } },
        })
      : Promise.resolve(null),
  ]);
  return buildBinaryVoteSummary(teamA, teamB, mine?.team);
};

/**
 * Async iterator over an event's RSVPs in cursor-paged batches. Replaces the
 * `take: 10000` single-shot fetch + in-memory loop in event update/cancel —
 * which scales linearly in memory and latency with the event size and turns
 * a single click into a giant query for popular events.
 *
 * Each yielded batch carries the same shape the call sites expected (RSVP +
 * user select). Callers fan out side effects per batch (push, email,
 * reminder cancel) and the next batch loads only after the current one's
 * critical work is done — bounded memory regardless of event size.
 */
async function* iterateEventRsvps(
  eventId: string,
  userSelect: { id?: true; email?: true; display_name?: true; preferences?: true },
  options: { batchSize?: number; cap?: number } = {}
): AsyncGenerator<Array<any>> {
  const batchSize = options.batchSize ?? RSVP_FANOUT_BATCH;
  const cap = options.cap ?? RSVP_FANOUT_LIMIT;
  let cursor: string | undefined;
  let yielded = 0;
  while (yielded < cap) {
    const batch = await prisma.eventRsvp.findMany({
      where: { event_id: eventId },
      include: { user: { select: userSelect } },
      orderBy: { id: 'asc' },
      take: Math.min(batchSize, cap - yielded),
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (batch.length === 0) return;
    yield batch;
    yielded += batch.length;
    if (batch.length < batchSize) return;
    cursor = batch[batch.length - 1].id;
  }
}

function renderEventReviewPage(action: 'approve' | 'reject', eventTitle: string, token?: string) {
  return renderReviewPage({ action, entityLabel: 'Event', entityName: eventTitle, token });
}

function renderEventFinalStatePage(
  event: { title: string | null; approval_status: string | null },
  action: 'approve' | 'reject'
) {
  return renderFinalStatePage({
    approvalStatus: event.approval_status,
    entityName: event.title,
    entityNoun: 'event',
    action,
  });
}

function renderEventResultPage(title: string, message: string, success: boolean) {
  return renderResultPage(title, message, success);
}

async function handleEventTokenReview(req: AuthedRequest, res: any, action: 'approve' | 'reject') {
  const eventId = String(req.params.id);
  const token = typeof req.query?.token === 'string' ? req.query.token : undefined;
  const payload = token
    ? verifyReviewToken<{ reviewId: string; reviewKind: string; action: string }>(token)
    : null;
  const expectedAction = action === 'approve' ? 'approve_event' : 'reject_event';

  const tokenValid =
    !!token &&
    !!payload &&
    payload.reviewId === eventId &&
    payload.reviewKind === 'event' &&
    payload.action === expectedAction;

  // Allow a signed-in platform admin to approve/reject without a valid token.
  // This is the fallback when email links expire — admin can navigate directly.
  const isSignedInAdmin = !tokenValid && req.user ? await getIsAdmin(req as any) : false;

  if (!tokenValid && !isSignedInAdmin) {
    return res
      .status(401)
      .send(
        renderEventResultPage(
          'Invalid Link',
          `This ${action} link is invalid or has expired.`,
          false
        )
      );
  }

  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { title: true, approval_status: true },
  });
  if (!event) {
    return res.status(404).send(renderEventResultPage('Not Found', 'Event not found.', false));
  }
  if (event.approval_status === 'approved') {
    return res.send(
      renderEventResultPage(
        'Already Approved',
        `${event.title || 'This event'} was already approved.`,
        true
      )
    );
  }
  if (event.approval_status === 'rejected') {
    return res.send(
      renderEventResultPage(
        'Already Rejected',
        `${event.title || 'This event'} was already rejected.`,
        true
      )
    );
  }

  if (req.method === 'GET') {
    return res.send(renderEventReviewPage(action, event.title || 'Unknown', token ?? undefined));
  }

  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : undefined;
  const reviewerUserId = req.user?.id ?? null;
  const result =
    action === 'approve'
      ? await approveEventService(eventId, reviewerUserId, prisma)
      : await rejectEventService(eventId, reviewerUserId, prisma, { reason });
  if (result.error) {
    const latest = await prisma.event.findUnique({
      where: { id: eventId },
      select: { title: true, approval_status: true },
    });
    const finalStatePage = latest ? renderEventFinalStatePage(latest, action) : null;
    if (finalStatePage) {
      return res.send(finalStatePage);
    }
    return res
      .status(result.status || 400)
      .send(renderEventResultPage('Error', result.error, false));
  }

  // Central audit trail (parity with coach/org/ad approvals). The event record
  // also carries approved_by/approved_at inline, but every privileged approval
  // must also land in AdminActivityLog.
  const reviewerEmail = reviewerUserId
    ? (await prisma.user.findUnique({ where: { id: reviewerUserId }, select: { email: true } }))
        ?.email || 'unknown'
    : 'email-token';
  await logAdminActivity(
    reviewerUserId || 'email-token',
    reviewerEmail,
    action === 'approve' ? 'APPROVE_EVENT' : 'REJECT_EVENT',
    'event',
    eventId,
    `${action === 'approve' ? 'Approved' : 'Rejected'} event: ${event.title || eventId}${
      reason ? ` — ${reason}` : ''
    }`
  ).catch(err => console.error('[events] AdminActivityLog write failed:', err));

  // Only consume the token when it was used (admin session path has no token to consume)
  if (tokenValid && token && payload) {
    const consumeResult = await consumeReviewToken(token, payload);
    if (consumeResult !== 'consumed') {
      console.warn('[events] review token could not be marked consumed after success:', {
        event_id: eventId,
        action,
        consumeResult,
      });
    }
  }

  return res.send(
    renderEventResultPage(
      action === 'approve' ? 'Event Approved' : 'Event Rejected',
      `${event.title || 'This event'} has been ${action === 'approve' ? 'approved' : 'rejected'}.`,
      true
    )
  );
}

// One-time startup backfill: geocode events/games that have a location string but no lat/lng.
// Safe to run repeatedly (skips rows already populated). Kept explicit so
// importing the router never mutates data during tests or verification.
export async function runEventsStartupBackfill(): Promise<void> {
  try {
    const missing = await prisma.event.findMany({
      where: { location: { not: null }, latitude: null },
      select: { id: true, location: true },
      take: 1000,
    });
    if (missing.length === 0) return;
    debugLog(`[events] backfill: geocoding ${missing.length} events without coordinates`);
    let success = 0;
    let failed = 0;
    for (const ev of missing) {
      try {
        const coords = await geocodeLocation(ev.location!);
        if (coords) {
          await prisma.event.update({
            where: { id: ev.id },
            data: { latitude: coords.latitude, longitude: coords.longitude },
          });
          success++;
        } else {
          failed++;
          console.warn(
            `[events] backfill: geocode returned null for event ${ev.id} location="${ev.location}"`
          );
        }
      } catch (err: any) {
        failed++;
        console.error(
          `[events] backfill: failed event ${ev.id} location="${ev.location}":`,
          err?.message || err
        );
      }
    }
    debugLog(
      `[events] backfill: done — ${success} geocoded, ${failed} failed out of ${missing.length}`
    );
  } catch (err) {
    console.warn('[events] backfill failed:', err);
  }
}

// Check if a user holds a coaching/management role on any team (DB truth, not preferences)
async function isTeamCoach(userId: string): Promise<boolean> {
  const membership = await prisma.teamMembership.findFirst({
    where: {
      user_id: userId,
      role: { in: ['owner', 'manager', 'coach', 'assistant_coach'] },
      status: 'active',
    },
  });
  return !!membership;
}

// Check if a user holds an admin-level role in any organization
async function isOrgAdmin(userId: string): Promise<boolean> {
  const membership = await prisma.organizationMembership.findFirst({
    where: {
      user_id: userId,
      role: { in: ['owner', 'manager'] },
      status: 'active',
    },
  });
  return !!membership;
}

const serializeEvent = (
  event: any,
  opts: { includeGame?: boolean; rsvpCount?: number; includeCreator?: boolean } = {}
) => {
  // Fall back to linked game coordinates when event itself lacks lat/lng
  const resolvedLat = event.latitude ?? event.game?.latitude ?? event.game?.venue_lat ?? null;
  const resolvedLng = event.longitude ?? event.game?.longitude ?? event.game?.venue_lng ?? null;
  const base: any = {
    id: event.id,
    title: event.title,
    date: event.date instanceof Date ? event.date.toISOString() : event.date,
    location: event.location,
    latitude: resolvedLat,
    longitude: resolvedLng,
    banner_url: event.banner_url,
    game_id: event.game_id,
    capacity: event.capacity,
    status: event.status,
    created_at:
      event.created_at instanceof Date ? event.created_at.toISOString() : event.created_at,
    // Fan event fields
    creator_id: event.creator_id,
    creator_role: event.creator_role,
    approval_status: event.approval_status,
    event_type: event.event_type,
    description: event.description,
    linked_league: event.linked_league,
    max_attendees: event.max_attendees,
    contact_info: event.contact_info,
    approved_at:
      event.approved_at instanceof Date ? event.approved_at.toISOString() : event.approved_at,
    rejected_reason: event.rejected_reason,
    // Sport powers the map's sport filter. Direct team wins; otherwise borrow
    // the linked game's matchup sport. Null when neither is known.
    sport:
      event.team?.sport ??
      event.game?.homeTeam?.sport ??
      event.game?.awayTeam?.sport ??
      event.sportsLeague?.sport_slug ??
      proLeagueToSport(event.proHomeTeam?.league ?? event.proAwayTeam?.league) ??
      null,
    sports_league_id: event.sports_league_id ?? null,
    league_slug: event.sportsLeague?.slug ?? null,
    league_name: event.sportsLeague?.name ?? null,
    league_level: event.sportsLeague?.level ?? null,
    league_gender: event.sportsLeague?.gender ?? null,
    // Pro teams carry no logo (trademark), only an accent color. The card uses
    // these two to render a branded gradient when a pro event has no banner.
    pro_home_color: event.proHomeTeam?.primary_color ?? null,
    pro_away_color: event.proAwayTeam?.primary_color ?? null,
    pro_league: event.proHomeTeam?.league ?? event.proAwayTeam?.league ?? null,
    venue_photo: venuePhotoFor(event.location),
    ...serializeLiveWindow(event.date, event.live_window_hours_after_start),
    // Owner rule (2026-09-14): lets the edit form reflect the coach's
    // all-day toggle without exposing/trusting the raw hour count.
    is_all_day: event.live_window_hours_after_start === COACH_ALL_DAY_LIVE_WINDOW_HOURS,
  };
  if (typeof opts.rsvpCount === 'number') {
    base.attendees_count = opts.rsvpCount;
    base.rsvp_count = opts.rsvpCount;
  }
  if (opts.includeGame && event.game) {
    base.game = {
      id: event.game.id,
      title: event.game.title,
      cover_image_url: event.game.cover_image_url,
      date: event.game.date instanceof Date ? event.game.date.toISOString() : event.game.date,
      location: event.game.location,
      home_score: (event.game as any).home_score ?? null,
      away_score: (event.game as any).away_score ?? null,
      winner: (event.game as any).winner ?? null,
    };
  }
  if (opts.includeCreator && event.creator) {
    base.creator = {
      id: event.creator.id,
      display_name: event.creator.display_name,
      avatar_url: event.creator.avatar_url,
    };
  }
  return base;
};

eventsRouter.get(
  '/sports-leagues',
  asyncHandler(async (req, res) => {
    const slugPattern = /^[a-z0-9_-]{1,120}$/;
    const sportSlug =
      typeof req.query.sport === 'string' ? req.query.sport.trim().toLowerCase() : '';
    const leagueLevel =
      typeof req.query.level === 'string' ? req.query.level.trim().toLowerCase() : '';
    const leagueGender =
      typeof req.query.gender === 'string' ? req.query.gender.trim().toLowerCase() : '';
    const searchRaw = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (searchRaw.length > 80) return sendError(res, 400, 'Invalid search');
    const search = searchRaw;
    for (const [label, value] of [
      ['sport', sportSlug],
      ['level', leagueLevel],
      ['gender', leagueGender],
    ] as const) {
      if (value && !slugPattern.test(value)) return sendError(res, 400, `Invalid ${label}`);
    }
    const limitRaw = Number.parseInt(String(req.query.limit ?? ''), 10);
    const take = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 300) : 300;

    const rows = await prisma.sportsLeague.findMany({
      where: {
        active: true,
        ...(sportSlug ? { sport_slug: sportSlug } : {}),
        ...(leagueLevel ? { level: leagueLevel } : {}),
        ...(leagueGender ? { gender: leagueGender } : {}),
        ...(search
          ? {
              OR: [
                { slug: { contains: search, mode: 'insensitive' } },
                { name: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ level: 'asc' }, { sport_slug: 'asc' }, { name: 'asc' }],
      take,
    });

    const catalogOrder = new Map(SPORTS_LEAGUE_CATALOG.map((entry, index) => [entry.slug, index]));
    const sorted = [...rows].sort((a, b) => {
      const ai = catalogOrder.get(a.slug) ?? Number.MAX_SAFE_INTEGER;
      const bi = catalogOrder.get(b.slug) ?? Number.MAX_SAFE_INTEGER;
      return ai - bi || a.name.localeCompare(b.name);
    });
    const leagueIds = sorted.map(row => row.id);
    const currentEventCounts = leagueIds.length
      ? await prisma.event.groupBy({
          by: ['sports_league_id'],
          where: {
            sports_league_id: { in: leagueIds },
            approval_status: 'approved',
            status: { not: 'cancelled' },
            date: { gte: new Date() },
          },
          _count: { _all: true },
        })
      : [];
    const currentEventCountByLeagueId = new Map(
      currentEventCounts.flatMap(row =>
        row.sports_league_id ? [[row.sports_league_id, row._count._all] as const] : []
      )
    );

    return res.json({
      items: sorted.map(row => {
        const currentEventCount = currentEventCountByLeagueId.get(row.id) ?? 0;
        return {
          id: row.id,
          slug: row.slug,
          name: row.name,
          sport_slug: row.sport_slug,
          level: row.level,
          gender: row.gender,
          country_code: row.country_code,
          provider: row.provider,
          provider_league_id: row.provider_league_id,
          schedule_status: getSportsLeagueScheduleStatus(row, currentEventCount),
          has_current_events: currentEventCount > 0,
          current_event_count: currentEventCount,
        };
      }),
    });
  })
);

eventsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const status = String(req.query.status || '').trim();
    const includeCancelled = String(req.query.include_cancelled || '').toLowerCase() === 'true';
    const approvalStatus = String(req.query.approval_status || '').trim();
    const eventType = String(req.query.event_type || '').trim();
    const search = String(req.query.q || '').trim();
    const sort = String(req.query.sort || '').trim();
    const teamId = typeof req.query.team_id === 'string' ? req.query.team_id.trim() : '';
    const teamIds =
      typeof req.query.team_ids === 'string'
        ? req.query.team_ids
            .split(',')
            .map(value => value.trim())
            .filter(Boolean)
            .slice(0, 50)
        : [];
    const proOnly = String(req.query.pro_only || req.query.pro || '').toLowerCase() === 'true';
    const eventOnly = String(req.query.event_only || '').toLowerCase() === 'true';
    const limitRaw = Number.parseInt(String(req.query.limit ?? ''), 10);
    // v1.0.2 pass 12: default to 100 when no limit is supplied so the query is always bounded.
    // Previous `undefined` fallback let callers omit `limit` and get an unbounded scan on Event.
    const maxTake = proOnly ? 300 : 100;
    const take = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, maxTake) : 100;
    const dateFrom = typeof req.query.from === 'string' ? new Date(req.query.from) : null;
    const dateTo = typeof req.query.to === 'string' ? new Date(req.query.to) : null;
    const proLeagueRaw =
      typeof req.query.pro_league === 'string' ? req.query.pro_league.trim().toLowerCase() : '';
    const sportsLeagueId =
      typeof req.query.sports_league_id === 'string' ? req.query.sports_league_id.trim() : '';
    const leagueSlug =
      typeof req.query.league_slug === 'string' ? req.query.league_slug.trim().toLowerCase() : '';
    const sportSlug =
      typeof req.query.sport === 'string' ? req.query.sport.trim().toLowerCase() : '';
    const leagueLevel =
      typeof req.query.level === 'string' ? req.query.level.trim().toLowerCase() : '';
    const leagueGender =
      typeof req.query.gender === 'string' ? req.query.gender.trim().toLowerCase() : '';
    const slugPattern = /^[a-z0-9_-]{1,120}$/;
    if (sportsLeagueId && !/^[a-zA-Z0-9_-]{1,120}$/.test(sportsLeagueId)) {
      return sendError(res, 400, 'Invalid sports_league_id');
    }
    for (const [label, value] of [
      ['league_slug', leagueSlug],
      ['sport', sportSlug],
      ['level', leagueLevel],
      ['gender', leagueGender],
    ] as const) {
      if (value && !slugPattern.test(value)) return sendError(res, 400, `Invalid ${label}`);
    }
    if (
      proLeagueRaw &&
      !PRO_SCHEDULE_LEAGUES.includes(proLeagueRaw as (typeof PRO_SCHEDULE_LEAGUES)[number])
    ) {
      return sendError(res, 400, 'Invalid pro_league');
    }
    const proLeague = proLeagueRaw as (typeof PRO_SCHEDULE_LEAGUES)[number] | '';

    const where: any = {};
    if (status) where.status = status;
    else if (!includeCancelled) where.status = { not: 'cancelled' }; // Exclude cancelled by default; ?include_cancelled=true for admin views
    // Only admins can filter by approval_status — public users always see approved only
    const isAdminUser = (req as any).user?.id ? await getIsAdmin(req as any) : false;
    if (approvalStatus && isAdminUser) where.approval_status = approvalStatus;
    else where.approval_status = 'approved';
    // A game-backed event inherits its game's opponent-consent gate: an upcoming
    // fixture whose opponent is pending/declined must not surface publicly (past
    // games stay visible). Events with no linked game are unaffected. Admins see
    // everything. Mirrors isGamePubliclyVisible on the single-item surfaces.
    if (!isAdminUser) {
      where.AND = where.AND || [];
      where.AND.push({
        OR: [
          { game_id: null },
          { game: { is: { opponent_approval_status: { notIn: ['pending', 'declined'] } } } },
          { game: { is: { date: { lt: new Date() } } } },
        ],
      });
      mergeAndWhere(
        where,
        buildPrivateTeamEventVisibilityWhere(
          await getExcludedPrivateTeamIds((req as any).user?.id ?? null)
        )
      );
    }
    if (eventType) where.event_type = eventType;
    if (eventOnly) where.game_id = null;
    if (proOnly) {
      where.AND = where.AND || [];
      where.AND.push({
        OR: [
          { pro_home_team_id: { not: null } },
          { pro_away_team_id: { not: null } },
          { sports_league_id: { not: null } },
        ],
      });
    }
    if (sportsLeagueId) where.sports_league_id = sportsLeagueId;
    if (leagueSlug) {
      where.AND = where.AND || [];
      where.AND.push({ sportsLeague: { is: { slug: leagueSlug } } });
    }
    if (sportSlug) {
      where.AND = where.AND || [];
      where.AND.push({
        OR: [
          { team: { is: { sport: sportSlug } } },
          { game: { is: { homeTeam: { is: { sport: sportSlug } } } } },
          { game: { is: { awayTeam: { is: { sport: sportSlug } } } } },
          { sportsLeague: { is: { sport_slug: sportSlug } } },
        ],
      });
    }
    if (leagueLevel) {
      where.AND = where.AND || [];
      where.AND.push({ sportsLeague: { is: { level: leagueLevel } } });
    }
    if (leagueGender) {
      where.AND = where.AND || [];
      where.AND.push({ sportsLeague: { is: { gender: leagueGender } } });
    }
    if (proLeague) {
      where.AND = where.AND || [];
      where.AND.push({
        OR: [
          { proHomeTeam: { is: { league: proLeague } } },
          { proAwayTeam: { is: { league: proLeague } } },
          { sportsLeague: { is: { slug: proLeague } } },
        ],
      });
    }
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { location: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (teamId || teamIds.length > 0) {
      const scopedTeamIds = [...new Set([teamId, ...teamIds].filter(Boolean))];
      where.AND = where.AND || [];
      where.AND.push({
        OR: [
          { team_id: { in: scopedTeamIds } },
          {
            game: {
              is: {
                OR: [
                  { home_team_id: { in: scopedTeamIds } },
                  { away_team_id: { in: scopedTeamIds } },
                ],
              },
            },
          },
        ],
      });
    }

    // `following=true` scopes to teams the authenticated viewer follows — the
    // Discover calendar surface (mirrors the same scope on GET /games). A guest,
    // or a viewer who follows no teams, gets an empty list, never a global scan.
    const following = String(req.query.following || '').toLowerCase() === 'true';
    if (following) {
      const viewerId = (req as any).user?.id as string | undefined;
      if (!viewerId) return res.json([]);
      // audit-allow unbounded: calendar scope needs every team the viewer follows
      const followedRows = await prisma.teamFollow.findMany({
        where: { user_id: viewerId },
        select: { team_id: true },
        take: 500,
      });
      const followedTeamIds = followedRows.map(r => r.team_id);
      if (followedTeamIds.length === 0) return res.json([]);
      where.AND = where.AND || [];
      where.AND.push({
        OR: [
          { team_id: { in: followedTeamIds } },
          {
            game: {
              is: {
                OR: [
                  { home_team_id: { in: followedTeamIds } },
                  { away_team_id: { in: followedTeamIds } },
                ],
              },
            },
          },
        ],
      });
    }

    // v1.0.2: auto-archive window is 3 days after event date (was "hide anything past").
    // Events remain visible in listings for 72h after they happen (post-game photos, recap)
    // and drop off after. `include_past=true` still returns everything for admin/team views.
    if (
      (dateFrom && !Number.isNaN(dateFrom.getTime())) ||
      (dateTo && !Number.isNaN(dateTo.getTime()))
    ) {
      where.date = where.date || {};
      if (dateFrom && !Number.isNaN(dateFrom.getTime())) where.date.gte = dateFrom;
      if (dateTo && !Number.isNaN(dateTo.getTime())) where.date.lte = dateTo;
    } else if (!req.query.include_past && !approvalStatus) {
      const EVENT_ARCHIVE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
      const archiveCutoff = new Date(Date.now() - EVENT_ARCHIVE_WINDOW_MS);
      where.date = { gte: archiveCutoff };
    }

    const orderBy =
      sort === 'date'
        ? { date: 'asc' as const }
        : sort === '-date'
          ? { date: 'desc' as const }
          : { created_at: 'desc' as const };

    // Location filtering: resolve user coordinates from zip or lat/lng params
    const showAll = String(req.query.show_all || '').toLowerCase() === 'true';
    const eventRadius = Math.min(Number(req.query.radius) || 30, 500); // default 30mi
    let userCoords: { lat: number; lon: number } | null = null;
    if (!showAll) {
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
    }

    // Constrain the DB query to a bounding box around the viewer BEFORE the
    // take/order cap, so a bulk import of far-away events (e.g. hundreds of pro
    // fixtures) can't push a nearby event out of the fetched window entirely.
    // The haversine pass below refines this square to the true radius. Events
    // with no own coordinates (game-linked events derive coords from the linked
    // game) are kept here and distance-filtered afterwards via that fallback.
    if (userCoords) {
      const box = geoBoundingBox(userCoords.lat, userCoords.lon, eventRadius);
      where.AND = where.AND || [];
      where.AND.push({
        OR: [
          {
            latitude: { gte: box.minLat, lte: box.maxLat },
            longitude: { gte: box.minLng, lte: box.maxLng },
          },
          { latitude: null },
        ],
      });
    }

    // Over-fetch when location filtering to compensate for filtered-out events
    const fetchLimit = userCoords ? Math.min((take ?? 100) * 3, 300) : take;
    let events = await prisma.event.findMany({
      where,
      orderBy,
      take: fetchLimit,
      include: {
        // Sport for the map filter: a fan event is tied to a team; a
        // game-linked event borrows its matchup's sport; a pro event derives
        // it from its league.
        team: { select: { sport: true } },
        sportsLeague: {
          select: { slug: true, name: true, sport_slug: true, level: true, gender: true },
        },
        proHomeTeam: { select: { league: true, primary_color: true } },
        proAwayTeam: { select: { league: true, primary_color: true } },
        game: {
          select: {
            id: true,
            title: true,
            cover_image_url: true,
            date: true,
            location: true,
            latitude: true,
            longitude: true,
            venue_lat: true,
            venue_lng: true,
            homeTeam: { select: { sport: true } },
            awayTeam: { select: { sport: true } },
          },
        },
      },
    });

    // Apply location filter: keep events without coords + events within radius
    // Use game-derived coordinates as fallback when event itself has no lat/lng
    if (userCoords) {
      events = events.filter((e: any) => {
        const lat = e.latitude ?? e.game?.latitude ?? e.game?.venue_lat ?? null;
        const lng = e.longitude ?? e.game?.longitude ?? e.game?.venue_lng ?? null;
        if (lat == null || lng == null) return true; // no location → always show
        return haversineDistance(userCoords!.lat, userCoords!.lon, lat, lng) <= eventRadius;
      });
      if (take) events = events.slice(0, take);
    }

    res.json(events.map(event => serializeEvent(event, { includeGame: true })));
  })
);

// List current user's RSVPs with event basics
eventsRouter.get(
  '/my-rsvps',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const limit = Math.max(
      1,
      Math.min(Number.parseInt(String(req.query.limit ?? '50'), 10) || 50, 100)
    );
    const cursorRaw = typeof req.query.cursor === 'string' ? req.query.cursor : null;
    const cursor = cursorRaw ? parseEventRsvpCursor(cursorRaw) : null;
    if (cursorRaw && !cursor) {
      return res.status(400).json({ error: 'INVALID_CURSOR' });
    }

    const where: any = { user_id: req.user.id };
    if (cursor) {
      where.OR = [
        { created_at: { lt: cursor.createdAt } },
        {
          created_at: { equals: cursor.createdAt },
          id: { lt: cursor.id },
        },
      ];
    }

    const rows = await prisma.eventRsvp.findMany({
      where,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      include: {
        event: {
          include: {
            game: {
              select: {
                id: true,
                title: true,
                cover_image_url: true,
                date: true,
                location: true,
                latitude: true,
                longitude: true,
                venue_lat: true,
                venue_lng: true,
              },
            },
          },
        },
      },
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? encodeEventRsvpCursor(page[page.length - 1]!) : null;
    if (nextCursor) {
      res.set('x-next-cursor', nextCursor);
    }
    res.set('x-has-more', nextCursor ? '1' : '0');

    const list = page.map(r => ({
      id: r.id,
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      event: r.event ? serializeEvent(r.event, { includeGame: true }) : null,
    }));
    return res.json(list);
  })
);

// List current user's created events (for fans to track their submissions)
eventsRouter.get(
  '/my-events',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const limit = Math.max(
      1,
      Math.min(Number.parseInt(String(req.query.limit ?? '25'), 10) || 25, 100)
    );
    const cursorRaw = typeof req.query.cursor === 'string' ? req.query.cursor : null;
    const cursor = cursorRaw ? parseEventRsvpCursor(cursorRaw) : null;
    if (cursorRaw && !cursor) {
      return res.status(400).json({ error: 'INVALID_CURSOR' });
    }

    const createdAtCursorWhere = buildCreatedAtIdCursorWhere(cursor);
    const events = await prisma.event.findMany({
      where: {
        creator_id: req.user!.id,
        ...(createdAtCursorWhere ? { OR: createdAtCursorWhere } : {}),
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        title: true,
        date: true,
        location: true,
        event_type: true,
        approval_status: true,
        status: true,
        rejected_reason: true,
        created_at: true,
        approved_at: true,
        description: true,
        game_id: true,
      },
    });
    const page = events.slice(0, limit);
    const nextCursor = events.length > limit ? encodeEventRsvpCursor(page[page.length - 1]!) : null;
    if (nextCursor) {
      res.set('x-next-cursor', nextCursor);
    }
    res.set('x-has-more', nextCursor ? '1' : '0');
    return res.json(page);
  })
);

// Get pending events for approval (admins & coaches only) - MUST be before /:id to avoid "pending" matching as id
eventsRouter.get(
  '/pending',
  requireAuth as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const isAdmin = await getIsAdmin(req as any);

    // Only coaches, org admins, and platform admins can view pending events (DB-verified roles)
    if (!isAdmin && !(await isTeamCoach(userId)) && !(await isOrgAdmin(userId))) {
      return res.status(403).json({ error: 'Only coaches and admins can view pending events' });
    }

    let where: any = { approval_status: 'pending' };
    if (!isAdmin) {
      const [managedTeams, managedOrgs] = await Promise.all([
        prisma.teamMembership.findMany({
          where: {
            user_id: userId,
            role: { in: ['owner', 'manager', 'coach', 'assistant_coach'] },
            status: 'active',
          },
          select: { team_id: true },
          take: 200,
        }),
        prisma.organizationMembership.findMany({
          where: {
            user_id: userId,
            role: { in: ['owner', 'manager'] },
            status: 'active',
          },
          select: { organization_id: true },
          take: 100,
        }),
      ]);

      const managedTeamIds = managedTeams.map(m => m.team_id);
      const managedOrgIds = managedOrgs.map(m => m.organization_id);
      const scope: any[] = [];
      if (managedTeamIds.length > 0) scope.push({ team_id: { in: managedTeamIds } });
      if (managedOrgIds.length > 0)
        scope.push({ team: { organization_id: { in: managedOrgIds } } });
      where =
        scope.length > 0
          ? {
              approval_status: 'pending',
              OR: scope,
            }
          : { approval_status: 'pending', team_id: '__no_visible_pending_events__' };
    }

    const limit = Math.max(
      1,
      Math.min(Number.parseInt(String(req.query.limit ?? '50'), 10) || 50, 100)
    );
    const cursorRaw = typeof req.query.cursor === 'string' ? req.query.cursor : null;
    const cursor = cursorRaw ? parseEventRsvpCursor(cursorRaw) : null;
    if (cursorRaw && !cursor) {
      return res.status(400).json({ error: 'INVALID_CURSOR' });
    }
    const createdAtCursorWhere = buildCreatedAtIdCursorWhere(cursor);

    const events = await prisma.event.findMany({
      where: createdAtCursorWhere ? { ...where, OR: createdAtCursorWhere } : where,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      include: {
        game: {
          select: {
            id: true,
            title: true,
            cover_image_url: true,
            date: true,
            location: true,
            latitude: true,
            longitude: true,
            venue_lat: true,
            venue_lng: true,
          },
        },
        creator: { select: { id: true, display_name: true, avatar_url: true } },
      },
      take: limit + 1,
    });

    const page = events.slice(0, limit);
    const nextCursor = events.length > limit ? encodeEventRsvpCursor(page[page.length - 1]!) : null;
    if (nextCursor) {
      res.set('x-next-cursor', nextCursor);
    }
    res.set('x-has-more', nextCursor ? '1' : '0');

    return res.json(
      page.map(event => serializeEvent(event, { includeGame: true, includeCreator: true }))
    );
  })
);

// Batched RSVP status: one request for all visible events instead of one per
// event (mirrors /games/votes-summary). Must register before '/:id'.
eventsRouter.get(
  '/rsvp-summary',
  asyncHandler(async (req: AuthedRequest, res) => {
    const idsParam = String(req.query.ids || '').trim();
    if (!idsParam)
      return res.status(400).json({ error: 'ids required (comma-separated event IDs)' });
    const ids = idsParam
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    if (ids.length === 0) return res.json({});
    if (ids.length > 50) return res.status(400).json({ error: 'Max 50 ids per request' });
    const userId = req.user?.id ?? null;

    const [counts, mine] = await Promise.all([
      prisma.eventRsvp.groupBy({
        by: ['event_id'],
        _count: { _all: true },
        where: { event_id: { in: ids } },
      }),
      userId
        ? prisma.eventRsvp.findMany({
            where: { event_id: { in: ids }, user_id: userId },
            select: { event_id: true },
            take: ids.length,
          })
        : Promise.resolve([]),
    ]);

    const countMap = new Map(counts.map(c => [c.event_id, c._count._all]));
    const mineSet = new Set(mine.map(m => m.event_id));
    const out: Record<string, { going: boolean; count: number }> = {};
    for (const id of ids) {
      out[id] = { going: mineSet.has(id), count: countMap.get(id) ?? 0 };
    }
    return res.json(out);
  })
);

// Get single event with RSVP count (optionally includes can_cancel when authenticated)
eventsRouter.get(
  '/:id',
  authMiddleware as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = String(req.params.id);
    const event = await prisma.event.findUnique({
      where: { id },
      include: {
        game: {
          select: {
            id: true,
            title: true,
            cover_image_url: true,
            date: true,
            location: true,
            latitude: true,
            longitude: true,
            venue_lat: true,
            venue_lng: true,
            home_team_id: true,
            away_team_id: true,
            home_score: true,
            away_score: true,
            winner: true,
          },
        },
      },
    });
    if (!event) return res.status(404).json({ error: 'Not found' });

    // Approved events are public to everyone (viewing never expires — owner
    // rule 2026-07-14). A non-approved event is still visible to its creator,
    // admins, or any contributor who posted to it (permanent, read-only — grants
    // no approval power).
    if (event.approval_status !== 'approved') {
      const isCreator = req.user && event.creator_id === req.user.id;
      const isAdmin = req.user ? await getIsAdmin(req as any) : false;
      let hasGraceViewAccess = false;
      if (!isCreator && !isAdmin && req.user) {
        hasGraceViewAccess = await viewerHasPostedOnEntity({
          userId: req.user.id,
          eventId: event.id,
          gameId: event.game_id ?? null,
        });
      }
      if (!isCreator && !isAdmin && !hasGraceViewAccess) {
        return res.status(404).json({ error: 'Not found' });
      }
    }

    const count = await prisma.eventRsvp.count({ where: { event_id: id } });
    const payload = serializeEvent(event, { includeGame: true, rsvpCount: count });
    if (req.user && event.status !== 'cancelled') {
      const isCreator = event.creator_id === req.user.id;
      let isTeamOwner = false;
      if (event.game?.home_team_id || event.game?.away_team_id) {
        const teamIds = [event.game.home_team_id, event.game.away_team_id].filter(
          Boolean
        ) as string[];
        const ownership = await prisma.teamMembership.findFirst({
          where: {
            team_id: { in: teamIds },
            user_id: req.user.id,
            role: 'owner',
            status: 'active',
          },
        });
        isTeamOwner = !!ownership;
      }
      const isAdmin = await getIsAdmin(req as any);
      (payload as any).can_cancel = isCreator || isTeamOwner || isAdmin;
      // can_edit: creator, any active team staff (coach/owner), or admin
      let canManage = isCreator || isAdmin;
      if (!canManage && event.team_id) {
        canManage = await canManageTeamScoped(req.user.id, event.team_id);
      } else if (!canManage && (event.game?.home_team_id || event.game?.away_team_id)) {
        const teamIds = [event.game.home_team_id, event.game.away_team_id].filter(
          Boolean
        ) as string[];
        canManage = await canManageAnyTeam(req.user.id, teamIds);
      }
      (payload as any).can_edit = canManage;

      // Per-viewer story override, same rule the story create-gate enforces: a
      // user who already posted/storied here (holds an active 7-day unlock) — or
      // the exclusive poster — may add a story to this event page from anywhere,
      // even after the live window has closed (owner rule, Sep 2026). The client
      // uses this to enable "Add Story" and skip the geofence for such users.
      // Everyone else follows the normal live window.
      const activeUnlock = await hasActiveEventPostingUnlock(req.user.id, {
        id: event.id,
        game_id: event.game_id ?? null,
      });
      const isExclusivePoster =
        !!event.exclusive_poster_id && event.exclusive_poster_id === req.user.id;
      (payload as any).can_upload_story = activeUnlock || isExclusivePoster;
    }
    return res.json(payload);
  })
);

// Get RSVP status and count
eventsRouter.get(
  '/:id/rsvp',
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = String(req.params.id);
    const event = await prisma.event.findUnique({
      where: { id },
      select: { capacity: true, max_attendees: true },
    });
    if (!event) return res.status(404).json({ error: 'Not found' });
    const count = await prisma.eventRsvp.count({ where: { event_id: id } });
    const capacity = event.capacity ?? event.max_attendees ?? null;
    if (!req.user) return res.json({ going: false, attending: false, count, capacity });
    const exists = await prisma.eventRsvp.findUnique({
      where: { event_id_user_id: { event_id: id, user_id: req.user.id } } as any,
    });
    const going = !!exists;
    return res.json({ going, attending: going, count, capacity });
  })
);

// Toggle/set RSVP
const rsvpSchema = z.object({ attending: z.boolean().optional(), going: z.boolean().optional() });

eventsRouter.post(
  '/:id/rsvp',
  requireAuth as any,
  rsvpLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const id = String(req.params.id);

    // Get event with date, capacity, title, location for RSVP and confirmation email.
    // Also pulls the team / game / creator linkage so we can enforce an
    // affiliation check — previously any authenticated user could RSVP to any
    // event (private team practices included), leading to fake attendance
    // counts and notification spam.
    const event = await prisma.event.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        location: true,
        capacity: true,
        max_attendees: true,
        date: true,
        timezone: true,
        status: true,
        approval_status: true,
        team_id: true,
        creator_id: true,
        creator: { select: { email: true } },
        game: { select: { id: true, home_team_id: true, away_team_id: true } },
      },
    });
    if (!event) return res.status(404).json({ error: 'Not found' });

    // Only a live (approved, non-cancelled) event can accept RSVPs. Previously
    // only the date was checked, so a cancelled/pending/rejected event still
    // took RSVPs and scheduled reminders for an event that isn't happening.
    if (event.approval_status && event.approval_status !== 'approved') {
      // error-envelope-exempt: matches this file's existing res.status().json() style
      return res.status(400).json({
        error: 'Event not available',
        message: 'This event is not open for RSVPs.',
      });
    }
    if (event.status === 'cancelled') {
      // error-envelope-exempt: matches this file's existing res.status().json() style
      return res.status(400).json({
        error: 'Event cancelled',
        message: 'This event has been cancelled.',
      });
    }

    // Validate event hasn't passed
    const eventDate = new Date(event.date);
    const now = new Date();
    if (eventDate < now) {
      return res.status(400).json({
        error: 'Event has passed',
        message: 'You cannot RSVP to events that have already occurred.',
      });
    }

    // RSVP affiliation gate: if the event is linked to any team (directly via
    // event.team_id or indirectly via event.game.home_team_id/away_team_id),
    // the requester must have some relationship to at least one of those teams
    // — member, follower, org admin — OR be the event creator, OR be a global
    // admin. Events with no team linkage are treated as public (anyone can
    // RSVP). The creator always passes regardless of current team membership,
    // since they built the event.
    const linkedTeamIds = [
      event.team_id ?? null,
      event.game?.home_team_id ?? null,
      event.game?.away_team_id ?? null,
    ].filter((tid): tid is string => Boolean(tid));

    // Platform-admin-created events are open to all authenticated users — no
    // affiliation required. Admins create public events (World Cup, pro games)
    // where anyone should be able to RSVP.
    const creatorIsAdmin = isEmailAdmin(event.creator?.email);

    if (linkedTeamIds.length > 0 && event.creator_id !== req.user.id && !creatorIsAdmin) {
      const [teamMembership, teamFollow, orgAdminCheck, isAdminUser] = await Promise.all([
        prisma.teamMembership.findFirst({
          where: {
            team_id: { in: linkedTeamIds },
            user_id: req.user.id,
            status: 'active',
          },
          select: { id: true },
        }),
        prisma.teamFollow.findFirst({
          where: { team_id: { in: linkedTeamIds }, user_id: req.user.id },
          select: { team_id: true },
        }),
        canManageAnyTeam(req.user.id, linkedTeamIds),
        getIsAdmin(req as any),
      ]);

      if (!teamMembership && !teamFollow && !orgAdminCheck && !isAdminUser) {
        return res.status(403).json({
          error: 'EVENT_AFFILIATION_REQUIRED',
          message: 'You must be a member or follower of this team to RSVP to this event.',
        });
      }
    }

    const parsed = rsvpSchema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid payload',
        issues: parsed.error.issues.map(i => ({ path: i.path, message: i.message })),
      });
    }
    const me = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!me) return res.status(401).json({ error: 'Unauthorized' });
    const current = await prisma.eventRsvp.findUnique({
      where: { event_id_user_id: { event_id: id, user_id: me.id } } as any,
    });
    const desired =
      typeof parsed.data.going === 'boolean'
        ? parsed.data.going
        : typeof parsed.data.attending === 'boolean'
          ? parsed.data.attending
          : !current;

    if (desired && !current) {
      // v1.0.2 pass 9: prevent capacity-overflow race by using SELECT ... FOR UPDATE on the
      // event row. The row lock serializes concurrent RSVPs so only one count+insert runs at
      // a time. Read Committed is sufficient here — after the lock is acquired each
      // transaction sees committed inserts from prior transactions, keeping the count accurate.
      // (Serializable was removed because SSI throws P2034 serialization failures on
      // concurrent count+insert even with FOR UPDATE, causing spurious 500s.)
      try {
        await prisma.$transaction(async tx => {
          // Lock the event row so concurrent RSVP transactions serialize at this point.
          await tx.$queryRaw`SELECT id FROM "Event" WHERE id = ${id} FOR UPDATE`;
          const currentCount = await tx.eventRsvp.count({ where: { event_id: id } });
          const capacity = event.capacity ?? event.max_attendees;
          if (capacity && currentCount >= capacity) {
            throw new Error('EVENT_AT_CAPACITY');
          }
          await tx.eventRsvp.create({
            data: { event_id: id, user_id: me.id, user_email: me.email },
          });
        });

        // Schedule game reminder notifications (12h and 1h before)
        await scheduleGameReminders(id, me.id).catch(err =>
          console.warn('[events] Failed to schedule reminders:', err)
        );

        // Owner "commandments" rule (2026-09-14): "Lets turn rsvp into,
        // watching... No email for now." No confirmation email is sent for
        // marking an event as watching.
      } catch (error: any) {
        if (error.message === 'EVENT_AT_CAPACITY') {
          const currentCount = await prisma.eventRsvp.count({ where: { event_id: id } });
          const capacity = event.capacity ?? event.max_attendees;
          return res.status(403).json({
            error: 'Event at capacity',
            message: 'This event is full. Please check back later for cancellations.',
            count: currentCount,
            capacity,
          });
        }
        // Prisma P2002 = unique constraint violation (duplicate RSVP from race)
        // Return settled state instead of 500
        if (error.code === 'P2002') {
          const count = await prisma.eventRsvp.count({ where: { event_id: id } });
          const capacity = event.capacity ?? event.max_attendees;
          return res.json({ going: true, attending: true, count, capacity: capacity ?? null });
        }
        throw error;
      }
    } else if (!desired && current) {
      await prisma.eventRsvp.delete({
        where: { event_id_user_id: { event_id: id, user_id: me.id } } as any,
      });
      // Cancel scheduled reminders
      await cancelGameReminders(id, me.id).catch(err =>
        console.warn('[events] Failed to cancel reminders:', err)
      );
    }
    const count = await prisma.eventRsvp.count({ where: { event_id: id } });
    const capacity = event.capacity ?? event.max_attendees;
    return res.json({ going: desired, attending: desired, count, capacity: capacity ?? null });
  })
);

// ── Event-page stories ──────────────────────────────────────────────────────
// Game-less event pages (pro fixtures, etc.) host stories keyed on event_id,
// the same way they already host posts. These mirror GET/POST
// /games/:id/stories exactly, reusing the shared serializeMedia / storySchema /
// ensureStoryPoster / verifyStoryPostingPermission helpers so there is ONE story
// code path — no duplicate page, no duplicate logic. A story with a game keeps
// using the games router; this path is only for the event's own id.
eventsRouter.get(
  '/:id/stories',
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = String(req.params.id);
    const storyNow = new Date();
    try {
      const event = await prisma.event.findUnique({
        where: { id },
        select: EVENT_VISIBILITY_SELECT,
      });
      if (!event) return sendError(res, 404, 'Not found');
      if (!(await canViewEventRecord(event, req))) {
        return sendError(res, 404, 'Not found');
      }

      const viewerId = req.user?.id ?? null;
      const [privateIds, blockedIds] = await Promise.all([
        getExcludedPrivateAuthorIds(viewerId),
        getBlockedUserIds(viewerId, getRequestBlockedCache(req)),
      ]);
      const excludedAuthorIds = [...new Set([...privateIds, ...blockedIds])];

      // Lazy expiry sweep for this event's stories (mirrors the game path).
      void (async () => {
        try {
          const expired = await prisma.story.findMany({
            where: { event_id: id, expires_at: { lt: new Date() } },
            select: { id: true, media_url: true },
            take: 200,
          });
          if (expired.length === 0) return;
          await prisma.story.deleteMany({ where: { id: { in: expired.map(s => s.id) } } });
          const { extractCloudinaryPublicId, destroyCloudinaryAsset } =
            await import('../lib/cloudinary.js');
          for (const story of expired) {
            if (!story.media_url) continue;
            const parsed = extractCloudinaryPublicId(story.media_url);
            if (!parsed) continue;
            destroyCloudinaryAsset(parsed.publicId, parsed.resourceType).catch(err =>
              console.warn(
                '[eventStories] Cloudinary destroy failed for expired story',
                story.id,
                err?.message || err
              )
            );
          }
        } catch (err: any) {
          console.warn('[eventStories] lazy expired-cleanup failed:', err?.message || err);
        }
      })();

      // Newest 50, replayed oldest-first — identical windowing to game stories.
      const items = await prisma.story.findMany({
        where: {
          event_id: id,
          AND: [
            { OR: [{ expires_at: null }, { expires_at: { gt: storyNow } }] },
            { OR: [{ user_id: null }, { user_id: { notIn: excludedAuthorIds } }] },
          ],
        },
        orderBy: { created_at: 'desc' },
        take: 50,
        select: {
          id: true,
          media_url: true,
          poster_url: true,
          created_at: true,
          caption: true,
          user_id: true,
          expires_at: true,
        },
      });
      for (const s of items) ensureStoryPoster(prisma, s);
      return res.json(items.reverse().map(serializeMedia));
    } catch (error: any) {
      console.error('[eventStories] Failed to list event media:', error);
      return sendError(res, 500, 'Failed to load event media');
    }
  })
);

eventsRouter.post(
  '/:id/stories',
  requireAuth as any,
  storyCreationLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const id = String(req.params.id);
    const parsed = storySchema.safeParse(req.body || {});
    if (!parsed.success) return sendError(res, 400, 'Invalid payload');
    const requestIdentity = storyRequestIdentity(req.user.id, 'event:' + id, parsed.data);
    const replayStory = async () => {
      try {
        const existing = await recoverStoryRequest(prisma, requestIdentity, req.user!.id);
        if (!existing) return false;
        res.status(200).json(existing);
      } catch (error: any) {
        if (error?.status !== 409) throw error;
        sendError(
          res,
          409,
          'This request conflicts with a previous submission. Please refresh and try again.',
          { code: 'IDEMPOTENCY_CONFLICT' }
        );
      }
      return true;
    };
    if (await replayStory()) return;

    const event = await prisma.event.findUnique({
      where: { id },
      select: { ...EVENT_VISIBILITY_SELECT, description: true, title: true },
    });
    if (!event) return sendError(res, 404, 'Not found');
    if (!(await canViewEventRecord(event, req))) {
      return sendError(res, 404, 'Not found');
    }

    // Only verified admin identity can bypass; descriptions never grant privileges.
    const isAdmin = await getIsAdmin(req as any);

    if (!isAdmin) {
      const loc = parsed.data.location;
      // Only device-origin GPS may satisfy the venue geofence (anti-spoof). A
      // designated poster with an active unlock passes without coords — that is
      // exactly what verifyStoryPostingPermission enforces server-side.
      const hasDeviceOriginLocation =
        loc?.source === 'device' && typeof loc?.lat === 'number' && typeof loc?.lng === 'number';
      const lat = hasDeviceOriginLocation ? (loc?.lat ?? null) : null;
      const lng = hasDeviceOriginLocation ? (loc?.lng ?? null) : null;
      const ipAddr =
        (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
        req.socket.remoteAddress ||
        null;
      const verification = await verifyStoryPostingPermission(id, req.user.id, lat, lng, ipAddr);
      if (!verification.allowed) {
        return res.status(403).json({
          error: verification.code || 'LOCATION_VERIFICATION_FAILED',
          message: verification.reason,
          distance: verification.distance,
        });
      }
    }

    const loc = parsed.data.location;
    let verifiedMedia;
    try {
      verifiedMedia = await assertReadyMediaForOwner(
        req.user.id,
        parsed.data.media_url,
        parsed.data.poster_url,
        20.25 // Nominal 20s story + 250ms frame/audio mux tolerance, matching the client trim gate.
      );
    } catch (error: any) {
      if (error?.status !== 422) throw error;
      return sendError(
        res,
        422,
        error.code === 'MEDIA_DURATION_EXCEEDED'
          ? 'Stories are limited to 20 seconds. Trim this video and retry.'
          : 'This media is not ready. Please upload it again.',
        {
          code:
            error.code === 'MEDIA_DURATION_EXCEEDED'
              ? 'MEDIA_DURATION_EXCEEDED'
              : 'MEDIA_NOT_READY',
        }
      );
    }
    const createData: any = {
      ...(requestIdentity
        ? { id: requestIdentity.id, client_request_hash: requestIdentity.hash }
        : {}),
      event_id: id,
      user_id: req.user.id,
      media_url: parsed.data.media_url,
      poster_url: verifiedMedia?.poster_url ?? parsed.data.poster_url ?? undefined,
      caption: parsed.data.caption ? stripHtml(parsed.data.caption) : undefined,
    };
    if (typeof loc?.lat === 'number') createData.lat = loc.lat;
    if (typeof loc?.lng === 'number') createData.lng = loc.lng;

    let story;
    try {
      story = await prisma.story.create({ data: createData });
    } catch (error: any) {
      if (error?.code === 'P2002' && (await replayStory())) return;
      if (!isMissingStoryLocationColumnError(error)) {
        console.error('[eventStories] Failed to create story:', error);
        return sendError(res, 500, 'Failed to create story');
      }
      const { lat: _lat, lng: _lng, ...withoutCoords } = createData;
      try {
        story = await prisma.story.create({ data: withoutCoords });
      } catch (fallbackError) {
        console.error('[eventStories] Failed to create story in fallback mode:', fallbackError);
        return sendError(res, 500, 'Failed to create story');
      }
    }

    ensureStoryPoster(prisma, story);

    // Notify the event creator (parity with the game story notification).
    try {
      if (event.creator_id && event.creator_id !== req.user.id) {
        const poster = await prisma.user.findUnique({
          where: { id: req.user.id },
          select: { display_name: true },
        });
        const posterName = poster?.display_name || 'Someone';
        await prisma.notification.create({
          data: {
            user_id: event.creator_id,
            actor_id: req.user.id,
            type: 'GAME_STORY_ADDED',
            meta: { event_id: id, game_title: (event as any).title, poster_name: posterName },
          },
        });
        void sendPushNotification(
          event.creator_id,
          `New story on ${(event as any).title}`,
          `${posterName} added a story to your event`,
          { type: 'game_story_added', event_id: id, screen: 'game-detail' }
        ).catch(pushErr =>
          console.warn('[eventStories] Failed to send event story push:', pushErr)
        );
      }
    } catch (notifErr) {
      console.error('[eventStories] Failed to send event story notification:', notifErr);
    }

    return res.status(201).json(story);
  })
);

eventsRouter.get(
  '/:id/votes/summary',
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const eventId = String(req.params.id);
      const eligibility = await getEventPollEligibility(eventId);
      if (!eligibility.ok) {
        return res.status(eligibility.status).json(eligibility.body);
      }
      const summary = await summarizeEventVotes(eventId, req.user?.id);
      return res.json(summary);
    } catch (err) {
      console.error('[events] votes-summary-single error:', err);
      return sendError(res, 500, 'Internal server error');
    }
  })
);

eventsRouter.post(
  '/:id/votes',
  requireAuth as any,
  voteLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      if (!req.user) return sendError(res, 401, 'Unauthorized');
      const eventId = String(req.params.id);
      const eligibility = await getEventPollEligibility(eventId);
      if (!eligibility.ok) {
        return res.status(eligibility.status).json(eligibility.body);
      }
      const teamInput = String(req.body?.team ?? '')
        .trim()
        .toUpperCase();
      if (teamInput !== 'A' && teamInput !== 'B') {
        return sendError(res, 400, 'Invalid team option');
      }

      await prisma.eventVote.upsert({
        where: { event_id_user_id: { event_id: eventId, user_id: req.user.id } },
        update: { team: teamInput },
        create: { event_id: eventId, user_id: req.user.id, team: teamInput },
      });

      const summary = await summarizeEventVotes(eventId, req.user.id);
      return res.json(summary);
    } catch (err) {
      console.error('[events] cast-vote error:', err);
      return sendError(res, 500, 'Internal server error');
    }
  })
);

eventsRouter.delete(
  '/:id/votes',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      if (!req.user) return sendError(res, 401, 'Unauthorized');
      const eventId = String(req.params.id);
      const eligibility = await getEventPollEligibility(eventId);
      if (!eligibility.ok) {
        return res.status(eligibility.status).json(eligibility.body);
      }
      await prisma.eventVote.deleteMany({ where: { event_id: eventId, user_id: req.user.id } });
      const summary = await summarizeEventVotes(eventId, req.user.id);
      return res.json(summary);
    } catch (err) {
      console.error('[events] delete-vote error:', err);
      return sendError(res, 500, 'Internal server error');
    }
  })
);

// Create event (fans & coaches)
const createEventSchema = z.object({
  title: z.string().trim().min(1).max(200),
  date: z.string().refine(
    dateStr => {
      const eventDate = new Date(dateStr);
      const now = new Date();
      return eventDate >= now;
    },
    {
      message: 'Event date must be in the future',
    }
  ),
  location: z.string().trim().min(1, 'Location is required'),
  timezone: z.string().max(64).optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  description: z.string().trim().max(5000).optional(),
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
  linked_league: z.string().trim().optional(),
  max_attendees: z.number().optional(),
  contact_info: z.string().trim().optional(),
  banner_url: z.string().optional(),
  cover_image_url: z.string().optional(),
  // Owner rule (2026-09-14): coaches may mark an event "all day" to extend the
  // geofenced posting window from the 6h default to 12h after start. A
  // boolean toggle only — the actual hour count is server-derived
  // (COACH_ALL_DAY_LIVE_WINDOW_HOURS), never client-supplied.
  is_all_day: z.boolean().optional(),
  game_id: z.string().optional(),
  home_team_id: z.string().optional(),
  team_id: z.string().optional(), // Alias for home_team_id — frontend may send either
  // Host request fields (sent by request-host-event screen)
  venue_address: z.string().trim().optional(),
  venue_place_id: z.string().trim().optional(),
  requested_by: z.string().trim().optional(),
  requested_email: z.string().trim().optional(),
});

eventsRouter.post(
  '/',
  requireAuth as any,
  requireVerified as any,
  requireOnboarded as any,
  eventCreationLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    // req.user is guaranteed by requireVerified middleware
    const parsed = createEventSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid payload',
        issues: parsed.error.issues.map(i => ({ path: i.path, message: i.message })),
      });
    }

    const data = parsed.data;
    // Normalize: accept either team_id or home_team_id from frontend
    if (data.team_id && !data.home_team_id) {
      data.home_team_id = data.team_id;
    }

    if (data.event_type === 'game' && !data.game_id) {
      return sendError(res, 400, 'Competitive games must be created through /games', {
        message:
          'Competitive games require a linked game_id so polls, scores, stories, and approvals use the Game record. Use /games for competitive games and /events for non-competitive events.',
        code: 'COMPETITIVE_EVENT_REQUIRES_GAME',
      });
    }

    // Validate event date is in the future
    const eventDate = new Date(data.date);
    const now = new Date();
    if (eventDate < now) {
      return res.status(400).json({
        error: 'Invalid date',
        message: 'Event date must be in the future.',
      });
    }

    const userId = req.user!.id;
    const isAdminUser = await getIsAdmin(req as any);

    // Auto-approve only for scoped authority:
    // - platform admins
    // - staff on the selected home team
    // - owner/manager of the selected home team's organization
    let autoApprove = false;
    let creatorRole: 'fan' | 'coach' | 'organizer' = 'fan';
    if (isAdminUser) {
      autoApprove = true;
      creatorRole = 'organizer';
    } else if (data.home_team_id) {
      const homeTeam = await prisma.team.findUnique({
        where: { id: data.home_team_id },
        select: { id: true, organization_id: true },
      });
      if (!homeTeam) {
        return res.status(400).json({ error: 'Home team not found' });
      }

      const teamMembership = await prisma.teamMembership.findFirst({
        where: {
          user_id: userId,
          team_id: data.home_team_id,
          role: { in: ['owner', 'manager', 'coach', 'assistant_coach'] },
          status: 'active',
        },
      });

      let isHomeOrgAdmin = false;
      if (homeTeam.organization_id) {
        const orgMembership = await prisma.organizationMembership.findFirst({
          where: {
            organization_id: homeTeam.organization_id,
            user_id: userId,
            role: { in: ['owner', 'manager'] },
            status: 'active',
          },
        });
        isHomeOrgAdmin = !!orgMembership;
      }

      autoApprove = !!teamMembership || isHomeOrgAdmin;
      if (autoApprove) {
        creatorRole = isHomeOrgAdmin ? 'organizer' : 'coach';
      }
    }

    // Use capacity if provided, otherwise max_attendees (for backward compatibility)
    const capacity = data.max_attendees ?? null;

    // Auto-geocode location if not supplied — do this before the transaction so we don't
    // hold a DB connection open during an external HTTP call.
    let resolvedLat = data.latitude ?? null;
    let resolvedLng = data.longitude ?? null;
    if (data.location && resolvedLat == null && resolvedLng == null) {
      try {
        const coords = await geocodeLocation(data.location);
        if (coords) {
          resolvedLat = coords.latitude;
          resolvedLng = coords.longitude;
          debugLog(`[events] auto-geocoded "${data.location}" → ${resolvedLat}, ${resolvedLng}`);
        }
      } catch (geocodeErr) {
        console.warn('[events] geocoding failed, continuing without coordinates:', geocodeErr);
      }
    }

    let event;
    try {
      // Atomic limit check + create to prevent race condition (fans: 3 pending max)
      event = await prisma.$transaction(async tx => {
        if (!autoApprove) {
          const pendingCount = await tx.event.count({
            where: {
              creator_id: userId,
              approval_status: 'pending',
            },
          });
          if (pendingCount >= 3) {
            throw new AppError(403, 'Event limit reached', {
              errorCode: 'EVENT_LIMIT_EXCEEDED',
              publicMetadata: { limit: 3, current: pendingCount },
            });
          }
        }
        // For host requests, append requester info to description
        let finalDescription = data.description ? stripHtml(data.description) : data.description;
        if (data.event_type === 'host_request' && (data.requested_by || data.requested_email)) {
          const safeRequestedBy = data.requested_by ? stripHtml(data.requested_by) : null;
          const extra = [
            safeRequestedBy ? `Requested by: ${safeRequestedBy}` : null,
            data.requested_email ? `Email: ${data.requested_email}` : null,
            data.venue_address ? `Venue: ${data.venue_address}` : null,
          ]
            .filter(Boolean)
            .join('\n');
          finalDescription = finalDescription ? `${finalDescription}\n\n---\n${extra}` : extra;
        }
        return tx.event.create({
          data: {
            title: data.title,
            date: new Date(data.date),
            timezone: data.timezone ?? null,
            location: data.location,
            latitude: resolvedLat,
            longitude: resolvedLng,
            description: finalDescription,
            event_type: data.event_type,
            linked_league: data.linked_league,
            capacity: capacity,
            max_attendees: data.max_attendees, // Keep for backward compatibility
            contact_info: data.contact_info || data.requested_email,
            banner_url: data.banner_url ?? data.cover_image_url,
            game_id: data.game_id,
            team_id: data.home_team_id || null,
            // Only a real coach/organizer creator (team staff or an org
            // admin — see creatorRole above) can extend the window; a plain
            // fan's is_all_day toggle is silently ignored.
            live_window_hours_after_start:
              data.is_all_day && creatorRole !== 'fan' ? COACH_ALL_DAY_LIVE_WINDOW_HOURS : null,
            creator_id: userId,
            creator_role: creatorRole,
            approval_status: autoApprove ? 'approved' : 'pending',
            status: autoApprove ? 'approved' : 'draft',
            approved_at: autoApprove ? new Date() : null,
          },
        });
      });

      // Submission-received confirmation email stays in parity with the game create flow.
      const [creator, team] = await Promise.all([
        prisma.user.findUnique({
          where: { id: userId },
          select: { display_name: true, email: true },
        }),
        data.home_team_id
          ? prisma.team.findUnique({
              where: { id: data.home_team_id },
              select: { name: true },
            })
          : Promise.resolve(null),
      ]);

      if (creator?.email) {
        sendEventSubmissionReceivedEmail({
          to: creator.email,
          submitterName: creator.display_name || undefined,
          eventTitle: event.title,
          needsApproval: !autoApprove,
        }).catch(err =>
          console.warn('[events] submission receipt email failed:', (err as any)?.message || err)
        );
      }

      if (!autoApprove) {
        void notifyPendingEventReviewers(prisma, {
          reviewId: event.id,
          reviewKind: 'event',
          teamId: data.home_team_id || null,
          requesterName: creator?.display_name || 'VarsityHub User',
          requesterEmail: creator?.email || '',
          eventTitle: event.title,
          eventType: event.event_type || undefined,
          eventDate: event.date,
          eventLocation: event.location || undefined,
          teamName: team?.name || data.linked_league || undefined,
          notes: event.description || undefined,
        }).catch(err => {
          console.warn('[events] pending review email failed:', (err as any)?.message || err);
        });
      }

      // Admin events route through /games and appear as game cards in the feed carousel.
      // No separate text post needed — game cards have full detail pages with stories/polls/RSVP.

      // Get pending count for response (helpful for non-coaches to know their limit status)
      const pendingCount = !autoApprove
        ? await prisma.event.count({
            where: {
              creator_id: userId,
              approval_status: 'pending',
            },
          })
        : null;

      return res.status(201).json({
        ...serializeEvent(event),
        message: autoApprove
          ? 'Event created and published successfully!'
          : 'Your event has been submitted for approval.',
        pending_count: pendingCount,
        limit: !autoApprove ? 3 : null,
      });
    } catch (err: any) {
      if (err instanceof AppError) {
        return res.status(err.statusCode).json(err.toJSON());
      }
      console.error('[events] create error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// Approve event
eventsRouter.get(
  '/:id/approve',
  asyncHandler(async (req: AuthedRequest, res) => handleEventTokenReview(req, res, 'approve'))
);
eventsRouter.post(
  '/:id/approve',
  asyncHandler(async (req: AuthedRequest, res) => handleEventTokenReview(req, res, 'approve'))
);

async function loadAuthorizedEventReview(params: {
  req: AuthedRequest;
  action: 'approve' | 'reject';
}) {
  const { req, action } = params;
  if (!req.user) {
    return { ok: false as const, status: 401, body: { error: 'Unauthorized' } };
  }

  const userId = req.user.id;
  const isAdmin = await getIsAdmin(req as any);
  const eventId = String(req.params.id);
  const event = await prisma.event.findUnique({ where: { id: eventId } });
  if (!event) {
    return { ok: false as const, status: 404, body: { error: 'Event not found' } };
  }

  if (!isAdmin) {
    if (event.creator_id === userId) {
      return {
        ok: false as const,
        status: 403,
        body: { error: 'You cannot review your own event', code: 'SELF_REVIEW_FORBIDDEN' },
      };
    }
    const canReview = event.team_id ? await canManageTeamScoped(userId, event.team_id) : false;
    if (!canReview) {
      return {
        ok: false as const,
        status: 403,
        body: {
          error: `Only coaches of this team or organization admins can ${action} events`,
        },
      };
    }
  }

  return { ok: true as const, userId, eventId, event };
}

function eventReviewErrorMessage(action: 'approve' | 'reject', error: string) {
  if (action === 'approve') {
    if (error === 'Event already approved') return 'This event has already been approved.';
    if (error === 'Event already rejected')
      return 'This event has already been rejected. Cannot approve a rejected event.';
    return 'Can only approve pending events.';
  }

  if (error === 'Event already approved')
    return 'This event has already been approved. Cannot reject an approved event.';
  if (error === 'Event already rejected') return 'This event has already been rejected.';
  return 'Can only reject pending events.';
}

eventsRouter.put(
  '/:id/approve',
  requireVerified as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const review = await loadAuthorizedEventReview({ req, action: 'approve' });
    if (!review.ok) return res.status(review.status).json(review.body);
    const { userId, eventId, event } = review;

    // Delegate state validation, DB write, and notifications to the approval service
    const result = await approveEventService(eventId, userId, prisma);
    if (result.error) {
      const msg = eventReviewErrorMessage('approve', result.error);
      return res.status(result.status || 400).json({ error: msg, code: result.error });
    }

    // Central audit trail — the in-app approve path must land in AdminActivityLog
    // too, not just the email-token path (parity with coach/org/ad/game).
    await logAdminActivityFromReq(
      req,
      'APPROVE_EVENT',
      'event',
      eventId,
      `Approved event: ${event.title || eventId}`
    ).catch(err => console.error('[events] AdminActivityLog write failed:', err));

    return res.json({
      ...serializeEvent(result.event!),
      message: 'Event approved successfully!',
    });
  })
);

// Reject event
const rejectEventSchema = z.object({
  reason: z.string().optional(),
});

eventsRouter.get(
  '/:id/reject',
  asyncHandler(async (req: AuthedRequest, res) => handleEventTokenReview(req, res, 'reject'))
);
eventsRouter.post(
  '/:id/reject',
  asyncHandler(async (req: AuthedRequest, res) => handleEventTokenReview(req, res, 'reject'))
);

eventsRouter.put(
  '/:id/reject',
  requireVerified as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const review = await loadAuthorizedEventReview({ req, action: 'reject' });
    if (!review.ok) return res.status(review.status).json(review.body);
    const { userId, eventId, event } = review;

    const parsed = rejectEventSchema.safeParse(req.body);
    const reason = parsed.success ? parsed.data.reason : undefined;

    // Delegate state validation, DB write, and notifications to the approval service
    const result = await rejectEventService(eventId, userId, prisma, { reason });
    if (result.error) {
      const msg = eventReviewErrorMessage('reject', result.error);
      return res.status(result.status || 400).json({ error: msg, code: result.error });
    }

    // Central audit trail (parity with the approve path + games).
    await logAdminActivityFromReq(
      req,
      'REJECT_EVENT',
      'event',
      eventId,
      `Rejected event: ${event.title || eventId}${reason ? ` — ${reason}` : ''}`
    ).catch(err => console.error('[events] AdminActivityLog write failed:', err));

    return res.json({
      ...serializeEvent(result.event!),
      message: 'Event rejected',
    });
  })
);

// Update event (creator, team owner/coach, or admin)
const updateEventSchema = z.object({
  title: z.string().min(1).optional(),
  date: z.string().optional(),
  location: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  description: z.string().optional(),
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
  linked_league: z.string().optional(),
  max_attendees: z.number().optional(),
  contact_info: z.string().optional(),
  banner_url: z.string().optional(),
  cover_image_url: z.string().optional(),
  // Opponent (updates linked Game when event has game_id)
  opponent: z.string().trim().optional(), // Alias for away_team_name (manual opponent name)
  away_team_id: z.string().trim().nullable().optional(),
  away_team_name: z.string().trim().optional(),
  // See createEventSchema — same boolean-only, server-derived-hours contract.
  is_all_day: z.boolean().optional(),
});

const COACH_EDITABLE_FIELDS = [
  'date',
  'location',
  'latitude',
  'longitude',
  'description',
  'banner_url',
  'opponent',
  'away_team_id',
  'away_team_name',
  'is_all_day',
];

async function loadEditableEventForAction(params: {
  req: AuthedRequest;
  cancelledError: string;
  permissionMessage: string;
}) {
  const { req, cancelledError, permissionMessage } = params;
  const eventId = String(req.params.id);
  const userId = req.user?.id;
  if (!userId) {
    return { ok: false as const, status: 401, body: { error: 'Unauthorized' } };
  }

  const event = await prisma.event.findUnique({
    where: { id: eventId },
    include: {
      game: { select: { id: true, home_team_id: true, away_team_id: true } },
    },
  });

  if (!event) return { ok: false as const, status: 404, body: { error: 'Event not found' } };
  if (event.status === 'cancelled') {
    return { ok: false as const, status: 400, body: { error: cancelledError } };
  }

  const isCreator = event.creator_id === userId;
  const linkedTeamIds: Array<string | null | undefined> = [
    event.game?.home_team_id ?? null,
    event.game?.away_team_id ?? null,
    (event as any).team_id ?? null,
  ];
  const canManageLinkedTeam = linkedTeamIds.some(Boolean)
    ? await canManageAnyTeam(userId, linkedTeamIds)
    : false;
  const isAdmin = await getIsAdmin(req as any);

  if (!isCreator && !canManageLinkedTeam && !isAdmin) {
    return {
      ok: false as const,
      status: 403,
      body: {
        error: 'Permission denied',
        message: permissionMessage,
      },
    };
  }

  return { ok: true as const, eventId, userId, event, isCreator, canManageLinkedTeam, isAdmin };
}

eventsRouter.patch(
  '/:id',
  requireAuth as any,
  requireVerified as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const editable = await loadEditableEventForAction({
      req,
      cancelledError: 'Cannot edit cancelled event',
      permissionMessage:
        'Only the event creator, team staff, or a league admin can edit this event.',
    });
    if (!editable.ok) return res.status(editable.status).json(editable.body);
    const { eventId, userId, event, isCreator, canManageLinkedTeam, isAdmin } = editable;

    const parsed = updateEventSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid payload',
        issues: parsed.error.issues.map(i => ({ path: i.path, message: i.message })),
      });
    }

    const data = parsed.data;
    // Normalize opponent -> away_team_name
    if (data.opponent !== undefined) {
      data.away_team_name = data.opponent;
    }
    if (data.banner_url === undefined && data.cover_image_url !== undefined) {
      data.banner_url = data.cover_image_url;
    }

    // Coaches/team owners can only edit approved events with limited fields
    const isApproved = event.approval_status === 'approved';
    const isCoachOrOwner = (isCreator || canManageLinkedTeam) && !isAdmin;
    if (isCoachOrOwner && isApproved) {
      const disallowed = Object.keys(data).filter(k => !COACH_EDITABLE_FIELDS.includes(k));
      if (disallowed.length > 0) {
        return res.status(403).json({
          error: 'Limited edit scope',
          message:
            'Coaches and team owners can only edit time, location, description, photo, and opponent for approved events.',
          disallowed,
        });
      }
    }

    if (data.date) {
      const eventDate = new Date(data.date);
      const now = new Date();
      if (eventDate < now) {
        return res.status(400).json({
          error: 'Invalid date',
          message: 'Event date must be in the future.',
        });
      }
    }

    const updateData: any = {};
    if (data.title !== undefined) updateData.title = stripHtml(data.title);
    if (data.date !== undefined) updateData.date = new Date(data.date);
    if (data.location !== undefined) updateData.location = data.location;
    if (data.latitude !== undefined) updateData.latitude = data.latitude;
    if (data.longitude !== undefined) updateData.longitude = data.longitude;
    // If location text changed but no new coordinates supplied, auto-geocode the new location
    if (
      data.location !== undefined &&
      data.latitude === undefined &&
      data.longitude === undefined
    ) {
      try {
        const coords = await geocodeLocation(data.location);
        if (coords) {
          updateData.latitude = coords.latitude;
          updateData.longitude = coords.longitude;
          debugLog(
            `[events] auto-geocoded update "${data.location}" → ${coords.latitude}, ${coords.longitude}`
          );
        }
      } catch (geocodeErr) {
        console.warn('[events] geocoding update failed:', geocodeErr);
      }
    }
    if (data.description !== undefined) updateData.description = stripHtml(data.description);
    if (data.event_type !== undefined) updateData.event_type = data.event_type;
    if (data.linked_league !== undefined) updateData.linked_league = data.linked_league;
    if (data.max_attendees !== undefined) {
      updateData.capacity = data.max_attendees;
      updateData.max_attendees = data.max_attendees;
    }
    if (data.contact_info !== undefined) updateData.contact_info = data.contact_info;
    if (data.banner_url !== undefined) updateData.banner_url = data.banner_url;
    if (data.is_all_day !== undefined) {
      updateData.live_window_hours_after_start = data.is_all_day
        ? COACH_ALL_DAY_LIVE_WINDOW_HOURS
        : null;
    }

    const updated = await prisma.event.update({
      where: { id: eventId },
      data: updateData,
    });

    // Date changed → move every RSVP's 12h/1h reminders to the new time.
    if (data.date !== undefined) {
      void rescheduleGameRemindersForEvent(eventId).catch(err =>
        console.warn('[events] reminder reschedule failed:', (err as any)?.message || err)
      );
    }

    // Keep the linked Game in sync when event has game_id. Previously only the
    // opponent synced back, so editing an event's date/location/title left the
    // game (shown on the schedule/feed/map) stale — the reverse direction
    // (PUT /games/:id) already syncs to the event, so this closes the asymmetry.
    if (
      event.game_id &&
      (data.away_team_id !== undefined ||
        data.away_team_name !== undefined ||
        data.opponent !== undefined ||
        data.date !== undefined ||
        data.location !== undefined ||
        data.title !== undefined)
    ) {
      const gameUpdate: any = {};
      if (data.away_team_id !== undefined) gameUpdate.away_team_id = data.away_team_id || null;
      if (data.away_team_name !== undefined)
        gameUpdate.away_team_name = data.away_team_name ?? null;
      if (data.date !== undefined) gameUpdate.date = new Date(data.date);
      if (data.location !== undefined) gameUpdate.location = data.location ?? null;
      if (data.title !== undefined) gameUpdate.title = data.title;
      if (Object.keys(gameUpdate).length > 0) {
        await prisma.game.update({
          where: { id: event.game_id },
          data: gameUpdate,
        });
      }
    }

    // Notify RSVPed users when time, location, or opponent changed
    const changes: string[] = [];
    if (data.date)
      changes.push(
        `Time: ${new Date(data.date).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}`
      );
    if (
      data.location !== undefined ||
      data.latitude !== undefined ||
      data.longitude !== undefined
    ) {
      changes.push(`Location: ${data.location || updated.location || 'Updated'}`);
    }
    if (
      data.away_team_id !== undefined ||
      data.away_team_name !== undefined ||
      data.opponent !== undefined
    ) {
      const opponentName =
        data.away_team_name ?? data.opponent ?? (data.away_team_id ? 'Updated' : 'TBD');
      changes.push(`Opponent: ${opponentName}`);
    }

    if (changes.length > 0) {
      const eventName = updated.title || event.title || 'Event';
      const changeSummary = changes.join('; ');
      const pushBody = `Event Updated: ${eventName} — ${changeSummary}`;

      // Page through RSVPs instead of one giant `take: 10000` fetch. Each
      // batch's pushes are best-effort (.catch logs locally). Bounded
      // memory regardless of event size up to RSVP_FANOUT_LIMIT.
      for await (const batch of iterateEventRsvps(eventId, {
        id: true,
        email: true,
        display_name: true,
      })) {
        for (const rsvp of batch) {
          if (rsvp.user?.id && rsvp.user.id !== userId) {
            sendPushNotification(rsvp.user.id, 'Event Updated', pushBody, {
              type: 'event_updated',
              event_id: eventId,
              screen: 'event-detail',
            }).catch(err => console.warn('[events] Failed to send push:', err));
            if (rsvp.user.email) {
              sendEventUpdatedEmail({
                to: rsvp.user.email,
                attendeeName: rsvp.user.display_name || undefined,
                eventTitle: eventName,
                changes,
                newDate: updated.date,
                newLocation: updated.location,
              }).catch(err =>
                console.warn('[events] event update email failed:', (err as any)?.message || err)
              );
            }
          }
        }
      }
    }

    return res.json({
      ...serializeEvent(updated),
      message: 'Event updated successfully.',
    });
  })
);

// Cancel event (creator or team owner only)
eventsRouter.patch(
  '/:id/cancel',
  requireAuth as any,
  requireVerified as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const editable = await loadEditableEventForAction({
      req,
      cancelledError: 'Event already cancelled',
      permissionMessage:
        'Only the event creator, team staff, or a league admin can cancel this event.',
    });
    if (!editable.ok) return res.status(editable.status).json(editable.body);
    const { eventId, userId, event } = editable;

    // Update event status
    const updated = await prisma.event.update({
      where: { id: eventId },
      data: { status: 'cancelled' },
    });

    const eventDate = event.date instanceof Date ? event.date : new Date(event.date);
    const eventDateStr = eventDate.toLocaleDateString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    const eventTimeStr = eventDate.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
    const eventLocation = [event.location].filter(Boolean).join(', ');

    // Page through RSVPs in batches instead of one `take: 10000` fetch.
    // Push + email are best-effort per RSVP; reminder cancel is
    // correctness-critical and runs through `mustSucceed` so failures
    // surface to Sentry. Each batch's reminder cancellations finish
    // (Promise.all) before we move to the next batch — bounded memory,
    // bounded latency, and a true scan limit at RSVP_FANOUT_LIMIT.
    for await (const batch of iterateEventRsvps(eventId, {
      id: true,
      email: true,
      display_name: true,
      preferences: true,
    })) {
      for (const rsvp of batch) {
        if (rsvp.user?.id && rsvp.user.id !== userId) {
          sendPushNotification(
            rsvp.user.id,
            'Event Cancelled',
            `"${event.title || 'Event'}" has been cancelled.`,
            { type: 'event_cancelled', event_id: eventId, screen: 'event-detail' }
          ).catch(err => console.warn('[events] Failed to send push:', err));

          // Best-effort email fallback using the approved cancellation template.
          if (rsvp.user.email) {
            sendEventCanceledEmail({
              to: rsvp.user.email,
              recipientName: rsvp.user.display_name || 'there',
              eventName: event.title || 'Event',
              eventDate: eventDateStr,
              eventTime: eventTimeStr,
              eventLocation,
              eventId,
            }).catch((err: any) =>
              console.warn('[events] cancel email failed:', err?.message || err)
            );
          }
        }
      }

      // Reminder cancellation is correctness-critical: a missed cancel
      // means the user gets a reminder for a cancelled event. Surface
      // failures to Sentry; let the batch fail loudly rather than
      // silently shipping stale reminders.
      await Promise.all(
        batch.map(rsvp =>
          mustSucceed(
            'events.cancel.reminder-cancel',
            {
              route: '/events/:id/cancel',
              event_id: eventId,
              actor_user_id: userId,
              target_user_id: rsvp.user_id,
            },
            () => cancelGameReminders(eventId, rsvp.user_id)
          )
        )
      );
    }

    return res.json({
      ...serializeEvent(updated),
      message: 'Event cancelled successfully.',
    });
  })
);
