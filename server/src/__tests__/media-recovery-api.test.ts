import { afterAll, beforeAll, expect, it, jest } from '@jest/globals';
import request from 'supertest';
import crypto from 'node:crypto';
import { app } from '../testApp.js';
import { describeDb } from './helpers/dbTestSuite.js';

let prisma: any;
let token: string;
let owner: string;
const originalCloud = [
  process.env.CLOUDINARY_CLOUD_NAME,
  process.env.CLOUDINARY_API_KEY,
  process.env.CLOUDINARY_API_SECRET,
];
describeDb('Media recovery API', () => {
  beforeAll(async () => {
    ({ prisma } = await import('../lib/prisma.js'));
    const { signJwt } = await import('../lib/jwt.js');
    const user = await prisma.user.create({
      data: {
        email: `recovery-${crypto.randomUUID()}@example.test`,
        email_verified: true,
        onboarding_completed: true,
        role: 'fan',
        preferences: { role: 'fan', onboarding_completed: true },
      },
    });
    owner = user.id;
    token = signJwt({ id: owner });
    process.env.CLOUDINARY_CLOUD_NAME = 'recovery-test-cloud';
    process.env.CLOUDINARY_API_KEY = 'recovery-test-key';
    process.env.CLOUDINARY_API_SECRET = 'recovery-test-secret';
  });
  afterAll(async () => {
    if (owner) {
      await prisma.post.deleteMany({ where: { author_id: owner } });
      await prisma.mediaUpload.deleteMany({ where: { owner_id: owner } });
      await prisma.user.delete({ where: { id: owner } });
    }
    ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'].forEach((key, i) => {
      if (originalCloud[i] === undefined) delete process.env[key];
      else process.env[key] = originalCloud[i];
    });
  });
  const send = (path: string, body: any) =>
    request(app).post(path).set('Authorization', `Bearer ${token}`).send(body);
  it('replays the exact post and rejects a changed request', async () => {
    const payload = { content: 'Reliable recovery', client_request_id: crypto.randomUUID() };
    const first = await send('/posts', payload);
    expect(first.status).toBe(201);
    const replay = await send('/posts', payload);
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);
    expect((await send('/posts', { ...payload, content: 'Changed' })).status).toBe(409);
    expect(await prisma.post.count({ where: { author_id: owner } })).toBe(1);
  });
  it('concurrent retries commit one post', async () => {
    const payload = { content: 'Concurrent recovery', client_request_id: crypto.randomUUID() };
    const results = await Promise.all([send('/posts', payload), send('/posts', payload)]);
    expect(results.map(result => result.status).sort()).toEqual([200, 201]);
    expect(results[0].body.id).toBe(results[1].body.id);
    expect(await prisma.post.count({ where: { id: results[0].body.id } })).toBe(1);
  });
  it('requires a ready owned session and exact canonical URL, then trusts provider metadata', async () => {
    const id = crypto.randomBytes(32).toString('hex');
    const url = `https://res.cloudinary.com/recovery-test-cloud/video/upload/v1/media/${id}.mp4`;
    const result = {
      url,
      poster_url: `https://res.cloudinary.com/recovery-test-cloud/video/upload/so_0/v1/media/${id}.jpg`,
      width: 1280,
      height: 720,
      bytes: 100,
      duration: 5,
    };
    await prisma.mediaUpload.create({
      data: {
        id,
        owner_id: owner,
        public_id: `media/${id}`,
        content_type: 'video/mp4',
        expected_bytes: 100,
        state: 'processing',
        result,
      },
    });
    const post = (media_url = url) =>
      send('/posts', {
        content: 'Verified media',
        media_url,
        media_width: 1,
        client_request_id: crypto.randomUUID(),
      });
    expect((await post()).status).toBe(422);
    await prisma.mediaUpload.update({
      where: { id },
      data: { state: 'ready', owner_id: 'foreign-owner' },
    });
    expect((await post()).status).toBe(422);
    await prisma.mediaUpload.update({ where: { id }, data: { owner_id: owner } });
    expect((await post(url.replace('/v1/', '/q_1/v1/'))).status).toBe(422);
    const created = await post();
    expect(created.status).toBe(201);
    expect(created.body.media_width).toBe(1280);
    expect(created.body.poster_url).toBe(result.poster_url);
  });
  it('enforces ready owned session media on both story write paths', async () => {
    const game = await prisma.game.create({
      data: {
        title: 'Recovery demo',
        description: '[DEMO_MATCHUP]',
        date: new Date(),
        location: 'Test',
        approval_status: 'approved',
      },
      select: { id: true },
    });
    const event = await prisma.event.create({
      data: {
        title: 'Recovery demo event',
        description: '[DEMO_MATCHUP]',
        date: new Date(),
        location: 'Test',
        approval_status: 'approved',
        status: 'approved',
        creator_id: owner,
      },
      select: { id: true },
    });
    const id = crypto.randomBytes(32).toString('hex');
    const url = `https://res.cloudinary.com/recovery-test-cloud/video/upload/v1/media/${id}.mp4`;
    await prisma.mediaUpload.create({
      data: {
        id,
        owner_id: owner,
        public_id: `media/${id}`,
        content_type: 'video/mp4',
        expected_bytes: 100,
        state: 'processing',
        result: { url },
      },
    });
    try {
      for (const path of [`/games/${game.id}/stories`, `/events/${event.id}/stories`]) {
        expect((await send(path, { media_url: url })).status).toBe(422);
      }
      await prisma.mediaUpload.update({
        where: { id },
        data: { state: 'ready', owner_id: 'foreign-owner' },
      });
      for (const path of [`/games/${game.id}/stories`, `/events/${event.id}/stories`]) {
        expect((await send(path, { media_url: url })).status).toBe(422);
      }
    } finally {
      await prisma.mediaUpload.delete({ where: { id } });
      await prisma.event.delete({ where: { id: event.id }, select: { id: true } });
      await prisma.game.delete({ where: { id: game.id }, select: { id: true } });
    }
  });
  it('enforces the nominal 20-second story cap with 250ms mux tolerance on both endpoints', async () => {
    const game = await prisma.game.create({
      data: {
        title: 'Duration demo',
        description: '[DEMO_MATCHUP]',
        date: new Date(),
        location: 'Test',
        approval_status: 'approved',
      },
      select: { id: true },
    });
    const event = await prisma.event.create({
      data: {
        title: 'Duration event',
        description: '[DEMO_MATCHUP]',
        date: new Date(),
        location: 'Test',
        approval_status: 'approved',
        status: 'approved',
        creator_id: owner,
      },
      select: { id: true },
    });
    const id = crypto.randomBytes(32).toString('hex');
    const url = `https://res.cloudinary.com/recovery-test-cloud/video/upload/v1/media/${id}.mp4`;
    const poster_url = `https://res.cloudinary.com/recovery-test-cloud/video/upload/so_0/v1/media/${id}.jpg`;
    await prisma.mediaUpload.create({
      data: {
        id,
        owner_id: owner,
        public_id: `media/${id}`,
        content_type: 'video/mp4',
        expected_bytes: 100,
        state: 'ready',
        result: { url, poster_url, duration: 20.1 },
      },
    });
    try {
      for (const duration of [20.251, 90]) {
        await prisma.mediaUpload.update({
          where: { id },
          data: { result: { url, poster_url, duration } },
        });
        for (const path of [`/games/${game.id}/stories`, `/events/${event.id}/stories`]) {
          for (const payload of [{ media_url: url }, { media_url: url, media_duration_s: 1 }]) {
            const rejected = await send(path, payload);
            expect(rejected.status).toBe(422);
            expect(rejected.body.code).toBe('MEDIA_DURATION_EXCEEDED');
          }
        }
      }
      expect(await prisma.story.count({ where: { user_id: owner } })).toBe(0);
      await prisma.mediaUpload.update({
        where: { id },
        data: { result: { url, poster_url, duration: 20.1 } },
      });
      for (const path of [`/games/${game.id}/stories`, `/events/${event.id}/stories`]) {
        expect((await send(path, { media_url: url })).status).toBe(201);
      }
    } finally {
      await prisma.story.deleteMany({ where: { user_id: owner } });
      await prisma.mediaUpload.delete({ where: { id } });
      await prisma.event.delete({ where: { id: event.id }, select: { id: true } });
      await prisma.game.delete({ where: { id: game.id }, select: { id: true } });
    }
  });
  it('replays story publication and collapses concurrent retries on game and event pages', async () => {
    const game = await prisma.game.create({
      data: {
        title: 'Story recovery',
        description: '[DEMO_MATCHUP]',
        date: new Date(),
        location: 'Test',
        approval_status: 'approved',
      },
      select: { id: true },
    });
    const event = await prisma.event.create({
      data: {
        title: 'Story event recovery',
        description: '[DEMO_MATCHUP]',
        date: new Date(),
        location: 'Test',
        approval_status: 'approved',
        status: 'approved',
        creator_id: owner,
      },
      select: { id: true },
    });
    try {
      for (const path of [`/games/${game.id}/stories`, `/events/${event.id}/stories`]) {
        const payload = {
          media_url: 'https://res.cloudinary.com/recovery-test-cloud/image/upload/v1/photo.jpg',
          client_request_id: crypto.randomUUID(),
        };
        const first = await send(path, payload);
        expect({ status: first.status, body: first.body }).toMatchObject({ status: 201 });
        const replay = await send(path, payload);
        expect(replay.status).toBe(200);
        expect(replay.body.id).toBe(first.body.id);
        expect((await send(path, { ...payload, caption: 'changed' })).status).toBe(409);
        const concurrentPayload = { ...payload, client_request_id: crypto.randomUUID() };
        const attempts = await Promise.all([
          send(path, concurrentPayload),
          send(path, concurrentPayload),
        ]);
        expect(attempts.map(item => item.status).sort()).toEqual([200, 201]);
        expect(attempts[0].body.id).toBe(attempts[1].body.id);
      }
      expect(await prisma.story.count({ where: { user_id: owner } })).toBe(4);
    } finally {
      await prisma.story.deleteMany({ where: { user_id: owner } });
      await prisma.event.delete({ where: { id: event.id }, select: { id: true } });
      await prisma.game.delete({ where: { id: game.id }, select: { id: true } });
    }
  });
  it('verifies raw webhook signatures and all derivatives without downgrading ready', async () => {
    const id = crypto.randomBytes(32).toString('hex');
    const publicId = `media/${id}`;
    const base = 'https://res.cloudinary.com/recovery-test-cloud/video/upload';
    const result = {
      url: `${base}/c_limit,w_1280/v1/${publicId}.mp4`,
      streaming_url: `${base}/sp_hd/v1/${publicId}.m3u8`,
      poster_url: `${base}/so_0,w_480/v1/${publicId}.jpg`,
    };
    await prisma.mediaUpload.create({
      data: {
        id,
        owner_id: owner,
        public_id: publicId,
        content_type: 'video/mp4',
        expected_bytes: 100,
        state: 'processing',
        result,
      },
    });
    const deliver = (data: any, age = 0, badSignature = false) => {
      const body = JSON.stringify(data);
      const timestamp = String(Math.floor(Date.now() / 1000) - age);
      const signature = crypto
        .createHash('sha1')
        .update(body + timestamp + 'recovery-test-secret')
        .digest('hex');
      return request(app)
        .post(`/webhooks/media/cloudinary/${id}`)
        .set('Content-Type', 'application/json')
        .set('X-Cld-Timestamp', timestamp)
        .set('X-Cld-Signature', badSignature ? '0'.repeat(40) : signature)
        .send(body);
    };
    const data = {
      public_id: publicId,
      resource_type: 'video',
      notification_type: 'eager',
      eager: Object.values(result).map(secure_url => ({ secure_url })),
    };
    const dbFailure = jest
      .spyOn(prisma.mediaUpload, 'findUnique')
      .mockRejectedValueOnce(new Error('database offline'));
    try {
      expect((await deliver(data)).status).toBe(503);
    } finally {
      dbFailure.mockRestore();
    }
    expect((await deliver(data, 0, true)).status).toBe(401);
    expect((await deliver(data, 4000)).status).toBe(401);
    expect((await deliver(data, -400)).status).toBe(401);
    expect((await deliver({ ...data, eager: data.eager.slice(0, 2) })).status).toBe(200);
    expect((await prisma.mediaUpload.findUnique({ where: { id } })).state).toBe('processing');
    expect((await deliver({ ...data, public_id: 'foreign' })).status).toBe(200);
    expect((await prisma.mediaUpload.findUnique({ where: { id } })).state).toBe('processing');
    data.eager[0].secure_url = data.eager[0].secure_url.replace('c_limit,w_1280', 'w_1280,c_limit');
    expect((await deliver(data)).status).toBe(200);
    expect((await prisma.mediaUpload.findUnique({ where: { id } })).state).toBe('ready');
    expect((await deliver({ ...data, error: { message: 'late failure' } })).status).toBe(200);
    expect((await prisma.mediaUpload.findUnique({ where: { id } })).state).toBe('ready');
    await prisma.mediaUpload.update({ where: { id }, data: { state: 'expiring' } });
    expect((await deliver(data)).status).toBe(200);
    expect((await prisma.mediaUpload.findUnique({ where: { id } })).state).toBe('expiring');
  });
  it('requires authentication for session creation and completion', async () => {
    expect((await request(app).post('/uploads/video-sessions').send({})).status).toBe(401);
    expect(
      (
        await request(app)
          .post(`/uploads/video-sessions/${'a'.repeat(64)}/complete`)
          .send({})
      ).status
    ).toBe(401);
  });
  it('initializes idempotently and refuses file changes and foreign completion', async () => {
    const payload = { id: crypto.randomUUID(), content_type: 'video/mp4', bytes: 100 };
    const first = await send('/uploads/video-sessions', payload);
    expect(first.status).toBe(200);
    const replay = await send('/uploads/video-sessions', payload);
    expect(replay.body.id).toBe(first.body.id);
    expect((await send('/uploads/video-sessions', { ...payload, bytes: 200 })).status).toBe(409);
    const foreignId = crypto.randomBytes(32).toString('hex');
    await prisma.mediaUpload.create({
      data: {
        id: foreignId,
        owner_id: 'foreign-owner',
        public_id: 'foreign',
        content_type: 'video/mp4',
        expected_bytes: 100,
      },
    });
    try {
      expect((await send(`/uploads/video-sessions/${foreignId}/complete`, {})).status).toBe(404);
    } finally {
      await prisma.mediaUpload.delete({ where: { id: foreignId } });
    }
  });
});
