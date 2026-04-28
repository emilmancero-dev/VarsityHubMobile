import { Router } from 'express';
import { z } from 'zod';
import {
  buildCoachJoinRequestReviewUrl,
  sendOrganizationInviteEmail,
  sendLeagueApprovalRequestEmail,
  sendCoachApprovedEmail,
  sendCoachRejectedEmail,
  sendCoachJoinRequestEmail,
} from '../lib/email.js';
import { sendPushNotification } from '../lib/notifications.js';
import { prisma } from '../lib/prisma.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireVerified } from '../middleware/requireVerified.js';
import { requireAdmin, isEmailAdmin } from '../middleware/requireAdmin.js';
import { debugLog } from '../lib/debugLog.js';
import escapeHtml from 'escape-html';
import { inviteLimiter, organizationsNearbyLimiter } from '../middleware/rateLimiters.js';
import { requireOnboarded } from '../middleware/requireOnboarded.js';
import { getAuthorizedUsersOrgLimit } from '../lib/planLimits.js';
import { consumeReviewToken, signReviewToken, verifyReviewToken } from '../lib/reviewTokens.js';
import { registerIdValidation } from '../middleware/validateParams.js';
import { approveOrganization, rejectOrganization } from '../lib/approvalService.js';
import { getLatestCoachApplication } from '../lib/coachApplications.js';
import { logAdminActivity } from '../lib/adminActivityLogger.js';
import { invalidateMeCacheForUser } from '../lib/userCache.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { serializeOrganization } from '../lib/serializeOrganization.js';
import { addBreadcrumb, captureException } from '../lib/sentry.js';
import { redactEmail } from '../lib/logRedaction.js';
import {
  buildAuthStateColumns,
  getCanonicalUserRole,
  getPreferencesObject,
  mergeAuthStateIntoPreferences,
} from '../lib/userAuthState.js';
import {
  buildBillingStateColumns,
  getEffectiveEntitledPlan,
} from '../lib/userBillingState.js';

export const organizationsRouter = Router();
registerIdValidation(organizationsRouter);

function reportApprovalNotificationFailure(
  channel: 'email' | 'push' | 'in_app',
  context: string,
  err: unknown,
  extra: Record<string, unknown>,
): void {
  console.error(`[organizations] ${context} ${channel} failed:`, (err as any)?.message || err);
  captureException(err instanceof Error ? err : new Error(String(err)), {
    context,
    notification_channel: channel,
    ...extra,
  });
}

// ---------------------------------------------
// Duplicate Detection & Admin Helpers
// ---------------------------------------------

// Normalize organization names to detect near-duplicates across org_type variants.
// Strategy: lowercase, replace common abbreviations, strip punctuation/spaces, drop trailing generic terms.
function normalizeOrganizationName(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\bst\.?\b/g, 'saint')
    .replace(/\bhs\b/g, 'highschool')
    .replace(/\bhigh school\b/g, 'highschool')
    .replace(/\bclub\b/g, '')
    .replace(/\bleague\b/g, '')
    .replace(/\bschool\b/g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

type OrganizationCreatePayload = {
  name: string;
  description?: string;
  sport?: string;
  org_type?: string;
  location?: string;
  zip_code?: string;
  season_start?: string;
  season_end?: string;
  supporting_document_url?: string;
};

function buildOrganizationCreateData(
  input: OrganizationCreatePayload,
  ownerId: string,
  options?: {
    adminApproved?: boolean;
  }
) {
  const adminApproved = options?.adminApproved === true;
  // Explicitly map DB-owned organization fields so middleware-only request keys
  // such as `onboarding` can never drift into Prisma writes via object spread.
  return {
    name: input.name,
    description: input.description,
    sport: input.sport,
    org_type: input.org_type,
    location: input.location,
    zip_code: input.zip_code,
    supporting_document_url: input.supporting_document_url,
    season_start: input.season_start ? new Date(input.season_start) : null,
    season_end: input.season_end ? new Date(input.season_end) : null,
    updated_at: new Date(),
    league_owner_id: ownerId,
    admin_approved: adminApproved,
    approved_at: adminApproved ? new Date() : null,
  };
}

// Determine if a membership role is considered an administrator of the organization.
function isOrganizationAdmin(role: string | null | undefined): boolean {
  if (!role) return false;
  return role === 'owner' || role === 'manager';
}

function buildPendingCoachPreferences(
  currentPrefs: unknown,
  organization: { id: string; name: string }
): Record<string, any> {
  const next = mergeAuthStateIntoPreferences(getPreferencesObject(currentPrefs), {
    role: 'coach',
    organization_id: organization.id,
  });
  next.organization_name = organization.name;
  next.join_request_pending = true;
  return next;
}

function buildPendingLeagueOwnerPreferences(
  currentPrefs: unknown,
  organization: { id: string; name: string }
): Record<string, any> {
  const next = mergeAuthStateIntoPreferences(getPreferencesObject(currentPrefs), {
    role: 'coach',
    organization_id: organization.id,
  });
  next.organization_name = organization.name;
  next.join_request_pending = false;
  return next;
}

async function shouldForcePendingApprovalOnOrganizationCreate(params: {
  userId: string;
  approvalStatus?: string | null;
  onboarding?: boolean;
}): Promise<boolean> {
  // Force PENDING when the user isn't already APPROVED — they need admin
  // sign-off before any org goes live.
  if (String(params.approvalStatus || '').toUpperCase() !== 'APPROVED') return true;

  // Force PENDING for legacy coaches who never went through the
  // CoachApplication flow — admin still needs to vouch for the new org.
  // Coaches who already have an approved CoachApplication keep their
  // APPROVED status across additional org creates (the application is
  // the canonical approval surface; subsequent orgs are just workspaces).
  // The onboarding flag is no longer load-bearing — `onboarding: true`
  // requests previously short-circuited to PENDING regardless of
  // application state, demoting already-approved coaches who created
  // their org outside the onboarding flow.
  const latestApplication = await getLatestCoachApplication(prisma as any, params.userId);
  return latestApplication?.status !== 'approved';
}

function buildApprovedCoachPreferences(params: {
  currentPrefs: unknown;
  organization: { id: string; name: string };
  teamId?: string | null;
  teamName?: string | null;
}): Record<string, any> {
  const next = mergeAuthStateIntoPreferences(getPreferencesObject(params.currentPrefs), {
    role: 'coach',
    organization_id: params.organization.id,
    proceeding_as_fan: false,
  }) as Record<string, any>;
  next.organization_name = params.organization.name;
  next.join_request_pending = false;

  if (params.teamId) next.team_id = params.teamId;
  if (params.teamName) next.team_name = params.teamName;

  delete next.pending_plan;
  delete next.payment_pending;
  delete next.payment_approved;

  return next;
}

function buildRejectedCoachPreferences(params: {
  currentPrefs: unknown;
  organization?: { id: string; name: string } | null;
}): Record<string, any> {
  const next = mergeAuthStateIntoPreferences(getPreferencesObject(params.currentPrefs), {
    role: 'coach',
  }) as Record<string, any>;
  next.join_request_pending = false;

  if (params.organization) {
    next.organization_id = params.organization.id;
    next.organization_name = params.organization.name;
  }

  delete next.team_id;
  delete next.team_name;

  return next;
}

async function isCurrentUserPlatformAdmin(req: AuthedRequest): Promise<boolean> {
  if (!req.user?.id) return false;
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { email: true, email_verified: true },
  });
  return !!user?.email_verified && isEmailAdmin(user?.email);
}

const LEAGUE_APPROVAL_TOKEN_TTL = '48h';

async function getPlatformAdminSession(req: AuthedRequest) {
  if (!req.user?.id) return null;
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { id: true, email: true, email_verified: true },
  });
  if (!user?.email_verified || !isEmailAdmin(user.email)) return null;
  return user;
}

function renderAdminLoginRequiredPage(action: 'approve' | 'reject', organizationName: string) {
  const verb = action === 'approve' ? 'approve' : 'reject';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin Sign-In Required</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:560px;margin:60px auto;padding:20px;text-align:center;">
<h2>Admin sign-in required</h2>
<p>You must be signed in as a verified VarsityHub platform admin to ${verb} <strong>${escapeHtml(organizationName || 'this league')}</strong>.</p>
<p>Open this link from an authenticated admin session, then confirm the action.</p>
</body></html>`;
}

// List organizations (public, with optional search)
organizationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    try {
      const authedReq = req as AuthedRequest;
      const currentUserId = authedReq.user?.id ?? null;
      const isAdminUser = await isCurrentUserPlatformAdmin(authedReq);
      const q = String((req.query as any).q || '').trim();
      const limit = Math.max(
        1,
        Math.min(parseInt(String((req.query as any).limit || '20'), 10) || 20, 50)
      );

      const where: any = q ? { name: { startsWith: q, mode: 'insensitive' } } : {};
      if (!isAdminUser) {
        if (currentUserId) {
          where.OR = [
            { admin_approved: true },
            { memberships: { some: { user_id: currentUserId, status: 'active' } } },
            { joinRequests: { some: { user_id: currentUserId, status: 'pending' } } },
          ];
        } else {
          where.admin_approved = true;
        }
      }

      const organizations = await prisma.organization.findMany({
        where,
        take: limit,
        orderBy: { created_at: 'desc' },
        select: {
          id: true,
          name: true,
          description: true,
          logo_url: true,
          profile_picture_url: true,
          background_url: true,
          admin_approved: true,
          sport: true,
          org_type: true,
          location: true,
          zip_code: true,
          season_start: true,
          season_end: true,
          status: true,
          contact_info: true,
          created_at: true,
          _count: {
            select: {
              memberships: true,
              teams: true,
            },
          },
        },
      });

      return res.json(
        organizations.map(organization =>
          serializeOrganization(organization, { includeCounts: true })
        )
      );
    } catch (err) {
      console.error('[organizations] GET / error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// List organizations where current user has admin access
organizationsRouter.get(
  '/mine',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const orgs = await prisma.organization.findMany({
        where: {
          memberships: {
            some: {
              user_id: req.user!.id,
              role: { in: ['owner', 'manager'] },
              status: 'active',
            },
          },
        },
        take: 50,
        orderBy: { created_at: 'desc' },
        select: {
          id: true,
          name: true,
          description: true,
          logo_url: true,
          profile_picture_url: true,
          background_url: true,
          sport: true,
          org_type: true,
          location: true,
          zip_code: true,
          season_start: true,
          season_end: true,
          status: true,
          admin_approved: true,
          contact_info: true,
          created_at: true,
          _count: {
            select: {
              memberships: true,
              teams: true,
            },
          },
        },
      });
      return res.json(
        orgs.map(organization =>
          serializeOrganization(organization, {
            includeCounts: true,
          })
        )
      );
    } catch (err) {
      console.error('[organizations] GET /mine error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// Update organization (admin only)
// H3: zip_code aligned with ads — 5-digit US format when provided
const updateOrgSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2000).optional().nullable(),
  logo_url: z
    .string()
    .url()
    .max(2000)
    .refine(
      url => {
        try {
          const h = new URL(url).hostname;
          return ['res.cloudinary.com', 'varsityhub.app', 'cdn.varsityhub.app'].some(d =>
            h.endsWith(d)
          );
        } catch {
          return false;
        }
      },
      { message: 'Image URL must be from an allowed domain' }
    )
    .optional()
    .nullable(),
  profile_picture_url: z
    .string()
    .url()
    .max(2000)
    .refine(
      url => {
        try {
          const h = new URL(url).hostname;
          return ['res.cloudinary.com', 'varsityhub.app', 'cdn.varsityhub.app'].some(d =>
            h.endsWith(d)
          );
        } catch {
          return false;
        }
      },
      { message: 'Image URL must be from an allowed domain' }
    )
    .optional()
    .nullable(),
  background_url: z
    .string()
    .url()
    .max(2000)
    .refine(
      url => {
        try {
          const h = new URL(url).hostname;
          return ['res.cloudinary.com', 'varsityhub.app', 'cdn.varsityhub.app'].some(d =>
            h.endsWith(d)
          );
        } catch {
          return false;
        }
      },
      { message: 'Image URL must be from an allowed domain' }
    )
    .optional()
    .nullable(),
  sport: z.string().max(100).optional().nullable(),
  org_type: z.string().max(50).optional().nullable(),
  location: z.string().max(500).optional().nullable(),
  zip_code: z
    .string()
    .regex(/^\d{5}$/, 'Must be a 5-digit US zip code')
    .optional()
    .nullable(),
  contact_info: z.string().max(500).optional().nullable(),
});

organizationsRouter.patch(
  '/:id',
  requireAuth as any,
  requireVerified as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const orgId = String(req.params.id);
      const userId = req.user!.id;

      // Verify user is org admin
      const membership = await prisma.organizationMembership.findFirst({
        where: {
          organization_id: orgId,
          user_id: userId,
          status: 'active',
          role: { in: ['owner', 'manager'] },
        },
      });
      if (!membership)
        return res
          .status(403)
          .json({ error: 'Only organization admins can edit this organization.' });

      const parsed = updateOrgSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ error: 'Invalid payload', issues: parsed.error.issues });

      const data = parsed.data;

      const updated = await prisma.organization.update({
        where: { id: orgId },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.logo_url !== undefined && { logo_url: data.logo_url }),
          ...(data.profile_picture_url !== undefined && {
            profile_picture_url: data.profile_picture_url,
          }),
          ...(data.background_url !== undefined && { background_url: data.background_url }),
          ...(data.sport !== undefined && { sport: data.sport }),
          ...(data.org_type !== undefined && { org_type: data.org_type }),
          ...(data.location !== undefined && { location: data.location }),
          ...(data.zip_code !== undefined && { zip_code: data.zip_code }),
          ...(data.contact_info !== undefined && { contact_info: data.contact_info }),
        },
        select: {
          id: true,
          name: true,
          description: true,
          logo_url: true,
          profile_picture_url: true,
          background_url: true,
          sport: true,
          org_type: true,
          location: true,
          zip_code: true,
          contact_info: true,
        },
      });
      return res.json(serializeOrganization(updated));
    } catch (err: any) {
      if (err?.code === 'P2002')
        return res
          .status(409)
          .json({ error: 'An organization with that name already exists in this area.' });
      console.error('[organizations] PATCH /:id error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// Follow an organization
organizationsRouter.post(
  '/:id/follow',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const userId = req.user!.id;
      const orgId = String(req.params.id);
      const org = await prisma.organization.findUnique({ where: { id: orgId } });
      if (!org) return res.status(404).json({ error: 'Organization not found' });
      try {
        await prisma.organizationFollow.create({
          data: { user_id: userId, organization_id: orgId },
        });
        return res.status(201).json({ is_following: true });
      } catch (e: any) {
        if (e?.code === 'P2002') return res.status(201).json({ is_following: true });
        throw e;
      }
    } catch (err) {
      console.error('[organizations] POST /:id/follow error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// Unfollow an organization
organizationsRouter.delete(
  '/:id/follow',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const userId = req.user!.id;
      const orgId = String(req.params.id);
      await prisma.organizationFollow.deleteMany({
        where: { user_id: userId, organization_id: orgId },
      });
      return res.json({ is_following: false });
    } catch (err) {
      console.error('[organizations] DELETE /:id/follow error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// NOTE: GET /:id moved to bottom of file to avoid shadowing literal routes
// like /invites/me, /search/nearby, /join-requests/me

// Get organization members (requires auth + membership or admin)
organizationsRouter.get(
  '/:id/members',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const id = String(req.params.id);
      const organization = await prisma.organization.findUnique({ where: { id } });
      if (!organization) return res.status(404).json({ error: 'Organization not found' });

      // Caller must be a member of this org or a platform admin
      const callerMembership = await prisma.organizationMembership.findUnique({
        where: { organization_id_user_id: { organization_id: id, user_id: req.user!.id } as any },
      });
      if (!callerMembership) {
        const caller = await prisma.user.findUnique({
          where: { id: req.user!.id },
          select: { email: true },
        });
        if (!isEmailAdmin(caller?.email)) {
          return res.status(403).json({ error: 'You must be a member of this organization' });
        }
      }

      const members = await prisma.organizationMembership.findMany({
        where: { organization_id: id, status: 'active' },
        take: 500,
        include: {
          user: {
            select: {
              id: true,
              display_name: true,
              username: true,
              avatar_url: true,
              preferences: true,
            },
          },
        },
        orderBy: { created_at: 'desc' },
      });

      const list = members.map(m => {
        const user = (m as any).user;
        const prefs = (user?.preferences || {}) as any;
        return {
          ...m,
          user: {
            id: user?.id,
            display_name: user?.display_name,
            username: user?.username,
            avatar_url: user?.avatar_url,
            is_parent: prefs?.is_parent === true,
          },
        };
      });

      return res.json(list);
    } catch (err) {
      console.error('[organizations] GET /:id/members error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// H3: zip_code aligned with ads — 5-digit US format when provided
const createOrganizationSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  sport: z.string().max(100).optional(),
  org_type: z.string().max(100).optional(),
  location: z.string().max(255).optional(),
  formatted_address: z.string().max(500).optional(),
  place_id: z.string().max(255).optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  zip_code: z
    .string()
    .regex(/^\d{5}$/, 'Must be a 5-digit US zip code')
    .optional(),
  season_start: z.string().optional(),
  season_end: z.string().optional(),
  supporting_document_url: z.string().url({ message: 'Supporting document is required' }),
  onboarding: z.boolean().optional(), // bypass requireVerified during onboarding
});

// Create organization
organizationsRouter.post(
  '/',
  requireAuth as any,
  requireVerified as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const parsed = createOrganizationSchema.safeParse(req.body);
      if (!parsed.success) {
        // v1.0.3: return the Zod issues so the client can show WHICH field
        // failed validation. The bare "Invalid payload" response caused an
        // entire session of "Failed to create page — something went wrong"
        // with no way for users OR support to diagnose missing fields
        // (most commonly: supporting_document_url null after a silent upload
        // failure).
        return res.status(400).json({
          error: 'Invalid payload',
          code: 'VALIDATION_FAILED',
          issues: parsed.error.issues.map(i => ({
            path: i.path,
            message: i.message,
          })),
        });
      }

      // v1.0.2: 48hr cooldown if prior application was rejected (mirrors POST /create).
      const REJECTION_COOLDOWN_MS = 48 * 60 * 60 * 1000;
      const applicant = await prisma.user.findUnique({
        where: { id: req.user!.id },
        select: {
          approval_status: true,
          rejected_at: true,
          rejection_reason: true,
          preferences: true,
          role: true,
        },
      });
      const applicantPrefs = getPreferencesObject(applicant?.preferences);
      if (getCanonicalUserRole(applicant as any) !== 'coach') {
        return res.status(403).json({ error: 'Only coach accounts can create organizations.' });
      }
      // v1.0.2 pass 4: backfill rejected_at for legacy REJECTED users so they can't bypass cooldown.
      if (applicant?.approval_status === 'REJECTED') {
        let rejectedAt = applicant.rejected_at;
        if (!rejectedAt) {
          rejectedAt = new Date();
          await prisma.user.update({
            where: { id: req.user!.id },
            data: { rejected_at: rejectedAt },
          });
          await invalidateMeCacheForUser(req.user!.id);
        }
        const elapsed = Date.now() - new Date(rejectedAt).getTime();
        if (Number.isFinite(elapsed) && elapsed < REJECTION_COOLDOWN_MS) {
          const retryAfterMs = REJECTION_COOLDOWN_MS - elapsed;
          return res.status(429).json({
            error:
              'Your previous application was declined. Please wait before creating another organization.',
            code: 'REJECTION_COOLDOWN',
            retry_after_ms: retryAfterMs,
            retry_after_hours: Math.ceil(retryAfterMs / (60 * 60 * 1000)),
            reason: applicant.rejection_reason || null,
          });
        }
      }

      const data = parsed.data;
      const shouldForcePendingApproval = await shouldForcePendingApprovalOnOrganizationCreate({
        userId: req.user!.id,
        approvalStatus: applicant?.approval_status,
        onboarding: data.onboarding,
      });
      // Duplicate guard: when zip_code is provided scope to that area; otherwise skip the
      // full-table scan (no zip_code means we can't reliably detect cross-area duplicates and
      // `zip_code: undefined` in a Prisma where clause removes the filter entirely, causing a
      // scan of ALL organizations).
      const nm = normalizeOrganizationName(data.name);
      let dup: { id: string; name: string } | null = null;
      if (data.zip_code) {
        const sameZipOrgs = await prisma.organization.findMany({
          where: { zip_code: data.zip_code, status: 'active' },
          select: { id: true, name: true },
          take: 100,
        });
        dup = sameZipOrgs.find(o => normalizeOrganizationName(o.name) === nm) ?? null;
      }
      if (dup) {
        return res
          .status(409)
          .json({ error: 'DUPLICATE_ORGANIZATION', duplicate_of: { id: dup.id, name: dup.name } });
      }
      // Transaction: create org + owner membership + update coach state atomically.
      // Legacy coach flows still move to PENDING here; coaches with an already-approved
      // CoachApplication keep their approved status during final setup.
      const preserveApprovedFinalSetup = !shouldForcePendingApproval;
      const organization = await prisma.$transaction(async tx => {
        const org = await tx.organization.create({
          data: buildOrganizationCreateData(data, req.user!.id, {
            adminApproved: preserveApprovedFinalSetup,
          }),
        });
        await tx.organizationMembership.create({
          data: {
            organization_id: org.id,
            user_id: req.user!.id,
            role: 'owner',
          },
        });
        // Preserve legacy pending behavior unless an approved coach application
        // already moved this coach through the new final-setup path.
        await tx.user.update({
          where: { id: req.user!.id },
          data: {
            preferences: buildPendingLeagueOwnerPreferences(applicantPrefs, {
              id: org.id,
              name: org.name,
            }),
            ...buildAuthStateColumns({
              role: 'coach',
              organization_id: org.id,
            }),
            ...(shouldForcePendingApproval ? { approval_status: 'PENDING' } : {}),
            paid_by_owner: false,
            // v1.0.2: clear prior rejection tracking on a fresh application
            rejected_at: null,
            rejection_reason: null,
          },
        });
        return org;
      });
      await invalidateMeCacheForUser(req.user!.id);

      // Send approval request email to super admin (best effort)
      const creator = await prisma.user.findUnique({
        where: { id: req.user!.id },
        select: { display_name: true, email: true },
      });
      if (shouldForcePendingApproval) {
        const approveToken = signReviewToken(
          { orgId: organization.id, action: 'approve_league' },
          LEAGUE_APPROVAL_TOKEN_TTL
        );
        const rejectToken = signReviewToken(
          { orgId: organization.id, action: 'reject_league' },
          LEAGUE_APPROVAL_TOKEN_TTL
        );
        sendLeagueApprovalRequestEmail({
          leagueId: organization.id,
          leagueName: organization.name,
          ownerName: creator?.display_name || 'Unknown',
          ownerEmail: creator?.email || '',
          sport: data.sport,
          orgType: data.org_type,
          approveToken,
          rejectToken,
          supportingDocumentUrl: data.supporting_document_url,
        })
          .then(sent => {
            if (!sent) {
              console.warn(
                '[organizations] League approval request email reported unsent (/). Check mail provider config.'
              );
            }
          })
          .catch(err => {
            console.warn('[organizations] Failed sending league approval request email (/):', err);
          });
      }

      return res.status(201).json(organization);
    } catch (err) {
      console.error('[organizations] POST / error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// H3: zip_code aligned with ads — 5-digit US format when provided
const createOrganizationWithTeamsSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  sport: z.string().max(100).optional(),
  org_type: z.string().max(100).optional(),
  location: z.string().max(255).optional(),
  formatted_address: z.string().max(500).optional(),
  place_id: z.string().max(255).optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  zip_code: z
    .string()
    .regex(/^\d{5}$/, 'Must be a 5-digit US zip code')
    .optional(),
  season_start: z.string().optional(),
  season_end: z.string().optional(),
  supporting_document_url: z.string().url({ message: 'Supporting document is required' }),
  onboarding: z.boolean().optional(),
  authorized_users: z
    .array(
      z.object({
        email: z.string().email().optional(),
        user_id: z.string().optional(),
        role: z.string().optional(),
        assign_team: z.string().optional(),
      })
    )
    .optional(),
});

// Enhanced create organization for onboarding
organizationsRouter.post(
  '/create',
  requireAuth as any,
  requireVerified as any,
  // Align with the canonical POST /organizations route (line 630). The legacy
  // /create variant previously omitted requireOnboarded and relied on inline
  // role + rejection-cooldown checks in the handler body. Those inline checks
  // remain as defense-in-depth, but middleware alignment removes the asymmetric
  // gate-chain that's historically been how regressions reappear (the two
  // routes drift when someone updates one and not the other).
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const parsed = createOrganizationWithTeamsSchema.safeParse(req.body);
      if (!parsed.success) {
        // v1.0.3: return Zod issues so client can render actionable errors.
        return res.status(400).json({
          error: 'Invalid payload',
          code: 'VALIDATION_FAILED',
          issues: parsed.error.issues.map(i => ({
            path: i.path,
            message: i.message,
          })),
        });
      }

      // v1.0.2: 48hr cooldown for users whose prior org application was rejected.
      const REJECTION_COOLDOWN_MS = 48 * 60 * 60 * 1000;
      const applicant = await prisma.user.findUnique({
        where: { id: req.user!.id },
        select: {
          approval_status: true,
          rejected_at: true,
          rejection_reason: true,
          preferences: true,
          role: true,
        },
      });
      const applicantPrefs = getPreferencesObject(applicant?.preferences);
      if (getCanonicalUserRole(applicant as any) !== 'coach') {
        return res.status(403).json({ error: 'Only coach accounts can create organizations.' });
      }
      // v1.0.2 pass 4: backfill rejected_at for legacy REJECTED users so they can't bypass cooldown.
      if (applicant?.approval_status === 'REJECTED') {
        let rejectedAt = applicant.rejected_at;
        if (!rejectedAt) {
          rejectedAt = new Date();
          await prisma.user.update({
            where: { id: req.user!.id },
            data: { rejected_at: rejectedAt },
          });
          await invalidateMeCacheForUser(req.user!.id);
        }
        const elapsed = Date.now() - new Date(rejectedAt).getTime();
        if (Number.isFinite(elapsed) && elapsed < REJECTION_COOLDOWN_MS) {
          const retryAfterMs = REJECTION_COOLDOWN_MS - elapsed;
          return res.status(429).json({
            error:
              'Your previous application was declined. Please wait before creating another organization.',
            code: 'REJECTION_COOLDOWN',
            retry_after_ms: retryAfterMs,
            retry_after_hours: Math.ceil(retryAfterMs / (60 * 60 * 1000)),
            reason: applicant.rejection_reason || null,
          });
        }
      }

      const data = parsed.data;
      const shouldForcePendingApproval = await shouldForcePendingApprovalOnOrganizationCreate({
        userId: req.user!.id,
        approvalStatus: applicant?.approval_status,
        onboarding: data.onboarding,
      });
      // Duplicate guard (same logic as simple create)
      const nm = normalizeOrganizationName(data.name);
      const duplicateWhere: any = { status: 'active' };
      if (data.zip_code) duplicateWhere.zip_code = data.zip_code;
      const possibleDuplicates = await prisma.organization.findMany({
        where: duplicateWhere,
        select: { id: true, name: true, zip_code: true },
        take: 100,
      });
      const dup = possibleDuplicates.find(o => normalizeOrganizationName(o.name) === nm);
      if (dup) {
        return res
          .status(409)
          .json({ error: 'DUPLICATE_ORGANIZATION', duplicate_of: { id: dup.id, name: dup.name } });
      }
      // Transaction: create org + owner membership + update league owner atomically.
      // Legacy flows still move to PENDING here; approved CoachApplication users
      // keep their approval while attaching the real organization during final setup.
      const preserveApprovedFinalSetup = !shouldForcePendingApproval;
      const organization = await prisma.$transaction(async tx => {
        const org = await tx.organization.create({
          data: buildOrganizationCreateData(data, req.user!.id, {
            adminApproved: preserveApprovedFinalSetup,
          }),
        });
        await tx.organizationMembership.create({
          data: {
            organization_id: org.id,
            user_id: req.user!.id,
            role: 'owner',
          },
        });
        await tx.user.update({
          where: { id: req.user!.id },
          data: {
            preferences: buildPendingLeagueOwnerPreferences(applicantPrefs, {
              id: org.id,
              name: org.name,
            }),
            ...buildAuthStateColumns({
              role: 'coach',
              organization_id: org.id,
            }),
            ...(shouldForcePendingApproval ? { approval_status: 'PENDING' } : {}),
            paid_by_owner: false,
            // v1.0.2: clear prior rejection tracking on a fresh application
            rejected_at: null,
            rejection_reason: null,
          },
        });
        return org;
      });
      await invalidateMeCacheForUser(req.user!.id);

      // Send approval request email to super admin (best effort)
      const creator = await prisma.user.findUnique({
        where: { id: req.user!.id },
        select: { display_name: true, email: true },
      });
      if (shouldForcePendingApproval) {
        const approveToken = signReviewToken(
          { orgId: organization.id, action: 'approve_league' },
          LEAGUE_APPROVAL_TOKEN_TTL
        );
        const rejectToken = signReviewToken(
          { orgId: organization.id, action: 'reject_league' },
          LEAGUE_APPROVAL_TOKEN_TTL
        );
        sendLeagueApprovalRequestEmail({
          leagueId: organization.id,
          leagueName: organization.name,
          ownerName: creator?.display_name || 'Unknown',
          ownerEmail: creator?.email || '',
          sport: data.sport,
          orgType: data.org_type,
          approveToken,
          rejectToken,
          supportingDocumentUrl: data.supporting_document_url,
        })
          .then(sent => {
            if (!sent) {
              console.warn(
                '[organizations] League approval request email reported unsent (/create). Check mail provider config.'
              );
            }
          })
          .catch(err => {
            console.warn(
              '[organizations] Failed sending league approval request email (/create):',
              err
            );
          });
      }

      // Send invites to authorized users
      if (data.authorized_users && data.authorized_users.length > 0) {
        const invites = data.authorized_users
          .filter(user => user.email)
          .map(user => ({
            organization_id: organization.id,
            email: user.email!,
            role: user.role || 'member',
          }));

        if (invites.length > 0) {
          await prisma.organizationInvite.createMany({
            data: invites,
            skipDuplicates: true,
          });
          // Send invite emails (best effort)
          const [inviter, createdInvites] = await Promise.all([
            prisma.user.findUnique({ where: { id: req.user!.id }, select: { display_name: true } }),
            prisma.organizationInvite.findMany({
              where: { organization_id: organization.id, email: { in: invites.map(i => i.email) } },
              select: { id: true, email: true },
              take: invites.length,
            }),
          ]);
          const tokenByEmail = Object.fromEntries(createdInvites.map(i => [i.email, i.id]));
          await Promise.all(
            invites.map(inv =>
              sendOrganizationInviteEmail({
                to: inv.email,
                organizationName: organization.name,
                role: inv.role,
                inviterName: inviter?.display_name || 'An organizer',
                inviteToken: tokenByEmail[inv.email],
              })
                .then(sent => {
                  if (!sent) {
              console.warn(
                '[organizations] Invite email reported unsent for',
                redactEmail(inv.email)
              );
                  }
                  return sent;
                })
                .catch(err => {
            console.warn(
              '[organizations] Failed sending invite email to',
              redactEmail(inv.email),
              err
            );
            // Org owners can't see why X never got their invite — surface
            // failures to Sentry so it's triagable. Return false to keep
            // the bulk-invite flow going.
            captureException(err instanceof Error ? err : new Error(String(err)), {
              context: 'org_invite_email_send_failed',
              provider: 'sendgrid',
            });
                  return false;
                })
            )
          );
        }
      }

      return res.status(201).json(organization);
    } catch (err) {
      console.error('[organizations] POST /create error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

const inviteUserSchema = z.object({
  email: z.string().email(),
  role: z.string().optional(),
});

// Invite user to organization
// Rule B: No plan gate on the inviting user — authorized users are covered by the org owner's plan.
// The plan-based user limit is enforced inside the handler using the org owner's tier.
organizationsRouter.post(
  '/:id/invite',
  requireAuth as any,
  requireVerified as any,
  requireOnboarded as any,
  inviteLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const id = String(req.params.id);
      const parsed = inviteUserSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' });

      const { email, role } = parsed.data;
      const inviteEmail = email.trim().toLowerCase();

      // Validate role against allowed org roles
      const VALID_ORG_INVITE_ROLES = ['manager', 'member'];
      if (role && !VALID_ORG_INVITE_ROLES.includes(role)) {
        return res
          .status(400)
          .json({ error: `Invalid role. Must be one of: ${VALID_ORG_INVITE_ROLES.join(', ')}` });
      }

      // Check if user is a member of the organization
      const membership = await prisma.organizationMembership.findUnique({
        where: { organization_id_user_id: { organization_id: id, user_id: req.user!.id } as any },
      });

      if (!membership || !isOrganizationAdmin(membership.role)) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }
      // PLAN LIMITS: Enforce authorized user caps based on ORG OWNER's plan (Rule B).
      // Authorized users are covered by the coach's plan — never charged individually.
      const ownerMembership = await prisma.organizationMembership.findFirst({
        where: { organization_id: id, role: 'owner', status: 'active' },
        select: { user_id: true },
      });
      const ownerId = ownerMembership?.user_id || req.user!.id;
      const owner = await prisma.user.findUnique({
        where: { id: ownerId },
        select: {
          preferences: true,
          plan: true,
          pending_plan: true,
          payment_pending: true,
          payment_approved: true,
        },
      });
      if (!owner) {
        return res
          .status(404)
          .json({ error: 'Organization owner not found. Please contact support.' });
      }
      const ownerPrefs = (owner.preferences || {}) as any;
      const plan = getEffectiveEntitledPlan(owner as any);

      // Get team count for org-level limit calculation (from org owner's profile)
      const teamCountTotal =
        ownerPrefs.team_count_total ||
        (await prisma.teamMembership.count({
          where: { user_id: ownerId, role: 'owner' },
        }));

      // Get organization-level limit from the owner's plan definitions
      const limit = getAuthorizedUsersOrgLimit(plan, teamCountTotal);

      // Atomic limit check + create to prevent race condition on concurrent invites.
      // v1.0.2 pass 12: promote to Serializable isolation — the default ReadCommitted still
      // permits two parallel invite requests to both pass the count check before either
      // INSERTs, over-counting the authorized-user cap. Serializable forces one to retry.
      const invite = await prisma.$transaction(
        async tx => {
          const existingInvite = await tx.organizationInvite.findFirst({
            where: {
              organization_id: id,
              email: { equals: inviteEmail, mode: 'insensitive' },
            } as any,
            select: { id: true },
          });

          if (limit !== null) {
            const inviteCount = await tx.organizationInvite.count({
              where: {
                organization_id: id,
                status: 'pending',
                ...(existingInvite ? { id: { not: existingInvite.id } } : {}),
              },
            });
            const memberCount = await tx.organizationMembership.count({
              where: { organization_id: id, status: 'active', role: { in: ['manager', 'member'] } },
            });
            const totalAuthorized = inviteCount + memberCount + 1;
            if (totalAuthorized > limit) {
              throw Object.assign(new Error('USER_LIMIT_REACHED'), {
                status: 403,
                body: {
                  error: 'USER_LIMIT_REACHED',
                  message: `Plan limit reached. ${plan} plan allows ${limit} authorized user${limit === 1 ? '' : 's'} for your organization.`,
                  limit,
                  current: totalAuthorized,
                },
              });
            }
          }
          if (existingInvite) {
            return tx.organizationInvite.update({
              where: { id: existingInvite.id },
              data: { email: inviteEmail, role: role || 'member', status: 'pending' },
            });
          }
          return tx.organizationInvite.create({
            data: { organization_id: id, email: inviteEmail, role: role || 'member', status: 'pending' },
          });
        },
        { isolationLevel: 'Serializable' }
      );

      // Send email (best effort)
      const org = await prisma.organization.findUnique({ where: { id }, select: { name: true } });
      const inviter = await prisma.user.findUnique({
        where: { id: req.user!.id },
        select: { display_name: true },
      });
      if (org) {
        await sendOrganizationInviteEmail({
          to: inviteEmail,
          organizationName: org.name,
          role: role || 'member',
          inviterName: inviter?.display_name || 'An organizer',
          inviteToken: invite.id,
        })
          .then(sent => {
            if (!sent) {
              console.warn(
                '[organizations] Direct invite email reported unsent for',
                redactEmail(inviteEmail)
              );
            }
            return sent;
          })
          .catch(err => {
            console.warn(
              '[organizations] Failed sending direct invite email to',
              redactEmail(inviteEmail),
              err
            );
            captureException(err instanceof Error ? err : new Error(String(err)), {
              context: 'org_direct_invite_email_send_failed',
              provider: 'sendgrid',
            });
            return false;
          });
      }

      return res.status(201).json(invite);
    } catch (err: any) {
      if (err?.status && err?.body) {
        return res.status(err.status).json(err.body);
      }
      console.error('[organizations] POST /:id/invite error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// Get my organization invites
organizationsRouter.get(
  '/invites/me',
  requireAuth as any,
  requireVerified as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
      if (!user) return res.status(404).json({ error: 'User not found' });

      const invites = await prisma.organizationInvite.findMany({
        where: { email: { equals: user.email, mode: 'insensitive' }, status: 'pending' } as any,
        include: { organization: true },
        orderBy: { created_at: 'desc' },
        take: 100,
      });

      return res.json(invites);
    } catch (err) {
      console.error('[organizations] GET /invites/me error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// Accept organization invite
organizationsRouter.post(
  '/invites/:inviteId/accept',
  requireAuth as any,
  requireVerified as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const inviteId = String(req.params.inviteId);
      const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
      if (!user) return res.status(404).json({ error: 'User not found' });

      const invite = await prisma.organizationInvite.findUnique({ where: { id: inviteId } });
      if (!invite || invite.status !== 'pending') {
        return res.status(404).json({ error: 'Invite not found or not valid' });
      }
      if (!user.email || user.email.toLowerCase() !== invite.email.toLowerCase()) {
        return res.status(403).json({ error: 'Invite not for this user' });
      }

      const accepted = await prisma.$transaction(async tx => {
        const transition = await tx.organizationInvite.updateMany({
          where: { id: inviteId, status: 'pending' },
          data: { status: 'accepted' },
        });
        if (transition.count === 0) return false;

        await tx.organizationMembership.upsert({
          where: {
            organization_id_user_id: {
              organization_id: invite.organization_id,
              user_id: user.id,
            } as any,
          },
          update: { status: 'active' }, // SECURITY: Only reactivate — never escalate role via invite
          create: {
            organization_id: invite.organization_id,
            user_id: user.id,
            role: invite.role,
            status: 'active',
          },
        });
        return true;
      });
      if (!accepted) return res.status(409).json({ error: 'Invite already processed' });

      // Organization approval welcome email removed — non-mandatory

      return res.json({ message: 'Invite accepted' });
    } catch (err) {
      console.error('[organizations] POST /invites/:inviteId/accept error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// Decline organization invite
organizationsRouter.post(
  '/invites/:inviteId/decline',
  requireAuth as any,
  requireVerified as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const inviteId = String(req.params.inviteId);
      const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
      if (!user) return res.status(404).json({ error: 'User not found' });

      const invite = await prisma.organizationInvite.findUnique({ where: { id: inviteId } });
      if (!invite || invite.status !== 'pending') {
        return res.status(404).json({ error: 'Invite not found or not valid' });
      }
      if (!user.email || user.email.toLowerCase() !== invite.email.toLowerCase()) {
        return res.status(403).json({ error: 'Invite not for this user' });
      }

      const declined = await prisma.organizationInvite.updateMany({
        where: { id: inviteId, status: 'pending' },
        data: { status: 'declined' },
      });
      if (declined.count === 0) return res.status(409).json({ error: 'Invite already processed' });
      return res.json({ message: 'Invite declined' });
    } catch (err) {
      console.error('[organizations] POST /invites/:inviteId/decline error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// ===========================================
// Organization Join Request Endpoints
// ===========================================

// Search organizations by zip code / proximity
organizationsRouter.get(
  '/search/nearby',
  organizationsNearbyLimiter,
  asyncHandler(async (req, res) => {
    try {
      const query = String((req.query as any).query || '').trim();
      const sport = String((req.query as any).sport || '').trim();
      const orgType = String((req.query as any).org_type || '').trim();
      const limit = Math.max(
        1,
        Math.min(parseInt(String((req.query as any).limit || '20'), 10) || 20, 50)
      );

      debugLog('🔍 Organization search request:', { query, sport, orgType, limit });

      if (!query) {
        return res.status(400).json({ error: 'query parameter is required' });
      }

      // Check if query is a zip code (5 digits) or organization name
      const isZipCode = /^\d{5}$/.test(query);

      const where: any = {
        status: 'active',
        OR: isZipCode
          ? [{ zip_code: query }]
          : [
              { name: { contains: query, mode: 'insensitive' } },
              { location: { contains: query, mode: 'insensitive' } },
            ],
      };

      if (sport) where.sport = sport;
      if (orgType) where.org_type = orgType;

      const organizations = await prisma.organization.findMany({
        where,
        take: limit,
        orderBy: { created_at: 'desc' },
        select: {
          id: true,
          name: true,
          description: true,
          sport: true,
          org_type: true,
          location: true,
          zip_code: true,
          created_at: true,
          _count: {
            select: {
              memberships: true,
              teams: true,
            },
          },
        },
      });

      debugLog(`✅ Found ${organizations.length} organizations matching "${query}"`);
      return res.json(organizations);
    } catch (err) {
      console.error('[organizations] GET /search/nearby error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// Check for duplicate organizations using normalized name comparison
organizationsRouter.post(
  '/check-duplicate',
  requireAuth as any,
  asyncHandler(async (req, res) => {
    try {
      const checkDuplicateSchema = z.object({
        name: z.string().min(1).max(200),
        zip_code: z.string().max(20).optional(),
      });
      const parsed = checkDuplicateSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ error: 'Invalid payload', issues: parsed.error.issues });
      const { name, zip_code } = parsed.data;

      const normalizedInput = normalizeOrganizationName(name);
      if (!normalizedInput) {
        return res.json({ exists: false, organization: null });
      }

      // If zip_code provided, check orgs in that zip first
      if (zip_code) {
        const localOrgs = await prisma.organization.findMany({
          where: { zip_code, status: 'active' },
          select: { id: true, name: true, location: true, sport: true },
          take: 200,
        });
        const localMatch = localOrgs.find(
          o => normalizeOrganizationName(o.name) === normalizedInput
        );
        if (localMatch) {
          return res.json({ exists: true, organization: localMatch });
        }
      }

      // Broader name-only scan as fallback (recent 200 active orgs)
      const recentOrgs = await prisma.organization.findMany({
        where: { status: 'active' },
        orderBy: { created_at: 'desc' },
        take: 200,
        select: { id: true, name: true, location: true, sport: true },
      });
      const broadMatch = recentOrgs.find(
        o => normalizeOrganizationName(o.name) === normalizedInput
      );

      return res.json({
        exists: !!broadMatch,
        organization: broadMatch ?? null,
      });
    } catch (err) {
      console.error('[organizations] POST /check-duplicate error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// Create join request
const createJoinRequestSchema = z.object({
  organization_id: z.string(),
  message: z.string().max(500).optional(),
});

organizationsRouter.post(
  '/join-requests',
  requireAuth as any,
  requireVerified as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const parsed = createJoinRequestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' });

      const { organization_id, message } = parsed.data;

      // Check if organization exists
      const organization = await prisma.organization.findUnique({
        where: { id: organization_id },
        include: {
          memberships: {
            where: { role: 'owner' },
            include: {
              user: {
                select: { id: true, email: true, display_name: true },
              },
            },
          },
        },
      });

      if (!organization) {
        return res.status(404).json({ error: 'Organization not found' });
      }

      // Check if user is already a member
      const existingMembership = await prisma.organizationMembership.findUnique({
        where: {
          organization_id_user_id: {
            organization_id,
            user_id: req.user!.id,
          } as any,
        },
      });

      if (existingMembership) {
        return res.status(400).json({ error: 'You are already a member of this organization' });
      }

      // Check for existing pending request
      const existingRequest = await prisma.organizationJoinRequest.findUnique({
        where: {
          organization_id_user_id: {
            organization_id,
            user_id: req.user!.id,
          } as any,
        },
      });

      if (existingRequest && existingRequest.status === 'pending') {
        return res
          .status(400)
          .json({ error: 'You already have a pending request for this organization' });
      }

      // ORG-9: Enforce 7-day cooldown after a rejected join request
      if (existingRequest && existingRequest.status === 'denied' && existingRequest.reviewed_at) {
        const cooldownMs = 7 * 24 * 60 * 60 * 1000; // 7 days
        const timeSinceRejection = Date.now() - new Date(existingRequest.reviewed_at).getTime();
        if (timeSinceRejection < cooldownMs) {
          const daysLeft = Math.ceil((cooldownMs - timeSinceRejection) / (24 * 60 * 60 * 1000));
          return res
            .status(429)
            .json({
              error: `Your previous request was denied. You can re-apply in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`,
            });
        }
      }

      // Check if requester is a coach before the write so we can set PENDING atomically
      const requester = await prisma.user.findUnique({
        where: { id: req.user!.id },
        select: {
          preferences: true,
          role: true,
          approval_status: true,
          rejected_at: true,
          rejection_reason: true,
        },
      });
      const requesterPrefs = getPreferencesObject(requester?.preferences);
      if (getCanonicalUserRole(requester as any) !== 'coach') {
        return res
          .status(403)
          .json({ error: 'Upgrade to a coach account before requesting to join a league.' });
      }
      if (requester?.approval_status === 'REJECTED') {
        const rejectionCooldownMs = 48 * 60 * 60 * 1000;
        let rejectedAt = requester.rejected_at;
        if (!rejectedAt) {
          rejectedAt = new Date();
          await prisma.user.update({
            where: { id: req.user!.id },
            data: { rejected_at: rejectedAt },
          });
          await invalidateMeCacheForUser(req.user!.id);
        }
        const elapsed = Date.now() - new Date(rejectedAt).getTime();
        if (Number.isFinite(elapsed) && elapsed < rejectionCooldownMs) {
          const retryAfterMs = rejectionCooldownMs - elapsed;
          return res.status(429).json({
            error: 'Your previous coach application was declined. Please wait before trying again.',
            code: 'REJECTION_COOLDOWN',
            retry_after_ms: retryAfterMs,
            retry_after_hours: Math.ceil(retryAfterMs / (60 * 60 * 1000)),
            retry_at: new Date(Date.now() + retryAfterMs).toISOString(),
            reason: requester.rejection_reason || null,
          });
        }
      }

      // Create join request + set coach to PENDING atomically
      const [joinRequest] = await prisma.$transaction([
        prisma.organizationJoinRequest.upsert({
          where: {
            organization_id_user_id: {
              organization_id,
              user_id: req.user!.id,
            } as any,
          },
          create: {
            organization_id,
            user_id: req.user!.id,
            message,
            status: 'pending',
          },
          update: {
            message,
            status: 'pending',
            created_at: new Date(),
            reviewed_at: null,
            reviewed_by: null,
          },
          include: {
            user: {
              select: { id: true, display_name: true, email: true },
            },
          },
        }),
        prisma.user.update({
          where: { id: req.user!.id },
          data: {
            preferences: buildPendingCoachPreferences(requesterPrefs, {
              id: organization.id,
              name: organization.name,
            }),
            ...buildAuthStateColumns({
              role: 'coach',
              organization_id: organization.id,
            }),
            approval_status: 'PENDING',
            paid_by_owner: false,
            rejected_at: null,
            rejection_reason: null,
          },
        }),
      ]);
      await invalidateMeCacheForUser(req.user!.id);

      // Send email + push + in-app notification to organization owner
      if (organization.memberships.length > 0) {
        const owner = organization.memberships[0];
        try {
          // v1.0.2 audit fix: search-mode join requests now send email to org owner
          // (previously only push + in-app). Uses LEAGUE_PENDING_APPROVAL template.
          sendCoachJoinRequestEmail({
            ownerEmail: owner.user.email!,
            ownerName: owner.user.display_name || 'League Owner',
            coachName: joinRequest.user.display_name || 'A coach',
            coachEmail: joinRequest.user.email || '',
            organizationName: organization.name,
            organizationId: organization.id,
            requestId: joinRequest.id,
            approveUrl: buildCoachJoinRequestReviewUrl({
              organizationId: organization.id,
              organizationName: organization.name,
              requestId: joinRequest.id,
              action: 'approve',
            }),
            rejectUrl: buildCoachJoinRequestReviewUrl({
              organizationId: organization.id,
              organizationName: organization.name,
              requestId: joinRequest.id,
              action: 'reject',
            }),
          }).catch(err =>
            console.error('[orgs] Failed to send join request email:', (err as any)?.message)
          );

          // Push notification to league owner
          sendPushNotification(
            owner.user.id,
            'New coach request',
            `${joinRequest.user.display_name || 'A coach'} wants to join ${organization.name}`,
            { type: 'coach_request', screen: 'approvals', organization_id: organization.id }
        ).catch((err) => console.warn('[orgs] Failed to send join request push:', (err as any)?.message || err));

          // In-app notification record for league owner
          await prisma.notification
            .create({
              data: {
                user_id: owner.user.id,
                actor_id: req.user!.id,
                type: 'TEAM_INVITE', // Closest available type for coach request
                meta: {
                  coach_request: true,
                  organization_id: organization.id,
                  organization_name: organization.name,
                  coach_name: joinRequest.user.display_name || 'A coach',
                },
              },
            })
            .catch(err =>
              console.error(
                '[orgs] FAILED to create join request notification:',
                (err as any)?.message
              )
            );
        } catch (err) {
          console.error('Failed to send join request notification to admin:', err);
        }
      }

      return res.status(201).json(joinRequest);
    } catch (err) {
      console.error('[organizations] POST /join-requests error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// Get join requests for an organization (owner only)
organizationsRouter.get(
  '/:id/join-requests',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const id = String(req.params.id);
      const status = String((req.query as any).status || 'pending');

      // Existing-org coach admission is decided by the league owner only.
      const membership = await prisma.organizationMembership.findUnique({
        where: {
          organization_id_user_id: {
            organization_id: id,
            user_id: req.user!.id,
          } as any,
        },
      });

      if (!membership || membership.status !== 'active' || membership.role !== 'owner') {
        return res.status(403).json({ error: 'Only the league owner can review coach requests' });
      }

      const joinRequests = await prisma.organizationJoinRequest.findMany({
        where: {
          organization_id: id,
          status: status === 'all' ? undefined : status,
        },
        include: {
          user: {
            select: {
              id: true,
              display_name: true,
              username: true,
              avatar_url: true,
              email: true,
            },
          },
        },
        orderBy: { created_at: 'desc' },
        take: 200,
      });

      return res.json(joinRequests);
    } catch (err) {
      console.error('[organizations] GET /:id/join-requests error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// Get user's own join requests
organizationsRouter.get(
  '/join-requests/me',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const joinRequests = await prisma.organizationJoinRequest.findMany({
        where: { user_id: req.user!.id },
        include: {
          organization: {
            select: {
              id: true,
              name: true,
              description: true,
              sport: true,
              location: true,
            },
          },
        },
        orderBy: { created_at: 'desc' },
        take: 100,
      });

      return res.json(joinRequests);
    } catch (err) {
      console.error('[organizations] GET /join-requests/me error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// Approve join request
organizationsRouter.post(
  '/join-requests/:requestId/approve',
  requireAuth as any,
  requireVerified as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const requestId = String(req.params.requestId);

      const joinRequest = await prisma.organizationJoinRequest.findUnique({
        where: { id: requestId },
        include: {
          organization: true,
          user: {
            select: {
              id: true,
              email: true,
              display_name: true,
              preferences: true,
            },
          },
        },
      });

      if (!joinRequest) {
        return res.status(404).json({ error: 'Join request not found' });
      }

      // Existing-org coach admission is decided by the league owner only.
      const membership = await prisma.organizationMembership.findUnique({
        where: {
          organization_id_user_id: {
            organization_id: joinRequest.organization_id,
            user_id: req.user!.id,
          } as any,
        },
        select: { role: true, status: true },
      });

      if (!membership || membership.status !== 'active' || membership.role !== 'owner') {
        return res.status(403).json({ error: 'Only the league owner can approve coach requests' });
      }

      if (joinRequest.status !== 'pending') {
        return res.status(400).json({ error: 'This request has already been reviewed' });
      }

      // SECURITY: Only allow approving join requests for admin-approved organizations.
      // Without this, coaches could get APPROVED status by joining an unapproved org.
      if (!joinRequest.organization.admin_approved) {
        return res
          .status(403)
          .json({ error: 'Organization must be approved by VarsityHub before accepting members.' });
      }

      // ORG-8 + ORG-4: Serializable isolation with status re-check inside transaction
      await prisma.$transaction(
        async tx => {
          // Re-check status inside transaction to prevent race condition (ORG-4)
          const fresh = await tx.organizationJoinRequest.findUnique({ where: { id: requestId } });
          if (!fresh || fresh.status !== 'pending') {
            throw new Error('JOIN_REQUEST_ALREADY_REVIEWED');
          }
          await tx.organizationJoinRequest.update({
            where: { id: requestId },
            data: {
              status: 'approved',
              reviewed_at: new Date(),
              reviewed_by: req.user!.id,
            },
          });
          await tx.organizationMembership.upsert({
            where: {
              organization_id_user_id: {
                organization_id: joinRequest.organization_id,
                user_id: joinRequest.user_id,
              } as any,
            },
            update: { role: 'coach', status: 'active' },
            create: {
              organization_id: joinRequest.organization_id,
              user_id: joinRequest.user_id,
              role: 'coach',
              status: 'active',
            },
          });
          await tx.user.update({
            where: { id: joinRequest.user_id },
            data: {
              approval_status: 'APPROVED',
              paid_by_owner: true,
              rejected_at: null,
              rejection_reason: null,
              preferences: buildApprovedCoachPreferences({
                currentPrefs: joinRequest.user.preferences,
                organization: {
                  id: joinRequest.organization_id,
                  name: joinRequest.organization.name,
                },
              }),
              ...buildAuthStateColumns({
                role: 'coach',
                organization_id: joinRequest.organization_id,
                proceeding_as_fan: false,
              }),
              ...buildBillingStateColumns({
                pending_plan: null,
                payment_pending: false,
                payment_approved: false,
              }),
            },
          });
        },
        { isolationLevel: 'Serializable' }
      );
      await invalidateMeCacheForUser(joinRequest.user_id);

      // Email the coach that they were approved (fire-and-forget)
      if (joinRequest.user.email) {
        sendCoachApprovedEmail({
          to: joinRequest.user.email,
          coachName: joinRequest.user.display_name || 'Coach',
          leagueName: joinRequest.organization.name,
        }).catch(err =>
          console.error('[orgs] Failed to send coach approved email:', (err as any)?.message)
        );
      }

      // Push notification so coach knows they were approved
      try {
        sendPushNotification(
          joinRequest.user_id,
          'Join Request Approved',
          `Your request to join ${joinRequest.organization.name} was approved!`,
          { type: 'join_request_approved', organization_id: joinRequest.organization_id }
        ).catch(() => {});
        console.log(`[notif] push sent JOIN_REQUEST_APPROVED to user=${joinRequest.user_id}`);
      } catch (err) {
        console.error(
          '[notif] Failed to send push for JOIN_REQUEST_APPROVED:',
          (err as any)?.message || err
        );
      }

      // In-app notification so it shows in the Updates page
      try {
        const notif = await prisma.notification.create({
          data: {
            user_id: joinRequest.user_id,
            actor_id: null,
            type: 'JOIN_REQUEST_APPROVED',
            meta: {
              organization_id: joinRequest.organization_id,
              organization_name: joinRequest.organization.name,
            },
          },
        });
        console.log(
          `[notif] JOIN_REQUEST_APPROVED created id=${notif.id} for user=${joinRequest.user_id}`
        );
      } catch (err) {
        console.error(
          '[notif] Failed to create JOIN_REQUEST_APPROVED notification:',
          (err as any)?.message || err
        );
        captureException(err as Error, {
          context: 'join_request_approval_notification_failed',
          organizationId: joinRequest.organization_id,
          userId: joinRequest.user_id,
          actorId: req.user?.id || null,
        });
      }

      return res.json({ message: 'Join request approved' });
    } catch (err: any) {
      if (err?.message === 'JOIN_REQUEST_ALREADY_REVIEWED') {
        return res.status(400).json({ error: 'This request has already been reviewed' });
      }
      console.error('[organizations] POST /join-requests/:requestId/approve error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// Deny join request
const denyJoinRequestSchema = z.object({
  reason: z.string().max(500).optional(),
});

organizationsRouter.post(
  '/join-requests/:requestId/deny',
  requireAuth as any,
  requireVerified as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const requestId = String(req.params.requestId);
      const parsed = denyJoinRequestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' });

      const { reason } = parsed.data;

      const joinRequest = await prisma.organizationJoinRequest.findUnique({
        where: { id: requestId },
        include: {
          organization: true,
          user: {
            select: {
              id: true,
              email: true,
              display_name: true,
              preferences: true,
            },
          },
        },
      });

      if (!joinRequest) {
        return res.status(404).json({ error: 'Join request not found' });
      }

      // Existing-org coach admission is decided by the league owner only.
      const membership = await prisma.organizationMembership.findUnique({
        where: {
          organization_id_user_id: {
            organization_id: joinRequest.organization_id,
            user_id: req.user!.id,
          } as any,
        },
        select: { role: true, status: true },
      });

      if (!membership || membership.status !== 'active' || membership.role !== 'owner') {
        return res.status(403).json({ error: 'Only the league owner can reject coach requests' });
      }

      if (joinRequest.status !== 'pending') {
        return res.status(400).json({ error: 'This request has already been reviewed' });
      }

      await prisma.$transaction(
        async tx => {
          const fresh = await tx.organizationJoinRequest.findUnique({ where: { id: requestId } });
          if (!fresh || fresh.status !== 'pending') {
            throw new Error('JOIN_REQUEST_ALREADY_REVIEWED');
          }
          await tx.organizationJoinRequest.update({
            where: { id: requestId },
            data: {
              status: 'denied',
              reviewed_at: new Date(),
              reviewed_by: req.user!.id,
              rejection_reason: reason || null,
            },
          });
          await tx.user.update({
            where: { id: joinRequest.user.id },
            data: {
              approval_status: 'REJECTED',
              paid_by_owner: false,
              rejected_at: new Date(),
              rejection_reason: reason || null,
              preferences: buildRejectedCoachPreferences({
                currentPrefs: joinRequest.user.preferences,
                organization: {
                  id: joinRequest.organization_id,
                  name: joinRequest.organization.name,
                },
              }),
              ...buildAuthStateColumns({
                role: 'coach',
                organization_id: joinRequest.organization_id,
              }),
            },
          });
        },
        { isolationLevel: 'Serializable' }
      );
      await invalidateMeCacheForUser(joinRequest.user.id);

      // Email the coach that they were denied (fire-and-forget)
      if (joinRequest.user.email) {
        sendCoachRejectedEmail({
          to: joinRequest.user.email,
          coachName: joinRequest.user.display_name || 'Coach',
          leagueName: joinRequest.organization.name,
          reason: reason || undefined,
        }).catch(err =>
          console.error('[orgs] Failed to send coach rejected email:', (err as any)?.message)
        );
      }

      // Push notification so the coach sees the denial immediately
      try {
        sendPushNotification(
          joinRequest.user.id,
          'Join Request Declined',
          `Your request to join ${joinRequest.organization.name} was not approved.${reason ? ` Reason: ${reason}` : ''}`,
          { type: 'join_request_denied', organization_id: joinRequest.organization_id }
        ).catch(() => {});
        console.log(`[notif] push sent JOIN_REQUEST_DENIED to user=${joinRequest.user.id}`);
      } catch (err) {
        console.error(
          '[notif] Failed to send push for JOIN_REQUEST_DENIED:',
          (err as any)?.message || err
        );
      }

      // Create in-app notification for the denied user
      try {
        await prisma.notification.create({
          data: {
            user_id: joinRequest.user.id,
            actor_id: req.user!.id,
            type: 'JOIN_REQUEST_DENIED',
            meta: {
              organization_id: joinRequest.organization_id,
              organization_name: joinRequest.organization.name,
              reason: reason || undefined,
            },
          },
        });
      } catch (notifErr) {
        console.warn('[organizations] Failed to create denial notification:', notifErr);
        captureException(notifErr as Error, {
          context: 'join_request_denial_notification_failed',
          organizationId: joinRequest.organization_id,
          userId: joinRequest.user.id,
          actorId: req.user?.id || null,
          reason: reason || null,
        });
      }

      return res.json({ message: 'Join request denied' });
    } catch (err: any) {
      if (err?.message === 'JOIN_REQUEST_ALREADY_REVIEWED') {
        return res.status(400).json({ error: 'This request has already been reviewed' });
      }
      console.error('[organizations] POST /join-requests/:requestId/deny error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// =====================================================
// EMAIL-TOKEN COACH JOIN REQUEST REVIEW (no app login)
// =====================================================
//
// Mirrors the league-approval pattern: signed review token in the email link
// IS the authorization. Lets the league owner approve/reject a coach join
// request directly from their inbox without needing the app to be reachable
// or to be signed in. The reviewer of record is the org's active owner.
//
// Email URL builder: buildCoachJoinRequestReviewUrl in server/src/lib/email.ts

function joinReviewHtml(title: string, body: string, color = '#111827'): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:520px;margin:60px auto;padding:24px;text-align:center;color:${color};">
${body}
</body></html>`;
}

async function _executeJoinRequestApprovalByToken(
  requestId: string,
  reviewerUserId: string
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const joinRequest = await prisma.organizationJoinRequest.findUnique({
    where: { id: requestId },
    include: {
      organization: true,
      user: { select: { id: true, email: true, display_name: true, preferences: true } },
    },
  });
  if (!joinRequest) return { ok: false, status: 404, error: 'Join request not found' };
  if (joinRequest.status !== 'pending')
    return { ok: false, status: 400, error: 'This request has already been reviewed' };
  if (!joinRequest.organization.admin_approved)
    return {
      ok: false,
      status: 403,
      error: 'Organization must be approved by VarsityHub before accepting members.',
    };

  try {
    await prisma.$transaction(
      async tx => {
        const fresh = await tx.organizationJoinRequest.findUnique({ where: { id: requestId } });
        if (!fresh || fresh.status !== 'pending') {
          throw new Error('JOIN_REQUEST_ALREADY_REVIEWED');
        }
        await tx.organizationJoinRequest.update({
          where: { id: requestId },
          data: { status: 'approved', reviewed_at: new Date(), reviewed_by: reviewerUserId },
        });
        await tx.organizationMembership.upsert({
          where: {
            organization_id_user_id: {
              organization_id: joinRequest.organization_id,
              user_id: joinRequest.user_id,
            } as any,
          },
          update: { role: 'coach', status: 'active' },
          create: {
            organization_id: joinRequest.organization_id,
            user_id: joinRequest.user_id,
            role: 'coach',
            status: 'active',
          },
        });
        await tx.user.update({
          where: { id: joinRequest.user_id },
          data: {
            approval_status: 'APPROVED',
            paid_by_owner: true,
            rejected_at: null,
            rejection_reason: null,
            preferences: buildApprovedCoachPreferences({
              currentPrefs: joinRequest.user.preferences,
              organization: {
                id: joinRequest.organization_id,
                name: joinRequest.organization.name,
              },
            }),
            ...buildAuthStateColumns({
              role: 'coach',
              organization_id: joinRequest.organization_id,
              proceeding_as_fan: false,
            }),
            ...buildBillingStateColumns({
              pending_plan: null,
              payment_pending: false,
              payment_approved: false,
            }),
          },
        });
      },
      { isolationLevel: 'Serializable' }
    );
  } catch (err: any) {
    if (err?.message === 'JOIN_REQUEST_ALREADY_REVIEWED') {
      return { ok: false, status: 400, error: 'This request has already been reviewed' };
    }
    throw err;
  }

  await invalidateMeCacheForUser(joinRequest.user_id);

  if (joinRequest.user.email) {
    sendCoachApprovedEmail({
      to: joinRequest.user.email,
      coachName: joinRequest.user.display_name || 'Coach',
      leagueName: joinRequest.organization.name,
    }).catch((err) =>
      reportApprovalNotificationFailure('email', 'coach_join_request_approved_email_failed', err, {
        organizationId: joinRequest.organization_id,
        userId: joinRequest.user_id,
        actorId: reviewerUserId,
      })
    );
  }
  try {
    sendPushNotification(
      joinRequest.user_id,
      'Join Request Approved',
      `Your request to join ${joinRequest.organization.name} was approved!`,
      { type: 'join_request_approved', organization_id: joinRequest.organization_id }
    ).catch(() => {});
  } catch (err) {
    reportApprovalNotificationFailure('push', 'join_request_approval_push_failed', err, {
      organizationId: joinRequest.organization_id,
      userId: joinRequest.user_id,
      actorId: reviewerUserId,
    });
  }
  try {
    await prisma.notification.create({
      data: {
        user_id: joinRequest.user_id,
        actor_id: null,
        type: 'JOIN_REQUEST_APPROVED',
        meta: {
          organization_id: joinRequest.organization_id,
          organization_name: joinRequest.organization.name,
        },
      },
    });
  } catch (err) {
    reportApprovalNotificationFailure('in_app', 'join_request_approval_notification_failed', err, {
      organizationId: joinRequest.organization_id,
      userId: joinRequest.user_id,
      actorId: reviewerUserId,
    });
  }

  return { ok: true };
}

async function _executeJoinRequestDenialByToken(
  requestId: string,
  reviewerUserId: string,
  reason?: string
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const joinRequest = await prisma.organizationJoinRequest.findUnique({
    where: { id: requestId },
    include: {
      organization: true,
      user: { select: { id: true, email: true, display_name: true, preferences: true } },
    },
  });
  if (!joinRequest) return { ok: false, status: 404, error: 'Join request not found' };
  if (joinRequest.status !== 'pending')
    return { ok: false, status: 400, error: 'This request has already been reviewed' };

  try {
    await prisma.$transaction(
      async tx => {
        const fresh = await tx.organizationJoinRequest.findUnique({ where: { id: requestId } });
        if (!fresh || fresh.status !== 'pending') {
          throw new Error('JOIN_REQUEST_ALREADY_REVIEWED');
        }
        await tx.organizationJoinRequest.update({
          where: { id: requestId },
          data: {
            status: 'denied',
            reviewed_at: new Date(),
            reviewed_by: reviewerUserId,
            rejection_reason: reason || null,
          },
        });
        await tx.user.update({
          where: { id: joinRequest.user.id },
          data: {
            approval_status: 'REJECTED',
            paid_by_owner: false,
            rejected_at: new Date(),
            rejection_reason: reason || null,
            preferences: buildRejectedCoachPreferences({
              currentPrefs: joinRequest.user.preferences,
              organization: {
                id: joinRequest.organization_id,
                name: joinRequest.organization.name,
              },
            }),
            ...buildAuthStateColumns({
              role: 'coach',
              organization_id: joinRequest.organization_id,
            }),
          },
        });
      },
      { isolationLevel: 'Serializable' }
    );
  } catch (err: any) {
    if (err?.message === 'JOIN_REQUEST_ALREADY_REVIEWED') {
      return { ok: false, status: 400, error: 'This request has already been reviewed' };
    }
    throw err;
  }

  await invalidateMeCacheForUser(joinRequest.user.id);

  if (joinRequest.user.email) {
    sendCoachRejectedEmail({
      to: joinRequest.user.email,
      coachName: joinRequest.user.display_name || 'Coach',
      leagueName: joinRequest.organization.name,
      reason: reason || undefined,
    }).catch(err =>
      console.error('[orgs] Failed to send coach rejected email:', (err as any)?.message)
    );
  }
  try {
    sendPushNotification(
      joinRequest.user.id,
      'Join Request Declined',
      `Your request to join ${joinRequest.organization.name} was not approved.${reason ? ` Reason: ${reason}` : ''}`,
      { type: 'join_request_denied', organization_id: joinRequest.organization_id }
    ).catch(() => {});
  } catch (err) {
    console.error(
      '[notif] Failed to send push for JOIN_REQUEST_DENIED:',
      (err as any)?.message || err
    );
  }
  try {
    await prisma.notification.create({
      data: {
        user_id: joinRequest.user.id,
        actor_id: reviewerUserId,
        type: 'JOIN_REQUEST_DENIED',
        meta: {
          organization_id: joinRequest.organization_id,
          organization_name: joinRequest.organization.name,
          reason: reason || undefined,
        },
      },
    });
  } catch (err) {
    console.warn('[organizations] Failed to create denial notification:', err);
    captureException(err as Error, {
      context: 'join_request_denial_notification_failed',
      organizationId: joinRequest.organization_id,
      userId: joinRequest.user.id,
      actorId: reviewerUserId,
      reason: reason || null,
    });
  }

  return { ok: true };
}

async function joinRequestEmailReviewHandler(
  req: AuthedRequest,
  res: any,
  action: 'approve' | 'reject'
) {
  const requestId = String(req.params.requestId);
  const token = String((req.query.token as string) || '');
  if (!token) {
    return res
      .status(401)
      .send(
        joinReviewHtml(
          'Link Expired',
          '<h1 style="color:#DC2626">Link Expired</h1><p>This approval link is missing or invalid.</p>',
          '#DC2626'
        )
      );
  }

  const expectedAction = action === 'approve' ? 'approve_join_request' : 'reject_join_request';
  const payload = verifyReviewToken<{ requestId: string; orgId: string; action: string }>(token);
  if (!payload || payload.requestId !== requestId || payload.action !== expectedAction) {
    return res
      .status(401)
      .send(
        joinReviewHtml(
          'Link Expired',
          '<h1 style="color:#DC2626">Link Expired</h1><p>This approval link is no longer valid.</p>',
          '#DC2626'
        )
      );
  }

  const joinRequest = await prisma.organizationJoinRequest.findUnique({
    where: { id: requestId },
    include: {
      organization: { select: { id: true, name: true, admin_approved: true } },
      user: { select: { id: true, display_name: true, email: true } },
    },
  });
  if (!joinRequest) {
    return res
      .status(404)
      .send(
        joinReviewHtml(
          'Request Not Found',
          '<h1>Request Not Found</h1><p>This coach join request no longer exists.</p>'
        )
      );
  }

  if (joinRequest.status !== 'pending') {
    return res.send(
      joinReviewHtml(
        'Already Reviewed',
        `<h1>Already ${joinRequest.status === 'approved' ? 'Approved' : 'Reviewed'}</h1><p>This request was already ${joinRequest.status}.</p>`
      )
    );
  }

  if (req.method === 'GET') {
    const verb = action === 'approve' ? 'Approve' : 'Reject';
    const color = action === 'approve' ? '#16A34A' : '#DC2626';
    const form = `<h2>${verb} this coach request?</h2>
<p style="margin:16px 0"><strong>${escapeHtml(joinRequest.user.display_name || 'Unknown coach')}</strong> wants to join <strong>${escapeHtml(joinRequest.organization.name)}</strong>.</p>
<form method="POST" action="?token=${encodeURIComponent(token)}" style="margin-top:24px">
  <button type="submit" style="background:${color};color:#fff;border:none;padding:14px 36px;border-radius:8px;font-size:16px;cursor:pointer;font-weight:600;">${verb}</button>
</form>`;
    return res.send(joinReviewHtml(`${verb} Coach Request`, form));
  }

  // POST: consume token, perform action
  const consumeResult = await consumeReviewToken(token, payload);
  if (consumeResult === 'already_used') {
    return res
      .status(409)
      .send(
        joinReviewHtml(
          'Link Already Used',
          '<h1 style="color:#DC2626">Link Already Used</h1><p>This approval link has already been used.</p>',
          '#DC2626'
        )
      );
  }
  if (consumeResult === 'store_unavailable') {
    return res
      .status(503)
      .send(
        joinReviewHtml(
          'Temporarily Unavailable',
          '<h1 style="color:#DC2626">Temporarily Unavailable</h1><p>This approval link cannot be completed right now. Please use the admin dashboard instead.</p>',
          '#DC2626'
        )
      );
  }

  const ownerMembership = await prisma.organizationMembership.findFirst({
    where: {
      organization_id: joinRequest.organization_id,
      role: 'owner',
      status: 'active',
    },
    select: { user_id: true },
  });
  if (!ownerMembership) {
    return res
      .status(500)
      .send(
        joinReviewHtml(
          'Owner Not Found',
          '<h1 style="color:#DC2626">Error</h1><p>Could not identify the league owner. Please contact support.</p>',
          '#DC2626'
        )
      );
  }

  const result =
    action === 'approve'
      ? await _executeJoinRequestApprovalByToken(requestId, ownerMembership.user_id)
      : await _executeJoinRequestDenialByToken(requestId, ownerMembership.user_id);

  if (!result.ok) {
    return res
      .status(result.status)
      .send(
        joinReviewHtml(
          'Error',
          `<h1 style="color:#DC2626">Error</h1><p>${escapeHtml(result.error)}</p>`,
          '#DC2626'
        )
      );
  }

  if (action === 'approve') {
    return res.send(
      joinReviewHtml(
        'Coach Approved',
        `<h1 style="color:#16A34A">Coach Approved</h1><p><strong>${escapeHtml(joinRequest.user.display_name || 'Coach')}</strong> has been added to <strong>${escapeHtml(joinRequest.organization.name)}</strong>.</p>`
      )
    );
  }
  return res.send(
    joinReviewHtml(
      'Request Declined',
      `<h1>Request Declined</h1><p>${escapeHtml(joinRequest.user.display_name || 'Coach')}'s request to join <strong>${escapeHtml(joinRequest.organization.name)}</strong> was declined.</p>`
    )
  );
}

organizationsRouter.get('/join-requests/:requestId/email/approve', (req, res, next) => {
  joinRequestEmailReviewHandler(req as AuthedRequest, res, 'approve').catch(next);
});
organizationsRouter.post('/join-requests/:requestId/email/approve', (req, res, next) => {
  joinRequestEmailReviewHandler(req as AuthedRequest, res, 'approve').catch(next);
});
organizationsRouter.get('/join-requests/:requestId/email/reject', (req, res, next) => {
  joinRequestEmailReviewHandler(req as AuthedRequest, res, 'reject').catch(next);
});
organizationsRouter.post('/join-requests/:requestId/email/reject', (req, res, next) => {
  joinRequestEmailReviewHandler(req as AuthedRequest, res, 'reject').catch(next);
});

// -----------------------------------------------
// POST /organizations/:id/transfer-ownership
// -----------------------------------------------
organizationsRouter.post(
  '/:id/transfer-ownership',
  requireAuth as any,
  requireVerified as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
      const orgId = req.params.id;
      const transferSchema = z.object({ new_owner_id: z.string().min(1) });
      const parsed = transferSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ error: 'Invalid payload', issues: parsed.error.issues });
      const { new_owner_id } = parsed.data;

      // Verify requester is current owner
      const currentOwnership = await prisma.organizationMembership.findFirst({
        where: { organization_id: orgId, user_id: req.user.id, role: 'owner', status: 'active' },
      });
      if (!currentOwnership) {
        return res.status(403).json({ error: 'Only the current owner can transfer ownership' });
      }

      // ORG-10: Prevent self-transfer (no-op that could cause confusion)
      if (new_owner_id === req.user.id) {
        return res.status(400).json({ error: 'Cannot transfer ownership to yourself' });
      }

      // Verify new owner is a member of the organization
      const newOwnerMembership = await prisma.organizationMembership.findFirst({
        where: { organization_id: orgId, user_id: new_owner_id, status: 'active' },
      });
      if (!newOwnerMembership) {
        return res.status(400).json({ error: 'New owner must be a member of the organization' });
      }

      // Transfer: demote current owner to manager, promote new owner (ORG-10: atomic)
      await prisma.$transaction([
        prisma.organizationMembership.update({
          where: { id: currentOwnership.id },
          data: { role: 'manager' },
        }),
        prisma.organizationMembership.update({
          where: { id: newOwnerMembership.id },
          data: { role: 'owner' },
        }),
      ]);

      return res.json({ message: 'Ownership transferred successfully' });
    } catch (err) {
      console.error('[organizations] POST /:id/transfer-ownership error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// =====================================================
// SUPER ADMIN LEAGUE APPROVAL (emancero@varsityhub.app)
// =====================================================

/**
 * POST /organizations/:id/approve
 * Approves a league page.
 * Token links are bearer-capable browser confirmation pages.
 */
// GET handler so email links work as simple browser clicks
organizationsRouter.get('/:id/approve', authMiddleware as any, (req, res, next) => {
  (approveLeagueHandler as any)(req, res).catch(next);
});
organizationsRouter.post('/:id/approve', authMiddleware as any, (req, res, next) => {
  (approveLeagueHandler as any)(req, res).catch(next);
});

async function approveLeagueHandler(req: AuthedRequest, res: any) {
  try {
    const orgId = req.params.id;
    const token = req.query.token as string | undefined;
    const adminSession = await getPlatformAdminSession(req);
    const authMode = token ? (adminSession ? 'token+admin' : 'token') : 'admin';
    addBreadcrumb('League approval endpoint hit', 'approval.organization_route', 'info', {
      action: 'approve',
      organization_id: orgId,
      method: req.method,
      auth_mode: authMode,
    });

    // Validate org exists early (before auth) to avoid Prisma errors on invalid UUIDs
    const orgExists = await prisma.organization
      .findUnique({ where: { id: orgId }, select: { id: true } })
      .catch(() => null);
    if (!orgExists) return res.status(404).json({ error: 'Organization not found' });

    if (token) {
      const payload = verifyReviewToken<{ orgId: string; action: string }>(token);
      if (!payload || payload.orgId !== orgId || payload.action !== 'approve_league') {
        addBreadcrumb('League approval token validation failed', 'approval.organization_route', 'warning', {
          action: 'approve',
          organization_id: orgId,
          method: req.method,
        });
        return res.status(401).json({ error: 'Invalid or expired approval token' });
      }
      if (req.method === 'GET') {
        addBreadcrumb('League approval confirmation page rendered', 'approval.organization_route', 'info', {
          action: 'approve',
          organization_id: orgId,
        });
        const orgInfo = await prisma.organization.findUnique({
          where: { id: orgId },
          select: { name: true, admin_approved: true },
        });
        if (orgInfo?.admin_approved)
          return res.send(
            `<html><body style="font-family:Arial;text-align:center;padding:60px"><h1>Already Approved</h1><p>This league was already approved.</p></body></html>`
          );
        return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve League</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:500px;margin:60px auto;padding:20px;text-align:center;">
<h2>Approve this league?</h2><p><strong>${escapeHtml(orgInfo?.name || 'Unknown')}</strong></p>
<form method="POST" action="?token=${encodeURIComponent(token)}">
<button type="submit" style="background:#16A34A;color:#fff;border:none;padding:12px 32px;border-radius:8px;font-size:16px;cursor:pointer;">Approve League</button>
</form></body></html>`);
      }

      const consumeResult = await consumeReviewToken(token, payload);
      if (consumeResult === 'already_used') {
        return res
          .status(409)
          .send(`<!DOCTYPE html><html><body style="font-family:Arial;text-align:center;padding:60px"><h1 style="color:#DC2626">Link Already Used</h1><p>This approval link has already been used.</p></body></html>`);
      }
      if (consumeResult === 'store_unavailable') {
        return res
          .status(503)
          .send(`<!DOCTYPE html><html><body style="font-family:Arial;text-align:center;padding:60px"><h1 style="color:#DC2626">Temporarily Unavailable</h1><p>This approval link cannot be completed right now. Please use the admin dashboard instead.</p></body></html>`);
      }

      const adminUserId = adminSession?.id || 'email-token';
      const adminNote: string | undefined = req.body?.note || undefined;
      const result = await approveOrganization(orgId, adminUserId, prisma, { note: adminNote });
      if (result.error) {
        return res.status((result as any).status || 500).send(`<!DOCTYPE html><html><body style="font-family:Arial;text-align:center;padding:60px"><h1 style="color:#DC2626">Error</h1><p>${escapeHtml(result.error)}</p></body></html>`);
      }
      if ((result as any).already) {
        return res.send(
          `<html><body style="font-family:Arial;text-align:center;padding:60px"><h1>Already Approved</h1><p>This league was already approved.</p></body></html>`
        );
      }
      addBreadcrumb('League approval endpoint completed', 'approval.organization_route', 'info', {
        action: 'approve',
        organization_id: orgId,
        auth_mode: authMode,
      });

      const org = (result as any).org;
      const approverEmail = adminSession?.email || 'email-token';
      await logAdminActivity(
        adminUserId,
        approverEmail,
        'APPROVE_LEAGUE',
        'organization',
        orgId,
        `Approved league: ${org.name || orgId}${adminNote ? ` — ${adminNote}` : ''}`
      );
      return res.send(
        `<html><body style="font-family:Arial;text-align:center;padding:60px"><h1 style="color:#16A34A">League Approved</h1><p>"${escapeHtml(String(org.name || ''))}" is now live on VarsityHub.</p></body></html>`
      );
    }

    if (!req.user) return res.status(401).json({ error: 'Admin login required. Please log in to the admin dashboard before approving.' });
    const me = await prisma.user.findUnique({ where: { id: req.user.id }, select: { email: true } });
    if (!isEmailAdmin(me?.email)) return res.status(403).json({ error: 'Admin only' });
    const adminUserId: string = req.user.id;

    const adminNote: string | undefined = req.body?.note || undefined;

    const result = await approveOrganization(orgId, adminUserId, prisma, { note: adminNote });
    if (result.error)
      return res.status((result as any).status || 500).json({ error: result.error });
    if ((result as any).already) return res.json({ message: 'Already approved' });
    addBreadcrumb('League approval endpoint completed', 'approval.organization_route', 'info', {
      action: 'approve',
      organization_id: orgId,
      auth_mode: authMode,
    });

    const org = (result as any).org;

    // ORG-11: Log league approval via centralized logger
    const approverEmail = adminSession?.email || adminUserId || 'unknown-admin';
    await logAdminActivity(
      adminUserId || 'unknown-admin',
      approverEmail,
      'APPROVE_LEAGUE',
      'organization',
      orgId,
      `Approved league: ${org.name || orgId}${adminNote ? ` — ${adminNote}` : ''}`
    );

    return res.json({ message: 'League approved', organization_id: orgId });
  } catch (err) {
    console.error('[organizations] POST /:id/approve error:', err);
    captureException(err instanceof Error ? err : new Error(String(err)), {
      context: 'approve_league_handler_failed',
      organizationId: req.params.id,
      adminId: req.user?.id || null,
    });
    addBreadcrumb('League approval endpoint crashed', 'approval.organization_route', 'error', {
      action: 'approve',
      organization_id: req.params.id,
      error: (err as Error)?.message || 'unknown_error',
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /organizations/:id/reject
 * Rejects a league page.
 * Token links are bearer-capable browser confirmation pages.
 */
// GET handler so email reject links work as simple browser clicks
organizationsRouter.get('/:id/reject', authMiddleware as any, (req, res, next) => {
  (rejectLeagueHandler as any)(req, res).catch(next);
});
organizationsRouter.post('/:id/reject', authMiddleware as any, (req, res, next) => {
  (rejectLeagueHandler as any)(req, res).catch(next);
});

async function rejectLeagueHandler(req: AuthedRequest, res: any) {
  try {
    const orgId = req.params.id;
    const token = req.query.token as string | undefined;
    const reason = req.body?.reason as string | undefined;
    const adminSession = await getPlatformAdminSession(req);
    const authMode = token ? (adminSession ? 'token+admin' : 'token') : 'admin';
    addBreadcrumb('League rejection endpoint hit', 'approval.organization_route', 'info', {
      action: 'reject',
      organization_id: orgId,
      method: req.method,
      auth_mode: authMode,
      has_reason: !!reason,
    });

    // Validate org exists early (before auth) to avoid Prisma errors on invalid UUIDs
    const orgExists = await prisma.organization
      .findUnique({ where: { id: orgId }, select: { id: true } })
      .catch(() => null);
    if (!orgExists) return res.status(404).json({ error: 'Organization not found' });

    if (token) {
      const payload = verifyReviewToken<{ orgId: string; action: string }>(token);
      if (!payload || payload.orgId !== orgId || payload.action !== 'reject_league') {
        addBreadcrumb('League rejection token validation failed', 'approval.organization_route', 'warning', {
          action: 'reject',
          organization_id: orgId,
          method: req.method,
        });
        return res.status(401).json({ error: 'Invalid or expired rejection token' });
      }
      if (req.method === 'GET') {
        addBreadcrumb('League rejection confirmation page rendered', 'approval.organization_route', 'info', {
          action: 'reject',
          organization_id: orgId,
        });
        const orgInfo = await prisma.organization.findUnique({
          where: { id: orgId },
          select: { name: true },
        });
        return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reject League</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:500px;margin:60px auto;padding:20px;text-align:center;">
<h2>Reject this league?</h2><p><strong>${escapeHtml(orgInfo?.name || 'Unknown')}</strong></p>
<form method="POST" action="?token=${encodeURIComponent(token)}">
<button type="submit" style="background:#DC2626;color:#fff;border:none;padding:12px 32px;border-radius:8px;font-size:16px;cursor:pointer;">Reject League</button>
</form></body></html>`);
      }

      const consumeResult = await consumeReviewToken(token, payload);
      if (consumeResult === 'already_used') {
        return res
          .status(409)
          .send(`<!DOCTYPE html><html><body style="font-family:Arial;text-align:center;padding:60px"><h1 style="color:#DC2626">Link Already Used</h1><p>This rejection link has already been used.</p></body></html>`);
      }
      if (consumeResult === 'store_unavailable') {
        return res
          .status(503)
          .send(`<!DOCTYPE html><html><body style="font-family:Arial;text-align:center;padding:60px"><h1 style="color:#DC2626">Temporarily Unavailable</h1><p>This rejection link cannot be completed right now. Please use the admin dashboard instead.</p></body></html>`);
      }

      const adminUserId = adminSession?.id || 'email-token';
      const result = await rejectOrganization(orgId, adminUserId, prisma, { reason });
      if (result.error) {
        return res.status((result as any).status || 500).send(`<!DOCTYPE html><html><body style="font-family:Arial;text-align:center;padding:60px"><h1 style="color:#DC2626">Error</h1><p>${escapeHtml(result.error)}</p></body></html>`);
      }
      addBreadcrumb('League rejection endpoint completed', 'approval.organization_route', 'info', {
        action: 'reject',
        organization_id: orgId,
        auth_mode: authMode,
      });

      const org = (result as any).org;
      const rejecterEmail = adminSession?.email || 'email-token';
      await logAdminActivity(
        adminUserId,
        rejecterEmail,
        'REJECT_LEAGUE',
        'organization',
        orgId,
        `Rejected league: ${org.name || orgId}${reason ? ` — ${reason}` : ''}`
      );
      return res.send(
        `<html><body style="font-family:Arial;text-align:center;padding:60px"><h1 style="color:#DC2626">League Rejected</h1><p>"${escapeHtml(String(org.name || ''))}" has been declined.</p></body></html>`
      );
    }

    if (!req.user) return res.status(401).json({ error: 'Admin login required. Please log in to the admin dashboard before rejecting.' });
    const me = await prisma.user.findUnique({ where: { id: req.user.id }, select: { email: true } });
    if (!isEmailAdmin(me?.email)) return res.status(403).json({ error: 'Admin only' });
    const adminUserId: string = req.user.id;
    const result = await rejectOrganization(orgId, adminUserId, prisma, { reason });
    if (result.error)
      return res.status((result as any).status || 500).json({ error: result.error });
    addBreadcrumb('League rejection endpoint completed', 'approval.organization_route', 'info', {
      action: 'reject',
      organization_id: orgId,
      auth_mode: authMode,
    });

    const org = (result as any).org;

    // ORG-11: Log league rejection via centralized logger
    const rejecterEmail = adminSession?.email || adminUserId || 'unknown-admin';
    await logAdminActivity(
      adminUserId || 'unknown-admin',
      rejecterEmail,
      'REJECT_LEAGUE',
      'organization',
      orgId,
      `Rejected league: ${org.name || orgId}${reason ? ` — ${reason}` : ''}`
    );

    return res.json({ message: 'League rejected', organization_id: orgId });
  } catch (err) {
    console.error('[organizations] POST /:id/reject error:', err);
    captureException(err instanceof Error ? err : new Error(String(err)), {
      context: 'reject_league_handler_failed',
      organizationId: req.params.id,
      adminId: req.user?.id || null,
    });
    addBreadcrumb('League rejection endpoint crashed', 'approval.organization_route', 'error', {
      action: 'reject',
      organization_id: req.params.id,
      error: (err as Error)?.message || 'unknown_error',
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// =====================================================
// LEAGUE OWNER → COACH APPROVAL
// =====================================================

/**
 * GET /organizations/:id/pending-coaches
 * Returns all users with PENDING approval_status who have a join request for this org.
 * Requires league owner role.
 */
organizationsRouter.get(
  '/:id/pending-coaches',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
      const orgId = req.params.id;

      // Existing-org coach admission is decided by the league owner only.
      const membership = await prisma.organizationMembership.findFirst({
        where: {
          organization_id: orgId,
          user_id: req.user.id,
          role: 'owner',
          status: 'active',
        },
      });
      if (!membership)
        return res
          .status(403)
          .json({ error: 'Only the league owner can view pending coaches' });

      const pendingRequests = await prisma.organizationJoinRequest.findMany({
        where: { organization_id: orgId, status: 'pending' },
        include: {
          user: {
            select: {
              id: true,
              display_name: true,
              username: true,
              avatar_url: true,
              approval_status: true,
              preferences: true,
            },
          },
        },
        orderBy: { created_at: 'desc' },
        take: 200,
      });

      return res.json(pendingRequests);
    } catch (err) {
      console.error('[organizations] GET /:id/pending-coaches error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

/**
 * POST /organizations/:id/coaches/:userId/approve
 * League owner approves a coach. Sets approval_status: APPROVED, paid_by_owner: true.
 */
organizationsRouter.post(
  '/:id/coaches/:userId/approve',
  requireAuth as any,
  requireVerified as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
      const { id: orgId, userId: coachId } = req.params;
      const { team_id: teamId } = req.body || {};

      // Existing-org coach admission is decided by the league owner only.
      const membership = await prisma.organizationMembership.findFirst({
        where: {
          organization_id: orgId,
          user_id: req.user.id,
          role: 'owner',
          status: 'active',
        },
      });
      if (!membership)
        return res.status(403).json({ error: 'Only the league owner can approve coaches' });

      // Idempotency: if coach is already approved, return success without writing again
      const coachUser = await prisma.user.findUnique({
        where: { id: coachId },
        select: { approval_status: true },
      });
      if (coachUser?.approval_status === 'APPROVED') {
        const existingMembership = await prisma.organizationMembership.findFirst({
          where: { organization_id: orgId, user_id: coachId, status: 'active' },
        });
        if (existingMembership) {
          return res.json({
            message: 'Coach already approved',
            coach_id: coachId,
            already_approved: true,
          });
        }
      }

      // Verify there's a pending join request for this coach
      const joinRequest = await prisma.organizationJoinRequest.findFirst({
        where: { organization_id: orgId, user_id: coachId, status: 'pending' },
      });
      if (!joinRequest)
        return res.status(404).json({ error: 'No pending join request found for this coach' });

      let approvedTeamName: string | null = null;
      // If team_id provided, verify the team belongs to this organization
      if (teamId) {
        const team = await prisma.team.findUnique({
          where: { id: teamId },
          select: { organization_id: true, name: true },
        });
        if (!team || team.organization_id !== orgId) {
          return res.status(400).json({ error: 'Team does not belong to this organization' });
        }
        approvedTeamName = team.name || null;
      }

      // Get org and coach info
      const [org, coach] = await Promise.all([
        prisma.organization.findUnique({
          where: { id: orgId },
          select: { name: true, admin_approved: true },
        }),
        prisma.user.findUnique({
          where: { id: coachId },
          select: { display_name: true, email: true, preferences: true },
        }),
      ]);
      if (!org) return res.status(404).json({ error: 'Organization not found' });
      if (!org.admin_approved) {
        return res.status(403).json({
          error: 'Organization must be approved by VarsityHub before approving coaches.',
        });
      }

      // Approve with Serializable isolation + re-check to prevent double-tap race conditions.
      // Matches the pattern used in POST /join-requests/:requestId/approve (ORG-8 + ORG-4).
      await prisma.$transaction(
        async tx => {
          // Re-check join request status inside transaction to prevent race condition
          const fresh = await tx.organizationJoinRequest.findUnique({
            where: { id: joinRequest.id },
          });
          if (!fresh || fresh.status !== 'pending') {
            throw new Error('JOIN_REQUEST_ALREADY_REVIEWED');
          }

          await tx.organizationJoinRequest.update({
            where: { id: joinRequest.id },
            data: { status: 'approved', reviewed_at: new Date(), reviewed_by: req.user!.id },
          });
          await tx.user.update({
            where: { id: coachId },
            data: {
              approval_status: 'APPROVED',
              paid_by_owner: true,
              rejected_at: null,
              rejection_reason: null,
              preferences: buildApprovedCoachPreferences({
                currentPrefs: coach?.preferences,
                organization: { id: orgId, name: org.name },
                teamId: teamId || null,
                teamName: approvedTeamName,
              }),
              ...buildAuthStateColumns({
                role: 'coach',
                organization_id: orgId,
                proceeding_as_fan: false,
              }),
              ...buildBillingStateColumns({
                pending_plan: null,
                payment_pending: false,
                payment_approved: false,
              }),
            },
          });
          await tx.organizationMembership.upsert({
            where: { organization_id_user_id: { organization_id: orgId, user_id: coachId } as any },
            update: { role: 'coach', status: 'active' },
            create: { organization_id: orgId, user_id: coachId, role: 'coach', status: 'active' },
          });

          // Assign coach to specific team if provided
          if (teamId) {
            await tx.teamMembership.upsert({
              where: { team_id_user_id: { team_id: teamId, user_id: coachId } as any },
              update: { role: 'coach', status: 'active' },
              create: { team_id: teamId, user_id: coachId, role: 'coach', status: 'active' },
            });
          }

          // Add notification record to the transaction for atomicity
          await tx.notification.create({
            data: {
              user_id: coachId,
              actor_id: req.user!.id,
              type: 'TEAM_INVITE',
              meta: {
                coach_approved: true,
                organization_id: orgId,
                organization_name: org?.name || 'your organization',
              },
            },
          });
        },
        { isolationLevel: 'Serializable' }
      );
      await invalidateMeCacheForUser(coachId);

      // Non-blocking: email and push notifications fire after transaction succeeds.
      // If these fail the approval is still recorded — we log but don't roll back.
      if (coach?.email) {
        sendCoachApprovedEmail({
          to: coach.email,
          coachName: coach.display_name || 'Coach',
          leagueName: org?.name || 'your organization',
        }).catch(err => {
          console.error('[orgs] coach approval email failed:', (err as any)?.message || err);
        });
      }

      sendPushNotification(
        coachId,
        'Congratulations!',
        `Congratulations on being accepted as a coach! Tap to complete your setup.`,
        { type: 'coach_approved', screen: 'onboarding', organization_id: orgId }
      )
        .then(() => {
          console.log(`[notif] push sent TEAM_INVITE(coach_approved) to user=${coachId}`);
        })
        .catch(err => {
          console.error('[notif] coach approval push failed:', (err as any)?.message || err);
        });

      return res.json({ message: 'Coach approved', coach_id: coachId });
    } catch (err: any) {
      if (err?.message === 'JOIN_REQUEST_ALREADY_REVIEWED') {
        return res.status(409).json({ error: 'This join request has already been reviewed' });
      }
      console.error('[organizations] POST /:id/coaches/:userId/approve error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

/**
 * POST /organizations/:id/coaches/:userId/reject
 * League owner rejects a coach request.
 */
organizationsRouter.post(
  '/:id/coaches/:userId/reject',
  requireAuth as any,
  requireVerified as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
      const { id: orgId, userId: coachId } = req.params;
      const reason = req.body?.reason as string | undefined;

      // Existing-org coach admission is decided by the league owner only.
      const membership = await prisma.organizationMembership.findFirst({
        where: {
          organization_id: orgId,
          user_id: req.user.id,
          role: 'owner',
          status: 'active',
        },
      });
      if (!membership)
        return res.status(403).json({ error: 'Only the league owner can reject coaches' });

      const joinRequest = await prisma.organizationJoinRequest.findFirst({
        where: { organization_id: orgId, user_id: coachId, status: 'pending' },
      });
      if (!joinRequest)
        return res.status(404).json({ error: 'No pending join request found for this coach' });

      const [org, coach] = await Promise.all([
        prisma.organization.findUnique({ where: { id: orgId }, select: { name: true } }),
        prisma.user.findUnique({
          where: { id: coachId },
          select: { display_name: true, email: true, preferences: true },
        }),
      ]);

      await prisma.$transaction(
        async tx => {
          const fresh = await tx.organizationJoinRequest.findUnique({
            where: { id: joinRequest.id },
          });
          if (!fresh || fresh.status !== 'pending') {
            throw new Error('COACH_REQUEST_ALREADY_REVIEWED');
          }
          await tx.organizationJoinRequest.update({
            where: { id: joinRequest.id },
            data: {
              status: 'denied',
              message: reason,
              reviewed_at: new Date(),
              reviewed_by: req.user!.id,
            },
          });
          await tx.user.update({
            where: { id: coachId },
            data: {
              approval_status: 'REJECTED',
              paid_by_owner: false,
              rejected_at: new Date(),
              rejection_reason: reason || null,
              preferences: buildRejectedCoachPreferences({
                currentPrefs: coach?.preferences,
                organization: org ? { id: orgId, name: org.name || 'this organization' } : null,
              }),
              ...buildAuthStateColumns({
                role: 'coach',
                organization_id: orgId,
              }),
            },
          });
        },
        { isolationLevel: 'Serializable' }
      );
      await invalidateMeCacheForUser(coachId);

      if (coach?.email) {
        sendCoachRejectedEmail({
          to: coach.email,
          coachName: coach.display_name || 'Coach',
          leagueName: org?.name || 'this organization',
          reason,
      }).catch((err) => console.error('[organizations] coach rejection email failed:', (err as any)?.message || err));
      }

      // Push notification to rejected coach (non-blocking)
      sendPushNotification(
        coachId,
        'Application Update',
        `Your application to join ${org?.name || 'this organization'} was not approved.${reason ? ` Reason: ${reason}` : ''}`,
        { type: 'coach_rejected', screen: 'profile', organization_id: orgId }
      ).catch(err => {
        console.warn('[orgs] coach rejection push failed:', (err as any)?.message || err);
      });

      // Create in-app notification for coach rejection
      try {
        await prisma.notification.create({
          data: {
            user_id: coachId,
            actor_id: req.user!.id,
            type: 'COACH_REJECTED',
            meta: {
              organization_id: orgId,
              organization_name: org?.name || 'this organization',
              reason: reason || null,
            },
          },
        });
      } catch (err) {
        console.error(
          '[orgs] FAILED to create coach rejected in-app notification:',
          (err as any)?.message || err
        );
      }

      return res.json({ message: 'Coach request rejected', coach_id: coachId });
    } catch (err: any) {
      if (err?.message === 'COACH_REQUEST_ALREADY_REVIEWED') {
        return res.status(400).json({ error: 'This coach request has already been reviewed' });
      }
      console.error('[organizations] POST /:id/coaches/:userId/reject error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// Get single organization
// IMPORTANT: This catch-all /:id route MUST be last so it doesn't shadow
// literal routes like /invites/me, /search/nearby, /join-requests/me
organizationsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    try {
      const id = String(req.params.id);
      const authedReq = req as AuthedRequest;
      const currentUserId = authedReq.user?.id ?? null;
      console.log(`[org-get] id=${id} user=${currentUserId || 'anon'}`);
      const organization = await prisma.organization.findUnique({
        where: { id },
        include: {
          _count: { select: { followers: true, memberships: true, teams: true } },
          teams: {
            orderBy: { name: 'asc' },
            select: {
              id: true,
              name: true,
              description: true,
              sport: true,
              season_start: true,
              season_end: true,
              status: true,
              logo_url: true,
              avatar_url: true,
              created_at: true,
              _count: {
                select: {
                  memberships: true,
                },
              },
            },
          },
          // memberships excluded from public endpoint — use GET /:id/members (requires auth)
        },
      });

      if (!organization) {
        console.log(`[org-get] not found: id=${id}`);
        return res.status(404).json({ error: 'Organization not found' });
      }

      if (!organization.admin_approved) {
        const isAdminUser = await isCurrentUserPlatformAdmin(authedReq);
        if (!isAdminUser) {
          if (!currentUserId) {
            console.log(`[org-get] unapproved+anon: id=${id}`);
            return res.status(404).json({ error: 'Organization not found' });
          }
          const [membership, pendingJoin] = await Promise.all([
            prisma.organizationMembership.findUnique({
              where: { organization_id_user_id: { organization_id: id, user_id: currentUserId } },
              select: { status: true },
            }),
            prisma.organizationJoinRequest.findUnique({
              where: { organization_id_user_id: { organization_id: id, user_id: currentUserId } },
              select: { status: true },
            }),
          ]);
          const hasAccess = membership?.status === 'active' || pendingJoin?.status === 'pending';
          if (!hasAccess) {
            console.log(`[org-get] unapproved+no-access: id=${id} user=${currentUserId}`);
            return res.status(404).json({ error: 'Organization not found' });
          }
        }
      }

      const isFollowing = currentUserId
        ? !!(await prisma.organizationFollow.findFirst({
            where: { user_id: currentUserId, organization_id: id },
          }))
        : null;

      return res.json(
        serializeOrganization(organization, {
          includeCounts: true,
          includeTeams: true,
          includeViewerState: true,
          isFollowing,
        })
      );
    } catch (err) {
      console.error('[organizations] GET /:id error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);
