import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import request from 'supertest';
import crypto from 'node:crypto';
import { app } from '../testApp.js';
import { prisma } from '../lib/prisma.js';
import { signJwt } from '../lib/jwt.js';
import { invalidatePrivateIdsCache } from '../lib/privacyUtils.js';

const eventIds: string[] = [];
const userIds: string[] = [];
let token: string;
describe('discovery content markers respect actual post privacy', () => {
  beforeAll(async () => {
    for (const role of ['viewer', 'public', 'blocked', 'private']) {
      const user = await prisma.user.create({
        data: {
          email: `map-${role}-${crypto.randomUUID()}@example.test`,
          email_verified: true,
          onboarding_completed: true,
          preferences: { profile_private: role === 'private' },
        },
      });
      userIds.push(user.id);
    }
    token = signJwt({ id: userIds[0] });
    await prisma.blockedUser.create({ data: { blocker_id: userIds[0], blocked_id: userIds[2] } });
    for (let i = 0; i < 4; i++) {
      const event = await prisma.event.create({
        data: {
          title: `Visibility ${i}`,
          date: new Date('2021-03-03T12:00:00Z'),
          location: 'Test',
          latitude: 40,
          longitude: -73,
          status: 'approved',
          approval_status: 'approved',
          creator_id: userIds[0],
        },
      });
      eventIds.push(event.id);
      if (i < 3)
        await prisma.post.create({
          data: {
            event_id: event.id,
            author_id: userIds[i + 1],
            content: 'Visible only to allowed viewers',
          },
        });
    }
    invalidatePrivateIdsCache();
  });
  afterAll(async () => {
    await prisma.post.deleteMany({ where: { author_id: { in: userIds } } });
    await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    invalidatePrivateIdsCache();
  });
  it('does not disclose blocked/private posts through gold pins or past-date presence', async () => {
    const result = await request(app)
      .get('/event-discovery?surface=map&from=2021-03-03T00:00:00Z&to=2021-03-04T00:00:00Z')
      .set('Authorization', `Bearer ${token}`);
    expect(result.status).toBe(200);
    const own = result.body.items.filter((item: any) => eventIds.includes(item.id));
    expect(own.map((item: any) => item.id)).toEqual([eventIds[0]]);
    expect(own[0].has_posts).toBe(true);
    expect(await prisma.event.count({ where: { id: { in: eventIds } } })).toBe(4);
  });
});
