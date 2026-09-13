import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import bcrypt from 'bcrypt';
import request from 'supertest';
import { app } from '../testApp.js';

let prisma: any;
let signJwt: any;

const ts = Date.now();
const PASSWORD = 'TestPassword123!';

describe('Unified search', () => {
  let userId: string;
  let token: string;
  let organizationId: string;
  let teamId: string;
  let gameId: string;
  let eventId: string;
  let mediaPostId: string;
  let textOnlyPostId: string;
  let demoTeamId: string;

  it('ranks name matches by distance from now before limiting either source', async () => {
    const title = `Temporal fixture ${ts}`;
    const anchor = Date.now();
    const gameIds: string[] = [];
    const eventIds: string[] = [];
    try {
      for (const hours of [-1, 2, 24 * 365]) {
        const data = {
          title,
          date: new Date(anchor + hours * 3600000),
          location: 'Test',
          approval_status: 'approved',
        };
        const game = await prisma.game.create({ data });
        const event = await prisma.event.create({
          data: { ...data, status: 'approved', creator_id: userId },
        });
        gameIds.push(game.id);
        eventIds.push(event.id);
      }
      const result = await request(app)
        .get('/search')
        .query({ q: title, limit: 2 })
        .set('Authorization', `Bearer ${token}`);
      expect(result.status).toBe(200);
      expect(result.body.games.map((item: any) => item.id)).toEqual(gameIds.slice(0, 2));
      expect(result.body.events.map((item: any) => item.id)).toEqual(eventIds.slice(0, 2));
    } finally {
      await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
      await prisma.game.deleteMany({ where: { id: { in: gameIds } } });
    }
  });

  beforeAll(async () => {
    ({ prisma } = await import('../lib/prisma.js'));
    ({ signJwt } = await import('../lib/jwt.js'));

    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await prisma.user.create({
      data: {
        email: `search-unified-${ts}@example.com`,
        password_hash: passwordHash,
        display_name: 'Search Tester',
        username: `sut${String(ts).slice(-8)}`,
        email_verified: true,
        onboarding_completed: true,
        role: 'fan',
        approval_status: 'APPROVED',
        preferences: {
          role: 'fan',
          onboarding_completed: true,
        },
      },
    });
    userId = user.id;
    token = signJwt({ id: userId });

    const org = await prisma.organization.create({
      data: {
        name: `Search Org ${ts}`,
        admin_approved: true,
        status: 'active',
        league_owner_id: userId,
      },
      select: { id: true },
    });
    organizationId = org.id;

    const team = await prisma.team.create({
      data: {
        name: `Search Team ${ts}`,
        organization_id: organizationId,
        status: 'active',
        sport: 'Basketball',
      },
      select: { id: true },
    });
    teamId = team.id;

    const demoTeam = await prisma.team.create({
      data: {
        name: `Search Team Demo ${ts}`,
        organization_id: organizationId,
        status: 'active',
        league: 'International Cup 2026',
      },
      select: { id: true },
    });
    demoTeamId = demoTeam.id;

    const game = await prisma.game.create({
      data: {
        title: `Search Showcase ${ts}`,
        date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        location: 'Search Arena',
        approval_status: 'approved',
        created_by_id: userId,
        event_type: 'game',
        home_team_id: teamId,
      },
    });
    gameId = game.id;

    const event = await prisma.event.create({
      data: {
        title: `Search Pep Rally ${ts}`,
        date: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000),
        location: 'Search Commons',
        status: 'approved',
        approval_status: 'approved',
        creator_id: userId,
        creator_role: 'coach',
      },
    });
    eventId = event.id;

    const mediaPost = await prisma.post.create({
      data: {
        author_id: userId,
        title: `Search Highlight ${ts}`,
        content: 'Great game recap',
        media_url: 'https://example.com/search-post.jpg',
      },
      select: { id: true },
    });
    mediaPostId = mediaPost.id;

    // Text-only — must NOT appear in post search results (media-only, same as /highlights).
    const textOnlyPost = await prisma.post.create({
      data: {
        author_id: userId,
        title: `Search TextOnly ${ts}`,
        content: 'No media here',
      },
      select: { id: true },
    });
    textOnlyPostId = textOnlyPost.id;
  });

  afterAll(async () => {
    await prisma.post
      .deleteMany({ where: { id: { in: [mediaPostId, textOnlyPostId] } } })
      .catch(() => {});
    await prisma.event.deleteMany({ where: { id: eventId } }).catch(() => {});
    await prisma.game.deleteMany({ where: { id: gameId } }).catch(() => {});
    await prisma.team.deleteMany({ where: { id: { in: [teamId, demoTeamId] } } }).catch(() => {});
    await prisma.organization.deleteMany({ where: { id: organizationId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
  });

  it('returns people, teams, organizations, games, and events from one query', async () => {
    const res = await request(app)
      .get('/search?q=Search')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body?.users?.some((row: any) => row.id === userId)).toBe(true);
    expect(res.body?.teams?.some((row: any) => row.id === teamId)).toBe(true);
    expect(res.body?.organizations?.some((row: any) => row.id === organizationId)).toBe(true);
    expect(res.body?.games?.some((row: any) => row.id === gameId)).toBe(true);
    expect(res.body?.events?.some((row: any) => row.id === eventId)).toBe(true);
    expect(res.body?.posts?.some((row: any) => row.id === mediaPostId)).toBe(true);
  });

  it('returns matching posts with the shape HighlightCard expects, media-only', async () => {
    const res = await request(app)
      .get('/search?q=Search Highlight')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const post = res.body?.posts?.find((row: any) => row.id === mediaPostId);
    expect(post).toBeTruthy();
    expect(post.media_url).toBe('https://example.com/search-post.jpg');
    expect(post.has_upvoted).toBe(false);
    expect(post.has_bookmarked).toBe(false);
    expect(typeof post.bookmarks_count).toBe('number');
    expect(post.author?.id).toBe(userId);

    // Text-only post matching the same query must not appear — posts search
    // is media-only, same restriction as /highlights.
    const res2 = await request(app)
      .get('/search?q=Search TextOnly')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res2.body?.posts?.some((row: any) => row.id === textOnlyPostId)).toBe(false);
  });

  it('exclude_demo_leagues=1 drops the FIFA demo team but keeps the real one (null league)', async () => {
    const withoutFlag = await request(app)
      .get('/search?q=Search Team')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(withoutFlag.body?.teams?.some((row: any) => row.id === teamId)).toBe(true);
    expect(withoutFlag.body?.teams?.some((row: any) => row.id === demoTeamId)).toBe(true);

    const withFlag = await request(app)
      .get('/search?q=Search Team&exclude_demo_leagues=1')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(withFlag.body?.teams?.some((row: any) => row.id === teamId)).toBe(true);
    expect(withFlag.body?.teams?.some((row: any) => row.id === demoTeamId)).toBe(false);
  });

  it('empty query returns an empty posts array alongside the other empty buckets', async () => {
    const res = await request(app)
      .get('/search?q=')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toEqual({
      users: [],
      teams: [],
      organizations: [],
      games: [],
      events: [],
      posts: [],
    });
  });

  it('a date query returns approved games on that date, including past dates', async () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    yesterday.setUTCHours(19, 0, 0, 0);
    const pastGame = await prisma.game.create({
      data: {
        title: `Date Lookup Game ${ts}`,
        date: yesterday,
        location: 'Date Arena',
        approval_status: 'approved',
        created_by_id: userId,
        event_type: 'game',
        home_team_id: teamId,
      },
    });
    try {
      const MONTHS = [
        'January',
        'February',
        'March',
        'April',
        'May',
        'June',
        'July',
        'August',
        'September',
        'October',
        'November',
        'December',
      ];
      const q = `${MONTHS[yesterday.getUTCMonth()]} ${yesterday.getUTCDate()} ${yesterday.getUTCFullYear()}`;

      const res = await request(app)
        .get('/search')
        .query({ q })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body?.games?.some((row: any) => row.id === pastGame.id)).toBe(true);

      // Text search now spans past events too (owner decision 2026-08-03):
      // finished pages must stay reviewable, so a past game matched by title
      // surfaces alongside upcoming ones.
      const textRes = await request(app)
        .get('/search')
        .query({ q: `Date Lookup Game ${ts}` })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(textRes.body?.games?.some((row: any) => row.id === pastGame.id)).toBe(true);
    } finally {
      await prisma.game.delete({ where: { id: pastGame.id } });
    }
  });

  it('finds a finished event by name so its recap page stays reviewable', async () => {
    // Regression for the Fanatics Fest miss (owner report 2026-08-03): a past
    // event was unfindable by name in unified search. game_id: null so it isn't
    // gated by opponent-consent — a pure past-date/text case.
    const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const pastEvent = await prisma.event.create({
      data: {
        title: `Recap Fest ${ts}`,
        date: lastWeek,
        location: 'Recap Arena',
        status: 'approved',
        approval_status: 'approved',
        event_type: 'other',
      },
      select: { id: true },
    });
    try {
      const res = await request(app)
        .get('/search')
        .query({ q: `Recap Fest ${ts}` })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(res.body?.events?.some((row: any) => row.id === pastEvent.id)).toBe(true);
    } finally {
      await prisma.event.delete({ where: { id: pastEvent.id } });
    }
  });
});
