/**
 * API Integration Tests - Event Endpoints
 *
 * Tests actual HTTP endpoints for event management:
 * - POST /events (create event with approval workflow)
 * - GET /events (list events)
 * - Coach auto-approval vs fan approval requirement
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import { app } from '../testApp.js';
import bcrypt from 'bcrypt';

let prisma: any;
let signJwt: any;

const TEST_COACH_EMAIL = `test-api-event-coach-${Date.now()}@example.com`;
const TEST_FAN_EMAIL = `test-api-event-fan-${Date.now()}@example.com`;
const TEST_PASSWORD = 'TestPassword123!';

describe('API Event Endpoints', () => {
  let coachUserId: string;
  let coachToken: string;
  let fanUserId: string;
  let fanToken: string;
  let testOrgId: string;
  let testTeamId: string;
  let testTeamMembershipId: string;

  beforeAll(async () => {
    ({ prisma } = await import('../lib/prisma.js'));
    ({ signJwt } = await import('../lib/jwt.js'));
    // Create coach user
    const coachPasswordHash = await bcrypt.hash(TEST_PASSWORD, 10);
    const coach = await prisma.user.create({
      data: {
        email: TEST_COACH_EMAIL,
        password_hash: coachPasswordHash,
        display_name: 'Test Coach',
        email_verified: true,
        role: 'coach',
        onboarding_completed: true,
        approval_status: 'APPROVED',
        preferences: {
          role: 'coach',
          plan: 'rookie',
          onboarding_completed: true,
          coach_agreement_accepted_at: new Date().toISOString(),
        },
      },
    });
    coachUserId = coach.id;
    coachToken = signJwt({ id: coachUserId });

    // Give the coach an org membership so isOrgAdmin() returns true for auto-approval
    const org = await prisma.organization.create({
      data: {
        name: `Test Event League ${Date.now()}`,
        org_type: 'club',
        updated_at: new Date(),
      },
    });
    testOrgId = org.id;
    await prisma.organizationMembership.create({
      data: { organization_id: testOrgId, user_id: coachUserId, role: 'owner', status: 'active' },
    });
    const team = await prisma.team.create({
      data: {
        name: `Test Event Team ${Date.now()}`,
        organization_id: testOrgId,
      },
    });
    testTeamId = team.id;
    const membership = await prisma.teamMembership.create({
      data: {
        team_id: testTeamId,
        user_id: coachUserId,
        role: 'owner',
        status: 'active',
      },
    });
    testTeamMembershipId = membership.id;

    // Create fan user
    const fanPasswordHash = await bcrypt.hash(TEST_PASSWORD, 10);
    const fan = await prisma.user.create({
      data: {
        email: TEST_FAN_EMAIL,
        password_hash: fanPasswordHash,
        display_name: 'Test Fan',
        email_verified: true,
        role: 'fan',
        onboarding_completed: true,
        preferences: {
          role: 'fan',
          onboarding_completed: true,
        },
      },
    });
    fanUserId = fan.id;
    fanToken = signJwt({ id: fanUserId });
  });

  afterAll(async () => {
    try {
      await prisma.eventRsvp.deleteMany({
        where: {
          user_id: {
            in: [coachUserId, fanUserId],
          },
        },
      });

      // Clean up events
      await prisma.event.deleteMany({
        where: {
          creator_id: {
            in: [coachUserId, fanUserId],
          },
        },
      });

      // Clean up org memberships and org
      if (testTeamMembershipId) {
        await prisma.teamMembership.delete({ where: { id: testTeamMembershipId } }).catch(() => {});
      }
      if (testTeamId) {
        await prisma.team.delete({ where: { id: testTeamId } }).catch(() => {});
      }
      if (testOrgId) {
        await prisma.organizationMembership.deleteMany({ where: { organization_id: testOrgId } });
        await prisma.organization.delete({ where: { id: testOrgId } }).catch(() => {});
      }

      // Clean up users
      await prisma.user.deleteMany({
        where: {
          id: {
            in: [coachUserId, fanUserId],
          },
        },
      });
    } catch (error) {
      console.warn('Cleanup error (non-critical):', error);
    }
  });

  describe('POST /events', () => {
    it('should auto-approve non-competitive events created by coaches', async () => {
      const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days from now

      const response = await request(app)
        .post('/events')
        .set('Authorization', `Bearer ${coachToken}`)
        .send({
          title: 'Coach Event',
          date: futureDate.toISOString(),
          location: 'Test Stadium',
          team_id: testTeamId,
          event_type: 'fundraiser',
        })
        .expect(201);

      expect(response.body).toHaveProperty('id');
      expect(response.body.status).toBe('approved');
      expect(response.body.approval_status).toBe('approved');
      expect(response.body.creator_id).toBe(coachUserId);
    });

    it('honors is_all_day for a coach, extending the posting window to 12h (owner rule 2026-09-14)', async () => {
      const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const response = await request(app)
        .post('/events')
        .set('Authorization', `Bearer ${coachToken}`)
        .send({
          title: 'Coach All-Day Event',
          date: futureDate.toISOString(),
          location: 'Test Stadium',
          team_id: testTeamId,
          event_type: 'fundraiser',
          is_all_day: true,
        })
        .expect(201);

      try {
        expect(response.body.is_all_day).toBe(true);
        // live_until should be start + 12h, not the 6h default.
        expect(Date.parse(response.body.live_until) - futureDate.getTime()).toBe(
          12 * 60 * 60 * 1000
        );
      } finally {
        // Other tests in this file (e.g. the my-events cursor pagination test)
        // count events by creator — don't leak a stray row into their totals.
        await prisma.event.delete({ where: { id: response.body.id } }).catch(() => {});
      }
    });

    it('ignores is_all_day from a fan — only real coach/organizer creators can extend the window', async () => {
      const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const response = await request(app)
        .post('/events')
        .set('Authorization', `Bearer ${fanToken}`)
        .send({
          title: 'Fan All-Day Attempt',
          date: futureDate.toISOString(),
          location: 'Test Location',
          event_type: 'fundraiser',
          is_all_day: true,
        })
        .expect(201);

      try {
        expect(response.body.is_all_day).toBe(false);
        // Falls back to the standard 6h default, not 12h.
        expect(Date.parse(response.body.live_until) - futureDate.getTime()).toBe(
          6 * 60 * 60 * 1000
        );
      } finally {
        await prisma.event.delete({ where: { id: response.body.id } }).catch(() => {});
      }
    });

    it('rejects competitive events created without a linked game record', async () => {
      const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const response = await request(app)
        .post('/events')
        .set('Authorization', `Bearer ${coachToken}`)
        .send({
          title: 'Orphan Competitive Event',
          date: futureDate.toISOString(),
          location: 'Test Stadium',
          team_id: testTeamId,
          event_type: 'game',
        })
        .expect(400);

      expect(response.body?.code).toBe('COMPETITIVE_EVENT_REQUIRES_GAME');
    });

    it('should require approval for events created by fans', async () => {
      const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const response = await request(app)
        .post('/events')
        .set('Authorization', `Bearer ${fanToken}`)
        .send({
          title: 'Fan Event',
          date: futureDate.toISOString(),
          location: 'Test Location',
          event_type: 'fundraiser',
        })
        .expect(201);

      expect(response.body).toHaveProperty('id');
      expect(response.body.status).toBe('draft');
      expect(response.body.approval_status).toBe('pending');
      expect(response.body.creator_id).toBe(fanUserId);
    });

    it('should require authentication', async () => {
      const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const response = await request(app)
        .post('/events')
        .send({
          title: 'Unauthorized Event',
          date: futureDate.toISOString(),
          location: 'Test',
        })
        .expect(401);

      expect(response.body).toHaveProperty('error');
    });

    it('should require event title', async () => {
      const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const response = await request(app)
        .post('/events')
        .set('Authorization', `Bearer ${coachToken}`)
        .send({
          date: futureDate.toISOString(),
          location: 'Test',
        })
        .expect(400);

      expect(response.body).toHaveProperty('error');
    });

    it('should require event date', async () => {
      const response = await request(app)
        .post('/events')
        .set('Authorization', `Bearer ${coachToken}`)
        .send({
          title: 'Event Without Date',
          location: 'Test',
        })
        .expect(400);

      expect(response.body).toHaveProperty('error');
    });

    it('should sanitize event title (trim whitespace)', async () => {
      const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const response = await request(app)
        .post('/events')
        .set('Authorization', `Bearer ${coachToken}`)
        .send({
          title: '  Trimmed Event  ',
          date: futureDate.toISOString(),
          location: 'Test',
        })
        .expect(201);

      expect(response.body.title).toBe('Trimmed Event');
      expect(response.body.title).not.toContain('  ');
    });

    it('should sanitize event location (trim whitespace)', async () => {
      const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const response = await request(app)
        .post('/events')
        .set('Authorization', `Bearer ${coachToken}`)
        .send({
          title: 'Test Event',
          date: futureDate.toISOString(),
          location: '  Trimmed Location  ',
        })
        .expect(201);

      expect(response.body.location).toBe('Trimmed Location');
      expect(response.body.location).not.toContain('  ');
    });
  });

  describe('GET /events', () => {
    it('should return list of approved events', async () => {
      const response = await request(app).get('/events').expect(200);

      expect(Array.isArray(response.body)).toBe(true);
    });

    it('should filter events by status', async () => {
      const response = await request(app).get('/events?status=approved').expect(200);

      expect(Array.isArray(response.body)).toBe(true);
    });

    it('should filter events by approval_status', async () => {
      const response = await request(app).get('/events?approval_status=pending').expect(200);

      expect(Array.isArray(response.body)).toBe(true);
    });

    it('should search events by query', async () => {
      const response = await request(app).get('/events?q=Test').expect(200);

      expect(Array.isArray(response.body)).toBe(true);
    });

    it('should limit number of results', async () => {
      const response = await request(app).get('/events?limit=10').expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body.length).toBeLessThanOrEqual(10);
    });

    it('should filter events by direct team_id and linked game team_ids', async () => {
      const futureDate = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
      const outsideTeam = await prisma.team.create({
        data: {
          name: `Outside Event Team ${Date.now()}`,
          organization_id: testOrgId,
        },
      });
      const linkedGame = await prisma.game.create({
        data: {
          title: `Linked Team Event Game ${Date.now()}`,
          date: futureDate,
          location: 'Linked Stadium',
          approval_status: 'approved',
          home_team_id: testTeamId,
        },
      });

      try {
        const directEvent = await prisma.event.create({
          data: {
            title: `Direct Team Event ${Date.now()}`,
            date: futureDate,
            location: 'Direct Stadium',
            status: 'approved',
            approval_status: 'approved',
            creator_id: coachUserId,
            creator_role: 'coach',
            team_id: testTeamId,
          },
        });
        const linkedEvent = await prisma.event.create({
          data: {
            title: `Linked Team Event ${Date.now()}`,
            date: futureDate,
            location: 'Linked Stadium',
            status: 'approved',
            approval_status: 'approved',
            creator_id: coachUserId,
            creator_role: 'coach',
            game_id: linkedGame.id,
          },
        });
        const outsideEvent = await prisma.event.create({
          data: {
            title: `Outside Team Event ${Date.now()}`,
            date: futureDate,
            location: 'Outside Stadium',
            status: 'approved',
            approval_status: 'approved',
            creator_id: coachUserId,
            creator_role: 'coach',
            team_id: outsideTeam.id,
          },
        });

        const response = await request(app)
          .get(`/events?team_ids=${encodeURIComponent(testTeamId)}`)
          .expect(200);

        const ids = response.body.map((item: any) => item.id);
        expect(ids).toContain(directEvent.id);
        expect(ids).toContain(linkedEvent.id);
        expect(ids).not.toContain(outsideEvent.id);
      } finally {
        await prisma.event
          .deleteMany({
            where: {
              OR: [
                { team_id: outsideTeam.id },
                { game_id: linkedGame.id },
                { team_id: testTeamId, title: { contains: 'Direct Team Event' } },
              ],
            },
          })
          .catch(() => {});
        await prisma.game.delete({ where: { id: linkedGame.id } }).catch(() => {});
        await prisma.team.delete({ where: { id: outsideTeam.id } }).catch(() => {});
      }
    });

    it('does not expose creator object on the public event list payload', async () => {
      const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      await prisma.event.create({
        data: {
          title: `Public Event List Contract ${Date.now()}`,
          date: futureDate,
          location: 'Test Stadium',
          status: 'approved',
          approval_status: 'approved',
          creator_id: coachUserId,
          creator_role: 'coach',
        },
      });

      const response = await request(app).get('/events').expect(200);

      const created = response.body.find((item: any) => item.creator_id === coachUserId);
      expect(created).toBeTruthy();
      expect(created).not.toHaveProperty('creator');
    });
  });

  describe('event list pagination', () => {
    it('paginates my-events with a stable created_at/id cursor in response headers', async () => {
      const base = Date.now() + 10_000;
      for (let i = 0; i < 3; i += 1) {
        await prisma.event.create({
          data: {
            title: `My Events Cursor ${i}`,
            date: new Date(base + (i + 1) * 60_000),
            location: 'Cursor Arena',
            event_type: 'fundraiser',
            approval_status: 'pending',
            status: 'draft',
            creator_id: fanUserId,
            created_at: new Date(base - i * 1000),
          },
        });
      }

      const firstPage = await request(app)
        .get('/events/my-events?limit=2')
        .set('Authorization', `Bearer ${fanToken}`)
        .expect(200);

      expect(Array.isArray(firstPage.body)).toBe(true);
      expect(firstPage.body).toHaveLength(2);
      expect(firstPage.headers['x-has-more']).toBe('1');
      expect(typeof firstPage.headers['x-next-cursor']).toBe('string');

      const secondPage = await request(app)
        .get(
          `/events/my-events?limit=2&cursor=${encodeURIComponent(firstPage.headers['x-next-cursor'])}`
        )
        .set('Authorization', `Bearer ${fanToken}`)
        .expect(200);

      expect(Array.isArray(secondPage.body)).toBe(true);
      expect(secondPage.body.length).toBeGreaterThanOrEqual(1);
      expect(secondPage.headers['x-has-more']).toBe('0');
    });

    it('paginates pending events for managed coaches with a stable created_at/id cursor', async () => {
      const base = Date.now() + 20_000;
      for (let i = 0; i < 3; i += 1) {
        await prisma.event.create({
          data: {
            title: `Pending Events Cursor ${i}`,
            date: new Date(base + (i + 1) * 60_000),
            location: 'Pending Arena',
            team_id: testTeamId,
            event_type: 'game',
            approval_status: 'pending',
            status: 'draft',
            creator_id: fanUserId,
            created_at: new Date(base - i * 1000),
          },
        });
      }

      const firstPage = await request(app)
        .get('/events/pending?limit=2')
        .set('Authorization', `Bearer ${coachToken}`)
        .expect(200);

      expect(Array.isArray(firstPage.body)).toBe(true);
      expect(firstPage.body).toHaveLength(2);
      expect(firstPage.headers['x-has-more']).toBe('1');
      expect(typeof firstPage.headers['x-next-cursor']).toBe('string');

      const secondPage = await request(app)
        .get(
          `/events/pending?limit=2&cursor=${encodeURIComponent(firstPage.headers['x-next-cursor'])}`
        )
        .set('Authorization', `Bearer ${coachToken}`)
        .expect(200);

      expect(Array.isArray(secondPage.body)).toBe(true);
      expect(secondPage.body.length).toBeGreaterThanOrEqual(1);
      expect(
        secondPage.body.some(
          (event: { title?: string }) =>
            typeof event.title === 'string' && event.title.startsWith('Pending Events Cursor ')
        )
      ).toBe(true);
      const firstPageIds = new Set(firstPage.body.map((event: { id: string }) => event.id));
      expect(secondPage.body.every((event: { id: string }) => !firstPageIds.has(event.id))).toBe(
        true
      );
    });
  });

  // ── Org-admin fallback + broader-cancel-semantics regression tests.
  //
  // Closes the third original boundary bug: /events/:id/cancel used to require
  // role='owner' on the team AND had no org-admin fallback. Now uses
  // canManageAnyTeam() which accepts owner/manager/coach/assistant_coach plus
  // org-admin fallback. These tests pin the broader semantics so a future
  // tightening can't silently regress them.
  describe('Event cancel — boundary regression', () => {
    const futureDate = () => {
      const d = new Date();
      d.setDate(d.getDate() + 14);
      return d;
    };

    it('allows an org owner to cancel an event linked to a team in their league without direct team membership', async () => {
      const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
      // Event creator is a separate team coach; the org-owner user we test
      // with (coachToken) has NO team membership on this team. The
      // pre-existing test setup does give coachToken a team owner membership
      // on `testTeamId` (line 73-80), so we build a NEW team without touching
      // that membership.
      const orgOnlyAdmin = coachToken; // coachUserId is already org OWNER of testOrgId

      const separateTeam = await prisma.team.create({
        data: {
          name: `Cancel-test-team-${Date.now()}`,
          organization_id: testOrgId,
        },
      });
      const separateCreator = await prisma.user.create({
        data: {
          email: `test-event-creator-${Date.now()}@example.com`,
          password_hash: passwordHash,
          display_name: 'Event Creator',
          email_verified: true,
          role: 'coach',
          onboarding_completed: true,
          approval_status: 'APPROVED',
          preferences: {
            role: 'coach',
            plan: 'rookie',
            onboarding_completed: true,
            coach_agreement_accepted_at: new Date().toISOString(),
          },
        },
      });
      await prisma.teamMembership.create({
        data: {
          team_id: separateTeam.id,
          user_id: separateCreator.id,
          role: 'coach',
          status: 'active',
        },
      });

      const event = await prisma.event.create({
        data: {
          title: 'Org-admin cancel target',
          date: futureDate(),
          status: 'approved',
          approval_status: 'approved',
          creator_id: separateCreator.id,
          team_id: separateTeam.id,
        } as any,
      });

      const res = await request(app)
        .patch(`/events/${event.id}/cancel`)
        .set('Authorization', `Bearer ${orgOnlyAdmin}`)
        .send({});

      expect(res.status).toBe(200);
      const refreshed = await prisma.event.findUnique({ where: { id: event.id } });
      expect(refreshed?.status).toBe('cancelled');

      // Cleanup
      await prisma.event.deleteMany({ where: { id: event.id } }).catch(() => {});
      await prisma.teamMembership
        .deleteMany({ where: { team_id: separateTeam.id } })
        .catch(() => {});
      await prisma.team.delete({ where: { id: separateTeam.id } }).catch(() => {});
      await prisma.user.delete({ where: { id: separateCreator.id } }).catch(() => {});
    });

    it('allows a team coach (not just owner) to cancel an event they did not create', async () => {
      // The pre-fix behavior rejected anyone whose team membership role was
      // not 'owner'. This test proves a coach on the same team can cancel.
      const passwordHash = await bcrypt.hash(TEST_PASSWORD, 10);
      const coachMember = await prisma.user.create({
        data: {
          email: `test-cancel-coach-${Date.now()}@example.com`,
          password_hash: passwordHash,
          display_name: 'Team Coach Member',
          email_verified: true,
          role: 'coach',
          onboarding_completed: true,
          approval_status: 'APPROVED',
          preferences: {
            role: 'coach',
            plan: 'rookie',
            onboarding_completed: true,
            coach_agreement_accepted_at: new Date().toISOString(),
          },
        },
      });
      await prisma.teamMembership.create({
        data: {
          team_id: testTeamId,
          user_id: coachMember.id,
          role: 'coach',
          status: 'active',
        },
      });
      const coachMemberToken = signJwt({ id: coachMember.id });

      // Event created by a THIRD party (not the coach we're testing). The
      // event is on testTeamId, so the coach has staff membership but isn't
      // the creator.
      const anotherCreator = await prisma.user.create({
        data: {
          email: `test-cancel-creator-${Date.now() + 1}@example.com`,
          password_hash: passwordHash,
          display_name: 'Another Creator',
          email_verified: true,
          role: 'coach',
          onboarding_completed: true,
          approval_status: 'APPROVED',
          preferences: {
            role: 'coach',
            plan: 'rookie',
            onboarding_completed: true,
            coach_agreement_accepted_at: new Date().toISOString(),
          },
        },
      });
      await prisma.teamMembership.create({
        data: {
          team_id: testTeamId,
          user_id: anotherCreator.id,
          role: 'assistant_coach',
          status: 'active',
        },
      });

      const event = await prisma.event.create({
        data: {
          title: 'Coach cancel target',
          date: futureDate(),
          status: 'approved',
          approval_status: 'approved',
          creator_id: anotherCreator.id,
          team_id: testTeamId,
        } as any,
      });

      const res = await request(app)
        .patch(`/events/${event.id}/cancel`)
        .set('Authorization', `Bearer ${coachMemberToken}`)
        .send({});

      expect(res.status).toBe(200);
      const refreshed = await prisma.event.findUnique({ where: { id: event.id } });
      expect(refreshed?.status).toBe('cancelled');

      // Cleanup
      await prisma.event.deleteMany({ where: { id: event.id } }).catch(() => {});
      await prisma.teamMembership
        .deleteMany({ where: { user_id: { in: [coachMember.id, anotherCreator.id] } } })
        .catch(() => {});
      await prisma.user
        .deleteMany({ where: { id: { in: [coachMember.id, anotherCreator.id] } } })
        .catch(() => {});
    });
  });
});
