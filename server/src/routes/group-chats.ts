import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { captureException, captureMessage } from '../lib/sentry.js';
import { notifyGroupChatMessage } from '../lib/notifications.js';
import { canManageTeam as canManageTeamScoped } from '../lib/teamAuthorization.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { groupMessageLimiter } from '../middleware/rateLimiters.js';
import { requireAuth } from '../middleware/requireAuth.js';
import { requireOnboarded } from '../middleware/requireOnboarded.js';
import { requireVerified } from '../middleware/requireVerified.js';
import { stripHtml } from '../lib/sanitizeHtml.js';
const groupChatsRouter = Router();

// Get all group chats for the current user
groupChatsRouter.get(
  '/',
  requireAuth as any,
  requireVerified as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    const memberships = await prisma.groupChatMember.findMany({
      where: { user_id: req.user.id },
      take: 100,
      include: {
        chat: {
          include: {
            team: true,
            members: {
              include: {
                user: {
                  select: {
                    id: true,
                    display_name: true,
                    avatar_url: true,
                  },
                },
              },
            },
            messages: {
              take: 1,
              orderBy: { created_at: 'desc' },
              include: {
                sender: {
                  select: {
                    id: true,
                    display_name: true,
                    avatar_url: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: { joined_at: 'desc' },
    });

    // Mirror the joined_at floor that the message-fetch path enforces (see
    // GET /:chatId/messages — line ~134, `created_at: { gte: membership.joined_at }`).
    // Without this AND clause, a member added after a chat already had history
    // would see unread badges for messages they cannot actually load —
    // confusing badge-vs-list mismatch.
    const unreadRows =
      memberships.length > 0
        ? await prisma.$queryRaw<Array<{ chat_id: string; unread_count: number }>>(Prisma.sql`
            SELECT
              m.chat_id,
              COUNT(*)::int AS unread_count
            FROM "GroupChatMember" m
            JOIN "GroupChatMessage" msg
              ON msg.chat_id = m.chat_id
            WHERE m.user_id = ${req.user.id}
              AND msg.sender_id <> ${req.user.id}
              AND msg.created_at >= m.joined_at
              AND (
                m.last_read_at IS NULL
                OR msg.created_at > m.last_read_at
              )
            GROUP BY m.chat_id
          `)
        : [];

    const unreadByChat = new Map<string, number>(
      unreadRows.map(row => [row.chat_id, Number(row.unread_count) || 0])
    );

    const chats = memberships.map((m: any) => ({
      ...m.chat,
      lastMessage: m.chat.messages[0] || null,
      unreadCount: unreadByChat.get(m.chat_id) ?? 0,
    }));

    return res.json(chats);
  })
);

// Get messages for a specific group chat
groupChatsRouter.get(
  '/:chatId/messages',
  requireAuth as any,
  requireVerified as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    const { chatId } = req.params;
    const meId = req.user.id;

    // Verify user is a member of this chat
    const membership = await prisma.groupChatMember.findFirst({
      where: {
        chat_id: chatId,
        user_id: meId,
      },
      select: { joined_at: true },
    });

    if (!membership) {
      return res.status(403).json({ error: 'Not a member of this chat' });
    }

    // Block-list: filter out messages from users the requester has blocked or
    // who have blocked the requester. Blocking otherwise only prevented DMs —
    // in group chats, blocked users were still fully visible to each other.
    //
    // Same overflow detection as search.ts: take=LIMIT+1 so a pathological
    // user with > LIMIT block relationships fails closed (503) instead of
    // silently letting blocked users' messages through.
    const BLOCK_LIST_HARD_LIMIT = 10_000;
    const blocks = await prisma.blockedUser.findMany({
      where: { OR: [{ blocker_id: meId }, { blocked_id: meId }] },
      select: { blocker_id: true, blocked_id: true },
      take: BLOCK_LIST_HARD_LIMIT + 1,
    });
    if (blocks.length > BLOCK_LIST_HARD_LIMIT) {
      captureMessage('Group-chat blocked-list exceeded hard limit — failing closed', 'error', {
        context: 'group_chat_blocked_list_overflow',
        userId: meId,
        chatId,
        limit: BLOCK_LIST_HARD_LIMIT,
      });
      return res.status(503).json({
        error: 'CHAT_TEMPORARILY_UNAVAILABLE',
        message: 'Chat is temporarily unavailable for this account. Please contact support.',
      });
    }
    const blockedUserIds = new Set<string>();
    for (const b of blocks) {
      if (b.blocker_id !== meId) blockedUserIds.add(b.blocker_id);
      if (b.blocked_id !== meId) blockedUserIds.add(b.blocked_id);
    }

    const messages = await prisma.groupChatMessage.findMany({
      where: {
        chat_id: chatId,
        // Pre-join history filter: members added partway through a chat now
        // see only messages from their join time forward. Previously new
        // members got full history, including conversations that happened
        // before they were added.
        created_at: { gte: membership.joined_at },
        ...(blockedUserIds.size > 0 ? { sender_id: { notIn: Array.from(blockedUserIds) } } : {}),
      },
      include: {
        sender: {
          select: {
            id: true,
            display_name: true,
            avatar_url: true,
          },
        },
      },
      orderBy: { created_at: 'asc' },
      take: 100, // Limit to last 100 messages
    });

    return res.json(messages);
  })
);

// Send a message to a group chat
const sendMessageSchema = z.object({
  content: z
    .string()
    .min(1, 'Message content required')
    .max(5000, 'Message too long (max 5000 characters)'),
});

groupChatsRouter.post(
  '/:chatId/messages',
  requireAuth as any,
  requireVerified as any,
  groupMessageLimiter as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    const { chatId } = req.params;
    const parsed = sendMessageSchema.safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    const { content } = parsed.data;

    // Verify user is a member of this chat
    const membership = await prisma.groupChatMember.findFirst({
      where: {
        chat_id: chatId,
        user_id: req.user.id,
      },
    });

    if (!membership) {
      return res.status(403).json({ error: 'Not a member of this chat' });
    }

    const [message, chat] = await Promise.all([
      prisma.groupChatMessage.create({
        data: {
          chat_id: chatId,
          sender_id: req.user.id,
          content: stripHtml(content.trim()),
        },
        include: {
          sender: {
            select: {
              id: true,
              display_name: true,
              avatar_url: true,
            },
          },
        },
      }),
      prisma.groupChat.findUnique({ where: { id: chatId }, select: { name: true } }),
    ]);

    // Fire-and-forget — a push failure must not block the message response.
    notifyGroupChatMessage(
      chatId,
      chat?.name || 'your team chat',
      req.user.id,
      message.sender?.display_name || 'Someone',
      message.content
    ).catch(e => {
      captureException(e instanceof Error ? e : new Error(String(e)), {
        context: 'group_message_notification_dispatch',
        extra: { chat_id: chatId, sender_id: req.user!.id },
      });
    });

    return res.status(201).json(message);
  })
);

// Mark messages as read
groupChatsRouter.post(
  '/:chatId/read',
  requireAuth as any,
  requireVerified as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    const { chatId } = req.params;

    // Update last_read_at for this user's membership. updateMany returns a count
    // — 0 means the caller isn't a member, so return 403 rather than a
    // misleading ok:true (membership-authz parity with the other chat routes).
    const updated = await prisma.groupChatMember.updateMany({
      where: {
        chat_id: chatId,
        user_id: req.user.id,
      },
      data: {
        last_read_at: new Date(),
      },
    });
    if (updated.count === 0) {
      return res.status(403).json({ error: 'You are not a member of this chat' }); // error-envelope-exempt
    }

    return res.json({ ok: true });
  })
);

// Create a group chat (usually for a team)
const createChatSchema = z.object({
  name: z.string().min(1, 'Chat name required').max(100),
  memberIds: z.array(z.string().min(1)).min(1, 'At least one member required'),
  teamId: z.string().min(1, 'teamId is required to create a group chat'),
});

groupChatsRouter.post(
  '/',
  requireAuth as any,
  requireVerified as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });

    const parsed = createChatSchema.safeParse(req.body);
    if (!parsed.success)
      return res
        .status(400)
        .json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    const { name, teamId, memberIds } = parsed.data;

    const canManage = await canManageTeamScoped(req.user.id, teamId);
    if (!canManage) {
      return res.status(403).json({ error: 'No permission to create team chat' });
    }

    // Verify all members are active on this team
    const teamMembers = await prisma.teamMembership.findMany({
      where: { team_id: teamId, user_id: { in: memberIds }, status: 'active' },
      select: { user_id: true },
      take: memberIds.length,
    });
    const teamMemberIds = new Set(teamMembers.map(m => m.user_id));
    const invalidMembers = memberIds.filter(
      (id: string) => !teamMemberIds.has(id) && id !== req.user!.id
    );
    if (invalidMembers.length > 0) {
      return res
        .status(400)
        .json({ error: 'Some members are not on this team', invalid: invalidMembers });
    }

    // Create the group chat
    const chat = await prisma.groupChat.create({
      data: {
        name: name.trim(),
        team_id: teamId || null,
        created_by: req.user!.id,
        members: {
          create: [
            { user_id: req.user!.id }, // Add creator
            ...memberIds
              .filter((id: string) => id !== req.user!.id) // Avoid duplicates
              .map((id: string) => ({ user_id: id })),
          ],
        },
      },
      include: {
        team: true,
        members: {
          include: {
            user: {
              select: {
                id: true,
                display_name: true,
                avatar_url: true,
              },
            },
          },
        },
      },
    });

    return res.status(201).json(chat);
  })
);

// Add a member to a team-scoped group chat. Requires team staff role on the
// chat's team (owner/manager/coach/assistant_coach) OR org admin (owner/manager)
// of the team's organization. The new member must be on the team's roster.
// Self-add is not permitted — joining is initiated by team management.
groupChatsRouter.post(
  '/:chatId/members',
  requireAuth as any,
  requireVerified as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const chatId = String(req.params.chatId);
    const parsed = z.object({ user_id: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'user_id is required' });
    }
    const targetUserId = parsed.data.user_id;

    const chat = await prisma.groupChat.findUnique({
      where: { id: chatId },
      select: { id: true, team_id: true, created_by: true },
    });
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });
    if (!chat.team_id) {
      return res.status(400).json({
        error: 'NOT_TEAM_CHAT',
        message: 'Direct chat membership cannot be modified.',
      });
    }

    // Permission: team staff OR org admin OR original creator.
    const canManage = await canManageTeamScoped(req.user.id, chat.team_id);
    const isCreator = chat.created_by === req.user.id;
    if (!canManage && !isCreator) {
      return res.status(403).json({
        error: 'PERMISSION_DENIED',
        message: 'Only team staff or org admins can add members to this chat.',
      });
    }

    // Target must be on the team's active roster.
    const onTeam = await prisma.teamMembership.findFirst({
      where: { team_id: chat.team_id, user_id: targetUserId, status: 'active' },
      select: { id: true },
    });
    if (!onTeam) {
      return res.status(400).json({
        error: 'NOT_ON_TEAM',
        message: "User is not on this team's roster.",
      });
    }

    // Idempotent — if already a member, return ok rather than P2002.
    const existing = await prisma.groupChatMember.findFirst({
      where: { chat_id: chatId, user_id: targetUserId },
      select: { id: true },
    });
    if (existing) {
      return res.json({ ok: true, already_member: true, user_id: targetUserId });
    }

    await prisma.groupChatMember.create({
      data: { chat_id: chatId, user_id: targetUserId },
    });
    return res.status(201).json({ ok: true, user_id: targetUserId });
  })
);

// v1.0.2 pass 8: leave a group chat (any member) or remove another member.
// Originally creator-only for removals — extended in the org-admin pass to
// allow team staff and org admins to manage roster, mirroring the same
// boundary used for team membership and chat creation. Closes the
// orphan-creator failure mode where a deleted creator left the chat
// permanently locked.
groupChatsRouter.delete(
  '/:chatId/members/:userId',
  requireAuth as any,
  requireVerified as any,
  requireOnboarded as any,
  asyncHandler(async (req: AuthedRequest, res) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthorized' });
    const chatId = String(req.params.chatId);
    const targetUserId = String(req.params.userId);
    const meId = req.user.id;

    const chat = await prisma.groupChat.findUnique({
      where: { id: chatId },
      select: {
        id: true,
        team_id: true,
        created_by: true,
        members: { where: { user_id: meId }, select: { user_id: true } },
      },
    });
    if (!chat) return res.status(404).json({ error: 'Group chat not found' });

    // Self-leave is always allowed. Removing another requires creator role,
    // team staff role on the chat's team, or org admin of the team's org.
    const isSelfLeave = targetUserId === meId;
    const isCreator = chat.created_by === meId;
    let canManageChat = isCreator;
    if (!canManageChat && chat.team_id) {
      canManageChat = await canManageTeamScoped(meId, chat.team_id);
    }
    if (!isSelfLeave && !canManageChat) {
      return res.status(403).json({
        error: 'Only the chat creator, team staff, or an org admin can remove other members.',
      });
    }

    // Verify the target is actually a member
    const targetMembership = await prisma.groupChatMember.findFirst({
      where: { chat_id: chatId, user_id: targetUserId },
      select: { id: true },
    });
    if (!targetMembership)
      return res.status(404).json({ error: 'User is not a member of this chat.' });

    // Creators cannot remove themselves while there are other members — prevents orphan chats
    if (isSelfLeave && isCreator) {
      const otherMembers = await prisma.groupChatMember.count({
        where: { chat_id: chatId, NOT: { user_id: meId } },
      });
      if (otherMembers > 0) {
        return res.status(400).json({
          error: 'Chat creator must transfer ownership or delete the chat before leaving.',
          code: 'CREATOR_CANNOT_LEAVE',
        });
      }
      // Last member + creator → delete the whole chat
      await prisma.$transaction([
        prisma.groupChatMessage.deleteMany({ where: { chat_id: chatId } }),
        prisma.groupChatMember.deleteMany({ where: { chat_id: chatId } }),
        prisma.groupChat.delete({ where: { id: chatId } }),
      ]);
      return res.json({ ok: true, deleted: true });
    }

    await prisma.groupChatMember.delete({ where: { id: targetMembership.id } });
    return res.json({ ok: true, removed_user_id: targetUserId });
  })
);

export { groupChatsRouter };
