import { AppError } from '../lib/errors/AppError.js';
import { OrganizationRole, Prisma } from '@prisma/client';
import escapeHtml from 'escape-html';
import { Response, Router } from 'express';
import { z } from 'zod';
import { logAdminActivity, logAdminActivityFromReq } from '../lib/adminActivityLogger.js';
import { approveOrganization, rejectOrganization } from '../lib/approvalService.js';
import { getLatestCoachApplication } from '../lib/coachApplications.js';
import { ASSET_URL_MESSAGE, isAllowedAssetUrl } from '../lib/mediaHosts.js';
import { debugLog } from '../lib/debugLog.js';
import { normalizeOrganizationName } from '../lib/normalizeNames.js';
import { isTeamHiddenFromViewer } from '../lib/privacyUtils.js';
import {
  buildCoachJoinRequestReviewUrl,
  sendCoachJoinRequestEmail,
  sendLeagueApprovalRequestEmail,
  sendOrganizationInviteEmail,
  sendStaffMemberJoinedEmail,
} from '../lib/email.js';
import { sendError } from '../lib/http/sendError.js';
import { InviteIdentifierError, resolveInviteIdentifier } from '../lib/inviteIdentifier.js';
import { redactEmail } from '../lib/logRedaction.js';
import { sendPushNotification } from '../lib/notifications.js';
import {
  getOrganizationMembership,
  isOrganizationOwner as isOrganizationOwnerScoped,
  ORGANIZATION_OWNER_ROLE,
} from '../lib/organizationAuthorization.js';
import { isCanonicalSport } from '../lib/sportsTaxonomy.js';
import {
  approveJoinRequest,
  denyJoinRequest,
  ownsApprovedOrganization,
  reportApprovalNotificationFailure,
} from '../lib/organizationJoinRequests.js';
import {
  getOrganizationInviteState,
  getOrganizationJoinRequestState,
  getOrganizationJoinRequestStateForUser,
  listOrganizationInvitesForEmail,
  listOrganizationJoinRequestsForOrganization,
  listOrganizationJoinRequestsForUser,
} from '../lib/organizationWorkflowState.js';
import { getAuthorizedUsersOrgLimit } from '../lib/planLimits.js';
import { prisma } from '../lib/prisma.js';
import { cacheGet, cacheSet } from '../lib/cache.js';
import { consumeReviewToken, signReviewToken, verifyReviewToken } from '../lib/reviewTokens.js';
import { stripHtml } from '../lib/sanitizeHtml.js';
import { addBreadcrumb, captureException } from '../lib/sentry.js';
import {
  buildOrganizationSerializeSelect,
  serializeOrganization,
} from '../lib/serializeOrganization.js';
import {
  buildAuthStateColumns,
  getCanonicalUserRole,
  getPreferencesObject,
  mergeAuthStateIntoPreferences,
} from '../lib/userAuthState.js';
import { getEffectiveEntitledPlan } from '../lib/userBillingState.js';
import { invalidateMeCacheForUser } from '../lib/userCache.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { authMiddleware } from '../middleware/auth.js';
import { inviteLimiter, organizationsNearbyLimiter } from '../middleware/rateLimiters.js';
import { getIsAdmin, isEmailAdmin, isVerifiedAdminUser } from '../middleware/requireAdmin.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireOnboarded } from '../middleware/requireOnboarded.js';
import { requireVerified } from '../middleware/requireVerified.js';
import { registerIdValidation } from '../middleware/validateParams.js';

export const organizationsRouter = Router();
registerIdValidation(organizationsRouter);

function toOrganizationInviteRole(role?: string | null): OrganizationRole {
  return role === OrganizationRole.manager ? OrganizationRole.manager : OrganizationRole.member;
}

const VALID_ORG_INVITE_ROLES = ['manager', 'member'] as const;
const ORGANIZATION_CREATE_REJECTION_COOLDOWN_MS = 48 * 60 * 60 * 1000;

const authorizedUserInputSchema = z.object({
  email: z.string().email().optional(),
  user_id: z.string().optional(),
  role: z.string().optional(),
  assign_team: z.string().optional(),
});

function isValidOrganizationInviteRole(
  role: string
): role is (typeof VALID_ORG_INVITE_ROLES)[number] {
  return VALID_ORG_INVITE_ROLES.includes(role as (typeof VALID_ORG_INVITE_ROLES)[number]);
}

type OrganizationAuthorizedInviteInput = {
  email: string;
  role: string;
};

function buildAuthorizedInviteInputs(
  authorizedUsers: z.infer<typeof authorizedUserInputSchema>[] | undefined
): OrganizationAuthorizedInviteInput[] {
  return (authorizedUsers || [])
    .filter(user => typeof user.email === 'string' && user.email.trim().length > 0)
    .map(user => ({
      email: String(user.email).trim().toLowerCase(),
      role: String(user.role || 'member')
        .trim()
        .toLowerCase(),
    }));
}

function findInvalidOrganizationInviteRole(inputs: OrganizationAuthorizedInviteInput[]) {
  return inputs.find(invite => !isValidOrganizationInviteRole(invite.role));
}

// ---------------------------------------------
// Duplicate Detection & Admin Helpers
// ---------------------------------------------

/**
 * Find an existing active organization that would collide with `name`/`zipCode`
 * under the DB's duplicate-name constraint. Mirrors the two partial unique
 * indexes from migration 20260429224500 EXACTLY by reusing their SQL function
 * `normalize_org_name_for_dedupe`, so the app-level 409 can never diverge from
 * the index (a TS-side re-implementation of the normalizer could) and is
 * deterministic (no unordered 100-row scan):
 *   - zip present  -> unique per (normalized_name, zip_code)
 *   - zip absent   -> normalized_name unique among no-zip active orgs
 * Same name in a different zip is intentionally allowed.
 */
async function findDuplicateActiveOrganization(
  name: string,
  zipCode?: string | null
): Promise<{ id: string; name: string } | null> {
  const rows = zipCode
    ? await prisma.$queryRaw<Array<{ id: string; name: string }>>`
        SELECT "id", "name" FROM "Organization"
        WHERE "status" = 'active'::"OrganizationStatus"
          AND "zip_code" = ${zipCode}
          AND normalize_org_name_for_dedupe("name") = normalize_org_name_for_dedupe(${name})
        LIMIT 1`
    : await prisma.$queryRaw<Array<{ id: string; name: string }>>`
        SELECT "id", "name" FROM "Organization"
        WHERE "status" = 'active'::"OrganizationStatus"
          AND "zip_code" IS NULL
          AND normalize_org_name_for_dedupe("name") = normalize_org_name_for_dedupe(${name})
        LIMIT 1`;
  return rows[0] ?? null;
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
  authorized_users?: z.infer<typeof authorizedUserInputSchema>[];
  onboarding?: boolean;
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
    // Auto-approved orgs (subsequent orgs created by an already-vetted coach —
    // intended "workspace" behavior) carry a sentinel approver so they're
    // distinguishable from super-admin-reviewed orgs in the audit trail rather
    // than showing a null approver. Owner-confirmed intentional 2026-07-15.
    approved_by: adminApproved ? 'auto:approved-coach' : null,
  };
}

// Determine if a membership role is considered an administrator of the organization.
function isOrganizationAdmin(role: string | null | undefined): boolean {
  if (!role) return false;
  return role === 'owner' || role === 'manager';
}

function toIsoDate(value: unknown): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function serializeOrganizationAdminMember(member: any) {
  const user = member?.user;
  const prefs = (user?.preferences || {}) as Record<string, unknown>;
  return {
    id: member.id,
    role: member.role,
    status: member.status,
    created_at: toIsoDate(member.created_at),
    user: {
      id: user?.id || null,
      display_name: user?.display_name || null,
      username: user?.username || null,
      avatar_url: user?.avatar_url || null,
      email: user?.email || null,
      is_parent: prefs?.is_parent === true,
    },
  };
}

function serializeOrganizationAdminInvite(invite: any) {
  return {
    id: invite.id,
    email: invite.email || null,
    role: invite.role || null,
    status: invite.status || null,
    created_at: toIsoDate(invite.created_at),
  };
}

function serializeOrganizationAdminGame(game: any) {
  return {
    id: game.id,
    title: game.title,
    date: toIsoDate(game.date),
    location: game.location || null,
    approval_status: game.approval_status || null,
    home_team_id: game.home_team_id || null,
    away_team_id: game.away_team_id || null,
    home_team: game.home_team || game.homeTeam?.name || null,
    away_team: game.away_team || game.awayTeam?.name || game.away_team_name || null,
  };
}

function serializeOrganizationAdminEvent(event: any) {
  return {
    id: event.id,
    title: event.title,
    date: toIsoDate(event.date),
    location: event.location || null,
    team_id: event.team_id || null,
    event_type: event.event_type || null,
    status: event.status || null,
    approval_status: event.approval_status || null,
    // Dedupe key: lets clients collapse a game-linked event onto its game row.
    game_id: event.game_id || null,
  };
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

async function loadEligibleOrganizationCreateApplicant(req: AuthedRequest, res: Response) {
  const applicant = await prisma.user.findUnique({
    where: { id: req.user!.id },
    select: {
      approval_status: true,
      rejected_at: true,
      rejection_reason: true,
      preferences: true,
      role: true,
      plan: true,
      pending_plan: true,
      payment_pending: true,
      payment_approved: true,
    },
  });
  const applicantPrefs = getPreferencesObject(applicant?.preferences);
  if (getCanonicalUserRole(applicant as any) !== 'coach') {
    res.status(403).json({ error: 'Only coach accounts can create organizations.' });
    return null;
  }

  // Backfill rejected_at for legacy REJECTED users so they cannot bypass cooldown.
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
    if (Number.isFinite(elapsed) && elapsed < ORGANIZATION_CREATE_REJECTION_COOLDOWN_MS) {
      const retryAfterMs = ORGANIZATION_CREATE_REJECTION_COOLDOWN_MS - elapsed;
      res.status(429).json({
        error:
          'Your previous application was declined. Please wait before creating another organization.',
        code: 'REJECTION_COOLDOWN',
        retry_after_ms: retryAfterMs,
        retry_after_hours: Math.ceil(retryAfterMs / (60 * 60 * 1000)),
        reason: applicant.rejection_reason || null,
      });
      return null;
    }
  }

  return { applicant, applicantPrefs };
}

async function prepareOrganizationCreatePreflight(params: {
  req: AuthedRequest;
  res: Response;
  data: OrganizationCreatePayload;
  applicant: unknown;
  applicantPrefs: Record<string, any>;
}) {
  const { req, res, data, applicant, applicantPrefs } = params;
  const authorizedInviteInputs = buildAuthorizedInviteInputs(data.authorized_users);
  const invalidInviteRole = findInvalidOrganizationInviteRole(authorizedInviteInputs);
  if (invalidInviteRole) {
    res.status(400).json({
      error: `Invalid role. Must be one of: ${VALID_ORG_INVITE_ROLES.join(', ')}`,
      code: 'INVALID_INVITE_ROLE',
    });
    return null;
  }

  const applicantPlan = getEffectiveEntitledPlan(applicant as any);
  const applicantTeamCountTotal =
    applicantPrefs.team_count_total ||
    (await prisma.teamMembership.count({
      where: { user_id: req.user!.id, role: 'owner', status: 'active' },
    }));
  const authorizedUsersLimit = getAuthorizedUsersOrgLimit(applicantPlan, applicantTeamCountTotal);
  const totalAuthorizedUsersOnCreate = 1 + authorizedInviteInputs.length;
  if (authorizedUsersLimit !== null && totalAuthorizedUsersOnCreate > authorizedUsersLimit) {
    res.status(403).json({
      error: 'USER_LIMIT_REACHED',
      message: `Plan limit reached. ${applicantPlan} plan allows ${authorizedUsersLimit} authorized user${authorizedUsersLimit === 1 ? '' : 's'} for your organization.`,
      limit: authorizedUsersLimit,
      current: totalAuthorizedUsersOnCreate,
    });
    return null;
  }

  const shouldForcePendingApproval = await shouldForcePendingApprovalOnOrganizationCreate({
    userId: req.user!.id,
    approvalStatus: (applicant as any)?.approval_status,
    onboarding: data.onboarding,
  });

  const dup = await findDuplicateActiveOrganization(data.name, data.zip_code);
  if (dup) {
    res
      .status(409)
      .json({ error: 'DUPLICATE_ORGANIZATION', duplicate_of: { id: dup.id, name: dup.name } });
    return null;
  }

  return { authorizedInviteInputs, shouldForcePendingApproval };
}

async function handleOrganizationCreateRequest(
  req: AuthedRequest,
  res: Response,
  data: OrganizationCreatePayload,
  options: {
    applicantPrefs: Record<string, unknown>;
    shouldForcePendingApproval: boolean;
    authorizedInviteInputs: { email: string; role: string }[];
    routeTag?: string;
  }
): Promise<Response> {
  const {
    applicantPrefs,
    shouldForcePendingApproval,
    authorizedInviteInputs,
    routeTag = '/',
  } = options;
  try {
    const userId = req.user!.id;
    const preserveApprovedFinalSetup = !shouldForcePendingApproval;
    const organization = await prisma.$transaction(async tx => {
      const org = await tx.organization.create({
        data: buildOrganizationCreateData(data, userId, {
          adminApproved: preserveApprovedFinalSetup,
        }),
        select: buildOrganizationSerializeSelect(),
      });
      await tx.organizationMembership.create({
        data: {
          organization_id: org.id,
          user_id: userId,
          role: 'owner',
        },
        select: { id: true },
      });
      // cache-invalidation-exempt — invalidateMeCacheForUser(userId) called after $transaction
      await tx.user.update({
        where: { id: userId },
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
    await invalidateMeCacheForUser(userId);

    // Auto-approved orgs skip the super-admin review that would otherwise write
    // the audit row, so emit one here — an org going live is a privileged state
    // change and must be auditable even when the platform didn't gate it.
    // Owner-confirmed intentional behavior (2026-07-15); the row makes it visible.
    if (preserveApprovedFinalSetup) {
      await logAdminActivity(
        'auto:approved-coach',
        'system',
        'APPROVE_LEAGUE',
        'organization',
        organization.id,
        `Organization auto-approved on creation by pre-vetted coach: ${organization.name}`,
        { reason: 'auto_approve_subsequent_org', created_by: userId }
      ).catch(err =>
        console.error('[organizations] auto-approve AdminActivityLog write failed:', err)
      );
    }

    // Send approval request email to super admin (best effort)
    const creator = await prisma.user.findUnique({
      where: { id: userId },
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
              `[organizations] League approval request email reported unsent (${routeTag}). Check mail provider config.`
            );
          }
        })
        .catch(err => {
          console.warn(
            `[organizations] Failed sending league approval request email (${routeTag}):`,
            err
          );
        });
    }

    // Send invites to authorized users (best effort)
    if (authorizedInviteInputs.length > 0) {
      const invites = authorizedInviteInputs.map(user => ({
        organization_id: organization.id,
        email: user.email,
        role: toOrganizationInviteRole(user.role),
      }));
      if (invites.length > 0) {
        await prisma.organizationInvite.createMany({
          data: invites,
          skipDuplicates: true,
        });
        const [inviter, createdInvites] = await Promise.all([
          prisma.user.findUnique({ where: { id: userId }, select: { display_name: true } }),
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
    // Race backstop: the pre-check passed but a concurrent create won the
    // insert, tripping the DB's normalized-name unique index. Return the same
    // structured 409 the pre-check would have, not a 500.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return res.status(409).json({ error: 'DUPLICATE_ORGANIZATION' });
    }
    console.error(`[organizations] POST ${routeTag} error:`, err);
    return sendError(res, 500, 'Internal server error');
  }
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

async function isCurrentUserPlatformAdmin(req: AuthedRequest): Promise<boolean> {
  if (!req.user?.id) return false;
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { email: true, email_verified: true },
  });
  return !!user?.email_verified && isEmailAdmin(user?.email);
}

const LEAGUE_APPROVAL_TOKEN_TTL = '30d';

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

function renderLeagueActionResultPage(title: string, message: string, isSuccess: boolean) {
  const headingColor = isSuccess ? '#16A34A' : '#DC2626';
  return `<!DOCTYPE html><html><body style="font-family:Arial;text-align:center;padding:60px"><h1 style="color:${headingColor}">${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
}

function describeLeagueEmailReviewState(
  orgInfo: { admin_approved?: boolean | null; status?: string | null },
  action: 'approve' | 'reject'
) {
  if (orgInfo.status === 'rejected') {
    return {
      title: 'Already Rejected',
      message: 'This league was already rejected.',
      success: action === 'reject',
    };
  }
  if (orgInfo.admin_approved) {
    return {
      title: 'Already Approved',
      message: 'This league was already approved.',
      success: action === 'approve',
    };
  }
  return null;
}

// List organizations (public, with optional search)
organizationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
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
      select: buildOrganizationSerializeSelect({ includeCounts: true }),
    });

    return res.json(
      organizations.map(organization =>
        serializeOrganization(organization, { includeCounts: true })
      )
    );
  })
);

// List organizations where current user is the owner
organizationsRouter.get(
  '/mine',
  requireAuth as any,
  requireVerified as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const orgs = await prisma.organization.findMany({
      where: {
        memberships: {
          some: {
            user_id: req.user!.id,
            role: ORGANIZATION_OWNER_ROLE,
            status: 'active',
          },
        },
      },
      take: 50,
      orderBy: { created_at: 'desc' },
      select: buildOrganizationSerializeSelect({ includeCounts: true }),
    });
    return res.json(
      orgs.map(organization =>
        serializeOrganization(organization, {
          includeCounts: true,
        })
      )
    );
  })
);

organizationsRouter.get(
  '/mine/review-summaries',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const memberships = await prisma.organizationMembership.findMany({
      where: {
        user_id: req.user!.id,
        role: { in: ['owner', 'manager'] },
        status: 'active',
      },
      orderBy: { created_at: 'desc' },
      take: 50,
      include: {
        organization: {
          select: {
            id: true,
            name: true,
            teams: {
              select: { id: true },
              orderBy: { created_at: 'asc' },
            },
          },
        },
      },
    });

    // Legacy orgs record ownership only on Organization.league_owner_id with no
    // membership row. Without this, their owners get an empty summary list and
    // the Discover "Manage Org" action dead-ends (manage-org-route-trace.ts).
    const membershipOrgIds = memberships.map(m => m.organization_id);
    const legacyOwnedOrgs = await prisma.organization.findMany({
      where: {
        league_owner_id: req.user!.id,
        ...(membershipOrgIds.length > 0 ? { id: { notIn: membershipOrgIds } } : {}),
      },
      orderBy: { created_at: 'desc' },
      take: 50,
      select: {
        id: true,
        name: true,
        teams: {
          select: { id: true },
          orderBy: { created_at: 'asc' },
        },
      },
    });

    const entries = [
      ...memberships.map(m => ({ organization: m.organization, role: m.role })),
      ...legacyOwnedOrgs.map(o => ({ organization: o, role: ORGANIZATION_OWNER_ROLE })),
    ];

    const summaries = await Promise.all(
      entries.map(async membership => {
        const organization = membership.organization;
        const teamIds = organization.teams.map(team => team.id);

        const [pendingCoachRequests, pendingGameReviews, pendingEventReviews] = await Promise.all([
          prisma.organizationJoinRequest.count({
            where: {
              organization_id: organization.id,
              status: 'pending',
            },
          }),
          teamIds.length > 0
            ? prisma.game.count({
                where: {
                  approval_status: 'pending',
                  OR: [{ home_team_id: { in: teamIds } }, { away_team_id: { in: teamIds } }],
                },
              })
            : Promise.resolve(0),
          teamIds.length > 0
            ? prisma.event.count({
                where: {
                  approval_status: 'pending',
                  team_id: { in: teamIds },
                },
              })
            : Promise.resolve(0),
        ]);

        return {
          organization: {
            id: organization.id,
            name: organization.name,
          },
          permissions: {
            can_manage: true,
            can_review_coach_requests: membership.role === ORGANIZATION_OWNER_ROLE,
            membership_role: membership.role,
          },
          counts: {
            pending_coach_requests: pendingCoachRequests,
            pending_game_reviews: pendingGameReviews,
            pending_event_reviews: pendingEventReviews,
          },
        };
      })
    );

    return res.json(summaries);
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
    .refine(isAllowedAssetUrl, ASSET_URL_MESSAGE)
    .optional()
    .nullable(),
  profile_picture_url: z
    .string()
    .url()
    .max(2000)
    .refine(isAllowedAssetUrl, ASSET_URL_MESSAGE)
    .optional()
    .nullable(),
  background_url: z
    .string()
    .url()
    .max(2000)
    .refine(isAllowedAssetUrl, ASSET_URL_MESSAGE)
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

      // Verify user is the organization owner
      const isOwner = await isOrganizationOwnerScoped(userId, orgId);
      if (!isOwner)
        return res
          .status(403)
          .json({ error: 'Only the organization owner can edit this organization.' });

      const parsed = updateOrgSchema.safeParse(req.body);
      if (!parsed.success)
        return res.status(400).json({ error: 'Invalid payload', issues: parsed.error.issues });

      const data = parsed.data;

      const updated = await prisma.organization.update({
        where: { id: orgId },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.description !== undefined && { description: stripHtml(data.description) }),
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
    const userId = req.user!.id;
    const orgId = String(req.params.id);
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { id: true },
    });
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
  })
);

// Unfollow an organization
organizationsRouter.delete(
  '/:id/follow',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const userId = req.user!.id;
    const orgId = String(req.params.id);
    await prisma.organizationFollow.deleteMany({
      where: { user_id: userId, organization_id: orgId },
    });
    return res.json({ is_following: false });
  })
);

// NOTE: GET /:id moved to bottom of file to avoid shadowing literal routes
// like /invites/me, /search/nearby, /join-requests/me

// Get organization members (requires auth + membership or admin)
organizationsRouter.get(
  '/:id/members',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = String(req.params.id);
    const organization = await prisma.organization.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!organization) return res.status(404).json({ error: 'Organization not found' });

    // Caller must be a member of this org or a platform admin
    const callerMembership = await getOrganizationMembership(req.user!.id, id);
    if (!callerMembership) {
      if (!(await isVerifiedAdminUser(req.user!.id))) {
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
  })
);

const organizationCreateSchemaFields = {
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
  authorized_users: z.array(authorizedUserInputSchema).optional(),
  onboarding: z.boolean().optional(), // bypass requireVerified during onboarding
};

// H3: zip_code aligned with ads — 5-digit US format when provided
const createOrganizationSchema = z.object(organizationCreateSchemaFields);

function sendOrganizationCreateValidationError(
  res: Response,
  issues: Array<{ path: PropertyKey[]; message: string }>
) {
  // v1.0.3: return Zod issues so the client can render actionable errors.
  return res.status(400).json({
    error: 'Invalid payload',
    code: 'VALIDATION_FAILED',
    issues: issues.map(i => ({
      path: i.path,
      message: i.message,
    })),
  });
}

async function handleOrganizationCreateRoute(
  req: AuthedRequest,
  res: Response,
  routeTag: '/' | '/create'
) {
  const parsed = createOrganizationSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendOrganizationCreateValidationError(res, parsed.error.issues);
  }

  const applicantResult = await loadEligibleOrganizationCreateApplicant(req, res);
  if (!applicantResult) return;
  const { applicant, applicantPrefs } = applicantResult;

  const data = parsed.data;
  const preflight = await prepareOrganizationCreatePreflight({
    req,
    res,
    data,
    applicant,
    applicantPrefs,
  });
  if (!preflight) return;
  return handleOrganizationCreateRequest(req, res, data, {
    applicantPrefs,
    shouldForcePendingApproval: preflight.shouldForcePendingApproval,
    authorizedInviteInputs: preflight.authorizedInviteInputs,
    routeTag,
  });
}

// Create organization
organizationsRouter.post(
  '/',
  requireAuth as any,
  requireVerified as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    // v1.0.3: return the Zod issues so the client can show WHICH field
    // failed validation. The bare "Invalid payload" response caused an entire
    // session of "Failed to create page — something went wrong" with no way
    // for users OR support to diagnose missing fields.
    return handleOrganizationCreateRoute(req, res, '/');
  })
);

// Enhanced create organization for onboarding
organizationsRouter.post(
  '/create',
  requireAuth as any,
  requireVerified as any,
  // Align with the canonical POST /organizations route. The legacy
  // /create variant previously omitted requireOnboarded and relied on inline
  // role + rejection-cooldown checks in the handler body. Those inline checks
  // remain as defense-in-depth, but middleware alignment removes the asymmetric
  // gate-chain that's historically been how regressions reappear (the two
  // routes drift when someone updates one and not the other).
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    return handleOrganizationCreateRoute(req, res, '/create');
  })
);

const inviteUserSchema = z
  .object({
    identifier: z.string().trim().min(1).optional(),
    email: z.string().trim().email().optional(),
    role: z.string().optional(),
  })
  .refine(data => Boolean(data.identifier || data.email), {
    message: 'Username or email is required',
    path: ['identifier'],
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

      const { identifier, email, role } = parsed.data;

      // Validate role against allowed org roles (cheap, no lookups).
      if (role && !isValidOrganizationInviteRole(role)) {
        return res
          .status(400)
          .json({ error: `Invalid role. Must be one of: ${VALID_ORG_INVITE_ROLES.join(', ')}` });
      }

      // Role-barrier model (2026-07-06): the organization owner is the ONLY
      // one who manages the organization — org managers no longer get invite
      // power. Owner-only, incl. legacy league_owner_id owners.
      // AUTHORIZE BEFORE RESOLVING THE IDENTIFIER: resolveInviteIdentifier turns
      // a @username into that user's private email (and its 404-vs-403 result is
      // a username-existence oracle), so a non-owner must be rejected first.
      if (!(await isOrganizationOwnerScoped(req.user!.id, id))) {
        return sendError(res, 403, 'Only the organization owner can invite members.');
      }

      const resolvedIdentifier = await resolveInviteIdentifier(prisma, identifier || email || '');
      const inviteEmail = resolvedIdentifier.email;
      if (resolvedIdentifier.resolvedUserId) {
        const existingMembership = await prisma.organizationMembership.findFirst({
          where: {
            organization_id: id,
            user_id: resolvedIdentifier.resolvedUserId,
            status: 'active',
          },
          select: { id: true },
        });
        if (existingMembership) {
          return sendError(res, 409, 'That user is already a member of this organization.', {
            code: 'ALREADY_MEMBER',
          });
        }
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
              where: {
                organization_id: id,
                status: 'active',
                role: { in: ['owner', 'manager', 'member'] },
              },
            });
            // +1 for the invite being created right now — otherwise, at exactly
            // `inviteCount + memberCount === limit`, the check `limit > limit` is
            // false and this invite slips through, leaking one authorized slot
            // over the plan cap. Matches the team invite paths.
            const totalAuthorized = inviteCount + memberCount + 1;
            if (totalAuthorized > limit) {
              throw new AppError(403, 'USER_LIMIT_REACHED', {
                errorCode: 'USER_LIMIT_REACHED',
                publicMetadata: { limit, current: totalAuthorized },
              });
            }
          }
          if (existingInvite) {
            return tx.organizationInvite.update({
              where: { id: existingInvite.id },
              data: { email: inviteEmail, role: toOrganizationInviteRole(role), status: 'pending' },
              select: { id: true },
            });
          }
          return tx.organizationInvite.create({
            data: {
              organization_id: id,
              email: inviteEmail,
              role: toOrganizationInviteRole(role),
              status: 'pending',
            },
            select: { id: true },
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
      if (err instanceof InviteIdentifierError) {
        return sendError(res, err.statusCode, 'Please enter a valid username or email address.', {
          code: err.code,
        });
      }
      if (err instanceof AppError) {
        return res.status(err.statusCode).json(err.toJSON());
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
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const invites = await listOrganizationInvitesForEmail(user.email);

    return res.json(invites);
  })
);

organizationsRouter.post(
  '/:id/invites/:inviteId/cancel',
  requireAuth as any,
  requireVerified as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const organizationId = String(req.params.id);
    const inviteId = String(req.params.inviteId);
    const userId = req.user?.id || null;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    // Owner-only (incl. legacy league_owner_id owners) or platform admin.
    const [isOwner, isPlatformAdmin, invite] = await Promise.all([
      isOrganizationOwnerScoped(userId, organizationId),
      isCurrentUserPlatformAdmin(req),
      prisma.organizationInvite.findUnique({
        where: { id: inviteId },
        select: { id: true, organization_id: true, status: true },
      }),
    ]);

    if (!invite || invite.organization_id !== organizationId) {
      return res.status(404).json({ error: 'Invite not found' });
    }

    if (!isPlatformAdmin && !isOwner) {
      return sendError(res, 403, 'PERMISSION_DENIED', {
        message: 'Only the organization owner can cancel invites.',
      });
    }

    const updated = await prisma.organizationInvite.updateMany({
      where: { id: inviteId, organization_id: organizationId, status: 'pending' },
      data: { status: 'revoked' },
    });

    if (updated.count === 0) {
      return res.status(409).json({ error: 'Invite already processed' });
    }

    return res.json({
      ok: true,
      invite: {
        id: inviteId,
        status: 'revoked',
      },
    });
  })
);

// Accept organization invite
organizationsRouter.post(
  '/invites/:inviteId/accept',
  requireAuth as any,
  requireVerified as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const inviteId = String(req.params.inviteId);
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const invite = await getOrganizationInviteState(inviteId);
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
          role: toOrganizationInviteRole(invite.role),
          status: 'active',
        },
        select: { id: true },
      });
      return true;
    });
    if (!accepted) return res.status(409).json({ error: 'Invite already processed' });

    try {
      const accepterName = user.display_name || user.email || 'A staff member';
      const [organization, managers] = await Promise.all([
        prisma.organization.findUnique({
          where: { id: invite.organization_id },
          select: { name: true },
        }),
        prisma.organizationMembership.findMany({
          where: {
            organization_id: invite.organization_id,
            role: { in: ['owner', 'manager'] },
            status: 'active',
            user_id: { not: req.user!.id },
          },
          select: {
            user: {
              select: {
                email: true,
                display_name: true,
              },
            },
          },
          take: 100,
        }),
      ]);

      await Promise.allSettled(
        managers
          .map(entry => entry.user)
          .filter(manager => typeof manager?.email === 'string' && manager.email.trim().length > 0)
          .map(manager =>
            sendStaffMemberJoinedEmail({
              to: String(manager!.email).trim(),
              ownerName: manager?.display_name || undefined,
              newMember: accepterName,
              newMemberRole: invite.role || 'member',
              scope: 'organization',
              scopeName: organization?.name || 'your organization',
            })
          )
      );
    } catch (notifErr) {
      console.error('[organizations] Failed to send invite accepted notification:', notifErr);
    }

    return res.json({ message: 'Invite accepted' });
  })
);

// Decline organization invite
organizationsRouter.post(
  '/invites/:inviteId/decline',
  requireAuth as any,
  requireVerified as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const inviteId = String(req.params.inviteId);
    const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const invite = await getOrganizationInviteState(inviteId);
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
      // Unapproved (unvetted) orgs must never surface publicly — mirrors the
      // GET /organizations and GET /:id boundary.
      admin_approved: true,
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
  })
);

// Check for duplicate organizations using normalized name comparison
organizationsRouter.post(
  '/check-duplicate',
  requireAuth as any,
  asyncHandler(async (req, res) => {
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
      const localMatch = localOrgs.find(o => normalizeOrganizationName(o.name) === normalizedInput);
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
    const broadMatch = recentOrgs.find(o => normalizeOrganizationName(o.name) === normalizedInput);

    return res.json({
      exists: !!broadMatch,
      organization: broadMatch ?? null,
    });
  })
);

// Create join request
const createJoinRequestSchema = z.object({
  organization_id: z.string(),
  message: z.string().max(500).optional(),
  team_id: z.string().optional(),
});

organizationsRouter.post(
  '/join-requests',
  requireAuth as any,
  requireVerified as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const parsed = createJoinRequestSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'Invalid payload' });

      const { organization_id, message, team_id } = parsed.data;

      // Check if organization exists
      const organization = await prisma.organization.findUnique({
        where: { id: organization_id },
        select: {
          id: true,
          name: true,
        },
      });

      if (!organization) {
        return res.status(404).json({ error: 'Organization not found' });
      }

      // Check if user is already a member
      const existingMembership = await getOrganizationMembership(req.user!.id, organization_id);

      if (existingMembership) {
        return res.status(400).json({ error: 'You are already a member of this organization' });
      }

      // Check for existing pending request
      const existingRequest = await getOrganizationJoinRequestStateForUser(
        organization_id,
        req.user!.id
      );

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
          return sendError(
            res,
            429,
            `Your previous request was denied. You can re-apply in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`
          );
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
      // If a team_id is provided, embed team context in message for league owner visibility.
      // (OrganizationJoinRequest has no team_id column — no schema migration needed.)
      let effectiveMessage = message;
      if (team_id) {
        const team = await prisma.team.findFirst({
          where: { id: team_id, organization_id },
          select: { name: true },
        });
        if (team?.name) {
          const teamContext = `[Team: ${team.name}]`;
          effectiveMessage = message ? `${teamContext} ${message}` : teamContext;
        }
      }
      const ownerMembership = await prisma.organizationMembership.findFirst({
        where: {
          organization_id,
          role: 'owner',
          status: 'active',
        },
        select: {
          user: {
            select: { id: true, email: true, display_name: true },
          },
        },
      });

      // Merely ASKING to join another league must not demote an established
      // league owner to PENDING — that locked them out of the org they already
      // run until a third party acted. They get the join request; their global
      // coach state is left alone.
      const requesterOwnsApprovedOrg = await ownsApprovedOrganization(
        req.user!.id,
        organization_id
      );

      const joinRequestUpsert = prisma.organizationJoinRequest.upsert({
        where: {
          organization_id_user_id: {
            organization_id,
            user_id: req.user!.id,
          } as any,
        },
        create: {
          organization_id,
          user_id: req.user!.id,
          message: effectiveMessage,
          status: 'pending',
        },
        update: {
          message: effectiveMessage,
          status: 'pending',
          created_at: new Date(),
          reviewed_at: null,
          reviewed_by: null,
        },
        select: {
          id: true,
          organization_id: true,
          user_id: true,
          message: true,
          created_at: true,
          user: {
            select: { id: true, display_name: true, username: true, email: true },
          },
        },
      });

      const joinRequestOps: Prisma.PrismaPromise<unknown>[] = [joinRequestUpsert];
      if (!requesterOwnsApprovedOrg) {
        joinRequestOps.push(
          // cache-invalidation-exempt — invalidateMeCacheForUser(req.user!.id) called after the $transaction below
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
          })
        );
      }
      const [joinRequest] = (await prisma.$transaction(joinRequestOps)) as [
        Awaited<typeof joinRequestUpsert>,
        ...unknown[],
      ];
      await invalidateMeCacheForUser(req.user!.id);

      // Send email + push + in-app notification to organization owner
      if (ownerMembership?.user) {
        const owner = ownerMembership.user;
        try {
          // v1.0.2 audit fix: search-mode join requests now send email to org owner
          // (previously only push + in-app). Uses LEAGUE_PENDING_APPROVAL template.
          sendCoachJoinRequestEmail({
            ownerEmail: owner.email!,
            ownerName: owner.display_name || 'League Owner',
            coachName: joinRequest.user.display_name || 'A coach',
            coachUsername: joinRequest.user.username || undefined,
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
            owner.id,
            'New coach request',
            `${joinRequest.user.display_name || 'A coach'} wants to join ${organization.name}`,
            { type: 'coach_request', screen: 'approvals', organization_id: organization.id }
          ).catch(err =>
            console.warn('[orgs] Failed to send join request push:', (err as any)?.message || err)
          );

          // In-app notification record for league owner
          await prisma.notification
            .create({
              data: {
                user_id: owner.id,
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
          reportApprovalNotificationFailure(
            'email',
            'organization_join_request_notify_failed',
            err,
            {
              organizationId: organization.id,
              ownerUserId: owner.id,
              requesterId: req.user!.id,
            }
          );
        }
      }
      return res.status(201).json(joinRequest);
    } catch (err: any) {
      if (err instanceof AppError) {
        return res.status(err.statusCode).json(err.toJSON());
      }
      console.error('[organizations] POST /:organizationId/join error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// Get join requests for an organization (owner only)
organizationsRouter.get(
  '/:id/join-requests',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = String(req.params.id);
    const status = String((req.query as any).status || 'pending');

    // Coach admission is decided by the organization owner — or a platform
    // admin (org-scoped god-override), matching the canReviewCoachRequests
    // flag GET /organizations/:id already advertises to admins.
    const isPlatformAdmin = await isCurrentUserPlatformAdmin(req);
    if (!isPlatformAdmin && !(await isOrganizationOwnerScoped(req.user!.id, id))) {
      return sendError(res, 403, 'Only the organization owner can review coach requests');
    }

    const joinRequests = await listOrganizationJoinRequestsForOrganization(id, status);

    return res.json(joinRequests);
  })
);

// Get user's own join requests
organizationsRouter.get(
  '/join-requests/me',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const joinRequests = await listOrganizationJoinRequestsForUser(req.user!.id);

    return res.json(joinRequests);
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

      const joinRequest = await getOrganizationJoinRequestState(requestId);

      if (!joinRequest) {
        return res.status(404).json({ error: 'Join request not found' });
      }

      // IDOR: prevent self-approval (defense-in-depth)
      if (joinRequest.user_id === req.user!.id) {
        return res.status(403).json({ error: 'You cannot approve your own join request.' });
      }

      // Coach admission is decided by the organization owner — or a platform
      // admin (org-scoped god-override). The self-approval IDOR guard above
      // still applies to admins.
      // Owner-only (incl. legacy league_owner_id owners) or platform admin.
      const isPlatformAdmin = await isCurrentUserPlatformAdmin(req);
      if (
        !isPlatformAdmin &&
        !(await isOrganizationOwnerScoped(req.user!.id, joinRequest.organization_id))
      ) {
        return sendError(res, 403, 'Only the organization owner can approve coach requests');
      }

      const result = await approveJoinRequest({
        requestId,
        reviewerUserId: req.user!.id,
        context: { via: 'app', req },
      });
      if (!result.ok) {
        return sendError(res, result.status, result.error);
      }

      return res.json({ message: 'Join request approved' });
    } catch (err: any) {
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

      const joinRequest = await getOrganizationJoinRequestState(requestId);

      if (!joinRequest) {
        return res.status(404).json({ error: 'Join request not found' });
      }

      // IDOR: prevent self-denial (defense-in-depth) — mirrors the approve route
      // (uses the error envelope per verify:error-envelope).
      if (joinRequest.user_id === req.user!.id) {
        return sendError(res, 403, 'You cannot deny your own join request.');
      }

      // Owner-only (incl. legacy league_owner_id owners) or platform admin.
      const isPlatformAdmin = await isCurrentUserPlatformAdmin(req);
      if (
        !isPlatformAdmin &&
        !(await isOrganizationOwnerScoped(req.user!.id, joinRequest.organization_id))
      ) {
        return sendError(res, 403, 'Only the organization owner can reject coach requests');
      }

      const result = await denyJoinRequest({
        requestId,
        reviewerUserId: req.user!.id,
        context: { via: 'app', req },
        reason,
      });
      if (!result.ok) {
        return sendError(res, result.status, result.error);
      }

      return res.json({ message: 'Join request denied' });
    } catch (err: any) {
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

function renderJoinRequestDecisionButtons(status: 'approved' | 'denied') {
  const approveStyle =
    status === 'approved'
      ? 'background:#16A34A;color:#fff;border:1px solid #16A34A;'
      : 'background:#E5E7EB;color:#6B7280;border:1px solid #D1D5DB;';
  const rejectStyle =
    status === 'denied'
      ? 'background:#DC2626;color:#fff;border:1px solid #DC2626;'
      : 'background:#E5E7EB;color:#6B7280;border:1px solid #D1D5DB;';

  return `<div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-top:24px;">
<span style="display:inline-block;padding:12px 24px;border-radius:999px;font-weight:700;${approveStyle}">Approve</span>
<span style="display:inline-block;padding:12px 24px;border-radius:999px;font-weight:700;${rejectStyle}">Deny</span>
</div>`;
}

function renderJoinRequestResultPage(params: {
  status: 'approved' | 'denied';
  coachName?: string | null;
  coachUsername?: string | null;
  organizationName?: string | null;
}) {
  const coachName = escapeHtml(params.coachName || 'This coach');
  const username =
    typeof params.coachUsername === 'string' && params.coachUsername.trim()
      ? `<p style="margin:10px 0 0;color:#64748B;font-size:14px;">@${escapeHtml(params.coachUsername.trim())}</p>`
      : '';
  const organizationName = params.organizationName
    ? `<p style="margin:14px 0 0;font-size:16px;color:#111827;">League: <strong>${escapeHtml(params.organizationName)}</strong></p>`
    : '';

  if (params.status === 'approved') {
    return joinReviewHtml(
      'Coach Approved',
      `<h1 style="color:#16A34A">Coach Approved</h1><p><strong>${coachName}</strong> has been added to the organization.</p>${username}${organizationName}${renderJoinRequestDecisionButtons('approved')}`,
      '#16A34A'
    );
  }

  return joinReviewHtml(
    'Request Declined',
    `<h1 style="color:#DC2626">Request Declined</h1><p><strong>${coachName}</strong> was not approved for this organization.</p>${username}${organizationName}${renderJoinRequestDecisionButtons('denied')}`,
    '#DC2626'
  );
}

function renderJoinRequestStatePage(
  joinRequest: { status: string | null },
  action: 'approve' | 'reject',
  details?: {
    coachName?: string | null;
    coachUsername?: string | null;
    organizationName?: string | null;
  }
) {
  if (joinRequest.status === 'approved') {
    const coachName = escapeHtml(details?.coachName || 'This coach');
    const username =
      typeof details?.coachUsername === 'string' && details.coachUsername.trim()
        ? `<p style="margin:10px 0 0;color:#64748B;font-size:14px;">@${escapeHtml(details.coachUsername.trim())}</p>`
        : '';
    const organizationName = details?.organizationName
      ? `<p style="margin:14px 0 0;font-size:16px;color:#111827;">League: <strong>${escapeHtml(details.organizationName)}</strong></p>`
      : '';
    return joinReviewHtml(
      'Already Approved',
      `<h1 style="color:#16A34A">Already Approved</h1><p><strong>${coachName}</strong> has already been approved for this organization.</p>${username}${organizationName}`,
      '#16A34A'
    );
  }
  if (joinRequest.status === 'denied') {
    return renderJoinRequestResultPage({
      status: 'denied',
      coachName: details?.coachName,
      coachUsername: details?.coachUsername,
      organizationName: details?.organizationName,
    });
  }
  return joinReviewHtml(
    'Already Reviewed',
    `<h1>Already Reviewed</h1><p>This request was already ${escapeHtml(String(joinRequest.status || 'reviewed'))}.</p>`
  );
}

async function joinRequestEmailReviewHandler(
  req: AuthedRequest,
  res: any,
  action: 'approve' | 'reject'
) {
  const requestId = String(req.params.requestId);
  const token = String((req.query.token as string) || '');
  const linkLabel = action === 'approve' ? 'approval' : 'rejection';
  if (!token) {
    return res
      .status(401)
      .send(
        joinReviewHtml(
          'Link Expired',
          `<h1 style="color:#DC2626">Link Expired</h1><p>This ${linkLabel} link is missing or invalid.</p>`,
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
          `<h1 style="color:#DC2626">Link Expired</h1><p>This ${linkLabel} link is no longer valid.</p>`,
          '#DC2626'
        )
      );
  }

  const joinRequest = await getOrganizationJoinRequestState(requestId);
  const [organization, user] = await Promise.all([
    joinRequest
      ? prisma.organization.findUnique({
          where: { id: joinRequest.organization_id },
          select: { id: true, name: true, admin_approved: true },
        })
      : Promise.resolve(null),
    joinRequest
      ? prisma.user.findUnique({
          where: { id: joinRequest.user_id },
          select: { id: true, display_name: true, username: true, email: true },
        })
      : Promise.resolve(null),
  ]);
  if (!joinRequest || !organization || !user) {
    return res
      .status(404)
      .send(
        joinReviewHtml(
          'Request Not Found',
          '<h1>Request Not Found</h1><p>This coach join request no longer exists.</p>'
        )
      );
  }

  if (payload.orgId !== joinRequest.organization_id) {
    return res
      .status(401)
      .send(
        joinReviewHtml(
          'Link Expired',
          `<h1 style="color:#DC2626">Link Expired</h1><p>This ${linkLabel} link is no longer valid.</p>`,
          '#DC2626'
        )
      );
  }

  if (joinRequest.status !== 'pending') {
    return res.send(
      renderJoinRequestStatePage(joinRequest, action, {
        coachName: user.display_name,
        coachUsername: user.username,
        organizationName: organization.name,
      })
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
      ? await approveJoinRequest({
          requestId,
          reviewerUserId: ownerMembership.user_id,
          context: { via: 'email-link' },
        })
      : await denyJoinRequest({
          requestId,
          reviewerUserId: ownerMembership.user_id,
          context: { via: 'email-link' },
        });

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

  const consumeResult = await consumeReviewToken(token, payload);
  if (consumeResult === 'already_used') {
    return res
      .status(409)
      .send(
        joinReviewHtml(
          'Link Already Used',
          `<h1 style="color:#DC2626">Link Already Used</h1><p>This ${linkLabel} link has already been used.</p>`,
          '#DC2626'
        )
      );
  }
  if (consumeResult === 'store_unavailable') {
    console.warn('[organizations] join request review token could not be marked consumed:', {
      request_id: requestId,
      action,
      consumeResult,
    });
  }

  if (action === 'approve') {
    return res.send(
      renderJoinRequestResultPage({
        status: 'approved',
        coachName: user.display_name || 'Coach',
        coachUsername: user.username,
        organizationName: organization.name,
      })
    );
  }
  return res.send(
    renderJoinRequestResultPage({
      status: 'denied',
      coachName: user.display_name || 'Coach',
      coachUsername: user.username,
      organizationName: organization.name,
    })
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
      select: { id: true },
    });
    // A legacy owner (league_owner_id pointer, no membership row) is still the
    // owner and may transfer. currentOwnership stays null for them — the
    // demotion step below is skipped since there's no row to demote.
    if (!currentOwnership && !(await isOrganizationOwnerScoped(req.user.id, orgId))) {
      return res.status(403).json({ error: 'Only the current owner can transfer ownership' });
    }

    // ORG-10: Prevent self-transfer (no-op that could cause confusion)
    if (new_owner_id === req.user.id) {
      return res.status(400).json({ error: 'Cannot transfer ownership to yourself' });
    }

    // Verify new owner is a member of the organization
    const newOwnerMembership = await prisma.organizationMembership.findFirst({
      where: { organization_id: orgId, user_id: new_owner_id, status: 'active' },
      select: { id: true },
    });
    if (!newOwnerMembership) {
      return res.status(400).json({ error: 'New owner must be a member of the organization' });
    }

    // Transfer the canonical owner pointer AND membership roles together.
    // Without updating `league_owner_id`, old-owner authority leaked through
    // billing, team-management fallback checks, and org-owner-only screens.
    await prisma.$transaction([
      prisma.organization.update({
        where: { id: orgId },
        data: { league_owner_id: new_owner_id },
        select: { id: true },
      }),
      // Demote the old owner's membership row — skipped for a legacy owner who
      // never had one (they simply stop being the league_owner_id pointer).
      ...(currentOwnership
        ? [
            prisma.organizationMembership.update({
              where: { id: currentOwnership.id },
              data: { role: 'manager' },
              select: { id: true },
            }),
          ]
        : []),
      prisma.organizationMembership.update({
        where: { id: newOwnerMembership.id },
        data: { role: 'owner' },
        select: { id: true },
      }),
    ]);

    await logAdminActivityFromReq(
      req,
      'TRANSFER_ORG_OWNERSHIP',
      'organization',
      orgId,
      `Transferred organization ownership to user ${new_owner_id}`,
      { new_owner_id }
    );

    return res.json({ message: 'Ownership transferred successfully' });
  })
);

// Remove an org member/manager (owner-only). An owner cannot be removed here —
// ownership must be moved via transfer-ownership first. Closes the audit gap
// where no removal path existed and ex-staff kept org-admin power forever.
organizationsRouter.delete(
  '/:id/members/:membershipId',
  requireAuth as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const orgId = req.params.id;
    const membershipId = req.params.membershipId;
    if (!(await isOrganizationOwnerScoped(req.user.id, orgId))) {
      return sendError(res, 403, 'Only the organization owner can remove members.');
    }
    const membership = await prisma.organizationMembership.findFirst({
      where: { id: membershipId, organization_id: orgId },
      select: { id: true, user_id: true, role: true },
    });
    if (!membership) return sendError(res, 404, 'Membership not found');
    if (membership.role === ORGANIZATION_OWNER_ROLE) {
      return sendError(
        res,
        400,
        'Cannot remove an owner. Transfer ownership to another member first.',
        {
          code: 'CANNOT_REMOVE_OWNER',
        }
      );
    }
    if (membership.user_id === req.user.id) {
      return sendError(res, 400, 'You cannot remove yourself.');
    }
    await prisma.organizationMembership.delete({ where: { id: membership.id } });
    await logAdminActivityFromReq(
      req,
      'REMOVE_ORG_MEMBER',
      'organization',
      orgId,
      `Removed member ${membership.user_id} from organization`,
      { membership_id: membership.id, removed_user_id: membership.user_id }
    );
    return res.json({ ok: true });
  })
);

// Change an org member's role between manager/member (owner-only). The owner
// role is intentionally not settable here — use transfer-ownership.
organizationsRouter.patch(
  '/:id/members/:membershipId',
  requireAuth as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const orgId = req.params.id;
    const membershipId = req.params.membershipId;
    const schema = z.object({ role: z.enum(['manager', 'member']) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid payload', issues: parsed.error.issues });
    }
    if (!(await isOrganizationOwnerScoped(req.user.id, orgId))) {
      return sendError(res, 403, 'Only the organization owner can change member roles.');
    }
    const membership = await prisma.organizationMembership.findFirst({
      where: { id: membershipId, organization_id: orgId },
      select: { id: true, user_id: true, role: true },
    });
    if (!membership) return sendError(res, 404, 'Membership not found');
    if (membership.role === ORGANIZATION_OWNER_ROLE) {
      return sendError(res, 400, 'Use transfer-ownership to change the owner.', {
        code: 'CANNOT_RELABEL_OWNER',
      });
    }
    await prisma.organizationMembership.update({
      where: { id: membership.id },
      data: { role: parsed.data.role as OrganizationRole },
    });
    await logAdminActivityFromReq(
      req,
      'UPDATE_ORG_MEMBER_ROLE',
      'organization',
      orgId,
      `Set member ${membership.user_id} role to ${parsed.data.role}`,
      { membership_id: membership.id, target_user_id: membership.user_id, role: parsed.data.role }
    );
    return res.json({ ok: true });
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
        addBreadcrumb(
          'League approval token validation failed',
          'approval.organization_route',
          'warning',
          {
            action: 'approve',
            organization_id: orgId,
            method: req.method,
          }
        );
        return res
          .status(401)
          .send(
            renderLeagueActionResultPage(
              'Invalid Link',
              'This approval link is invalid or has expired.',
              false
            )
          );
      }
      if (req.method === 'GET') {
        addBreadcrumb(
          'League approval confirmation page rendered',
          'approval.organization_route',
          'info',
          {
            action: 'approve',
            organization_id: orgId,
          }
        );
        const orgInfo = await prisma.organization.findUnique({
          where: { id: orgId },
          select: { name: true, admin_approved: true, status: true },
        });
        const currentState = orgInfo ? describeLeagueEmailReviewState(orgInfo, 'approve') : null;
        if (currentState) {
          return res.send(
            renderLeagueActionResultPage(
              currentState.title,
              currentState.message,
              currentState.success
            )
          );
        }
        return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Approve League</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:500px;margin:60px auto;padding:20px;text-align:center;">
<h2>Approve this league?</h2><p><strong>${escapeHtml(orgInfo?.name || 'Unknown')}</strong></p>
<form method="POST" action="?token=${encodeURIComponent(token)}">
<button type="submit" style="background:#16A34A;color:#fff;border:none;padding:12px 32px;border-radius:8px;font-size:16px;cursor:pointer;">Approve League</button>
</form></body></html>`);
      }

      const orgInfo = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { name: true, admin_approved: true, status: true },
      });
      const currentState = orgInfo ? describeLeagueEmailReviewState(orgInfo, 'approve') : null;
      if (currentState) {
        return res.send(
          renderLeagueActionResultPage(
            currentState.title,
            currentState.message,
            currentState.success
          )
        );
      }

      const adminUserId = adminSession?.id || 'email-token';
      const adminNote: string | undefined = req.body?.note || undefined;
      const result = await approveOrganization(orgId, adminUserId, prisma, { note: adminNote });
      if (result.error) {
        const finalState = (result as any).finalState;
        if (finalState === 'rejected') {
          return res
            .status((result as any).status || 409)
            .send(
              renderLeagueActionResultPage(
                'Already Rejected',
                'This league was already rejected.',
                false
              )
            );
        }
        return res
          .status((result as any).status || 500)
          .send(
            `<!DOCTYPE html><html><body style="font-family:Arial;text-align:center;padding:60px"><h1 style="color:#DC2626">Error</h1><p>${escapeHtml(result.error)}</p></body></html>`
          );
      }
      if ((result as any).already) {
        return res.send(
          renderLeagueActionResultPage(
            'Already Approved',
            'This league was already approved.',
            false
          )
        );
      }
      const consumeResult = await consumeReviewToken(token, payload);
      if (consumeResult === 'already_used') {
        return res
          .status(409)
          .send(
            `<!DOCTYPE html><html><body style="font-family:Arial;text-align:center;padding:60px"><h1 style="color:#DC2626">Link Already Used</h1><p>This approval link has already been used.</p></body></html>`
          );
      }
      if (consumeResult === 'store_unavailable') {
        console.warn('[organizations] league approval token could not be marked consumed:', {
          organization_id: orgId,
          action: 'approve',
          consumeResult,
        });
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

    if (!req.user)
      return sendError(
        res,
        401,
        'Admin login required. Please log in to the admin dashboard before approving.'
      );
    const me = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { email: true, email_verified: true },
    });
    if (!me?.email_verified) {
      return res.status(403).json({ error: 'Email verification required' });
    }
    if (!isEmailAdmin(me.email)) return res.status(403).json({ error: 'Admin only' });
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
    if (adminSession?.email) {
      await logAdminActivity(
        adminUserId || 'unknown-admin',
        adminSession.email,
        'APPROVE_LEAGUE',
        'organization',
        orgId,
        `Approved league: ${org.name || orgId}${adminNote ? ` — ${adminNote}` : ''}`
      );
    } else {
      await logAdminActivityFromReq(
        req,
        'APPROVE_LEAGUE',
        'organization',
        orgId,
        `Approved league: ${org.name || orgId}${adminNote ? ` — ${adminNote}` : ''}`
      );
    }

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
 * POST /organizations/:id/resend-approval-email
 * Lets the org owner (or admin) regenerate and resend the approval-request
 * email to admins when the original link has expired.
 * Rate-limited: once per org per 24 hours to prevent spam.
 */
organizationsRouter.post(
  '/:id/resend-approval-email',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const orgId = req.params.id;
    const userId = req.user!.id;

    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: {
        id: true,
        name: true,
        admin_approved: true,
        status: true,
        league_owner_id: true,
        sport: true,
        org_type: true,
        supporting_document_url: true,
      },
    });
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    if (org.admin_approved)
      return res
        .status(409)
        .json({ error: 'Organization is already approved.', code: 'ALREADY_APPROVED' });
    if (org.status === 'rejected')
      return res.status(409).json({
        error: 'This application was rejected. Please contact support.',
        code: 'REJECTED',
      });

    const isAdmin = await getIsAdmin(req as any);
    // Use the scoped helper (honors both league_owner_id AND an owner membership
    // row) instead of the raw pointer — parity with every other org-owner gate.
    const isOwner = await isOrganizationOwnerScoped(userId, orgId);
    if (!isOwner && !isAdmin)
      return res
        .status(403)
        .json({ error: 'Only the organization owner can resend the approval request.' });

    // Rate-limit: one resend per org per 24 hours (non-admin). Uses cache (Redis/in-memory).
    if (!isAdmin) {
      const cooldownKey = `org-approval-resend:${orgId}`;
      const lastSent = await cacheGet<number>(cooldownKey);
      const cooldownMs = 24 * 60 * 60 * 1000;
      if (lastSent && Date.now() - lastSent < cooldownMs) {
        const nextAllowedAt = new Date(lastSent + cooldownMs).toISOString();
        return res.status(429).json({
          error: 'Approval email was already resent recently. Please wait 24 hours.',
          code: 'RESEND_COOLDOWN',
          next_allowed_at: nextAllowedAt,
        });
      }
      await cacheSet(cooldownKey, Date.now(), 24 * 60 * 60);
    }

    const owner = await prisma.user.findUnique({
      where: { id: org.league_owner_id || userId },
      select: { display_name: true, email: true },
    });

    const approveToken = signReviewToken(
      { orgId: org.id, action: 'approve_league' },
      LEAGUE_APPROVAL_TOKEN_TTL
    );
    const rejectToken = signReviewToken(
      { orgId: org.id, action: 'reject_league' },
      LEAGUE_APPROVAL_TOKEN_TTL
    );

    sendLeagueApprovalRequestEmail({
      leagueId: org.id,
      leagueName: org.name,
      ownerName: owner?.display_name || 'Unknown',
      ownerEmail: owner?.email || '',
      sport: org.sport || undefined,
      orgType: org.org_type || undefined,
      approveToken,
      rejectToken,
      supportingDocumentUrl: org.supporting_document_url || undefined,
    })
      .then(sent => {
        if (!sent)
          console.warn('[organizations] resend approval email reported unsent for org', orgId);
      })
      .catch(err =>
        console.warn('[organizations] resend approval email failed:', (err as any)?.message || err)
      );

    return res.json({ message: 'Approval request email resent to admins.' });
  })
);

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
        addBreadcrumb(
          'League rejection token validation failed',
          'approval.organization_route',
          'warning',
          {
            action: 'reject',
            organization_id: orgId,
            method: req.method,
          }
        );
        return res
          .status(401)
          .send(
            renderLeagueActionResultPage(
              'Invalid Link',
              'This rejection link is invalid or has expired.',
              false
            )
          );
      }
      if (req.method === 'GET') {
        addBreadcrumb(
          'League rejection confirmation page rendered',
          'approval.organization_route',
          'info',
          {
            action: 'reject',
            organization_id: orgId,
          }
        );
        const orgInfo = await prisma.organization.findUnique({
          where: { id: orgId },
          select: { name: true, admin_approved: true, status: true },
        });
        const currentState = orgInfo ? describeLeagueEmailReviewState(orgInfo, 'reject') : null;
        if (currentState) {
          return res.send(
            renderLeagueActionResultPage(
              currentState.title,
              currentState.message,
              currentState.success
            )
          );
        }
        return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reject League</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:500px;margin:60px auto;padding:20px;text-align:center;">
<h2>Reject this league?</h2><p><strong>${escapeHtml(orgInfo?.name || 'Unknown')}</strong></p>
<form method="POST" action="?token=${encodeURIComponent(token)}">
<button type="submit" style="background:#DC2626;color:#fff;border:none;padding:12px 32px;border-radius:8px;font-size:16px;cursor:pointer;">Reject League</button>
</form></body></html>`);
      }

      const orgInfo = await prisma.organization.findUnique({
        where: { id: orgId },
        select: { name: true, admin_approved: true, status: true },
      });
      const currentState = orgInfo ? describeLeagueEmailReviewState(orgInfo, 'reject') : null;
      if (currentState) {
        return res.send(
          renderLeagueActionResultPage(
            currentState.title,
            currentState.message,
            currentState.success
          )
        );
      }

      const adminUserId = adminSession?.id || 'email-token';
      const result = await rejectOrganization(orgId, adminUserId, prisma, { reason });
      if (result.error) {
        const finalState = (result as any).finalState;
        if (finalState === 'approved') {
          return res
            .status((result as any).status || 409)
            .send(
              renderLeagueActionResultPage(
                'Already Approved',
                'This league was already approved.',
                false
              )
            );
        }
        return res
          .status((result as any).status || 500)
          .send(
            `<!DOCTYPE html><html><body style="font-family:Arial;text-align:center;padding:60px"><h1 style="color:#DC2626">Error</h1><p>${escapeHtml(result.error)}</p></body></html>`
          );
      }
      if ((result as any).already) {
        return res.send(
          renderLeagueActionResultPage(
            'Already Rejected',
            'This league was already rejected.',
            false
          )
        );
      }
      const consumeResult = await consumeReviewToken(token, payload);
      if (consumeResult === 'already_used') {
        return res
          .status(409)
          .send(
            `<!DOCTYPE html><html><body style="font-family:Arial;text-align:center;padding:60px"><h1 style="color:#DC2626">Link Already Used</h1><p>This rejection link has already been used.</p></body></html>`
          );
      }
      if (consumeResult === 'store_unavailable') {
        console.warn('[organizations] league rejection token could not be marked consumed:', {
          organization_id: orgId,
          action: 'reject',
          consumeResult,
        });
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

    if (!req.user)
      return sendError(
        res,
        401,
        'Admin login required. Please log in to the admin dashboard before rejecting.'
      );
    const me = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { email: true, email_verified: true },
    });
    if (!me?.email_verified) {
      return res.status(403).json({ error: 'Email verification required' });
    }
    if (!isEmailAdmin(me.email)) return res.status(403).json({ error: 'Admin only' });
    const adminUserId: string = req.user.id;
    const result = await rejectOrganization(orgId, adminUserId, prisma, { reason });
    if ((result as any).already || (result as any).finalState === 'rejected') {
      return res.json({
        message: 'League already rejected',
        organization_id: orgId,
        already_rejected: true,
      });
    }
    if (result.error)
      return res.status((result as any).status || 500).json({ error: result.error });
    addBreadcrumb('League rejection endpoint completed', 'approval.organization_route', 'info', {
      action: 'reject',
      organization_id: orgId,
      auth_mode: authMode,
    });

    const org = (result as any).org;

    // ORG-11: Log league rejection via centralized logger
    if (adminSession?.email) {
      await logAdminActivity(
        adminUserId || 'unknown-admin',
        adminSession.email,
        'REJECT_LEAGUE',
        'organization',
        orgId,
        `Rejected league: ${org.name || orgId}${reason ? ` — ${reason}` : ''}`
      );
    } else {
      await logAdminActivityFromReq(
        req,
        'REJECT_LEAGUE',
        'organization',
        orgId,
        `Rejected league: ${org.name || orgId}${reason ? ` — ${reason}` : ''}`
      );
    }

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

organizationsRouter.get(
  '/:id/admin-summary',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const orgId = String(req.params.id);
    const viewerId = req.user?.id || null;
    if (!viewerId) return res.status(401).json({ error: 'Authentication required' });

    const [organization, membership, isPlatformAdmin] = await Promise.all([
      prisma.organization.findUnique({
        where: { id: orgId },
        select: buildOrganizationSerializeSelect({
          includeCounts: true,
          includeFollowersCount: true,
          includeTeams: true,
        }),
      }),
      getOrganizationMembership(viewerId, orgId),
      getIsAdmin(req as any),
    ]);

    if (!organization) {
      return res.status(404).json({ error: 'Organization not found' });
    }

    const membershipRole = membership?.status === 'active' ? String(membership.role || '') : null;
    const canManage = isPlatformAdmin || isOrganizationAdmin(membershipRole);
    const canReviewCoachRequests = isPlatformAdmin || membershipRole === ORGANIZATION_OWNER_ROLE;

    if (!canManage) {
      return res.status(403).json({
        error: 'Only organization admins or platform admins can view admin summary',
      });
    }

    const teamIds = Array.isArray((organization as any).teams)
      ? (organization as any).teams.map((team: any) => String(team.id))
      : [];
    const now = new Date();

    const [
      members,
      pendingInvites,
      pendingCoachRequests,
      pendingGames,
      pendingEvents,
      upcomingGames,
      upcomingEvents,
      pendingInviteCount,
      pendingCoachCount,
      pendingGameCount,
      pendingEventCount,
      upcomingGameCount,
      upcomingEventCount,
    ] = await Promise.all([
      prisma.organizationMembership.findMany({
        where: { organization_id: orgId, status: 'active' },
        orderBy: { created_at: 'asc' },
        take: 500,
        include: {
          user: {
            select: {
              id: true,
              display_name: true,
              username: true,
              avatar_url: true,
              email: true,
              preferences: true,
            },
          },
        },
      }),
      prisma.organizationInvite.findMany({
        where: { organization_id: orgId, status: 'pending' },
        orderBy: { created_at: 'asc' },
        take: 200,
      }),
      listOrganizationJoinRequestsForOrganization(orgId, 'pending'),
      teamIds.length > 0
        ? prisma.game.findMany({
            where: {
              approval_status: 'pending',
              OR: [{ home_team_id: { in: teamIds } }, { away_team_id: { in: teamIds } }],
            },
            orderBy: { date: 'asc' },
            take: 25,
            include: {
              homeTeam: { select: { id: true, name: true } },
              awayTeam: { select: { id: true, name: true } },
            },
          })
        : Promise.resolve([]),
      teamIds.length > 0
        ? prisma.event.findMany({
            where: {
              approval_status: 'pending',
              team_id: { in: teamIds },
            },
            orderBy: { date: 'asc' },
            take: 25,
          })
        : Promise.resolve([]),
      teamIds.length > 0
        ? prisma.game.findMany({
            where: {
              approval_status: 'approved',
              date: { gte: now },
              OR: [{ home_team_id: { in: teamIds } }, { away_team_id: { in: teamIds } }],
            },
            orderBy: { date: 'asc' },
            take: 25,
            include: {
              homeTeam: { select: { id: true, name: true } },
              awayTeam: { select: { id: true, name: true } },
            },
          })
        : Promise.resolve([]),
      teamIds.length > 0
        ? prisma.event.findMany({
            where: {
              approval_status: 'approved',
              date: { gte: now },
              team_id: { in: teamIds },
            },
            orderBy: { date: 'asc' },
            take: 25,
          })
        : Promise.resolve([]),
      prisma.organizationInvite.count({
        where: { organization_id: orgId, status: 'pending' },
      }),
      prisma.organizationJoinRequest.count({
        where: { organization_id: orgId, status: 'pending' },
      }),
      teamIds.length > 0
        ? prisma.game.count({
            where: {
              approval_status: 'pending',
              OR: [{ home_team_id: { in: teamIds } }, { away_team_id: { in: teamIds } }],
            },
          })
        : Promise.resolve(0),
      teamIds.length > 0
        ? prisma.event.count({
            where: {
              approval_status: 'pending',
              team_id: { in: teamIds },
            },
          })
        : Promise.resolve(0),
      teamIds.length > 0
        ? prisma.game.count({
            where: {
              approval_status: 'approved',
              date: { gte: now },
              OR: [{ home_team_id: { in: teamIds } }, { away_team_id: { in: teamIds } }],
            },
          })
        : Promise.resolve(0),
      teamIds.length > 0
        ? prisma.event.count({
            where: {
              approval_status: 'approved',
              date: { gte: now },
              team_id: { in: teamIds },
            },
          })
        : Promise.resolve(0),
    ]);

    return res.json({
      organization: serializeOrganization(organization, {
        includeCounts: true,
        includeTeams: true,
        includeViewerState: true,
        viewerRole: membershipRole,
        isMember: membership?.status === 'active',
        isOwner: membershipRole === ORGANIZATION_OWNER_ROLE,
        canEdit: membershipRole === ORGANIZATION_OWNER_ROLE,
        canManage,
        canReviewCoaches: canReviewCoachRequests,
      }),
      permissions: {
        can_manage: canManage,
        can_review_coach_requests: canReviewCoachRequests,
        membership_role: membershipRole,
        is_platform_admin: isPlatformAdmin,
      },
      counts: {
        teams: Number((organization as any)?._count?.teams || teamIds.length),
        members: members.length,
        followers: Number((organization as any)?._count?.followers || 0),
        pending_authorized_invites: pendingInviteCount,
        pending_coach_requests: pendingCoachCount,
        pending_game_reviews: pendingGameCount,
        pending_event_reviews: pendingEventCount,
        upcoming_games: upcomingGameCount,
        upcoming_events: upcomingEventCount,
      },
      teams: Array.isArray((organization as any).teams)
        ? (organization as any).teams.map((team: any) => ({
            id: team.id,
            name: team.name,
            description: team.description ?? null,
            sport: team.sport ?? null,
            season_start: toIsoDate(team.season_start),
            season_end: toIsoDate(team.season_end),
            status: team.status ?? null,
            logo_url: team.logo_url || team.avatar_url || null,
            avatar_url: team.avatar_url || team.logo_url || null,
            created_at: toIsoDate(team.created_at),
            _count: {
              memberships: Number(team?._count?.memberships || 0),
            },
          }))
        : [],
      members: members.map(serializeOrganizationAdminMember),
      requests: {
        authorized_invites: pendingInvites.map(serializeOrganizationAdminInvite),
        coach_requests: pendingCoachRequests.map(request => ({
          ...request,
          created_at: toIsoDate(request.created_at),
          reviewed_at: toIsoDate(request.reviewed_at),
        })),
        pending_games: pendingGames.map(serializeOrganizationAdminGame),
        pending_events: pendingEvents.map(serializeOrganizationAdminEvent),
      },
      upcoming: {
        games: upcomingGames.map(serializeOrganizationAdminGame),
        events: upcomingEvents.map(serializeOrganizationAdminEvent),
      },
    });
  })
);

// ── Sport programs (Phase 1 of the sport-program pivot) ──────────────
const createProgramSchema = z.object({
  sport: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(120).optional(),
});

// POST /organizations/:id/programs — org owner or any active org member
// (approved coaches land as org 'member'); same tier as team creation.
organizationsRouter.post(
  '/:id/programs',
  requireAuth as any,
  requireVerified as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return sendError(res, 401, 'Unauthorized');
    const orgId = String(req.params.id);
    const parsed = createProgramSchema.safeParse(req.body);
    if (!parsed.success)
      return sendError(res, 400, 'Validation failed', {
        details: parsed.error.flatten().fieldErrors,
      });
    if (!isCanonicalSport(parsed.data.sport))
      return sendError(res, 400, 'INVALID_SPORT', {
        message: 'sport must be a canonical slug from the sports taxonomy.',
      });

    const isOwner = await isOrganizationOwnerScoped(req.user.id, orgId);
    const membership = isOwner
      ? null
      : await prisma.organizationMembership.findFirst({
          where: { organization_id: orgId, user_id: req.user.id, status: 'active' },
          select: { id: true },
        });
    if (!isOwner && !membership) return sendError(res, 403, 'PERMISSION_DENIED');

    try {
      const program = await prisma.sportProgram.create({
        data: {
          organization_id: orgId,
          sport: parsed.data.sport,
          name: parsed.data.name ?? null,
        },
      });
      return res.status(201).json({ ok: true, program });
    } catch (err: any) {
      if (err?.code === 'P2002')
        return sendError(res, 409, 'PROGRAM_EXISTS', {
          message: 'This organization already has that sport program.',
        });
      throw err;
    }
  })
);

// GET /organizations/:id/programs — any authenticated user (public info)
organizationsRouter.get(
  '/:id/programs',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const orgId = String(req.params.id);
    const viewerId = req.user?.id ?? null;

    // Unapproved orgs are not public — mirror GET /organizations/:id: only a
    // platform admin or an active member may see an unapproved org's programs.
    const org = await prisma.organization.findUnique({
      where: { id: orgId },
      select: { admin_approved: true },
    });
    if (!org) return res.status(404).json({ error: 'Organization not found' });
    if (!org.admin_approved) {
      const isAdminUser = await isCurrentUserPlatformAdmin(req);
      const membership = viewerId ? await getOrganizationMembership(viewerId, orgId) : null;
      if (!isAdminUser && membership?.status !== 'active') {
        return res.status(404).json({ error: 'Organization not found' });
      }
    }

    const programs = await prisma.sportProgram.findMany({
      where: { organization_id: orgId },
      orderBy: [{ sport: 'asc' }],
      take: 200,
      include: {
        teams: {
          where: { status: 'active' },
          select: { id: true, name: true, level: true, gender: true },
          orderBy: { created_at: 'asc' },
          take: 25,
        },
      },
    });

    // Drop private teams the viewer isn't allowed to see (mirrors programs.ts).
    const filtered = await Promise.all(
      programs.map(async program => {
        const hidden = await Promise.all(
          program.teams.map(t => isTeamHiddenFromViewer(t.id, viewerId))
        );
        return { ...program, teams: program.teams.filter((_, i) => !hidden[i]) };
      })
    );
    return res.json({ programs: filtered });
  })
);

// Get single organization
// IMPORTANT: This catch-all /:id route MUST be last so it doesn't shadow
// literal routes like /invites/me, /search/nearby, /join-requests/me
organizationsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const authedReq = req as AuthedRequest;
    const currentUserId = authedReq.user?.id ?? null;
    debugLog(`[org-get] id=${id} user=${currentUserId || 'anon'}`);
    const organization = await prisma.organization.findUnique({
      where: { id },
      select: buildOrganizationSerializeSelect({
        includeCounts: true,
        includeFollowersCount: true,
        includeTeams: true,
      }),
    });

    if (!organization) {
      debugLog(`[org-get] not found: id=${id}`);
      return res.status(404).json({ error: 'Organization not found' });
    }

    if (!organization.admin_approved) {
      const isAdminUser = await isCurrentUserPlatformAdmin(authedReq);
      if (!isAdminUser) {
        if (!currentUserId) {
          debugLog(`[org-get] unapproved+anon: id=${id}`);
          return res.status(404).json({ error: 'Organization not found' });
        }
        const [membership, pendingJoin] = await Promise.all([
          getOrganizationMembership(currentUserId, id),
          getOrganizationJoinRequestStateForUser(id, currentUserId),
        ]);
        const hasAccess = membership?.status === 'active' || pendingJoin?.status === 'pending';
        if (!hasAccess) {
          debugLog(`[org-get] unapproved+no-access: id=${id} user=${currentUserId}`);
          return res.status(404).json({ error: 'Organization not found' });
        }
      }
    }

    const viewerMembership = currentUserId
      ? await getOrganizationMembership(currentUserId, id)
      : null;
    const viewerRole =
      viewerMembership?.status === 'active' ? String(viewerMembership.role || '') : null;
    const isMember = viewerMembership?.status === 'active';
    const isOwner = viewerRole === ORGANIZATION_OWNER_ROLE;
    const canManage = isOrganizationAdmin(viewerRole);

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
        viewerRole,
        isMember,
        isOwner,
        canEdit: isOwner,
        canManage,
        canReviewCoaches: isOwner,
      })
    );
  })
);
