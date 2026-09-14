import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import bcrypt from 'bcrypt';

/**
 * notifyGroupChatMessage (server/src/lib/notifications.ts) — the group-chat
 * counterpart to notifyNewMessage. Owner "commandments" audit, 2026-09-14:
 * group chats previously sent NO push notification at all on a new message,
 * unlike 1:1 DMs.
 */

const mockSendPushNotification = jest.fn(async () => [] as string[]);

jest.unstable_mockModule('../lib/pushNotifications.js', () => ({
  sendPushNotification: mockSendPushNotification,
}));

const { notifyGroupChatMessage } = await import('../lib/notifications.js');
const { prisma } = await import('../lib/prisma.js');

let sender: any;
let recipientDefault: any;
let recipientOptedOut: any;
let chatId: string;
const ts = Date.now();
const PASSWORD = 'TestPassword123!';

describe('notifyGroupChatMessage', () => {
  beforeAll(async () => {
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const makeUser = (label: string, preferences: any = {}) =>
      prisma.user.create({
        data: {
          email: `group-push-${label}-${ts}@example.com`,
          password_hash: passwordHash,
          display_name: `${label} ${ts}`,
          email_verified: true,
          onboarding_completed: true,
          role: 'fan',
          approval_status: 'APPROVED',
          preferences: { role: 'fan', onboarding_completed: true, ...preferences },
        },
      });

    sender = await makeUser('sender');
    recipientDefault = await makeUser('recipient-default');
    recipientOptedOut = await makeUser('recipient-optout', {
      notifications: { messages_notifications: false },
    });

    const chat = await prisma.groupChat.create({
      data: { name: `Test Chat ${ts}`, created_by: sender.id },
    });
    chatId = chat.id;
    await prisma.groupChatMember.createMany({
      data: [
        { chat_id: chatId, user_id: sender.id },
        { chat_id: chatId, user_id: recipientDefault.id },
        { chat_id: chatId, user_id: recipientOptedOut.id },
      ],
    });
  });

  afterAll(async () => {
    try {
      await prisma.groupChatMember.deleteMany({ where: { chat_id: chatId } });
      await prisma.groupChat.deleteMany({ where: { id: chatId } });
      await prisma.user.deleteMany({
        where: { id: { in: [sender.id, recipientDefault.id, recipientOptedOut.id] } },
      });
    } catch (error) {
      console.warn('Cleanup error (non-critical):', error);
    }
  });

  it('pushes every other member except the sender and opted-out recipients', async () => {
    mockSendPushNotification.mockClear();

    await notifyGroupChatMessage(chatId, 'Test Chat', sender.id, 'Sender Name', 'Hello team');

    expect(mockSendPushNotification).toHaveBeenCalledTimes(1);
    expect(mockSendPushNotification).toHaveBeenCalledWith(
      recipientDefault.id,
      'Sender Name in Test Chat',
      'Hello team',
      expect.objectContaining({ type: 'new_group_message', chat_id: chatId, sender_id: sender.id })
    );
    const calledIds = mockSendPushNotification.mock.calls.map((c: any) => c[0]);
    expect(calledIds).not.toContain(sender.id);
    expect(calledIds).not.toContain(recipientOptedOut.id);
  });
});
