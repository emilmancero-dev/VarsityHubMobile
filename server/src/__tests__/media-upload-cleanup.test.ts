import { beforeEach, expect, it, jest } from '@jest/globals';

const findMany = jest.fn<(...args: any[]) => Promise<any[]>>();
const updateMany = jest.fn<(...args: any[]) => Promise<{ count: number }>>();
const destroy = jest.fn<(...args: any[]) => Promise<{ ok: boolean; error?: string }>>();
jest.unstable_mockModule('../lib/prisma.js', () => ({
  prisma: { mediaUpload: { findMany, updateMany } },
}));
jest.unstable_mockModule('../lib/cloudinary.js', () => ({ destroyCloudinaryAsset: destroy }));
jest.unstable_mockModule('../lib/sentry.js', () => ({ captureException: jest.fn() }));
const { cleanupAbandonedMediaUploads } = await import('../lib/mediaUploadCleanup.js');

const now = new Date('2026-09-09T12:00:00Z');
const candidate = {
  id: 'session',
  public_id: 'videos/session',
  state: 'uploading',
  updated_at: new Date('2026-09-01'),
};
beforeEach(() => {
  findMany.mockReset().mockResolvedValue([candidate]);
  updateMany.mockReset().mockResolvedValue({ count: 1 });
  destroy.mockReset().mockResolvedValue({ ok: true });
});

it('bounds the sweep and excludes ready/published and recent sessions', async () => {
  await cleanupAbandonedMediaUploads(now);
  expect(findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: {
        state: { in: ['uploading', 'verifying', 'processing', 'failed', 'expiring'] },
        created_at: { lt: new Date('2026-09-07T12:00:00Z') },
      },
      take: 100,
    })
  );
  expect(destroy).toHaveBeenCalledWith('videos/session', 'video');
  expect(updateMany.mock.calls[0][0]).toMatchObject({
    where: { id: 'session', state: 'uploading', updated_at: candidate.updated_at },
    data: { state: 'expiring' },
  });
  expect(updateMany.mock.calls[1][0]).toMatchObject({
    where: { id: 'session', state: 'expiring' },
    data: { state: 'expired' },
  });
});

it('never deletes an asset that won the race to ready', async () => {
  updateMany.mockResolvedValueOnce({ count: 0 });
  expect(await cleanupAbandonedMediaUploads(now)).toEqual({ checked: 1, expired: 0 });
  expect(destroy).not.toHaveBeenCalled();
});

it('keeps expiring after failed deletion and retries it on the next sweep', async () => {
  destroy.mockResolvedValueOnce({ ok: false, error: 'network unavailable' });
  await expect(cleanupAbandonedMediaUploads(now)).rejects.toThrow('retry queued');
  expect(updateMany).toHaveBeenCalledTimes(1);
  findMany.mockResolvedValue([{ ...candidate, state: 'expiring' }]);
  expect(await cleanupAbandonedMediaUploads(now)).toEqual({ checked: 1, expired: 1 });
  expect(destroy).toHaveBeenCalledTimes(2);
});

it('continues processing the bounded batch after one provider failure', async () => {
  findMany.mockResolvedValue([
    candidate,
    { ...candidate, id: 'second', public_id: 'videos/second' },
  ]);
  destroy.mockRejectedValueOnce(new Error('provider offline'));
  await expect(cleanupAbandonedMediaUploads(now)).rejects.toThrow('1 session');
  expect(destroy).toHaveBeenCalledTimes(2);
  expect(updateMany).toHaveBeenLastCalledWith(
    expect.objectContaining({
      where: { id: 'second', state: 'expiring' },
      data: expect.objectContaining({ state: 'expired' }),
    })
  );
});
