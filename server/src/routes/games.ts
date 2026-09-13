import { storyRequestIdentity, recoverStoryRequest } from '../lib/storyRequestRecovery.js';
import { assertReadyMediaForOwner } from '../lib/mediaUploadOwnership.js';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { logAdminActivity } from '../lib/adminActivityLogger.js';
import { MEDIA_URL_MESSAGE, isAllowedAssetUrl } from '../lib/mediaHosts.js';
import { renderReviewPage, renderResultPage, renderFinalStatePage } from '../lib/reviewPage.js';
import { cacheDelPattern, cacheGet, cacheSet } from '../lib/cache.js';
import { debugLog } from '../lib/debugLog.js';
import {
  sendEventApprovedEmail,
  sendEventCanceledEmail,
  sendEventDeniedEmail,
  sendEventSubmissionReceivedEmail,
  sendEventUpdatedEmail,
} from '../lib/email.js';
import {
  getPendingEventReviewRecipients,
  notifyPendingEventReviewers,
} from '../lib/eventReviewNotifications.js';
import { sendError } from '../lib/http/sendError.js';
import { detectMediaType, resolvePreviewUrl } from '../lib/mediaUtils.js';
import { prisma } from '../lib/prisma.js';
import {
  buildPrivateTeamGameVisibilityWhere,
  getBlockedUserIds,
  getExcludedPrivateAuthorIds,
  getExcludedPrivateTeamIds,
  getRequestBlockedCache,
  mergeAndWhere,
} from '../lib/privacyUtils.js';
import { consumeReviewToken, verifyReviewToken } from '../lib/reviewTokens.js';
import { stripHtml } from '../lib/sanitizeHtml.js';
import { GAME_SUMMARY_SELECT } from '../lib/serializeGame.js';
import { venuePhotoFor } from '../lib/proSchedule/venuePhotos.js';
import {
  creatorSideTeamIds,
  deriveGameApproval,
  isGamePubliclyVisible,
} from '../lib/gameApproval.js';
import { formatEventTime } from '../lib/formatEventTime.js';
import {
  canManageAnyTeam,
  canManageTeam as canManageTeamScoped,
  ORG_ADMIN_ROLES,
  TEAM_STAFF_ROLES,
} from '../lib/teamAuthorization.js';
import { buildBinaryVoteSummary } from '../lib/voteSummary.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { authMiddleware, type AuthedRequest } from '../middleware/auth.js';
import {
  gameCreationLimiter,
  storyCreationLimiter,
  voteLimiter,
} from '../middleware/rateLimiters.js';
import {
  serializeLiveWindow,
  verifyStoryPostingPermission,
  viewerHasPostedOnEntity,
} from '../lib/geofencing.js';
import { getZipCoordinates } from '../lib/geoUtils.js';
import { geocodeLocation } from '../lib/geocoding.js';
import { getIsAdmin, isVerifiedAdminUser, requireAdmin } from '../middleware/requireAdmin.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireOnboarded } from '../middleware/requireOnboarded.js';
import { requireVerified } from '../middleware/requireVerified.js';
import { registerIdValidation } from '../middleware/validateParams.js';

// ---------------------------------------------------------------------------
// Game media / stories — inlined to keep all game-related logic in one file
// ---------------------------------------------------------------------------

const isVideoUrl = (url?: string | null) => {
  if (!url) return false;
  const sanitized = url.split('?')[0].toLowerCase();
  return ['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv'].some(ext => sanitized.endsWith(ext));
};

export const serializeMedia = (story: any) => {
  const isVideo = isVideoUrl(story.media_url);
  return {
    id: story.id,
    url: story.media_url,
    kind: isVideo ? 'video' : 'photo',
    // Prefer the generated poster (works for R2 videos); fall back to the
    // Cloudinary-derived preview for Cloudinary-hosted videos. resolvePreviewUrl
    // is the single seam every serializer must go through (lib/mediaUtils.ts):
    // it prefers the stored poster, then falls back to the Cloudinary
    // derivation, so preview behavior stays correct as media migrates off
    // Cloudinary. Requires poster_url in the story select below.
    thumbnail_url: isVideo ? resolvePreviewUrl(story) : null,
    created_at:
      story.created_at instanceof Date ? story.created_at.toISOString() : story.created_at,
    caption: story.caption ?? null,
    user_id: story.user_id ?? null,
    expires_at:
      story.expires_at instanceof Date
        ? story.expires_at.toISOString()
        : (story.expires_at ?? null),
  };
};

// In-memory dedupe so concurrent fetches don't kick off duplicate poster
// generations for the same story (per replica; good enough — once poster_url is
// persisted, later reads skip it entirely).
const posterGenInFlight = new Set<string>();

/**
 * Fire-and-forget: generate + persist a still poster for a video story that
 * doesn't have one yet. Uses Cloudinary upload-by-URL (server-side, so it
 * reaches every client regardless of app build, and backfills already-posted
 * videos the first time the story list is viewed). Never throws.
 */
export function ensureStoryPoster(
  p: StoryDeps['prisma'],
  story: { id: string; media_url?: string | null; poster_url?: string | null }
): void {
  if (!story?.id || story.poster_url || !isVideoUrl(story.media_url)) return;
  if (posterGenInFlight.has(story.id)) return;
  posterGenInFlight.add(story.id);
  void (async () => {
    try {
      const { generateVideoPosterFromUrl } = await import('../lib/cloudinary.js');
      const poster = await generateVideoPosterFromUrl(String(story.media_url));
      if (poster) {
        await p.story.update({ where: { id: story.id }, data: { poster_url: poster } });
      }
    } catch (err: any) {
      console.warn('[stories] poster generation failed', story.id, err?.message || err);
    } finally {
      posterGenInFlight.delete(story.id);
    }
  })();
}

export const isMissingStoryLocationColumnError = (error: any): boolean => {
  if (!error || error.code !== 'P2022') return false;
  const modelName = String(error?.meta?.modelName ?? '');
  const column = String(error?.meta?.column ?? '');
  return modelName === 'Story' && (column === 'Story.lat' || column === 'Story.lng');
};

const locationSchema = z
  .object({
    lat: z.number().nullable().optional(),
    lng: z.number().nullable().optional(),
    source: z.enum(['device', 'places', 'zip', 'derived']).nullable().optional(),
  })
  .optional();

export const storySchema = z.object({
  client_request_id: z
    .string()
    .min(16)
    .max(128)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .optional(),
  media_url: z
    .string()
    .url({ message: 'media_url must be a valid URL' })
    .refine(isAllowedAssetUrl, MEDIA_URL_MESSAGE),
  // First-frame poster uploaded alongside an R2-hosted video (mirrors the post
  // create path). R2 stores bytes verbatim, so getVideoPreviewUrl can't derive
  // a preview from the media_url — without this the story renders as a black
  // tile until the lazy server-side backfill lands on a later fetch.
  poster_url: z
    .string()
    .url({ message: 'poster_url must be a valid URL' })
    .refine(isAllowedAssetUrl, MEDIA_URL_MESSAGE)
    .optional(),
  caption: z.string().max(500).optional(),
  location: locationSchema,
});

type StoryDeps = { prisma: typeof import('../lib/prisma.js').prisma };

async function canViewGameMedia(
  prismaClient: StoryDeps['prisma'],
  gameId: string,
  req: AuthedRequest
): Promise<{ allowed: boolean; exists: boolean }> {
  const game = await prismaClient.game.findUnique({
    where: { id: gameId },
    select: {
      id: true,
      approval_status: true,
      opponent_approval_status: true,
      date: true,
      created_by_id: true,
      home_team_id: true,
      away_team_id: true,
    } as any,
  });
  if (!game) return { allowed: false, exists: false };
  // Opponent-pending/declined UPCOMING games are not public media — fall through
  // to the privileged-viewer checks below (creator/admin/team/org staff).
  if (isGamePubliclyVisible(game as any)) return { allowed: true, exists: true };

  const viewerId = req.user?.id ?? null;
  if (!viewerId) return { allowed: false, exists: true };
  if ((game as any).created_by_id && (game as any).created_by_id === viewerId)
    return { allowed: true, exists: true };
  if (await getIsAdmin(req as any)) return { allowed: true, exists: true };

  const teamIds = [(game as any).home_team_id, (game as any).away_team_id].filter(
    Boolean
  ) as string[];
  if (teamIds.length === 0) return { allowed: false, exists: true };

  const teamMembership = await prismaClient.teamMembership.findFirst({
    where: {
      user_id: viewerId,
      team_id: { in: teamIds },
      role: { in: ['owner', 'manager', 'coach', 'assistant_coach'] },
      status: 'active',
    },
    select: { id: true },
  });
  if (teamMembership) return { allowed: true, exists: true };

  const teams = await prismaClient.team.findMany({
    where: { id: { in: teamIds } },
    select: { organization_id: true },
    take: teamIds.length,
  });
  const organizationIds = teams.map(team => team.organization_id).filter(Boolean) as string[];
  if (organizationIds.length === 0) return { allowed: false, exists: true };

  const orgMembership = await prismaClient.organizationMembership.findFirst({
    where: {
      user_id: viewerId,
      organization_id: { in: organizationIds },
      role: { in: ['owner', 'manager'] },
      status: 'active',
    },
    select: { id: true },
  });
  return { allowed: !!orgMembership, exists: true };
}

// Exported for tests: the prisma dependency is already injected, so the story
// list/order contract can be pinned with a stub client and no database.
export const makeListMediaHandler = ({ prisma: p }: StoryDeps) =>
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id);
    try {
      const visibility = await canViewGameMedia(p, id, req as AuthedRequest);
      if (!visibility.exists) return res.status(404).json({ error: 'Not found' });
      if (!visibility.allowed) return res.status(404).json({ error: 'Not found' });

      void (async () => {
        try {
          const expired = await p.story.findMany({
            where: { game_id: id, expires_at: { lt: new Date() } },
            select: { id: true, media_url: true },
            take: 200,
          });
          if (expired.length === 0) return;

          await p.story.deleteMany({ where: { id: { in: expired.map(s => s.id) } } });

          const { extractCloudinaryPublicId, destroyCloudinaryAsset } =
            await import('../lib/cloudinary.js');
          for (const story of expired) {
            if (!story.media_url) continue;
            const parsed = extractCloudinaryPublicId(story.media_url);
            if (!parsed) continue;
            destroyCloudinaryAsset(parsed.publicId, parsed.resourceType).catch(err =>
              console.warn(
                '[gameStories] Cloudinary destroy failed for expired story',
                story.id,
                err?.message || err
              )
            );
          }
        } catch (err: any) {
          console.warn('[gameStories] lazy expired-cleanup failed:', err?.message || err);
        }
      })();

      // Select the newest 50 (the window a viewer cares about), then replay
      // them oldest-first: stories walk through the day from the beginning to
      // the end, like every other story product. Ordering is fixed here rather
      // than at the render layer because the stories rail and StoriesViewer
      // consume this one array and the viewer indexes into it by position — a
      // render-layer reverse in the rail would open the viewer on the wrong
      // story. Keeping `desc` for the `take` (rather than ordering `asc`) means
      // a game with >50 stories still returns the most recent 50, not the
      // oldest 50.
      const items = await p.story.findMany({
        where: { game_id: id },
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
      // Lazy poster backfill: any video story still missing a poster gets one
      // generated in the background; it appears on the next fetch. Then replay
      // oldest-first (owner rule 2026-07-16) — beginning of day to end.
      for (const s of items) ensureStoryPoster(p, s);
      return res.json(items.reverse().map(serializeMedia));
    } catch (error: any) {
      if (isMissingStoryLocationColumnError(error)) {
        console.warn('[stories] Story location columns missing, falling back to legacy query');
        if (!/^[a-zA-Z0-9_-]+$/.test(id) || id.length > 100) {
          return res.status(400).json({ error: 'Invalid game id' });
        }
        try {
          const items = await p.$queryRaw<
            Array<{
              id: string;
              media_url: string;
              created_at: Date | string;
              caption: string | null;
              user_id: string | null;
            }>
          >`
            SELECT "id", "media_url", "created_at", "caption", "user_id"
            FROM "Story"
            WHERE "game_id" = ${id}
            ORDER BY "created_at" DESC
            LIMIT 50
          `;
          // Same newest-50 window, replayed oldest-first (mirrors the Prisma path).
          return res.json(items.reverse().map(serializeMedia));
        } catch (fallbackError) {
          console.error('[stories] Legacy fallback query failed:', fallbackError);
          return res.status(500).json({ error: 'Failed to load game media' });
        }
      }
      console.error('[stories] Failed to list game media:', error);
      return res.status(500).json({ error: 'Failed to load game media' });
    }
  });

const makeCreateStoryHandler = ({ prisma: p }: StoryDeps) =>
  asyncHandler(async (req: AuthedRequest, res: Response) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const id = String(req.params.id);
    const parsed = storySchema.safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' });
    const requestIdentity = storyRequestIdentity(req.user.id, 'game:' + id, parsed.data);
    const replayStory = async () => {
      try {
        const existing = await recoverStoryRequest(p, requestIdentity, req.user!.id);
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

    {
      const game = await p.game.findUnique({
        where: { id },
        select: {
          id: true,
          description: true,
          home_team_id: true,
          away_team_id: true,
          events: {
            orderBy: { date: 'asc' },
            take: 1,
            select: { id: true, date: true, latitude: true, longitude: true, location: true },
          },
        },
      });

      const isAdmin = await getIsAdmin(req as any);

      if (!isAdmin && game?.events && game.events.length > 0) {
        const event = game.events[0];
        const location = parsed.data.location;
        const hasDeviceOriginLocation =
          location?.source === 'device' &&
          typeof location?.lat === 'number' &&
          typeof location?.lng === 'number';

        // Only device-origin GPS may satisfy the venue geofence (anti-spoof:
        // zip-derived coords must never count). Pass null otherwise and let
        // verifyStoryPostingPermission decide — a first story still requires
        // device location at the venue, but users holding a 7-day posting
        // unlock (already posted to this event page) may post without it.
        const lat = hasDeviceOriginLocation ? (location?.lat ?? null) : null;
        const lng = hasDeviceOriginLocation ? (location?.lng ?? null) : null;

        const ipAddr =
          (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
          req.socket.remoteAddress ||
          null;
        const verification = await verifyStoryPostingPermission(
          event.id,
          req.user.id,
          lat,
          lng,
          ipAddr
        );

        if (!verification.allowed) {
          return res.status(403).json({
            error: verification.code || 'LOCATION_VERIFICATION_FAILED',
            message: verification.reason,
            distance: verification.distance,
          });
        }
      }
    }

    const location = parsed.data.location;
    const lat = location?.lat ?? null;
    const lng = location?.lng ?? null;

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
      game_id: id,
      user_id: req.user.id,
      media_url: parsed.data.media_url,
      poster_url: verifiedMedia?.poster_url ?? parsed.data.poster_url ?? undefined,
      caption: parsed.data.caption ? stripHtml(parsed.data.caption) : undefined,
    };
    if (typeof lat === 'number') createData.lat = lat;
    if (typeof lng === 'number') createData.lng = lng;

    let story;
    try {
      story = await p.story.create({ data: createData });
    } catch (error: any) {
      if (error?.code === 'P2002' && (await replayStory())) return;
      if (!isMissingStoryLocationColumnError(error)) {
        console.error('[stories] Failed to create story:', error);
        return res.status(500).json({ error: 'Failed to create story' });
      }
      console.warn('[stories] Story location columns missing, retrying without lat/lng');
      const { lat: _lat, lng: _lng, ...withoutCoords } = createData;
      try {
        story = await p.story.create({ data: withoutCoords });
      } catch (fallbackError) {
        console.error('[stories] Failed to create story in fallback mode:', fallbackError);
        return res.status(500).json({ error: 'Failed to create story' });
      }
    }

    // Kick off poster generation for video stories (fire-and-forget; the poster
    // appears on the next story-list fetch). Never blocks or fails the create.
    ensureStoryPoster(p, story);

    try {
      const game = await p.game.findUnique({
        where: { id },
        select: { id: true, title: true, created_by_id: true },
      });
      if (game?.created_by_id && game.created_by_id !== req.user.id) {
        const poster = await p.user.findUnique({
          where: { id: req.user.id },
          select: { display_name: true },
        });
        const posterName = poster?.display_name || 'Someone';

        await p.notification.create({
          data: {
            user_id: game.created_by_id,
            actor_id: req.user.id,
            type: 'GAME_STORY_ADDED',
            meta: { game_id: id, game_title: game.title, poster_name: posterName },
          },
        });

        const { sendPushNotification } = await import('../lib/notifications.js');
        void sendPushNotification(
          game.created_by_id,
          `New story on ${game.title}`,
          `${posterName} added a story to your game`,
          { type: 'game_story_added', game_id: id, screen: 'game-detail' }
        ).catch(pushErr => {
          console.warn('[stories] Failed to send game story push:', pushErr);
        });
      }
    } catch (notifErr) {
      console.error('[stories] Failed to send game story notification:', notifErr);
    }

    return res.status(201).json(story);
  });

export const gamesRouter = Router();
registerIdValidation(gamesRouter);

// Fields a non-admin (creator or coach) may change on an ALREADY-APPROVED game.
// Mirrors events.ts COACH_EDITABLE_FIELDS: logistics + opponent, never the
// identity/moderation-sensitive fields (title stays admin-only once approved).
// Team-id changes are allowed here but re-trigger opponent consent in PUT /:id.
const GAME_COACH_EDITABLE_FIELDS: string[] = [
  'date',
  'location',
  'latitude',
  'longitude',
  'venue_address',
  'venue_place_id',
  'venue_lat',
  'venue_lng',
  'description',
  'banner_url',
  'cover_image_url',
  'appearance',
  'home_team',
  'away_team',
  'home_team_id',
  'away_team_id',
  'away_team_name',
  'is_neutral',
  'expected_attendance',
  'donation_goal',
  'watch_location',
  'watch_location_lat',
  'watch_location_lng',
  'watch_location_place_id',
  'destination',
  'event_type',
];

async function invalidateGamesListCache(): Promise<void> {
  await cacheDelPattern('games:*');
}

function renderGameReviewPage(action: 'approve' | 'reject', title: string, token?: string) {
  return renderReviewPage({ action, entityLabel: 'Game', entityName: title, token });
}

function renderGameResultPage(title: string, message: string, success: boolean) {
  return renderResultPage(title, message, success);
}

function renderGameFinalStatePage(
  game: { title: string | null; approval_status: string | null },
  action: 'approve' | 'reject'
) {
  return renderFinalStatePage({
    approvalStatus: game.approval_status,
    entityName: game.title,
    entityNoun: 'game',
    action,
  });
}

async function applyGameApprovalDecision(
  id: string,
  approvalStatus: 'approved' | 'rejected',
  actingUserId: string | null,
  reason?: string | null
) {
  const isApproved = approvalStatus === 'approved';
  const approvalAppliedAt = isApproved ? new Date() : null;

  // IDOR self-review guard, in the SHARED helper so BOTH the in-app PUT route
  // and the email-token path (handleGameTokenReview) are covered — mirrors the
  // guard living inside approveEvent/rejectEvent. The PUT route also guards, but
  // the token path called this helper directly with no self-review check.
  if (actingUserId) {
    const existing = await prisma.game.findUnique({
      where: { id },
      select: { created_by_id: true },
    });
    if (existing?.created_by_id && existing.created_by_id === actingUserId) {
      return {
        error: 'You cannot approve or reject a game you created',
        status: 403 as const,
      };
    }
  }

  const updatedGame = await prisma.$transaction(async tx => {
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
    return {
      error: 'Game approval status changed before this action completed',
      status: 409 as const,
    };
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
      // Render in the game's captured timezone (falls back to zone-less when
      // null) — the same helper the cancellation email uses. Previously the
      // approval email formatted without a timezone, so it showed the server's
      // UTC time instead of the event's local time.
      const eventWhen = eventDate ? formatEventTime(eventDate, updatedGame.timezone) : null;

      const { sendPushNotification } = await import('../lib/notifications.js');
      if (approvalStatus === 'approved') {
        sendPushNotification(
          updatedGame.created_by_id,
          'Event Approved!',
          `Your event "${updatedGame.title}" has been approved and is now live.`,
          { type: 'event_approved', game_id: id, event_id: eventId }
        ).catch(err => {
          console.warn('[games] event approved push failed:', err);
        });
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
            eventDate: eventWhen?.dateStr,
            eventTime: eventWhen?.timeStr,
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
        ).catch(err => {
          console.warn('[games] event rejected push failed:', err);
        });
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
            eventDate: eventWhen?.dateStr,
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

async function handleGameTokenReview(
  req: AuthedRequest,
  res: Response,
  action: 'approve' | 'reject'
) {
  const id = String(req.params.id);
  const token = typeof req.query?.token === 'string' ? req.query.token : undefined;
  const payload = token
    ? verifyReviewToken<{ reviewId: string; reviewKind: string; action: string }>(token)
    : null;
  const expectedAction = action === 'approve' ? 'approve_game' : 'reject_game';

  const tokenValid =
    !!token &&
    !!payload &&
    payload.reviewId === id &&
    payload.reviewKind === 'game' &&
    payload.action === expectedAction;

  // Allow a signed-in platform admin to approve/reject without a valid token.
  const isSignedInAdmin = !tokenValid && req.user ? await getIsAdmin(req as any) : false;

  if (!tokenValid && !isSignedInAdmin) {
    return res
      .status(401)
      .send(
        renderGameResultPage(
          'Invalid Link',
          `This ${action} link is invalid or has expired.`,
          false
        )
      );
  }

  const game = await (prisma.game.findUnique as any)({
    where: { id },
    select: { title: true, approval_status: true },
  });
  if (!game) {
    return res.status(404).send(renderGameResultPage('Not Found', 'Game not found.', false));
  }
  if (game.approval_status === 'approved') {
    return res.send(
      renderGameResultPage(
        'Already Approved',
        `${game.title || 'This game'} was already approved.`,
        true
      )
    );
  }
  if (game.approval_status === 'rejected') {
    return res.send(
      renderGameResultPage(
        'Already Rejected',
        `${game.title || 'This game'} was already rejected.`,
        true
      )
    );
  }

  if (req.method === 'GET') {
    return res.send(renderGameReviewPage(action, game.title || 'Unknown', token ?? undefined));
  }

  const reason =
    typeof (req.body as any)?.reason === 'string'
      ? String((req.body as any).reason).trim()
      : undefined;
  const reviewerUserId = req.user?.id ?? null;
  const result = await applyGameApprovalDecision(
    id,
    action === 'approve' ? 'approved' : 'rejected',
    reviewerUserId,
    reason
  );
  if ('error' in result) {
    const latest = await (prisma.game.findUnique as any)({
      where: { id },
      select: { title: true, approval_status: true },
    });
    const finalStatePage = latest ? renderGameFinalStatePage(latest, action) : null;
    if (finalStatePage) {
      return res.send(finalStatePage);
    }
    return res.status(result.status!).send(renderGameResultPage('Error', result.error!, false));
  }

  // Central audit trail (parity with coach/org/ad approvals). The game record
  // also carries approved_by_id/approved_at inline, but every privileged
  // approval must also land in AdminActivityLog.
  const reviewerEmail = reviewerUserId
    ? (await prisma.user.findUnique({ where: { id: reviewerUserId }, select: { email: true } }))
        ?.email || 'unknown'
    : 'email-token';
  await logAdminActivity(
    reviewerUserId || 'email-token',
    reviewerEmail,
    action === 'approve' ? 'APPROVE_GAME' : 'REJECT_GAME',
    'game',
    id,
    `${action === 'approve' ? 'Approved' : 'Rejected'} game: ${game.title || id}${
      reason ? ` — ${reason}` : ''
    }`
  ).catch(err => console.error('[games] AdminActivityLog write failed:', err));

  if (tokenValid && token && payload) {
    const consumeResult = await consumeReviewToken(token, payload);
    if (consumeResult !== 'consumed') {
      console.warn('[games] review token could not be marked consumed after success:', {
        game_id: id,
        action,
        consumeResult,
      });
    }
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
// Safe to run repeatedly (skips games already populated). Kept explicit so
// importing the router never mutates data during tests or verification.
export async function runGamesStartupBackfill(): Promise<void> {
  try {
    const missing = await (prisma.game.findMany as any)({
      where: { location: { not: null }, latitude: null, venue_lat: null },
      select: { id: true, location: true },
      take: 1000,
    });
    if (missing.length === 0) return;
    debugLog(`[games] backfill: geocoding ${missing.length} games without coordinates`);
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
    debugLog(
      `[games] backfill: done — ${success} geocoded, ${failed} failed out of ${missing.length}`
    );
  } catch (err) {
    console.warn('[games] backfill failed:', err);
  }
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

// lat/lng are dropped here: this post row comes from an `include:` query (all
// scalar columns), and precise capture coordinates must never reach clients —
// they expose where a user (often a minor) was filmed.
const serializePost = ({ lat: _lat, lng: _lng, ...post }: any) => ({
  ...post,
  created_at: post.created_at instanceof Date ? post.created_at.toISOString() : post.created_at,
  media_type: detectMediaType(post.media_url),
  // resolvePreviewUrl, not getVideoPreviewUrl: the latter only derives a poster
  // from a Cloudinary URL, so every R2-hosted video (all media since the
  // 2026-07-13 migration) serialized preview_url: null and rendered as a black
  // tile. This row comes from an `include:` query, so poster_url is present.
  preview_url: resolvePreviewUrl(post),
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
        event_type: event.event_type ?? null,
      }
    : null;

const pickBannerUrl = (game: any, event: any | null, media: Array<{ url: string }>) => {
  // Fixed: Prioritize game.banner_url first, then fallback to others
  if (game?.banner_url) return game.banner_url;
  if (game?.cover_image_url) return game.cover_image_url;
  if (event?.banner_url) return event.banner_url;
  return media.length > 0 ? (media[0]?.url ?? null) : null;
};

const isCompetitivePollEventType = (eventType?: string | null) => {
  if (!eventType) return true;
  return String(eventType).trim().toLowerCase() === 'game';
};

const getPollEligibility = async (gameId: string) => {
  const game = await prisma.game.findUnique({
    where: { id: gameId },
    select: { id: true, event_type: true },
  });
  if (!game) return { ok: false as const, status: 404, body: { error: 'Not found' } };
  if (!isCompetitivePollEventType(game.event_type)) {
    return {
      ok: false as const,
      status: 409,
      body: {
        error: 'Polls are only available for competitive games.',
        code: 'POLL_NOT_AVAILABLE',
      },
    };
  }
  return { ok: true as const, game };
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
  return buildBinaryVoteSummary(teamA, teamB, mine?.team);
};

type GameVisibilityRecord = {
  id?: string | null;
  date?: Date | string | null;
  approval_status?: string | null;
  opponent_approval_status?: string | null;
  created_by_id?: string | null;
  home_team_id?: string | null;
  away_team_id?: string | null;
};

async function canViewGameRecord(
  record: GameVisibilityRecord,
  viewerId?: string | null
): Promise<boolean> {
  // Public-visibility rule lives in the shared isGamePubliclyVisible helper so
  // every public surface (og, share-landing, events list/search, media, feed)
  // gates identically. Past approved games stay public regardless of an
  // opponent-consent re-flip; upcoming games need non-blocking opponent consent.
  if (isGamePubliclyVisible(record)) return true;
  if (!viewerId) return false;
  if (record.created_by_id && record.created_by_id === viewerId) return true;

  if (await isVerifiedAdminUser(viewerId)) return true;

  const teamIds = [record.home_team_id, record.away_team_id].filter(Boolean) as string[];
  if (teamIds.length > 0) {
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
      take: teamIds.length,
    });
    const organizationIds = teams.map(team => team.organization_id).filter(Boolean) as string[];
    if (organizationIds.length > 0) {
      const orgMembership = await prisma.organizationMembership.findFirst({
        where: {
          user_id: viewerId,
          organization_id: { in: organizationIds },
          role: { in: ['owner', 'manager'] },
          status: 'active',
        },
        select: { id: true },
      });
      if (orgMembership) return true;
    }
  }

  // Additive permanent fallback: a contributor who posted to this game can
  // always view it, even while it's an upcoming game still awaiting opponent
  // consent (owner rule: viewing never expires). Read-only.
  if (record.id) {
    return viewerHasPostedOnEntity({ userId: viewerId, gameId: record.id });
  }

  return false;
}

gamesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
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
      const latRaw = Number.parseFloat(String(req.query.lat ?? ''));
      const lngRaw = Number.parseFloat(String(req.query.lng ?? ''));
      let viewerLat: number | null = Number.isFinite(latRaw) ? latRaw : null;
      let viewerLng: number | null = Number.isFinite(lngRaw) ? lngRaw : null;
      const showAll = String(req.query.show_all || '').toLowerCase() === 'true';
      const dateFromRaw = req.query.from ? new Date(String(req.query.from)) : null;
      const dateToRaw = req.query.to ? new Date(String(req.query.to)) : null;

      const authedReq = req as AuthedRequest;

      // By default, only show approved games unless specifically requested otherwise
      const showPending = req.query.show_pending === 'true';
      const following = req.query.following === 'true';
      const approvalStatus = req.query.approval_status as string;
      const normalizedApprovalStatus =
        typeof approvalStatus === 'string' ? approvalStatus.trim().toLowerCase() : '';
      const wantsNonApproved =
        showPending || (normalizedApprovalStatus !== '' && normalizedApprovalStatus !== 'approved');
      const shouldUseGamesCache = !wantsNonApproved && !following;
      const viewerScope = authedReq.user?.id ? `user:${authedReq.user.id}` : 'anon';
      const cacheRequestUrl = req.originalUrl || req.url;
      const gameCacheKey = `games:${viewerScope}:${cacheRequestUrl}`;

      // Followed-teams calendar scope (Discover): signed-out users have no
      // follows, so return an empty list rather than the global feed.
      if (following && !authedReq.user?.id) {
        return res.json([]);
      }

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

        const isAdmin = await isVerifiedAdminUser(authedReq.user.id);
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
        // show_pending=true means "my full schedule": approved games PLUS my
        // not-yet-approved ones. Team Schedule (manage-season) relies on this.
        // A 2026-03 hardening pass narrowed it to pending-only, which made
        // every approved game vanish from the Team Schedule screen. Callers
        // that want pending-only (event approvals) pass approval_status=pending
        // explicitly and hit the branch above.
        whereClause.approval_status = { in: ['approved', 'pending'] };
      } else {
        whereClause.approval_status = 'approved';
      }

      // Opponent-approval workflow: a plain 'approved' filter is the PUBLIC
      // path (unscoped — not gated by canViewNonApproved below), so it must
      // also exclude games still awaiting/declined opponent consent. The
      // 'my full schedule' (show_pending) path is already scoped to the
      // viewer's own managed teams further down, so a not-yet-confirmed game
      // on THEIR team's calendar correctly still shows there.
      if (whereClause.approval_status === 'approved') {
        whereClause.opponent_approval_status = { in: ['not_required', 'approved'] };
      }

      if (!wantsNonApproved) {
        const privateTeamWhere = buildPrivateTeamGameVisibilityWhere(
          await getExcludedPrivateTeamIds(authedReq.user?.id ?? null)
        );
        mergeAndWhere(whereClause, privateTeamWhere);
      }

      // Scope non-approved games to the coach's managed teams/orgs (prevent data leak).
      // Admins see all; regular coaches only see pending games for their teams.
      if (wantsNonApproved && canViewNonApproved && authedReq.user?.id) {
        const isAdmin = await isVerifiedAdminUser(authedReq.user.id);
        if (!isAdmin) {
          // Get team IDs and org IDs the coach manages
          const [managedTeams, managedOrgs] = await Promise.all([
            // audit-allow unbounded: access scope must include every managed team for this coach
            prisma.teamMembership.findMany({
              where: {
                user_id: authedReq.user.id,
                role: { in: ['owner', 'manager', 'coach', 'assistant_coach'] },
                status: 'active',
              },
              select: { team_id: true },
            }),
            // audit-allow unbounded: access scope must include every admin org for this coach
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
            // audit-allow unbounded: org-scoped visibility requires the full team set across managed orgs
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

      // Organization page needs a single bounded calendar query. Without this
      // filter the client had to issue one /games request per team, which made
      // coach org pages scale linearly with the number of teams.
      const organizationIdFilter =
        typeof req.query.organization_id === 'string'
          ? req.query.organization_id.trim()
          : typeof req.query.org_id === 'string'
            ? req.query.org_id.trim()
            : null;
      if (organizationIdFilter) {
        if (!whereClause.AND) whereClause.AND = [];
        whereClause.AND.push({
          OR: [
            { homeTeam: { organization_id: organizationIdFilter } },
            { awayTeam: { organization_id: organizationIdFilter } },
          ],
        });
      }

      // teamless=true: curated/marquee events (festivals, one-off watch parties)
      // created without a real team matchup. Used by the feed to fetch these
      // separately so they can't be paginated out by a flood of routine
      // league games sharing the same date window.
      if (req.query.teamless === 'true' || req.query.teamless === '1') {
        whereClause.home_team_id = null;
        whereClause.away_team_id = null;
      }

      // Discover calendar: scope to the viewer's followed teams (home OR away).
      // Guests were already short-circuited above; an authed user with zero
      // follows gets an empty list without hitting the games table.
      if (following && authedReq.user?.id) {
        // audit-allow unbounded: calendar scope needs every team the viewer follows
        const followedRows = await prisma.teamFollow.findMany({
          where: { user_id: authedReq.user.id },
          select: { team_id: true },
          take: 500,
        });
        const followedTeamIds = followedRows.map(r => r.team_id);
        if (followedTeamIds.length === 0) {
          return res.json([]);
        }
        if (!whereClause.AND) whereClause.AND = [];
        whereClause.AND.push({
          OR: [
            { home_team_id: { in: followedTeamIds } },
            { away_team_id: { in: followedTeamIds } },
          ],
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

      // map_view=true restricts to the rolling map window (today through +14 days).
      // Widened from +7 to +14 (2026-08) so the map and feed cover the same 2-week
      // window and stay in sync (mirror of utils/feedGameQueries.ts FEED_UPCOMING_WINDOW_MS).
      // Test note: once a game is in the past it should drop off the map. This filter is
      // opt-in so list views still work as before.
      const isMapView = req.query.map_view === 'true' || req.query.map_view === '1';
      if (isMapView) {
        const now = new Date();
        const twoWeeksFromNow = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
        const liveLookback = new Date(now.getTime() - 18 * 60 * 60 * 1000);
        // Regular games are limited to the next two weeks — a game drops off the
        // map once it's in the past (by design). Marquee/teamless events (festivals)
        // also stay pinned during their live window (started within 18h), so an
        // all-day fest happening right now doesn't slide off the map at its
        // start time. Matched on null team columns so it holds regardless of
        // whether the map query flags teamless.
        if (!whereClause.AND) whereClause.AND = [];
        whereClause.AND.push({
          OR: [
            { date: { gte: now, lte: twoWeeksFromNow } },
            {
              home_team_id: null,
              away_team_id: null,
              date: { gte: liveLookback, lte: twoWeeksFromNow },
            },
          ],
        });
      }

      // Marquee/teamless events (festivals, watch parties) stay on the feed for
      // their full live window — up to 18h after start — instead of dropping off
      // after the client's short (2h) live lookback. So an all-day fest that
      // started earlier today keeps surfacing while it's live. List views only
      // (not the map, which is intentionally current-week only).
      const isTeamlessQuery = req.query.teamless === 'true' || req.query.teamless === '1';
      if (!isMapView && isTeamlessQuery && (whereClause.date as any)?.gte) {
        const liveLookback = new Date(Date.now() - 18 * 60 * 60 * 1000);
        if (new Date((whereClause.date as any).gte).getTime() > liveLookback.getTime()) {
          (whereClause.date as any).gte = liveLookback;
        }
      }

      // Proximity fallback: a signed-in viewer with no device coords still
      // gets nearest-first selection from their profile zip preference
      // (mirrors /feed/bundle's zip handling). Scoped to plain public list
      // queries only — team schedules (team_id), approvals (non-approved),
      // and the followed-teams calendar (following) stay strictly date-ordered.
      if (
        viewerLat === null &&
        !showAll &&
        authedReq.user?.id &&
        !teamIdFilter &&
        !organizationIdFilter &&
        !following &&
        !wantsNonApproved
      ) {
        try {
          const viewer = await prisma.user.findUnique({
            where: { id: authedReq.user.id },
            select: { preferences: true },
          });
          const zip = (viewer?.preferences as any)?.zip_code;
          if (typeof zip === 'string' && zip.trim().length > 0) {
            const staticCoords = getZipCoordinates(zip.trim());
            const coords =
              staticCoords ??
              (await geocodeLocation(zip.trim()).then(r =>
                r ? { lat: r.latitude, lon: r.longitude } : null
              ));
            if (coords) {
              viewerLat = coords.lat;
              viewerLng = coords.lon;
            }
          }
        } catch (err) {
          // Proximity is best-effort — fall back to plain date order.
          console.warn('[games] zip proximity fallback failed:', err);
        }
      }
      const hasCoords = viewerLat !== null && viewerLng !== null;

      // With viewer coords, selection is nearest-first: widen the candidate
      // pool (bounded) so nearby games can't be crowded out of the page by
      // sooner-but-far ones, then keep only the `limit` nearest below.
      const poolSize = hasCoords ? Math.min(Math.max(limit * 5, 100), 200) : limit;

      const games = await (prisma.game.findMany as any)({
        where: Object.keys(whereClause).length > 0 ? whereClause : undefined,
        orderBy,
        take: poolSize + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: {
          events: {
            orderBy: { date: 'asc' },
            take: 1,
            // Pro-matchup team colors power the feed card's team-color gradient
            // (utils/feedGameCard.ts). Pro teams live on the linked EVENT, not
            // the game, so they must be pulled through here — mirrors the
            // /events serializer (routes/events.ts). Null for non-pro events.
            include: {
              proHomeTeam: { select: { primary_color: true } },
              proAwayTeam: { select: { primary_color: true } },
            },
          },
          _count: { select: { events: true } },
          // Load the creator so Event Approvals can show a "submitted by" label
          // on pending game cards. Without this, the client-side filter at
          // event-approvals.tsx `g.created_by ? {...} : undefined` always hits
          // the `undefined` branch and the submitter name is dropped.
          created_by: {
            select: { id: true, display_name: true, username: true, avatar_url: true },
          },
          // Sport comes from either side of the matchup (both play the same
          // sport). Powers the map's sport filter; not rendered directly.
          homeTeam: { select: { sport: true } },
          awayTeam: { select: { sport: true } },
        },
      });

      const hasMore = games.length > poolSize;
      const results = hasMore ? games.slice(0, poolSize) : games;

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
        const {
          events,
          _count,
          created_by: createdByUser,
          homeTeam,
          awayTeam,
          ...rest
        } = game as any;
        // Both teams play the same sport; either side answers "what sport is this".
        const sport = homeTeam?.sport ?? awayTeam?.sport ?? null;
        let distance: number | null = null;
        if (
          hasCoords &&
          viewerLat !== null &&
          viewerLng !== null &&
          typeof rest.latitude === 'number' &&
          typeof rest.longitude === 'number'
        ) {
          const dLat = ((rest.latitude - viewerLat) * Math.PI) / 180;
          const dLng = ((rest.longitude - viewerLng) * Math.PI) / 180;
          const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos((viewerLat * Math.PI) / 180) *
              Math.cos((rest.latitude * Math.PI) / 180) *
              Math.sin(dLng / 2) *
              Math.sin(dLng / 2);
          const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
          distance = 6371 * c; // km
        }
        // The live posting window is a server rule (geofencing.ts) and is
        // computed from the EVENT when one is linked — a game row's own date
        // can disagree with its event's (and does, for Fanatics Fest Day 1).
        // Shipping the computed bounds keeps the app from re-deriving them
        // with a hardcoded cutoff that ignores per-event overrides.
        const liveWindow = serializeLiveWindow(
          event?.date ?? rest.date,
          event?.live_window_hours_after_start
        );
        return {
          ...rest,
          sport,
          appearance: rest.appearance ?? null,
          event_id: event?.id ?? null,
          // Pro-matchup colors for the feed card gradient. Null for non-pro
          // games; the client falls back to a deterministic gradient.
          pro_home_color: event?.proHomeTeam?.primary_color ?? null,
          pro_away_color: event?.proAwayTeam?.primary_color ?? null,
          pro_league: event?.proHomeTeam?.league ?? event?.proAwayTeam?.league ?? null,
          venue_photo: venuePhotoFor(event?.location ?? rest.location),
          ...liveWindow,
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

      // nextCursor must continue the DATE-ordered scan the query ran, so it is
      // taken from the last candidate in fetch order — never from the
      // distance-sorted payload (that cursor would skip everything between).
      const lastId = results.length > 0 ? results[results.length - 1].id : null;

      let finalGames = payload;
      if (hasCoords) {
        payload.sort((a: any, b: any) => {
          if (typeof a.distance !== 'number' && typeof b.distance !== 'number') return 0;
          if (typeof a.distance !== 'number') return 1;
          if (typeof b.distance !== 'number') return -1;
          return a.distance - b.distance;
        });
        // Keep only the `limit` nearest of the widened candidate pool.
        finalGames = payload.slice(0, limit);
      }

      const gamesResponse = { games: finalGames, nextCursor: hasMore ? lastId : null };
      if (shouldUseGamesCache) {
        void cacheSet(gameCacheKey, gamesResponse, 120); // 120s TTL
      }
      res.json(gamesResponse);
    } catch (err) {
      console.error('[games] GET / error:', err);
      return sendError(res, 500, 'Internal server error');
    }
  })
);

// Create a new game
gamesRouter.post(
  '/',
  requireVerified as any,
  requireOnboarded as any,
  gameCreationLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return sendError(res, 401, 'Unauthorized');

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
      // Creator's device IANA timezone (for correct email time rendering)
      timezone: z.string().max(64).optional(),
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
        title: stripHtml(parsed.data.title),
        date: parsed.data.date ? new Date(parsed.data.date) : new Date(),
        timezone: parsed.data.timezone ?? null,
        location: stripHtml(parsed.data.location),
        description: parsed.data.description ? stripHtml(parsed.data.description) : undefined,
        banner_url: parsed.data.banner_url ?? null,
        cover_image_url: parsed.data.cover_image_url ?? null,
        appearance: parsed.data.appearance ?? null,
        expected_attendance: parsed.data.expected_attendance ?? null,
        event_type: parsed.data.event_type ?? 'game',
        donation_goal: parsed.data.donation_goal ?? null,
        watch_location: parsed.data.watch_location ? stripHtml(parsed.data.watch_location) : null,
        watch_location_lat: parsed.data.watch_location_lat ?? null,
        watch_location_lng: parsed.data.watch_location_lng ?? null,
        watch_location_place_id: parsed.data.watch_location_place_id ?? null,
        destination: parsed.data.destination ? stripHtml(parsed.data.destination) : null,
        latitude: parsed.data.latitude ?? null,
        longitude: parsed.data.longitude ?? null,
        home_team: parsed.data.home_team ?? null,
        away_team: parsed.data.away_team ?? null,
        home_team_id: parsed.data.home_team_id ?? null,
        away_team_id: parsed.data.away_team_id ?? null,
        away_team_name: parsed.data.away_team_name ? stripHtml(parsed.data.away_team_name) : null,
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

      // Approval workflow: resolve which participating team the requester can manage.
      // Away-game flows break if we hardcode everything to home_team_id.
      let isCoach = false;
      let managedTeamId: string | null = null;

      // Check if user is super admin (can create events for ANY team)
      const currentUser = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { email: true, display_name: true },
      });
      const isAdmin = await isVerifiedAdminUser(req.user.id);

      // Require team association for non-admin users
      if (!parsed.data.home_team_id && !parsed.data.away_team_id && !isAdmin) {
        return sendError(
          res,
          400,
          'A home_team_id or away_team_id is required. Games must be associated with a team.'
        );
      }

      // Single source of truth for approval_status + opponent-approval — see
      // lib/gameApproval.ts. Do NOT re-derive this inline; POST /games/bulk and
      // PUT /games/:id call the same authority (parity-pinned).
      const approvalDecision = await deriveGameApproval(
        req.user.id,
        parsed.data.home_team_id,
        parsed.data.away_team_id,
        isAdmin,
        canManageTeamScoped
      );
      isCoach = approvalDecision.isCoach;
      managedTeamId = approvalDecision.managedTeamId;

      // Verify the caller's managed team's org is admin-approved (coach path only)
      if (isCoach && !isAdmin && managedTeamId) {
        const team = await prisma.team.findUnique({
          where: { id: managedTeamId },
          select: { organization_id: true },
        });
        if (team?.organization_id) {
          const org = await prisma.organization.findUnique({
            where: { id: team.organization_id },
            select: { admin_approved: true },
          });
          if (org && !org.admin_approved) {
            return res.status(403).json({
              error: 'Your organization must be approved before creating games.',
              code: 'ORG_NOT_APPROVED',
            });
          }
        }
      } else if (isAdmin) {
        debugLog(
          `✅ Admin ${currentUser?.email} creating event for team ${managedTeamId || 'N/A'}`
        );
      }

      const associatedTeamId =
        managedTeamId || parsed.data.home_team_id || parsed.data.away_team_id || null;

      gameData.opponent_approval_status = approvalDecision.opponentApprovalStatus;
      gameData.opponent_approval_team_id = approvalDecision.opponentApprovalTeamId;
      gameData.approval_status = approvalDecision.approvalStatus;
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
          timezone: game.timezone ?? null,
          location: game.location || null,
          latitude: eventLat,
          longitude: eventLng,
          game_id: game.id,
          team_id: associatedTeamId,
          // EventStatus enum is draft|approved|rejected|cancelled — it has NO
          // `pending` member. approval_status ('pending') must map to `draft`,
          // in parity with POST /events (status: approved|draft). Passing
          // 'pending' here threw an invalid-enum error that was swallowed into a
          // generic 500 for every not-yet-approved game create.
          status:
            gameData.approval_status === 'approved'
              ? 'approved'
              : gameData.approval_status === 'rejected'
                ? 'rejected'
                : 'draft',
          approval_status: gameData.approval_status || 'pending',
          creator_id: req.user!.id,
          creator_role: isCoach ? 'coach' : 'fan',
          event_type: parsed.data.event_type || 'game',
          capacity: null,
        } as any,
      });

      if (currentUser?.email) {
        sendEventSubmissionReceivedEmail({
          to: currentUser.email,
          submitterName: currentUser.display_name || undefined,
          eventTitle: game.title,
          needsApproval: gameData.approval_status !== 'approved',
        }).catch(err =>
          console.warn('[games] submission receipt email failed:', (err as any)?.message || err)
        );
      }

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
        const reviewTeamName =
          managedTeamId === game.awayTeam?.id
            ? game.awayTeam?.name
            : game.homeTeam?.name || game.awayTeam?.name;
        void notifyPendingEventReviewers(prisma, {
          reviewId: game.id,
          reviewKind: 'game',
          teamId: associatedTeamId,
          requesterName: currentUser?.display_name || 'VarsityHub User',
          requesterEmail: currentUser?.email || '',
          eventTitle: game.title,
          eventType: parsed.data.event_type || 'game',
          eventDate: game.date,
          eventLocation: game.location || game.venue_address || undefined,
          teamName: reviewTeamName || undefined,
        }).catch(err => {
          console.warn('[games] pending review email failed:', (err as any)?.message || err);
        });
      }

      if (approvalDecision.opponentApprovalTeamId) {
        const opponentApprovalTeamId = approvalDecision.opponentApprovalTeamId;
        void (async () => {
          try {
            const recipients = await getPendingEventReviewRecipients(prisma, {
              teamId: opponentApprovalTeamId,
            });
            const userIds = recipients.map(r => r.userId).filter((id): id is string => Boolean(id));
            if (userIds.length === 0) return;

            await prisma.notification.createMany({
              data: userIds.map(uid => ({
                user_id: uid,
                actor_id: req.user!.id,
                type: 'GAME_OPPONENT_APPROVAL_REQUESTED' as any,
                meta: {
                  game_id: game.id,
                  event_id: event.id,
                  title: game.title,
                  proposing_team_name:
                    managedTeamId === game.homeTeam?.id ? game.homeTeam?.name : game.awayTeam?.name,
                },
              })),
            });

            const { sendPushNotification } = await import('../lib/notifications.js');
            for (const uid of userIds) {
              sendPushNotification(
                uid,
                'Game request awaiting your approval',
                `${currentUser?.display_name || 'A coach'} proposed "${game.title}" against your team.`,
                { type: 'game_opponent_approval_requested', game_id: game.id }
              ).catch(err => {
                console.warn(
                  '[games] opponent approval push failed:',
                  (err as any)?.message || err
                );
              });
            }
          } catch (err) {
            console.warn(
              '[games] opponent approval notification failed:',
              (err as any)?.message || err
            );
          }
        })();
      }

      await invalidateGamesListCache();
      res.status(201).json(response);
    } catch (error) {
      console.error('Error creating game:', error);
      sendError(res, 500, 'Failed to create game');
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
    const isAdmin = await isVerifiedAdminUser(userId);

    if (!isAdmin && parsed.data.games.every(g => !g.home_team_id && !g.away_team_id)) {
      return sendError(res, 400, 'Each game must reference a home_team_id or away_team_id.');
    }

    try {
      // Per-row approval decision via the single authority — a row whose teams
      // the caller does not manage lands PENDING, exactly like POST /games. This
      // is what stops the batch-level "manages ANY one team" auto-approve
      // injection the 2026-07-14 audit found.
      const decisionByIndex = await Promise.all(
        parsed.data.games.map(g =>
          deriveGameApproval(userId, g.home_team_id, g.away_team_id, isAdmin, canManageTeamScoped)
        )
      );
      const opponentTeamIdByIndex = decisionByIndex.map(d => d.opponentApprovalTeamId);

      // All-or-nothing: one failure rolls back the whole batch.
      const created = await prisma.$transaction(async tx => {
        const rows: any[] = [];
        for (let i = 0; i < parsed.data.games.length; i++) {
          const g = parsed.data.games[i];
          const decision = decisionByIndex[i];
          const associatedTeamId =
            decision.managedTeamId || g.home_team_id || g.away_team_id || null;
          const row = await tx.game.create({
            data: {
              title: stripHtml(g.title),
              date: new Date(g.date),
              location: stripHtml(g.location),
              description: g.description ? stripHtml(g.description) : null,
              home_team: g.home_team ?? null,
              away_team: g.away_team ?? null,
              home_team_id: g.home_team_id ?? null,
              away_team_id: g.away_team_id ?? null,
              event_type: g.event_type ?? 'game',
              is_neutral: g.is_neutral ?? false,
              created_by_id: userId,
              approval_status: decision.approvalStatus as any,
              approved_by_id: decision.isCoach ? userId : null,
              approved_at: decision.isCoach ? new Date() : null,
              opponent_approval_status: decision.opponentApprovalStatus as any,
              opponent_approval_team_id: decision.opponentApprovalTeamId,
            },
            select: { id: true, title: true, date: true, location: true },
          });
          // Mirror single-create: every game gets a linked Event so RSVP +
          // geofencing work. Without this, bulk games had no RSVP surface.
          await tx.event.create({
            data: {
              title: row.title,
              date: row.date,
              location: row.location || null,
              game_id: row.id,
              team_id: associatedTeamId,
              status: decision.approvalStatus,
              approval_status: decision.approvalStatus,
              creator_id: userId,
              creator_role: decision.isCoach ? 'coach' : 'fan',
              event_type: g.event_type ?? 'game',
              capacity: null,
            } as any,
          });
          rows.push(row);
        }
        return rows;
      });

      const triggeredOpponents = created
        .map((row, i) => ({ row, teamId: opponentTeamIdByIndex[i] }))
        .filter((entry): entry is { row: (typeof created)[number]; teamId: string } =>
          Boolean(entry.teamId)
        );
      if (triggeredOpponents.length > 0) {
        void (async () => {
          try {
            const { sendPushNotification } = await import('../lib/notifications.js');
            for (const { row, teamId } of triggeredOpponents) {
              const recipients = await getPendingEventReviewRecipients(prisma, { teamId });
              const userIds = recipients
                .map(r => r.userId)
                .filter((id): id is string => Boolean(id));
              if (userIds.length === 0) continue;
              await prisma.notification.createMany({
                data: userIds.map(uid => ({
                  user_id: uid,
                  actor_id: userId,
                  type: 'GAME_OPPONENT_APPROVAL_REQUESTED' as any,
                  meta: { game_id: row.id, title: row.title },
                })),
              });
              for (const uid of userIds) {
                sendPushNotification(
                  uid,
                  'Game request awaiting your approval',
                  `A coach proposed "${row.title}" against your team.`,
                  { type: 'game_opponent_approval_requested', game_id: row.id }
                ).catch(() => {});
              }
            }
          } catch (err) {
            console.warn(
              '[games/bulk] opponent approval notification failed:',
              (err as any)?.message || err
            );
          }
        })();
      }

      await invalidateGamesListCache();
      return res.status(201).json({ ok: true, created_count: created.length, games: created });
    } catch (err: any) {
      console.error('[games/bulk] failed — rolled back:', err?.message || err);
      return sendError(res, 500, 'Unable to create games. Please try again.');
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
gamesRouter.get(
  '/votes-summary',
  authMiddleware as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const idsParam = String(req.query.ids || '').trim();
      if (!idsParam) return sendError(res, 400, 'ids required (comma-separated game IDs)');
      const ids = idsParam
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
      if (ids.length === 0) return res.json({});
      if (ids.length > 50) return sendError(res, 400, 'Max 50 ids per request');
      const userId = req.user?.id ?? null;
      const eligibleGames = await prisma.game.findMany({
        where: {
          id: { in: ids },
          OR: [{ event_type: null }, { event_type: 'game' }],
        },
        select: { id: true },
        take: ids.length,
      });
      const eligibleIds = eligibleGames.map(game => game.id);
      if (eligibleIds.length === 0) return res.json({});

      // Batch: 1 groupBy query for all vote counts + 1 query for user votes (instead of 3N queries)
      const [voteCounts, userVotes] = await Promise.all([
        prisma.gameVote.groupBy({
          by: ['game_id', 'team'],
          _count: { _all: true },
          where: { game_id: { in: eligibleIds } },
        }),
        userId
          ? prisma.gameVote.findMany({
              where: { game_id: { in: eligibleIds }, user_id: userId },
              select: { game_id: true, team: true },
              take: eligibleIds.length,
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
      for (const id of eligibleIds) {
        const counts = countMap.get(id) || { A: 0, B: 0 };
        result[id] = buildBinaryVoteSummary(counts.A, counts.B, userVoteMap.get(id));
      }
      return res.json(result);
    } catch (err) {
      console.error('[games] votes-summary error:', err);
      return sendError(res, 500, 'Internal server error');
    }
  })
);

// Opponent-pending list: games awaiting a decision from a team the caller
// manages (canManageTeam — same "authorized user" boundary as deciding).
// Registered before the bare `/:id` route below so it isn't shadowed.
gamesRouter.get(
  '/opponent-pending',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return sendError(res, 401, 'Unauthorized');

    const managedTeams = await prisma.teamMembership.findMany({
      where: {
        user_id: req.user.id,
        role: { in: [...TEAM_STAFF_ROLES] },
        status: 'active',
      },
      select: { team_id: true },
      take: 100,
    });
    const managedTeamIds = managedTeams.map(m => m.team_id);

    const orgMemberships = await prisma.organizationMembership.findMany({
      where: {
        user_id: req.user.id,
        role: { in: [...ORG_ADMIN_ROLES] },
        status: 'active',
      },
      select: { organization_id: true },
      take: 100,
    });
    const orgIds = orgMemberships.map(m => m.organization_id);
    const orgTeams = orgIds.length
      ? await prisma.team.findMany({
          where: { organization_id: { in: orgIds } },
          select: { id: true },
          take: 500,
        })
      : [];

    const teamIds = [...new Set([...managedTeamIds, ...orgTeams.map(t => t.id)])];
    if (teamIds.length === 0) return res.json([]);

    const games = await prisma.game.findMany({
      where: {
        opponent_approval_status: 'pending',
        opponent_approval_team_id: { in: teamIds },
      },
      // GAME_SUMMARY_SELECT plus the opponent-decision fields this endpoint
      // needs — per serializeGame.ts's own guidance, extend locally rather
      // than mutate the shared constant other endpoints depend on.
      select: {
        ...GAME_SUMMARY_SELECT,
        opponent_approval_status: true,
        opponent_approval_team_id: true,
        created_by_id: true,
      },
      orderBy: { date: 'asc' },
      take: 50,
    });
    return res.json(games);
  })
);

// Get single game by id
gamesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
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
      if (!game) return sendError(res, 404, 'Not found');
      if (!(await canViewGameRecord(game as GameVisibilityRecord, authedReq.user?.id ?? null))) {
        return sendError(res, 404, 'Not found');
      }
      const gameData = game as any; // Type assertion for relation fields
      const event = gameData.events[0] ?? null;
      const { events, ...rest } = gameData;
      return res.json({
        ...rest,
        appearance: rest.appearance ?? null,
        event_id: event?.id ?? null,
        // Same posting-window bounds the list + summary ship, so the event page
        // gates story posting on the real (per-event) window, not a 3h fallback.
        ...serializeLiveWindow(event?.date ?? rest.date, event?.live_window_hours_after_start),
      });
    } catch (err) {
      console.error('[games] get-by-id error:', err);
      return sendError(res, 500, 'Internal server error');
    }
  })
);

// Compact summary payload for the Game Details screen.
// Posts and stories are intentionally excluded here — the client fetches them
// separately via GET /games/:id/posts and GET /games/:id/stories so this
// endpoint stays fast (no heavy joins on potentially large post tables).
gamesRouter.get(
  '/:id/summary',
  asyncHandler(async (req: AuthedRequest, res) => {
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
      if (!game) return sendError(res, 404, 'Not found');
      if (!(await canViewGameRecord(game as GameVisibilityRecord, req.user?.id ?? null))) {
        return sendError(res, 404, 'Not found');
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
          if (await isVerifiedAdminUser(req.user.id)) canEditResult = true;
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
        event_type: gameData.event_type ?? event?.event_type ?? null,
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
        // Ship the computed posting-window bounds (starts_at/live_from/live_until)
        // just like GET /games does — the event page reads these to gate story
        // posting and the "Add Story" button. Without them the client falls back
        // to date+3h, which closed Fanatics Fest days (18h window) ~3h in and
        // wrongly reported "event has ended" while the server still accepted posts.
        ...serializeLiveWindow(event?.date ?? gameData.date, event?.live_window_hours_after_start),
        home_score: gameData.home_score ?? null,
        away_score: gameData.away_score ?? null,
        winner: gameData.winner ?? null,
        can_edit_result: canEditResult,
      });
    } catch (err) {
      console.error('[games] summary error:', err);
      return sendError(res, 500, 'Internal server error');
    }
  })
);

gamesRouter.get(
  '/:id/votes/summary',
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const gameId = String(req.params.id);
      const eligibility = await getPollEligibility(gameId);
      if (!eligibility.ok) {
        return res.status(eligibility.status).json(eligibility.body);
      }
      const summary = await summarizeVotes(gameId, req.user?.id);
      res.json(summary);
    } catch (err) {
      console.error('[games] votes-summary-single error:', err);
      return sendError(res, 500, 'Internal server error');
    }
  })
);

gamesRouter.post(
  '/:id/votes',
  requireAuth as any,
  voteLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      if (!req.user) return sendError(res, 401, 'Unauthorized');
      const gameId = String(req.params.id);
      const eligibility = await getPollEligibility(gameId);
      if (!eligibility.ok) {
        return res.status(eligibility.status).json(eligibility.body);
      }
      const teamInput = String(req.body?.team ?? '')
        .trim()
        .toUpperCase();
      if (teamInput !== 'A' && teamInput !== 'B') {
        return sendError(res, 400, 'Invalid team option');
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
      return sendError(res, 500, 'Internal server error');
    }
  })
);

gamesRouter.delete(
  '/:id/votes',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      if (!req.user) return sendError(res, 401, 'Unauthorized');
      const gameId = String(req.params.id);
      const eligibility = await getPollEligibility(gameId);
      if (!eligibility.ok) {
        return res.status(eligibility.status).json(eligibility.body);
      }
      await prisma.gameVote.deleteMany({ where: { game_id: gameId, user_id: req.user.id } });
      const summary = await summarizeVotes(gameId, req.user.id);
      res.json(summary);
    } catch (err) {
      console.error('[games] delete-vote error:', err);
      return sendError(res, 500, 'Internal server error');
    }
  })
);

// Delete a game
gamesRouter.delete(
  '/:id',
  requireAuth as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return sendError(res, 401, 'Unauthorized');
    const id = String(req.params.id);

    try {
      // Check if game exists
      const game = await prisma.game.findUnique({
        where: { id },
        select: {
          id: true,
          title: true,
          date: true,
          location: true,
          created_by_id: true,
          home_team_id: true,
          away_team_id: true,
          opponent_approval_team_id: true,
        },
      });

      if (!game) return sendError(res, 404, 'Game not found');

      // CRITICAL: Check authorization before allowing deletion
      // Only allow: game creator, CREATING-team coaches, or admins. The opposing
      // team's staff must NOT be able to delete a shared game (they decline via
      // the opponent-approval flow) — audit 2026-07-14.
      const isCreator = game.created_by_id === req.user.id;

      // Check if user is admin
      const isAdmin = await isVerifiedAdminUser(req.user.id);

      // Authorize on the CREATOR's side only (opponent excluded). Keep the full
      // team set below for cancellation notifications to BOTH teams.
      const deleteTeamIds = [game.home_team_id, game.away_team_id].filter(Boolean) as string[];
      const authTeamIds = creatorSideTeamIds(
        game.home_team_id,
        game.away_team_id,
        game.opponent_approval_team_id
      );
      const isCoach = await canManageAnyTeam(req.user.id, authTeamIds);

      // Deny access if user is not authorized
      if (!isCreator && !isCoach && !isAdmin) {
        return res.status(403).json({
          error: 'Not authorized',
          message:
            'Only the game creator, the creating team’s coaches, or admins can delete games.',
        });
      }

      // Notify RSVPed users before deleting
      try {
        const gameForNotif = await prisma.game.findUnique({
          where: { id },
          select: { id: true, title: true, date: true, location: true, timezone: true },
        });
        const gameTitle = gameForNotif?.title || 'A game';
        const gameDate = gameForNotif?.date instanceof Date ? gameForNotif.date : null;
        // Render in the game's captured timezone (falls back to zone-less when null).
        const formatted = gameDate ? formatEventTime(gameDate, gameForNotif?.timezone) : null;
        const eventDate = formatted?.dateStr;
        const eventTime = formatted ? `${formatted.timeStr}` : undefined;

        // Find events linked to this game and their RSVPs
        // audit-allow unbounded: game deletion must notify every linked event RSVP
        const linkedEvents = await prisma.event.findMany({
          where: { game_id: id },
          select: {
            id: true,
            rsvps: {
              select: {
                user_id: true,
                user: {
                  select: {
                    email: true,
                    display_name: true,
                  },
                },
              },
            },
          },
        });
        const rsvpUserIds = new Set<string>();
        const { cancelGameReminders } = await import('../lib/notifications.js');
        for (const evt of linkedEvents) {
          for (const rsvp of evt.rsvps) {
            if (rsvp.user_id !== req.user!.id) rsvpUserIds.add(rsvp.user_id);
            if (rsvp.user?.email && rsvp.user_id !== req.user!.id) {
              sendEventCanceledEmail({
                to: rsvp.user.email,
                recipientName: rsvp.user.display_name || 'there',
                eventName: gameTitle,
                eventDate,
                eventTime,
                eventLocation: gameForNotif?.location || undefined,
                eventId: evt.id,
              }).catch((err: any) =>
                console.warn('[games] cancel email failed:', err?.message || err)
              );
            }
            if (rsvp.user_id !== req.user!.id) {
              await cancelGameReminders(evt.id, rsvp.user_id);
            }
          }
        }

        // Also notify team members of home/away teams
        if (deleteTeamIds.length > 0) {
          // audit-allow unbounded: game cancellation must notify every active member on affected teams
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
        const notificationUserIds = [...rsvpUserIds];
        if (notificationUserIds.length > 0) {
          await prisma.notification.createMany({
            data: notificationUserIds.map(uid => ({
              user_id: uid,
              actor_id: req.user!.id,
              type: 'GAME_CANCELLED',
              meta: { game_id: id, game_title: gameTitle },
            })),
          });
          await Promise.allSettled(
            notificationUserIds.map(uid =>
              sendPushNotification(uid, `Game cancelled`, `${gameTitle} has been cancelled`, {
                type: 'game_cancelled',
                game_id: id,
                screen: 'games',
              })
            )
          );
        }
      } catch (notifErr) {
        console.error('[games] Failed to send game cancelled notifications:', notifErr);
      }

      // The linked Event has onDelete: SetNull, so deleting the game would leave
      // an orphaned Event that still accepts RSVPs and fires reminders. Cancel
      // linked events first (RSVPers were already notified above) so the RSVP
      // status guard closes them out.
      await prisma.event.updateMany({
        where: { game_id: id },
        data: { status: 'cancelled' },
      });
      // Delete the game (remaining cascade deletes handle stories/votes)
      await prisma.game.delete({ where: { id } });
      await invalidateGamesListCache();

      res.json({ message: 'Game deleted successfully' });
    } catch (error) {
      console.error('Error deleting game:', error);
      sendError(res, 500, 'Failed to delete game');
    }
  })
);

// Posts tied to a game
gamesRouter.get(
  '/:id/posts',
  authMiddleware as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const id = String(req.params.id);
      const limit = Math.max(1, Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 100));
      // Privacy: exclude posts from private-profile authors the viewer doesn't
      // follow AND from blocked users — parity with the other content reads
      // (this feed previously omitted the block filter). Audit 2026-07-14.
      const [privateIds, blockedIds] = await Promise.all([
        getExcludedPrivateAuthorIds(req.user?.id ?? null),
        getBlockedUserIds(req.user?.id ?? null, getRequestBlockedCache(req)),
      ]);
      const excludedIds = [...new Set([...privateIds, ...blockedIds])];
      const posts = await prisma.post.findMany({
        where: {
          // Match posts tied to the game directly (game_id) OR via any of its
          // events (event_id). Writes denormalize both columns, so game_id
          // alone would suffice for new rows — the event relation filter keeps
          // this correct for any legacy row not yet backfilled.
          OR: [{ game_id: id }, { event: { game_id: id } }],
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
      return sendError(res, 500, 'Internal server error');
    }
  })
);

// Media (stories) tied to a game
gamesRouter.get('/:id/media', makeListMediaHandler({ prisma }));

// Delete a specific media/story from a game
gamesRouter.delete(
  '/:id/media/:mediaId',
  requireAuth as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return sendError(res, 401, 'Unauthorized');

    const gameId = String(req.params.id);
    const mediaId = String(req.params.mediaId);

    try {
      // Find the story first to check ownership
      const story = await prisma.story.findUnique({
        where: { id: mediaId },
        select: { id: true, user_id: true, game_id: true },
      });

      if (!story) {
        return sendError(res, 404, 'Story not found');
      }

      // Verify the story belongs to this game
      if (story.game_id !== gameId) {
        return sendError(res, 400, 'Story does not belong to this game');
      }

      // Verify the user owns this story
      if (story.user_id !== req.user.id) {
        return sendError(res, 403, 'You can only delete your own stories');
      }

      // Delete the story
      await prisma.story.delete({ where: { id: mediaId } });

      debugLog(`✅ User ${req.user.id} deleted story ${mediaId} from game ${gameId}`);
      res.json({ message: 'Story deleted successfully' });
    } catch (error) {
      console.error('Error deleting story:', error);
      sendError(res, 500, 'Failed to delete story');
    }
  })
);

// Legacy stories endpoints (kept for backwards compatibility)
gamesRouter.get('/:id/stories', makeListMediaHandler({ prisma }));

gamesRouter.post(
  '/:id/stories',
  requireAuth as any,
  requireOnboarded as any,
  storyCreationLimiter,
  makeCreateStoryHandler({ prisma })
);

// Update game result (scores) - coaches and team owners only
gamesRouter.patch(
  '/:id/result',
  requireAuth as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      if (!req.user) return sendError(res, 401, 'Unauthorized');
      const actingUserId = req.user.id;

      const id = String(req.params.id);
      const schema = z.object({
        home_score: z.number().int().min(0).optional(),
        away_score: z.number().int().min(0).optional(),
        winner: z.enum(['home', 'away', 'tie']).optional().nullable(),
      });
      const parsed = schema.safeParse(req.body || {});
      if (!parsed.success)
        return sendError(res, 400, 'Invalid payload', {
          details: parsed.error.issues.map(i => ({ path: i.path, message: i.message })),
        });

      const game = await prisma.game.findUnique({
        where: { id },
        select: {
          id: true,
          created_by_id: true,
          home_team_id: true,
          away_team_id: true,
          opponent_approval_team_id: true,
          date: true,
          home_score: true,
          away_score: true,
        },
      });

      if (!game) return sendError(res, 404, 'Game not found');

      // The reported score belongs to the CREATING team — the opponent can't
      // overwrite it (they use opponent-approval). Audit 2026-07-14.
      const teamIds = creatorSideTeamIds(
        game.home_team_id,
        game.away_team_id,
        game.opponent_approval_team_id
      );
      const isCoach = await canManageAnyTeam(req.user.id, teamIds);

      const isCreator = game.created_by_id === req.user.id;
      const isAdmin = await isVerifiedAdminUser(req.user.id);

      if (!isCreator && !isCoach && !isAdmin) {
        return res
          .status(403)
          .json({ error: 'Only the creating team’s coaches or admins can update game results' });
      }

      // Score edit window: once a game has been scored (either score set) and
      // more than 48 hours have passed since the game date, normal users lose
      // edit access. This is the data-integrity baseline — a league can't
      // re-litigate results weeks later. Platform admins retain override so
      // legitimate correction requests still have an escape hatch.
      const SCORE_EDIT_WINDOW_MS = 48 * 60 * 60 * 1000;
      const gameWasScored = game.home_score !== null || game.away_score !== null;
      const windowClosesAt = game.date
        ? new Date(game.date.getTime() + SCORE_EDIT_WINDOW_MS)
        : null;
      const windowExpired = windowClosesAt !== null && Date.now() > windowClosesAt.getTime();
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
      return sendError(res, 500, 'Internal server error');
    }
  })
);

// Update cover image
gamesRouter.patch(
  '/:id',
  requireAuth as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return sendError(res, 401, 'Unauthorized');

    const id = String(req.params.id);
    const schema = z.object({
      cover_image_url: z.string().url().optional(),
      appearance: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return sendError(res, 400, 'Invalid payload');

    try {
      // CRITICAL: Check authorization before allowing updates
      const game = await prisma.game.findUnique({
        where: { id },
        select: {
          id: true,
          created_by_id: true,
          home_team_id: true,
          away_team_id: true,
          opponent_approval_team_id: true,
        },
      });

      if (!game) return sendError(res, 404, 'Game not found');

      // Only allow: game creator, team coaches, or admins
      const isCreator = game.created_by_id === req.user.id;

      // Check if user is admin
      const isAdmin = await isVerifiedAdminUser(req.user.id);

      // Creator-side only — the opposing team's staff must not overwrite the
      // cover/appearance of a shared game (parity with DELETE / PATCH /result).
      const teamIds = creatorSideTeamIds(
        game.home_team_id,
        game.away_team_id,
        game.opponent_approval_team_id
      );
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
      return sendError(res, 500, 'Failed to update game');
    }
  })
);

// Full update of a game (coaches, creators, admins)
gamesRouter.put(
  '/:id',
  requireAuth as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return sendError(res, 401, 'Unauthorized');

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
      return sendError(res, 400, 'Invalid game data', { details: parsed.error.issues });
    }

    try {
      const game = await prisma.game.findUnique({
        where: { id },
        select: {
          id: true,
          title: true,
          date: true,
          location: true,
          created_by_id: true,
          home_team_id: true,
          away_team_id: true,
          opponent_approval_team_id: true,
          approval_status: true,
        },
      });

      if (!game) return sendError(res, 404, 'Game not found');

      const isCreator = game.created_by_id === req.user.id;

      const isAdmin = await isVerifiedAdminUser(req.user.id);

      // Only the CREATOR side may edit a shared game — the opposing team's staff
      // must use the opponent-approval/decline flow, never mutate a game they
      // didn't create and haven't consented to. Mirrors DELETE and PATCH /result.
      const gameTeamIds = creatorSideTeamIds(
        game.home_team_id,
        game.away_team_id,
        game.opponent_approval_team_id
      );
      const isCoach = await canManageAnyTeam(req.user.id, gameTeamIds);

      if (!isCreator && !isCoach && !isAdmin) {
        return res
          .status(403)
          .json({ error: 'Only the game creator, team coaches, or admins can update this event' });
      }

      const d = parsed.data;

      // Approved-game edit allowlist (mirrors events.ts COACH_EDITABLE_FIELDS).
      // Once a game is approved, a non-admin editor (creator or coach) may only
      // change logistics/identity-neutral fields — not re-write it past
      // moderation. Team changes ARE allowed but re-trigger opponent consent
      // (handled below).
      if (game.approval_status === 'approved' && !isAdmin) {
        const disallowed = Object.keys(d).filter(k => !GAME_COACH_EDITABLE_FIELDS.includes(k));
        if (disallowed.length > 0) {
          return sendError(res, 403, 'Limited edit scope', {
            code: 'LIMITED_EDIT_SCOPE',
            message:
              'Coaches can only edit time, location, description, photo, and opponent for an approved game. Contact an admin for other changes.',
            details: { disallowed },
          });
        }
      }

      // Build update payload — only include fields that were explicitly provided
      const updateData: any = {};
      if (d.title !== undefined) updateData.title = stripHtml(d.title);
      if (d.home_team !== undefined) updateData.home_team = d.home_team;
      if (d.away_team !== undefined) updateData.away_team = d.away_team;
      if (d.home_team_id !== undefined) updateData.home_team_id = d.home_team_id;
      if (d.away_team_id !== undefined) updateData.away_team_id = d.away_team_id;
      if (d.away_team_name !== undefined)
        updateData.away_team_name = d.away_team_name
          ? stripHtml(d.away_team_name)
          : d.away_team_name;
      if (d.date !== undefined) updateData.date = new Date(d.date);
      if (d.location !== undefined) updateData.location = stripHtml(d.location);
      if (d.description !== undefined)
        updateData.description = d.description ? stripHtml(d.description) : d.description;
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

      // Team reassignment: if either team id changes, re-authorize against the
      // NEW configuration and recompute opponent consent via the single
      // authority. Without this, a coach could pin a victim team as opponent on
      // an already-approved game, bypassing the consent workflow.
      const teamsChanging =
        (d.home_team_id !== undefined && d.home_team_id !== game.home_team_id) ||
        (d.away_team_id !== undefined && d.away_team_id !== game.away_team_id);
      if (teamsChanging) {
        const nextHomeId = d.home_team_id !== undefined ? d.home_team_id : game.home_team_id;
        const nextAwayId = d.away_team_id !== undefined ? d.away_team_id : game.away_team_id;

        // Any newly-referenced team id must actually exist (avoid FK 500).
        const newIds = [nextHomeId, nextAwayId].filter(
          (tid): tid is string =>
            Boolean(tid) && tid !== game.home_team_id && tid !== game.away_team_id
        );
        if (newIds.length > 0) {
          const found = await prisma.team.count({ where: { id: { in: newIds } } });
          if (found !== newIds.length) {
            return sendError(res, 400, 'One or more referenced teams do not exist.');
          }
        }

        const reDecision = await deriveGameApproval(
          req.user.id,
          nextHomeId,
          nextAwayId,
          isAdmin,
          canManageTeamScoped
        );
        // A non-admin must still manage at least one side of the NEW matchup.
        if (!isAdmin && !reDecision.isCoach) {
          return res
            .status(403)
            .json({ error: 'You must manage one of the teams in the new matchup.' });
        }
        updateData.opponent_approval_status = reDecision.opponentApprovalStatus;
        updateData.opponent_approval_team_id = reDecision.opponentApprovalTeamId;
      }

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
        // Date changed → move every RSVP's 12h/1h reminders to the new time.
        if (d.date !== undefined) {
          void (async () => {
            const { rescheduleGameRemindersForEvent } = await import('../lib/notifications.js');
            await rescheduleGameRemindersForEvent(event.id);
          })().catch(err =>
            console.warn('[games] reminder reschedule failed:', (err as any)?.message || err)
          );
        }
      }

      const changes: string[] = [];
      if (d.date !== undefined) {
        changes.push(`Date: ${updated.date?.toLocaleString?.() || 'Updated'}`);
      }
      if (d.location !== undefined) {
        changes.push(`Location: ${updated.location || 'TBD'}`);
      }
      if (d.title !== undefined && d.title !== game.title) {
        changes.push(`Title: ${updated.title || 'Updated event'}`);
      }

      if (event && changes.length > 0) {
        const eventRsvps = await prisma.eventRsvp.findMany({
          where: { event_id: event.id },
          select: {
            user: {
              select: {
                id: true,
                email: true,
                display_name: true,
              },
            },
          },
          take: 5000,
        });

        for (const rsvp of eventRsvps) {
          if (!rsvp.user?.email || rsvp.user.id === req.user.id) continue;
          sendEventUpdatedEmail({
            to: rsvp.user.email,
            attendeeName: rsvp.user.display_name || undefined,
            eventTitle: updated.title || game.title || 'Event',
            changes,
            newDate: updated.date,
            newLocation: updated.location,
            timezone: updated.timezone ?? null,
          }).catch(err =>
            console.warn('[games] event update email failed:', (err as any)?.message || err)
          );
        }
      }

      const { events, ...rest } = updated as any;
      await invalidateGamesListCache();
      return res.json({ ...rest, event_id: event?.id ?? null });
    } catch (error) {
      console.error('Error updating game:', error);
      return sendError(res, 500, 'Failed to update game');
    }
  })
);

// Approve or reject event
gamesRouter.get(
  '/:id/approve',
  asyncHandler(async (req: AuthedRequest, res: Response) =>
    handleGameTokenReview(req, res, 'approve')
  )
);
gamesRouter.post(
  '/:id/approve',
  asyncHandler(async (req: AuthedRequest, res: Response) =>
    handleGameTokenReview(req, res, 'approve')
  )
);
gamesRouter.put(
  '/:id/approve',
  requireAuth as any,
  requireVerified as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      if (!req.user) return sendError(res, 401, 'Unauthorized');
      const actingUserId = req.user.id;

      const id = String(req.params.id);
      const schema = z.object({
        approval_status: z.enum(['approved', 'rejected']),
      });

      const parsed = schema.safeParse(req.body || {});
      if (!parsed.success)
        return sendError(res, 400, 'Invalid payload', {
          details: parsed.error.issues.map(i => ({ path: i.path, message: i.message })),
        });

      // Get the game to check permissions
      const game = await (prisma.game.findUnique as any)({
        where: { id },
        select: {
          id: true,
          title: true,
          home_team_id: true,
          away_team_id: true,
          approval_status: true,
          created_by_id: true,
        },
      });

      if (!game) return sendError(res, 404, 'Event not found');

      // IDOR guard: a reviewer must never approve/reject a game they created,
      // even with manage rights. Mirrors approveAd + the events guard. Coaches
      // auto-approve their own games on create, so a pending self-created game
      // shouldn't arise — this is defense-in-depth against that ever changing.
      if (game.created_by_id && game.created_by_id === actingUserId) {
        return sendError(res, 403, 'You cannot review your own event');
      }

      // Check if user is coach/manager of either the home or away team,
      // or an owner/manager of the organization that owns either team.
      const gameTeamIds = [game.home_team_id, game.away_team_id].filter(Boolean) as string[];
      const canApprove = await canManageAnyTeam(req.user.id, gameTeamIds);

      const isAdmin = await getIsAdmin(req as any);

      if (!canApprove && !isAdmin) {
        return res
          .status(403)
          .json({ error: 'Only coaches, org admins, and platform admins can approve events' });
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

      // Central audit trail — the in-app approve path must land in
      // AdminActivityLog too, not just the email-token path (parity with
      // coach/org/ad approvals).
      const reviewerEmail =
        (await prisma.user.findUnique({ where: { id: actingUserId }, select: { email: true } }))
          ?.email || 'unknown';
      await logAdminActivity(
        actingUserId,
        reviewerEmail,
        parsed.data.approval_status === 'approved' ? 'APPROVE_GAME' : 'REJECT_GAME',
        'game',
        id,
        `${parsed.data.approval_status === 'approved' ? 'Approved' : 'Rejected'} game: ${
          game.title || id
        }`
      ).catch(err => console.error('[games] AdminActivityLog write failed:', err));

      return res.json(result.game);
    } catch (err) {
      console.error('[games] approve error:', err);
      return sendError(res, 500, 'Internal server error');
    }
  })
);

gamesRouter.get(
  '/:id/reject',
  asyncHandler(async (req: AuthedRequest, res: Response) =>
    handleGameTokenReview(req, res, 'reject')
  )
);
gamesRouter.post(
  '/:id/reject',
  asyncHandler(async (req: AuthedRequest, res: Response) =>
    handleGameTokenReview(req, res, 'reject')
  )
);

// Opponent-approval decision: the opposing team's staff (canManageTeam — the
// authorized-user "approve/deny events" function) confirms or declines a game
// a coach proposed against their team. Independent of approval_status
// (platform moderation); see OpponentApprovalStatus in schema.prisma.
gamesRouter.post(
  '/:id/opponent-approval',
  requireAuth as any,
  requireVerified as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return sendError(res, 401, 'Unauthorized');
    const actingUserId = req.user.id;
    const id = String(req.params.id);

    const schema = z.object({
      decision: z.enum(['approve', 'decline']),
      reason: z.string().trim().max(2000).optional(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success)
      return sendError(res, 400, 'Invalid payload', {
        details: parsed.error.issues.map(i => ({ path: i.path, message: i.message })),
      });

    const game = await prisma.game.findUnique({
      where: { id },
      select: {
        id: true,
        title: true,
        date: true,
        created_by_id: true,
        opponent_approval_status: true,
        opponent_approval_team_id: true,
      },
    });
    if (!game) return sendError(res, 404, 'Game not found');
    if (!game.opponent_approval_team_id) {
      return sendError(res, 400, 'This game does not require opponent approval');
    }

    // IDOR guard: the proposing coach can never decide their own proposal —
    // canManageTeam against the OPPONENT team already excludes them by
    // construction (they don't manage the opponent side), but this is
    // defense-in-depth in case a user manages both teams somehow.
    if (game.created_by_id && game.created_by_id === actingUserId) {
      return sendError(res, 403, 'You cannot review your own game request');
    }

    const canDecide = await canManageTeamScoped(actingUserId, game.opponent_approval_team_id);
    if (!canDecide) {
      return sendError(res, 403, 'Only the opponent team staff can review this game request');
    }

    const isApprove = parsed.data.decision === 'approve';
    const decidedAt = new Date();
    const updatedGame = await prisma.$transaction(async tx => {
      const transition = await tx.game.updateMany({
        where: { id, opponent_approval_status: 'pending' },
        data: {
          opponent_approval_status: (isApprove ? 'approved' : 'declined') as any,
          opponent_approved_by_id: isApprove ? actingUserId : null,
          opponent_approved_at: isApprove ? decidedAt : null,
          opponent_declined_reason: isApprove ? null : parsed.data.reason || null,
        },
      });
      if (transition.count === 0) return null;
      return tx.game.findUnique({ where: { id } });
    });

    if (!updatedGame) {
      return sendError(res, 409, 'This game request was already decided');
    }
    await invalidateGamesListCache();

    if (game.created_by_id) {
      try {
        const { sendPushNotification } = await import('../lib/notifications.js');
        if (isApprove) {
          await prisma.notification.create({
            data: {
              user_id: game.created_by_id,
              actor_id: actingUserId,
              type: 'GAME_OPPONENT_APPROVED' as any,
              meta: { game_id: id, title: game.title },
            },
          });
          sendPushNotification(
            game.created_by_id,
            'Game confirmed!',
            `Your opponent confirmed "${game.title}" — it's now live.`,
            { type: 'game_opponent_approved', game_id: id }
          ).catch(() => {});
        } else {
          await prisma.notification.create({
            data: {
              user_id: game.created_by_id,
              actor_id: actingUserId,
              type: 'GAME_OPPONENT_DECLINED' as any,
              meta: { game_id: id, title: game.title, reason: parsed.data.reason || undefined },
            },
          });
          sendPushNotification(
            game.created_by_id,
            'Game declined',
            `Your opponent declined "${game.title}".${parsed.data.reason ? ` Reason: ${parsed.data.reason}` : ''}`,
            { type: 'game_opponent_declined', game_id: id }
          ).catch(() => {});
        }
      } catch (notifErr) {
        console.warn('[games] opponent-approval decision notification failed:', notifErr);
      }
    }

    return res.json(updatedGame);
  })
);
