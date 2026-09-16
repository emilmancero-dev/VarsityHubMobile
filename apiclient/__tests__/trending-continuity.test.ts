const mockGet = jest.fn();
jest.mock('../http', () => ({ httpGet: (...args: any[]) => mockGet(...args) }));
jest.mock('../auth', () => ({ __esModule: true, default: {} }));
import { Post } from '../entities';

beforeEach(() => mockGet.mockReset());

it('surfaces a failed compatibility fallback instead of reporting an empty feed', async () => {
  mockGet.mockRejectedValueOnce({ status: 404 }).mockRejectedValueOnce(new Error('offline'));
  await expect(Post.trendingPage()).rejects.toThrow('offline');
  expect(mockGet).toHaveBeenCalledTimes(2);
});
it('does not fall back on ordinary service errors', async () => {
  mockGet.mockRejectedValueOnce({ status: 503 });
  await expect(Post.trendingPage()).rejects.toEqual({ status: 503 });
  expect(mockGet).toHaveBeenCalledTimes(1);
});
it('accepts a truly empty trending page without another request', async () => {
  mockGet.mockResolvedValueOnce({ items: [], nextCursor: null });
  await expect(Post.trendingPage()).resolves.toEqual({ items: [], nextCursor: null });
  expect(mockGet).toHaveBeenCalledTimes(1);
});
