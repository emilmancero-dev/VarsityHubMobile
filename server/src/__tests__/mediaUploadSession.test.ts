import crypto from 'node:crypto';
import { beforeEach, afterAll, describe, expect, it, jest } from '@jest/globals';
const findFirst = jest.fn<any>();
const updateMany = jest.fn<any>();
const originalApiBase = process.env.API_BASE_URL;
const originalRailwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
const provider = jest.fn<any>();
const originalFetch = global.fetch;
jest.unstable_mockModule('../lib/prisma.js', () => ({
  prisma: { mediaUpload: { findFirst, updateMany } },
}));
jest.unstable_mockModule('../lib/cloudinary.js', () => ({
  getCloudinaryCredentials: () => ({
    cloudName: 'test-cloud',
    apiKey: 'test-key',
    apiSecret: 'test-secret',
  }),
  getCloudinaryFolder: () => 'varsityhub/test',
}));
jest.unstable_mockModule('../lib/circuitBreaker.js', () => ({
  runWithBreaker: async (_name: string, fn: () => Promise<any>) => fn(),
}));
const { validateUploadedVideo, videoDeliveryUrls, completeVideoUpload } =
  await import('../lib/mediaUploadSession.js');
beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = provider as any;
  updateMany.mockReset().mockResolvedValue({ count: 1 });
  delete process.env.API_BASE_URL;
  delete process.env.RAILWAY_PUBLIC_DOMAIN;
});
afterAll(() => {
  global.fetch = originalFetch;
  if (originalApiBase === undefined) delete process.env.API_BASE_URL;
  else process.env.API_BASE_URL = originalApiBase;
  if (originalRailwayDomain === undefined) delete process.env.RAILWAY_PUBLIC_DOMAIN;
  else process.env.RAILWAY_PUBLIC_DOMAIN = originalRailwayDomain;
});

describe('verified video completion', () => {
  const session = { public_id: 'varsityhub/test/media/abc', expected_bytes: 1234 };
  const resource = {
    public_id: session.public_id,
    resource_type: 'video',
    bytes: 1234,
    duration: 20,
    width: 1920,
    height: 1080,
    version: 12,
    format: 'mov',
  };
  it('accepts only the expected complete video', () => {
    expect(() => validateUploadedVideo(session, resource)).not.toThrow();
  });
  it('accepts mux padding at the nominal 90-second trim limit', () => {
    expect(() => validateUploadedVideo(session, { ...resource, duration: 90.1 })).not.toThrow();
  });
  it.each([
    { public_id: 'another-owner/asset' },
    { bytes: 1 },
    { bytes: 200000000 },
    { duration: 91 },
    { duration: 90.251 },
    { duration: undefined },
    { resource_type: 'image' },
    { width: 0 },
    { version: undefined },
  ])('rejects mismatched or unverified provider metadata %p', change => {
    expect(() => validateUploadedVideo(session, { ...resource, ...change })).toThrow();
  });
  it('pins delivery codec and creates versioned MP4, HLS and still poster URLs', () => {
    const urls = videoDeliveryUrls('our-cloud', resource);
    expect(urls.url).toContain('vc_h264,ac_aac,f_mp4');
    expect(urls.url).toContain('/v12/varsityhub/test/media/abc.mp4');
    expect(urls.url).toContain('c_limit,w_1920,h_1920');
    expect(urls.streaming_url).toContain('/sp_full_hd/v12/');
    expect(urls.poster_url).toContain('/so_0,w_480,f_jpg/');
  });
});

describe('provider completion service', () => {
  const id = 'a'.repeat(64);
  const uploaded = {
    public_id: 'varsityhub/test/media/abc',
    bytes: 1234,
    resource_type: 'video',
    duration: 20,
    width: 1920,
    height: 1080,
    version: 12,
    format: 'mov',
  };
  const result = videoDeliveryUrls('test-cloud', uploaded);
  const session = { id, owner_id: 'owner', public_id: uploaded.public_id, expected_bytes: 1234 };
  it.each([404, 423])('treats rendition status %s as pending rather than failed', async status => {
    findFirst.mockResolvedValue({ ...session, state: 'processing', result });
    provider.mockResolvedValue({ ok: false, status });
    await expect(completeVideoUpload('owner', id)).resolves.toEqual({ state: 'processing' });
    expect(updateMany).not.toHaveBeenCalled();
    expect(provider).toHaveBeenCalledTimes(3);
  });
  it('only declares ready once every rendition responds successfully', async () => {
    findFirst.mockResolvedValue({ ...session, state: 'processing', result });
    provider.mockResolvedValue({ ok: true, status: 200 });
    await expect(completeVideoUpload('owner', id)).resolves.toEqual({ state: 'ready', result });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id, state: 'processing' },
      data: { state: 'ready' },
    });
    expect(provider.mock.calls.map(([url]) => url)).toEqual([
      result.url,
      result.streaming_url,
      result.poster_url,
    ]);
  });
  it('never returns ready while even one rendition is pending', async () => {
    findFirst.mockResolvedValue({ ...session, state: 'processing', result });
    provider
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: false, status: 423 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    await expect(completeVideoUpload('owner', id)).resolves.toEqual({ state: 'processing' });
    expect(updateMany).not.toHaveBeenCalled();
  });
  it('verifies metadata before requesting billable transformations', async () => {
    findFirst.mockResolvedValue({ ...session, state: 'uploading' });
    provider.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ...uploaded, bytes: 1 }),
    });
    await expect(completeVideoUpload('owner', id)).rejects.toMatchObject({ status: 422 });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { state: 'uploading' } })
    );
  });
  it('schedules processing after validating the complete provider asset', async () => {
    findFirst.mockResolvedValue({ ...session, state: 'uploading' });
    provider
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => uploaded })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    await expect(completeVideoUpload('owner', id)).resolves.toEqual({ state: 'processing' });
    const body = provider.mock.calls[1][1].body as URLSearchParams;
    expect(body.get('public_id')).toBe(session.public_id);
    expect(body.get('eager_async')).toBe('true');
    expect(body.get('eager')).toContain('sp_full_hd/m3u8');
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: 'processing' }) })
    );
  });
  it('owner-scopes lookup and performs no provider call for missing sessions', async () => {
    findFirst.mockResolvedValue(null);
    await expect(completeVideoUpload('other', id)).rejects.toMatchObject({ status: 404 });
    expect(findFirst).toHaveBeenCalledWith({ where: { id, owner_id: 'other' } });
    expect(provider).not.toHaveBeenCalled();
  });
  it('returns persisted ready results without new provider requests', async () => {
    findFirst.mockResolvedValue({ ...session, state: 'ready', result });
    await expect(completeVideoUpload('owner', id)).resolves.toEqual({ state: 'ready', result });
    expect(provider).not.toHaveBeenCalled();
  });
  it('waits for the signed webhook before making early CDN requests', async () => {
    findFirst.mockResolvedValue({
      ...session,
      state: 'processing',
      result: { ...result, webhook_expected: true },
      updated_at: new Date(),
    });
    await expect(completeVideoUpload('owner', id)).resolves.toEqual({ state: 'processing' });
    expect(provider).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });
  it('includes the callback URL in the signed explicit parameters and persists it before dispatch', async () => {
    process.env.API_BASE_URL = 'https://api.test';
    findFirst.mockResolvedValue({ ...session, state: 'uploading' });
    provider
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => uploaded })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    await completeVideoUpload('owner', id);
    // Cloudinary omits duration unless detailed media metadata is requested.
    expect(provider.mock.calls[0][0]).toContain('?media_metadata=true');
    const body = provider.mock.calls[1][1].body as URLSearchParams;
    expect(body.get('eager_notification_url')).toBe(
      `https://api.test/webhooks/media/cloudinary/${id}`
    );
    expect(body.get('eager')).toMatch(/\/mp4\|sp_full_hd\/m3u8\|so_0,w_480,f_jpg\/jpg$/);
    const signedFields = [...body.entries()]
      .filter(([key]) => !['api_key', 'signature'].includes(key))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}=${value}`)
      .join('&');
    expect(body.get('signature')).toBe(
      crypto
        .createHash('sha1')
        .update(signedFields + 'test-secret')
        .digest('hex')
    );
    expect(updateMany.mock.calls[1][0].data.result.webhook_expected).toBe(true);
    expect(updateMany.mock.invocationCallOrder[1]).toBeLessThan(
      provider.mock.invocationCallOrder[1]
    );
  });
  it('does not dispatch provider processing when another caller owns the lease', async () => {
    findFirst.mockResolvedValue({ ...session, state: 'uploading' });
    updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(completeVideoUpload('owner', id)).resolves.toEqual({ state: 'processing' });
    expect(provider).not.toHaveBeenCalled();
  });
  it('does not dispatch if its lease was lost before metadata persistence', async () => {
    findFirst.mockResolvedValue({ ...session, state: 'uploading' });
    updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    provider.mockResolvedValueOnce({ ok: true, status: 200, json: async () => uploaded });
    await expect(completeVideoUpload('owner', id)).resolves.toEqual({ state: 'processing' });
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it('returns verified readiness immediately when the callback wins the explicit-response race', async () => {
    findFirst
      .mockResolvedValueOnce({ ...session, state: 'uploading' })
      .mockResolvedValueOnce({ ...session, state: 'ready', result });
    provider
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => uploaded })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    await expect(completeVideoUpload('owner', id)).resolves.toEqual({ state: 'ready', result });
    expect(provider).toHaveBeenCalledTimes(2);
  });
  it.each(['TimeoutError', 'AbortError'])(
    'keeps optional rendition checks pending on %s',
    async name => {
      findFirst.mockResolvedValue({ ...session, state: 'processing', result });
      provider
        .mockRejectedValueOnce(Object.assign(new Error('transport timeout'), { name }))
        .mockResolvedValueOnce({ ok: true, status: 200 })
        .mockResolvedValueOnce({ ok: true, status: 200 });
      await expect(completeVideoUpload('owner', id)).resolves.toEqual({ state: 'processing' });
      expect(updateMany).not.toHaveBeenCalled();
    }
  );
  it('does not hide a permanent provider rejection behind a parallel timeout', async () => {
    findFirst.mockResolvedValue({ ...session, state: 'processing', result });
    provider
      .mockRejectedValueOnce(
        Object.assign(new Error('transport timeout'), { name: 'TimeoutError' })
      )
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    await expect(completeVideoUpload('owner', id)).rejects.toMatchObject({ status: 503 });
    expect(updateMany).not.toHaveBeenCalled();
  });
  it('still fails authoritative metadata retrieval on timeout', async () => {
    findFirst.mockResolvedValue({ ...session, state: 'uploading' });
    provider.mockRejectedValueOnce(
      Object.assign(new Error('transport timeout'), { name: 'TimeoutError' })
    );
    await expect(completeVideoUpload('owner', id)).rejects.toMatchObject({ name: 'TimeoutError' });
  });
});
