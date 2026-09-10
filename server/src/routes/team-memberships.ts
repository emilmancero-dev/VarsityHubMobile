import { AppError } from '../lib/errors/AppError.js';
import { Router } from 'express';
import { z } from 'zod';
import { sendError } from '../lib/http/sendError.js';
import { sendPushNotification } from '../lib/notifications.js';
import { prisma } from '../lib/prisma.js';
import { stripHtml } from '../lib/sanitizeHtml.js';
import {
  canAdministerTeam as canAdministerTeamShared,
  canAssignTeamRole,
} from '../lib/teamAuthorization.js';
import { guardTeamMembershipMutation } from '../lib/teamEntitlements.js';
import { ensureTeamGroupChatMembershipExternal, removeUserFromTeamGroupChats } from './teams.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireOnboarded } from '../middleware/requireOnboarded.js';
import { requirePlan } from '../middleware/subscription.js';
import { registerIdValidation } from '../middleware/validateParams.js';

// 'owner' is intentionally excluded — ownership can only be assigned through org creation or transfer-ownership endpoint
// 2026-07-09: player/parent/member retired — teams hold staff only (coaches +
// authorized users). Athletes connect by following, never by membership.
const VALID_ROLES = [
  'manager',
  'coach',
  'assistant_coach',
  'equipment',
  'health_wellness',
] as const;
type ValidRole = (typeof VALID_ROLES)[number];

export const teamMembershipsRouter = Router();
registerIdValidation(teamMembershipsRouter);

// Role-barrier model: full team administration (add/remove members, change
// roles, search candidates to invite) is reserved for owner/coach/org owner.
// Managers/assistant_coaches keep event/game approvals (in their own routes);
// they have no membership powers here.
async function canAdministerTeam(req: AuthedRequest, teamId: string): Promise<boolean> {
  return canAdministerTeamShared(req.user?.id ?? null, teamId);
}

// POST /team-memberships { team_id, user_id, role }
// CRITICAL: Only team owners/managers/coaches can add members to their teams
const createMembershipSchema = z.object({
  team_id: z.string().min(1),
  user_id: z.string().min(1),
  role: z.string().optional(),
});

teamMembershipsRouter.post(
  '/',
  requireAuth as any,
  requireOnboarded as any,
  requirePlan('rookie') as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      if (!req.user) return sendError(res, 401, 'Unauthorized');
      const parsed = createMembershipSchema.safeParse(req.body);
      if (!parsed.success)
        return res
          .status(400)
          .json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      const { team_id, user_id, role } = parsed.data;

      const canManage = await canAdministerTeam(req, String(team_id));
      if (!canManage) {
        return sendError(res, 403, 'PERMISSION_DENIED', {
          message: 'Only the team owner, head coach, or organization owner can add members.',
        });
      }

      // Validate role against whitelist
      const assignedRole = String(role || 'member') as ValidRole;
      if (!VALID_ROLES.includes(assignedRole)) {
        return sendError(res, 400, 'Invalid role', { details: { valid_roles: VALID_ROLES } });
      }

      // Role-tier guard (single source of truth). canAdministerTeam above admits
      // head coaches, who must NOT assign the manager role — the same rule the
      // PATCH, teams.ts invite, and team-invites paths already enforce. Without
      // this a coach could add a user directly as `manager` via this route.
      if (!(await canAssignTeamRole(req.user.id, String(team_id), assignedRole))) {
        return sendError(res, 403, 'INSUFFICIENT_ROLE', {
          message: 'Only team owners can assign the manager role.',
        });
      }

      const team = await prisma.team.findUnique({
        where: { id: String(team_id) },
        select: { id: true },
      });
      if (!team) return sendError(res, 404, 'Team not found');
      const user = await prisma.user.findUnique({ where: { id: String(user_id) } });
      if (!user) return sendError(res, 404, 'User not found');

      // Enforce roster size limit and create membership atomically
      const teamIdStr = String(team_id);
      const userIdStr = String(user_id);

      const m = await prisma.$transaction(
        async tx => {
          const existingMembership = await tx.teamMembership.findUnique({
            where: { team_id_user_id: { team_id: teamIdStr, user_id: userIdStr } } as any,
            select: { role: true, status: true },
          });
          // Sole-owner guard: `owner` is not an assignable role here, so upserting
          // an existing owner's row always demotes it. Don't let that strand the
          // team ownerless.
          if (existingMembership?.role === 'owner') {
            const activeOwnerCount = await tx.teamMembership.count({
              where: { team_id: teamIdStr, role: 'owner', status: 'active' },
            });
            if (activeOwnerCount <= 1) {
              throw new AppError(400, 'SOLE_OWNER', { errorCode: 'SOLE_OWNER' });
            }
          }
          const guard = await guardTeamMembershipMutation(tx, {
            teamId: teamIdStr,
            nextRole: assignedRole,
            existingMembership,
          });
          if (!guard.ok) {
            throw new AppError(guard.status, guard.body.error, { errorCode: guard.body.code });
          }

          return tx.teamMembership.upsert({
            where: { team_id_user_id: { team_id: teamIdStr, user_id: userIdStr } } as any,
            update: { role: assignedRole, status: 'active' },
            create: {
              team_id: teamIdStr,
              user_id: userIdStr,
              role: assignedRole,
              status: 'active',
            },
          });
        },
        { isolationLevel: 'Serializable' }
      );
      // Mirror invite-accept: a directly-added member joins the team group
      // chat too (previously only invite-accept did this).
      await ensureTeamGroupChatMembershipExternal(teamIdStr, userIdStr).catch(err =>
        console.error('[team-memberships] group-chat add on direct-add failed:', err)
      );
      return res.status(201).json(m);
    } catch (err: any) {
      if (err instanceof AppError) {
        return res.status(err.statusCode).json(err.toJSON());
      }
      console.error('[team-memberships] POST / error:', err);
      return sendError(res, 500, 'Internal server error');
    }
  })
);

// PATCH /team-memberships/:id { role? }
const VALID_STATUSES = ['active', 'archived'] as const;
type ValidStatus = (typeof VALID_STATUSES)[number];

const updateMembershipSchema = z.object({
  role: z.string().optional(),
  custom_position: z.string().nullable().optional(),
  status: z.enum(VALID_STATUSES).optional(),
});

teamMembershipsRouter.patch(
  '/:id',
  requireAuth as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      if (!req.user) return sendError(res, 401, 'Unauthorized');
      const id = String(req.params.id || '');
      if (!id) return sendError(res, 400, 'membership id required');
      const parsed = updateMembershipSchema.safeParse(req.body);
      if (!parsed.success)
        return res
          .status(400)
          .json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      const { role, custom_position, status } = parsed.data;

      const membership = await prisma.teamMembership.findUnique({ where: { id } });
      if (!membership) return sendError(res, 404, 'Membership not found');

      const canManage = await canAdministerTeam(req, membership.team_id);
      if (!canManage) {
        return sendError(res, 403, 'PERMISSION_DENIED', {
          message: 'Only the team owner, head coach, or organization owner can update roles.',
        });
      }

      if (!role && custom_position === undefined && !status)
        return sendError(res, 400, 'role, custom_position, or status is required');

      const data: Record<string, any> = {};
      if (role) {
        const validatedRole = String(role) as ValidRole;
        if (!VALID_ROLES.includes(validatedRole)) {
          return sendError(res, 400, 'Invalid role', { details: { valid_roles: VALID_ROLES } });
        }

        // Role-tier guard (single source of truth). canManage above admits
        // coaches/assistant_coaches, who must NOT be able to promote anyone
        // (including themselves) to manager.
        if (!(await canAssignTeamRole(req.user.id, membership.team_id, validatedRole))) {
          return sendError(res, 403, 'INSUFFICIENT_ROLE', {
            message: 'Only team owners can assign the manager role.',
          });
        }

        const guard = await guardTeamMembershipMutation(prisma, {
          teamId: membership.team_id,
          nextRole: validatedRole,
          existingMembership: { role: membership.role, status: membership.status },
          nextStatus: status ?? membership.status,
        });
        if (!guard.ok) {
          return res.status(guard.status).json(guard.body);
        }
        data.role = validatedRole;
      }
      if (status) {
        // When activating an archived member, re-check roster limits
        if (status === 'active' && membership.status !== 'active') {
          const guard = await guardTeamMembershipMutation(prisma, {
            teamId: membership.team_id,
            nextRole: (role as ValidRole) ?? (membership.role as ValidRole),
            existingMembership: { role: membership.role, status: membership.status },
            nextStatus: 'active',
          });
          if (!guard.ok) {
            return res.status(guard.status).json(guard.body);
          }
        }
        data.status = status;
      }
      if (custom_position !== undefined)
        data.custom_position = custom_position === null ? null : stripHtml(String(custom_position));

      // ORG-5 parity: a role change or archive must not strand the team without
      // an owner. DELETE already guards this; role-change/archive did not, so a
      // coach (who passes canAdministerTeam) could demote or archive the only
      // owner — after which transfer-ownership permanently 403s ("no active
      // owner"). Block the sole owner from being demoted or deactivated here.
      const demotesOwner = membership.role === 'owner' && data.role && data.role !== 'owner';
      const deactivatesOwner = membership.role === 'owner' && data.status === 'archived';

      // Sole-owner count + update run atomically under Serializable so two
      // concurrent demotions/archivals can't both pass the count and strand the
      // team with no active owner.
      let updated;
      try {
        updated = await prisma.$transaction(
          async tx => {
            if (demotesOwner || deactivatesOwner) {
              const activeOwnerCount = await tx.teamMembership.count({
                where: { team_id: membership.team_id, role: 'owner', status: 'active' },
              });
              if (activeOwnerCount <= 1) throw new Error('SOLE_OWNER_GUARD');
            }
            return tx.teamMembership.update({ where: { id }, data });
          },
          { isolationLevel: 'Serializable' }
        );
      } catch (guardErr: any) {
        if (guardErr?.message === 'SOLE_OWNER_GUARD') {
          return sendError(res, 400, 'SOLE_OWNER', {
            message:
              'Cannot demote or deactivate the only owner. Transfer ownership to another member first.',
          });
        }
        throw guardErr;
      }

      // Archiving a member removes them from the roster — also drop them from the
      // team group chat(s) so an archived staff member can't keep reading it.
      if (data.status === 'archived') {
        await removeUserFromTeamGroupChats(membership.team_id, membership.user_id).catch(err =>
          console.error('[team-memberships] group-chat cleanup on archive failed:', err)
        );
      }

      // Notify the affected member about role change
      if (data.role && membership.user_id !== req.user!.id) {
        try {
          const team = await prisma.team.findUnique({
            where: { id: membership.team_id },
            select: { id: true, name: true },
          });
          const teamName = team?.name || 'your team';

          await prisma.notification.create({
            data: {
              user_id: membership.user_id,
              actor_id: req.user!.id,
              type: 'TEAM_ROLE_CHANGED',
              meta: { team_id: membership.team_id, team_name: teamName, new_role: data.role },
            },
          });

          void sendPushNotification(
            membership.user_id,
            `Role updated on ${teamName}`,
            `Your role has been changed to ${data.role}`,
            { type: 'team_role_changed', team_id: membership.team_id, screen: 'team-page' }
          ).catch(pushErr => {
            console.error('[team-memberships] Failed to send role change push:', pushErr);
          });
        } catch (notifErr) {
          console.error('[team-memberships] Failed to send role change notification:', notifErr);
        }
      }

      return res.json(updated);
    } catch (err) {
      console.error('[team-memberships] PATCH /:id error:', err);
      return sendError(res, 500, 'Internal server error');
    }
  })
);

// DELETE /team-memberships/:id
teamMembershipsRouter.delete(
  '/:id',
  requireAuth as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    try {
      if (!req.user) return sendError(res, 401, 'Unauthorized');
      const id = String(req.params.id || '');
      if (!id) return sendError(res, 400, 'membership id required');

      const membership = await prisma.teamMembership.findUnique({ where: { id } });
      if (!membership) return sendError(res, 404, 'Membership not found');

      const canManage = await canAdministerTeam(req, membership.team_id);
      const isSelf = req.user.id === membership.user_id;
      if (!canManage && !isSelf) {
        return sendError(res, 403, 'PERMISSION_DENIED', {
          message: 'Only the team owner, head coach, or organization owner can remove members.',
        });
      }

      // ORG-5: Prevent removal of the sole team owner. Count only ACTIVE owners
      // — an archived owner row is not a valid successor, so counting it would
      // let the last active owner be removed and strand the team.
      if (membership.role === 'owner') {
        const ownerCount = await prisma.teamMembership.count({
          where: { team_id: membership.team_id, role: 'owner', status: 'active' },
        });
        if (ownerCount <= 1) {
          return sendError(res, 400, 'SOLE_OWNER', {
            message: 'Cannot remove the only owner. Transfer ownership to another member first.',
          });
        }
      }

      await prisma.teamMembership.delete({ where: { id } });

      // Revoke the removed member's access to the team's group chat(s) — an
      // ex-staff member must not keep reading/writing the team chat.
      await removeUserFromTeamGroupChats(membership.team_id, membership.user_id).catch(err =>
        console.error('[team-memberships] group-chat cleanup on remove failed:', err)
      );

      // Notify the removed member (only if removed by someone else, not self-leave)
      if (!isSelf) {
        try {
          const team = await prisma.team.findUnique({
            where: { id: membership.team_id },
            select: { id: true, name: true },
          });
          const teamName = team?.name || 'a team';

          await prisma.notification.create({
            data: {
              user_id: membership.user_id,
              actor_id: req.user!.id,
              type: 'TEAM_MEMBER_REMOVED',
              meta: { team_id: membership.team_id, team_name: teamName },
            },
          });

          void sendPushNotification(
            membership.user_id,
            `Removed from ${teamName}`,
            `You have been removed from ${teamName}`,
            { type: 'team_member_removed', team_id: membership.team_id, screen: 'teams' }
          ).catch(pushErr => {
            console.error('[team-memberships] Failed to send removal push:', pushErr);
          });
        } catch (notifErr) {
          console.error('[team-memberships] Failed to send removal notification:', notifErr);
        }
      }

      return res.json({ ok: true });
    } catch (err) {
      console.error('[team-memberships] DELETE /:id error:', err);
      return sendError(res, 500, 'Internal server error');
    }
  })
);

// GET /team-memberships/search-users?teamId=xxx&q=yyy
// Coaches can search existing users by name/username to add to their team.
// Excludes users already on the team and blocked users.
teamMembershipsRouter.get(
  '/search-users',
  requireAuth as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return sendError(res, 401, 'Unauthorized');
    const teamId = String(req.query.teamId || '').trim();
    const q = String(req.query.q || '').trim();
    if (!teamId) return sendError(res, 400, 'teamId is required');
    if (!q || q.length < 2) return sendError(res, 400, 'q must be at least 2 characters');

    const canManage = await canAdministerTeam(req, teamId);
    if (!canManage) return sendError(res, 403, 'PERMISSION_DENIED');

    // Users already on the team (any status) — exclude from results
    const existingMembers = await prisma.teamMembership.findMany({
      where: { team_id: teamId },
      select: { user_id: true },
      take: 500,
    });
    const existingUserIds = existingMembers.map(m => m.user_id);

    const users = await prisma.user.findMany({
      where: {
        AND: [
          { id: { notIn: existingUserIds } },
          { deleted_at: null },
          { banned: false },
          {
            OR: [
              { username: { contains: q, mode: 'insensitive' } },
              { display_name: { contains: q, mode: 'insensitive' } },
            ],
          },
        ],
      },
      select: { id: true, username: true, display_name: true, avatar_url: true },
      take: 20,
      orderBy: { username: 'asc' },
    });

    return res.json(users);
  })
);
