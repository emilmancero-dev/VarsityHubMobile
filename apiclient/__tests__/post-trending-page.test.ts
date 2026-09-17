const mockHttpGet = jest.fn();

jest.mock('../auth', () => ({
  __esModule: true,
  default: {},
  invalidateMeCache: jest.fn(),
}));

jest.mock('../http', () => ({
  httpDelete: jest.fn(),
  httpGet: (...args: any[]) => mockHttpGet(...args),
  httpPatch: jest.fn(),
  httpPost: jest.fn(),
  httpPostLongTimeout: jest.fn(),
  httpPostWithOptions: jest.fn(),
  httpPut: jest.fn(),
}));

import { Post } from '../entities';

describe('Post.trendingPage', () => {
  beforeEach(() => {
    mockHttpGet.mockReset();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('propagates a failure from the supported recent-post fallback', async () => {
    mockHttpGet
      .mockRejectedValueOnce(Object.assign(new Error('route missing'), { status: 404 }))
      .mockRejectedValueOnce(new Error('offline'));

    await expect(Post.trendingPage(undefined, 20)).rejects.toThrow('offline');
    expect(mockHttpGet).toHaveBeenCalledTimes(2);
  });

  it('does not fall back for authentication failures', async () => {
    const unauthorized = Object.assign(new Error('sign in required'), { status: 401 });
    mockHttpGet.mockRejectedValueOnce(unauthorized);

    await expect(Post.trendingPage(undefined, 20)).rejects.toBe(unauthorized);
    expect(mockHttpGet).toHaveBeenCalledTimes(1);
  });

  it('uses the recent-post endpoint only when trending is explicitly unsupported', async () => {
    mockHttpGet
      .mockRejectedValueOnce(Object.assign(new Error('gone'), { status: 410 }))
      .mockResolvedValueOnce({ items: [{ id: 'p1' }], nextCursor: 'next' });

    await expect(Post.trendingPage(undefined, 20)).resolves.toMatchObject({
      items: [{ id: 'p1' }],
      nextCursor: 'next',
    });
    expect(mockHttpGet).toHaveBeenLastCalledWith('/posts?limit=20&sort=-created_at', {}, 12000, 0);
  });
});
