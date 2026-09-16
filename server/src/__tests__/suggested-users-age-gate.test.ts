import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';
import { app } from '../testApp.js';
import { prisma } from '../lib/prisma.js';
import { signJwt } from '../lib/jwt.js';

describe('suggestions preserve adult discovery and privacy gates', () => {
  const ids: string[] = [];
  const prefix = `suggested-age-${Date.now()}`;
  let token: string;
  let adult: string;
  const excluded: string[] = [];

  async function user(name: string, dob: Date | null, preferences = {}) {
    const result = await prisma.user.create({
      data: {
        email: `${prefix}-${name}@example.com`,
        display_name: name,
        date_of_birth: dob,
        email_verified: true,
        onboarding_completed: true,
        role: 'fan',
        preferences,
      },
    });
    ids.push(result.id);
    return result;
  }

  beforeAll(async () => {
    const viewer = await user('viewer', new Date('1990-01-01'));
    token = signJwt({ id: viewer.id });
    adult = (await user('adult', new Date('1990-01-01'))).id;
    const unknown = await user('unknown', null);
    const minor = await user('minor', new Date(`${new Date().getUTCFullYear() - 15}-01-01`));
    const privateAdult = await user('private', new Date('1990-01-01'), { profile_private: true });
    const blocked = await user('blocked', new Date('1990-01-01'));
    const blockedBy = await user('blocked-by', new Date('1990-01-01'));
    await prisma.blockedUser.createMany({
      data: [
        { blocker_id: viewer.id, blocked_id: blocked.id },
        { blocker_id: blockedBy.id, blocked_id: viewer.id },
      ],
    });
    excluded.push(viewer.id, unknown.id, minor.id, privateAdult.id, blocked.id, blockedBy.id);
  });

  afterAll(async () => {
    await prisma.blockedUser.deleteMany({ where: { blocker_id: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });

  it('returns a known adult without suggesting unknown-age, minor, blocked or private users', async () => {
    // Exercise real SQL eligibility/privacy against this fixture cohort. The
    // shared database may contain >50 equally ranked users from other suites;
    // whether our adult wins that unrelated ranking is not the age contract.
    const findMany = prisma.user.findMany.bind(prisma.user);
    const candidates = jest.spyOn(prisma.user, 'findMany').mockImplementation((args: any) => {
      if (args?.take === 50 && args?.select?.date_of_birth === true) {
        return findMany({ ...args, where: { AND: [args.where, { id: { in: ids } }] } });
      }
      return findMany(args);
    });
    try {
      const response = await request(app)
        .get('/users/me/suggested?limit=20')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      const suggested = response.body.items.map((item: { id: string }) => item.id);
      expect(suggested).toContain(adult);
      for (const id of excluded) expect(suggested).not.toContain(id);
      expect(response.body.items.every((item: object) => !('date_of_birth' in item))).toBe(true);
    } finally {
      candidates.mockRestore();
    }
  });
});
