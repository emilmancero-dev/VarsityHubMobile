import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import request from 'supertest';
import { app } from '../testApp.js';
import { prisma } from '../lib/prisma.js';
import { signJwt } from '../lib/jwt.js';
import { invalidatePrivateIdsCache } from '../lib/privacyUtils.js';

describe('post pagination boundaries', () => {
  let author: any;
  let viewer: any;
  let token: string;
  const userIds: string[] = [];
  const teamIds: string[] = [];
  const organizationIds: string[] = [];
  beforeEach(async () => {
    for (const name of ['author', 'viewer']) {
      const user = await prisma.user.create({
        data: {
          email: `page-edge-${name}-${Date.now()}-${Math.random()}@example.com`,
          date_of_birth: new Date('1990-01-01'),
          email_verified: true,
          onboarding_completed: true,
          approval_status: 'APPROVED',
          preferences: { role: 'fan', onboarding_completed: true },
        },
      });
      userIds.push(user.id);
      if (name === 'author') author = user;
      else viewer = user;
    }
    token = signJwt({ id: viewer.id });
  });
  afterEach(async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
    await prisma.team.deleteMany({ where: { id: { in: teamIds.splice(0) } } });
    await prisma.organization.deleteMany({ where: { id: { in: organizationIds.splice(0) } } });
    await invalidatePrivateIdsCache();
  });
  async function makePosts(count: number, interleaved = false) {
    const rows = [];
    for (let index = 0; index < count; index++)
      rows.push(
        await prisma.post.create({
          data: {
            author_id: author.id,
            content: `Edge ${index}`,
            created_at: new Date(1_800_000_000_000 + index),
            ...(interleaved ? { lat: index % 2 ? 40 : 34, lng: index % 2 ? -74 : -118 } : {}),
          },
        })
      );
    return rows;
  }
  const page = (query: Record<string, any> = {}) =>
    request(app)
      .get('/posts')
      .set('Authorization', `Bearer ${token}`)
      .query({ user_id: author.id, limit: 2, ...query })
      .expect(200);

  it('ends an exact-limit page without inventing a continuation', async () => {
    const rows = await makePosts(2);
    const response = await page();
    expect(response.body.items.map((p: any) => p.id)).toEqual(rows.reverse().map(p => p.id));
    expect(response.body.nextCursor).toBeNull();
  });
  it('traverses interleaved nearby and distant rows without omissions', async () => {
    const rows = await makePosts(16, true);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 12; i++) {
      const response = await page({ lat: 40, lng: -74, radius: 5, ...(cursor ? { cursor } : {}) });
      seen.push(...response.body.items.map((p: any) => p.id));
      cursor = response.body.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect(seen).toEqual(
      rows
        .filter((_, i) => i % 2)
        .reverse()
        .map(p => p.id)
    );
  });
  it.each(['blocked', 'private'])(
    'does not widen a scoped continuation after author becomes %s',
    async mode => {
      await makePosts(5);
      await prisma.post.create({ data: { author_id: viewer.id, content: 'Unrelated scope' } });
      const first = await page();
      expect(first.body.items).toHaveLength(2);
      if (mode === 'blocked')
        await request(app)
          .post(`/users/${author.id}/block`)
          .set('Authorization', `Bearer ${token}`)
          .send({})
          .expect(201);
      else {
        await prisma.user.update({
          where: { id: author.id },
          data: { preferences: { profile_private: true } },
        });
        await invalidatePrivateIdsCache();
      }
      const next = await page({ cursor: first.body.nextCursor });
      expect(next.body.items).toEqual([]);
      expect(next.body.nextCursor).toBeNull();
    }
  );
  it('continues after soft deletion of a delivered post', async () => {
    const rows = await makePosts(5);
    const first = await page();
    await prisma.post.update({
      where: { id: first.body.items[1].id },
      data: { deleted_at: new Date() },
    });
    const next = await page({ cursor: first.body.nextCursor });
    expect(next.body.items.map((p: any) => p.id)).toEqual([rows[2].id, rows[1].id]);
  });
  it('continues after permanent deletion of a delivered post', async () => {
    const rows = await makePosts(5);
    const first = await page();
    await prisma.post.delete({ where: { id: first.body.items[1].id } });
    const next = await page({ cursor: first.body.nextCursor });
    expect(next.body.items.map((p: any) => p.id)).toEqual([rows[2].id, rows[1].id]);
  });
  it('accepts an existing client ID cursor', async () => {
    const rows = await makePosts(5);
    const next = await page({ cursor: rows[3].id });
    expect(next.body.items.map((p: any) => p.id)).toEqual([rows[2].id, rows[1].id]);
  });
  it('keeps pinned team posts first across a deleted boundary and equal timestamps', async () => {
    const organization = await prisma.organization.create({ data: { name: 'Pagination fixture' } });
    organizationIds.push(organization.id);
    const team = await prisma.team.create({
      data: { name: 'Pagination team', organization_id: organization.id },
    });
    teamIds.push(team.id);
    const rows = await makePosts(6);
    for (let i = 0; i < rows.length; i++)
      await prisma.post.update({
        where: { id: rows[i].id },
        data: {
          team_id: team.id,
          is_pinned: i < 3,
          created_at: new Date(1_800_000_000_000),
        },
      });
    const expected = await prisma.post.findMany({
      where: { team_id: team.id },
      orderBy: [{ is_pinned: 'desc' }, { created_at: 'desc' }, { id: 'desc' }],
      take: 10,
    });
    const first = await page({ team_id: team.id });
    const seen = first.body.items.map((p: any) => p.id);
    await prisma.post.delete({ where: { id: seen[1] } });
    let cursor = first.body.nextCursor;
    for (let i = 0; cursor && i < 5; i++) {
      const next = await page({ team_id: team.id, cursor });
      seen.push(...next.body.items.map((p: any) => p.id));
      cursor = next.body.nextCursor;
    }
    expect(cursor).toBeNull();
    expect(seen).toEqual(expected.map(p => p.id));
  });
  it.each(['p1:invalid', 'c1:invalid'])(
    'rejects malformed or wrong-kind cursor %s',
    async cursor => {
      await request(app)
        .get('/posts')
        .set('Authorization', `Bearer ${token}`)
        .query({ user_id: author.id, cursor })
        .expect(400);
    }
  );
  it('continues bundled followed posts after deleting the delivered anchor', async () => {
    const rows = await makePosts(5);
    await prisma.follows.create({
      data: { follower_id: viewer.id, following_id: author.id, status: 'accepted' },
    });
    const bundlePage = (cursor?: string) =>
      request(app)
        .get('/feed/bundle')
        .set('Authorization', `Bearer ${token}`)
        .query({ posts_limit: 2, ...(cursor ? { posts_cursor: cursor } : {}) })
        .expect(200);
    const first = await bundlePage();
    expect(first.body.posts.items.map((p: any) => p.id)).toEqual([rows[4].id, rows[3].id]);
    await prisma.post.delete({ where: { id: rows[3].id } });
    const next = await bundlePage(first.body.posts.nextCursor);
    expect(next.body.posts.items.map((p: any) => p.id)).toEqual([rows[2].id, rows[1].id]);
  });
  it('continues comments after the delivered anchor comment is deleted', async () => {
    const [post] = await makePosts(1);
    const comments = [];
    for (let i = 0; i < 5; i++)
      comments.push(
        await prisma.comment.create({
          data: {
            author_id: author.id,
            post_id: post.id,
            content: `Comment ${i}`,
            created_at: new Date(1_800_000_000_000 + i),
          },
        })
      );
    const first = await request(app)
      .get(`/posts/${post.id}/comments`)
      .set('Authorization', `Bearer ${token}`)
      .query({ limit: 2 })
      .expect(200);
    await prisma.comment.delete({ where: { id: first.body.items[1].id } });
    const next = await request(app)
      .get(`/posts/${post.id}/comments`)
      .set('Authorization', `Bearer ${token}`)
      .query({ limit: 2, cursor: first.body.nextCursor })
      .expect(200);
    expect(next.body.items.map((c: any) => c.id)).toEqual([comments[2].id, comments[1].id]);
  });
});
