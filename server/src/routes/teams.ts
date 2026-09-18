import { MembershipStatus, Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { isOrganizationApproved } from '../lib/approvalService.js';
import { debugLog } from '../lib/debugLog.js';
import { ASSET_URL_MESSAGE, isAllowedAssetUrl } from '../lib/mediaHosts.js';
import { withDistributedLock } from '../lib/distributedLock.js';
import { sendStaffMemberJoinedEmail, sendTeamInviteEmail } from '../lib/email.js';
import { sendError } from '../lib/http/sendError.js';
import { getOrganizationState } from '../lib/organizationState.js';
import { DEMO_LEAGUE_NAMES } from '../lib/demoContent.js';
import { getVeteranTotalTeamAllowance, resolveOwnerBillingOrgId } from '../lib/paymentInternals.js';
import { GAME_SUMMARY_SELECT } from '../lib/serializeGame.js';
import { SERVER_ROOKIE_PROGRAM_LIMIT } from '../lib/planDefinitions.js';
import { getAuthorizedUsersPerTeam, planSupportsExtracurricular } from '../lib/planLimits.js';
import { prisma } from '../lib/prisma.js';
import {
  getExcludedPrivateTeamIds,
  invalidatePrivateTeamIdsCache,
  isTeamHiddenFromViewer,
} from '../lib/privacyUtils.js';
import { sendPushNotification } from '../lib/pushNotifications.js';
import { stripHtml } from '../lib/sanitizeHtml.js';
import { buildTeamSerializeSelect, serializeTeam } from '../lib/serializeTeam.js';
import { customSportSlug, normalizeSportToSlug } from '../lib/sportsTaxonomy.js';
import { getTeamScheduleFeed } from '../lib/teamScheduleFeed.js';
import {
  buildTeamCreateOrganizationError,
  encodeManagedTeamCursor,
  parseManagedTeamCursor,
  serializeTeamMember,
  type ManagedTeamCursor,
} from '../lib/teamRouteHelpers.js';
import {
  buildTeamCreateBillingContext,
  countBillableProgramsForContext,
  getVeteranSubscriptionAllowance,
  resolveOrganizationIdForTeamCreate,
  validateTeamCreateOrganizationAccess,
  type TeamCreatePayload,
} from '../lib/teamCreate.js';
import {
  canAdministerTeam as canAdministerTeamScoped,
  canAssignTeamRole as canAssignTeamRoleScoped,
  canArchiveTeam as canArchiveTeamScoped,
  ORG_ADMIN_ROLES,
  TEAM_STAFF_ROLES,
} from '../lib/teamAuthorization.js';
import { logAdminActivityFromReq } from '../lib/adminActivityLogger.js';
import {
  buildRosterLimitError,
  buildTeamPlanLockedError,
  getTeamEntitlementState,
  getTeamEntitlementStates,
  isAuthorizedTeamRole,
  isManagementRole,
  TEAM_AUTHORIZED_ROLES,
} from '../lib/teamEntitlements.js';
import { fanOutProgramFollowersToTeam } from '../lib/programFollowFanout.js';
import { getTeamState, listTeamStates } from '../lib/teamState.js';
import { getCanonicalUserRole, isUserOnboardingComplete } from '../lib/userAuthState.js';
import { getEffectiveEntitledPlan } from '../lib/userBillingState.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import type { AuthedRequest } from '../middleware/auth.js';
import {
  followLimiter,
  inviteLimiter,
  teamCreationLimiter,
  teamUpdateLimiter,
} from '../middleware/rateLimiters.js';
import { getIsAdmin } from '../middleware/requireAdmin.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireOnboarded } from '../middleware/requireOnboarded.js';
import { requireVerified } from '../middleware/requireVerified.js';
import { getUserPlan, requirePlan } from '../middleware/subscription.js';
import { registerIdValidation } from '../middleware/validateParams.js';

export const teamsRouter = Router();

// 2026-07-09: player/parent/member retired — teams hold staff only. Shared by
// the create-time `authorized_users` cap pre-check and the fan-out below, so
// the count that is validated is exactly the set that gets written.
const CREATE_INVITE_ROLES = new Set([
  'manager',
  'coach',
  'assistant_coach',
  'equipment',
  'health_wellness',
]);

/**
 * The invites a create-time `authorized_users` payload would actually write:
 * role-whitelisted and de-duplicated by email, since `createMany` collapses
 * duplicates on the (team_id, email) unique index.
 */
function resolveCreateTimeInvites(
  authorizedUsers: TeamCreatePayload['authorized_users']
): { email: string; role: string }[] {
  const byEmail = new Map<string, { email: string; role: string }>();
  for (const user of authorizedUsers || []) {
    const email = typeof user.email === 'string' ? user.email.trim() : '';
    const role = String(user.role || '');
    if (!email || !CREATE_INVITE_ROLES.has(role)) continue;
    const key = email.toLowerCase();
    if (!byEmail.has(key)) byEmail.set(key, { email, role });
  }
  return [...byEmail.values()];
}
registerIdValidation(teamsRouter);
const teamGroupChatLocks = new Map<string, Promise<any>>();

/**
 * Remove a user from every group chat belonging to a team. Called when a member
 * is removed or archived from the roster so ex-staff lose access to the team
 * chat (access is gated purely on GroupChatMember, so deleting these rows
 * revokes read+write immediately). Accepts a tx client to run inside the
 * membership-mutation transaction.
 */
export async function removeUserFromTeamGroupChats(
  teamId: string,
  userId: string,
  client: {
    groupChat: { findMany: (args: any) => Promise<Array<{ id: string }>> };
    groupChatMember: { deleteMany: (args: any) => Promise<unknown> };
  } = prisma as any
): Promise<void> {
  const chats = await client.groupChat.findMany({
    where: { team_id: teamId },
    select: { id: true },
    take: 100,
  });
  if (chats.length === 0) return;
  await client.groupChatMember.deleteMany({
    where: { chat_id: { in: chats.map(c => c.id) }, user_id: userId },
  });
}

export async function ensureTeamGroupChatMembershipExternal(teamId: string, userId: string) {
  return ensureTeamGroupChatMembership(teamId, userId);
}

async function ensureTeamGroupChatMembership(teamId: string, userId: string) {
  return withDistributedLock(
    {
      namespace: 'team-group-chat',
      key: teamId,
      localLocks: teamGroupChatLocks,
      ttlMs: 5_000,
      acquireTimeoutMs: 5_000,
    },
    async () => {
      let groupChat = await prisma.groupChat.findFirst({
        where: { team_id: teamId },
        orderBy: { created_at: 'asc' },
      });

      if (!groupChat) {
        const team = await prisma.team.findUnique({
          where: { id: teamId },
          select: { name: true },
        });
        const allMembers = await prisma.teamMembership.findMany({
          where: { team_id: teamId, status: 'active' },
          select: { user_id: true },
          take: 500,
        });

        groupChat = await prisma.groupChat.create({
          data: {
            name: `${team?.name || 'Team'} Chat`,
            team_id: teamId,
            created_by: userId,
            members: {
              create: allMembers.map(member => ({ user_id: member.user_id })),
            },
          },
        });
      } else {
        const existingMember = await prisma.groupChatMember.findFirst({
          where: { chat_id: groupChat.id, user_id: userId },
        });

        if (!existingMember) {
          await prisma.groupChatMember.create({
            data: { chat_id: groupChat.id, user_id: userId },
          });
        }
      }

      return groupChat;
    }
  );
}

async function loadTeamViewerAccess(teamId: string, viewerId: string | null) {
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    select: buildTeamSerializeSelect({
      includeCounts: true,
      includeOrganization: true,
    }),
  });
  if (!team) return null;

  const teamState = await getTeamState(teamId);
  const isAdmin = viewerId ? await getIsAdmin({ user: { id: viewerId } } as any) : false;

  let membership: { role: string } | null = null;
  let isOrgAdmin = false;
  // Org OWNER is a stronger tier than org admin (owner|manager). Full team
  // administration (settings, roster role-change, invites, archive, transfer)
  // requires org OWNER, not just org admin — so track it distinctly.
  let isOrgOwner = false;
  if (viewerId) {
    const [resolvedMembership, orgMembership] = await Promise.all([
      prisma.teamMembership.findFirst({
        where: { team_id: teamId, user_id: viewerId, status: 'active' },
        select: { role: true },
      }),
      team.organization_id
        ? prisma.organizationMembership.findFirst({
            where: {
              organization_id: team.organization_id,
              user_id: viewerId,
              role: { in: ['owner', 'manager'] },
              status: 'active',
            },
            select: { role: true },
          })
        : Promise.resolve(null),
    ]);
    membership = resolvedMembership;
    isOrgAdmin = !!orgMembership;
    isOrgOwner = orgMembership?.role === 'owner';
  }

  return {
    team: {
      ...team,
      status: teamState?.status ?? null,
    },
    membership,
    isAdmin,
    isOrgAdmin,
    isOrgOwner,
  };
}

// Get teams managed by current user (requires authentication)
teamsRouter.get(
  '/managed',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });

    const q = String((req.query as any).q || '')
      .trim()
      .toLowerCase();
    const limitRaw = Number.parseInt(String((req.query as any).limit || ''), 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 50;
    const cursorRaw =
      typeof (req.query as any).cursor === 'string' ? String((req.query as any).cursor) : null;
    const cursor = cursorRaw ? parseManagedTeamCursor(cursorRaw) : null;
    if (cursorRaw && !cursor) {
      return sendError(res, 400, 'INVALID_CURSOR', {
        message: 'Managed teams cursor is invalid.',
      });
    }
    const userId = req.user.id;
    const managementRoles = [...TEAM_STAFF_ROLES];
    const managementRoleSql = Prisma.join(
      managementRoles.map(role => Prisma.sql`${role}::"TeamRole"`)
    );
    // Mirror `canManageAnyTeam`: team access is a staff TeamMembership OR being
    // an org admin of the team's organization. This list previously implemented
    // only the first half, so an organizer whose coaches created the teams saw
    // none of their own org's teams — even though the gate says they may manage
    // them. Kept in lockstep with ORG_ADMIN_ROLES so the list can never show a
    // team the gate would then refuse (or hide one it would allow).
    const orgAdminRoleSql = Prisma.join(
      [...ORG_ADMIN_ROLES].map(role => Prisma.sql`${role}::"OrganizationRole"`)
    );

    const select: any = {
      ...buildTeamSerializeSelect({
        includeCounts: true,
        includeOrganization: true,
      }),
      memberships: {
        where: { user_id: userId, status: MembershipStatus.active },
        select: { role: true },
      },
    };
    const batchSize = Math.min(Math.max(limit * 2, 25), 100);
    let exhausted = false;
    let rawCursor = cursor;
    const visibleRows: Array<{ team: any; cursor: ManagedTeamCursor }> = [];

    while (visibleRows.length < limit + 1 && !exhausted) {
      const searchClause = q ? Prisma.sql`AND t."name" ILIKE ${`%${q}%`}` : Prisma.empty;
      const cursorClause = rawCursor
        ? Prisma.sql`AND ROW(o."name", t."name", t."id") > ROW(${rawCursor.orgName}, ${rawCursor.teamName}, ${rawCursor.teamId})`
        : Prisma.empty;

      const candidates = await prisma.$queryRaw<
        Array<{ id: string; org_name: string; team_name: string }>
      >(
        Prisma.sql`
            SELECT t."id", o."name" AS org_name, t."name" AS team_name
            FROM "Team" t
            INNER JOIN "Organization" o ON o."id" = t."organization_id"
            WHERE t."status" = 'active'
              AND (
                EXISTS (
                  SELECT 1
                  FROM "TeamMembership" tm
                  WHERE tm."team_id" = t."id"
                    AND tm."user_id" = ${userId}
                    AND tm."status" = 'active'
                    AND tm."role" IN (${managementRoleSql})
                )
                OR EXISTS (
                  SELECT 1
                  FROM "OrganizationMembership" om
                  WHERE om."organization_id" = t."organization_id"
                    AND om."user_id" = ${userId}
                    AND om."status" = 'active'
                    AND om."role" IN (${orgAdminRoleSql})
                )
              )
              ${searchClause}
              ${cursorClause}
            ORDER BY o."name" ASC, t."name" ASC, t."id" ASC
            LIMIT ${batchSize}
          `
      );

      exhausted = candidates.length < batchSize;
      if (candidates.length === 0) break;

      rawCursor = {
        orgName: candidates[candidates.length - 1]!.org_name,
        teamName: candidates[candidates.length - 1]!.team_name,
        teamId: candidates[candidates.length - 1]!.id,
      };

      const teamIds = candidates.map(team => team.id);
      const [rows, entitlementsByTeamId] = await Promise.all([
        prisma.team.findMany({
          where: { id: { in: teamIds } },
          select,
          take: teamIds.length,
        }),
        getTeamEntitlementStates(prisma, teamIds),
      ]);
      const rowsById = new Map<string, any>();
      for (const team of rows as Array<any>) {
        rowsById.set(team.id, team);
      }

      for (const candidate of candidates) {
        const entitlement = entitlementsByTeamId.get(candidate.id);
        if (entitlement?.teamLocked) continue;
        const hydrated = rowsById.get(candidate.id);
        if (!hydrated) continue;
        visibleRows.push({
          team: hydrated,
          cursor: {
            orgName: candidate.org_name,
            teamName: candidate.team_name,
            teamId: candidate.id,
          },
        });
        if (visibleRows.length >= limit + 1) break;
      }
    }

    const hasMore = visibleRows.length > limit;
    const pageEntries = hasMore ? visibleRows.slice(0, limit) : visibleRows;
    const pageRows = pageEntries.map(entry => entry.team);
    const nextCursor = hasMore
      ? encodeManagedTeamCursor(pageEntries[pageEntries.length - 1]!.cursor)
      : null;
    const teamStateById = new Map(
      (await listTeamStates(pageRows.map(team => team.id))).map(team => [team.id, team])
    );

    const followedTeamRows = await prisma.teamFollow.findMany({
      where: { user_id: userId, team_id: { in: pageRows.map(team => team.id) } },
      select: { team_id: true },
      take: Math.max(pageRows.length, 1),
    });
    const followedTeamIds = new Set(followedTeamRows.map(row => row.team_id));

    const list = pageRows.map(team =>
      serializeTeam(
        {
          ...team,
          status: teamStateById.get(team.id)?.status ?? null,
        },
        {
          includeCounts: true,
          includeOrganization: true,
          includeViewerState: true,
          viewerRole: team.memberships?.[0]?.role ?? null,
          isFollowing: followedTeamIds.has(team.id),
        }
      )
    );

    if (nextCursor) {
      res.set('x-next-cursor', nextCursor);
    }
    res.set('x-has-more', hasMore ? '1' : '0');
    return res.json(list);
  })
);

// Check team creation limits for current user
teamsRouter.get(
  '/limits',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: {
        id: true,
        preferences: true,
        plan: true,
        pending_plan: true,
        payment_pending: true,
        payment_approved: true,
        paid_by_owner: true,
        subscription_tier: true,
      },
    });
    if (!user) return res.status(401).json({ error: 'User not found' });

    const billingContext = await buildTeamCreateBillingContext(req.user!.id, user);
    const ownedProgramsCount = await countBillableProgramsForContext(
      prisma,
      req.user!.id,
      billingContext
    );
    const effectivePlan = billingContext.effectivePlan;

    // maxPrograms === null means unlimited (display 999 on legacy fields).
    let maxPrograms: number | null = SERVER_ROOKIE_PROGRAM_LIMIT;
    let canCreateMore = true;
    let metered = false;

    if (effectivePlan === 'veteran') {
      const subscriptionId = billingContext.effectiveSubscriptionId;
      if (!subscriptionId) {
        // Flat-tier IAP purchase (Apple/Google) — no Stripe quantity to meter
        // against, so this rail is unlimited, not blocked.
        maxPrograms = null;
        canCreateMore = true;
        metered = false;
      } else {
        metered = true;
        try {
          const allowance = await getVeteranSubscriptionAllowance(subscriptionId);
          maxPrograms = allowance.totalTeamAllowance;
          canCreateMore = allowance.active && ownedProgramsCount < allowance.totalTeamAllowance;
        } catch (err) {
          console.error('[teams] limits veteran allowance verification failed:', err);
          maxPrograms = ownedProgramsCount;
          canCreateMore = false;
        }
      }
    } else if (effectivePlan === 'legend') {
      maxPrograms = null;
      canCreateMore = true;
      metered = false;
    } else {
      // Rookie (or any unrecognized/default plan) — free floor of
      // SERVER_ROOKIE_PROGRAM_LIMIT billable sport programs.
      maxPrograms = SERVER_ROOKIE_PROGRAM_LIMIT;
      canCreateMore = ownedProgramsCount < SERVER_ROOKIE_PROGRAM_LIMIT;
      metered = false;
    }

    const maxProgramsDisplay = maxPrograms === null ? 999 : maxPrograms;
    const remaining = maxPrograms === null ? 999 : Math.max(0, maxPrograms - ownedProgramsCount);
    const subscriptionTier = effectivePlan ?? (user as any).subscription_tier ?? 'free';

    return res.json({
      owned_programs: ownedProgramsCount,
      max_programs: maxPrograms,
      metered,
      // Legacy fields — kept for older client bundles that read team-based
      // names; the values are program-based now (see Phase 4 billing re-unit).
      owned_teams: ownedProgramsCount,
      max_teams: maxProgramsDisplay,
      can_create_more: canCreateMore,
      remaining,
      subscription_tier: subscriptionTier,
      upgrade_required: !canCreateMore,
    });
  })
);

teamsRouter.get(
  '/:id/admin-summary',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const teamId = String(req.params.id);
    const viewerId = req.user?.id || null;
    if (!viewerId) return res.status(401).json({ error: 'Authentication required' });

    const access = await loadTeamViewerAccess(teamId, viewerId);
    if (!access) return res.status(404).json({ error: 'Team not found' });

    const canManage =
      access.isAdmin || access.isOrgAdmin || isManagementRole(access.membership?.role);
    if (!canManage) {
      return res.status(403).json({
        error: 'Only team staff, league admins, or platform admins can view admin summary',
      });
    }

    // Full-administration tier (canAdministerTeam): team owner/head coach, org
    // OWNER, or platform admin. This is the authority for settings edit, roster
    // add/remove/role-change, invite create/cancel, and archive — distinct from
    // canManage (the staff tier that also admits managers/assistant_coaches for
    // roster + event approvals only). Exposed so clients stop rendering
    // admin-only buttons to the staff tier (which the server then 403s).
    const teamRole = String(access.membership?.role ?? '');
    const canAdminister =
      access.isAdmin || access.isOrgOwner || teamRole === 'owner' || teamRole === 'coach';
    // Ownership transfer: team owner/coach or org owner (matches the transfer route).
    const canTransfer = access.isOrgOwner || teamRole === 'owner' || teamRole === 'coach';

    const entitlement = await getTeamEntitlementState(prisma, teamId);
    if (entitlement.teamLocked) {
      return res.status(403).json(buildTeamPlanLockedError(entitlement));
    }

    const [memberships, pendingInvites, upcomingGames] = await Promise.all([
      prisma.teamMembership.findMany({
        where: { team_id: teamId, status: 'active' },
        orderBy: { created_at: 'asc' },
        take: 500,
        include: {
          user: {
            select: {
              id: true,
              display_name: true,
              avatar_url: true,
              username: true,
              email: true,
              preferences: true,
            },
          },
        },
      }),
      prisma.teamInvite.findMany({
        where: { team_id: teamId, status: 'pending' },
        orderBy: { created_at: 'desc' },
        take: 100,
        select: {
          id: true,
          email: true,
          role: true,
          status: true,
          created_at: true,
        },
      }),
      prisma.game.findMany({
        where: {
          approval_status: 'approved',
          // Opponent-approval workflow: exclude games still awaiting/declined
          // opponent consent from this team's public upcoming-games list.
          opponent_approval_status: { in: ['not_required', 'approved'] },
          date: { gte: new Date() },
          OR: [{ home_team_id: teamId }, { away_team_id: teamId }],
        },
        orderBy: { date: 'asc' },
        take: 20,
        select: GAME_SUMMARY_SELECT,
      }),
    ]);

    const staffCount = memberships.filter(membership =>
      ['owner', 'manager', 'coach', 'assistant_coach'].includes(String(membership.role))
    ).length;

    return res.json({
      team: serializeTeam(access.team, {
        includeCounts: true,
        includeOrganization: true,
        includeViewerState: true,
        viewerRole: access.membership?.role ?? null,
        canManageTeam: canManage,
        canAdministerTeam: canAdminister,
        isOrgAdmin: access.isOrgAdmin,
      }),
      permissions: {
        can_manage: canManage,
        can_administer: canAdminister,
        can_archive: canAdminister,
        can_transfer: canTransfer,
        membership_role: access.membership?.role ?? null,
        via_org_admin: access.isOrgAdmin && !isManagementRole(access.membership?.role),
        via_org_owner: access.isOrgOwner,
      },
      counts: {
        members: memberships.length,
        staff: staffCount,
        pending_invites: pendingInvites.length,
        upcoming_games: upcomingGames.length,
      },
      members: memberships.map(member => serializeTeamMember(member, true)),
      pending_invites: pendingInvites.map(invite => ({
        ...invite,
        created_at:
          invite.created_at instanceof Date
            ? invite.created_at.toISOString()
            : String(invite.created_at),
      })),
      upcoming_games: upcomingGames.map(game => ({
        ...game,
        date: game.date instanceof Date ? game.date.toISOString() : String(game.date),
      })),
    });
  })
);

teamsRouter.get(
  '/:id/screen-summary',
  asyncHandler(async (req, res) => {
    const teamId = String(req.params.id);
    const viewerId = (req as AuthedRequest).user?.id ?? null;
    const access = await loadTeamViewerAccess(teamId, viewerId);
    if (!access) return res.status(404).json({ error: 'Team not found' });

    if (!access.isAdmin) {
      const hidden = await isTeamHiddenFromViewer(teamId, viewerId);
      if (hidden) return res.status(404).json({ error: 'Not found' });
    }

    const canManage =
      access.isAdmin || access.isOrgAdmin || isManagementRole(access.membership?.role);

    const [memberships, approvedGames] = await Promise.all([
      prisma.teamMembership.findMany({
        where: { team_id: teamId, status: 'active' },
        orderBy: { created_at: 'asc' },
        take: 500,
        include: {
          user: {
            select: {
              id: true,
              display_name: true,
              avatar_url: true,
              username: true,
              preferences: true,
            },
          },
        },
      }),
      prisma.game.findMany({
        where: {
          approval_status: 'approved',
          // Opponent-approval workflow: exclude games still awaiting/declined
          // opponent consent from this team's public game list.
          opponent_approval_status: { in: ['not_required', 'approved'] },
          OR: [{ home_team_id: teamId }, { away_team_id: teamId }],
        },
        orderBy: { date: 'desc' },
        take: 20,
        select: GAME_SUMMARY_SELECT,
      }),
    ]);

    // Merged public schedule (approved+visible games + standalone events) — the
    // single source of truth the Events tab renders. `games` stays for back-compat.
    const schedule = await getTeamScheduleFeed([teamId], viewerId);

    return res.json({
      team: serializeTeam(access.team, {
        includeCounts: true,
        includeOrganization: true,
        includeViewerState: true,
        viewerRole: access.membership?.role ?? null,
        canManageTeam: canManage,
        isOrgAdmin: access.isOrgAdmin,
      }),
      permissions: {
        can_manage: canManage,
        membership_role: access.membership?.role ?? null,
        via_org_admin: access.isOrgAdmin && !isManagementRole(access.membership?.role),
      },
      counts: {
        members: memberships.length,
        games: approvedGames.length,
      },
      members: memberships.map(member => serializeTeamMember(member, false)),
      games: approvedGames.map(game => ({
        ...game,
        date: game.date instanceof Date ? game.date.toISOString() : String(game.date),
      })),
      schedule,
    });
  })
);

// List teams with member counts; optional search q
teamsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const q = String((req.query as any).q || '')
      .trim()
      .toLowerCase();
    const all = String((req.query as any).all || '') === '1';
    const mine = String((req.query as any).mine || '') === '1';
    const directory = String((req.query as any).directory || '') === '1'; // Team directory search
    const orgIdFilter = String((req.query as any).organization_id || '').trim() || null;
    const excludeDemoLeagues = String((req.query as any).exclude_demo_leagues || '') === '1';
    const limitRaw = Number.parseInt(String((req.query as any).limit ?? ''), 10);
    const take = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : undefined;

    if (all) {
      // Admin-only view flag; otherwise fall back to normal list
      const isAdmin = await getIsAdmin(req as any);
      if (!isAdmin) return res.status(403).json({ error: 'Admin only' });
    }

    let where: any = all ? {} : { status: 'active' };
    const currentUserId = (req as AuthedRequest).user?.id ?? null;
    const isAdmin = currentUserId ? await getIsAdmin(req as any) : false;
    const privateTeamExcludeIds =
      !all && !isAdmin ? await getExcludedPrivateTeamIds(currentUserId) : [];
    if (privateTeamExcludeIds.length > 0) {
      where.id = { notIn: privateTeamExcludeIds };
    }
    // Opt-in only — the FIFA demo bracket stays fully discoverable everywhere
    // else (feed, general search); this flag exists for opponent-selection
    // flows where the result must be a real, challengeable VarsityHub team.
    // `league` is nullable, and Prisma's NOT/notIn on a nullable field
    // excludes null rows too (SQL 3-valued logic) — the explicit `league: null`
    // branch keeps every ordinary team (no league set) in the results.
    if (excludeDemoLeagues) {
      where.AND = [
        ...(where.AND ?? []),
        { OR: [{ league: null }, { league: { notIn: [...DEMO_LEAGUE_NAMES] } }] },
      ];
    }

    // Directory search: search across name, city, league, sport
    if (directory && q) {
      where.OR = [
        { name: { contains: q, mode: 'insensitive' } },
        { city: { contains: q, mode: 'insensitive' } },
        { state: { contains: q, mode: 'insensitive' } },
        { league: { contains: q, mode: 'insensitive' } },
        { sport: { contains: q, mode: 'insensitive' } },
      ];
    } else if (q) {
      where.name = { contains: q, mode: 'insensitive' };
    }

    // Filter to only teams where the current user has management roles
    if (mine) {
      const authReq = req as AuthedRequest;
      if (!authReq.user) {
        return res.status(401).json({ error: 'Authentication required to view managed teams' });
      }

      const userId = authReq.user.id;
      const managementRoles = [...TEAM_STAFF_ROLES];

      where.memberships = {
        some: {
          user_id: userId,
          role: { in: managementRoles },
          status: MembershipStatus.active,
        },
      };
    }

    // Filter by organization if requested
    if (orgIdFilter) {
      where.organization_id = orgIdFilter;
    }

    const rows = await prisma.team.findMany({
      where,
      orderBy: { created_at: 'desc' },
      take: take,
      select: buildTeamSerializeSelect({
        includeCounts: true,
        includeOrganization: true,
      }),
    });
    const teamStateById = new Map(
      (await listTeamStates(rows.map(team => team.id))).map(team => [team.id, team])
    );
    const teamIds = rows.map(team => team.id);
    const [viewerMemberships, followedTeamRows] = await Promise.all([
      currentUserId
        ? prisma.teamMembership.findMany({
            where: {
              user_id: currentUserId,
              status: MembershipStatus.active,
              team_id: { in: teamIds },
            },
            select: { team_id: true, role: true },
            take: Math.max(teamIds.length, 1),
          })
        : Promise.resolve([]),
      currentUserId
        ? prisma.teamFollow.findMany({
            where: { user_id: currentUserId, team_id: { in: teamIds } },
            select: { team_id: true },
            take: Math.max(teamIds.length, 1),
          })
        : Promise.resolve([]),
    ]);
    const viewerRoleByTeamId = new Map(
      viewerMemberships.map(membership => [membership.team_id, membership.role])
    );
    const followedTeamIds = new Set(followedTeamRows.map(row => row.team_id));

    const list = rows.map(team =>
      serializeTeam(
        {
          ...team,
          status: teamStateById.get(team.id)?.status ?? null,
        },
        {
          includeCounts: true,
          includeOrganization: true,
          includeViewerState: true,
          viewerRole: viewerRoleByTeamId.get(team.id) ?? null,
          isFollowing: currentUserId ? followedTeamIds.has(team.id) : null,
        }
      )
    );
    return res.json(list);
  })
);

// Follow a team
teamsRouter.post(
  '/:id/follow',
  requireAuth as any,
  followLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const userId = req.user!.id;
      const teamId = String(req.params.id);
      const team = await getTeamState(teamId);
      if (!team) return res.status(404).json({ error: 'Team not found' });
      if (team.status !== 'active') return res.status(404).json({ error: 'Team not found' });
      // Upsert (not create) so a direct follow always records GENUINE intent.
      // If a program fan-out already created a stamped row (via_program_id set),
      // this PROMOTES it to a real direct follow by clearing the stamp — so a
      // later program-unfollow (which deletes only this-program-stamped rows)
      // no longer wipes the user's explicit direct follow. This is the inverse
      // of the direct-then-program lossless case: both directions now survive.
      // Note the compound unique input `user_id_team_id` matches TeamFollow's
      // @@id([user_id, team_id]).
      const existingFollow = await prisma.teamFollow.findUnique({
        where: { user_id_team_id: { user_id: userId, team_id: teamId } },
        select: { user_id: true },
      });
      await prisma.teamFollow.upsert({
        where: { user_id_team_id: { user_id: userId, team_id: teamId } },
        create: { user_id: userId, team_id: teamId },
        update: { via_program_id: null },
      });

      // Notify team coaches/owners only on a brand-new follow — mirrors the old
      // create/P2002 control flow, where an already-following user (or now, a
      // stamped-row promotion) sent no notification and just returned 201.
      if (!existingFollow) {
        try {
          const follower = await prisma.user.findUnique({
            where: { id: userId },
            select: { display_name: true },
          });
          const followerName = follower?.display_name || 'Someone';

          const managers = await prisma.teamMembership.findMany({
            where: {
              team_id: teamId,
              role: { in: ['owner', 'manager', 'coach'] },
              status: 'active',
              user_id: { not: userId },
            },
            select: { user_id: true },
            take: 100,
          });

          // Batch: create all notifications in one query, send push in parallel
          if (managers.length > 0) {
            await prisma.notification.createMany({
              data: managers.map(mgr => ({
                user_id: mgr.user_id,
                actor_id: userId,
                type: 'TEAM_FOLLOWED',
                meta: { team_id: teamId, team_name: team!.name, follower_name: followerName },
              })),
            });
            await Promise.allSettled(
              managers.map(mgr =>
                sendPushNotification(
                  mgr.user_id,
                  `New follower`,
                  `${followerName} is now following ${team!.name}`,
                  { type: 'team_followed', team_id: teamId, screen: 'team-page' }
                )
              )
            );
          }
        } catch (notifErr) {
          console.error('[teams] Failed to send team followed notification:', notifErr);
        }
      }

      return res.status(201).json({ is_following: true });
    } catch (e: any) {
      console.error('[teams] follow error:', e?.message || e);
      return res.status(500).json({ error: 'Failed to follow team' });
    }
  })
);

// Unfollow a team
teamsRouter.delete(
  '/:id/follow',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      const userId = req.user!.id;
      const teamId = String(req.params.id);
      await prisma.teamFollow.deleteMany({ where: { user_id: userId, team_id: teamId } });
      return res.json({ is_following: false });
    } catch (e: any) {
      console.error('[teams] unfollow error:', e?.message || e);
      return res.status(500).json({ error: 'Failed to unfollow team' });
    }
  })
);

// Team details with counts
teamsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = String(req.params.id);
    const currentUserId = (req as AuthedRequest).user?.id ?? null;
    const t = await prisma.team.findUnique({
      where: { id },
      select: buildTeamSerializeSelect({
        includeCounts: true,
        includeOrganization: true,
      }),
    });
    if (!t) return res.status(404).json({ error: 'Not found' });
    const teamState = await getTeamState(id);
    const isAdmin = currentUserId ? await getIsAdmin(req as any) : false;
    if (!isAdmin) {
      const hidden = await isTeamHiddenFromViewer(id, currentUserId);
      if (hidden) return res.status(404).json({ error: 'Not found' });
    }

    let membership: { role: string } | null = null;
    let isOrgAdmin = false;
    if (currentUserId) {
      const [resolvedMembership, orgMembership] = await Promise.all([
        prisma.teamMembership.findFirst({
          where: { team_id: id, user_id: currentUserId, status: 'active' },
          select: { role: true },
        }),
        t.organization_id
          ? prisma.organizationMembership.findFirst({
              where: {
                organization_id: t.organization_id,
                user_id: currentUserId,
                role: { in: ['owner', 'manager'] },
                status: 'active',
              },
              select: { id: true },
            })
          : Promise.resolve(null),
      ]);
      membership = resolvedMembership;
      isOrgAdmin = !!orgMembership;

      const hasPrivilegedAccess = !!isAdmin || isOrgAdmin || isManagementRole(membership?.role);
      if (hasPrivilegedAccess) {
        const entitlement = await getTeamEntitlementState(prisma, id);
        if (entitlement.teamLocked) {
          return res.status(403).json(buildTeamPlanLockedError(entitlement));
        }
      }
    }

    const isFollowing = currentUserId
      ? !!(await prisma.teamFollow.findFirst({ where: { user_id: currentUserId, team_id: id } }))
      : null;

    return res.json(
      serializeTeam(
        {
          ...t,
          status: teamState?.status ?? null,
        },
        {
          includeCounts: true,
          includeOrganization: true,
          includeViewerState: true,
          isFollowing,
          viewerRole: membership?.role ?? null,
          canManageTeam: isManagementRole(membership?.role) || isOrgAdmin,
          isOrgAdmin,
        }
      )
    );
  })
);

// Team members list (auth required — roster visibility)
// Restricted to team members, org admins (owner/manager), or platform admins
teamsRouter.get(
  '/:id/members',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const id = String(req.params.id);
    const team = await prisma.team.findUnique({
      where: { id },
      select: { id: true, organization_id: true, is_private: true },
    });
    if (!team) return res.status(404).json({ error: 'Team not found' });

    const isAdmin = await getIsAdmin(req as any);
    const teamMembership = await prisma.teamMembership.findFirst({
      where: { team_id: id, user_id: req.user!.id, status: 'active' },
      select: { id: true, role: true },
    });
    let isOrgAdmin = false;
    if (team.organization_id) {
      const orgMembership = await prisma.organizationMembership.findFirst({
        where: {
          organization_id: team.organization_id,
          user_id: req.user!.id,
          role: { in: ['owner', 'manager'] },
          status: 'active',
        },
        select: { id: true },
      });
      isOrgAdmin = !!orgMembership;
    }
    if (!isAdmin && !teamMembership && !isOrgAdmin) {
      return res.status(403).json({
        error: 'Only team members, league admins, or platform admins can view the roster',
      });
    }

    if (isAdmin || isOrgAdmin || isManagementRole(teamMembership?.role)) {
      const entitlement = await getTeamEntitlementState(prisma, id);
      if (entitlement.teamLocked) {
        return res.status(403).json(buildTeamPlanLockedError(entitlement));
      }
    }

    const mems = await prisma.teamMembership.findMany({
      where: { team_id: id },
      orderBy: { created_at: 'asc' },
      take: 500,
      include: {
        user: {
          select: {
            id: true,
            display_name: true,
            avatar_url: true,
            username: true,
            preferences: true,
          },
        },
      },
    });
    const list = mems.map(m => {
      const user = (m as any).user;
      const prefs = (user?.preferences || {}) as any;
      return {
        id: m.id,
        role: m.role,
        status: m.status,
        position: (m as any).custom_position || null,
        jersey_number: prefs?.jersey_number || null,
        user: {
          id: m.user_id,
          display_name: user?.display_name || null,
          avatar_url: user?.avatar_url || null,
          username: user?.username || null,
          is_parent: prefs?.is_parent === true,
        },
      };
    });
    return res.json(list);
  })
);

// All members across teams (admin screens). Paged and DB-filtered to avoid unbounded scans.
teamsRouter.get(
  '/members/all',
  requireAuth as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const isAdmin = await getIsAdmin(req);
    if (!isAdmin) return res.status(403).json({ error: 'Admin only' });

    const q = String((req.query as any).q || '').trim();
    const limitRaw = Number.parseInt(String((req.query as any).limit || '100'), 10);
    const offsetRaw = Number.parseInt(String((req.query as any).offset || '0'), 10);
    const take = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 100;
    const skip = Number.isFinite(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;

    const where = q
      ? {
          OR: [
            { user: { display_name: { contains: q, mode: 'insensitive' as const } } },
            { user: { email: { contains: q, mode: 'insensitive' as const } } },
            { team: { name: { contains: q, mode: 'insensitive' as const } } },
          ],
        }
      : {};

    const mems = await prisma.teamMembership.findMany({
      where,
      orderBy: { created_at: 'desc' },
      skip: skip,
      take: take,
      select: {
        id: true,
        role: true,
        status: true,
        user_id: true,
        team_id: true,
        user: {
          select: {
            id: true,
            email: true,
            display_name: true,
          },
        },
        team: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    const list = mems.map(m => ({
      id: m.id,
      role: m.role,
      status: m.status,
      user: {
        id: m.user_id,
        email: m.user?.email || '',
        display_name: m.user?.display_name || '',
      },
      team: { id: m.team_id, name: m.team?.name || '' },
    }));

    return res.json(list);
  })
);

// Create team (auth required). Creator becomes owner.
const TEAM_LOGO_URL_VALIDATOR = z
  .string()
  .url({ message: 'logo_url must be a valid URL' })
  .refine(isAllowedAssetUrl, ASSET_URL_MESSAGE)
  .optional()
  .or(z.literal(''));

// Single team-create payload contract. BOTH create routes derive from this —
// they previously carried separate hand-maintained schemas and drifted, so
// POST /teams silently stripped sport/club_type/venue/branding fields (Zod
// drops unknown keys) and still answered 201, filing every team under the
// org's `other` program.
const teamCreateBaseSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(1000).optional(),
  sport: z.string().max(100).optional(),
  club_type: z.enum(['sport', 'extracurricular']).optional(),
  extracurricular_category: z.string().max(100).optional(),
  season: z.string().max(50).optional(),
  primary_color: z.string().max(20).optional(),
  season_start: z.string().optional(),
  season_end: z.string().optional(),
  organization_id: z.string().optional(),
  organization_name: z.string().max(255).optional(),
  logo_url: TEAM_LOGO_URL_VALIDATOR,
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  league: z.string().max(100).optional(),
  venue_place_id: z.string().optional(),
  venue_lat: z.number().optional(),
  venue_lng: z.number().optional(),
  venue_address: z.string().optional(),
  level: z.enum(['varsity', 'jv', 'freshman', 'middle_school', 'unified', 'other']).optional(),
  gender: z.enum(['boys', 'girls', 'coed']).optional(),
  program_id: z.string().min(1).optional(),
  // Hard upper bound so one request can't fan out an unbounded invite blast;
  // the per-plan maxAuthorizedUsers cap is enforced in createTeamWithGuardrails.
  authorized_users: z
    .array(
      z.object({
        email: z.string().email().optional(),
        user_id: z.string().optional(),
        role: z.string().optional(),
        assign_team: z.string().optional(),
      })
    )
    .max(50)
    .optional(),
  onboarding: z.boolean().optional(),
});

// POST /teams keeps the stricter contract: an explicit organization_id, no
// resolve-by-name. Everything else matches POST /teams/create exactly.
const createSchema = teamCreateBaseSchema.extend({
  organization_id: z.string().min(1, 'Organization is required'),
});
async function createTeamWithGuardrails(userId: string, data: TeamCreatePayload) {
  const me = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      role: true,
      onboarding_completed: true,
      preferences: true,
      approval_status: true,
      paid_by_owner: true,
      plan: true,
      pending_plan: true,
      payment_pending: true,
      payment_approved: true,
    },
  });
  if (!me) return { status: 401, body: { error: 'Unauthorized' } };

  const canonicalRole = getCanonicalUserRole(me as any);
  const onboardingComplete = isUserOnboardingComplete(me as any);
  const isCoach = canonicalRole === 'coach';

  // Only a coach ACCOUNT can create teams. A staff membership (org owner/
  // manager, or a team-staff role) is not a substitute: a fan invited as an
  // org manager or added as team staff would otherwise create teams with no
  // coach application, agreement, or approval — contradicting "Only coach
  // accounts can create teams" and "org managers have zero admin power at the
  // org level". A coach in "proceed as fan" mode still has role === 'coach'
  // (getCanonicalUserRole reads the column), so this never blocked a real
  // coach — the old membership bypass only ever admitted genuine fan accounts.
  if (!isCoach) {
    return {
      status: 403,
      body: {
        error: 'COACH_ROLE_REQUIRED',
        message: 'Only coach accounts can create teams.',
        code: 'COACH_ROLE_REQUIRED',
      },
    };
  }

  if (isCoach && me.approval_status !== 'APPROVED') {
    const isOrgOwner = await prisma.organizationMembership.findFirst({
      where: { user_id: userId, role: 'owner', status: 'active' },
      select: { id: true },
    });
    if (!(Boolean(isOrgOwner) && !onboardingComplete)) {
      return {
        status: 403,
        body: {
          error: 'APPROVAL_REQUIRED',
          message: 'Your coach account must be approved by a league admin before creating teams.',
          code: 'APPROVAL_REQUIRED',
        },
      };
    }
  }

  // Resolve and authorize the target organization BEFORE any billing decision.
  // The org owner's plan is what gates the create, so the org has to be known
  // first — and this also covers the `organization_name` path, which previously
  // reached the billing gate with no organization id at all.
  const resolvedOrganization = await resolveOrganizationIdForTeamCreate(data);
  if ('status' in resolvedOrganization) {
    return resolvedOrganization;
  }

  const organizationAccess = await validateTeamCreateOrganizationAccess(
    me.id,
    resolvedOrganization.organizationId,
    onboardingComplete
  );
  if ('status' in organizationAccess) {
    return organizationAccess;
  }

  const organizationId = resolvedOrganization.organizationId;

  // Validate the create-time invite list against the plan cap BEFORE anything
  // is written. POST /teams/:id/invite and POST /team-invites both enforce
  // maxAuthorizedUsers; this path only had a role whitelist and a hard max(50),
  // so an over-cap payload minted invites that the accept-time backstop would
  // later refuse — inviting people who then could not join. Resolved from the
  // CREATOR's plan because they become the team owner, which is what
  // getTeamEntitlementState reads once the team exists (pre/post must agree).
  const createTimeInvites = resolveCreateTimeInvites(data.authorized_users);
  const authorizedInviteCount = createTimeInvites.filter(invite =>
    isAuthorizedTeamRole(invite.role)
  ).length;
  if (authorizedInviteCount > 0) {
    const creatorPlan = await getUserPlan(userId);
    const authorizedUsersLimit = getAuthorizedUsersPerTeam(creatorPlan);
    if (authorizedUsersLimit !== null && authorizedInviteCount > authorizedUsersLimit) {
      return {
        status: 403,
        body: {
          error: 'USER_LIMIT_REACHED',
          code: 'USER_LIMIT_REACHED',
          message: `Plan limit reached for authorized users. This team allows ${authorizedUsersLimit} authorized user${authorizedUsersLimit === 1 ? '' : 's'}.`,
          limit: authorizedUsersLimit,
          current: authorizedInviteCount,
        },
      };
    }
  }

  const billingContext = await buildTeamCreateBillingContext(userId, me, organizationId);
  const effectivePlan = billingContext.effectivePlan;
  // The caller is being gated by a plan they cannot change themselves.
  const gatedByOwnerPlan = !billingContext.callerIsOrgOwner;
  const clubType = data.club_type || 'sport';

  if (clubType === 'extracurricular' && !planSupportsExtracurricular(effectivePlan)) {
    return {
      status: 403,
      body: {
        error: 'Extracurricular clubs require Legend tier',
        message:
          'Upgrade to Legend ($19.99/year) to create extracurricular clubs like Theater, Chess, Debate, etc.',
        code: 'LEGEND_TIER_REQUIRED',
        feature: 'extracurricular_clubs',
      },
    };
  }

  // Phase 4 billing unit: sport programs, not raw team count. A team joining
  // a program that already has an active team introduces no new billable
  // unit (free level-team add-on within an existing sport).
  const targetProgramId = data.program_id ?? null;
  let targetProgramAlreadyActive = false;
  if (targetProgramId) {
    const activeInProgram = await prisma.team.count({
      where: { program_id: targetProgramId, status: 'active' },
    });
    targetProgramAlreadyActive = activeInProgram > 0;
  } else if ((data.club_type || 'sport') === 'sport') {
    // No explicit program_id: the create transaction groups this sport team into
    // the org's (organization_id, sport) program — creating it if absent, or
    // JOINING an existing one. Mirror that resolution here (read-only) so adding a
    // level team to an EXISTING sport isn't mis-gated as a brand-new billable
    // program, which false-blocked free level-team add-ons at the rookie limit.
    // Keyed on the RESOLVED org id so the `organization_name` path is covered too.
    // MUST mirror the create-transaction slug resolution (below) exactly, or the
    // billing pre-check keys on a different program than the one create writes.
    const sportSlug = normalizeSportToSlug(data.sport) ?? customSportSlug(data.sport);
    const existingProgram = await prisma.sportProgram.findUnique({
      where: {
        organization_id_sport: { organization_id: organizationId, sport: sportSlug },
      },
      select: { id: true },
    });
    if (existingProgram) {
      const activeInProgram = await prisma.team.count({
        where: { program_id: existingProgram.id, status: 'active' },
      });
      targetProgramAlreadyActive = activeInProgram > 0;
    }
  }

  if (effectivePlan === 'rookie' || !effectivePlan) {
    const billablePrograms = await countBillableProgramsForContext(prisma, userId, billingContext);
    if (!targetProgramAlreadyActive && billablePrograms >= SERVER_ROOKIE_PROGRAM_LIMIT) {
      return {
        status: 403,
        body: {
          error: 'Program limit reached',
          message: gatedByOwnerPlan
            ? `Your organization has reached the free limit (${SERVER_ROOKIE_PROGRAM_LIMIT} sports). The league owner needs to upgrade.`
            : `You've reached your free limit (${SERVER_ROOKIE_PROGRAM_LIMIT} sports). Upgrade to add another sport.`,
          code: 'PROGRAM_LIMIT_EXCEEDED',
          limit: SERVER_ROOKIE_PROGRAM_LIMIT,
          current: billablePrograms,
        },
      };
    }
  } else if (effectivePlan === 'veteran') {
    const subscriptionId = billingContext.effectiveSubscriptionId;
    if (!subscriptionId) {
      // IAP veteran (Apple/Google flat MIDTIER) — no per-unit metering possible,
      // so the flat tier grants UNLIMITED programs. Do not block. (Fixes the bug
      // where mobile veterans could not create any team.)
    } else {
      try {
        const allowance = await getVeteranSubscriptionAllowance(subscriptionId);
        if (!allowance.active) {
          return {
            status: 403,
            body: {
              error: 'Subscription not active',
              message: gatedByOwnerPlan
                ? "The league owner's Veteran subscription is not active."
                : 'Your Veteran subscription is not active. Please update your billing settings.',
              code: 'SUBSCRIPTION_NOT_ACTIVE',
            },
          };
        }

        const billablePrograms = await countBillableProgramsForContext(
          prisma,
          userId,
          billingContext
        );
        if (!targetProgramAlreadyActive && billablePrograms >= allowance.totalTeamAllowance) {
          return {
            status: 403,
            body: {
              error: 'Program limit reached',
              message: gatedByOwnerPlan
                ? `The organization's subscription currently covers ${allowance.totalTeamAllowance} sports. The league owner needs to update billing before adding another sport.`
                : `Your subscription currently covers ${allowance.totalTeamAllowance} sports. Update billing before adding another sport.`,
              code: 'SUBSCRIPTION_QUANTITY_EXCEEDED',
              paid_quantity: allowance.billableQuantity,
              allowed_total_programs: allowance.totalTeamAllowance,
              current_programs: billablePrograms,
            },
          };
        }
      } catch (err) {
        console.error('[Teams] Failed to verify Veteran subscription:', err);
        return {
          status: 500,
          body: {
            error: 'Subscription verification failed',
            message: 'Unable to verify your subscription. Please try again or contact support.',
          },
        };
      }
    }
  }

  if (data.program_id) {
    const program = await prisma.sportProgram.findUnique({
      where: { id: data.program_id },
      select: { id: true, organization_id: true },
    });
    if (!program || program.organization_id !== organizationId) {
      return {
        status: 400,
        body: {
          error: 'PROGRAM_ORG_MISMATCH',
          message: 'program_id must belong to the same organization as the team.',
          code: 'PROGRAM_ORG_MISMATCH',
        },
      };
    }
  }

  try {
    const team = await prisma.$transaction(
      async tx => {
        if (effectivePlan === 'rookie' || !effectivePlan) {
          const billablePrograms = await countBillableProgramsForContext(tx, me.id, billingContext);
          if (!targetProgramAlreadyActive && billablePrograms >= SERVER_ROOKIE_PROGRAM_LIMIT) {
            throw Object.assign(new Error('Program limit reached'), {
              status: 403,
              body: {
                error: 'Program limit reached',
                message: gatedByOwnerPlan
                  ? `Your organization has reached the free limit (${SERVER_ROOKIE_PROGRAM_LIMIT} sports). The league owner needs to upgrade.`
                  : `You've reached your free limit (${SERVER_ROOKIE_PROGRAM_LIMIT} sports). Upgrade to add another sport.`,
                code: 'PROGRAM_LIMIT_EXCEEDED',
                limit: SERVER_ROOKIE_PROGRAM_LIMIT,
                current: billablePrograms,
              },
            });
          }
        } else if (effectivePlan === 'veteran') {
          const subscriptionId = billingContext.effectiveSubscriptionId;
          if (!subscriptionId) {
            // IAP veteran (Apple/Google flat MIDTIER) — no per-unit metering possible,
            // so the flat tier grants UNLIMITED programs. Do not block. (Fixes the bug
            // where mobile veterans could not create any team.)
          } else {
            try {
              const allowance = await getVeteranSubscriptionAllowance(subscriptionId);
              if (!allowance.active) {
                throw Object.assign(new Error('Subscription not active'), {
                  status: 403,
                  body: {
                    error: 'Subscription not active',
                    message: gatedByOwnerPlan
                      ? "The league owner's Veteran subscription is not active."
                      : 'Your Veteran subscription is not active. Please update your billing settings.',
                    code: 'SUBSCRIPTION_NOT_ACTIVE',
                  },
                });
              }
              const billablePrograms = await countBillableProgramsForContext(
                tx,
                me.id,
                billingContext
              );
              if (!targetProgramAlreadyActive && billablePrograms >= allowance.totalTeamAllowance) {
                throw Object.assign(new Error('Program limit reached'), {
                  status: 403,
                  body: {
                    error: 'Program limit reached',
                    message: gatedByOwnerPlan
                      ? `The organization's subscription currently covers ${allowance.totalTeamAllowance} sports. The league owner needs to update billing before adding another sport.`
                      : `Your subscription currently covers ${allowance.totalTeamAllowance} sports. Update billing before adding another sport.`,
                    code: 'SUBSCRIPTION_QUANTITY_EXCEEDED',
                    paid_quantity: allowance.billableQuantity,
                    allowed_total_programs: allowance.totalTeamAllowance,
                    current_programs: billablePrograms,
                  },
                });
              }
            } catch (err: any) {
              if (err?.status && err?.body) throw err;
              throw Object.assign(new Error('Subscription verification failed'), {
                status: 500,
                body: {
                  error: 'Subscription verification failed',
                  message:
                    'Unable to verify your subscription. Please try again or contact support.',
                },
              });
            }
          }
        }

        // Every sport team MUST belong to a SportProgram — no ungrouped billable
        // units. If the caller didn't pass a validated program_id, resolve/create
        // the org's program for this sport. Unrecognized/custom sports fall back to
        // the taxonomy's 'other' program so nothing is ever left ungrouped.
        // Extracurricular clubs are exempt (no sport / no program).
        const isSportTeam = (data.club_type || 'sport') === 'sport';
        let resolvedProgramId: string | null = data.program_id ?? null;
        if (!resolvedProgramId && isSportTeam) {
          const canonicalSlug = normalizeSportToSlug(data.sport);
          const sportSlug = canonicalSlug ?? customSportSlug(data.sport);
          // Custom (non-canonical) sports carry a display name so the program
          // label reads "Rowing", not "custom:rowing". Canonical sports keep the
          // taxonomy label and set no name (avoids churn on existing programs).
          const programName = !canonicalSlug && data.sport?.trim() ? data.sport.trim() : null;
          const program = await tx.sportProgram.upsert({
            where: {
              organization_id_sport: { organization_id: organizationId, sport: sportSlug },
            },
            create: {
              organization_id: organizationId,
              sport: sportSlug,
              ...(programName ? { name: programName } : {}),
            },
            update: {},
            select: { id: true },
          });
          resolvedProgramId = program.id;
        }

        const newTeam = await tx.team.create({
          data: {
            name: stripHtml(data.name.trim()),
            description: data.description ? stripHtml(data.description.trim()) : null,
            sport: data.sport ? stripHtml(data.sport.trim()) : null,
            club_type: data.club_type || 'sport',
            extracurricular_category: data.extracurricular_category?.trim() || null,
            season: data.season?.trim() || null,
            primary_color: data.primary_color?.trim() || null,
            season_start: data.season_start ? new Date(data.season_start) : null,
            season_end: data.season_end ? new Date(data.season_end) : null,
            organization_id: organizationId,
            logo_url: data.logo_url || null,
            city: data.city ? stripHtml(data.city.trim()) : null,
            state: data.state ? stripHtml(data.state.trim()) : null,
            league: data.league ? stripHtml(data.league.trim()) : null,
            venue_place_id: data.venue_place_id || null,
            venue_lat: data.venue_lat || null,
            venue_lng: data.venue_lng || null,
            venue_address: data.venue_address ? stripHtml(data.venue_address.trim()) : null,
            level: data.level ?? null,
            gender: data.gender ?? null,
            program_id: resolvedProgramId,
          },
          select: {
            id: true,
            name: true,
            description: true,
            organization_id: true,
            season_start: true,
            season_end: true,
            logo_url: true,
            avatar_url: true,
            level: true,
            gender: true,
            program_id: true,
          },
        });

        await tx.teamMembership.create({
          data: {
            team_id: newTeam.id,
            user_id: me.id,
            role: 'owner',
            status: 'active',
          },
        });

        return { ...newTeam, status: 'active' as const };
      },
      { isolationLevel: 'Serializable' }
    );

    if (
      data.authorized_users &&
      Array.isArray(data.authorized_users) &&
      data.authorized_users.length > 0
    ) {
      try {
        const invites = resolveCreateTimeInvites(data.authorized_users).map(invite => ({
          team_id: team.id,
          email: invite.email,
          role: invite.role as any,
        }));

        if (invites.length > 0) {
          await prisma.teamInvite.createMany({
            data: invites,
            skipDuplicates: true,
          });

          try {
            const [inviter, createdInvites] = await Promise.all([
              prisma.user.findUnique({ where: { id: me.id }, select: { display_name: true } }),
              prisma.teamInvite.findMany({
                where: { team_id: team.id, email: { in: invites.map(invite => invite.email) } },
                select: { id: true, email: true },
                take: invites.length,
              }),
            ]);
            const tokenByEmail = Object.fromEntries(
              createdInvites.map(invite => [invite.email, invite.id])
            );
            await Promise.all(
              invites.map(async invite => {
                try {
                  await sendTeamInviteEmail({
                    to: invite.email,
                    teamName: team.name,
                    organizationName: null,
                    role: invite.role,
                    inviterName: inviter?.display_name || 'Team Owner',
                    teamHeroUrl: team.logo_url || undefined,
                    teamLogoUrl: team.avatar_url || undefined,
                    inviteToken: tokenByEmail[invite.email],
                  });
                } catch (error) {
                  console.warn('[Teams] Failed to send team invite email:', error);
                }
              })
            );
          } catch (emailError) {
            console.warn('[Teams] Failed to send invite emails (non-blocking):', emailError);
          }
        }
      } catch (inviteError: any) {
        console.warn('[Teams] Failed to create invites (non-blocking):', inviteError);
      }
    }

    // The team was just created inside a program (program_id set at birth).
    // Fan out the program's existing followers to this new level team so its
    // posts reach them — keyed on the ProgramFollow ledger, not a heuristic.
    // Runs AFTER the transaction committed; must never fail the create.
    if ((team as any).program_id) {
      try {
        await fanOutProgramFollowersToTeam(prisma, (team as any).program_id, team.id);
      } catch (fanoutError) {
        console.error('[program-fanout] create-path fan-out failed (non-blocking):', fanoutError);
      }
    }

    return { team };
  } catch (teamError: any) {
    if (teamError?.status && teamError?.body) {
      return { status: teamError.status, body: teamError.body };
    }
    console.error('[Teams] Failed to create team:', teamError);
    return { status: 500, body: { error: 'Team creation failed' } };
  }
}

teamsRouter.post(
  '/',
  requireVerified as any,
  requireOnboarded as any,
  requirePlan('rookie') as any,
  teamCreationLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid payload',
        issues: parsed.error.issues.map(i => ({ path: i.path, message: i.message })),
      });
    }

    const result = await createTeamWithGuardrails(req.user!.id, {
      ...parsed.data,
      // Honor the payload rather than force-overriding it — silently rewriting
      // an explicit `extracurricular` back to `sport` is the same class of
      // quiet data loss this route's schema drift already caused. The Legend
      // tier gate for extracurricular clubs lives in createTeamWithGuardrails.
      club_type: parsed.data.club_type ?? 'sport',
    });
    if ('status' in result) {
      return res.status(result.status).json(result.body);
    }
    invalidatePrivateTeamIdsCache();

    return res.status(201).json(result.team);
  })
);

// Update team (auth required). Only owners/admins can update.
// Accept full URLs or relative paths (uploads return .path) or empty string to clear
const logoUrlString = z.union([
  z.string().url(),
  z
    .string()
    .regex(/^\/uploads\//)
    .optional()
    .or(z.string()),
  z.literal(''),
]);

const updateSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  description: z.string().trim().max(1000).optional(),
  sport: z.string().trim().max(100).optional(),
  season: z.string().trim().optional(),
  // v1.0.2: season dates are now editable after team creation.
  // Previously missing from updateSchema so coaches were stuck with the initial dates.
  season_start: z.string().optional().nullable(),
  season_end: z.string().optional().nullable(),
  organization_id: z.string().optional(),
  logo_url: TEAM_LOGO_URL_VALIDATOR,
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  league: z.string().max(100).optional(),
  venue_place_id: z.string().optional(),
  venue_lat: z.number().optional(),
  venue_lng: z.number().optional(),
  venue_address: z.string().optional(),
  is_private: z.boolean().optional(),
  level: z.enum(['varsity', 'jv', 'freshman', 'middle_school', 'unified', 'other']).optional(),
  gender: z.enum(['boys', 'girls', 'coed']).optional(),
  program_id: z.string().min(1).optional(),
});
teamsRouter.put(
  '/:id',
  requireVerified as any,
  requireOnboarded as any,
  teamUpdateLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    debugLog('[Teams PUT] Received update request:', JSON.stringify(req.body));
    // req.user is guaranteed by requireVerified middleware
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      console.error('[Teams PUT] Validation failed:', JSON.stringify(parsed.error));
      return res.status(400).json({
        error: 'Invalid payload',
        issues: parsed.error.issues.map(i => ({ path: i.path, message: i.message })),
      });
    }

    const teamId = String(req.params.id);
    const team = await getTeamState(teamId);
    if (!team) return res.status(404).json({ error: 'Team not found' });
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    const isAdmin = await getIsAdmin(req as any);
    const canManage = await canAdministerTeamScoped(req.user.id, teamId);
    if (!isAdmin && !canManage) {
      return res.status(403).json({
        error:
          'Only the team owner, head coach, organization owner, or platform admins can update team information',
      });
    }

    const entitlement = await getTeamEntitlementState(prisma, teamId);
    if (entitlement.teamLocked) {
      return res.status(403).json(buildTeamPlanLockedError(entitlement));
    }

    const updateData: any = {};
    if (parsed.data.name !== undefined) {
      updateData.name = stripHtml(parsed.data.name);
    }
    if (parsed.data.description !== undefined) {
      updateData.description = parsed.data.description
        ? stripHtml(parsed.data.description)
        : parsed.data.description;
    }
    if (parsed.data.sport !== undefined)
      updateData.sport = parsed.data.sport ? stripHtml(parsed.data.sport) : null;
    if (parsed.data.season !== undefined) updateData.season = parsed.data.season;
    // v1.0.2: season date edits
    if (parsed.data.season_start !== undefined) {
      updateData.season_start = parsed.data.season_start
        ? new Date(parsed.data.season_start)
        : null;
    }
    if (parsed.data.season_end !== undefined) {
      updateData.season_end = parsed.data.season_end ? new Date(parsed.data.season_end) : null;
    }
    if (parsed.data.organization_id !== undefined) {
      const targetOrganizationId = parsed.data.organization_id;
      // Owner rule (note 6): once a team belongs to an organization it is LOCKED
      // to that org and cannot be moved to a different one. Only a first-time
      // assignment (team currently has no org) or a same-org no-op is allowed.
      // This deliberately disables cross-org team transfer per the owner's rule.
      if (team.organization_id != null && targetOrganizationId !== team.organization_id) {
        return res.status(403).json({
          error: 'TEAM_ORG_LOCKED',
          message: 'This team is locked to its organization and cannot be moved to another one.',
          code: 'TEAM_ORG_LOCKED',
        });
      }
      const targetOrg = await prisma.organization.findUnique({
        where: { id: targetOrganizationId },
        select: { id: true },
      });
      if (!targetOrg) {
        return res.status(400).json({ error: 'Target organization not found or inactive' });
      }

      if (
        targetOrganizationId !== team.organization_id &&
        !(await isOrganizationApproved(targetOrganizationId, prisma))
      ) {
        return res.status(403).json({
          error: 'ORGANIZATION_NOT_APPROVED',
          message:
            'Teams can only be moved under organizations that have been approved by VarsityHub.',
          code: 'ORGANIZATION_NOT_APPROVED',
        });
      }

      // Moving a team across organizations is stronger than ordinary team edits
      // (it rehomes billing/administration) — role-barrier model requires
      // admin-tier control on the source side and the ORG OWNER (not manager)
      // on the destination side. The base canAdministerTeam gate above already
      // excludes team managers from reaching this handler at all.
      if (!isAdmin && targetOrganizationId !== team.organization_id) {
        const sourceTeamMembership = await prisma.teamMembership.findUnique({
          where: {
            team_id_user_id: {
              team_id: teamId,
              user_id: req.user.id,
            },
          } as any,
          select: { role: true, status: true },
        });
        const { isOrgOwner: isOrgOwnerScoped } = await import('../lib/teamAuthorization.js');
        const canAdminSourceOrg = team.organization_id
          ? await isOrgOwnerScoped(req.user.id, team.organization_id)
          : false;
        const canControlSourceTeam =
          (sourceTeamMembership?.status === 'active' &&
            (sourceTeamMembership.role === 'owner' || sourceTeamMembership.role === 'coach')) ||
          canAdminSourceOrg;
        if (!canControlSourceTeam) {
          return res.status(403).json({
            error: 'TEAM_TRANSFER_ADMIN_REQUIRED',
            message:
              'Only the team owner, the head coach, or the organization owner can move a team to another organization.',
          });
        }

        const canAdminTargetOrg = await isOrgOwnerScoped(req.user.id, targetOrganizationId);
        if (!canAdminTargetOrg) {
          return res.status(403).json({
            error: 'ORGANIZATION_ADMIN_REQUIRED',
            message: 'You must be the owner of the target organization to move this team.',
          });
        }
      }

      if (targetOrganizationId !== team.organization_id && parsed.data.program_id === undefined) {
        // Org transfer without an explicit program_id: clear the old org's
        // program link so the team never points at a cross-org program
        // (mirrors the FK's onDelete: SetNull spirit). When the payload DOES
        // carry program_id, the PROGRAM_ORG_MISMATCH validation below handles it.
        updateData.program_id = null;
      }
      updateData.organization_id = targetOrganizationId;
    }
    if (parsed.data.logo_url !== undefined)
      updateData.logo_url = parsed.data.logo_url === '' ? null : parsed.data.logo_url;

    // Venue fields
    if (parsed.data.city !== undefined)
      updateData.city = parsed.data.city ? stripHtml(parsed.data.city) : parsed.data.city;
    if (parsed.data.state !== undefined)
      updateData.state = parsed.data.state ? stripHtml(parsed.data.state) : parsed.data.state;
    if (parsed.data.league !== undefined)
      updateData.league = parsed.data.league ? stripHtml(parsed.data.league) : parsed.data.league;
    if (parsed.data.venue_place_id !== undefined) {
      updateData.venue_place_id = parsed.data.venue_place_id;
      updateData.venue_updated_at = new Date();
    }
    if (parsed.data.venue_lat !== undefined) updateData.venue_lat = parsed.data.venue_lat;
    if (parsed.data.venue_lng !== undefined) updateData.venue_lng = parsed.data.venue_lng;
    if (parsed.data.venue_address !== undefined)
      updateData.venue_address = parsed.data.venue_address
        ? stripHtml(parsed.data.venue_address)
        : parsed.data.venue_address;
    if (parsed.data.is_private !== undefined) updateData.is_private = parsed.data.is_private;
    if (parsed.data.level !== undefined) updateData.level = parsed.data.level;
    if (parsed.data.gender !== undefined) updateData.gender = parsed.data.gender;
    // Set when the PUT newly assigns a program_id that DIFFERS from the team's
    // prior one — the trigger to fan out the program's existing followers to
    // this team after the update commits (see below). Never set on the
    // org-transfer null-clear above (that path leaves parsed.data.program_id
    // undefined), nor when program_id is unchanged.
    let fanOutProgramId: string | null = null;
    if (parsed.data.program_id !== undefined) {
      const targetOrgForProgram = updateData.organization_id ?? team.organization_id;
      const program = await prisma.sportProgram.findUnique({
        where: { id: parsed.data.program_id },
        select: { id: true, organization_id: true },
      });
      if (!program || program.organization_id !== targetOrgForProgram) {
        return sendError(res, 400, 'PROGRAM_ORG_MISMATCH', {
          message: 'program_id must belong to the same organization as the team.',
          code: 'PROGRAM_ORG_MISMATCH',
        });
      }
      const priorProgram = await prisma.team.findUnique({
        where: { id: teamId },
        select: { program_id: true },
      });
      if (priorProgram?.program_id !== parsed.data.program_id) {
        fanOutProgramId = parsed.data.program_id;
      }
      updateData.program_id = parsed.data.program_id;
    }

    debugLog('[Teams PUT] Prepared update data:', JSON.stringify(updateData));

    try {
      const updatedTeam = await prisma.team.update({
        where: { id: teamId },
        data: updateData as any,
        select: {
          id: true,
          name: true,
          description: true,
          sport: true,
          is_private: true,
          season_start: true,
          season_end: true,
          organization_id: true,
          logo_url: true,
          avatar_url: true,
          created_at: true,
          level: true,
          gender: true,
          program_id: true,
          organization: {
            select: {
              id: true,
              name: true,
              description: true,
              sport: true,
            },
          },
        },
      });
      if (
        parsed.data.is_private !== undefined ||
        parsed.data.organization_id !== undefined ||
        parsed.data.program_id !== undefined
      ) {
        invalidatePrivateTeamIdsCache();
      }
      debugLog('[Teams PUT] Update successful');
      // The team just gained (or switched to) a program_id. Fan out that
      // program's existing followers to this team so its posts reach them.
      // Runs AFTER commit; must never fail the request — the team WAS updated.
      if (fanOutProgramId) {
        try {
          await fanOutProgramFollowersToTeam(prisma, fanOutProgramId, updatedTeam.id);
        } catch (fanoutError) {
          console.error('[program-fanout] PUT-path fan-out failed (non-blocking):', fanoutError);
        }
      }
      // Return a compact team object including organization and logo/avatar fields for client convenience
      return res.json({
        id: updatedTeam.id,
        name: updatedTeam.name,
        description: updatedTeam.description,
        sport: updatedTeam.sport,
        is_private: (updatedTeam as any).is_private ?? false,
        season_start: updatedTeam.season_start,
        season_end: updatedTeam.season_end,
        organization_id: updatedTeam.organization_id,
        organization: updatedTeam.organization
          ? {
              id: updatedTeam.organization.id,
              name: updatedTeam.organization.name,
              description: updatedTeam.organization.description,
              sport: updatedTeam.organization.sport,
            }
          : null,
        logo_url: (updatedTeam as any).logo_url || null,
        avatar_url: (updatedTeam as any).avatar_url || null,
        status: team.status,
        created_at: updatedTeam.created_at,
        level: (updatedTeam as any).level ?? null,
        gender: (updatedTeam as any).gender ?? null,
        program_id: (updatedTeam as any).program_id ?? null,
      });
    } catch (err: any) {
      console.error('[teams] update error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// Delete team (auth required). Only owners/admins can delete.
teamsRouter.delete(
  '/:id',
  requireVerified as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    // req.user is guaranteed by requireVerified middleware

    const teamId = String(req.params.id);
    const team = await getTeamState(teamId);
    if (!team) return res.status(404).json({ error: 'Team not found' });
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    // Team staff OR org admin can archive. Using the shared helper keeps this
    // route's boundary consistent with team update, event approval, and the
    // rest of the team-scoped endpoints — previously this check was inline and
    // missed the org-admin fallback, blocking league owners from archiving
    // teams inside their own league.
    const isAdmin = await getIsAdmin(req as any);
    // Archiving cascades (memberships/invites/follows/chat unlinks), so it is
    // gated more tightly than team edits: only the team owner/coach, or the
    // org owner — not managers/assistant_coaches — may archive.
    const canArchive = await canArchiveTeamScoped(req.user.id, teamId);
    if (!isAdmin && !canArchive) {
      return res.status(403).json({
        error: 'Only team owners, managers, or league admins can delete teams',
      });
    }
    if (team.status !== 'active') {
      return res.json({ ok: true, archived: true, already_archived: true });
    }

    try {
      // Archive the team instead of deleting it so historical games/events/posts
      // keep a resolvable team reference instead of degrading into null orphans.
      await prisma.$transaction([
        prisma.teamMembership.deleteMany({ where: { team_id: teamId } }),
        prisma.teamInvite.deleteMany({ where: { team_id: teamId } }),
        prisma.teamFollow.deleteMany({ where: { team_id: teamId } }),
        // Team-scoped chats should no longer appear as team chats after archival.
        prisma.groupChat.updateMany({ where: { team_id: teamId }, data: { team_id: null } }),
        prisma.team.update({
          where: { id: teamId },
          data: { status: 'archived' },
          select: { id: true },
        }),
      ]);
      invalidatePrivateTeamIdsCache();

      return res.json({ ok: true, archived: true, message: 'Team archived successfully' });
    } catch (err: any) {
      console.error('[teams] delete error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }
  })
);

// Dev helper: update just the logo_url of a team (useful for testing uploads quickly)
if (process.env.NODE_ENV !== 'production') {
  teamsRouter.post(
    '/:id/dev-set-logo',
    requireAuth as any,
    asyncHandler(async (req, res) => {
      const id = String(req.params.id);
      const { logo_url } = req.body || {};
      try {
        const t = await prisma.team.update({
          where: { id },
          data: { logo_url: logo_url === '' ? null : logo_url } as any,
          select: { id: true, logo_url: true },
        });
        return res.json({ ok: true, team: { id: t.id, logo_url: (t as any).logo_url } });
      } catch (e: any) {
        console.error('dev-set-logo failed', e?.message || e);
        return res.status(500).json({ error: 'Internal server error' });
      }
    })
  );
}

// Enhanced create team for onboarding
const createTeamSchema = teamCreateBaseSchema;

teamsRouter.post(
  '/create',
  requireVerified as any,
  requireOnboarded as any,
  requirePlan('rookie') as any,
  teamCreationLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    const parsed = createTeamSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid payload',
        issues: parsed.error.issues.map(i => ({ path: i.path, message: i.message })),
      });
    }
    const result = await createTeamWithGuardrails(req.user!.id, parsed.data);
    if ('status' in result) {
      return res.status(result.status).json(result.body);
    }

    return res.status(201).json({
      ok: true,
      team: {
        id: result.team.id,
        name: result.team.name,
        organization_id: result.team.organization_id,
        level: (result.team as any).level ?? null,
        gender: (result.team as any).gender ?? null,
        program_id: (result.team as any).program_id ?? null,
      },
    });
  })
);

// Invite user by email OR username to a team. Username is resolved to the
// target's canonical account email at invite time, so a person already on
// VarsityHub is never sent an invite that could spawn a duplicate account.
const inviteSchema = z
  .object({
    email: z.string().email().optional(),
    username: z.string().trim().min(1).max(30).optional(),
    role: z.string().optional(),
  })
  .refine(d => Boolean(d.email) || Boolean(d.username), {
    message: 'Provide an email address or a username to invite.',
  });
// 2026-07-09: player/parent/member retired — teams hold staff only.
const VALID_TEAM_INVITE_ROLES = [
  'manager',
  'coach',
  'assistant_coach',
  'equipment',
  'health_wellness',
] as const;
teamsRouter.post(
  '/:id/invite',
  requireAuth as any,
  requireVerified as any,
  requireOnboarded as any,
  inviteLimiter,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const id = String(req.params.id);
    const parsed = inviteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid payload',
        issues: parsed.error.issues.map(i => ({ path: i.path, message: i.message })),
      });
    }
    const { email, username, role } = parsed.data;
    const assignedRole = String(role || 'member');
    if (!(VALID_TEAM_INVITE_ROLES as readonly string[]).includes(assignedRole)) {
      return res.status(400).json({
        error: 'Invalid role',
        valid_roles: VALID_TEAM_INVITE_ROLES,
      });
    }
    const team = await prisma.team.findUnique({
      where: { id },
      select: { id: true, name: true, logo_url: true, avatar_url: true },
    });
    if (!team) return res.status(404).json({ error: 'Team not found' });
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    // Role-barrier model: invite creation is a full-administration action —
    // authorized users (managers/assistant_coaches) only approve/deny incoming
    // join requests, they don't send invites. Reserved for owner/coach/org owner.
    const canManage = await canAdministerTeamScoped(req.user.id, id);

    if (!canManage) {
      return res.status(403).json({
        error: 'PERMISSION_DENIED',
        message: 'Only the team owner, head coach, or organization owner can invite members.',
      });
    }

    // Role-tier guard (single source of truth). Even administrators default to
    // non-manager roles here; only a team owner (or org owner, already
    // admitted above) may invite at manager level.
    if (!(await canAssignTeamRoleScoped(req.user.id, id, assignedRole))) {
      return res.status(403).json({
        error: 'INSUFFICIENT_ROLE',
        message: 'Only team owners can invite at manager level.',
      });
    }

    // Resolve the invite target to a canonical account email. Done AFTER the
    // authorization checks so an unauthorized caller can't probe which
    // usernames exist. Inviting by username looks up the existing account and
    // keys the invite to that user's real email — no duplicate account can be
    // spawned for someone already on VarsityHub. Inviting by email that
    // already belongs to an account is likewise normalized to that account.
    let inviteEmail: string;
    if (username) {
      const target = await prisma.user.findUnique({
        where: { username: username.trim() },
        select: { email: true, deleted_at: true },
      });
      if (!target?.email || target.deleted_at) {
        return sendError(res, 404, 'USER_NOT_FOUND', {
          message: 'No active user found with that username.',
        });
      }
      inviteEmail = target.email.trim().toLowerCase();
    } else {
      inviteEmail = email!.trim().toLowerCase();
    }

    // Reject inviting someone who is already an active member of this team.
    const existingUserForInvite = await prisma.user.findFirst({
      where: { email: { equals: inviteEmail, mode: 'insensitive' } } as any,
      select: { id: true },
    });
    if (existingUserForInvite) {
      const existingMembership = await prisma.teamMembership.findFirst({
        where: {
          team_id: id,
          user_id: existingUserForInvite.id,
          status: 'active',
        },
        select: { id: true },
      });
      if (existingMembership) {
        return sendError(res, 409, 'That user is already on this team.', {
          code: 'ALREADY_MEMBER',
        });
      }
    }

    // PLAN LIMITS: Enforce authorized user caps based on TEAM OWNER's plan (Rule B).
    // Authorized users are covered by the coach's plan — never charged individually.
    // CRITICAL: Use transaction to prevent race condition bypassing user limits.
    let invite;
    try {
      // Create invite within transaction to prevent race conditions
      invite = await prisma.$transaction(async tx => {
        const entitlement = await getTeamEntitlementState(tx, id);
        if (entitlement.teamLocked) {
          throw new Error('TEAM_PLAN_LOCKED');
        }

        const existingInvite = await tx.teamInvite.findFirst({
          where: {
            team_id: id,
            email: { equals: inviteEmail, mode: 'insensitive' },
          } as any,
          select: { id: true, status: true, role: true },
        });

        // Conflict: an invite for this email is ALREADY pending with a
        // different role. Same rule as POST /team-invites — silently
        // overwriting the role let a second invite downgrade/change what the
        // invitee was already emailed about. Same role = idempotent re-invite.
        if (
          existingInvite &&
          existingInvite.status === 'pending' &&
          String(existingInvite.role) !== assignedRole
        ) {
          throw new Error(
            `INVITE_ROLE_CONFLICT:An invite for this email is already pending with role "${existingInvite.role}". Cancel it first or re-invite with the same role.`
          );
        }

        // Enforce roster size limit — counts active members + all pending
        // invites so the cap cannot be bypassed by sending invites instead of
        // direct adds. Same rule as POST /team-invites; this endpoint was
        // missing it (2026-07-13 audit).
        if (entitlement.maxRoster !== null) {
          const activeMemberCount = await tx.teamMembership.count({
            where: { team_id: id, status: 'active' },
          });
          const pendingInviteCount = await tx.teamInvite.count({
            where: {
              team_id: id,
              status: 'pending',
              ...(existingInvite ? { id: { not: existingInvite.id } } : {}),
            },
          });
          if (activeMemberCount + pendingInviteCount + 1 > entitlement.maxRoster) {
            throw new Error(`ROSTER_LIMIT_REACHED:${entitlement.maxRoster}`);
          }
        }

        if (isAuthorizedTeamRole(assignedRole)) {
          const limit = entitlement.maxAuthorizedUsers;
          if (limit !== null) {
            // Count atomically within transaction
            const inviteCount = await tx.teamInvite.count({
              where: {
                team_id: id,
                status: 'pending',
                ...(existingInvite ? { id: { not: existingInvite.id } } : {}),
              },
            });
            const memberCount = await tx.teamMembership.count({
              where: {
                team_id: id,
                status: 'active',
                role: { in: [...TEAM_AUTHORIZED_ROLES] as any },
              },
            });
            const totalAuthorized = inviteCount + memberCount + 1;

            if (totalAuthorized > limit) {
              throw new Error(`USER_LIMIT_REACHED:${limit}`);
            }
          }
        }

        if (existingInvite) {
          return await tx.teamInvite.update({
            where: { id: existingInvite.id },
            data: { email: inviteEmail, role: assignedRole as any, status: 'pending' },
          });
        }

        // Create invite within same transaction
        return await tx.teamInvite.create({
          data: { team_id: id, email: inviteEmail, role: assignedRole as any, status: 'pending' },
        });
      });
    } catch (e: any) {
      if (e?.message === 'TEAM_PLAN_LOCKED') {
        const entitlement = await getTeamEntitlementState(prisma, id);
        return res.status(403).json(buildTeamPlanLockedError(entitlement));
      }
      if (e?.message?.startsWith('INVITE_ROLE_CONFLICT:')) {
        const [, message] = e.message.split(':');
        return sendError(res, 409, 'INVITE_ROLE_CONFLICT', {
          message: message || 'An invite for this email is already pending with a different role.',
        });
      }
      if (e?.message?.startsWith('ROSTER_LIMIT_REACHED:')) {
        const limit = parseInt(e.message.split(':')[1], 10);
        return res.status(403).json(buildRosterLimitError(limit));
      }
      // Handle specific limit errors
      if (e?.message?.includes('USER_LIMIT_REACHED')) {
        const [, rawLimit] = e.message.split(':');
        const limit = Number.parseInt(String(rawLimit || ''), 10);
        return res.status(403).json({
          error: 'USER_LIMIT_REACHED',
          code: 'USER_LIMIT_REACHED',
          message: Number.isFinite(limit)
            ? `Plan limit reached for authorized users. This team allows ${limit} authorized user${limit === 1 ? '' : 's'}.`
            : 'Plan limit reached for authorized users.',
        });
      }

      console.warn('[teams][invite-limit] check failed', e);
      return res.status(500).json({
        error: 'Failed to create invite',
        message: 'Unable to create team invite. Please try again.',
      });
    }
    // Send invite email (best effort)
    const inviter = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { display_name: true },
    });
    try {
      await sendTeamInviteEmail({
        to: inviteEmail,
        teamName: team.name,
        organizationName: null,
        role: assignedRole,
        teamHeroUrl: team.logo_url || undefined,
        teamLogoUrl: team.avatar_url || undefined,
        inviterName: inviter?.display_name || 'Team Owner',
        inviteToken: invite.id,
      });
    } catch (err) {
      console.error('Failed to send team invite email:', err);
    }

    // Find the invited user by email and create notification if they exist
    const invitedUser = await prisma.user.findFirst({
      where: { email: { equals: inviteEmail, mode: 'insensitive' } } as any,
      select: { id: true, preferences: true },
    });
    if (invitedUser) {
      try {
        await prisma.notification.create({
          data: {
            user_id: invitedUser.id,
            actor_id: req.user.id,
            type: 'TEAM_INVITE',
            meta: {
              team_id: team.id,
              team_name: team.name,
              invite_id: invite.id,
              role: assignedRole,
            },
          },
        });
        // Push notification (respect team_updates preference)
        const prefs = (invitedUser.preferences || {}) as any;
        if (prefs?.notifications?.team_updates !== false) {
          const inviterName = inviter?.display_name || 'A coach';
          sendPushNotification(
            invitedUser.id,
            `${inviterName} invited you to join ${team.name}`,
            'Tap to view',
            {
              type: 'team_invite',
              actor_id: req.user.id,
              team_id: team.id,
              invite_id: invite.id,
              screen: 'team-invites',
            }
          ).catch(err => {
            console.warn('[teams] team invite push failed:', (err as any)?.message || err);
          });
        }
      } catch (error) {
        console.error('Failed to create team invite notification:', error);
        // Continue even if notification fails
      }
    }

    return res.status(201).json(invite);
  })
);

// List invites for the authed user's email
teamsRouter.get(
  '/invites/me',
  requireAuth as any,
  requireVerified as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user?.email) return res.status(400).json({ error: 'User email not found' });
    const invites = await prisma.teamInvite.findMany({
      where: { email: { equals: user.email, mode: 'insensitive' }, status: 'pending' } as any,
      include: { team: true },
      orderBy: { created_at: 'desc' },
      take: 100,
    });
    const list = invites.map(i => ({
      id: i.id,
      role: i.role,
      created_at: i.created_at,
      team: { id: i.team_id, name: (i as any).team?.name || '' },
    }));
    return res.json(list);
  })
);

teamsRouter.post(
  '/:id/invites/:inviteId/cancel',
  requireAuth as any,
  requireVerified as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    const teamId = String(req.params.id);
    const inviteId = String(req.params.inviteId);
    const userId = req.user?.id || null;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const invite = await prisma.teamInvite.findUnique({
      where: { id: inviteId },
      select: { id: true, team_id: true, status: true },
    });
    if (!invite || invite.team_id !== teamId) {
      return res.status(404).json({ error: 'Invite not found' });
    }

    const canManage = await canAdministerTeamScoped(userId, teamId);
    if (!canManage) {
      return res.status(403).json({
        error: 'PERMISSION_DENIED',
        message: 'Only the team owner, head coach, or organization owner can cancel invites.',
      });
    }

    const updated = await prisma.teamInvite.updateMany({
      where: { id: inviteId, team_id: teamId, status: 'pending' },
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

// Accept invite
teamsRouter.post(
  '/invites/:inviteId/accept',
  requireAuth as any,
  requireVerified as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const inviteId = String(req.params.inviteId);
    const invite = await prisma.teamInvite.findUnique({ where: { id: inviteId } });
    if (!invite || invite.status !== 'pending')
      return res.status(404).json({ error: 'Invite not found' });
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user?.email || user.email.toLowerCase() !== invite.email.toLowerCase())
      return sendError(res, 403, 'INVITE_EMAIL_MISMATCH', {
        message:
          'This invite was sent to a different email address. Sign in with the email that received the invite to accept it.',
      });
    const existingMembership = await prisma.teamMembership.findUnique({
      where: {
        team_id_user_id: {
          team_id: invite.team_id,
          user_id: user.id,
        } as any,
      },
    });
    // 2026-07-09: player/parent/member retired — block acceptance of legacy
    // pending invites carrying a retired role (archive script cancels them,
    // this is the backstop for the deploy window).
    const RETIRED_TEAM_ROLES = new Set(['player', 'parent', 'member']);
    if (RETIRED_TEAM_ROLES.has(String(invite.role))) {
      return sendError(res, 410, 'INVITE_ROLE_RETIRED', {
        message:
          'This invite was for a roster role that no longer exists. Ask a coach to send a new staff invite.',
      });
    }
    try {
      const accepted = await prisma.$transaction(
        async tx => {
          const currentMembership = await tx.teamMembership.findUnique({
            where: {
              team_id_user_id: {
                team_id: invite.team_id,
                user_id: user.id,
              } as any,
            },
          });
          // Never resurrect a retired role from an archived membership — the
          // staff role on the fresh invite wins.
          const roleToApply = RETIRED_TEAM_ROLES.has(String(currentMembership?.role))
            ? invite.role
            : currentMembership?.role || invite.role;
          const entitlement = await getTeamEntitlementState(tx, invite.team_id);
          if (entitlement.teamLocked) {
            throw new Error('TEAM_PLAN_LOCKED');
          }

          if (entitlement.maxRoster !== null) {
            const currentActiveCount = await tx.teamMembership.count({
              where: { team_id: invite.team_id, status: 'active' },
            });
            const existingActive = currentMembership?.status === 'active';
            const nextActiveCount = currentActiveCount + (existingActive ? 0 : 1);
            if (nextActiveCount > entitlement.maxRoster) {
              throw new Error(`ROSTER_LIMIT_REACHED:${entitlement.maxRoster}`);
            }
          }

          // Backstop the authorized-user cap at accept time — invite-create
          // reserves the slot, but a concurrent direct-add could have consumed
          // the plan's authorized allowance since. (Roster limit above is
          // vestigial; the authorized cap is the effective bound.)
          if (entitlement.maxAuthorizedUsers !== null && isAuthorizedTeamRole(roleToApply)) {
            const existingAuthorized =
              currentMembership?.status === 'active' &&
              isAuthorizedTeamRole(String(currentMembership?.role));
            const currentAuthorizedCount = await tx.teamMembership.count({
              where: {
                team_id: invite.team_id,
                status: 'active',
                role: { in: [...TEAM_AUTHORIZED_ROLES] as any },
              },
            });
            const nextAuthorizedCount = currentAuthorizedCount + (existingAuthorized ? 0 : 1);
            if (nextAuthorizedCount > entitlement.maxAuthorizedUsers) {
              throw new Error(`AUTHORIZED_LIMIT_REACHED:${entitlement.maxAuthorizedUsers}`);
            }
          }

          const transition = await tx.teamInvite.updateMany({
            where: { id: invite.id, status: 'pending' },
            data: { status: 'accepted' },
          });
          if (transition.count === 0) return false;

          await tx.teamMembership.upsert({
            where: { team_id_user_id: { team_id: invite.team_id, user_id: user.id } } as any,
            update: { role: roleToApply, status: 'active' },
            create: {
              team_id: invite.team_id,
              user_id: user.id,
              role: roleToApply,
              status: 'active',
            },
          });
          return true;
        },
        { isolationLevel: 'Serializable' }
      );

      if (!accepted) return sendError(res, 409, 'Invite already processed');
    } catch (error: any) {
      if (error?.message === 'TEAM_PLAN_LOCKED') {
        const entitlement = await getTeamEntitlementState(prisma, invite.team_id);
        return res.status(403).json(buildTeamPlanLockedError(entitlement));
      }
      if (error?.message?.startsWith('ROSTER_LIMIT_REACHED:')) {
        const limit = Number.parseInt(error.message.split(':')[1], 10);
        return res.status(403).json({
          error: 'ROSTER_LIMIT_REACHED',
          code: 'ROSTER_LIMIT_REACHED',
          message: `This team has reached its roster limit of ${limit} members. Upgrade your plan for more.`,
        });
      }
      if (error?.message?.startsWith('AUTHORIZED_LIMIT_REACHED:')) {
        const limit = Number.parseInt(error.message.split(':')[1], 10);
        return sendError(res, 403, 'AUTHORIZED_LIMIT_REACHED', {
          code: 'AUTHORIZED_LIMIT_REACHED',
          message: `This team has reached its limit of ${limit} authorized users. Upgrade your plan for more.`,
        });
      }
      throw error;
    }

    try {
      await ensureTeamGroupChatMembership(invite.team_id, user.id);
    } catch (error) {
      console.error('Error managing group chat:', error);
      // Don't fail the invite acceptance if group chat creation fails
    }

    // Notify team coaches/owners that the invite was accepted
    try {
      const team = await prisma.team.findUnique({
        where: { id: invite.team_id },
        select: { id: true, name: true },
      });
      const teamName = team?.name || 'your team';
      const accepterName = user.display_name || user.email || 'Someone';

      // Find coaches/owners to notify
      const managers = await prisma.teamMembership.findMany({
        where: {
          team_id: invite.team_id,
          role: { in: ['owner', 'manager', 'coach'] },
          status: 'active',
          user_id: { not: req.user!.id },
        },
        select: { user_id: true },
        take: 100,
      });

      if (managers.length > 0) {
        await prisma.notification.createMany({
          data: managers.map(mgr => ({
            user_id: mgr.user_id,
            actor_id: req.user!.id,
            type: 'TEAM_INVITE_ACCEPTED',
            meta: { team_id: invite.team_id, team_name: teamName, accepter_name: accepterName },
          })),
        });
        await Promise.allSettled(
          managers.map(mgr =>
            sendPushNotification(
              mgr.user_id,
              `${accepterName} joined ${teamName}`,
              `Your team invite was accepted`,
              { type: 'team_invite_accepted', team_id: invite.team_id, screen: 'team-page' }
            )
          )
        );

        const managerUsers = await prisma.user.findMany({
          where: { id: { in: managers.map(mgr => mgr.user_id) } },
          select: { email: true, display_name: true },
          take: managers.length,
        });
        await Promise.allSettled(
          managerUsers
            .filter(manager => typeof manager.email === 'string' && manager.email.trim().length > 0)
            .map(manager =>
              sendStaffMemberJoinedEmail({
                to: String(manager.email).trim(),
                ownerName: manager.display_name || undefined,
                newMember: accepterName,
                newMemberRole: invite.role,
                scope: 'team',
                scopeName: teamName,
              })
            )
        );
      }
    } catch (notifErr) {
      console.error('[teams] Failed to send invite accepted notification:', notifErr);
    }

    return res.json({ ok: true });
  })
);

// Decline invite
teamsRouter.post(
  '/invites/:inviteId/decline',
  requireAuth as any,
  requireVerified as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const inviteId = String(req.params.inviteId);
    const invite = await prisma.teamInvite.findUnique({ where: { id: inviteId } });
    if (!invite || invite.status !== 'pending')
      return res.status(404).json({ error: 'Invite not found' });
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user?.email || user.email.toLowerCase() !== invite.email.toLowerCase())
      return res.status(403).json({ error: 'Invite not for this user' });
    const declined = await prisma.teamInvite.updateMany({
      where: { id: invite.id, status: 'pending' },
      data: { status: 'declined' },
    });
    if (declined.count === 0) return sendError(res, 409, 'Invite already processed');

    // Notify team coaches/owners that the invite was declined
    try {
      const team = await prisma.team.findUnique({
        where: { id: invite.team_id },
        select: { id: true, name: true },
      });
      const teamName = team?.name || 'your team';
      const declinerName = user.display_name || user.email || 'Someone';

      const managers = await prisma.teamMembership.findMany({
        where: {
          team_id: invite.team_id,
          role: { in: ['owner', 'manager', 'coach'] },
          status: 'active',
        },
        select: { user_id: true },
        take: 100,
      });

      if (managers.length > 0) {
        await prisma.notification.createMany({
          data: managers.map(mgr => ({
            user_id: mgr.user_id,
            actor_id: req.user!.id,
            type: 'TEAM_INVITE_DECLINED',
            meta: { team_id: invite.team_id, team_name: teamName, decliner_name: declinerName },
          })),
        });
        await Promise.allSettled(
          managers.map(mgr =>
            sendPushNotification(
              mgr.user_id,
              `Invite declined`,
              `${declinerName} declined the invite to ${teamName}`,
              { type: 'team_invite_declined', team_id: invite.team_id, screen: 'team-page' }
            )
          )
        );
      }
    } catch (notifErr) {
      console.error('[teams] Failed to send invite declined notification:', notifErr);
    }

    return res.json({ ok: true });
  })
);

// Transfer team ownership
// NOTE: requireVerified was missing here while every other team mutation route enforces it,
// which meant unverified emails could transfer ownership. Matches the org transfer chain now.
teamsRouter.post(
  '/:id/transfer-ownership',
  requireAuth as any,
  requireVerified as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const teamId = String(req.params.id);
    const transferSchema = z.object({ new_owner_id: z.string().min(1) });
    const parsed = transferSchema.safeParse(req.body);
    if (!parsed.success)
      return res.status(400).json({ error: 'Invalid payload', issues: parsed.error.issues });
    const { new_owner_id } = parsed.data;

    // Transfer-ownership is deliberately MORE restrictive than canManageTeam.
    // Role-barrier model (2026-07-06): only the team owner, the team's head
    // coach, or the ORG OWNER (not org manager) may hand off ownership.
    // Team managers/assistant_coaches pass canManageTeam but must NOT be able
    // to transfer ownership.
    const team = await prisma.team.findUnique({
      where: { id: teamId },
      select: { organization_id: true },
    });
    if (!team) return res.status(404).json({ error: 'Team not found' });

    const currentMembership = await prisma.teamMembership.findFirst({
      where: { team_id: teamId, user_id: req.user.id, status: 'active' },
    });
    const isDirectOwnerOrCoach =
      currentMembership?.role === 'owner' || currentMembership?.role === 'coach';
    const { isOrgOwner } = await import('../lib/teamAuthorization.js');
    const isLeagueOwner = team.organization_id
      ? await isOrgOwner(req.user.id, team.organization_id)
      : false;
    if (!isDirectOwnerOrCoach && !isLeagueOwner) {
      return res.status(403).json({
        error:
          'Only the team owner, the head coach, or the organization owner can transfer ownership',
      });
    }

    // Verify new owner is a member of the team
    const newOwnerMembership = await prisma.teamMembership.findFirst({
      where: { team_id: teamId, user_id: new_owner_id, status: 'active' },
    });
    if (!newOwnerMembership) {
      return res.status(400).json({ error: 'New owner must be an existing team member' });
    }

    // Read owner + demote/promote inside one Serializable transaction, with the
    // demotion guarded on the row still being the active owner. Without this,
    // two concurrent transfers both read the same owner and mint TWO owners.
    try {
      await prisma.$transaction(
        async tx => {
          const existingOwnerMembership = await tx.teamMembership.findFirst({
            where: { team_id: teamId, role: 'owner', status: 'active' },
            select: { user_id: true },
          });
          if (!existingOwnerMembership) throw new Error('NO_ACTIVE_OWNER');

          const demoted = await tx.teamMembership.updateMany({
            where: {
              team_id: teamId,
              user_id: existingOwnerMembership.user_id,
              role: 'owner',
              status: 'active',
            },
            data: { role: 'manager' },
          });
          if (demoted.count === 0) throw new Error('OWNER_CHANGED');

          await tx.teamMembership.update({
            where: { team_id_user_id: { team_id: teamId, user_id: new_owner_id } },
            data: { role: 'owner' },
          });
        },
        { isolationLevel: 'Serializable' }
      );
    } catch (e: any) {
      if (e?.message === 'NO_ACTIVE_OWNER') {
        return res
          .status(400)
          .json({ error: 'Team does not have an active owner to transfer from' });
      }
      if (e?.message === 'OWNER_CHANGED') {
        return res
          .status(409)
          .json({ error: 'Ownership changed before this action completed. Please retry.' });
      }
      throw e;
    }

    await logAdminActivityFromReq(
      req,
      'TRANSFER_TEAM_OWNERSHIP',
      'team',
      teamId,
      `Transferred team ownership to user ${new_owner_id}`,
      { new_owner_id }
    );

    return res.json({ ok: true, message: 'Ownership transferred successfully' });
  })
);
