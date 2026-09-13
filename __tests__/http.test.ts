/**
 * api/http.ts — transport-layer contract tests.
 *
 * Pins six behaviors that every screen depends on:
 *   - 401 triggers one refresh, then retries once
 *   - concurrent 401s share the same refresh promise (no double-refresh race)
 *   - in-flight GETs dedupe by URL+token
 *   - Railway HTML 502 classifies as infra error, not a parsed JSON app error
 *   - refresh failure with reason 'auth' or 'missing' clears session and throws SESSION_EXPIRED
 *   - timeout abort classifies as 408 with the canonical timeout message
 *
 * These are behavior pins. If a future refactor changes how the transport
 * layer handles any of them, the relevant case here fails. This file does
 * NOT specify new behavior — it only locks in what the code currently does
 * so the refactor can proceed safely.
 */

import { describe, expect, it, beforeEach, jest } from '@jest/globals';

type FetchFn = (input: any, init?: any) => Promise<any>;
type FetchMockFn = ReturnType<typeof jest.fn<FetchFn>>;

jest.mock('@/utils/sentry', () => ({
  captureBreadcrumb: jest.fn(),
  captureException: jest.fn(),
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: {} } },
  expoConfig: { extra: {} },
}));

// We mock the lazy-imported auth module. http.ts does
// `const { auth } = await import('./auth')` inside its 401 branch, which
// resolves (via the `@/` alias) to the same module we mock here.
const mockRefreshToken = jest.fn<(...args: any[]) => any>();
const mockClearTokensOnly = jest.fn<(...args: any[]) => any>();
const mockGetToken = jest.fn<(...args: any[]) => any>();
const mockEmitSessionExpired = jest.fn<(...args: any[]) => any>();

jest.mock('@/api/auth', () => ({
  auth: {
    refreshToken: (...args: any[]) => mockRefreshToken(...args),
    clearTokensOnly: (...args: any[]) => mockClearTokensOnly(...args),
    getToken: (...args: any[]) => mockGetToken(...args),
  },
}));

jest.mock('@/utils/sessionEvents', () => ({
  emitSessionExpired: (...args: any[]) => mockEmitSessionExpired(...args),
}));

// Silence __DEV__-gated logging.
(global as any).__DEV__ = false;

// Minimal fetch Response shape used across tests.
type FakeResponse = {
  ok: boolean;
  status: number;
  headers: { get: (k: string) => string | null };
  text: () => Promise<string>;
};

function mkJsonResponse(status: number, body: any): FakeResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null),
    },
    text: async () => text,
  };
}

function mkHtmlResponse(status: number, body: string): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k: string) => (k.toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null),
    },
    text: async () => body,
  };
}

/**
 * Each test loads a fresh copy of api/http so the module-level state
 * (refreshPromise, inflightGets, tokenCache) does not leak across tests.
 * Mock resets happen in beforeEach — freshHttp deliberately does not reset
 * them so the test body can configure refresh/clearTokens before loading.
 */
function freshHttp(fetchImpl: FetchMockFn) {
  jest.resetModules();
  (global as any).fetch = fetchImpl;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('@/api/http') as typeof import('@/api/http');
}

beforeEach(() => {
  jest.resetModules();
  mockRefreshToken.mockReset();
  mockClearTokensOnly.mockReset();
  mockClearTokensOnly.mockResolvedValue(undefined as any);
  mockGetToken.mockReset();
  mockGetToken.mockResolvedValue(null as any);
  mockEmitSessionExpired.mockReset();
});

describe('api/http — auth refresh', () => {
  it('hydrates the auth header from persisted storage when memory cache is empty', async () => {
    const fetchMock = jest
      .fn<(input: any, init?: any) => Promise<any>>()
      .mockResolvedValue(mkJsonResponse(200, { ok: true }));

    mockGetToken.mockResolvedValue('persisted-token' as any);

    const http = freshHttp(fetchMock);
    http.clearAuthToken();

    const result = await http.httpGet('/me', {}, undefined, 0);

    expect(result).toEqual({ ok: true });
    expect(mockGetToken).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0] as any[];
    const headers = (firstCall[1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer persisted-token');
  });

  it('omitAuthToken suppresses Authorization on auth-establishing requests even when a stale token exists', async () => {
    const fetchMock = jest
      .fn<(input: any, init?: any) => Promise<any>>()
      .mockResolvedValue(mkJsonResponse(200, { ok: true }));

    mockGetToken.mockResolvedValue('persisted-token' as any);

    const http = freshHttp(fetchMock);
    http.setAuthToken('stale-token');

    const result = await http.httpPost(
      '/auth/login',
      { email: 'user@example.com', password: 'pw' },
      { omitAuthToken: true, skipAuthRetry: true }
    );

    expect(result).toEqual({ ok: true });
    expect(mockGetToken).not.toHaveBeenCalled();
    const firstCall = fetchMock.mock.calls[0] as any[];
    const headers = (firstCall[1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('regular protected POST requests still send Authorization by default', async () => {
    const fetchMock = jest
      .fn<(input: any, init?: any) => Promise<any>>()
      .mockResolvedValue(mkJsonResponse(200, { ok: true }));

    const http = freshHttp(fetchMock);
    http.setAuthToken('live-token');

    const result = await http.httpPost('/auth/logout', { refresh_token: 'r1' });

    expect(result).toEqual({ ok: true });
    const firstCall = fetchMock.mock.calls[0] as any[];
    const headers = (firstCall[1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer live-token');
  });

  it('one 401 triggers one refresh attempt, then retries the request once', async () => {
    // First call: 401. After refresh, second call: 200.
    const fetchMock = jest
      .fn<(input: any, init?: any) => Promise<any>>()
      .mockResolvedValueOnce(mkJsonResponse(401, { error: 'expired' }))
      .mockResolvedValueOnce(mkJsonResponse(200, { hello: 'world' }));

    mockRefreshToken.mockResolvedValue({ accessToken: 'new-token', reason: 'success' } as any);

    const http = freshHttp(fetchMock);
    http.setAuthToken('stale-token');

    // Use retries=0 so the request function doesn't go into the 502/network
    // retry loop — we're isolating the 401 path.
    const result = await http.httpGet('/me', {}, undefined, 0);

    expect(result).toEqual({ hello: 'world' });
    expect(mockRefreshToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The retry must carry the refreshed token.
    const retryCall = fetchMock.mock.calls[1] as any[];
    const retryHeaders = (retryCall[1] as RequestInit).headers as Record<string, string>;
    expect(retryHeaders.Authorization).toBe('Bearer new-token');
  });

  it('concurrent 401s share the same refresh promise (no double-refresh race)', async () => {
    // Two parallel GETs both hit 401, then both retry with the refreshed token.
    // refresh should be invoked exactly once.
    const fetchMock = jest
      .fn<(input: any, init?: any) => Promise<any>>()
      .mockImplementation(async (url: string, init: any) => {
        const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
        if (auth === 'Bearer stale-token') return mkJsonResponse(401, { error: 'expired' });
        if (auth === 'Bearer new-token') {
          if (url.endsWith('/a')) return mkJsonResponse(200, { path: 'a' });
          if (url.endsWith('/b')) return mkJsonResponse(200, { path: 'b' });
        }
        return mkJsonResponse(500, { error: 'unexpected' });
      });

    // Resolve the refresh after a microtask to give both requests a chance
    // to reach the refresh-promise check before it resolves.
    mockRefreshToken.mockImplementation(
      () =>
        new Promise(res => {
          setImmediate(() => res({ accessToken: 'new-token', reason: 'success' }));
        })
    );

    const http = freshHttp(fetchMock);
    http.setAuthToken('stale-token');

    const [a, b] = await Promise.all([
      http.httpGet('/a', {}, undefined, 0),
      http.httpGet('/b', {}, undefined, 0),
    ]);

    expect(a).toEqual({ path: 'a' });
    expect(b).toEqual({ path: 'b' });

    // Both requests must have coalesced onto a single refresh attempt.
    expect(mockRefreshToken).toHaveBeenCalledTimes(1);
    // Four total fetches: 2 original 401s + 2 retries with new token.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  // Per fix 4a6a694e: when the refresh result is a clean auth failure, http
  // intentionally does NOT throw. It clears tokens, emits sessionExpired so
  // AuthProvider can route to /sign-in, and returns a never-resolving Promise
  // so per-screen catch blocks don't stack a native Error modal on top of
  // the redirect. These tests assert exactly that contract.
  // Regression: cross-account leak. The refresh result is cached for 5s so
  // sibling 401s on the same identity reuse it (see prior test). But the
  // cache MUST NOT survive a sign-in / sign-out — otherwise user B's first
  // 401 after switching accounts would reuse user A's cached refresh and
  // execute the retry under user A's token. clearAuthToken is the single
  // entry point used by sign-in (replaceSession), sign-out, and session-
  // expiry, so clearing the cache there covers every account-switch path.
  it('clearAuthToken invalidates the cached refresh promise so the next 401 forces a new refresh', async () => {
    const fetchMock = jest
      .fn<(input: any, init?: any) => Promise<any>>()
      .mockResolvedValueOnce(mkJsonResponse(401, { error: 'expired' })) // user A: original
      .mockResolvedValueOnce(mkJsonResponse(200, { who: 'a' })) // user A: retry
      .mockResolvedValueOnce(mkJsonResponse(401, { error: 'expired' })) // user B: original
      .mockResolvedValueOnce(mkJsonResponse(200, { who: 'b' })); // user B: retry

    mockRefreshToken
      .mockResolvedValueOnce({ accessToken: 'token-a', reason: 'success' } as any)
      .mockResolvedValueOnce({ accessToken: 'token-b', reason: 'success' } as any);

    const http = freshHttp(fetchMock);

    // User A flow.
    http.setAuthToken('stale-a');
    const a = await http.httpGet('/me', {}, undefined, 0);
    expect(a).toEqual({ who: 'a' });
    expect(mockRefreshToken).toHaveBeenCalledTimes(1);

    // Account switch happens here — clearLocalAuthState() / sign-in calls
    // clearAuthToken under the hood. This MUST drop the refresh cache.
    http.clearAuthToken();
    http.setAuthToken('stale-b');

    // User B's request triggers another 401. Without the fix, the handler
    // would reuse user A's cached refresh promise (returning token-a) and
    // never call mockRefreshToken a second time. With the fix, refresh is
    // called again and returns token-b.
    const b = await http.httpGet('/me', {}, undefined, 0);
    expect(b).toEqual({ who: 'b' });
    expect(mockRefreshToken).toHaveBeenCalledTimes(2);

    // And the user B retry must carry user B's freshly refreshed token, not
    // user A's leaked one — this is the actual security assertion.
    const userBRetry = fetchMock.mock.calls[3] as any[];
    const userBHeaders = (userBRetry[1] as RequestInit).headers as Record<string, string>;
    expect(userBHeaders.Authorization).toBe('Bearer token-b');
  });

  it('refresh failure with reason "auth" clears session, emits session-expired, never resolves', async () => {
    const fetchMock = jest
      .fn<(input: any, init?: any) => Promise<any>>()
      .mockResolvedValue(mkJsonResponse(401, { error: 'expired' }));
    mockRefreshToken.mockResolvedValue({ accessToken: null, reason: 'auth' } as any);

    const http = freshHttp(fetchMock);
    http.setAuthToken('stale-token');

    const settled = jest.fn();
    void http.httpGet('/me', {}, undefined, 0).then(settled, settled);

    // Let the microtask queue drain — refresh runs, clearTokensOnly runs,
    // emitSessionExpired fires, then the never-resolving Promise is returned.
    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    expect(mockClearTokensOnly).toHaveBeenCalledTimes(1);
    expect(mockEmitSessionExpired).toHaveBeenCalledTimes(1);
    expect(mockEmitSessionExpired).toHaveBeenCalledWith('refresh_failed');
    expect(settled).not.toHaveBeenCalled();
  });

  it('refresh failure with reason "missing" clears session, emits refresh_missing, never resolves', async () => {
    const fetchMock = jest
      .fn<(input: any, init?: any) => Promise<any>>()
      .mockResolvedValue(mkJsonResponse(401, { error: 'expired' }));
    mockRefreshToken.mockResolvedValue({ accessToken: null, reason: 'missing' } as any);

    const http = freshHttp(fetchMock);
    http.setAuthToken('stale-token');

    const settled = jest.fn();
    void http.httpGet('/me', {}, undefined, 0).then(settled, settled);

    await new Promise(r => setImmediate(r));
    await new Promise(r => setImmediate(r));

    expect(mockClearTokensOnly).toHaveBeenCalledTimes(1);
    expect(mockEmitSessionExpired).toHaveBeenCalledTimes(1);
    expect(mockEmitSessionExpired).toHaveBeenCalledWith('refresh_missing');
    expect(settled).not.toHaveBeenCalled();
  });
});

describe('api/http — GET dedup', () => {
  it('in-flight GETs for the same path + token coalesce into one network call', async () => {
    // A single slow response — both concurrent GETs must share it.
    let resolve: (v: any) => void;
    const pending = new Promise<any>(r => {
      resolve = r;
    });
    const fetchMock = jest
      .fn<(input: any, init?: any) => Promise<any>>()
      .mockImplementation(() => pending);

    const http = freshHttp(fetchMock);
    http.setAuthToken('tok');

    const p1 = http.httpGet('/feed');
    const p2 = http.httpGet('/feed');

    // Fire both, then resolve the underlying fetch.
    resolve!(mkJsonResponse(200, { items: [1, 2, 3] }));
    const [a, b] = await Promise.all([p1, p2]);

    expect(a).toEqual({ items: [1, 2, 3] });
    expect(b).toEqual({ items: [1, 2, 3] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('api/http — Railway 502 classification', () => {
  it('HTML 502 with Correlation Key surfaces as infra error, not a parsed JSON app error', async () => {
    const railwayHtml = `
      <!DOCTYPE html>
      <html><body>
        <h1>Application failed to respond</h1>
        <p>Correlation Key: ABCDEFGHIJKLMNOPQRSTUVWXY27</p>
      </body></html>
    `.trim();

    const fetchMock = jest
      .fn<(input: any, init?: any) => Promise<any>>()
      .mockResolvedValue(mkHtmlResponse(502, railwayHtml));

    const http = freshHttp(fetchMock);
    http.setAuthToken('tok');

    // retries=0 — we're pinning the terminal-error shape, not the retry loop.
    await expect(http.httpGet('/feed', {}, undefined, 0)).rejects.toMatchObject({
      status: 502,
      isRailwayErrorPage: true,
    });

    // And the error message must be the user-facing Railway infra string,
    // not an attempt to read `.error` or `.message` off a parsed JSON body.
    try {
      await http.httpGet('/feed', {}, undefined, 0);
    } catch (e: any) {
      expect(e.message).toMatch(/temporarily unavailable/i);
      // Raw HTML body is preserved on err.data — NOT a JSON object with
      // keys like { error, message } that the caller might try to read.
      expect(typeof e.data === 'string').toBe(true);
      expect(e.data).toContain('Correlation Key');
    }
  });
});

describe('api/http — timeout', () => {
  it('AbortError is classified as 408 with the canonical timeout message', async () => {
    // fetch throws an AbortError — simulates the controller.abort() path.
    const abortErr: any = new Error('The user aborted a request.');
    abortErr.name = 'AbortError';
    const fetchMock = jest
      .fn<(input: any, init?: any) => Promise<any>>()
      .mockRejectedValue(abortErr);

    const http = freshHttp(fetchMock);
    http.setAuthToken('tok');

    // retries=0 so we go through the terminal throw, not the retry branch.
    await expect(http.httpGet('/slow', {}, 100, 0)).rejects.toMatchObject({
      status: 408,
      message: 'Request timeout - server did not respond',
    });
  });
});

describe('api/http — successful response parsing', () => {
  it.each([false, true])(
    'rejects malformed JSON without replay (after refresh: %s)',
    async afterRefresh => {
      const privateBody = '{"private":"do-not-log-this"';
      const fetchMock = jest.fn<FetchFn>();
      if (afterRefresh)
        fetchMock.mockResolvedValueOnce(mkJsonResponse(401, { error: 'Unauthorized' }));
      fetchMock.mockResolvedValue(mkJsonResponse(201, privateBody));
      mockRefreshToken.mockResolvedValue({ accessToken: 'fresh-token', reason: 'success' });
      const http = freshHttp(fetchMock);
      http.setAuthToken('old-token');
      const { captureException, captureBreadcrumb } = require('@/utils/sentry');

      const error = await http
        .httpPostWithOptions('/posts?private=query-do-not-log', {}, 1000, 3)
        .catch(error => error);
      expect(error).toMatchObject({
        name: 'HttpProtocolError',
        code: 'INVALID_JSON_RESPONSE',
        isProtocolError: true,
        status: 201,
      });
      expect(error.data).toBeUndefined();
      expect(error.cause).toBeUndefined();
      expect(error.message).not.toContain('do-not-log-this');
      expect(fetchMock).toHaveBeenCalledTimes(afterRefresh ? 2 : 1);
      expect(captureException).toHaveBeenCalledTimes(1);
      expect(captureException.mock.calls[0][0]).toBe(error);
      expect(JSON.stringify(captureException.mock.calls)).not.toContain('do-not-log-this');
      expect(JSON.stringify(captureException.mock.calls)).not.toContain('query-do-not-log');
      expect(JSON.stringify(captureBreadcrumb.mock.calls)).not.toContain('query-do-not-log');
      expect(captureException.mock.calls[0][1]).toMatchObject({ path: '/posts', method: 'POST' });
      http.clearAuthToken();
    }
  );

  it('does not retry a malformed successful GET even with a retry budget', async () => {
    const fetchMock = jest.fn<FetchFn>().mockResolvedValue(mkJsonResponse(200, '   '));
    const http = freshHttp(fetchMock);
    await expect(http.httpGet('/feed', {}, 1000, 3)).rejects.toMatchObject({
      code: 'INVALID_JSON_RESPONSE',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'preserves empty successful JSON bodies (after refresh: %s)',
    async afterRefresh => {
      const fetchMock = jest.fn<FetchFn>();
      if (afterRefresh)
        fetchMock.mockResolvedValueOnce(mkJsonResponse(401, { error: 'Unauthorized' }));
      fetchMock.mockResolvedValue(mkJsonResponse(204, ''));
      mockRefreshToken.mockResolvedValue({ accessToken: 'fresh-token', reason: 'success' });
      const http = freshHttp(fetchMock);
      http.setAuthToken('old-token');
      await expect(http.httpPost('/posts', {})).resolves.toBeNull();
      http.clearAuthToken();
    }
  );

  it('preserves valid JSON null and non-JSON text responses', async () => {
    const fetchMock = jest
      .fn<FetchFn>()
      .mockResolvedValueOnce(mkJsonResponse(200, 'null'))
      .mockResolvedValueOnce(mkHtmlResponse(200, 'plain response'));
    const http = freshHttp(fetchMock);
    await expect(http.httpGet('/null')).resolves.toBeNull();
    await expect(http.httpGet('/text')).resolves.toBe('plain response');
  });

  it('retains the HTTP status for malformed error JSON', async () => {
    const fetchMock = jest.fn<FetchFn>().mockResolvedValue(mkJsonResponse(403, '{bad'));
    const http = freshHttp(fetchMock);
    await expect(http.httpPost('/posts', {})).rejects.toMatchObject({ status: 403, data: null });
  });
});

describe('api/http — Sentry reporting boundaries', () => {
  it('does not capture handled 4xx responses such as the non-admin seed endpoint', async () => {
    const fetchMock = jest
      .fn<(input: any, init?: any) => Promise<any>>()
      .mockResolvedValue(mkJsonResponse(403, { error: 'Admin only' }));

    const http = freshHttp(fetchMock);
    const { captureException } = require('@/utils/sentry') as {
      captureException: jest.MockedFunction<
        (error: unknown, context?: Record<string, unknown>) => void
      >;
    };

    await expect(http.httpPost('/games/seed-samples', {})).rejects.toMatchObject({
      status: 403,
      message: 'Admin only',
    });

    expect(captureException).not.toHaveBeenCalled();
  });

  it('still captures server-side 5xx responses exactly once', async () => {
    const fetchMock = jest
      .fn<(input: any, init?: any) => Promise<any>>()
      .mockResolvedValue(mkJsonResponse(500, { error: 'Internal server error' }));

    const http = freshHttp(fetchMock);
    const { captureException } = require('@/utils/sentry') as {
      captureException: jest.MockedFunction<
        (error: unknown, context?: Record<string, unknown>) => void
      >;
    };

    await expect(http.httpGet('/feed', {}, undefined, 0)).rejects.toMatchObject({
      status: 500,
      message: 'Internal server error',
    });

    expect(captureException).toHaveBeenCalledTimes(1);
    expect(captureException.mock.calls[0]?.[1]).toMatchObject({
      tags: { component: 'http-client', endpoint: '/feed' },
    });
  });
});
