import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';
import { app } from '../testApp.js';
import { prisma } from '../lib/prisma.js';
import { signJwt } from '../lib/jwt.js';

describe('post/comment pagination continuity (real database)', () => {
  const previousWriterFlag = process.env.POST_PAGE_CURSOR_V2_WRITE_ENABLED;
  let viewer: string;
  let team: string;
  let organization: string;
  let token: string;
  let posts: string[];
  let comments: string[];
  beforeEach(async () => {
    process.env.POST_PAGE_CURSOR_V2_WRITE_ENABLED = 'true';
    const user = await prisma.user.create({
      data: {
        email: `pagination-${Date.now()}-${Math.random()}@example.com`,
        email_verified: true,
        onboarding_completed: true,
        role: 'fan',
        date_of_birth: new Date('1990-01-01'),
      },
    });
    viewer = user.id;
    token = signJwt({ id: viewer });
    organization = (await prisma.organization.create({ data: { name: 'Pagination fixture' } })).id;
    team = (
      await prisma.team.create({
        data: { name: 'Pagination fixture', status: 'active', organization_id: organization },
      })
    ).id;
    await prisma.teamFollow.create({ data: { user_id: viewer, team_id: team } });
    posts = [];
    comments = [];
    // Deliberate equal timestamps: IDs are the deterministic descending tie-breaker.
    for (let i = 0; i < 7; i++) {
      const id = `c${viewer.slice(1, 17)}page${i.toString().padStart(4, '0')}`;
      posts.push(id);
      await prisma.post.create({
        data: {
          id,
          author_id: viewer,
          team_id: team,
          content: `row ${i}`,
          created_at: new Date('2026-01-01'),
          lat: 40.75,
          lng: -73.99,
        },
      });
    }
    for (let i = 0; i < 7; i++) {
      const id = `c${viewer.slice(1, 17)}comm${i.toString().padStart(4, '0')}`;
      comments.push(id);
      await prisma.comment.create({
        data: {
          id,
          author_id: viewer,
          post_id: posts[0],
          content: `comment ${i}`,
          created_at: new Date('2026-01-01'),
        },
      });
    }
  });
  afterEach(async () => {
    if (previousWriterFlag === undefined) delete process.env.POST_PAGE_CURSOR_V2_WRITE_ENABLED;
    else process.env.POST_PAGE_CURSOR_V2_WRITE_ENABLED = previousWriterFlag;
    await prisma.post.deleteMany({ where: { author_id: viewer } });
    await prisma.team.delete({ where: { id: team } });
    await prisma.organization.delete({ where: { id: organization } });
    await prisma.user.delete({ where: { id: viewer } });
  });

  async function page(kind: string, cursor?: string, extra = {}) {
    const bundle = kind.startsWith('bundle');
    const path = bundle
      ? '/feed/bundle'
      : kind === 'comments'
        ? `/posts/${posts[0]}/comments`
        : '/posts';
    const query = bundle
      ? {
          posts_limit: 2,
          [kind === 'bundle-teams' ? 'posts_followed_teams_cursor' : 'posts_cursor']: cursor,
        }
      : { limit: 2, ...(kind === 'comments' ? {} : { user_id: viewer }), cursor, ...extra };
    const response = await request(app)
      .get(path)
      .set('Authorization', `Bearer ${token}`)
      .query(query)
      .expect(200);
    expect(response.body.errors ?? []).toEqual([]);
    return bundle
      ? response.body[kind === 'bundle-teams' ? 'posts_followed_teams' : 'posts']
      : response.body;
  }
  async function traverse(kind: string, extra = {}) {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let n = 0; n < 30; n++) {
      const result = await page(kind, cursor, extra);
      ids.push(...result.items.map((row: { id: string }) => row.id));
      if (!result.nextCursor) return ids;
      expect(result.nextCursor).not.toBe(cursor);
      cursor = result.nextCursor;
    }
    throw new Error('Pagination failed to terminate');
  }
  it.each(['posts', 'comments', 'bundle-people', 'bundle-teams'])(
    'delivers all seven %s exactly once at page size two',
    async kind => {
      expect(await traverse(kind)).toEqual([...(kind === 'comments' ? comments : posts)].reverse());
    }
  );
  it.each(['posts', 'comments', 'bundle-people', 'bundle-teams', 'trending'])(
    'defaults to legacy output and supports forward/rollback cursor transitions for %s',
    async kind => {
      delete process.env.POST_PAGE_CURSOR_V2_WRITE_ENABLED;
      const target = kind === 'trending' ? 'posts' : kind;
      const extra = kind === 'trending' ? { sort: 'trending' } : {};
      const expected = [...(kind === 'comments' ? comments : posts)].reverse();
      expect(await traverse(target, extra)).toEqual(expected);
      const first = await page(target, undefined, extra);
      expect(first.nextCursor).toBe(
        kind === 'trending' ? `t:0|2026-01-01T00:00:00.000Z|${expected[2]}` : expected[2]
      );
      process.env.POST_PAGE_CURSOR_V2_WRITE_ENABLED = 'true';
      const second = await page(target, first.nextCursor, extra);
      expect(second.nextCursor.startsWith(kind === 'trending' ? 't2:' : 'p2:')).toBe(true);
      process.env.POST_PAGE_CURSOR_V2_WRITE_ENABLED = 'false';
      const third = await page(target, second.nextCursor, extra);
      const fourth = await page(target, third.nextCursor, extra);
      expect(
        [...first.items, ...second.items, ...third.items, ...fourth.items].map(row => row.id)
      ).toEqual(expected);
    }
  );
  it('keeps pinned team posts first without dropping timestamp ties', async () => {
    await prisma.post.update({ where: { id: posts[0] }, data: { is_pinned: true } });
    expect(await traverse('posts', { team_id: team })).toEqual([
      posts[0],
      ...posts.slice(1).reverse(),
    ]);
  });
  it('delivers every trending post once when scores and timestamps tie', async () => {
    expect(await traverse('posts', { sort: 'trending' })).toEqual([...posts].reverse());
  });
  it('includes the first unseen record from a legacy trending cursor', async () => {
    const result = await page('posts', `t:0|2026-01-01T00:00:00.000Z|${posts[4]}`, {
      sort: 'trending',
    });
    expect(result.items.map((r: { id: string }) => r.id)).toEqual([posts[4], posts[3]]);
  });
  it('keeps trending score time fixed across delayed continuation requests', async () => {
    for (let i = 0; i < posts.length; i++)
      await prisma.post.update({
        where: { id: posts[i] },
        data: { upvotes_count: 7 - i, created_at: new Date() },
      });
    const first = await page('posts', undefined, { sort: 'trending' });
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_000);
    try {
      const second = await page('posts', first.nextCursor, { sort: 'trending' });
      expect([...first.items, ...second.items].map((r: { id: string }) => r.id)).toEqual(
        posts.slice(0, 4)
      );
    } finally {
      clock.mockRestore();
    }
  });
  it('resumes a positive-score legacy trending cursor at its first unseen record after time passes', async () => {
    const createdAt = new Date();
    for (let i = 0; i < posts.length; i++)
      await prisma.post.update({
        where: { id: posts[i] },
        data: { upvotes_count: 7 - i, created_at: createdAt },
      });
    const clock = jest.spyOn(Date, 'now').mockReturnValue(createdAt.getTime() + 3_600_000);
    try {
      const result = await page(
        'posts',
        `t:1.7677669529663687|${createdAt.toISOString()}|${posts[2]}`,
        { sort: 'trending' }
      );
      expect(result.items.map((r: { id: string }) => r.id)).toEqual([posts[2], posts[3]]);
    } finally {
      clock.mockRestore();
    }
  });
  it('does not treat close but unequal trending scores as timestamp ties', async () => {
    const now = Date.now();
    await prisma.post.update({
      where: { id: posts[0] },
      data: { upvotes_count: 2, created_at: new Date(now - 10000 * 3_600_000) },
    });
    await prisma.post.update({
      where: { id: posts[1] },
      data: { upvotes_count: 1, created_at: new Date(now - 6298.9 * 3_600_000) },
    });
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const first = await page('posts', undefined, { sort: 'trending', limit: 1 });
      const second = await page('posts', first.nextCursor, { sort: 'trending', limit: 1 });
      expect([first.items[0].id, second.items[0].id]).toEqual([posts[0], posts[1]]);
    } finally {
      clock.mockRestore();
    }
  });
  it.each(['posts', 'comments', 'bundle-people', 'bundle-teams'])(
    'accepts old first-unseen ID cursors for %s without skipping that item',
    async kind => {
      const rows = kind === 'comments' ? comments : posts;
      expect((await page(kind, rows[4])).items.map((r: { id: string }) => r.id)).toEqual([
        rows[4],
        rows[3],
      ]);
    }
  );
  it.each(['posts', 'comments', 'bundle-people', 'bundle-teams'])(
    'continues %s after the last delivered row is deleted',
    async kind => {
      const first = await page(kind);
      const last = first.items[1].id;
      if (kind === 'comments') await prisma.comment.delete({ where: { id: last } });
      else await prisma.post.delete({ where: { id: last } });
      const rows = kind === 'comments' ? comments : posts;
      expect((await page(kind, first.nextCursor)).items.map((r: { id: string }) => r.id)).toEqual([
        rows[4],
        rows[3],
      ]);
    }
  );
  it('does not silently restart for an invalid posts cursor', async () => {
    const response = await request(app)
      .get('/posts')
      .set('Authorization', `Bearer ${token}`)
      .query({ user_id: viewer, cursor: 'p2:invalid', limit: 2 });
    expect(response.status).toBe(400);
  });
  it('asks for refresh when a legacy cursor row no longer exists', async () => {
    await prisma.post.delete({ where: { id: posts[4] } });
    for (const extra of [
      { cursor: posts[4] },
      { sort: 'trending', cursor: `t:0|2026-01-01T00:00:00.000Z|${posts[4]}` },
    ]) {
      await request(app)
        .get('/posts')
        .set('Authorization', `Bearer ${token}`)
        .query({ user_id: viewer, limit: 2, ...extra })
        .expect(400);
    }
  });
  it.each(['true', 'false'])(
    'returns a progressing cursor when distant rows exhaust the scan budget (v2=%s)',
    async enabled => {
      process.env.POST_PAGE_CURSOR_V2_WRITE_ENABLED = enabled;
      await prisma.post.createMany({
        data: Array.from({ length: 95 }, (_, i) => ({
          author_id: viewer,
          content: `scan-budget ${i}`,
          lat: 0,
          lng: 0,
          created_at: new Date(Date.UTC(2026, 1, 1, 0, 0, i)),
        })),
      });
      const first = await page('posts', undefined, { lat: 40.75, lng: -73.99, radius: 10 });
      expect(first.items).toEqual([]);
      expect(first.nextCursor).toEqual(expect.any(String));
      const second = await page('posts', first.nextCursor, { lat: 40.75, lng: -73.99, radius: 10 });
      expect(second.items.map((r: { id: string }) => r.id)).toEqual([posts[6], posts[5]]);
      expect(await traverse('posts', { lat: 40.75, lng: -73.99, radius: 10 })).toEqual(
        [...posts].reverse()
      );
    }
  );
  it('keeps nearby posts reachable beyond a full batch of distant records', async () => {
    await prisma.post.createMany({
      data: Array.from({ length: 10 }, (_, i) => ({
        author_id: viewer,
        content: `distant ${i}`,
        lat: 0,
        lng: 0,
        created_at: new Date(`2026-02-${String(i + 1).padStart(2, '0')}`),
      })),
    });
    expect(await traverse('posts', { lat: 40.75, lng: -73.99, radius: 10 })).toEqual(
      [...posts].reverse()
    );
  });

  it('does not repeat a nearby last-scanned row on a partial legacy page', async () => {
    process.env.POST_PAGE_CURSOR_V2_WRITE_ENABLED = 'false';
    const boundaryId = `c${viewer.slice(1, 17)}sparse0005`;
    await prisma.post.createMany({
      data: Array.from({ length: 95 }, (_, i) => ({
        id: `c${viewer.slice(1, 17)}sparse${i.toString().padStart(4, '0')}`,
        author_id: viewer,
        content: `partial scan ${i}`,
        lat: i === 5 ? 40.75 : 0,
        lng: i === 5 ? -73.99 : 0,
        created_at: new Date(Date.UTC(2026, 1, 1, 0, 0, i)),
      })),
    });
    const nearby = { lat: 40.75, lng: -73.99, radius: 10 };
    const first = await page('posts', undefined, nearby);
    expect(first.items.map((row: { id: string }) => row.id)).toEqual([boundaryId]);
    expect(first.nextCursor).not.toBe(boundaryId);
    expect(await traverse('posts', nearby)).toEqual([boundaryId, ...posts.slice().reverse()]);
  });

  it('ends a legacy sparse page when the exact scan budget exhausts authorized rows', async () => {
    process.env.POST_PAGE_CURSOR_V2_WRITE_ENABLED = 'false';
    await prisma.post.updateMany({ where: { author_id: viewer }, data: { lat: 0, lng: 0 } });
    await prisma.post.createMany({
      data: Array.from({ length: 83 }, (_, i) => ({
        author_id: viewer,
        content: `exact scan ${i}`,
        lat: 0,
        lng: 0,
        created_at: new Date(Date.UTC(2026, 1, 1, 0, 0, i)),
      })),
    });
    const result = await page('posts', undefined, { lat: 40.75, lng: -73.99, radius: 10 });
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });
});
