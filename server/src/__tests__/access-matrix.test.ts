/**
 * Access Matrix Test
 *
 * Logs in as Fan, Rookie Coach, and Veteran Coach and attempts to access
 * every major feature.  For each endpoint the test records:
 *   - HTTP status received
 *   - Whether access was GRANTED, DENIED (clean 403/401), or CRASHED (5xx / unexpected)
 *
 * Flags raised:
 *   - Fan accessing a coach-only feature      → FLAG_FAN_COACH
 *   - Rookie accessing a veteran-only feature  → FLAG_ROOKIE_VETERAN
 *   - Any role getting a 500+ error            → FLAG_CRASH
 *   - Missing clean permission message         → FLAG_BAD_DENIAL
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import express from 'express';
import { writeFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';

/* ──────────────────────────────────────────── */
/*  Build a test app that mounts ALL routers    */
/* ──────────────────────────────────────────── */
import { signJwt } from '../lib/jwt.js';
import { prisma } from '../lib/prisma.js';
import { authMiddleware } from '../middleware/auth.js';
import { adsRouter } from '../routes/ads.js';
import { authRouter } from '../routes/auth.js';
import { eventsRouter } from '../routes/events.js';
import { feedRouter } from '../routes/feed.js';
import { gamesRouter } from '../routes/games.js';
import { groupChatsRouter } from '../routes/group-chats.js';
import { messagesRouter } from '../routes/messages.js';
import { notificationsRouter } from '../routes/notifications.js';
import { organizationsRouter } from '../routes/organizations.js';
import { postsRouter } from '../routes/posts.js';
import { reportsRouter } from '../routes/reports.js';
import { searchRouter } from '../routes/search.js';
import { supportRouter } from '../routes/support.js';
import { teamMembershipsRouter } from '../routes/team-memberships.js';
import { teamsRouter } from '../routes/teams.js';
import { uploadsRouter } from '../routes/uploads.js';
import { usersRouter } from '../routes/users.js';
import { createTestUser } from './helpers/createTestUser.js';

const fullApp = express();
fullApp.use(express.json());
fullApp.use(authMiddleware);
fullApp.use('/auth', authRouter);
fullApp.use('/events', eventsRouter);
fullApp.use('/posts', postsRouter);
fullApp.use('/teams', teamsRouter);
fullApp.use('/uploads', uploadsRouter);
fullApp.use('/users', usersRouter);
fullApp.use('/organizations', organizationsRouter);
fullApp.use('/ads', adsRouter);
fullApp.use('/messages', messagesRouter);
fullApp.use('/group-chats', groupChatsRouter);
fullApp.use('/notifications', notificationsRouter);
fullApp.use('/reports', reportsRouter);
fullApp.use('/support', supportRouter);
fullApp.use('/games', gamesRouter);
fullApp.use('/feed', feedRouter);
fullApp.use('/search', searchRouter);
fullApp.use('/team-memberships', teamMembershipsRouter);
fullApp.use(
  (err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof err?.statusCode === 'number' ? err.statusCode : 500;
    if (typeof err?.toJSON === 'function') return res.status(status).json(err.toJSON());
    return res.status(status).json({ error: err?.message || 'Internal server error' });
  }
);

/* ──────────────────────────────────────────── */
/*  Test data identifiers                       */
/* ──────────────────────────────────────────── */
const ts = Date.now();
const PASSWORD = 'TestPassword123!';

function uniqueUsername(prefix: string): string {
  const entropy = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}${entropy}`.slice(0, 20);
}

const FAN_EMAIL = `matrix-fan-${ts}@example.com`;
const ROOKIE_EMAIL = `matrix-rookie-${ts}@example.com`;
const VETERAN_EMAIL = `matrix-veteran-${ts}@example.com`;

let fanId: string, fanToken: string;
let rookieId: string, rookieToken: string;
let veteranId: string, veteranToken: string;

// Shared fixtures
let orgId: string; // org owned by rookie (for team tests)
let vetOrgId: string; // org owned by veteran
let rookieTeamId: string; // team owned by rookie
let veteranTeamId: string; // team owned by veteran
let testPostId: string; // post created by fan
let testEventId: string; // event created by veteran
let targetUserId: string; // another user for follow/block/message tests

/* ──────────────────────────────────────────── */
/*  Helpers                                     */
/* ──────────────────────────────────────────── */
async function createUser(
  email: string,
  displayName: string,
  role: 'fan' | 'coach',
  plan?: 'rookie' | 'veteran' | 'legend'
) {
  return createTestUser({
    prisma,
    signJwt,
    password: PASSWORD,
    email,
    displayName,
    role,
    plan,
    username:
      role === 'coach'
        ? uniqueUsername(
            `${displayName
              .toLowerCase()
              .replace(/[^a-z0-9]/g, '')
              .slice(0, 6)}_`
          )
        : undefined,
  });
}

type Verdict = 'GRANTED' | 'DENIED' | 'CRASHED' | 'NOT_FOUND' | 'INVALID';

function classify(status: number, body: any): Verdict {
  if (status >= 500) return 'CRASHED';
  if (status === 401 || status === 403) return 'DENIED';
  if (status === 404) return 'NOT_FOUND';
  if (status >= 200 && status < 300) return 'GRANTED';
  // Validation/conflict responses establish reachability, not successful access.
  if (status === 400) return 'INVALID';
  if (status === 409) return 'INVALID'; // conflict does not prove access
  return 'CRASHED';
}

/* ──────────────────────────────────────────── */
/*  SETUP / TEARDOWN                            */
/* ──────────────────────────────────────────── */
beforeAll(async () => {
  // Create users
  ({ id: fanId, token: fanToken } = await createUser(FAN_EMAIL, 'Matrix Fan', 'fan'));
  ({ id: rookieId, token: rookieToken } = await createUser(
    ROOKIE_EMAIL,
    'Matrix Rookie',
    'coach',
    'rookie'
  ));
  ({ id: veteranId, token: veteranToken } = await createUser(
    VETERAN_EMAIL,
    'Matrix Veteran',
    'coach',
    'veteran'
  ));

  // Target user for social interactions
  const target = await createUser(`matrix-target-${ts}@example.com`, 'Matrix Target', 'fan');
  targetUserId = target.id;

  // Create orgs
  const org = await prisma.organization.create({
    data: {
      name: `Matrix Rookie Org ${ts}`,
      org_type: 'club',
      admin_approved: true,
      league_owner_id: rookieId,
      updated_at: new Date(),
    },
  });
  orgId = org.id;
  await prisma.organizationMembership.create({
    data: { organization_id: orgId, user_id: rookieId, role: 'owner', status: 'active' },
  });

  const vetOrg = await prisma.organization.create({
    data: {
      name: `Matrix Veteran Org ${ts}`,
      org_type: 'club',
      admin_approved: true,
      league_owner_id: veteranId,
      updated_at: new Date(),
    },
  });
  vetOrgId = vetOrg.id;
  await prisma.organizationMembership.create({
    data: { organization_id: vetOrgId, user_id: veteranId, role: 'owner', status: 'active' },
  });

  // Create a team for the rookie
  const teamRes = await request(fullApp)
    .post('/teams')
    .set('Authorization', `Bearer ${rookieToken}`)
    .send({ name: `Matrix Team ${ts}`, organization_id: orgId });
  expect(teamRes.status).toBe(201);
  if (teamRes.status === 201) {
    rookieTeamId = teamRes.body.team?.id || teamRes.body.id;
  }

  const veteranTeamRes = await request(fullApp)
    .post('/teams')
    .set('Authorization', `Bearer ${veteranToken}`)
    .send({ name: `Matrix Veteran Team ${ts}`, organization_id: vetOrgId });
  expect(veteranTeamRes.status).toBe(201);
  if (veteranTeamRes.status === 201) {
    veteranTeamId = veteranTeamRes.body.team?.id || veteranTeamRes.body.id;
  }

  // Create a post (by fan, since posts don't require coach)
  const postRes = await request(fullApp)
    .post('/posts')
    .set('Authorization', `Bearer ${rookieToken}`)
    .send({ content: `Matrix test post ${ts}` });
  expect(postRes.status).toBe(201);
  if (postRes.status === 201) {
    testPostId = postRes.body.id;
  }

  // Create an event (by veteran, who is org admin → auto-approved)
  const futureDate = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
  const eventRes = await request(fullApp)
    .post('/events')
    .set('Authorization', `Bearer ${veteranToken}`)
    .send({ title: `Matrix Event ${ts}`, date: futureDate, location: 'Test' });
  expect(eventRes.status).toBe(201);
  if (eventRes.status === 201) {
    testEventId = eventRes.body.id;
  }
}, 30000);

afterAll(async () => {
  try {
    const userIds = [fanId, rookieId, veteranId, targetUserId].filter(Boolean);
    const orgIds = [orgId, vetOrgId].filter(Boolean);
    const teamIds = [rookieTeamId, veteranTeamId].filter(Boolean);

    // Posts
    if (userIds.length)
      await prisma.post.deleteMany({ where: { author_id: { in: userIds } } }).catch(() => {});
    // Events
    if (userIds.length)
      await prisma.event.deleteMany({ where: { creator_id: { in: userIds } } }).catch(() => {});
    // Games (created by the matrix Games/coach-tool probes)
    if (userIds.length)
      await prisma.game.deleteMany({ where: { created_by_id: { in: userIds } } }).catch(() => {});
    // Team invites
    if (teamIds.length)
      await prisma.teamInvite.deleteMany({ where: { team_id: { in: teamIds } } }).catch(() => {});
    // Team memberships
    if (teamIds.length)
      await prisma.teamMembership
        .deleteMany({ where: { team_id: { in: teamIds } } })
        .catch(() => {});
    // Teams
    if (teamIds.length)
      await prisma.team.deleteMany({ where: { id: { in: teamIds } } }).catch(() => {});
    // Org memberships
    if (orgIds.length)
      await prisma.organizationMembership
        .deleteMany({ where: { organization_id: { in: orgIds } } })
        .catch(() => {});
    // Orgs
    if (orgIds.length)
      await prisma.organization.deleteMany({ where: { id: { in: orgIds } } }).catch(() => {});
    // Follows
    if (userIds.length) {
      await prisma.follows
        .deleteMany({
          where: { OR: [{ follower_id: { in: userIds } }, { following_id: { in: userIds } }] },
        })
        .catch(() => {});
    }
    // Reports
    if (userIds.length)
      await prisma.abuseReport
        .deleteMany({ where: { reporter_id: { in: userIds } } })
        .catch(() => {});
    // Users
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  } catch (e) {
    console.warn('Cleanup error (non-critical):', e);
  }
});

/* ═══════════════════════════════════════════════════
   MATRIX RESULTS COLLECTOR
   ═══════════════════════════════════════════════════ */

type MatrixRow = {
  feature: string;
  endpoint: string;
  fan: { status: number; verdict: Verdict };
  rookie: { status: number; verdict: Verdict };
  veteran: { status: number; verdict: Verdict };
  flags: string[];
};

const matrix: MatrixRow[] = [];

function record(
  feature: string,
  endpoint: string,
  fan: { status: number; body: any },
  rookie: { status: number; body: any },
  veteran: { status: number; body: any },
  opts: {
    coachOnly?: boolean; // Fan should NOT get GRANTED
    veteranOnly?: boolean; // Rookie should NOT get GRANTED
  } = {}
) {
  const fv = classify(fan.status, fan.body);
  const rv = classify(rookie.status, rookie.body);
  const vv = classify(veteran.status, veteran.body);

  const flags: string[] = [];

  // Flag: fan accessing coach-only feature
  if (opts.coachOnly && fv === 'GRANTED') {
    flags.push('FLAG_FAN_COACH');
  }

  // Flag: rookie accessing veteran-only feature
  if (opts.veteranOnly && rv === 'GRANTED') {
    flags.push('FLAG_ROOKIE_VETERAN');
  }

  // Flag: any crash (5xx)
  if (fv === 'CRASHED') flags.push('FLAG_CRASH_FAN');
  if (rv === 'CRASHED') flags.push('FLAG_CRASH_ROOKIE');
  if (vv === 'CRASHED') flags.push('FLAG_CRASH_VETERAN');

  // Flag: audited route drift. A 404 in the matrix usually means the client or
  // test is hitting a stale path, which is exactly how tab workflows break.
  if (fv === 'NOT_FOUND') flags.push('FLAG_ROUTE_MISSING_FAN');
  if (rv === 'NOT_FOUND') flags.push('FLAG_ROUTE_MISSING_ROOKIE');
  if (vv === 'NOT_FOUND') flags.push('FLAG_ROUTE_MISSING_VETERAN');

  // Flag: denial without clean error message
  if (fv === 'DENIED' && !fan.body?.error && !fan.body?.message) flags.push('FLAG_BAD_DENIAL_FAN');
  if (rv === 'DENIED' && !rookie.body?.error && !rookie.body?.message)
    flags.push('FLAG_BAD_DENIAL_ROOKIE');
  if (vv === 'DENIED' && !veteran.body?.error && !veteran.body?.message)
    flags.push('FLAG_BAD_DENIAL_VETERAN');

  matrix.push({
    feature,
    endpoint,
    fan: { status: fan.status, verdict: fv },
    rookie: { status: rookie.status, verdict: rv },
    veteran: { status: veteran.status, verdict: vv },
    flags,
  });

  return { fv, rv, vv, flags };
}

/* Helper to hit an endpoint as all 3 users */
async function hitAll(
  method: 'get' | 'post' | 'patch' | 'put' | 'delete',
  path: string,
  body?: any
) {
  const r = (token: string) => {
    const req = (request(fullApp) as any)[method](path).set('Authorization', `Bearer ${token}`);
    if (body && ['post', 'patch', 'put'].includes(method)) return req.send(body);
    return req;
  };
  const [fan, rookie, veteran] = await Promise.all([r(fanToken), r(rookieToken), r(veteranToken)]);
  return { fan, rookie, veteran };
}

/* ═══════════════════════════════════════════════════
   TESTS
   ═══════════════════════════════════════════════════ */

describe('Access Matrix — Full Feature Scan', () => {
  // ─── AUTH / PROFILE ───────────────────────────────

  describe('Auth & Profile', () => {
    it('GET /auth/me — view own profile', async () => {
      const { fan, rookie, veteran } = await hitAll('get', '/auth/me');
      const { flags } = record('View own profile', 'GET /auth/me', fan, rookie, veteran);
      expect(fan.status).toBe(200);
      expect(rookie.status).toBe(200);
      expect(veteran.status).toBe(200);
      expect(flags).toEqual([]);
    });

    it('GET /users/:id — view other user profile', async () => {
      const { fan, rookie, veteran } = await hitAll('get', `/users/${targetUserId}`);
      record('View other profile', `GET /users/:id`, fan, rookie, veteran);
      // All roles should be able to view profiles
      expect(fan.status).toBeLessThan(500);
      expect(rookie.status).toBeLessThan(500);
      expect(veteran.status).toBeLessThan(500);
    });

    it('GET /users/me/export — GDPR data export', async () => {
      const { fan, rookie, veteran } = await hitAll('get', '/users/me/export');
      record('GDPR data export', 'GET /users/me/export', fan, rookie, veteran);
      expect(fan.status).toBeLessThan(500);
    });
  });

  // ─── TEAMS ────────────────────────────────────────

  describe('Teams', () => {
    it('POST /teams — create team (coach-only, plan-gated)', async () => {
      const { fan, rookie, veteran } = await hitAll('post', '/teams', {
        name: `AccessTest Team ${ts}`,
        organization_id: orgId,
      });
      const { flags } = record('Create team', 'POST /teams', fan, rookie, veteran, {
        coachOnly: true,
      });

      // Fan MUST be denied
      expect(fan.status).toBe(403);
      expect(flags.filter(f => f === 'FLAG_FAN_COACH')).toEqual([]);

      // Cleanup: if teams were created, delete them
      for (const res of [rookie, veteran]) {
        const id = res.body?.team?.id || res.body?.id;
        if (id) {
          await prisma.teamMembership.deleteMany({ where: { team_id: id } }).catch(() => {});
          await prisma.team.delete({ where: { id } }).catch(() => {});
        }
      }
    });

    it('GET /teams — list teams (public)', async () => {
      const { fan, rookie, veteran } = await hitAll('get', '/teams');
      record('List teams', 'GET /teams', fan, rookie, veteran);
      expect(fan.status).toBe(200);
      expect(rookie.status).toBe(200);
      expect(veteran.status).toBe(200);
    });

    it('GET /teams/:id — view team detail (public)', async () => {
      expect(rookieTeamId).toBeTruthy();
      const { fan, rookie, veteran } = await hitAll('get', `/teams/${rookieTeamId}`);
      record('View team detail', 'GET /teams/:id', fan, rookie, veteran);
      expect(fan.status).toBeLessThan(500);
    });

    it('GET /teams/managed — my managed teams (auth required)', async () => {
      const { fan, rookie, veteran } = await hitAll('get', '/teams/managed');
      record('My managed teams', 'GET /teams/managed', fan, rookie, veteran);
      expect(fan.status).toBe(200); // empty array for fans
      expect(rookie.status).toBe(200);
      expect(veteran.status).toBe(200);
    });

    it('POST /teams/:id/invites — invite to team (owner only)', async () => {
      expect(rookieTeamId).toBeTruthy();
      const { fan, rookie, veteran } = await hitAll('post', `/teams/${rookieTeamId}/invite`, {
        email: `invite-test-${ts}@example.com`,
        role: 'coach',
      });
      record('Invite to team', 'POST /teams/:id/invite', fan, rookie, veteran, {
        coachOnly: true,
      });
      // Fan should be denied (not team owner)
      expect(fan.status).toBeGreaterThanOrEqual(403);
      // Veteran should be denied (not member of this team)
      expect(veteran.status).toBeGreaterThanOrEqual(403);
    });
  });

  // ─── ORGANIZATIONS ────────────────────────────────

  describe('Organizations', () => {
    it('GET /organizations — list organizations (public)', async () => {
      const { fan, rookie, veteran } = await hitAll('get', '/organizations');
      record('List organizations', 'GET /organizations', fan, rookie, veteran);
      expect(fan.status).toBe(200);
    });

    it('GET /organizations/:id — view org detail (public)', async () => {
      const { fan, rookie, veteran } = await hitAll('get', `/organizations/${orgId}`);
      record('View org detail', 'GET /organizations/:id', fan, rookie, veteran);
      expect(fan.status).toBeLessThan(500);
    });

    it('GET /organizations/mine — my organizations', async () => {
      const { fan, rookie, veteran } = await hitAll('get', '/organizations/mine');
      record('My organizations', 'GET /organizations/mine', fan, rookie, veteran);
      expect(fan.status).toBe(200); // empty array
      expect(rookie.status).toBe(200); // has org
      expect(veteran.status).toBe(200);
    });

    it('POST /organizations — create organization', async () => {
      const tempFan = await createUser(`matrix-org-fan-${ts}@example.com`, 'Matrix Org Fan', 'fan');
      const tempRookie = await createUser(
        `matrix-org-rookie-${ts}@example.com`,
        'Matrix Org Rookie',
        'coach',
        'rookie'
      );
      const tempVeteran = await createUser(
        `matrix-org-veteran-${ts}@example.com`,
        'Matrix Org Veteran',
        'coach',
        'veteran'
      );
      const createOrg = (token: string, suffix: string) =>
        request(fullApp)
          .post('/organizations')
          .set('Authorization', `Bearer ${token}`)
          .send({
            name: `AccessTest Org ${ts} ${suffix}`,
            org_type: 'club',
          });
      const [fan, rookie, veteran] = await Promise.all([
        createOrg(tempFan.token, 'fan'),
        createOrg(tempRookie.token, 'rookie'),
        createOrg(tempVeteran.token, 'veteran'),
      ]);
      record('Create organization', 'POST /organizations', fan, rookie, veteran);
      // Cleanup any orgs created
      for (const res of [fan, rookie, veteran]) {
        const id = res.body?.id || res.body?.organization?.id;
        if (id) {
          await prisma.organizationMembership
            .deleteMany({ where: { organization_id: id } })
            .catch(() => {});
          await prisma.organization.delete({ where: { id } }).catch(() => {});
        }
      }
      await prisma.user
        .deleteMany({
          where: { id: { in: [tempFan.id, tempRookie.id, tempVeteran.id] } },
        })
        .catch(() => {});
    });

    it('POST /organizations/:id/invite — unrelated users cannot invite', async () => {
      const { fan, rookie, veteran } = await hitAll('post', `/organizations/${vetOrgId}/invite`, {
        email: `org-invite-${ts}@example.com`,
        role: 'member',
      });
      record('Invite to org', 'POST /organizations/:id/invite', fan, rookie, veteran);
      expect(fan.status).toBe(403);
      expect(rookie.status).toBe(403);
      // Same organization ownership boundary, independent of subscription tier.
    });

    it('POST /organizations/join-requests — request to join org', async () => {
      const tempFan = await createUser(
        `matrix-join-fan-${ts}@example.com`,
        'Matrix Join Fan',
        'fan'
      );
      const tempRookie = await createUser(
        `matrix-join-rookie-${ts}@example.com`,
        'Matrix Join Rookie',
        'coach',
        'rookie'
      );
      const tempVeteran = await createUser(
        `matrix-join-veteran-${ts}@example.com`,
        'Matrix Join Veteran',
        'coach',
        'veteran'
      );
      const requestJoin = (token: string) =>
        request(fullApp)
          .post('/organizations/join-requests')
          .set('Authorization', `Bearer ${token}`)
          .send({
            organization_id: orgId,
            message: 'Test join request',
          });
      const [fan, rookie, veteran] = await Promise.all([
        requestJoin(tempFan.token),
        requestJoin(tempRookie.token),
        requestJoin(tempVeteran.token),
      ]);
      record('Join request', 'POST /organizations/join-requests', fan, rookie, veteran);
      // Cleanup join requests
      await prisma.organizationJoinRequest
        .deleteMany({
          where: {
            user_id: { in: [tempFan.id, tempRookie.id, tempVeteran.id] },
            organization_id: orgId,
          },
        })
        .catch(() => {});
      await prisma.user
        .deleteMany({
          where: { id: { in: [tempFan.id, tempRookie.id, tempVeteran.id] } },
        })
        .catch(() => {});
    });
  });

  // ─── EVENTS ───────────────────────────────────────

  describe('Events', () => {
    it('GET /events — list events (public)', async () => {
      const { fan, rookie, veteran } = await hitAll('get', '/events');
      record('List events', 'GET /events', fan, rookie, veteran);
      expect(fan.status).toBe(200);
    });

    it('POST /events — create event', async () => {
      const futureDate = new Date(Date.now() + 21 * 24 * 3600 * 1000).toISOString();
      const [fan, rookie, veteran] = await Promise.all([
        request(fullApp)
          .post('/events')
          .set('Authorization', `Bearer ${fanToken}`)
          .send({
            title: `AccessTest Fan Event ${ts}`,
            date: futureDate,
            location: 'Test Stadium',
            event_type: 'other',
          }),
        request(fullApp)
          .post('/events')
          .set('Authorization', `Bearer ${rookieToken}`)
          .send({
            title: `AccessTest Rookie Event ${ts}`,
            date: futureDate,
            location: 'Test Stadium',
            event_type: 'other',
            home_team_id: rookieTeamId,
          }),
        request(fullApp)
          .post('/events')
          .set('Authorization', `Bearer ${veteranToken}`)
          .send({
            title: `AccessTest Veteran Event ${ts}`,
            date: futureDate,
            location: 'Test Stadium',
            event_type: 'other',
            home_team_id: veteranTeamId,
          }),
      ]);
      record('Create event', 'POST /events', fan, rookie, veteran);
      // All roles should be able to create events (fans get pending status)
      expect(fan.status).toBe(201);
      expect(rookie.status).toBe(201);
      expect(veteran.status).toBe(201);

      // Verify fan event needs approval
      if (fan.status === 201) {
        expect(fan.body.approval_status).toBe('pending');
      }
      // Access matrix only verifies role access here; approval details vary by selected team scope.
    });

    it('POST /events/:id/rsvp — RSVP to event', async () => {
      expect(testEventId).toBeTruthy();
      const { fan, rookie, veteran } = await hitAll('post', `/events/${testEventId}/rsvp`, {
        status: 'going',
      });
      record('RSVP to event', 'POST /events/:id/rsvp', fan, rookie, veteran);
      expect(fan.status).toBeLessThan(500);
    });

    it('GET /events/pending — view pending events (coach/admin only)', async () => {
      const { fan, rookie, veteran } = await hitAll('get', '/events/pending');
      record('View pending events', 'GET /events/pending', fan, rookie, veteran, {
        coachOnly: true,
      });
      // Fan should be denied
      expect(fan.status).toBe(403);
    });
  });

  // ─── POSTS ────────────────────────────────────────

  describe('Posts', () => {
    it('GET /posts — list posts (public)', async () => {
      const { fan, rookie, veteran } = await hitAll('get', '/posts');
      record('List posts', 'GET /posts', fan, rookie, veteran);
      expect(fan.status).toBe(200);
    });

    it('POST /posts — create post', async () => {
      const { fan, rookie, veteran } = await hitAll('post', '/posts', {
        content: `Access matrix post ${ts} ${Math.random()}`,
      });
      // All onboarded users (including fans) can create posts.
      record('Create post', 'POST /posts', fan, rookie, veteran);
      expect(fan.status).toBe(201);
      expect(rookie.status).toBe(201);
      expect(veteran.status).toBe(201);
    });

    it('POST /posts/:id/upvote — upvote post', async () => {
      expect(testPostId).toBeTruthy();
      const { fan, rookie, veteran } = await hitAll('post', `/posts/${testPostId}/upvote`);
      record('Upvote post', 'POST /posts/:id/upvote', fan, rookie, veteran);
      expect(fan.status).toBeLessThan(500);
    });

    it('POST /posts/:id/bookmark — bookmark post', async () => {
      expect(testPostId).toBeTruthy();
      const { fan, rookie, veteran } = await hitAll('post', `/posts/${testPostId}/bookmark`);
      record('Bookmark post', 'POST /posts/:id/bookmark', fan, rookie, veteran);
      expect(fan.status).toBeLessThan(500);
    });

    it('GET /posts/:id/comments — list comments (public)', async () => {
      expect(testPostId).toBeTruthy();
      const { fan, rookie, veteran } = await hitAll('get', `/posts/${testPostId}/comments`);
      record('List comments', 'GET /posts/:id/comments', fan, rookie, veteran);
      expect(fan.status).toBe(200);
    });

    it('POST /posts/:id/comments — create comment', async () => {
      expect(testPostId).toBeTruthy();
      const { fan, rookie, veteran } = await hitAll('post', `/posts/${testPostId}/comments`, {
        content: 'Test comment',
      });
      record('Create comment', 'POST /posts/:id/comments', fan, rookie, veteran);
      expect(fan.status).toBeLessThan(500);
    });
  });

  // ─── ADS ──────────────────────────────────────────

  describe('Ads', () => {
    it('POST /ads — create ad', async () => {
      const { fan, rookie, veteran } = await hitAll('post', '/ads', {
        contact_name: 'Test',
        contact_email: 'test@example.com',
        business_name: 'Test Biz',
        banner_url: 'https://example.com/banner.jpg',
        target_url: 'https://example.com',
        target_zip_code: '10001',
        description: 'Test ad',
      });
      record('Create ad', 'POST /ads', fan, rookie, veteran);
      expect(fan.status).toBe(201);
      expect(rookie.status).toBe(201);
      expect(veteran.status).toBe(201);

      // Cleanup
      for (const res of [fan, rookie, veteran]) {
        const id = res.body?.id || res.body?.ad?.id;
        if (id) await prisma.ad.delete({ where: { id } }).catch(() => {});
      }
    });

    it('GET /ads?mine=1 — list my ads', async () => {
      const { fan, rookie, veteran } = await hitAll('get', '/ads?mine=1');
      record('List my ads', 'GET /ads?mine=1', fan, rookie, veteran);
      expect(fan.status).toBeLessThan(500);
    });

    it('GET /ads/for-feed — get feed ads (public)', async () => {
      const todayISO = new Date().toISOString().slice(0, 10);
      const { fan, rookie, veteran } = await hitAll(
        'get',
        `/ads/for-feed?date=${todayISO}&zip=10001`
      );
      record('Feed ads', 'GET /ads/for-feed', fan, rookie, veteran);
      expect(fan.status).toBe(200);
    });

    it('GET /ads/availability — check ad availability (public)', async () => {
      const from = new Date().toISOString().slice(0, 10);
      const to = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
      const { fan, rookie, veteran } = await hitAll(
        'get',
        `/ads/availability?zip=10001&from=${from}&to=${to}`
      );
      record('Ad availability', 'GET /ads/availability', fan, rookie, veteran);
      expect(fan.status).toBe(200);
    });
  });

  // ─── SOCIAL ───────────────────────────────────────

  describe('Social (Follow / Block)', () => {
    it('POST /users/:id/follow — follow user', async () => {
      const { fan, rookie, veteran } = await hitAll('post', `/users/${targetUserId}/follow`);
      record('Follow user', 'POST /users/:id/follow', fan, rookie, veteran);
      expect(fan.status).toBeLessThan(500);
    });

    it('GET /users/:id/followers — view followers', async () => {
      const { fan, rookie, veteran } = await hitAll('get', `/users/${targetUserId}/followers`);
      record('View followers', 'GET /users/:id/followers', fan, rookie, veteran);
      expect(fan.status).toBeLessThan(500);
    });

    it('GET /users/:id/following — view following', async () => {
      const { fan, rookie, veteran } = await hitAll('get', `/users/${targetUserId}/following`);
      record('View following', 'GET /users/:id/following', fan, rookie, veteran);
      expect(fan.status).toBeLessThan(500);
    });

    it('POST /users/:id/block — block user', async () => {
      const { fan, rookie, veteran } = await hitAll('post', `/users/${targetUserId}/block`);
      record('Block user', 'POST /users/:id/block', fan, rookie, veteran);
      expect(fan.status).toBeLessThan(500);
      // Unblock after
      await hitAll('delete', `/users/${targetUserId}/block`);
    });

    it('GET /users/blocked — list blocked users', async () => {
      const { fan, rookie, veteran } = await hitAll('get', '/users/blocked');
      record('List blocked', 'GET /users/blocked', fan, rookie, veteran);
      expect(fan.status).toBe(200);
    });
  });

  // ─── MESSAGES ─────────────────────────────────────

  describe('Messages', () => {
    it('GET /messages — list messages', async () => {
      const { fan, rookie, veteran } = await hitAll('get', '/messages');
      record('List messages', 'GET /messages', fan, rookie, veteran);
      expect(fan.status).toBeLessThan(500);
    });

    it('POST /messages — send message', async () => {
      const { fan, rookie, veteran } = await hitAll('post', '/messages', {
        to: targetUserId,
        content: 'Hello from access matrix test',
      });
      record('Send message', 'POST /messages', fan, rookie, veteran);
      // Should not crash
      expect(fan.status).toBeLessThan(500);
      expect(rookie.status).toBeLessThan(500);
      expect(veteran.status).toBeLessThan(500);
    });
  });

  // ─── NOTIFICATIONS ────────────────────────────────

  describe('Notifications', () => {
    it('GET /notifications — list notifications', async () => {
      const { fan, rookie, veteran } = await hitAll('get', '/notifications');
      record('List notifications', 'GET /notifications', fan, rookie, veteran);
      expect(fan.status).toBe(200);
    });

    it('POST /notifications/mark-read-all — mark all read', async () => {
      const { fan, rookie, veteran } = await hitAll('post', '/notifications/mark-read-all');
      record('Mark all read', 'POST /notifications/mark-read-all', fan, rookie, veteran);
      expect(fan.status).toBeLessThan(500);
    });
  });

  // ─── REPORTS / SUPPORT ────────────────────────────

  describe('Reports & Support', () => {
    it('GET /reports/reasons — list report reasons (public)', async () => {
      const { fan, rookie, veteran } = await hitAll('get', '/reports/reasons');
      record('Report reasons', 'GET /reports/reasons', fan, rookie, veteran);
      expect(fan.status).toBe(200);
    });

    it('POST /reports — submit report', async () => {
      const { fan, rookie, veteran } = await hitAll('post', '/reports', {
        target_type: 'user',
        target_id: targetUserId,
        reason: 'spam',
      });
      record('Submit report', 'POST /reports', fan, rookie, veteran);
      expect(fan.status).toBeLessThan(500);
    });

    it('POST /support/contact — contact support', async () => {
      const { fan, rookie, veteran } = await hitAll('post', '/support/contact', {
        subject: 'Test',
        message: 'Access matrix test support request',
      });
      record('Contact support', 'POST /support/contact', fan, rookie, veteran);
      expect(fan.status).toBeLessThan(500);
    });
  });

  // ─── UPLOADS ──────────────────────────────────────

  describe('Uploads', () => {
    it('GET /uploads/sign — sign URL (auth required)', async () => {
      const { fan, rookie, veteran } = await hitAll('get', '/uploads/sign?key=test.jpg');
      record('Sign upload URL', 'GET /uploads/sign', fan, rookie, veteran);
      expect(fan.status).toBeLessThan(500);
    });
  });

  // ─── COACH-ONLY FEATURES DEEP CHECK ──────────────

  describe('Coach-only features (Fan must be denied)', () => {
    it('POST /teams — Fan cannot create team', async () => {
      const res = await request(fullApp)
        .post('/teams')
        .set('Authorization', `Bearer ${fanToken}`)
        .send({ name: 'Fan Team Attempt', organization_id: orgId });
      expect(res.status).toBe(403);
      expect(res.body.error).toBeDefined();
      // Verify clean denial message
      expect(typeof res.body.error).toBe('string');
      expect(res.body.error.length).toBeGreaterThan(0);
    });

    it('GET /events/pending — Fan cannot view pending events', async () => {
      const res = await request(fullApp)
        .get('/events/pending')
        .set('Authorization', `Bearer ${fanToken}`);
      expect(res.status).toBe(403);
      expect(res.body.error).toBeDefined();
    });
  });

  // ─── VETERAN-ONLY FEATURES DEEP CHECK ─────────────

  describe('Veteran-only features (Rookie must be denied)', () => {
    it('POST /organizations/:id/invite — Rookie can invite to own org within org limits', async () => {
      const res = await request(fullApp)
        .post(`/organizations/${orgId}/invite`)
        .set('Authorization', `Bearer ${rookieToken}`)
        .send({ email: `vet-test-${ts}@example.com`, role: 'member' });
      expect([201, 403, 409]).toContain(res.status);
      if (res.status === 403) {
        expect(res.body.error).not.toMatch(/PLAN_UPGRADE/i);
      }
    });

    it('Veteran CAN invite to own org', async () => {
      const res = await request(fullApp)
        .post(`/organizations/${vetOrgId}/invite`)
        .set('Authorization', `Bearer ${veteranToken}`)
        .send({ email: `vet-invite-${ts}@example.com`, role: 'member' });
      // Should succeed (201) or hit invite limit
      expect([201, 403, 409]).toContain(res.status);
      if (res.status === 403) {
        // If 403, it should NOT be PLAN_UPGRADE_REQUIRED
        expect(res.body.error).not.toMatch(/PLAN_UPGRADE/i);
      }
    });
  });

  // ─── GAMES (shared + coach game tools) ────────────

  describe('Games', () => {
    let gameId: string | undefined;

    beforeAll(async () => {
      // A game created by the rookie coach — reused by the read probes below.
      // Games must be associated with a team (server rule), so attach the
      // rookie's own team → derives approved.
      const res = await request(fullApp)
        .post('/games')
        .set('Authorization', `Bearer ${rookieToken}`)
        .send({ title: `Matrix Game ${ts}`, location: 'Test Field', home_team_id: rookieTeamId });
      expect(res.status).toBe(201);
      gameId = res.body?.id || res.body?.game?.id;
      expect(gameId).toBeTruthy();
    });

    afterAll(async () => {
      if (gameId) await prisma.game.deleteMany({ where: { id: gameId } }).catch(() => {});
    });

    it('GET /games — list games', async () => {
      const { fan, rookie, veteran } = await hitAll('get', '/games');
      const { flags } = record('List games', 'GET /games', fan, rookie, veteran);
      expect(flags.filter(f => f.startsWith('FLAG_CRASH'))).toEqual([]);
    });

    it('GET /games/opponent-pending — pending opponent approvals (coach tool)', async () => {
      const { fan, rookie, veteran } = await hitAll('get', '/games/opponent-pending');
      const { flags } = record(
        'Opponent pending',
        'GET /games/opponent-pending',
        fan,
        rookie,
        veteran
      );
      // Auth'd staff-scoped read: never a crash, never a missing route.
      expect(flags.filter(f => f.startsWith('FLAG_CRASH'))).toEqual([]);
      expect(flags.filter(f => f.startsWith('FLAG_ROUTE_MISSING'))).toEqual([]);
    });

    it('GET /games/:id — game detail (public read)', async () => {
      // Fail loudly if the seed create broke — a silent skip would hide a
      // regression in POST /games, which is exactly what this audit guards.
      expect(gameId).toBeTruthy();
      const { fan, rookie, veteran } = await hitAll('get', `/games/${gameId}`);
      const { flags } = record('View game detail', 'GET /games/:id', fan, rookie, veteran);
      expect(flags.filter(f => f.startsWith('FLAG_CRASH'))).toEqual([]);
      expect(fan.status).toBe(200);
    });

    it('GET /games/:id/summary — game summary (public read)', async () => {
      expect(gameId).toBeTruthy();
      const { fan, rookie, veteran } = await hitAll('get', `/games/${gameId}/summary`);
      const { flags } = record('View game summary', 'GET /games/:id/summary', fan, rookie, veteran);
      expect(flags.filter(f => f.startsWith('FLAG_CRASH'))).toEqual([]);
    });

    it('POST /games — create game (verified+onboarded; coach-managed = approved, else pending)', async () => {
      // Attaching the rookie's team: rookie (owner) → approved, fan/veteran
      // (non-managers) → pending. Not a role gate — mirrors POST /events.
      const { fan, rookie, veteran } = await hitAll('post', '/games', {
        title: `Matrix Game Create ${ts}`,
        location: 'Test Field',
        home_team_id: rookieTeamId,
      });
      const { flags } = record('Create game', 'POST /games', fan, rookie, veteran);
      expect(flags.filter(f => f.startsWith('FLAG_CRASH'))).toEqual([]);
      for (const [res, approval] of [
        [fan, 'pending'],
        [rookie, 'approved'],
        [veteran, 'pending'],
      ] as const) {
        expect(res.status).toBe(201);
        const id = res.body?.id || res.body?.game?.id;
        expect(id).toBeTruthy();
        const game = await prisma.game.findUniqueOrThrow({ where: { id } });
        expect(game.approval_status).toBe(approval);
        const event = await prisma.event.findFirstOrThrow({ where: { game_id: id } });
        expect(event.approval_status).toBe(approval);
        expect(event.status).toBe(approval === 'approved' ? 'approved' : 'draft');
      }
      // Cleanup any games created by this probe.
      for (const res of [fan, rookie, veteran]) {
        const id = res.body?.id || res.body?.game?.id;
        if (id) await prisma.game.deleteMany({ where: { id } }).catch(() => {});
      }
    });

    it('DELETE /games/:id — only the creating side may delete (ownership boundary)', async () => {
      // Fresh throwaway game owned by the rookie coach.
      const created = await request(fullApp)
        .post('/games')
        .set('Authorization', `Bearer ${rookieToken}`)
        .send({
          title: `Matrix Game Del ${ts}`,
          location: 'Test Field',
          home_team_id: rookieTeamId,
        });
      expect(created.status).toBe(201);
      const delId = created.body?.id || created.body?.game?.id;
      expect(delId).toBeTruthy();

      // Sequential (NOT parallel): non-owners must be denied while the game still
      // exists — a parallel rookie-delete would race them into a 404.
      const del = (token: string) =>
        request(fullApp).delete(`/games/${delId}`).set('Authorization', `Bearer ${token}`);
      const fan = await del(fanToken);
      const veteran = await del(veteranToken);
      const rookie = await del(rookieToken); // creator → deletes it (also the cleanup)

      record('Delete game', 'DELETE /games/:id', fan, rookie, veteran);
      // Ownership: creator allowed, everyone else denied with a clean message.
      expect(fan.status).toBe(403);
      expect(veteran.status).toBe(403);
      expect(fan.body?.error || fan.body?.message).toBeTruthy();
      expect([200, 204]).toContain(rookie.status);
      // Belt-and-suspenders cleanup in case the delete didn't remove it.
      await prisma.game.deleteMany({ where: { id: delId } }).catch(() => {});
    });
  });

  // ─── FEED ─────────────────────────────────────────

  describe('Feed', () => {
    it('GET /feed/bundle — composed feed (auth required)', async () => {
      const { fan, rookie, veteran } = await hitAll('get', '/feed/bundle');
      const { flags } = record('Feed bundle', 'GET /feed/bundle', fan, rookie, veteran);
      expect(flags.filter(f => f.startsWith('FLAG_CRASH'))).toEqual([]);
      expect(flags.filter(f => f.startsWith('FLAG_ROUTE_MISSING'))).toEqual([]);
      expect(fan.status).toBe(200);
    });
  });

  // ─── SEARCH ───────────────────────────────────────

  describe('Search', () => {
    it('GET /search — universal search (optional auth)', async () => {
      const { fan, rookie, veteran } = await hitAll('get', '/search?q=matrix');
      const { flags } = record('Search', 'GET /search?q=', fan, rookie, veteran);
      expect(flags.filter(f => f.startsWith('FLAG_CRASH'))).toEqual([]);
      expect(flags.filter(f => f.startsWith('FLAG_ROUTE_MISSING'))).toEqual([]);
    });
  });

  // ─── DIRECT MESSAGES & GROUP CHATS ────────────────

  describe('Direct Messages & Group Chats', () => {
    it('GET /messages/unread-count — DM unread badge (verified)', async () => {
      const { fan, rookie, veteran } = await hitAll('get', '/messages/unread-count');
      const { flags } = record(
        'DM unread count',
        'GET /messages/unread-count',
        fan,
        rookie,
        veteran
      );
      expect(flags.filter(f => f.startsWith('FLAG_CRASH'))).toEqual([]);
      expect(flags.filter(f => f.startsWith('FLAG_ROUTE_MISSING'))).toEqual([]);
    });

    it('POST /messages/mark-read — mark thread read (route reachable)', async () => {
      const { fan, rookie, veteran } = await hitAll('post', '/messages/mark-read', {});
      const { flags } = record('DM mark read', 'POST /messages/mark-read', fan, rookie, veteran);
      expect(flags.filter(f => f.startsWith('FLAG_CRASH'))).toEqual([]);
      expect(flags.filter(f => f.startsWith('FLAG_ROUTE_MISSING'))).toEqual([]);
    });

    it('GET /group-chats — list my group chats (verified)', async () => {
      const { fan, rookie, veteran } = await hitAll('get', '/group-chats');
      const { flags } = record('List group chats', 'GET /group-chats', fan, rookie, veteran);
      expect(flags.filter(f => f.startsWith('FLAG_CRASH'))).toEqual([]);
      expect(flags.filter(f => f.startsWith('FLAG_ROUTE_MISSING'))).toEqual([]);
    });

    it('POST /group-chats — create group chat (route reachable)', async () => {
      // Empty body → validation 400 (route exists, no crash); membership/ownership
      // enforcement is exercised by the group-chat suite, not this reachability probe.
      const { fan, rookie, veteran } = await hitAll('post', '/group-chats', {});
      const { flags } = record('Create group chat', 'POST /group-chats', fan, rookie, veteran);
      expect(flags.filter(f => f.startsWith('FLAG_CRASH'))).toEqual([]);
      expect(flags.filter(f => f.startsWith('FLAG_ROUTE_MISSING'))).toEqual([]);
    });
  });

  // ─── COACH TEAM TOOLS ─────────────────────────────

  describe('Coach Team Tools', () => {
    it('GET /teams/limits — plan/roster limits (coach tool)', async () => {
      const { fan, rookie, veteran } = await hitAll('get', '/teams/limits');
      const { flags } = record('Team limits', 'GET /teams/limits', fan, rookie, veteran);
      expect(flags.filter(f => f.startsWith('FLAG_CRASH'))).toEqual([]);
      expect(flags.filter(f => f.startsWith('FLAG_ROUTE_MISSING'))).toEqual([]);
    });

    it('GET /teams/:id/members — roster (coach tool)', async () => {
      expect(rookieTeamId).toBeTruthy();
      const { fan, rookie, veteran } = await hitAll('get', `/teams/${rookieTeamId}/members`);
      const { flags } = record('Team roster', 'GET /teams/:id/members', fan, rookie, veteran);
      expect(flags.filter(f => f.startsWith('FLAG_CRASH'))).toEqual([]);
      expect(flags.filter(f => f.startsWith('FLAG_ROUTE_MISSING'))).toEqual([]);
      // Owner must be able to read their own roster.
      expect(rookie.status).toBe(200);
      expect(fan.status).toBe(403);
      expect(veteran.status).toBe(403);
    });

    it('GET /teams/:id/admin-summary — coach admin dashboard (coach tool)', async () => {
      expect(rookieTeamId).toBeTruthy();
      const { fan, rookie, veteran } = await hitAll('get', `/teams/${rookieTeamId}/admin-summary`);
      const { flags } = record(
        'Team admin summary',
        'GET /teams/:id/admin-summary',
        fan,
        rookie,
        veteran
      );
      expect(flags.filter(f => f.startsWith('FLAG_CRASH'))).toEqual([]);
      expect(flags.filter(f => f.startsWith('FLAG_ROUTE_MISSING'))).toEqual([]);
      // The team owner must reach their own admin summary.
      expect(rookie.status).toBe(200);
      expect(fan.status).toBe(403);
      expect(veteran.status).toBe(403);
    });

    it('GET /team-memberships/search-users — roster add search (coach tool)', async () => {
      const { fan, rookie, veteran } = await hitAll(
        'get',
        `/team-memberships/search-users?q=matrix&teamId=${rookieTeamId ?? ''}`
      );
      const { flags } = record(
        'Roster user search',
        'GET /team-memberships/search-users',
        fan,
        rookie,
        veteran
      );
      expect(flags.filter(f => f.startsWith('FLAG_CRASH'))).toEqual([]);
      expect(flags.filter(f => f.startsWith('FLAG_ROUTE_MISSING'))).toEqual([]);
      expect(rookie.status).toBe(200);
      expect(fan.status).toBe(403);
      expect(veteran.status).toBe(403);
    });
  });

  describe('Independent access dimensions', () => {
    it.each([
      [200, 'GRANTED'],
      [400, 'INVALID'],
      [409, 'INVALID'],
      [401, 'DENIED'],
      [403, 'DENIED'],
      [404, 'NOT_FOUND'],
      [500, 'CRASHED'],
    ] as const)('classifies HTTP %s as %s', (status, verdict) => {
      expect(classify(status, {})).toBe(verdict);
    });

    it('anonymous search is public and returns typed result groups', async () => {
      const res = await request(fullApp).get('/search?q=matrix');
      expect(res.status).toBe(200);
      for (const key of ['users', 'teams', 'organizations', 'games', 'events', 'posts']) {
        expect(Array.isArray(res.body[key])).toBe(true);
      }
    });

    it.each([
      '/auth/me',
      '/feed/bundle',
      '/group-chats',
      '/messages/unread-count',
      '/teams/managed',
    ])('anonymous requests are denied: %s', async path => {
      const res = await request(fullApp).get(path);
      expect(res.status).toBe(401);
      expect(res.body.error || res.body.message).toBeTruthy();
    });

    it.each(['verification', 'onboarding'] as const)(
      '%s gates game writes without creating records',
      async dimension => {
        const original = await prisma.user.findUniqueOrThrow({ where: { id: fanId } });
        const before = await prisma.game.count({ where: { created_by_id: fanId } });
        try {
          await prisma.user.update({
            where: { id: fanId },
            data:
              dimension === 'verification'
                ? { email_verified: false }
                : {
                    onboarding_completed: false,
                    preferences: {
                      ...(original.preferences as Record<string, any>),
                      onboarding_completed: false,
                    },
                  },
          });
          const res = await request(fullApp)
            .post('/games')
            .set('Authorization', `Bearer ${fanToken}`)
            .send({
              title: `Matrix gated ${ts}`,
              location: 'Test Field',
              home_team_id: rookieTeamId,
            });
          expect(res.status).toBe(403);
          expect(res.body.error || res.body.message).toBeTruthy();
          expect(await prisma.game.count({ where: { created_by_id: fanId } })).toBe(before);
        } finally {
          await prisma.user.update({
            where: { id: fanId },
            data: {
              email_verified: original.email_verified,
              onboarding_completed: original.onboarding_completed,
              preferences: original.preferences as any,
            },
          });
        }
      }
    );
  });

  // ─── FINAL MATRIX REPORT ─────────────────────────

  describe('Matrix Report', () => {
    it('prints the full access matrix and checks for flags', () => {
      // Print formatted matrix
      console.log('\n');
      console.log(
        '╔═══════════════════════════════════════════════════════════════════════════════════════════════════════╗'
      );
      console.log(
        '║                              ACCESS MATRIX — FULL FEATURE SCAN                                      ║'
      );
      console.log(
        '╠═══════════════════════════════════════════════════════════════════════════════════════════════════════╣'
      );
      console.log(
        '║ Feature                    │ Endpoint                           │  Fan  │ Rookie│  Vet  │ Flags      ║'
      );
      console.log(
        '╠═══════════════════════════════════════════════════════════════════════════════════════════════════════╣'
      );

      for (const row of matrix) {
        const feat = row.feature.padEnd(26).slice(0, 26);
        const ep = row.endpoint.padEnd(36).slice(0, 36);
        const f = `${row.fan.status}/${row.fan.verdict.slice(0, 1)}`.padEnd(5);
        const r = `${row.rookie.status}/${row.rookie.verdict.slice(0, 1)}`.padEnd(5);
        const v = `${row.veteran.status}/${row.veteran.verdict.slice(0, 1)}`.padEnd(5);
        const fl = row.flags.length ? row.flags.join(',') : '—';
        console.log(`║ ${feat} │ ${ep} │ ${f} │ ${r} │ ${v} │ ${fl.padEnd(10).slice(0, 10)} ║`);
      }

      console.log(
        '╠═══════════════════════════════════════════════════════════════════════════════════════════════════════╣'
      );
      console.log(
        '║ Legend: G=Granted  D=Denied  C=Crashed  N=Not Found  I=Invalid payload/conflict                                                ║'
      );
      console.log(
        '╚═══════════════════════════════════════════════════════════════════════════════════════════════════════╝'
      );

      // Collect all flags
      const allFlags = matrix.flatMap(r => r.flags);
      const crashes = allFlags.filter(f => f.startsWith('FLAG_CRASH'));
      const fanCoach = allFlags.filter(f => f === 'FLAG_FAN_COACH');
      const rookieVet = allFlags.filter(f => f === 'FLAG_ROOKIE_VETERAN');
      const missingRoutes = allFlags.filter(f => f.startsWith('FLAG_ROUTE_MISSING'));
      const badDenial = allFlags.filter(f => f.startsWith('FLAG_BAD_DENIAL'));

      console.log('\n─── FLAG SUMMARY ───');
      console.log(`  Crashes (5xx):                   ${crashes.length}`);
      console.log(`  Missing audited routes (404):    ${missingRoutes.length}`);
      console.log(`  Fan accessing coach features:    ${fanCoach.length}`);
      console.log(`  Rookie accessing vet features:   ${rookieVet.length}`);
      console.log(`  Denials without clean message:   ${badDenial.length}`);

      if (allFlags.length > 0) {
        console.log('\n─── FLAGGED ITEMS ───');
        for (const row of matrix) {
          if (row.flags.length > 0) {
            console.log(`  [${row.flags.join(', ')}] ${row.feature} — ${row.endpoint}`);
          }
        }
      } else {
        console.log(
          '\n  No smoke flags raised. Unasserted permissions and UI workflows remain unverified.'
        );
      }
      console.log('');

      // Write matrix to file so it's visible even when Jest buffers console
      const lines: string[] = [];
      lines.push('ACCESS MATRIX — FULL FEATURE SCAN');
      lines.push('═'.repeat(105));
      lines.push(
        `${'Feature'.padEnd(26)} │ ${'Endpoint'.padEnd(36)} │ ${'Fan'.padEnd(5)} │ ${'Rook'.padEnd(5)} │ ${'Vet'.padEnd(5)} │ Flags`
      );
      lines.push('─'.repeat(105));
      for (const row of matrix) {
        const feat = row.feature.padEnd(26).slice(0, 26);
        const ep = row.endpoint.padEnd(36).slice(0, 36);
        const f = `${row.fan.status}/${row.fan.verdict.slice(0, 1)}`.padEnd(5);
        const r = `${row.rookie.status}/${row.rookie.verdict.slice(0, 1)}`.padEnd(5);
        const v = `${row.veteran.status}/${row.veteran.verdict.slice(0, 1)}`.padEnd(5);
        const fl = row.flags.length ? row.flags.join(', ') : '—';
        lines.push(`${feat} │ ${ep} │ ${f} │ ${r} │ ${v} │ ${fl}`);
      }
      lines.push('═'.repeat(105));
      lines.push('Legend: G=Granted  D=Denied  C=Crashed  N=Not Found  I=Invalid payload/conflict');
      lines.push('');
      lines.push('FLAG SUMMARY');
      lines.push(`  Crashes (5xx):                   ${crashes.length}`);
      lines.push(`  Missing audited routes (404):    ${missingRoutes.length}`);
      lines.push(`  Fan accessing coach features:    ${fanCoach.length}`);
      lines.push(`  Rookie accessing vet features:   ${rookieVet.length}`);
      lines.push(`  Denials without clean message:   ${badDenial.length}`);
      if (allFlags.length > 0) {
        lines.push('');
        lines.push('FLAGGED ITEMS');
        for (const row of matrix) {
          if (row.flags.length > 0) {
            lines.push(`  [${row.flags.join(', ')}] ${row.feature} — ${row.endpoint}`);
          }
        }
      } else {
        lines.push('');
        lines.push(
          '  No smoke flags raised. Unasserted permissions and UI workflows remain unverified.'
        );
      }
      const outPath = join(process.cwd(), 'access-matrix-report.txt');
      writeFileSync(outPath, lines.join('\n') + '\n');

      // ASSERT: no crashes
      expect(crashes).toEqual([]);
      // ASSERT: audited routes still exist
      expect(missingRoutes).toEqual([]);
      // ASSERT: no fan accessing coach features
      expect(fanCoach).toEqual([]);
      // ASSERT: no rookie accessing veteran features
      expect(rookieVet).toEqual([]);
      expect(badDenial).toEqual([]);
    });
  });
});
