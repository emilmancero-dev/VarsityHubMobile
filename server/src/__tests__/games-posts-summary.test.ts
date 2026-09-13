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
      await prisma.user.deleteMany({ where: { id: userId } });
    } catch (error) {
      console.warn('Cleanup error (non-critical):', error);
    }
  });

  it('reports has_posts=true only for the game with a visible post', async () => {
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

    expect(res.body?.[posted.id]).toBe(true);
    expect(res.body?.[unposted.id]).toBe(false);
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
