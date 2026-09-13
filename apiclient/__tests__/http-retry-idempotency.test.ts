/**
 * Non-idempotent requests must never be auto-retried on timeout/network error —
 * a timed-out POST may have been processed server-side (e.g. verification email
 * already sent); retrying duplicates the mutation.
 *
 * httpPost() itself already defaults to retries=0 (see http.ts), so it can't
 * exercise the retry-gating logic directly. The actual defect lives in
 * request()'s AbortError/network-error branches, which retried on
 * `retries > 0` alone regardless of HTTP method. httpPostWithOptions(...,
 * retries=1) is used below to drive a POST through those branches with a
 * nonzero retry budget, matching how a future/real call site could invoke it.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../auth', () => ({
  __esModule: true,
  auth: {
    getToken: jest.fn(async () => 'test-token'),
    refreshToken: jest.fn(async () => ({
      accessToken: 'refreshed-token',
      reason: 'success' as const,
    })),
    clearTokensOnly: jest.fn(async () => undefined),
  },
}));

jest.mock('@/hooks/useVerificationGate', () => ({
  openVerificationGate: jest.fn(async () => false),
  isEmailVerificationRequiredError: () => false,
}));

describe('http retry idempotency', () => {
  const fetchMock = jest.fn() as any;

  beforeEach(() => {
    jest.resetModules();
    fetchMock.mockReset();
    (global as any).fetch = fetchMock;
  });

  afterEach(() => {
    delete (global as any).fetch;
    jest.restoreAllMocks();
  });

  it('propagates explicit cancellation without retry or timeout conversion', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          );
          controller.abort();
        })
    );
    const { httpPostWithOptions } = await import('../http');
    await expect(
      httpPostWithOptions('/uploads/video-sessions', {}, 100, 1, undefined, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('keeps cancellation attached while reading the response body', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: () =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          );
          controller.abort();
        }),
    }));
    const { httpPostWithOptions } = await import('../http');
    await expect(
      httpPostWithOptions('/uploads/video-sessions', {}, 100, 0, undefined, controller.signal)
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('does NOT retry a POST that times out', async () => {
    const abortErr: any = new Error('Aborted');
    abortErr.name = 'AbortError';
    fetchMock.mockRejectedValue(abortErr);

    const { httpPostWithOptions } = await import('../http');
    await expect(
      httpPostWithOptions('/auth/request-verification', {}, 1000, 1)
    ).rejects.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a POST on a network error', async () => {
    fetchMock.mockRejectedValue(new Error('Network request failed'));

    const { httpPostWithOptions } = await import('../http');
    await expect(httpPostWithOptions('/posts', {}, 1000, 1)).rejects.toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still retries a GET that times out', async () => {
    const abortErr: any = new Error('Aborted');
    abortErr.name = 'AbortError';
    fetchMock.mockRejectedValue(abortErr);

    const { httpGet } = await import('../http');
    await expect(httpGet('/highlights')).rejects.toBeTruthy();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });
});
