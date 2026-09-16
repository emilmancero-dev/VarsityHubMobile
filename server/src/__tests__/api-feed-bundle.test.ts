import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { describeDb } from './helpers/dbTestSuite.js';
import bcrypt from 'bcrypt';
import request from 'supertest';
import { app } from '../testApp.js';

let prisma: any;
let signJwt: any;

const PASSWORD = 'TestPassword123!';
const ts = Date.now();

describeDb('GET /feed/bundle', () => {
  const userIds: string[] = [];
  const postIds: string[] = [];
  const teamIds: string[] = [];
  const orgIds: string[] = [];
  const adIds: string[] = [];
  const gameIds: string[] = [];

  let viewerToken = '';
  let viewerId = '';

  beforeAll(async () => {
    ({ prisma } = await import('../lib/prisma.js'));
    ({ signJwt } = await import('../lib/jwt.js'));

    const passwordHash = await bcrypt.hash(PASSWORD, 10);

    const viewer = await prisma.user.create({
      data: {
        email: `feed-viewer-${ts}@example.com`,
        password_hash: passwordHash,
        display_name: 'Feed Viewer',
        email_verified: true,
        approval_status: 'APPROVED',
        date_of_birth: new Date('1992-01-01'),
        dob_set_at: new Date('2024-01-01T00:00:00.000Z'),
        preferences: {
          role: 'fan',
          onboarding_completed: true,
          country_code: 'US',
        },
      },
    });
    viewerId = viewer.id;
    viewerToken = signJwt({ id: viewer.id });
    userIds.push(viewer.id);

    const followedAuthor = await prisma.user.create({
      data: {
        email: `feed-followed-${ts}@example.com`,
        password_hash: passwordHash,
        display_name: 'Followed Author',
        email_verified: true,
        approval_status: 'APPROVED',
        date_of_birth: new Date('1990-05-05'),
        dob_set_at: new Date('2024-01-01T00:00:00.000Z'),
        preferences: { role: 'fan', onboarding_completed: true },
      },
    });
    userIds.push(followedAuthor.id);

    const actor = await prisma.user.create({
      data: {
        email: `feed-actor-${ts}@example.com`,
        password_hash: passwordHash,
        display_name: 'Actor',
        email_verified: true,
        approval_status: 'APPROVED',
        date_of_birth: new Date('1991-06-06'),
        dob_set_at: new Date('2024-01-01T00:00:00.000Z'),
        preferences: { role: 'fan', onboarding_completed: true },
      },
    });
    userIds.push(actor.id);

    await prisma.follows.create({
      data: {
        follower_id: viewer.id,
        following_id: followedAuthor.id,
        status: 'accepted',
      },
    });

    const organization = await prisma.organization.create({
      data: {
        name: `Feed Bundle Org ${ts}`,
        location: 'New York, NY',
        zip_code: '10001',
        admin_approved: true,
        status: 'active',
      },
    });
    orgIds.push(organization.id);

    const team = await prisma.team.create({
      data: {
        name: `Feed Bundle Team ${ts}`,
        organization_id: organization.id,
        sport: 'Basketball',
        status: 'active',
      },
    });
    teamIds.push(team.id);

    await prisma.teamFollow.create({
      data: {
        user_id: viewer.id,
        team_id: team.id,
      },
    });

    const followedPost = await prisma.post.create({
      data: {
        author_id: followedAuthor.id,
        title: 'Followed post',
        content: 'From followed user',
        type: 'post',
        country_code: 'US',
      },
    });
    postIds.push(followedPost.id);

    const teamPost = await prisma.post.create({
      data: {
        author_id: actor.id,
        team_id: team.id,
        title: 'Team post',
        content: 'From followed team',
        type: 'post',
        country_code: 'US',
      },
    });
    postIds.push(teamPost.id);

    await prisma.postUpvote.create({
      data: {
        user_id: viewer.id,
        post_id: followedPost.id,
      },
    });

    await prisma.notification.create({
      data: {
        user_id: viewer.id,
        actor_id: actor.id,
        type: 'FOLLOW',
      },
    });

    await prisma.message.create({
      data: {
        sender_id: actor.id,
        recipient_id: viewer.id,
        conversation_id: `dm:${[actor.id, viewer.id].sort().join('__')}`,
        content: 'Unread bundle message',
        read: false,
      },
    });

    const ad = await prisma.ad.create({
      data: {
        user_id: actor.id,
        contact_name: 'Bundle Advertiser',
        contact_email: `feed-ad-${ts}@example.com`,
        business_name: 'Bundle Ad',
        banner_url: 'https://example.com/banner.jpg',
        target_url: 'https://example.com',
        target_zip_code: '10001',
        target_lat: 40.7506,
        target_lng: -73.9972,
        radius: 25,
        description: 'Feed ad',
        status: 'active',
        payment_status: 'paid',
        reservations: {
          create: {
            date: new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`),
          },
        },
      },
    });
    adIds.push(ad.id);
  });

  afterAll(async () => {
    try {
      await prisma.message
        .deleteMany({
          where: {
            OR: [{ sender_id: { in: userIds } }, { recipient_id: { in: userIds } }],
          },
        })
        .catch(() => {});
      await prisma.notification
        .deleteMany({
          where: {
            OR: [{ user_id: { in: userIds } }, { actor_id: { in: userIds } }],
          },
        })
        .catch(() => {});
      await prisma.game.deleteMany({ where: { id: { in: gameIds } } }).catch(() => {});
      await prisma.postUpvote
        .deleteMany({
          where: {
            user_id: { in: userIds },
            post_id: { in: postIds },
          },
        })
        .catch(() => {});
      await prisma.teamFollow
        .deleteMany({
          where: { user_id: { in: userIds }, team_id: { in: teamIds } },
        })
        .catch(() => {});
      await prisma.follows
        .deleteMany({
          where: {
            OR: [{ follower_id: { in: userIds } }, { following_id: { in: userIds } }],
          },
        })
        .catch(() => {});
      await prisma.ad.deleteMany({ where: { id: { in: adIds } } }).catch(() => {});
      await prisma.post.deleteMany({ where: { id: { in: postIds } } }).catch(() => {});
      await prisma.team.deleteMany({ where: { id: { in: teamIds } } }).catch(() => {});
      await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => {});
      await prisma.refreshToken.deleteMany({ where: { user_id: { in: userIds } } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
    } catch (error) {
      console.warn('Cleanup error (non-critical):', error);
    }
  });

  it('computes only people posts when that is the requested section', async () => {
    const postReads = jest.spyOn(prisma.post, 'findMany');
    const adReads = jest.spyOn(prisma.ad, 'findMany');
    const notifications = jest.spyOn(prisma.notification, 'count');
    const messages = jest.spyOn(prisma.message, 'count');
    try {
      const res = await request(app)
        .get('/feed/bundle')
        .set('Authorization', `Bearer ${viewerToken}`)
        .query({ sections: 'posts', posts_limit: 2 })
        .expect(200);
      expect(res.body.posts.items.map((p: { id: string }) => p.id)).toContain(postIds[0]);
      expect(Object.keys(res.body).sort()).toEqual(['errors', 'posts']);
      expect(postReads).toHaveBeenCalledTimes(1);
      expect(adReads).not.toHaveBeenCalled();
      expect(notifications).not.toHaveBeenCalled();
      expect(messages).not.toHaveBeenCalled();
    } finally {
      jest.restoreAllMocks();
    }
  });
  it.each(['', 'posts,unknown', 'posts,', 'unknown'])(
    'rejects invalid section selection %s',
    async sections => {
      await request(app)
        .get('/feed/bundle')
        .set('Authorization', `Bearer ${viewerToken}`)
        .query({ sections })
        .expect(400);
    }
  );
  it('returns the bundled feed contract with unread counts and reservation-free ads', async () => {
    const res = await request(app)
      .get('/feed/bundle')
      .set('Authorization', `Bearer ${viewerToken}`)
      .query({
        country: 'US',
        date: new Date().toISOString().slice(0, 10),
        lat: 40.7506,
        lng: -73.9972,
      });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body?.posts?.items)).toBe(true);
    expect(Array.isArray(res.body?.posts_followed_teams?.items)).toBe(true);
    expect(Array.isArray(res.body?.highlights?.nationalTop)).toBe(true);
    expect(Array.isArray(res.body?.highlights?.ranked)).toBe(true);
    expect(res.body?.errors).toEqual([]);
    expect(res.body?.unread_notifications).toBe(1);
    expect(res.body?.unread_messages).toBe(1);

    const followedIds = (res.body?.posts?.items ?? []).map((item: any) => item.id);
    const teamIdsFromBundle = (res.body?.posts_followed_teams?.items ?? []).map(
      (item: any) => item.id
    );
    expect(followedIds.length).toBeGreaterThan(0);
    expect(teamIdsFromBundle.length).toBeGreaterThan(0);
    expect(res.body?.posts?.followed_feed_meta?.following_count).toBe(1);
    expect(res.body?.posts_followed_teams?.followed_teams_feed_meta?.followed_teams_count).toBe(1);

    expect(res.body?.ads?.date).toBe(new Date().toISOString().slice(0, 10));
    expect(Array.isArray(res.body?.ads?.ads)).toBe(true);
    expect(res.body?.ads?.ads.length).toBeGreaterThan(0);
    expect(res.body.ads.ads[0]).not.toHaveProperty('reservations');

    const viewerRow = await prisma.user.findUnique({
      where: { id: viewerId },
      select: { id: true },
    });
    expect(viewerRow?.id).toBe(viewerId);
  });

  // REGRESSION GUARD: ad visibility must not depend on the client forwarding
  // location. A stale app build or a web session that never sends zip/lat/lng
  // still gets ads because the server falls back to the signed-in viewer's
  // saved zip_code (the ad here targets 10001; the viewer's profile zip is
  // 10001). Without the fallback getAdsBundle returned zero ads for any client
  // that omitted location — the "active ad but I don't see it" bug.
  it('serves geofenced ads from the viewer profile zip when the request carries no location', async () => {
    const existing = await prisma.user.findUnique({
      where: { id: viewerId },
      select: { preferences: true },
    });
    await prisma.user.update({
      where: { id: viewerId },
      data: {
        preferences: {
          ...((existing?.preferences as object) ?? {}),
          zip_code: '10001',
        },
      },
    });

    const res = await request(app)
      .get('/feed/bundle')
      .set('Authorization', `Bearer ${viewerToken}`)
      .query({ date: new Date().toISOString().slice(0, 10) }); // no zip / lat / lng

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body?.ads?.ads)).toBe(true);
    expect(res.body?.ads?.ads.length).toBeGreaterThan(0);
  });

  // REGRESSION GUARD: the bundled highlights section must NOT filter on `post.type`.
  //
  // `Post.type` is nullable with no default and no backfill, and the main
  // create-post surface tags normal uploads `type: 'post'` (only a game's
  // add-highlight button sends 'highlight'). A `type: 'highlight'` WHERE clause
  // would hide every regular media post AND every legacy (type: null) post from
  // the bundled Highlights forever — the recurring "posted but not showing:
  // it's a filter, not a save failure" incident. Product decision in 1e23e19f:
  // Highlights is scoped by media_url + country + recency + privacy. Not by type.
  // Mirrors the equivalent guard in api-highlights.test.ts.
  it('includes BOTH highlight-typed and generic media posts in the bundled highlights section (no type filter)', async () => {
    const bundleHighlightId = `feed-bundle-highlight-${ts}`;
    const bundleRegularId = `feed-bundle-regular-${ts}`;

    await prisma.post.create({
      data: {
        id: bundleHighlightId,
        author_id: userIds[1],
        title: 'Bundle highlight',
        content: 'Should appear in highlights bundle',
        type: 'highlight',
        media_url: 'https://example.com/bundle-highlight.jpg',
        country_code: 'CA',
      },
    });
    postIds.push(bundleHighlightId);

    await prisma.post.create({
      data: {
        id: bundleRegularId,
        author_id: userIds[2],
        title: 'Bundle regular post',
        content: 'Generic media post — must also appear in highlights bundle',
        type: 'post',
        media_url: 'https://example.com/bundle-regular.jpg',
        country_code: 'CA',
      },
    });
    postIds.push(bundleRegularId);

    const res = await request(app)
      .get('/feed/bundle')
      .set('Authorization', `Bearer ${viewerToken}`)
      .query({ country: 'CA' });

    expect(res.status).toBe(200);
    const highlightIds = [
      ...(res.body?.highlights?.nationalTop ?? []),
      ...(res.body?.highlights?.ranked ?? []),
    ].map((item: any) => item.id);
    expect(highlightIds).toContain(bundleHighlightId);
    expect(highlightIds).toContain(bundleRegularId);
  });

  it('includes followed-user posts even after the viewer follows more than 1000 users', async () => {
    const overflowUserIds = Array.from(
      { length: 1001 },
      (_, index) => `feed-overflow-user-${ts}-${index}`
    );
    const overflowPostId = `feed-overflow-post-${ts}`;
    const overflowAuthorId = overflowUserIds[overflowUserIds.length - 1]!;

    await prisma.user.createMany({
      data: overflowUserIds.map((id, index) => ({
        id,
        email: `feed-overflow-user-${ts}-${index}@example.com`,
        email_verified: true,
        onboarding_completed: true,
      })),
    });
    userIds.push(...overflowUserIds);

    await prisma.follows.createMany({
      data: overflowUserIds.map(followingId => ({
        follower_id: viewerId,
        following_id: followingId,
        status: 'accepted',
      })),
    });

    await prisma.post.create({
      data: {
        id: overflowPostId,
        author_id: overflowAuthorId,
        title: 'Overflow followed post',
        content: 'Should still be visible after 1000 follows',
        type: 'post',
        country_code: 'US',
      },
    });
    postIds.push(overflowPostId);

    const res = await request(app)
      .get('/feed/bundle')
      .set('Authorization', `Bearer ${viewerToken}`);

    expect(res.status).toBe(200);
    expect(res.body?.posts?.followed_feed_meta?.following_count).toBe(1002);
    expect((res.body?.posts?.items ?? []).map((item: any) => item.id)).toContain(overflowPostId);
  });

  it('includes followed-team game posts even after the viewer follows more than 1000 teams', async () => {
    const overflowTeamIds = Array.from(
      { length: 1001 },
      (_, index) => `feed-overflow-team-${ts}-${index}`
    );
    const overflowGameId = `feed-overflow-game-${ts}`;
    const overflowPostId = `feed-overflow-team-post-${ts}`;
    const overflowTeamId = overflowTeamIds[overflowTeamIds.length - 1]!;

    await prisma.team.createMany({
      data: overflowTeamIds.map((id, index) => ({
        id,
        name: `Overflow Team ${index}`,
        organization_id: orgIds[0],
        status: 'active',
      })),
    });
    teamIds.push(...overflowTeamIds);

    await prisma.teamFollow.createMany({
      data: overflowTeamIds.map(teamId => ({
        user_id: viewerId,
        team_id: teamId,
      })),
    });

    await prisma.game.create({
      data: {
        id: overflowGameId,
        title: 'Overflow team game',
        date: new Date(Date.now() + 24 * 60 * 60 * 1000),
        location: 'Overflow Stadium',
        approval_status: 'approved',
        home_team_id: overflowTeamId,
      },
    });
    gameIds.push(overflowGameId);

    await prisma.post.create({
      data: {
        id: overflowPostId,
        author_id: userIds[1],
        game_id: overflowGameId,
        title: 'Overflow followed team post',
        content: 'Game-linked post from an overflow followed team',
        type: 'post',
        country_code: 'US',
      },
    });
    postIds.push(overflowPostId);

    const res = await request(app)
      .get('/feed/bundle')
      .set('Authorization', `Bearer ${viewerToken}`);

    expect(res.status).toBe(200);
    expect(res.body?.posts_followed_teams?.followed_teams_feed_meta?.followed_teams_count).toBe(
      1002
    );
    expect((res.body?.posts_followed_teams?.items ?? []).map((item: any) => item.id)).toContain(
      overflowPostId
    );

    await prisma.game.delete({ where: { id: overflowGameId } }).catch(() => {});
    gameIds.pop();
  });
});
