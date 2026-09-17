import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import bcrypt from 'bcrypt';
import request from 'supertest';
import { app } from '../testApp.js';

let prisma: any;
let signJwt: any;

const ts = Date.now();
const PASSWORD = 'TestPassword123!';

describe('GET /users/:id/event-pages', () => {
  let userId: string;
  let token: string;
  const eventIds: string[] = [];

  beforeAll(async () => {
    ({ prisma } = await import('../lib/prisma.js'));
    ({ signJwt } = await import('../lib/jwt.js'));
    const user = await prisma.user.create({
      data: {
        email: `event-pages-${ts}@example.com`,
        password_hash: await bcrypt.hash(PASSWORD, 10),
        display_name: 'Event Pages Tester',
        email_verified: true,
        onboarding_completed: true,
        role: 'fan',
        approval_status: 'APPROVED',
        preferences: { role: 'fan', onboarding_completed: true },
      },
    });
    userId = user.id;
    token = signJwt({ id: userId });
  });

  afterAll(async () => {
    try {
      await prisma.eventPostingUnlock.deleteMany({ where: { user_id: userId } });
      await prisma.post.deleteMany({ where: { author_id: userId } });
      await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
      await prisma.user.deleteMany({ where: { id: userId } });
    } catch (error) {
      console.warn('Cleanup error (non-critical):', error);
    }
  });

  async function createEvent(title: string, date: Date, overrides: Record<string, unknown> = {}) {
    const event = await prisma.event.create({
      data: {
        title,
        date,
        location: 'Test Stadium',
        event_type: 'game',
        status: 'approved',
        approval_status: 'approved',
        creator_id: userId,
        creator_role: 'fan',
        ...overrides,
      },
    });
    eventIds.push(event.id);
    return event;
  }

  it('shows verified and contributed event pages while hiding future events', async () => {
    const past = await createEvent(
      `Cowboys at Giants ${ts}`,
      new Date(Date.now() - 24 * 60 * 60 * 1000),
      { live_window_hours_after_start: 4 }
    );
    const future = await createEvent(
      `Future Event ${ts}`,
      new Date(Date.now() + 24 * 60 * 60 * 1000)
    );
    const postedOnly = await createEvent(
      `Posted Only ${ts}`,
      new Date(Date.now() - 48 * 60 * 60 * 1000)
    );
    await prisma.eventPostingUnlock.createMany({
      data: [
        { event_id: past.id, user_id: userId },
        { event_id: future.id, user_id: userId },
      ],
    });
    await prisma.post.create({
      data: {
        author_id: userId,
        content: `Posted without watching ${ts}`,
        type: 'post',
        event_id: postedOnly.id,
      },
    });

    const res = await request(app)
      .get(`/users/${userId}/event-pages`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.items.map((item: any) => item.id)).toEqual([past.id, postedOnly.id]);
    expect(res.body.items[0]).toMatchObject({
      title: `Cowboys at Giants ${ts}`,
      event_id: past.id,
      source_type: 'event',
    });
    expect(res.body.items[0].starts_at).toBe(past.date.toISOString());
    expect(res.body.items[0].live_until).toBe(
      new Date(past.date.getTime() + 4 * 60 * 60 * 1000).toISOString()
    );
  });
});
