import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import request from 'supertest';
import { app } from '../testApp.js';
import { prisma } from '../lib/prisma.js';
import { signJwt } from '../lib/jwt.js';

describe('post and comment pagination continuity', () => {
  let author: any;
  let token: string;
  const posts: string[] = [];
  const comments: string[] = [];
  beforeAll(async () => {
    author = await prisma.user.create({
      data: {
        email: `pagination-${Date.now()}@example.com`,
        email_verified: true,
        onboarding_completed: true,
        date_of_birth: new Date('1990-01-01'),
        approval_status: 'APPROVED',
        preferences: { role: 'fan', onboarding_completed: true },
      },
    });
    token = signJwt({ id: author.id });
    const date = new Date();
    for (let index = 0; index < 7; index += 1) {
      const post = await prisma.post.create({
        data: {
          author_id: author.id,
          content: `Post ${index}`,
          created_at: date,
        },
      });
      posts.push(post.id);
      const comment = await prisma.comment.create({
        data: {
          author_id: author.id,
          post_id: posts[0],
          content: `Comment ${index}`,
          created_at: date,
        },
      });
      comments.push(comment.id);
    }
  });
  afterAll(async () => {
    if (author) await prisma.user.delete({ where: { id: author.id } });
  });

  it.each(['ordinary', 'trending', 'comments'])('returns every %s record once', async mode => {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 12; page += 1) {
      const response = await request(app)
        .get(mode === 'comments' ? `/posts/${posts[0]}/comments` : '/posts')
        .set('Authorization', `Bearer ${token}`)
        .query({
          limit: 2,
          user_id: author.id,
          ...(mode === 'trending' ? { sort: 'trending' } : {}),
          ...(cursor ? { cursor } : {}),
        })
        .expect(200);
      ids.push(...response.body.items.map((item: any) => item.id));
      cursor = response.body.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect(ids.length).toBe(new Set(ids).size);
    expect([...ids].sort()).toEqual([...(mode === 'comments' ? comments : posts)].sort());
  });

  it('continues beyond full batches of distant posts without skipping nearby posts', async () => {
    await prisma.post.createMany({
      data: Array.from({ length: 105 }, (_, index) => ({
        author_id: author.id,
        content: `Distant ${index}`,
        lat: 34,
        lng: -118,
        created_at: new Date(Date.now() + 60_000 + index),
      })),
    });
    const seen: string[] = [];
    let cursor: string | null = null;
    let emptyContinuation = false;
    for (let page = 0; page < 12; page += 1) {
      const response = await request(app)
        .get('/posts')
        .set('Authorization', `Bearer ${token}`)
        .query({
          user_id: author.id,
          limit: 2,
          lat: 40,
          lng: -74,
          radius: 5,
          ...(cursor ? { cursor } : {}),
        })
        .expect(200);
      const items = response.body.items;
      cursor = response.body.nextCursor;
      if (!items.length && cursor) emptyContinuation = true;
      seen.push(...items.map((item: any) => item.id));
      if (!cursor) break;
    }
    expect(emptyContinuation).toBe(true);
    expect(cursor).toBeNull();
    expect(seen.length).toBe(new Set(seen).size);
    expect([...seen].sort()).toEqual([...posts].sort());
  });
});
