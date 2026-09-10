import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import crypto from 'node:crypto';
import request from 'supertest';
import { app } from '../testApp.js';
import { prisma } from '../lib/prisma.js';
import { listEventDiscoveryItems } from '../lib/eventDiscovery.js';

const eventIds: string[] = [];
const leagueIds: string[] = [];
let creatorId: string;
const now = new Date('2035-03-03T00:00:00Z');
describe('database league filtering before result limits', () => {
  beforeAll(async () => {
    const creator = await prisma.user.create({
      data: { email: `league-map-${crypto.randomUUID()}@example.test` },
    });
    creatorId = creator.id;
    for (const level of ['major', 'minor']) {
      const league = await prisma.sportsLeague.create({
        data: {
          slug: `test-${crypto.randomUUID()}`,
          name: 'Test league',
          sport_slug: 'baseball',
          level,
          gender: 'mixed',
        },
      });
      leagueIds.push(league.id);
    }
    for (let i = 0; i < 4; i++) {
      const event = await prisma.event.create({
        data: {
          title: `Bounded map ${i}`,
          creator_id: creatorId,
          status: 'approved',
          approval_status: 'approved',
          date: new Date(+now + (i + 1) * 3600000),
          latitude: 40,
          longitude: -73,
          sports_league_id: leagueIds[i === 3 ? 1 : 0],
        },
      });
      eventIds.push(event.id);
    }
  });
  afterAll(async () => {
    await prisma.event.deleteMany({ where: { id: { in: eventIds } } });
    await prisma.sportsLeague.deleteMany({ where: { id: { in: leagueIds } } });
    if (creatorId) await prisma.user.delete({ where: { id: creatorId } });
  });
  it('finds the minor event beyond the unfiltered query limit', async () => {
    const result = await listEventDiscoveryItems(prisma, {
      surface: 'map',
      level: 'minor',
      limit: 1,
      now,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: eventIds[3], league_level: 'minor' });
    const other = await listEventDiscoveryItems(prisma, {
      surface: 'map',
      level: 'other',
      limit: 1,
      now,
    });
    expect(other.items.every(item => !eventIds.includes(item.id))).toBe(true);
  });
  it('rejects unsupported league filters without exposing internals', async () => {
    const response = await request(app).get('/event-discovery?surface=map&level=invalid');
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).not.toMatch(/Prisma|stack|node_modules/);
  });
});
