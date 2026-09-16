/**
 * API Integration Tests for Uploads Endpoints
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { describeDb } from './helpers/dbTestSuite.js';
import bcrypt from 'bcrypt';
import request from 'supertest';
import { app } from '../testApp.js';

let prisma: any;
let signJwt: any;

describeDb('Uploads API Endpoints', () => {
  let testUser: any;
  let testUserToken: string;
  let unverifiedUser: any;
  let unverifiedUserToken: string;
  let ownedAd: any;
  let foreignAd: any;

  beforeAll(async () => {
    ({ prisma } = await import('../lib/prisma.js'));
    ({ signJwt } = await import('../lib/jwt.js'));
    testUser = await prisma.user.create({
      data: {
        email: `test-uploads-${Date.now()}@example.com`,
        password_hash: await bcrypt.hash('TestPassword123!', 10),
        display_name: 'Upload Tester',
        email_verified: true,
        preferences: { role: 'fan', onboarding_completed: true },
      },
    });
    testUserToken = signJwt({ id: testUser.id });
    unverifiedUser = await prisma.user.create({
      data: {
        email: `test-unverified-uploads-${Date.now()}@example.com`,
        password_hash: await bcrypt.hash('TestPassword123!', 10),
        display_name: 'Unverified Upload Tester',
        email_verified: false,
        preferences: { role: 'fan', onboarding_completed: false },
      },
    });
    unverifiedUserToken = signJwt({ id: unverifiedUser.id });
    ownedAd = await prisma.ad.create({
      data: {
        user_id: unverifiedUser.id,
        business_name: 'Owned Ad Banner Upload',
        contact_email: unverifiedUser.email,
        target_zip_code: '10001',
        status: 'draft',
        payment_status: 'unpaid',
      },
    });
    foreignAd = await prisma.ad.create({
      data: {
        user_id: testUser.id,
        business_name: 'Foreign Ad Banner Upload',
        contact_email: testUser.email,
        target_zip_code: '10002',
        status: 'draft',
        payment_status: 'unpaid',
      },
    });
  });

  afterAll(async () => {
    await prisma.ad
      .deleteMany({
        where: { id: { in: [ownedAd?.id, foreignAd?.id].filter(Boolean) } },
      })
      .catch(() => {});
    await prisma.user.deleteMany({ where: { id: testUser.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: unverifiedUser.id } }).catch(() => {});
  });

  describe('POST /uploads', () => {
    it('should require authentication', async () => {
      const res = await request(app).post('/uploads');
      expect(res.statusCode).toEqual(401);
    });

    it('allows unverified users through (verification bypassed for onboarding uploads)', async () => {
      // POST /uploads intentionally bypasses email verification so unverified
      // users can upload during onboarding. Without a file the handler returns 400.
      const res = await request(app)
        .post('/uploads')
        .set('Authorization', `Bearer ${unverifiedUserToken}`);
      expect(res.statusCode).toEqual(400);
      expect(res.body.error).toEqual('No file uploaded');
    });

    it('should reject unverified ad-banner uploads for ads the caller does not own', async () => {
      const res = await request(app)
        .post(`/uploads?purpose=ad_banner&ad_id=${foreignAd.id}`)
        .set('Authorization', `Bearer ${unverifiedUserToken}`);
      expect(res.statusCode).toEqual(403);
      expect(res.body.error).toEqual('Ad banner upload requires an ad you own');
    });
  });

  describe('POST /uploads/files', () => {
    it('should require authentication', async () => {
      const res = await request(app).post('/uploads/files');
      expect(res.statusCode).toEqual(401);
    });

    it('should require verified email', async () => {
      const res = await request(app)
        .post('/uploads/files')
        .set('Authorization', `Bearer ${unverifiedUserToken}`);
      expect(res.statusCode).toEqual(403);
      expect(res.body.error).toEqual('Email verification required');
    });
  });

  describe('GET /uploads/cloudinary-signature', () => {
    it('should require authentication', async () => {
      const res = await request(app).get('/uploads/cloudinary-signature');
      expect(res.statusCode).toEqual(401);
    });

    it('allows unverified users through (verification bypassed for onboarding uploads)', async () => {
      // GET /cloudinary-signature intentionally bypasses email verification.
      // In test environment Cloudinary is not configured so we get 503.
      const res = await request(app)
        .get('/uploads/cloudinary-signature')
        .set('Authorization', `Bearer ${unverifiedUserToken}`);
      expect([200, 503]).toContain(res.statusCode);
    });

    it('should allow unverified ad-banner signatures for caller-owned ads only', async () => {
      const res = await request(app)
        .get(`/uploads/cloudinary-signature?purpose=ad_banner&ad_id=${ownedAd.id}`)
        .set('Authorization', `Bearer ${unverifiedUserToken}`);

      expect([200, 503]).toContain(res.statusCode);
      if (res.statusCode === 503) {
        expect(res.body.error).toBe('Uploads are temporarily unavailable. Please try again later.');
      }
    });
  });

  describe('GET /uploads/sign', () => {
    it('should require authentication', async () => {
      const res = await request(app).get('/uploads/sign?path=/uploads/test.png');
      expect(res.statusCode).toEqual(401);
    });

    it('should return signed URL for authenticated users', async () => {
      const res = await request(app)
        .get('/uploads/sign?path=/uploads/test.png')
        .set('Authorization', `Bearer ${testUserToken}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body.token).toBeDefined();
      expect(res.body.exp).toBeDefined();
      expect(res.body.signed_url).toContain('/uploads/test.png');
    });

    it('should reject invalid paths', async () => {
      const res = await request(app)
        .get('/uploads/sign?path=../secrets.txt')
        .set('Authorization', `Bearer ${testUserToken}`);
      expect(res.statusCode).toEqual(400);
    });
  });
});
