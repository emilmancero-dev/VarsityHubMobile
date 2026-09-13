import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { describeDb } from './helpers/dbTestSuite.js';
import bcrypt from 'bcrypt';
import request from 'supertest';
import { app } from '../testApp.js';

// Event-page stories: a game-LESS event (pro fixtures, etc.) can host stories
// keyed on event_id, the same surface that already hosts posts. This pins the
// owner scenario directly: a designated poster with an active unlock uploads a
// story from anywhere (no device GPS) to a finished event, while a normal user
// off-site is still blocked. See server/src/routes/events.ts + the
// EventDesignatedPoster / EventPostingUnlock pair.
let prisma: any;
let signJwt: any;

describeDb('Event-page stories', () => {
  let designatedUser: any;
  let designatedToken: string;
  let strangerUser: any;
  let strangerToken: string;
  let eventId: string;

  beforeAll(async () => {
    ({ prisma } = await import('../lib/prisma.js'));
    ({ signJwt } = await import('../lib/jwt.js'));

    designatedUser = await prisma.user.create({
      data: {
        email: `event-story-designated-${Date.now()}@example.com`,
        password_hash: await bcrypt.hash('TestPassword123!', 10),
        display_name: 'Event Story Superfan',
        email_verified: true,
        role: 'fan',
        onboarding_completed: true,
        approval_status: 'APPROVED',
        preferences: { role: 'fan', onboarding_completed: true },
      },
    });
    designatedToken = signJwt({ id: designatedUser.id });

    strangerUser = await prisma.user.create({
      data: {
        email: `event-story-stranger-${Date.now()}@example.com`,
        password_hash: await bcrypt.hash('TestPassword123!', 10),
        display_name: 'Event Story Stranger',
        email_verified: true,
        role: 'fan',
        onboarding_completed: true,
        approval_status: 'APPROVED',
        preferences: { role: 'fan', onboarding_completed: true },
      },
    });
    strangerToken = signJwt({ id: strangerUser.id });

    // A game-LESS event (no game_id) with a venue location — the pro-fixture
    // shape. It is already finished so the live window is closed for everyone.
    const event = await prisma.event.create({
      data: {
        title: `Event story page ${Date.now()}`,
        date: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
        location: 'MetLife Stadium',
        latitude: 40.8135,
        longitude: -74.0745,
        status: 'approved',
        approval_status: 'approved',
        creator_id: strangerUser.id,
        creator_role: 'fan',
      },
    });
    eventId = event.id;

    // Grant the designated user continued story access: the additive marker
    // PLUS an active unlock (the pair the admin grant / one-off script writes).
    await prisma.eventDesignatedPoster.create({
      data: { event_id: eventId, user_id: designatedUser.id },
    });
    await prisma.eventPostingUnlock.create({
      data: { event_id: eventId, user_id: designatedUser.id, unlocked_at: new Date() },
    });
  });

  afterAll(async () => {
    await prisma.story.deleteMany({ where: { event_id: eventId } }).catch(() => {});
    await prisma.eventDesignatedPoster.deleteMany({ where: { event_id: eventId } }).catch(() => {});
    await prisma.eventPostingUnlock.deleteMany({ where: { event_id: eventId } }).catch(() => {});
    if (eventId) await prisma.event.delete({ where: { id: eventId } }).catch(() => {});
    await prisma.user.delete({ where: { id: designatedUser?.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: strangerUser?.id } }).catch(() => {});
  });

  it('lets a designated poster upload a story with NO device location, even after the event ended', async () => {
    const res = await request(app)
      .post(`/events/${eventId}/stories`)
      .set('Authorization', `Bearer ${designatedToken}`)
      .send({
        media_url: 'https://res.cloudinary.com/demo/image/upload/event-story.jpg',
        caption: 'Recap story on a game-less event page',
      });

    expect(res.statusCode).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.event_id).toBe(eventId);
    expect(res.body.game_id ?? null).toBeNull();
  });

  it('returns the event-page stories via GET /events/:id/stories', async () => {
    const res = await request(app)
      .get(`/events/${eventId}/stories`)
      .set('Authorization', `Bearer ${designatedToken}`);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
    expect(res.body[0].url).toContain('event-story.jpg');
  });

  it('still blocks a non-designated user with no device location (geofence enforced)', async () => {
    const res = await request(app)
      .post(`/events/${eventId}/stories`)
      .set('Authorization', `Bearer ${strangerToken}`)
      .send({
        media_url: 'https://res.cloudinary.com/demo/image/upload/stranger-story.jpg',
        caption: 'Should be blocked off-site',
      });

    expect(res.statusCode).toBe(403);
    // Finished event → window closed; a fresh event would return LOCATION_REQUIRED.
    expect(['POSTING_WINDOW_CLOSED', 'LOCATION_REQUIRED']).toContain(res.body.error);
  });
});
