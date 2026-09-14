import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

/**
 * scheduleEventPostingGraceReminders (server/src/lib/notifications.ts) — the
 * day-after / 3-days-left / last-day push cadence for the 7-day post-event
 * grace window. Owner "commandments" rule (2026-09-14).
 */

const mockEventFindUnique = jest.fn();
const mockQueueAdd = jest.fn(async () => ({ id: 'job-1' }));

jest.unstable_mockModule('../lib/prisma.js', () => ({
  prisma: { event: { findUnique: mockEventFindUnique } },
}));

jest.unstable_mockModule('../jobs/queues.js', () => ({
  notificationQueue: { add: mockQueueAdd },
}));

const { scheduleEventPostingGraceReminders } = await import('../lib/notifications.js');

describe('scheduleEventPostingGraceReminders', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockEventFindUnique.mockReset();
    mockQueueAdd.mockClear();
    mockEventFindUnique.mockResolvedValue({ title: 'Homecoming Game' });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('schedules day-after, 3-days-left, and last-day jobs relative to unlockedAt', async () => {
    const now = new Date('2026-05-10T18:00:00.000Z');
    jest.setSystemTime(now);
    const unlockedAt = now; // unlock happens right now

    await scheduleEventPostingGraceReminders('event-1', 'user-1', unlockedAt);

    expect(mockQueueAdd).toHaveBeenCalledTimes(3);

    const calls = mockQueueAdd.mock.calls as any[];
    const byStage = Object.fromEntries(calls.map(c => [c[0], c]));

    expect(byStage['posting-grace-event-1-user-1-day-after'][2]).toEqual({
      delay: 1 * 24 * 60 * 60 * 1000,
      jobId: 'posting-grace-event-1-user-1-day-after',
    });
    expect(byStage['posting-grace-event-1-user-1-3-days-left'][2]).toEqual({
      delay: 4 * 24 * 60 * 60 * 1000,
      jobId: 'posting-grace-event-1-user-1-3-days-left',
    });
    expect(byStage['posting-grace-event-1-user-1-last-day'][2]).toEqual({
      delay: 6 * 24 * 60 * 60 * 1000,
      jobId: 'posting-grace-event-1-user-1-last-day',
    });
    // Payload carries the userId/title/body/data shape the notification worker expects.
    expect(byStage['posting-grace-event-1-user-1-day-after'][1]).toEqual(
      expect.objectContaining({
        userId: 'user-1',
        data: expect.objectContaining({
          type: 'posting_grace_reminder',
          event_id: 'event-1',
          stage: 'day-after',
        }),
      })
    );
  });

  it('skips stages that have already passed — an old unlock does not fire reminders in the past', async () => {
    const now = new Date('2026-05-20T18:00:00.000Z');
    jest.setSystemTime(now);
    // Unlocked 5 days ago: day-after (+1d) and 3-days-left (+4d) are already
    // past; only last-day (+6d, still 1 day away) should schedule.
    const unlockedAt = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);

    await scheduleEventPostingGraceReminders('event-1', 'user-1', unlockedAt);

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd.mock.calls[0][0]).toBe('posting-grace-event-1-user-1-last-day');
  });

  it('does nothing when the event no longer exists', async () => {
    mockEventFindUnique.mockResolvedValue(null);

    await scheduleEventPostingGraceReminders('missing-event', 'user-1', new Date());

    expect(mockQueueAdd).not.toHaveBeenCalled();
  });
});
