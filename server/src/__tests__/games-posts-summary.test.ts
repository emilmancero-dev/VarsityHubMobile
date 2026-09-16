import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import bcrypt from 'bcrypt';
import request from 'supertest';
import { app } from '../testApp.js';

let prisma: any;
let signJwt: any;

const ts = Date.now();
const PASSWORD = 'TestPassword123!';

describe('GET /games/posts-summary', () => {
  let userId: string;
  let token: string;

  beforeAll(async () => {
    ({ prisma } = await import('../lib/prisma.js'));
    ({ signJwt } = await import('../lib/jwt.js'));

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await prisma.user.create({
      data: {
        email: `games-posts-summary-${ts}@example.com`,
        password_hash: passwordHash,
        display_name: 'Posts Summary Tester',
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
      await prisma.post.deleteMany({ where: { author_id: userId } });
      await prisma.game.deleteMany({ where: { created_by_id: userId } });
      await prisma.event.deleteMany({ where: { creator_id: userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    } catch (error) {
      console.warn('Cleanup error (non-critical):', error);
    }
  });

  it('reports the post count per game (0 when none)', async () => {
    const posted = await prisma.game.create({
      data: {
        title: `Posted Game ${ts}`,
        date: new Date(Date.now() + 60 * 60 * 1000),
        location: 'Field A',
        event_type: 'game',
        approval_status: 'approved',
        created_by_id: userId,
      },
    });
    const unposted = await prisma.game.create({
      data: {
        title: `Unposted Game ${ts}`,
        date: new Date(Date.now() + 60 * 60 * 1000),
        location: 'Field B',
        event_type: 'game',
        approval_status: 'approved',
        created_by_id: userId,
      },
    });
    await prisma.post.create({
      data: {
        author_id: userId,
        content: `Live update ${ts}`,
        type: 'post',
        game_id: posted.id,
      },
    });

    const res = await request(app)
      .get(`/games/posts-summary?ids=${posted.id},${unposted.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body?.[posted.id]).toBe(1);
    expect(res.body?.[unposted.id]).toBe(0);
  });

  it('falls back to a standalone event (no linked game) for ids that are not a Game — feed/map gold-border parity', async () => {
    // Owner "commandments" rule (2026-09-14): an event-only page must be able
    // to go gold the same way a game can, so the map pin and the feed border
    // never disagree.
    const postedEvent = await prisma.event.create({
      data: {
        title: `Posted standalone event ${ts}`,
        date: new Date(Date.now() + 60 * 60 * 1000),
        location: 'Venue A',
        status: 'approved',
        approval_status: 'approved',
        creator_id: userId,
        creator_role: 'fan',
      },
    });
    const unpostedEvent = await prisma.event.create({
      data: {
        title: `Unposted standalone event ${ts}`,
        date: new Date(Date.now() + 60 * 60 * 1000),
        location: 'Venue B',
        status: 'approved',
        approval_status: 'approved',
        creator_id: userId,
        creator_role: 'fan',
      },
    });
    await prisma.post.create({
      data: {
        author_id: userId,
        content: `Live event update ${ts}`,
        type: 'post',
        event_id: postedEvent.id,
      },
    });

    const res = await request(app)
      .get(`/games/posts-summary?ids=${postedEvent.id},${unpostedEvent.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body?.[postedEvent.id]).toBe(1);
    expect(res.body?.[unpostedEvent.id]).toBe(0);
  });

  it('counts both event and game posts when queried by a linked event id', async () => {
    const game = await prisma.game.create({
      data: {
        title: `Linked Game ${ts}`,
        date: new Date(Date.now() + 60 * 60 * 1000),
        location: 'Linked Field',
        event_type: 'game',
        approval_status: 'approved',
        created_by_id: userId,
      },
    });
    const event = await prisma.event.create({
      data: {
        title: `Linked Event ${ts}`,
        date: game.date,
        location: game.location,
        status: 'approved',
        approval_status: 'approved',
        creator_id: userId,
        creator_role: 'fan',
        game_id: game.id,
      },
    });
    await prisma.post.createMany({
      data: [
        { author_id: userId, content: `Game post ${ts}`, type: 'post', game_id: game.id },
        { author_id: userId, content: `Event post ${ts}`, type: 'post', event_id: event.id },
      ],
    });

    const res = await request(app)
      .get(`/games/posts-summary?ids=${event.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body?.[event.id]).toBe(2);

    // Normal creation denormalizes one post onto BOTH page identifiers.
    await prisma.post.create({
      data: {
        author_id: userId,
        content: `Dual-linked post ${ts}`,
        type: 'post',
        game_id: game.id,
        event_id: event.id,
      },
    });
    await prisma.post.create({
      data: {
        author_id: userId,
        content: `Deleted dual-linked post ${ts}`,
        type: 'post',
        game_id: game.id,
        event_id: event.id,
        deleted_at: new Date(),
      },
    });
    const combined = await request(app)
      .get(`/games/posts-summary?ids=${event.id},${game.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(combined.body).toEqual({ [event.id]: 3, [game.id]: 3 });
  });

  it('rejects a request with no ids', async () => {
    await request(app)
      .get('/games/posts-summary')
      .set('Authorization', `Bearer ${token}`)
      .expect(400);
  });

  it('works anonymously (auth optional, like votes-summary)', async () => {
    const res = await request(app).get('/games/posts-summary?ids=abc').expect(200);
    expect(res.body).toEqual({});
  });
});
