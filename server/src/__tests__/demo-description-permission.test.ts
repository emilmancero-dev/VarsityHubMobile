import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import request from 'supertest';
import crypto from 'node:crypto';
import { app } from '../testApp.js';
import { prisma } from '../lib/prisma.js';
import { signJwt } from '../lib/jwt.js';

// Integration regression: editable descriptive text must never grant upload privileges.
describe('demo descriptions do not grant posting permission', () => {
  let userId: string;
  let token: string;
  let gameId: string;
  let eventId: string;
  beforeAll(async () => {
    const user = await prisma.user.create({
      data: {
        email: `demo-boundary-${crypto.randomUUID()}@example.test`,
        email_verified: true,
        onboarding_completed: true,
        role: 'fan',
        preferences: { role: 'fan', onboarding_completed: true },
      },
    });
    userId = user.id;
    token = signJwt({ id: userId });
    const game = await prisma.game.create({
      data: {
        title: 'Permission test',
        description: '[DEMO_MATCHUP]',
        date: new Date(),
        location: 'Test venue',
        latitude: 40,
        longitude: -73,
        approval_status: 'approved',
      },
    });
    gameId = game.id;
    const event = await prisma.event.create({
      data: {
        title: 'Permission test',
        description: '[DEMO_MATCHUP]',
        date: new Date(),
        location: 'Test venue',
        latitude: 40,
        longitude: -73,
        approval_status: 'approved',
        status: 'approved',
        creator_id: userId,
        game_id: gameId,
      },
    });
    eventId = event.id;
  });
  afterAll(async () => {
    if (userId) {
      await prisma.post.deleteMany({ where: { author_id: userId } });
      await prisma.story.deleteMany({ where: { user_id: userId } });
    }
    if (eventId) await prisma.event.delete({ where: { id: eventId } });
    if (gameId) await prisma.game.delete({ where: { id: gameId } });
    if (userId) await prisma.user.delete({ where: { id: userId } });
  });
  it('denies a first post without a device location even on demo-tagged games', async () => {
    const result = await request(app)
      .post('/posts')
      .set('Authorization', `Bearer ${token}`)
      .send({ game_id: gameId, content: 'Must not bypass venue checks' });
    expect(result.status).toBe(403);
  });
  it('denies both story write paths without a device location on demo-tagged pages', async () => {
    for (const path of [`/games/${gameId}/stories`, `/events/${eventId}/stories`]) {
      const result = await request(app)
        .post(path)
        .set('Authorization', `Bearer ${token}`)
        .send({ media_url: 'https://res.cloudinary.com/demo/image/upload/sample.jpg' });
      expect(result.status).toBe(403);
    }
  });
});
