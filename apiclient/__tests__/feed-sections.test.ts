const mockGet = jest.fn();
jest.mock('../http', () => ({ httpGet: (...args: any[]) => mockGet(...args) }));
jest.mock('../auth', () => ({ __esModule: true, default: {} }));
import { Feed } from '../entities';
it('encodes an optional list of bundle sections without changing legacy requests', async () => {
  mockGet.mockResolvedValue({ posts: { items: [], nextCursor: null }, errors: [] });
  await Feed.bundle({ sections: ['posts', 'unread_messages'], posts_cursor: 'p2:opaque' });
  expect(mockGet).toHaveBeenLastCalledWith(
    '/feed/bundle?posts_cursor=p2%3Aopaque&sections=posts%2Cunread_messages'
  );
  await Feed.bundle();
  expect(mockGet).toHaveBeenLastCalledWith('/feed/bundle');
});
