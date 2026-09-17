import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import request from 'supertest';
import { app } from '../testApp.js';
import { prisma } from '../lib/prisma.js';
import { signJwt } from '../lib/jwt.js';
import { invalidatePrivateIdsCache } from '../lib/privacyUtils.js';

describe('suggested users age restrictions', () => {
  const ids: string[] = [];
  const users: Record<string, any> = {};
  const run = `${Date.now()}`;
  beforeAll(async () => {
    for (const name of [
      'viewer',
      'teenViewer',
      'adult',
      'minor',
      'unknown',
      'blocked',
      'private',
      'banned',
      'deleted',
      'birthday',
      'tomorrow',
    ]) {
      const now = new Date();
      const birthday = new Date(
        Date.UTC(now.getUTCFullYear() - 18, now.getUTCMonth(), now.getUTCDate())
      );
      const tomorrow = new Date(birthday);
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      users[name] = await prisma.user.create({
        data: {
          email: `suggest-${run}-${name}@example.com`,
          display_name: name,
          email_verified: true,
          onboarding_completed: true,
          approval_status: 'APPROVED',
          role: 'fan',
          date_of_birth:
            name === 'unknown'
              ? null
              : name === 'birthday'
                ? birthday
                : name === 'tomorrow'
                  ? tomorrow
                  : ['minor', 'teenViewer'].includes(name)
                    ? new Date(Date.UTC(now.getUTCFullYear() - 16, 0, 1))
                    : new Date('1990-01-01'),
          banned: name === 'banned',
          deleted_at: name === 'deleted' ? new Date() : null,
          preferences: {
            role: 'fan',
            onboarding_completed: true,
            profile_private: name === 'private',
          },
        },
      });
      ids.push(users[name].id);
    }
    for (const viewer of ['viewer', 'teenViewer']) {
      await prisma.blockedUser.create({
        data: { blocker_id: users[viewer].id, blocked_id: users.blocked.id },
      });
    }
    // Give this run's candidates a deterministic rank above unrelated fixture
    // accounts retained by other suites in the disposable audit database.
    for (let index = 0; index < 5; index += 1) {
      const supporter = await prisma.user.create({
        data: {
          email: `suggest-${run}-supporter-${index}@example.com`,
        },
      });
      ids.push(supporter.id);
      await prisma.follows.createMany({
        data: Object.values(users).map(candidate => ({
          follower_id: supporter.id,
          following_id: candidate.id,
          status: 'accepted',
        })),
      });
    }
    invalidatePrivateIdsCache();
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    invalidatePrivateIdsCache();
  });

  it.each(['viewer', 'teenViewer'])(
    'only suggests known adults to %s without exposing age fields',
    async viewer => {
      const response = await request(app)
        .get('/users/me/suggested?limit=20')
        .set('Authorization', `Bearer ${signJwt({ id: users[viewer].id })}`)
        .expect(200);
      const returned = response.body.items.map((row: any) => row.id);
      expect(returned).toContain(users.adult.id);
      expect(returned).toContain(users.birthday.id);
      for (const name of [
        'minor',
        'unknown',
        'blocked',
        'private',
        'banned',
        'deleted',
        'tomorrow',
      ]) {
        expect(returned).not.toContain(users[name].id);
      }
      for (const row of response.body.items) expect(row).not.toHaveProperty('date_of_birth');
    }
  );
});
