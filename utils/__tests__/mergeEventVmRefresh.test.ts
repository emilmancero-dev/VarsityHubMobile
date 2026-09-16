import { mergeEventVmRefresh } from '../eventPostGrid';

type VM = {
  eventId: string | null;
  gameId: string | null;
  posts?: unknown[];
  media?: unknown[];
  title?: string;
};

const makeVm = (over: Partial<VM> = {}): VM => ({
  eventId: 'evt-1',
  gameId: null,
  posts: [],
  media: [],
  title: 'Event',
  ...over,
});

describe('mergeEventVmRefresh (event-page soft-refresh flicker fix)', () => {
  it('starts clean when there is no previous view-model', () => {
    const next = makeVm({ posts: [], media: [] });
    expect(mergeEventVmRefresh(null, next)).toBe(next);
  });

  it('preserves already-loaded posts/media on a same-event refresh', () => {
    // This is the flicker case: the loader rebuilds `next` with empty arrays,
    // but the screen already has posts hydrated. They must survive the refresh.
    const prev = makeVm({ posts: [{ id: 'p1' }, { id: 'p2' }], media: [{ id: 'm1' }] });
    const next = makeVm({ posts: [], media: [], title: 'Event (refreshed)' });

    const merged = mergeEventVmRefresh(prev, next);

    expect(merged.posts).toEqual(prev.posts); // not blanked to []
    expect(merged.media).toEqual(prev.media);
    expect(merged.title).toBe('Event (refreshed)'); // fresh metadata still applied
  });

  it('does NOT preserve across a different event', () => {
    const prev = makeVm({ eventId: 'evt-1', posts: [{ id: 'p1' }] });
    const next = makeVm({ eventId: 'evt-2', posts: [] });
    expect(mergeEventVmRefresh(prev, next)).toBe(next);
  });

  it('does NOT preserve when the previous VM was a real game (not an event page)', () => {
    const prev = makeVm({ eventId: 'evt-1', gameId: 'game-9', posts: [{ id: 'p1' }] });
    const next = makeVm({ eventId: 'evt-1', gameId: null, posts: [] });
    expect(mergeEventVmRefresh(prev, next)).toBe(next);
  });

  it('takes the fresh posts when the previous VM had none', () => {
    const prev = makeVm({ posts: [], media: [] });
    const next = makeVm({ posts: [{ id: 'p1' }], media: [{ id: 'm1' }] });
    const merged = mergeEventVmRefresh(prev, next);
    expect(merged.posts).toEqual(next.posts);
    expect(merged.media).toEqual(next.media);
  });
});
