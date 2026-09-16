const mockWrite = jest.fn();
jest.mock('../http', () => ({
  httpPost: (...args: any[]) => mockWrite(...args),
  httpPut: (...args: any[]) => mockWrite(...args),
  httpPatch: (...args: any[]) => mockWrite(...args),
  httpDelete: (...args: any[]) => mockWrite(...args),
}));
jest.mock('../auth', () => ({ __esModule: true, default: {} }));
import { Game, Event } from '../entities';
import { queryClient } from '@/lib/queryClient';

const keys = [
  ['feed-game-window', 'viewer'],
  ['feed-games-upcoming', 'viewer', 'bound'],
  ['feed-pro-events-upcoming', 'viewer', 'bound'],
];
beforeEach(() => {
  queryClient.clear();
  mockWrite.mockReset().mockResolvedValue({ id: 'changed' });
  for (const key of keys) queryClient.setQueryData(key, { old: true });
  queryClient.setQueryData(['profile', 'viewer'], { name: 'unchanged' });
});
afterEach(() => queryClient.clear());

it.each([
  ['game create', () => Game.create({})],
  ['game update', () => Game.update('g', {})],
  ['game delete', () => Game.delete('g')],
  ['game bulk create', () => Game.bulkCreate([])],
  ['event create', () => Event.create({} as any)],
  ['event update', () => Event.update('e', {})],
  ['event cancel', () => Event.cancel('e')],
  ['event extend', () => Event.extendWindow('e')],
])('invalidates warm game windows and pages after %s', async (_name, mutate) => {
  await mutate();
  for (const key of keys) expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
  const fetchPage = jest.fn(async () => ({ old: false }));
  expect(await queryClient.fetchQuery({ queryKey: keys[1], queryFn: fetchPage })).toEqual({
    old: false,
  });
  expect(fetchPage).toHaveBeenCalledTimes(1);
  expect(queryClient.getQueryState(['profile', 'viewer'])?.isInvalidated).toBe(false);
});

it('does not invalidate on a rejected mutation', async () => {
  mockWrite.mockRejectedValue(new Error('denied'));
  await expect(Game.update('g', {})).rejects.toThrow('denied');
  for (const key of keys) expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);
});
