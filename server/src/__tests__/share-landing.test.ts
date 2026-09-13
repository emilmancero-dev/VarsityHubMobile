/**
 * Share-landing regression suite.
 *
 * Locks in the contract for the universal-link web fallback:
 *   1. Browser requests (Accept: text/html) get HTML with OG tags.
 *   2. JSON clients (Accept: application/json) fall through to the API
 *      and get the existing JSON response (or its 401/404). This is
 *      load-bearing — every existing API client (mobile app, fetch,
 *      integrations) must keep working unchanged.
 *   3. OG tags include the resource title + canonical URL.
 *   4. Generic landing renders for /share and /join/:code.
 *
 * Pure unit-style — boots a minimal Express app with the share router
 * mounted in front of a stub "API" router that always replies JSON.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const postFindUnique = jest.fn();
const gameFindUnique = jest.fn();
const teamFindUnique = jest.fn();
const userFindUnique = jest.fn();
const eventFindUnique = jest.fn();

jest.unstable_mockModule('../lib/prisma.js', () => ({
  prisma: {
    post: { findUnique: postFindUnique },
    game: { findUnique: gameFindUnique },
    team: { findUnique: teamFindUnique },
    user: { findUnique: userFindUnique },
    event: { findUnique: eventFindUnique },
  },
}));

const { shareLandingRouter } = await import('../routes/shareLanding.js');

function makeApp() {
  const app = express();
  // Landing first, then a stub API that always replies JSON.
  app.use(shareLandingRouter);
  app.get('/posts/:id', (_req, res) => res.status(200).json({ id: 'api-response' }));
  app.get('/games/:id', (_req, res) => res.status(200).json({ id: 'api-response' }));
  app.get('/teams/:id', (_req, res) => res.status(200).json({ id: 'api-response' }));
  app.get('/users/:id', (_req, res) => res.status(200).json({ id: 'api-response' }));
  app.get('/events/:id', (_req, res) => res.status(200).json({ id: 'api-response' }));
  return app;
}

describe('share-landing — content-type branching', () => {
  beforeEach(() => {
    postFindUnique.mockReset().mockResolvedValue(null as any);
    gameFindUnique.mockReset().mockResolvedValue(null as any);
    teamFindUnique.mockReset().mockResolvedValue(null as any);
    userFindUnique.mockReset().mockResolvedValue(null as any);
    eventFindUnique.mockReset().mockResolvedValue(null as any);
  });

  it('JSON client (Accept: application/json) falls through to API', async () => {
    const app = makeApp();
    const res = await request(app).get('/posts/abc').set('Accept', 'application/json');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ id: 'api-response' });
    expect(postFindUnique).not.toHaveBeenCalled();
  });

  it('Browser request (Accept: text/html) gets HTML landing', async () => {
    const app = makeApp();
    const res = await request(app).get('/posts/abc').set('Accept', 'text/html');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('<!DOCTYPE html>');
    expect(res.text).toContain('og:title');
    expect(res.text).toContain('Open in VarsityHub');
    expect(postFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'abc' } }));
  });

  it('Social crawler (Accept: */*, UA: facebookexternalhit) gets HTML landing', async () => {
    const app = makeApp();
    const res = await request(app)
      .get('/posts/abc')
      .set('Accept', '*/*')
      .set(
        'User-Agent',
        'facebookexternalhit/1.1 (+https://www.facebook.com/externalhit_uatext.php)'
      );

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('og:title');
  });

  it('Plain Accept: */* (no crawler UA) falls through to API — no false positive on supertest/axios/fetch', async () => {
    const app = makeApp();
    const res = await request(app).get('/posts/abc').set('Accept', '*/*');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ id: 'api-response' });
  });
});

describe('share-landing — OG metadata enrichment', () => {
  beforeEach(() => {
    postFindUnique.mockReset();
    gameFindUnique.mockReset();
    teamFindUnique.mockReset();
    userFindUnique.mockReset();
    eventFindUnique.mockReset();
  });

  it('post landing pulls author + content + media for the OG tags', async () => {
    postFindUnique.mockResolvedValueOnce({
      content: 'Big win against Springfield High!',
      media_url: 'https://cdn.example.com/highlight.jpg',
      author: { display_name: 'Coach Carter', username: 'coach_c' },
    } as any);

    const res = await request(makeApp()).get('/posts/abc').set('Accept', 'text/html');

    expect(res.text).toContain('Coach Carter on VarsityHub');
    expect(res.text).toContain('Big win against Springfield High!');
    expect(res.text).toContain('https://cdn.example.com/highlight.jpg');
    expect(res.text).toContain('summary_large_image'); // image present → big card
  });

  it('query-style /share?type=post&id= routes to the post OG (not the generic card)', async () => {
    // The app's share sheet emits /share?type=post&id=…; it must resolve to the
    // real post preview, not the imageless generic landing (owner note, Sep 2026).
    postFindUnique.mockResolvedValueOnce({
      content: 'Big win against Springfield High!',
      media_url: 'https://cdn.example.com/highlight.jpg',
      author: { display_name: 'Coach Carter', username: 'coach_c' },
    } as any);

    const res = await request(makeApp()).get('/share?type=post&id=abc').set('Accept', 'text/html');

    expect(res.status).toBe(200);
    expect(res.text).toContain('Big win against Springfield High!');
    expect(res.text).toContain('https://cdn.example.com/highlight.jpg');
    expect(res.text).toContain('summary_large_image');
  });

  it('game landing pulls title + location + date for description', async () => {
    gameFindUnique.mockResolvedValueOnce({
      title: 'Westhill vs Stamford',
      location: 'Westhill HS',
      date: new Date('2026-05-15T19:00:00Z'),
      approval_status: 'approved', // share door only enriches approved games (Phase 3a)
    } as any);

    const res = await request(makeApp()).get('/games/g1').set('Accept', 'text/html');

    expect(res.text).toContain('Westhill vs Stamford');
    expect(res.text).toContain('at Westhill HS');
  });

  it('team landing pulls team metadata for the OG tags', async () => {
    teamFindUnique.mockResolvedValueOnce({
      name: 'Westhill Wildcats',
      description: 'Official team page for Westhill basketball.',
      logo_url: 'https://cdn.example.com/team-logo.jpg',
      is_private: false, // share door only enriches public, active teams (Phase 3a)
      status: 'active',
    } as any);

    const res = await request(makeApp()).get('/teams/team_123').set('Accept', 'text/html');

    expect(res.text).toContain('Westhill Wildcats');
    expect(res.text).toContain('Official team page for Westhill basketball.');
    expect(res.text).toContain('https://cdn.example.com/team-logo.jpg');
    expect(teamFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'team_123' } })
    );
  });

  it('user landing uses @username for the title', async () => {
    userFindUnique.mockResolvedValueOnce({
      display_name: 'Coach Carter',
      username: 'coach_c',
      bio: 'Westhill basketball, est. 1989',
      avatar_url: 'https://cdn.example.com/avatar.jpg',
      deleted_at: null,
      preferences: {},
    } as any);

    const res = await request(makeApp()).get('/users/u1').set('Accept', 'text/html');

    expect(res.text).toContain('@coach_c');
    expect(res.text).toContain('Westhill basketball, est. 1989');
  });

  it('private user landing falls back to the generic branded page', async () => {
    const privateUser = {
      display_name: 'Private Coach',
      username: 'locked_coach',
      bio: 'Should not leak',
      avatar_url: 'https://cdn.example.com/private-avatar.jpg',
      deleted_at: null,
      preferences: { profile_private: true },
    } as any;
    userFindUnique.mockResolvedValue(privateUser);

    const res = await request(makeApp()).get('/users/u-private').set('Accept', 'text/html');

    expect(res.text).toContain('VarsityHub');
    expect(res.text).toContain('Open in VarsityHub');
    expect(res.text).not.toContain('@locked_coach');
    expect(res.text).not.toContain('https://cdn.example.com/private-avatar.jpg');
  });

  it('falls back to generic OG tags when the resource is missing', async () => {
    postFindUnique.mockResolvedValueOnce(null as any);
    const res = await request(makeApp()).get('/posts/missing').set('Accept', 'text/html');

    expect(res.status).toBe(200);
    expect(res.text).toContain('VarsityHub');
    expect(res.text).toContain('Open in VarsityHub');
  });

  it('escapes HTML entities in OG tags (no XSS via post content)', async () => {
    postFindUnique.mockResolvedValueOnce({
      content: '<script>alert(1)</script> & "fun"',
      media_url: null,
      author: { display_name: '"><img onerror=alert(1)>', username: null },
    } as any);

    const res = await request(makeApp()).get('/posts/x').set('Accept', 'text/html');

    expect(res.text).not.toContain('<script>alert');
    expect(res.text).not.toContain('"><img onerror');
    expect(res.text).toContain('&lt;script&gt;');
    expect(res.text).toContain('&amp;');
  });
});

describe('share-landing — generic routes', () => {
  beforeEach(() => {
    postFindUnique.mockReset();
    gameFindUnique.mockReset();
    teamFindUnique.mockReset();
    userFindUnique.mockReset();
    eventFindUnique.mockReset();
  });

  it('/join/:code renders generic landing without DB lookup', async () => {
    const app = makeApp();
    const res = await request(app).get('/join/SOMECODE').set('Accept', 'text/html');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(postFindUnique).not.toHaveBeenCalled();
    expect(gameFindUnique).not.toHaveBeenCalled();
  });

  it('/join/team/:code renders generic landing without DB lookup', async () => {
    const app = makeApp();
    const res = await request(app).get('/join/team/SOMECODE').set('Accept', 'text/html');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(postFindUnique).not.toHaveBeenCalled();
    expect(gameFindUnique).not.toHaveBeenCalled();
  });

  it('/join/org/:code renders generic landing without DB lookup', async () => {
    const app = makeApp();
    const res = await request(app).get('/join/org/SOMECODE').set('Accept', 'text/html');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(postFindUnique).not.toHaveBeenCalled();
    expect(gameFindUnique).not.toHaveBeenCalled();
  });

  it('/share renders generic landing', async () => {
    const app = makeApp();
    const res = await request(app).get('/share').set('Accept', 'text/html');

    expect(res.status).toBe(200);
    expect(res.text).toContain('VarsityHub');
  });
});
