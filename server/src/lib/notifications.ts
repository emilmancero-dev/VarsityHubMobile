/**
 * @deprecated Use email.ts instead - this file is maintained for backward compatibility with push notifications
 * All email functionality has been consolidated into server/src/lib/email.ts
 *
 * Re-export email functions for backward compatibility
 */
export {
  initEmailService as initNotifications,
  sendBillingNoticeEmail,
  sendOrganizationInviteEmail,
  sendVerificationEmail,
} from './email.js';

/**
 * Push Notification System
 *
 * Notification triggers:
 * 1. New direct message
 * 2. Someone interacts with user's post (like, comment, share)
 * 3. Someone follows the user
 * 4. 12 hours before RSVP'd game
 * 5. 1 hour before RSVP'd game
 */

import { Expo } from 'expo-server-sdk';
import { prisma } from './prisma.js';
import { debugLog } from './debugLog.js';
import { shouldClearPushTokenForExpoError } from './pushReceiptPolicy.js';
import { captureException, captureMessage } from './sentry.js';
import { updateUserAndInvalidate } from './userCache.js';
import { sendPushNotification } from './pushNotifications.js';

const expo = new Expo();
export { sendPushNotification };

/**
 * Notify when user receives a new direct message
 */
export async function notifyNewMessage(
  recipientId: string,
  senderId: string,
  senderName: string,
  messagePreview: string,
  conversationId?: string
): Promise<string[]> {
  const user = await prisma.user.findUnique({
    where: { id: recipientId },
    select: { preferences: true },
  });
  const prefs = user?.preferences as any;
  if (prefs?.notifications?.messages_notifications === false) {
    debugLog(`Messages notifications disabled for user ${recipientId}`);
    return [];
  }
  return sendPushNotification(
    recipientId,
    `New message from ${senderName}`,
    messagePreview.substring(0, 100),
    {
      type: 'new_message',
      screen: 'message-thread',
      conversation_id: conversationId,
      sender_id: senderId,
    }
  );
}

/**
 * Push-notify every OTHER member of a group chat about a new message —
 * mirrors notifyNewMessage's per-category preference check above so group
 * chats get the same push behavior 1:1 DMs already have (owner "commandments"
 * audit, 2026-09-14: "Audit messaging... it should work as well as with push
 * notifications"). Callers must fire-and-forget (.catch(...)) — this never
 * throws itself, but a caller awaiting it would add push latency to the
 * message response.
 */
export async function notifyGroupChatMessage(
  chatId: string,
  chatName: string,
  senderId: string,
  senderName: string,
  content: string
): Promise<void> {
  const recipients = await prisma.groupChatMember.findMany({
    where: { chat_id: chatId, user_id: { not: senderId } },
    select: { user_id: true },
  });
  if (!recipients.length) return;

  const users = await prisma.user.findMany({
    where: { id: { in: recipients.map(r => r.user_id) } },
    select: { id: true, preferences: true },
  });

  await Promise.all(
    users.map(async user => {
      const prefs = user.preferences as any;
      if (prefs?.notifications?.messages_notifications === false) return;
      try {
        await sendPushNotification(user.id, `${senderName} in ${chatName}`, content.slice(0, 100), {
          type: 'new_group_message',
          screen: 'group-chat',
          chat_id: chatId,
          sender_id: senderId,
        });
      } catch (e) {
        captureException(e instanceof Error ? e : new Error(String(e)), {
          context: 'group_message_notification',
          extra: { chat_id: chatId, recipient_id: user.id, sender_id: senderId },
        });
      }
    })
  );
}

/**
 * Notify when someone interacts with user's post
 */
export async function notifyPostInteraction(
  postAuthorId: string,
  interactionType: 'like' | 'comment' | 'share',
  actorId: string,
  actorName: string,
  postId: string
): Promise<string[]> {
  // Don't notify if user interacted with their own post
  if (postAuthorId === actorId) {
    return [];
  }

  // Respect blocking in both directions — a blocked user must not be able to
  // keep generating notifications via likes/comments. Messages already do this
  // check; parity here closes the harassment vector.
  const blocked = await prisma.blockedUser.findFirst({
    where: {
      OR: [
        { blocker_id: postAuthorId, blocked_id: actorId },
        { blocker_id: actorId, blocked_id: postAuthorId },
      ],
    },
    select: { id: true },
  });
  if (blocked) {
    debugLog(
      `Post interaction notification suppressed by block between ${actorId} and ${postAuthorId}`
    );
    return [];
  }

  // Check if user has disabled comments & upvotes notifications
  if (interactionType === 'like' || interactionType === 'comment') {
    const user = await prisma.user.findUnique({
      where: { id: postAuthorId },
      select: { preferences: true },
    });
    const prefs = user?.preferences as any;
    if (prefs?.notifications?.comments_upvotes === false) {
      debugLog(`Comments & upvotes notifications disabled for user ${postAuthorId}`);
      return [];
    }
  }

  const titles = {
    like: `${actorName} liked your post`,
    comment: `${actorName} commented on your post`,
    share: `${actorName} shared your post`,
  };

  return sendPushNotification(
    postAuthorId,
    titles[interactionType],
    'Open the post to see the latest activity.',
    {
      type: 'post_interaction',
      interaction_type: interactionType,
      actor_id: actorId,
      post_id: postId,
      screen: 'post-detail',
      post_id_param: postId,
    }
  );
}

/**
 * Notify when someone replies to a user's comment
 */
export async function notifyCommentReply(
  parentCommentAuthorId: string,
  replierId: string,
  replierName: string,
  postId: string,
  commentId: string
): Promise<string[]> {
  if (parentCommentAuthorId === replierId) return [];

  // Respect blocking both directions.
  const blocked = await prisma.blockedUser.findFirst({
    where: {
      OR: [
        { blocker_id: parentCommentAuthorId, blocked_id: replierId },
        { blocker_id: replierId, blocked_id: parentCommentAuthorId },
      ],
    },
    select: { id: true },
  });
  if (blocked) {
    debugLog(
      `Comment-reply notification suppressed by block between ${replierId} and ${parentCommentAuthorId}`
    );
    return [];
  }

  const user = await prisma.user.findUnique({
    where: { id: parentCommentAuthorId },
    select: { preferences: true },
  });
  const prefs = user?.preferences as any;
  if (prefs?.notifications?.comments_upvotes === false) {
    debugLog(`Comments & upvotes notifications disabled for user ${parentCommentAuthorId}`);
    return [];
  }

  return sendPushNotification(
    parentCommentAuthorId,
    `${replierName} replied to your comment`,
    'Open the comment thread to view the reply.',
    {
      type: 'comment_reply',
      actor_id: replierId,
      post_id: postId,
      comment_id: commentId,
      screen: 'post-detail',
      post_id_param: postId,
      comment_id_param: commentId,
    }
  );
}

/**
 * Notify when someone follows the user
 */
export async function notifyNewFollower(
  userId: string,
  followerId: string,
  followerName: string
): Promise<string[]> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { preferences: true },
  });
  const prefs = user?.preferences as any;
  if (prefs?.notifications?.follows_notifications === false) {
    debugLog(`Follows notifications disabled for user ${userId}`);
    return [];
  }
  return sendPushNotification(
    userId,
    `${followerName} started following you`,
    'Open their profile to follow back.',
    {
      type: 'new_follower',
      follower_id: followerId,
      screen: 'profile',
      user_id_param: followerId,
    }
  );
}

/** Hard cap on RSVPs the reminder cron will scan per call. Past this, the
 *  cron stops and trusts the next tick (5 min later) to catch up. 50k is
 *  ~3 orders of magnitude above today's per-window workload; raise once
 *  production traces show a real ceiling. */
const REMINDER_CRON_RSVP_CAP = 50_000;
/** Dedup query fans out user_ids into a single IN-batch this large at
 *  most. Keeps the indexed `Notification(user_id, created_at)` scan
 *  bounded even under a runaway window. */
const REMINDER_CRON_DEDUP_BATCH = 500;

/**
 * Notify users about upcoming RSVPd games
 * Should be called by a cron job or scheduled task
 *
 * Query shape (rewritten):
 *   - ONE join-filtered query for all candidate RSVPs (event in window +
 *     status approved + user reminder pref not false). Replaces the prior
 *     `1000 events × 5000 RSVPs` nested loop, which scaled multiplicatively
 *     in memory.
 *   - ONE batch query for recent dedup notifications (per user IN-batch).
 *     Replaces the per-RSVP `findFirst` that fired N queries against the
 *     Notification table.
 *
 * Per-RSVP work (notification create + push send) is still serial — those
 * touch external systems (Expo) and the prior code's "continue on push
 * failure" semantic is preserved.
 */
export async function notifyUpcomingGames(hoursBeforeGame: number): Promise<void> {
  const now = new Date();
  const targetTime = new Date(now.getTime() + hoursBeforeGame * 60 * 60 * 1000);

  // Find all events happening at the target time (with 5 minute window)
  const windowStart = new Date(targetTime.getTime() - 5 * 60 * 1000);
  const windowEnd = new Date(targetTime.getTime() + 5 * 60 * 1000);

  // Single join-scoped query for all candidate RSVPs in the window.
  const candidateRsvps = await prisma.eventRsvp.findMany({
    where: {
      event: {
        date: { gte: windowStart, lte: windowEnd },
        OR: [{ status: { in: ['approved'] as any } }, { approval_status: 'approved' }],
      },
    },
    include: {
      event: {
        select: {
          id: true,
          title: true,
          location: true,
          creator_id: true,
        },
      },
      user: {
        select: {
          id: true,
          display_name: true,
          preferences: true,
        },
      },
    },
    orderBy: { id: 'asc' },
    take: REMINDER_CRON_RSVP_CAP,
  });

  debugLog(`Found ${candidateRsvps.length} RSVP candidates for ${hoursBeforeGame}h reminders`);
  if (candidateRsvps.length === 0) return;

  // In-memory pref filter (JSON path predicates in Prisma don't compose
  // cleanly with the OR above; cheaper to filter post-fetch on a bounded
  // result set).
  const reminderEnabled = (user: any) => {
    const prefs = user?.preferences as any;
    return prefs?.notifications?.game_event_reminders !== false;
  };
  const eligibleRsvps = candidateRsvps.filter((r: any) => reminderEnabled(r.user));

  // Batch dedup: pull recent GAME_REMINDER rows for all candidate users in
  // one query, build a Set keyed by `userId:eventId`, then per-RSVP check
  // is O(1) lookup. Replaces the per-RSVP findFirst that dominated cron
  // latency at scale.
  const dedupWindowStart = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const userIdsForDedup = Array.from(new Set(eligibleRsvps.map((r: any) => r.user_id)));
  const dedupKeys = new Set<string>();
  for (let i = 0; i < userIdsForDedup.length; i += REMINDER_CRON_DEDUP_BATCH) {
    const batch = userIdsForDedup.slice(i, i + REMINDER_CRON_DEDUP_BATCH);
    // audit-allow unbounded: dedup scan is bounded by a 2h window plus a fixed user batch
    const recent = await prisma.notification.findMany({
      where: {
        type: 'GAME_REMINDER',
        user_id: { in: batch },
        created_at: { gte: dedupWindowStart },
      },
      select: { user_id: true, meta: true },
    });
    for (const n of recent) {
      const eventIdMeta = (n.meta as any)?.event_id;
      if (eventIdMeta) dedupKeys.add(`${n.user_id}:${eventIdMeta}`);
    }
  }

  // Send notifications. Per-RSVP work touches Expo + DB writes; preserved
  // sequential semantics (continue on push failure) from the prior loop.
  for (const rsvp of eligibleRsvps) {
    const user = (rsvp as any).user;
    const event = (rsvp as any).event;

    if (dedupKeys.has(`${user.id}:${event.id}`)) {
      debugLog(`Skipping duplicate game reminder for user ${user.id}, event ${event.id}`);
      continue;
    }

    const title =
      hoursBeforeGame === 12
        ? `Game reminder: ${event.title}`
        : `Game starting soon: ${event.title}`;

    const body =
      hoursBeforeGame === 12
        ? `Your game starts in 12 hours at ${event.location || 'the venue'}`
        : `Your game starts in 1 hour! Get ready!`;

    // Create in-app notification record so it appears in notification history
    const actorId = (event as any).creator_id ?? user.id;
    let notificationId: string | undefined;
    try {
      const notification = await prisma.notification.create({
        data: {
          user_id: user.id,
          actor_id: actorId,
          type: 'GAME_REMINDER',
          meta: {
            event_id: event.id,
            event_title: event.title,
            hours_before: hoursBeforeGame,
            location: event.location,
          },
        },
      });
      notificationId = notification.id;
    } catch (e) {
      console.error('[notifications] Failed to create game reminder in-app notification:', e);
    }

    let ticketIds: string[] = [];
    try {
      ticketIds = await sendPushNotification(user.id, title, body, {
        type: 'game_reminder',
        hours_before: hoursBeforeGame,
        event_id: event.id,
        screen: 'event-detail',
        event_id_param: event.id,
      });
    } catch (pushErr) {
      console.error(
        `[notifications] Failed to send push for user ${user.id}, event ${event.id}:`,
        pushErr
      );
      captureException(pushErr instanceof Error ? pushErr : new Error(String(pushErr)), {
        extra: { userId: user.id, eventId: event.id, hoursBeforeGame },
      });
      // Continue to next user — don't let one failure kill the entire batch
      continue;
    }

    // Store ticket ID in notification meta for receipt tracking
    if (notificationId && ticketIds.length > 0) {
      try {
        const existing = await prisma.notification.findUnique({
          where: { id: notificationId },
          select: { meta: true },
        });
        await prisma.notification.update({
          where: { id: notificationId },
          data: {
            meta: { ...((existing?.meta as any) || {}), ticket_id: ticketIds[0] },
          },
        });
      } catch (e) {
        console.error('[notifications] Failed to store ticket_id in notification meta:', e);
      }
    }
  }
}

/**
 * Schedule notifications for a newly created RSVP
 * This sets up both 12-hour and 1-hour reminders
 */
export async function scheduleGameReminders(eventId: string, userId: string): Promise<void> {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    select: { date: true, title: true },
  });

  if (!event) {
    console.error(`Event ${eventId} not found for scheduling reminders`);
    return;
  }

  const { notificationQueue } = await import('../jobs/queues.js');
  if (!notificationQueue) {
    captureMessage(
      `Game reminders dropped: notification queue unavailable (event ${eventId}, user ${userId})`,
      'error',
      {
        context: 'game_reminder_queue_unavailable',
        tags: {
          job: 'game-reminder',
          route: '/notifications/game-reminder',
          provider: 'bullmq',
        },
        eventId,
        userId,
      }
    );
    console.error(
      `[scheduleGameReminders] No notification queue available — game reminders dropped for event ${eventId}, user ${userId}`
    );
    return;
  }

  const now = Date.now();
  const gameTime = new Date(event.date).getTime();
  const twelveHBefore = gameTime - 12 * 60 * 60 * 1000;
  const oneHBefore = gameTime - 1 * 60 * 60 * 1000;

  if (twelveHBefore > now) {
    await notificationQueue.add(
      `game-reminder-${eventId}-${userId}-12h`,
      { userId, title: `Game reminder: ${event.title}`, body: `Your game starts in 12 hours!` },
      { delay: twelveHBefore - now, jobId: `game-reminder-${eventId}-${userId}-12h` }
    );
  }

  if (oneHBefore > now) {
    await notificationQueue.add(
      `game-reminder-${eventId}-${userId}-1h`,
      {
        userId,
        title: `Game starting soon: ${event.title}`,
        body: `Your game starts in 1 hour! Get ready!`,
      },
      { delay: oneHBefore - now, jobId: `game-reminder-${eventId}-${userId}-1h` }
    );
  }

  debugLog(`Scheduled game reminders for user ${userId} for event ${eventId} (${event.title})`);
}

/**
 * Cancel scheduled game reminders when RSVP is removed
 */
export async function cancelGameReminders(eventId: string, userId: string): Promise<void> {
  const { notificationQueue } = await import('../jobs/queues.js');
  if (!notificationQueue) {
    debugLog(
      `[cancelGameReminders] No notification queue available, skipping for event ${eventId}`
    );
    return;
  }

  try {
    await notificationQueue.remove(`game-reminder-${eventId}-${userId}-12h`);
  } catch {
    // Job may not exist or already processed
  }
  try {
    await notificationQueue.remove(`game-reminder-${eventId}-${userId}-1h`);
  } catch {
    // Job may not exist or already processed
  }

  debugLog(`Cancelled game reminders for user ${userId} for event ${eventId}`);
}

/**
 * Reschedule the 12h/1h reminders for EVERY RSVP of an event — call after the
 * event's date changes. The per-user schedule/cancel helpers re-read the event's
 * current date, so cancel-then-schedule moves each reminder to the new time.
 * Without this, a rescheduled game still pushed reminders for the OLD time.
 * Audit 2026-07-14 (4b). Best-effort; a queue hiccup never blocks the edit.
 */
export async function rescheduleGameRemindersForEvent(eventId: string): Promise<void> {
  const rsvps = await prisma.eventRsvp.findMany({
    where: { event_id: eventId },
    select: { user_id: true },
    take: 5000,
  });
  for (const { user_id } of rsvps) {
    await cancelGameReminders(eventId, user_id).catch(() => {});
    await scheduleGameReminders(eventId, user_id).catch(() => {});
  }
}

/**
 * Verify push notification delivery receipts from Expo.
 * Queries recent notifications with a ticket_id in meta, checks receipts,
 * and clears stale push tokens for receipt errors that prove the token is no
 * longer usable for this app.
 */
export async function verifyPushReceipts(): Promise<void> {
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Find notifications with a ticket_id that haven't been receipt-checked yet.
  // v1.0.2 pass 12: bound the scan. 5000 / 24h handles our current push volume and the
  // oldest rows run first so Expo's 24-hour receipt retention window is respected.
  const notifications = await prisma.notification.findMany({
    where: {
      created_at: { gte: twentyFourHoursAgo },
      meta: { not: undefined },
    },
    select: {
      id: true,
      user_id: true,
      meta: true,
    },
    orderBy: { created_at: 'asc' },
    take: 5000,
  });

  // Filter to those with ticket_id and no receipt_checked flag
  const unchecked = notifications.filter(n => {
    const meta = n.meta as any;
    return meta?.ticket_id && !meta?.receipt_checked;
  });

  if (unchecked.length === 0) {
    debugLog('[verifyPushReceipts] No unchecked tickets found');
    return;
  }

  debugLog(`[verifyPushReceipts] Checking ${unchecked.length} ticket(s)`);

  // Build a map from ticketId -> notification
  const ticketMap = new Map<string, { id: string; user_id: string; meta: any }>();
  for (const n of unchecked) {
    const meta = n.meta as any;
    ticketMap.set(meta.ticket_id, { id: n.id, user_id: n.user_id, meta });
  }

  const allTicketIds = Array.from(ticketMap.keys());

  // Process in chunks of 1000 (Expo limit)
  for (let i = 0; i < allTicketIds.length; i += 1000) {
    const chunk = allTicketIds.slice(i, i + 1000);
    let receipts: Record<string, any>;

    try {
      receipts = await expo.getPushNotificationReceiptsAsync(chunk);
    } catch (error) {
      console.error('[verifyPushReceipts] Failed to fetch receipts:', error);
      continue;
    }

    for (const [ticketId, receipt] of Object.entries(receipts)) {
      const entry = ticketMap.get(ticketId);
      if (!entry) continue;

      try {
        if (receipt.status === 'ok') {
          await prisma.notification.update({
            where: { id: entry.id },
            data: {
              meta: { ...entry.meta, receipt_checked: true },
            },
          });
        } else if (receipt.status === 'error') {
          const details = receipt.details;

          if (shouldClearPushTokenForExpoError(details?.error)) {
            // Clear the stale push token from user preferences
            debugLog(
              `[verifyPushReceipts] Clearing stale push token for user ${entry.user_id} (${details?.error})`
            );
            const user = await prisma.user.findUnique({
              where: { id: entry.user_id },
              select: { preferences: true },
            });
            if (user?.preferences) {
              const prefs = { ...(user.preferences as any) };
              delete prefs.push_token;
              await updateUserAndInvalidate(prisma, {
                where: { id: entry.user_id },
                data: { preferences: prefs },
              });
            }
          } else {
            console.error(
              `[verifyPushReceipts] Receipt error for ticket ${ticketId}:`,
              receipt.message,
              details
            );
          }

          await prisma.notification.update({
            where: { id: entry.id },
            data: {
              meta: {
                ...entry.meta,
                receipt_checked: true,
                receipt_error: details?.error || receipt.message,
              },
            },
          });
        }
      } catch (error) {
        console.error(
          `[verifyPushReceipts] Failed to process receipt for ticket ${ticketId}:`,
          error
        );
      }
    }
  }

  debugLog(`[verifyPushReceipts] Done processing ${allTicketIds.length} receipt(s)`);
}
