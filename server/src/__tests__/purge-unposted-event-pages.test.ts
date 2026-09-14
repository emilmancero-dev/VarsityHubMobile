import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import bcrypt from 'bcrypt';

/**
 * purgeUnpostedEventPages (server/src/lib/approvalService.ts) — owner
 * "commandments" rule (2026-09-14): "If an event page doesn't get post
 * after the 8 hours, it can be removed from the database. But should still
 * be live window on feed and map until the 8 hours expire."
 */

let prisma: any;
let purgeUnpostedEventPages: any;

const ts = Date.now();
const PASSWORD = 'TestPassword123!';
let userId: string;

// Window closed hours ago (default 6h after start + comfortably past).
const CLOSED_WINDOW_DATE = new Date(Date.now() - 30 * 60 * 60 * 1000);
// Window still open (well within the 24h DB pre-filter AND the live cutoff).
const OPEN_WINDOW_DATE = new Date(Date.now() - 60 * 60 * 1000);

describe('purgeUnpostedEventPages', () => {
  beforeAll(async () => {
    ({ prisma } = await import('../lib/prisma.js'));
    ({ purgeUnpostedEventPages } = await import('../lib/approvalService.js'));

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await prisma.user.create({
      data: {
        email: `purge-events-${ts}@example.com`,
        password_hash: passwordHash,
        display_name: 'Purge Tester',
        email_verified: true,
        onboarding_completed: true,
        role: 'fan',
        approval_status: 'APPROVED',
        preferences: { role: 'fan', onboarding_completed: true },
      },
    });
    userId = user.id;
  });

  afterAll(async () => {
    try {
      await prisma.post.deleteMany({ where: { author_id: userId } });
      await prisma.event.deleteMany({ where: { creator_id: userId } });
      await prisma.game.deleteMany({ where: { created_by_id: userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    } catch (error) {
      console.warn('Cleanup error (non-critical):', error);
    }
  });

  const makeEvent = (overrides: Record<string, any> = {}) =>
    prisma.event.create({
      data: {
        title: `Purge test event ${ts}-${Math.random().toString(36).slice(2)}`,
        date: CLOSED_WINDOW_DATE,
        location: 'Test Venue',
        status: 'approved',
        approval_status: 'approved',
        creator_id: userId,
        creator_role: 'fan',
        ...overrides,
      },
    });

  it('removes a standalone unposted event whose window has closed', async () => {
    const event = await makeEvent();

    const removed = await purgeUnpostedEventPages(prisma);

    expect(removed).toBeGreaterThanOrEqual(1);
    const stillThere = await prisma.event.findUnique({ where: { id: event.id } });
    expect(stillThere).toBeNull();
  });

  it('does NOT remove an event whose window is still open — must stay live until it expires', async () => {
    const event = await makeEvent({ date: OPEN_WINDOW_DATE });

    await purgeUnpostedEventPages(prisma);

    const stillThere = await prisma.event.findUnique({ where: { id: event.id } });
    expect(stillThere).not.toBeNull();

    await prisma.event.delete({ where: { id: event.id } });
  });

  it('does NOT remove an event that received a post, even after the window closed', async () => {
    const event = await makeEvent();
    await prisma.post.create({
      data: { author_id: userId, content: `Recap ${ts}`, type: 'post', event_id: event.id },
    });

    await purgeUnpostedEventPages(prisma);

    const stillThere = await prisma.event.findUnique({ where: { id: event.id } });
    expect(stillThere).not.toBeNull();

    await prisma.post.deleteMany({ where: { event_id: event.id } });
    await prisma.event.delete({ where: { id: event.id } });
  });

  it('does NOT remove a game-linked event, even unposted and closed — competitive games keep their historical record', async () => {
    const game = await prisma.game.create({
      data: {
        title: `Purge test game ${ts}`,
        date: CLOSED_WINDOW_DATE,
        location: 'Field A',
        event_type: 'game',
        approval_status: 'approved',
        created_by_id: userId,
      },
    });
    const event = await makeEvent({ game_id: game.id });

    await purgeUnpostedEventPages(prisma);

    const stillThere = await prisma.event.findUnique({ where: { id: event.id } });
    expect(stillThere).not.toBeNull();

    await prisma.event.delete({ where: { id: event.id } });
    await prisma.game.delete({ where: { id: game.id } });
  });

  it('honors a per-event window override — a coach all-day (12h) event is not purged until 12h have passed', async () => {
    // 10h after start: past the 6h default, but inside a 12h override.
    const event = await makeEvent({
      date: new Date(Date.now() - 10 * 60 * 60 * 1000),
      live_window_hours_after_start: 12,
    });

    await purgeUnpostedEventPages(prisma);

    const stillThere = await prisma.event.findUnique({ where: { id: event.id } });
    expect(stillThere).not.toBeNull();

    await prisma.event.delete({ where: { id: event.id } });
  });
});
