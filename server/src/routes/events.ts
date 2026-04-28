import escapeHtml from 'escape-html';
import { Router } from 'express';
import { z } from 'zod';
import { sendEventCanceledEmail } from '../lib/email.js';
import {
  cancelGameReminders,
  scheduleGameReminders,
  sendPushNotification,
} from '../lib/notifications.js';
import {
  approveEvent as approveEventService,
  rejectEvent as rejectEventService,
} from '../lib/approvalService.js';
import { prisma } from '../lib/prisma.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { getIsAdmin } from '../middleware/requireAdmin.js';
import { requireVerified } from '../middleware/requireVerified.js';
import { requireOnboarded } from '../middleware/requireOnboarded.js';
import { eventCreationLimiter, rsvpLimiter } from '../middleware/rateLimiters.js';
import { haversineDistance, getZipCoordinates } from '../lib/geoUtils.js';
import { geocodeLocation } from '../lib/geocoding.js';
import { mustSucceed } from '../lib/sideEffect.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { registerIdValidation } from '../middleware/validateParams.js';
import { canManageAnyTeam, canManageTeam as canManageTeamScoped } from '../lib/teamAuthorization.js';
import { notifyPendingEventReviewers } from '../lib/eventReviewNotifications.js';
import { consumeReviewToken, verifyReviewToken } from '../lib/reviewTokens.js';

export const eventsRouter = Router();
registerIdValidation(eventsRouter);
const shouldRunStartupBackfills =
  process.env.NODE_ENV !== 'test' && process.env.JEST_WORKER_ID == null;

/** Hard cap on RSVPs we'll fan out to per event update/cancel. Past this we
 *  stop and trust the next surface (re-open the event, manual notification)
 *  to catch up. 50k is ~2 orders of magnitude above today's largest event;
 *  raise if/when production traces show a real ceiling. */
const RSVP_FANOUT_LIMIT = 50_000;
const RSVP_FANOUT_BATCH = 200;

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
  options: { batchSize?: number; cap?: number } = {},
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

function renderEventReviewPage(action: 'approve' | 'reject', eventTitle: string, token: string) {
  const title = action === 'approve' ? 'Approve Event' : 'Reject Event';
  const button = action === 'approve' ? 'Approve Event' : 'Reject Event';
  const color = action === 'approve' ? '#16A34A' : '#DC2626';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:60px auto;padding:20px;text-align:center;">
<h2>${title}?</h2>
<p style="color:#374151;">Event: <strong>${escapeHtml(eventTitle || 'Unknown')}</strong></p>
<form method="POST" action="?token=${encodeURIComponent(token)}">
<button type="submit" style="background:${color};color:#fff;border:none;padding:12px 32px;border-radius:8px;font-size:16px;cursor:pointer;">${button}</button>
</form>
</body></html>`;
}

function renderEventResultPage(title: string, message: string, success: boolean) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:60px auto;padding:20px;text-align:center;">
<h2 style="color:${success ? '#16A34A' : '#DC2626'};">${escapeHtml(title)}</h2>
<p style="color:#374151;">${escapeHtml(message)}</p>
</body></html>`;
}

async function handleEventTokenReview(req: AuthedRequest, res: any, action: 'approve' | 'reject') {
  const eventId = String(req.params.id);
  const token = typeof req.query?.token === 'string' ? req.query.token : undefined;
  const payload = token
    ? verifyReviewToken<{ reviewId: string; reviewKind: string; action: string }>(token)
    : null;
  const expectedAction = action === 'approve' ? 'approve_event' : 'reject_event';

  if (
    !token ||
    !payload ||
    payload.reviewId !== eventId ||
    payload.reviewKind !== 'event' ||
    payload.action !== expectedAction
  ) {
    return res
      .status(401)
      .send(renderEventResultPage('Invalid Link', `This ${action} link is invalid or has expired.`, false));
  }

  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { title: true },
  });
  if (!event) {
    return res.status(404).send(renderEventResultPage('Not Found', 'Event not found.', false));
  }

  if (req.method === 'GET') {
    return res.send(renderEventReviewPage(action, event.title || 'Unknown', token));
  }

  const consumeResult = await consumeReviewToken(token, payload);
  if (consumeResult === 'already_used') {
    return res
      .status(409)
      .send(renderEventResultPage('Link Already Used', `This ${action} link has already been used.`, false));
  }
  if (consumeResult === 'store_unavailable') {
    return res
      .status(503)
      .send(renderEventResultPage('Temporarily Unavailable', `This ${action} link cannot be completed right now. Please use the admin dashboard instead.`, false));
  }

  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : undefined;
  const reviewerUserId = req.user?.id ?? null;
  const result =
    action === 'approve'
      ? await approveEventService(eventId, reviewerUserId, prisma)
      : await rejectEventService(eventId, reviewerUserId, prisma, { reason });
  if (result.error) {
    return res.status(result.status || 400).send(renderEventResultPage('Error', result.error, false));
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
// Fire-and-forget — safe to run repeatedly (skips rows already populated).
if (shouldRunStartupBackfills) {
  void (async () => {
    try {
      const missing = await prisma.event.findMany({
        where: { location: { not: null }, latitude: null },
        select: { id: true, location: true },
        take: 1000,
      });
      if (missing.length === 0) return;
      console.log(`[events] backfill: geocoding ${missing.length} events without coordinates`);
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
      console.log(
        `[events] backfill: done — ${success} geocoded, ${failed} failed out of ${missing.length}`
      );
    } catch (err) {
      console.warn('[events] backfill failed:', err);
    }
  })();
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

eventsRouter.get('/', asyncHandler(async (req, res) => {
  try {
    const status = String(req.query.status || '').trim();
    const includeCancelled = String(req.query.include_cancelled || '').toLowerCase() === 'true';
    const approvalStatus = String(req.query.approval_status || '').trim();
    const eventType = String(req.query.event_type || '').trim();
    const search = String(req.query.q || '').trim();
    const sort = String(req.query.sort || '').trim();
    const limitRaw = Number.parseInt(String(req.query.limit ?? ''), 10);
    // v1.0.2 pass 12: default to 100 when no limit is supplied so the query is always bounded.
    // Previous `undefined` fallback let callers omit `limit` and get an unbounded scan on Event.
    const take = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 100;

    const where: any = {};
    if (status) where.status = status;
    else if (!includeCancelled) where.status = { not: 'cancelled' }; // Exclude cancelled by default; ?include_cancelled=true for admin views
    // Only admins can filter by approval_status — public users always see approved only
    const isAdminUser = (req as any).user?.id ? await getIsAdmin(req as any) : false;
    if (approvalStatus && isAdminUser) where.approval_status = approvalStatus;
    else where.approval_status = 'approved';
    if (eventType) where.event_type = eventType;
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
        { location: { contains: search, mode: 'insensitive' } },
      ];
    }

    // v1.0.2: auto-archive window is 3 days after event date (was "hide anything past").
    // Events remain visible in listings for 72h after they happen (post-game photos, recap)
    // and drop off after. `include_past=true` still returns everything for admin/team views.
    if (!req.query.include_past && !approvalStatus) {
      const EVENT_ARCHIVE_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
      const archiveCutoff = new Date(Date.now() - EVENT_ARCHIVE_WINDOW_MS);
      where.date = { gte: archiveCutoff };
    }

    const orderBy = sort === 'date' ? { date: 'asc' as const } : { created_at: 'desc' as const };

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

    // Over-fetch when location filtering to compensate for filtered-out events
    const fetchLimit = userCoords ? Math.min((take ?? 100) * 3, 300) : take;
    let events = await prisma.event.findMany({
      where,
      orderBy,
      take: fetchLimit,
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

    res.json(
      events.map(event => serializeEvent(event, { includeGame: true }))
    );
  } catch (err) {
    console.error('[events] GET / error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}));

// List current user's RSVPs with event basics
eventsRouter.get('/my-rsvps', requireAuth as any, asyncHandler(async (req: AuthedRequest, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const rows = await prisma.eventRsvp.findMany({
      where: { user_id: req.user.id },
      orderBy: { created_at: 'desc' },
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
      take: 100,
    });
    const list = rows.map(r => ({
      id: r.id,
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      event: r.event ? serializeEvent(r.event, { includeGame: true }) : null,
    }));
    return res.json(list);
  } catch (err) {
    console.error('[events] GET /my-rsvps error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}));

// List current user's created events (for fans to track their submissions)
eventsRouter.get('/my-events', requireAuth as any, asyncHandler(async (req: AuthedRequest, res) => {
  try {
    // req.user is guaranteed by requireAuth middleware
    const events = await prisma.event.findMany({
      where: { creator_id: req.user!.id },
      orderBy: { created_at: 'desc' },
      take: 50,
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
      },
    });
    return res.json(events);
  } catch (err) {
    console.error('[events] GET /my-events error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}));

// Get pending events for approval (admins & coaches only) - MUST be before /:id to avoid "pending" matching as id
eventsRouter.get(
  '/pending',
  requireAuth as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
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
            take: 500,
          }),
          prisma.organizationMembership.findMany({
            where: {
              user_id: userId,
              role: { in: ['owner', 'manager'] },
              status: 'active',
            },
            select: { organization_id: true },
            take: 500,
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

      const events = await prisma.event.findMany({
        where,
        orderBy: { created_at: 'desc' },
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
        take: 100,
      });

      return res.json(
        events.map(event => serializeEvent(event, { includeGame: true, includeCreator: true }))
      );
    } catch (err) {
      console.error('[events] GET /pending error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
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

    // Non-approved events only visible to creator or admins
    if (event.approval_status !== 'approved') {
      const isCreator = req.user && event.creator_id === req.user.id;
      const isAdmin = req.user ? await getIsAdmin(req as any) : false;
      if (!isCreator && !isAdmin) {
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
        team_id: true,
        creator_id: true,
        game: { select: { id: true, home_team_id: true, away_team_id: true } },
      },
    });
    if (!event) return res.status(404).json({ error: 'Not found' });

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

    if (linkedTeamIds.length > 0 && event.creator_id !== req.user.id) {
      const [teamMembership, teamFollow, orgAdminCheck, isAdminUser] =
        await Promise.all([
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
          message:
            'You must be a member or follower of this team to RSVP to this event.',
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
          console.log(`[events] auto-geocoded "${data.location}" → ${resolvedLat}, ${resolvedLng}`);
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
            throw Object.assign(new Error('EVENT_LIMIT_EXCEEDED'), {
              status: 403,
              body: {
                error: 'Event limit reached',
                message:
                  "You've reached your limit of 3 pending events. Wait for one to be approved or rejected before submitting another.",
                code: 'EVENT_LIMIT_EXCEEDED',
                limit: 3,
                current: pendingCount,
              },
            });
          }
        }
        // For host requests, append requester info to description
        let finalDescription = data.description;
        if (data.event_type === 'host_request' && (data.requested_by || data.requested_email)) {
          const extra = [
            data.requested_by ? `Requested by: ${data.requested_by}` : null,
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
            location: data.location,
            latitude: resolvedLat,
            longitude: resolvedLng,
            description: finalDescription,
            event_type: data.event_type,
            linked_league: data.linked_league,
            capacity: capacity,
            max_attendees: data.max_attendees, // Keep for backward compatibility
            contact_info: data.contact_info || data.requested_email,
            banner_url: data.banner_url,
            game_id: data.game_id,
            team_id: data.home_team_id || null,
            creator_id: userId,
            creator_role: creatorRole,
            approval_status: autoApprove ? 'approved' : 'pending',
            status: autoApprove ? 'approved' : 'draft',
            approved_at: autoApprove ? new Date() : null,
          },
        });
      });

      // Submission-received confirmation email removed — non-mandatory transactional email

      if (!autoApprove) {
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
        }).catch((err) => {
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
      if (err?.status && err?.body) {
        return res.status(err.status).json(err.body);
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
eventsRouter.put(
  '/:id/approve',
  requireVerified as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    // req.user is guaranteed by requireVerified middleware
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    const userId = req.user.id;
    const isAdmin = await getIsAdmin(req as any);

    const eventId = String(req.params.id);
    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event) return res.status(404).json({ error: 'Event not found' });

    // Scope approval: must be admin, or coach/admin of the event's team/org
    if (!isAdmin) {
      const canApprove = event.team_id
        ? await canManageTeamScoped(userId, event.team_id)
        : false;
      if (!canApprove) {
        return res
          .status(403)
          .json({ error: 'Only coaches of this team or organization admins can approve events' });
      }
    }

    // Delegate state validation, DB write, and notifications to the approval service
    const result = await approveEventService(eventId, userId, prisma);
    if (result.error) {
      const msg =
        result.error === 'Event already approved'
          ? 'This event has already been approved.'
          : result.error === 'Event already rejected'
            ? 'This event has already been rejected. Cannot approve a rejected event.'
            : 'Can only approve pending events.';
      return res.status(result.status || 400).json({ error: msg, code: result.error });
    }

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
    // req.user is guaranteed by requireVerified middleware
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    const userId = req.user.id;
    const isAdmin = await getIsAdmin(req as any);

    const eventId = String(req.params.id);
    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event) return res.status(404).json({ error: 'Event not found' });

    // Scope rejection: must be admin, or coach/admin of the event's team/org
    if (!isAdmin) {
      const canReject = event.team_id
        ? await canManageTeamScoped(userId, event.team_id)
        : false;
      if (!canReject) {
        return res
          .status(403)
          .json({ error: 'Only coaches of this team or organization admins can reject events' });
      }
    }

    const parsed = rejectEventSchema.safeParse(req.body);
    const reason = parsed.success ? parsed.data.reason : undefined;

    // Delegate state validation, DB write, and notifications to the approval service
    const result = await rejectEventService(eventId, userId, prisma, { reason });
    if (result.error) {
      const msg =
        result.error === 'Event already approved'
          ? 'This event has already been approved. Cannot reject an approved event.'
          : result.error === 'Event already rejected'
            ? 'This event has already been rejected.'
            : 'Can only reject pending events.';
      return res.status(result.status || 400).json({ error: msg, code: result.error });
    }

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
  // Opponent (updates linked Game when event has game_id)
  opponent: z.string().trim().optional(), // Alias for away_team_name (manual opponent name)
  away_team_id: z.string().trim().nullable().optional(),
  away_team_name: z.string().trim().optional(),
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
];

eventsRouter.patch(
  '/:id',
  requireAuth as any,
  requireVerified as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const eventId = String(req.params.id);
      const userId = req.user!.id;

      const event = await prisma.event.findUnique({
        where: { id: eventId },
        include: {
          game: { select: { id: true, home_team_id: true, away_team_id: true } },
        },
      });

      if (!event) return res.status(404).json({ error: 'Event not found' });
      if (event.status === 'cancelled') {
        return res.status(400).json({ error: 'Cannot edit cancelled event' });
      }

      const isCreator = event.creator_id === userId;
      let isTeamOwner = false;
      if (event.game?.home_team_id || event.game?.away_team_id) {
        const teamIds = [event.game.home_team_id, event.game.away_team_id].filter(
          Boolean
        ) as string[];
        const ownership = await prisma.teamMembership.findFirst({
          where: {
            team_id: { in: teamIds },
            user_id: userId,
            role: { in: ['owner', 'manager', 'coach', 'assistant_coach'] },
            status: 'active',
          },
        });
        isTeamOwner = !!ownership;
      }
      const isAdmin = await getIsAdmin(req as any);

      if (!isCreator && !isTeamOwner && !isAdmin) {
        return res.status(403).json({
          error: 'Permission denied',
          message: 'Only the event creator, team owner, or admin can edit this event.',
        });
      }

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

      // Coaches/team owners can only edit approved events with limited fields
      const isApproved = event.approval_status === 'approved';
      const isCoachOrOwner = (isCreator || isTeamOwner) && !isAdmin;
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
      if (data.title !== undefined) updateData.title = data.title;
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
            console.log(
              `[events] auto-geocoded update "${data.location}" → ${coords.latitude}, ${coords.longitude}`
            );
          }
        } catch (geocodeErr) {
          console.warn('[events] geocoding update failed:', geocodeErr);
        }
      }
      if (data.description !== undefined) updateData.description = data.description;
      if (data.event_type !== undefined) updateData.event_type = data.event_type;
      if (data.linked_league !== undefined) updateData.linked_league = data.linked_league;
      if (data.max_attendees !== undefined) {
        updateData.capacity = data.max_attendees;
        updateData.max_attendees = data.max_attendees;
      }
      if (data.contact_info !== undefined) updateData.contact_info = data.contact_info;
      if (data.banner_url !== undefined) updateData.banner_url = data.banner_url;

      const updated = await prisma.event.update({
        where: { id: eventId },
        data: updateData,
      });

      // Update opponent on linked Game when event has game_id
      if (
        event.game_id &&
        (data.away_team_id !== undefined ||
          data.away_team_name !== undefined ||
          data.opponent !== undefined)
      ) {
        const gameUpdate: any = {};
        if (data.away_team_id !== undefined) gameUpdate.away_team_id = data.away_team_id || null;
        if (data.away_team_name !== undefined)
          gameUpdate.away_team_name = data.away_team_name ?? null;
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
            }
          }
        }
      }

      return res.json({
        ...serializeEvent(updated),
        message: 'Event updated successfully.',
      });
    } catch (err) {
      console.error('[events] PATCH /:id error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// Cancel event (creator or team owner only)
eventsRouter.patch(
  '/:id/cancel',
  requireAuth as any,
  requireVerified as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const eventId = String(req.params.id);
      const userId = req.user!.id;

      const event = await prisma.event.findUnique({
        where: { id: eventId },
        include: {
          game: { select: { id: true, home_team_id: true, away_team_id: true } },
        },
      });

      if (!event) return res.status(404).json({ error: 'Event not found' });
      if (event.status === 'cancelled') {
        return res.status(400).json({ error: 'Event already cancelled' });
      }

      // Permission: creator OR any team staff (including org admin fallback)
      // for any team linked to this event. Previously this check accepted only
      // role='owner' and skipped the org-admin fallback — league owners
      // couldn't cancel events in their own league, and team coaches couldn't
      // cancel events they scheduled. `canManageAnyTeam` consolidates the
      // same rule used by team update / game approval / chat creation.
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
        return res.status(403).json({
          error: 'Permission denied',
          message:
            'Only the event creator, team staff, or a league admin can cancel this event.',
        });
      }

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
    } catch (err) {
      console.error('[events] PATCH /:id/cancel error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);
