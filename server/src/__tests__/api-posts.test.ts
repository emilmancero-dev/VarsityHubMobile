/**
 * API Integration Tests for Posts Endpoints
 *
 * Tests the posts API endpoints with real HTTP requests
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import request from 'supertest';
import { app } from '../testApp.js';
import bcrypt from 'bcrypt';
import { describeDb } from './helpers/dbTestSuite.js';

let prisma: any;
let signJwt: any;

describeDb('Posts API Endpoints', () => {
  let testUser: any;
  let testUserToken: string;
  let testPostId: string;
  let testEventId: string;
  let adminUser: any;
  let adminToken: string;
  let reusedAdmin = false;
  let bypassCoachUser: any;
  let bypassCoachToken: string;
  let bypassOrgId: string;
  let bypassHomeTeamId: string;
  let bypassAwayTeamId: string;
  let bypassGameId: string;
  let bypassEventId: string;
  const missingPostId = `c${'0'.repeat(24)}`;

  beforeAll(async () => {
    ({ prisma } = await import('../lib/prisma.js'));
    ({ signJwt } = await import('../lib/jwt.js'));
    // Create test user
    testUser = await prisma.user.create({
      data: {
        email: `test-posts-${Date.now()}@example.com`,
        password_hash: await bcrypt.hash('TestPassword123!', 10),
        display_name: 'Test Posts User',
        email_verified: true,
        role: 'coach',
        onboarding_completed: true,
        approval_status: 'APPROVED',
        preferences: {
          role: 'coach',
          onboarding_completed: true,
          coach_agreement_accepted_at: new Date().toISOString(),
        },
      },
    });
    testUserToken = signJwt({ id: testUser.id });

    // Admin ACCESS is the hardcoded PLATFORM_ADMIN_EMAILS floor (not ADMIN_EMAILS,
    // which only drives notification routing). Upsert by that email so we don't
    // collide with a leftover row, and don't delete a pre-existing admin.
    const ADMIN_EMAIL = 'emancero@varsityhub.app';
    const existingAdmin = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
    if (existingAdmin) {
      adminUser = await prisma.user.update({
        where: { id: existingAdmin.id },
        data: { email_verified: true },
      });
      reusedAdmin = true;
    } else {
      adminUser = await prisma.user.create({
        data: {
          email: ADMIN_EMAIL,
          password_hash: await bcrypt.hash('TestPassword123!', 10),
          display_name: 'Geofence Admin',
          email_verified: true,
          role: 'fan',
          onboarding_completed: true,
          approval_status: 'APPROVED',
          preferences: {
            role: 'fan',
            onboarding_completed: true,
          },
        },
      });
    }
    adminToken = signJwt({ id: adminUser.id });

    bypassCoachUser = await prisma.user.create({
      data: {
        email: `bypass-coach-posts-${Date.now()}@example.com`,
        password_hash: await bcrypt.hash('TestPassword123!', 10),
        display_name: 'Bypass Coach',
        email_verified: true,
        role: 'coach',
        onboarding_completed: true,
        approval_status: 'APPROVED',
        preferences: {
          role: 'coach',
          onboarding_completed: true,
          coach_agreement_accepted_at: new Date().toISOString(),
        },
      },
    });
    bypassCoachToken = signJwt({ id: bypassCoachUser.id });

    const bypassOrg = await prisma.organization.create({
      data: {
        name: `Post geofence bypass org ${Date.now()}`,
        org_type: 'club',
        updated_at: new Date(),
      },
    });
    bypassOrgId = bypassOrg.id;

    const [homeTeam, awayTeam] = await Promise.all([
      prisma.team.create({
        data: {
          name: `Post bypass home ${Date.now()}`,
          organization_id: bypassOrgId,
        },
      }),
      prisma.team.create({
        data: {
          name: `Post bypass away ${Date.now()}`,
          organization_id: bypassOrgId,
        },
      }),
    ]);
    bypassHomeTeamId = homeTeam.id;
    bypassAwayTeamId = awayTeam.id;

    const bypassGame = await prisma.game.create({
      data: {
        title: `Post bypass game ${Date.now()}`,
        date: new Date(Date.now() + 60 * 60 * 1000),
        location: 'Bypass Stadium',
        approval_status: 'approved',
        home_team_id: bypassHomeTeamId,
        away_team_id: bypassAwayTeamId,
      },
    });
    bypassGameId = bypassGame.id;

    const bypassEvent = await prisma.event.create({
      data: {
        title: `Post bypass event ${Date.now()}`,
        date: new Date(Date.now() + 60 * 60 * 1000),
        location: 'Bypass Stadium',
        latitude: 40.7128,
        longitude: -74.006,
        game_id: bypassGameId,
        status: 'approved',
        approval_status: 'approved',
        creator_id: testUser.id,
        creator_role: 'coach',
      },
    });
    bypassEventId = bypassEvent.id;

    await prisma.teamMembership.create({
      data: {
        team_id: bypassHomeTeamId,
        user_id: bypassCoachUser.id,
        role: 'coach',
        status: 'active',
      },
    });
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { user_id: testUser.id } }).catch(() => {});
    if (testEventId) {
      await prisma.event.delete({ where: { id: testEventId } }).catch(() => {});
    }
    if (bypassEventId) {
      await prisma.event.delete({ where: { id: bypassEventId } }).catch(() => {});
    }
    if (bypassGameId) {
      await prisma.game.delete({ where: { id: bypassGameId } }).catch(() => {});
    }
    if (bypassHomeTeamId || bypassAwayTeamId) {
      await prisma.teamMembership
        .deleteMany({ where: { user_id: bypassCoachUser?.id } })
        .catch(() => {});
      await prisma.team
        .deleteMany({ where: { id: { in: [bypassHomeTeamId, bypassAwayTeamId].filter(Boolean) } } })
        .catch(() => {});
    }
    if (bypassOrgId) {
      await prisma.organization.delete({ where: { id: bypassOrgId } }).catch(() => {});
    }
    // Clean up test data
    if (testPostId) {
      await prisma.post.delete({ where: { id: testPostId } }).catch(() => {});
    }
    await prisma.post
      .deleteMany({
        where: { author_id: { in: [adminUser?.id, bypassCoachUser?.id].filter(Boolean) } },
      })
      .catch(() => {});
    // Only remove the admin if we created it — never delete a pre-existing row.
    if (!reusedAdmin) {
      await prisma.user.delete({ where: { id: adminUser?.id } }).catch(() => {});
    }
    await prisma.user.delete({ where: { id: bypassCoachUser?.id } }).catch(() => {});
    await prisma.user.delete({ where: { id: testUser.id } }).catch(() => {});
  });

  describe('GET /posts', () => {
    it('should return list of posts', async () => {
      const res = await request(app).get('/posts').query({ limit: '10' });

      expect(res.statusCode).toEqual(200);
      expect(Array.isArray(res.body.items)).toBe(true);
    });

    it('should support pagination with cursor', async () => {
      const res1 = await request(app).get('/posts').query({ limit: '5' });

      expect(res1.statusCode).toEqual(200);
      expect(Array.isArray(res1.body.items)).toBe(true);

      if (res1.body.items.length > 0) {
        const cursor = res1.body.items[res1.body.items.length - 1].id;
        const res2 = await request(app).get('/posts').query({ limit: '5', cursor });

        expect(res2.statusCode).toEqual(200);
        expect(Array.isArray(res2.body.items)).toBe(true);
      }
    });

    it('should filter by game_id when provided', async () => {
      const res = await request(app).get('/posts').query({ game_id: 'non-existent-id' });

      expect(res.statusCode).toEqual(200);
      expect(Array.isArray(res.body.items)).toBe(true);
    });

    it("team_id filter includes posts attached to the team's games", async () => {
      const [teamPost, gamePost] = await Promise.all([
        prisma.post.create({
          data: { author_id: testUser.id, content: 'direct team post', team_id: bypassHomeTeamId },
        }),
        prisma.post.create({
          data: { author_id: testUser.id, content: 'game-linked post', game_id: bypassGameId },
        }),
      ]);
      try {
        const res = await request(app)
          .get('/posts')
          .query({ team_id: bypassHomeTeamId, limit: '50' });

        expect(res.statusCode).toEqual(200);
        const ids = res.body.items.map((p: any) => p.id);
        expect(ids).toContain(teamPost.id);
        expect(ids).toContain(gamePost.id);
      } finally {
        await prisma.post
          .deleteMany({ where: { id: { in: [teamPost.id, gamePost.id] } } })
          .catch(() => {});
      }
    });

    it('program_id filter returns posts across ALL sub-teams in the program (shared sport page)', async () => {
      // Owner July-28: ONE sport page — the Posts tab is shared across every
      // sub-team. A post on the home sub-team AND a post on the away sub-team
      // both surface under program_id, regardless of which sub-team was tapped.
      const program = await prisma.sportProgram.create({
        data: { organization_id: bypassOrgId, sport: 'basketball' },
      });
      await prisma.team.updateMany({
        where: { id: { in: [bypassHomeTeamId, bypassAwayTeamId] } },
        data: { program_id: program.id },
      });
      const [homePost, awayPost] = await Promise.all([
        prisma.post.create({
          data: {
            author_id: testUser.id,
            content: 'home sub-team post',
            team_id: bypassHomeTeamId,
          },
        }),
        prisma.post.create({
          data: {
            author_id: testUser.id,
            content: 'away sub-team post',
            team_id: bypassAwayTeamId,
          },
        }),
      ]);
      try {
        const res = await request(app).get('/posts').query({ program_id: program.id, limit: '50' });

        expect(res.statusCode).toEqual(200);
        const ids = res.body.items.map((p: any) => p.id);
        expect(ids).toContain(homePost.id);
        expect(ids).toContain(awayPost.id);
      } finally {
        await prisma.post
          .deleteMany({ where: { id: { in: [homePost.id, awayPost.id] } } })
          .catch(() => {});
        await prisma.team
          .updateMany({
            where: { id: { in: [bypassHomeTeamId, bypassAwayTeamId] } },
            data: { program_id: null },
          })
          .catch(() => {});
        await prisma.sportProgram.delete({ where: { id: program.id } }).catch(() => {});
      }
    });
  });

  describe('POST /posts', () => {
    it('should require authentication', async () => {
      const res = await request(app).post('/posts').send({
        title: 'Test Post',
        content: 'Test content',
      });

      expect(res.statusCode).toEqual(401);
    });

    it('should create a post with valid data', async () => {
      const res = await request(app)
        .post('/posts')
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({
          title: 'Test Post',
          content: 'Test content for integration test',
          type: 'post',
        });

      expect(res.statusCode).toEqual(201);
      expect(res.body).toHaveProperty('id');
      expect(res.body.title).toBe('Test Post');
      expect(res.body.content).toBe('Test content for integration test');
      expect(res.body.author_id).toBe(testUser.id);

      testPostId = res.body.id;
    });

    it('should allow delete + restore within undo window', async () => {
      const created = await request(app)
        .post('/posts')
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({
          title: 'Post to delete',
          content: 'Delete me',
          type: 'post',
        });

      const postId = created.body.id;
      expect(postId).toBeDefined();

      const del = await request(app)
        .delete(`/posts/${postId}`)
        .set('Authorization', `Bearer ${testUserToken}`);

      expect(del.statusCode).toEqual(200);
      expect(del.body.deleted_at).toBeDefined();

      const restore = await request(app)
        .post(`/posts/${postId}/restore`)
        .set('Authorization', `Bearer ${testUserToken}`);

      expect(restore.statusCode).toEqual(200);
      expect(restore.body.ok).toBe(true);
      expect(restore.body.post_id).toBe(postId);

      await prisma.post.delete({ where: { id: postId } }).catch(() => {});
    });

    it('should remove post-linked notifications when a post is soft-deleted', async () => {
      const created = await request(app)
        .post('/posts')
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({
          title: 'Post with notifications',
          content: 'Delete should clean notifications',
          type: 'post',
        });

      const postId = created.body.id;
      expect(postId).toBeDefined();

      await prisma.notification.create({
        data: {
          user_id: testUser.id,
          type: 'SHARE',
          post_id: postId,
          meta: { source: 'api-posts-test' },
        },
      });

      const del = await request(app)
        .delete(`/posts/${postId}`)
        .set('Authorization', `Bearer ${testUserToken}`);

      expect(del.statusCode).toBe(200);

      const notifications = await prisma.notification.findMany({
        where: { post_id: postId },
        select: { id: true },
      });

      expect(notifications).toHaveLength(0);

      await prisma.post.delete({ where: { id: postId } }).catch(() => {});
    });

    // 2026-07-08 incident: client retries of a delete that had already landed got
    // 404s (surfaced as "Failed to delete post") or piled up behind a stalled
    // transaction. Retries by an authorized caller must settle fast as success.
    it('should return 200 (idempotent) when the author retries an already-deleted post', async () => {
      const created = await request(app)
        .post('/posts')
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({
          title: 'Idempotent delete',
          content: 'Delete twice, second one must still be a success',
          type: 'post',
        });

      const postId = created.body.id;
      expect(postId).toBeDefined();

      const first = await request(app)
        .delete(`/posts/${postId}`)
        .set('Authorization', `Bearer ${testUserToken}`);
      expect(first.statusCode).toBe(200);
      expect(first.body.deleted_at).toBeDefined();

      const retry = await request(app)
        .delete(`/posts/${postId}`)
        .set('Authorization', `Bearer ${testUserToken}`);
      expect(retry.statusCode).toBe(200);
      expect(retry.body.already_deleted).toBe(true);
      expect(retry.body.deleted_at).toBe(first.body.deleted_at);

      // A caller who could NOT have deleted the post sees the same 404 as a
      // nonexistent post — already-deleted must not leak to unauthorized users.
      const unauthorized = await request(app)
        .delete(`/posts/${postId}`)
        .set('Authorization', `Bearer ${bypassCoachToken}`);
      expect(unauthorized.statusCode).toBe(404);

      await prisma.post.delete({ where: { id: postId } }).catch(() => {});
    });

    it('should remove comment-linked notifications when a comment is deleted', async () => {
      const created = await request(app)
        .post('/posts')
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({
          title: 'Comment cleanup post',
          content: 'Comment delete should clean notifications',
          type: 'post',
        });

      const postId = created.body.id;
      expect(postId).toBeDefined();

      const comment = await prisma.comment.create({
        data: {
          post_id: postId,
          author_id: testUser.id,
          content: 'Temporary comment',
        },
      });

      await prisma.notification.create({
        data: {
          user_id: testUser.id,
          type: 'COMMENT_REPLY',
          post_id: postId,
          comment_id: comment.id,
          meta: { source: 'api-posts-test' },
        },
      });

      const del = await request(app)
        .delete(`/posts/${postId}/comments/${comment.id}`)
        .set('Authorization', `Bearer ${testUserToken}`);

      expect(del.statusCode).toBe(200);

      const notifications = await prisma.notification.findMany({
        where: { comment_id: comment.id },
        select: { id: true },
      });

      expect(notifications).toHaveLength(0);

      await prisma.post.delete({ where: { id: postId } }).catch(() => {});
    });

    it('should reject invalid payload', async () => {
      const res = await request(app)
        .post('/posts')
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({
          // Missing required fields or invalid data
          title: '', // Empty title might be invalid
        });

      expect(res.statusCode).toEqual(400);
    });

    it.each(['zip', 'derived', 'places'] as const)(
      'should reject event posts when location source is %s',
      async source => {
        const event = await prisma.event.create({
          data: {
            title: `Post geofence event ${Date.now()}-${source}`,
            date: new Date(Date.now() + 60 * 60 * 1000),
            location: 'VarsityHub Stadium',
            latitude: 40.7128,
            longitude: -74.006,
            status: 'approved',
            approval_status: 'approved',
            creator_id: testUser.id,
            creator_role: 'coach',
          },
        });
        testEventId = event.id;

        try {
          const res = await request(app)
            .post('/posts')
            .set('Authorization', `Bearer ${testUserToken}`)
            .send({
              title: `${source}-backed event post`,
              content: `Trying to post with a non-device location source: ${source}`,
              event_id: event.id,
              location: {
                lat: 40.7128,
                lng: -74.006,
                source,
              },
            });

          expect(res.statusCode).toBe(403);
          expect(res.body.error).toBe('LOCATION_REQUIRED');
          expect(res.body.message).toMatch(/device location/i);
        } finally {
          await prisma.event.delete({ where: { id: event.id } }).catch(() => {});
          testEventId = undefined as any;
        }
      }
    );

    it('should reject event posts when location source is missing', async () => {
      const event = await prisma.event.create({
        data: {
          title: `Missing-source event ${Date.now()}`,
          date: new Date(Date.now() + 60 * 60 * 1000),
          location: 'VarsityHub Stadium',
          latitude: 40.7128,
          longitude: -74.006,
          status: 'approved',
          approval_status: 'approved',
          creator_id: testUser.id,
          creator_role: 'coach',
        },
      });

      try {
        const res = await request(app)
          .post('/posts')
          .set('Authorization', `Bearer ${testUserToken}`)
          .send({
            title: 'Missing-source event post',
            content: 'Trying to post without an explicit device location source',
            event_id: event.id,
            location: {
              lat: 40.7128,
              lng: -74.006,
            },
          });

        expect(res.statusCode).toBe(403);
        expect(res.body.error).toBe('LOCATION_REQUIRED');
        expect(res.body.message).toMatch(/device location/i);
      } finally {
        await prisma.event.delete({ where: { id: event.id } }).catch(() => {});
      }
    });

    it('should allow event posts when device-origin coordinates are within 3 km', async () => {
      const event = await prisma.event.create({
        data: {
          title: `Device geofence event ${Date.now()}`,
          date: new Date(Date.now() + 60 * 60 * 1000),
          location: 'VarsityHub Arena',
          latitude: 40.7128,
          longitude: -74.006,
          status: 'approved',
          approval_status: 'approved',
          creator_id: testUser.id,
          creator_role: 'coach',
        },
      });

      try {
        const res = await request(app)
          .post('/posts')
          .set('Authorization', `Bearer ${testUserToken}`)
          .send({
            title: 'Device-backed event post',
            content: 'Posting from the venue with device coordinates',
            event_id: event.id,
            location: {
              lat: 40.7128,
              lng: -74.006,
              source: 'device',
            },
          });

        expect(res.statusCode).toBe(201);
        expect(res.body.id).toBeDefined();

        await prisma.post.delete({ where: { id: res.body.id } }).catch(() => {});
      } finally {
        await prisma.event.delete({ where: { id: event.id } }).catch(() => {});
      }
    });

    it('should create and return media posts attached only by event_id', async () => {
      const event = await prisma.event.create({
        data: {
          title: `Standalone media event ${Date.now()}`,
          date: new Date(Date.now() + 60 * 60 * 1000),
          location: 'VarsityHub Arena',
          latitude: 40.7128,
          longitude: -74.006,
          status: 'approved',
          approval_status: 'approved',
          creator_id: testUser.id,
          creator_role: 'coach',
        },
      });

      try {
        const createRes = await request(app)
          .post('/posts')
          .set('Authorization', `Bearer ${testUserToken}`)
          .send({
            content: 'Posting uploaded media to a standalone event page',
            type: 'highlight',
            media_url: 'https://varsityhub.app/uploads/test-event-media.jpg',
            event_id: event.id,
            location: {
              lat: 40.7128,
              lng: -74.006,
              source: 'device',
            },
          });

        expect(createRes.statusCode).toBe(201);
        expect(createRes.body.event_id).toBe(event.id);
        expect(createRes.body.game_id ?? null).toBeNull();

        const eventFeedRes = await request(app)
          .get('/posts')
          .query({ event_id: event.id })
          .set('Authorization', `Bearer ${testUserToken}`);

        expect(eventFeedRes.statusCode).toBe(200);
        const items = eventFeedRes.body.items || eventFeedRes.body.posts || [];
        expect(items.some((post: any) => post.id === createRes.body.id)).toBe(true);

        await prisma.post.delete({ where: { id: createRes.body.id } }).catch(() => {});
      } finally {
        await prisma.event.delete({ where: { id: event.id } }).catch(() => {});
      }
    });

    it('accepts a batch of up to 5 media items via media_urls, mirroring the first onto media_url', async () => {
      const urls = [1, 2, 3].map(
        n => `https://varsityhub.app/uploads/batch-${n}-${Date.now()}.jpg`
      );
      const createRes = await request(app)
        .post('/posts')
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({ content: 'Batch media post', media_urls: urls });

      expect(createRes.statusCode).toBe(201);
      expect(createRes.body.media_url).toBe(urls[0]);
      expect(createRes.body.media_urls).toEqual(urls);

      await prisma.post.delete({ where: { id: createRes.body.id } }).catch(() => {});
    });

    it('rejects more than 5 media items in a single post', async () => {
      const urls = [1, 2, 3, 4, 5, 6].map(
        n => `https://varsityhub.app/uploads/toomany-${n}-${Date.now()}.jpg`
      );
      const createRes = await request(app)
        .post('/posts')
        .set('Authorization', `Bearer ${testUserToken}`)
        .send({ content: 'Too many media items', media_urls: urls });

      expect(createRes.statusCode).toBe(400);
    });

    it('should reject game-linked event posts when venue coordinates are missing', async () => {
      const game = await prisma.game.create({
        data: {
          title: `No-coords post game ${Date.now()}`,
          date: new Date(Date.now() + 60 * 60 * 1000),
          location: 'Venue name only',
          approval_status: 'approved',
          home_team_id: bypassHomeTeamId,
          away_team_id: bypassAwayTeamId,
        },
      });

      const event = await prisma.event.create({
        data: {
          title: `No-coords post event ${Date.now()}`,
          date: new Date(Date.now() + 60 * 60 * 1000),
          location: 'Venue name only',
          game_id: game.id,
          status: 'approved',
          approval_status: 'approved',
          creator_id: testUser.id,
          creator_role: 'coach',
        },
      });

      try {
        const res = await request(app)
          .post('/posts')
          .set('Authorization', `Bearer ${testUserToken}`)
          .send({
            title: 'No-coords event page post',
            content: 'Posting should fail when the venue lacks coordinates',
            game_id: game.id,
            location: {
              lat: 40.7128,
              lng: -74.006,
              source: 'device',
            },
          });

        expect(res.statusCode).toBe(403);
        expect(res.body.error).toBe('NO_EVENT_LOCATION');
        expect(res.body.message).toMatch(/disabled until the location is configured/i);
      } finally {
        await prisma.event.delete({ where: { id: event.id } }).catch(() => {});
        await prisma.game.delete({ where: { id: game.id } }).catch(() => {});
      }
    });

    it('should let admins bypass geofencing without device-origin location', async () => {
      const res = await request(app)
        .post('/posts')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          title: 'Admin bypass post',
          content: 'Admin bypasses venue geofence',
          game_id: bypassGameId,
          location: {
            source: 'zip',
          },
        });

      expect(res.statusCode).toBe(201);
      expect(res.body.id).toBeDefined();

      await prisma.post.delete({ where: { id: res.body.id } }).catch(() => {});
    });

    it('should reject active team members without device-origin location', async () => {
      const res = await request(app)
        .post('/posts')
        .set('Authorization', `Bearer ${bypassCoachToken}`)
        .send({
          title: 'Team member bypass post',
          content: 'Active team members bypass venue geofence',
          game_id: bypassGameId,
          location: {
            source: 'derived',
          },
        });

      expect(res.statusCode).toBe(403);
      expect(res.body.error).toBe('LOCATION_REQUIRED');
    });
  });

  describe('GET /posts/:id', () => {
    it('should return post by id', async () => {
      if (!testPostId) {
        // Create a post first
        const createRes = await request(app)
          .post('/posts')
          .set('Authorization', `Bearer ${testUserToken}`)
          .send({
            title: 'Test Post for Get',
            content: 'Test content',
          });
        testPostId = createRes.body.id;
      }

      const res = await request(app).get(`/posts/${testPostId}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body.id).toBe(testPostId);
    });

    it('should return 404 for non-existent post', async () => {
      const res = await request(app).get(`/posts/${missingPostId}`);

      expect(res.statusCode).toEqual(404);
    });
  });

  describe('POST /posts/:id/upvote', () => {
    it('should require authentication', async () => {
      if (!testPostId) return;

      const res = await request(app).post(`/posts/${testPostId}/upvote`);

      expect(res.statusCode).toEqual(401);
    });

    it('should upvote a post', async () => {
      if (!testPostId) {
        const createRes = await request(app)
          .post('/posts')
          .set('Authorization', `Bearer ${testUserToken}`)
          .send({
            title: 'Test Post for Upvote',
            content: 'Test content',
          });
        testPostId = createRes.body.id;
      }

      const res = await request(app)
        .post(`/posts/${testPostId}/upvote`)
        .set('Authorization', `Bearer ${testUserToken}`);

      expect([200, 201]).toContain(res.statusCode);
    });
  });
});
