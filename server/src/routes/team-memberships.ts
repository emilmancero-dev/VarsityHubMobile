import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { sendPushNotification } from '../lib/notifications.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireOnboarded } from '../middleware/requireOnboarded.js';
import { requirePlan } from '../middleware/subscription.js';
import { registerIdValidation } from '../middleware/validateParams.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { guardTeamMembershipMutation } from '../lib/teamEntitlements.js';
import { canManageTeam as canManageTeamShared } from '../lib/teamAuthorization.js';

// 'owner' is intentionally excluded — ownership can only be assigned through org creation or transfer-ownership endpoint
const VALID_ROLES = ['manager', 'coach', 'assistant_coach', 'player', 'parent', 'member', 'equipment', 'health_wellness'] as const;
type ValidRole = typeof VALID_ROLES[number];

export const teamMembershipsRouter = Router();
registerIdValidation(teamMembershipsRouter);

// Thin wrapper preserving the existing (req, teamId) signature used by handlers
// in this router. Delegates to the shared lib so the boundary logic lives in
// one place.
async function canManageTeam(req: AuthedRequest, teamId: string): Promise<boolean> {
  return canManageTeamShared(req.user?.id ?? null, teamId);
}

// POST /team-memberships { team_id, user_id, role }
// CRITICAL: Only team owners/managers/coaches can add members to their teams
const createMembershipSchema = z.object({
  team_id: z.string().min(1),
  user_id: z.string().min(1),
  role: z.string().optional(),
});

teamMembershipsRouter.post('/', requireAuth as any, requireOnboarded as any, requirePlan('rookie') as any, asyncHandler(async (req: AuthedRequest, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const parsed = createMembershipSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    const { team_id, user_id, role } = parsed.data;

    const canManage = await canManageTeam(req, String(team_id));
    if (!canManage) {
      return res.status(403).json({
        error: 'PERMISSION_DENIED',
        message: 'Only team staff or organization admins can add members to teams.'
      });
    }

    // Validate role against whitelist
    const assignedRole = String(role || 'member') as ValidRole;
    if (!VALID_ROLES.includes(assignedRole)) {
      return res.status(400).json({ error: 'Invalid role', valid_roles: VALID_ROLES });
    }

    const team = await prisma.team.findUnique({ where: { id: String(team_id) }, include: { organization: true } });
    if (!team) return res.status(404).json({ error: 'Team not found' });
    const user = await prisma.user.findUnique({ where: { id: String(user_id) } });
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Enforce roster size limit and create membership atomically
    const teamIdStr = String(team_id);
    const userIdStr = String(user_id);

    const m = await prisma.$transaction(async (tx) => {
      const existingMembership = await tx.teamMembership.findUnique({
        where: { team_id_user_id: { team_id: teamIdStr, user_id: userIdStr } } as any,
        select: { role: true, status: true },
      });
      const guard = await guardTeamMembershipMutation(tx, {
        teamId: teamIdStr,
        nextRole: assignedRole,
        existingMembership,
      });
      if (!guard.ok) {
        const error = new Error(guard.body.code || guard.body.error || 'TEAM_MEMBERSHIP_GUARD_FAILED');
        (error as any).status = guard.status;
        (error as any).body = guard.body;
        throw error;
      }

      return tx.teamMembership.upsert({
        where: { team_id_user_id: { team_id: teamIdStr, user_id: userIdStr } } as any,
        update: { role: assignedRole, status: 'active' },
        create: { team_id: teamIdStr, user_id: userIdStr, role: assignedRole, status: 'active' },
      });
    }, { isolationLevel: 'Serializable' });
    return res.status(201).json(m);
  } catch (err: any) {
    if (err?.status && err?.body) {
      return res.status(err.status).json(err.body);
    }
    console.error('[team-memberships] POST / error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}));

// PATCH /team-memberships/:id { role? }
const updateMembershipSchema = z.object({
  role: z.string().optional(),
  custom_position: z.string().nullable().optional(),
});

teamMembershipsRouter.patch('/:id', requireAuth as any, requireOnboarded as any, asyncHandler(async (req: AuthedRequest, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ error: 'membership id required' });
    const parsed = updateMembershipSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    const { role, custom_position } = parsed.data;

    const membership = await prisma.teamMembership.findUnique({ where: { id } });
    if (!membership) return res.status(404).json({ error: 'Membership not found' });

    const canManage = await canManageTeam(req, membership.team_id);
    if (!canManage) {
      return res.status(403).json({
        error: 'PERMISSION_DENIED',
        message: 'Only team staff or organization admins can update roles.',
      });
    }

    if (!role && custom_position === undefined) return res.status(400).json({ error: 'role or custom_position is required' });

    const data: Record<string, any> = {};
    if (role) {
      const validatedRole = String(role) as ValidRole;
      if (!VALID_ROLES.includes(validatedRole)) {
        return res.status(400).json({ error: 'Invalid role', valid_roles: VALID_ROLES });
      }

      const guard = await guardTeamMembershipMutation(prisma, {
        teamId: membership.team_id,
        nextRole: validatedRole,
        existingMembership: { role: membership.role, status: membership.status },
        nextStatus: membership.status,
      });
      if (!guard.ok) {
        return res.status(guard.status).json(guard.body);
      }
      data.role = validatedRole;
    }
    if (custom_position !== undefined) data.custom_position = custom_position === null ? null : String(custom_position);

    const updated = await prisma.teamMembership.update({
      where: { id },
      data,
    });

    // Notify the affected member about role change
    if (data.role && membership.user_id !== req.user!.id) {
      try {
        const team = await prisma.team.findUnique({ where: { id: membership.team_id }, select: { id: true, name: true } });
        const teamName = team?.name || 'your team';

        await prisma.notification.create({
          data: {
            user_id: membership.user_id,
            actor_id: req.user!.id,
            type: 'TEAM_ROLE_CHANGED',
            meta: { team_id: membership.team_id, team_name: teamName, new_role: data.role },
          },
        });

        sendPushNotification(
          membership.user_id,
          `Role updated on ${teamName}`,
          `Your role has been changed to ${data.role}`,
          { type: 'team_role_changed', team_id: membership.team_id, screen: 'team-page' }
        ).catch(() => {});
      } catch (notifErr) {
        console.error('[team-memberships] Failed to send role change notification:', notifErr);
      }
    }

    return res.json(updated);
  } catch (err) {
    console.error('[team-memberships] PATCH /:id error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}));

// DELETE /team-memberships/:id
teamMembershipsRouter.delete('/:id', requireAuth as any, requireOnboarded as any, asyncHandler(async (req: AuthedRequest, res) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ error: 'membership id required' });

    const membership = await prisma.teamMembership.findUnique({ where: { id } });
    if (!membership) return res.status(404).json({ error: 'Membership not found' });

    const canManage = await canManageTeam(req, membership.team_id);
    const isSelf = req.user.id === membership.user_id;
    if (!canManage && !isSelf) {
      return res.status(403).json({
        error: 'PERMISSION_DENIED',
        message: 'Only team staff or organization admins can remove members.',
      });
    }

    // ORG-5: Prevent removal of the sole team owner
    if (membership.role === 'owner') {
      const ownerCount = await prisma.teamMembership.count({
        where: { team_id: membership.team_id, role: 'owner' },
      });
      if (ownerCount <= 1) {
        return res.status(400).json({
          error: 'SOLE_OWNER',
          message: 'Cannot remove the only owner. Transfer ownership to another member first.',
        });
      }
    }

    await prisma.teamMembership.delete({ where: { id } });

    // Notify the removed member (only if removed by someone else, not self-leave)
    if (!isSelf) {
      try {
        const team = await prisma.team.findUnique({ where: { id: membership.team_id }, select: { id: true, name: true } });
        const teamName = team?.name || 'a team';

        await prisma.notification.create({
          data: {
            user_id: membership.user_id,
            actor_id: req.user!.id,
            type: 'TEAM_MEMBER_REMOVED',
            meta: { team_id: membership.team_id, team_name: teamName },
          },
        });

        sendPushNotification(
          membership.user_id,
          `Removed from ${teamName}`,
          `You have been removed from ${teamName}`,
          { type: 'team_member_removed', team_id: membership.team_id, screen: 'teams' }
        ).catch(() => {});
      } catch (notifErr) {
        console.error('[team-memberships] Failed to send removal notification:', notifErr);
      }
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[team-memberships] DELETE /:id error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}));
