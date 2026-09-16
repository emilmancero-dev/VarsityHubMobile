import React from 'react';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import { AppState, FlatList, RefreshControl, View } from 'react-native';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

const createDeferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const mockRouterPush = jest.fn();
const mockPostsSummary = jest.fn(async (..._args: any[]) => ({}));
const mockEventFilter = jest.fn(async (..._args: any[]) => []);
const mockFeedBundle = jest.fn<Promise<any>, [any]>();
let capturedFocusEffect: null | (() => void | (() => void)) = null;
let authDeferred: Deferred<any>;
let firstGameDeferred: Deferred<any>;
let gameDeferredQueue: Deferred<any>[] = [];
let mockViewer: any = null;
// feed.tsx loads THREE game sections per refresh — upcoming (the main list),
// past recap, and curated/marquee events — fanned out in a single Promise.all
// (they were serialized until the ~1.2s-per-load fix). So one feed load is
// three Game.list calls, and this constant is what keeps the invariant these
// tests actually protect honest: ONE load per focus, never a duplicate.
// If a section is added or removed, update this deliberately rather than
// letting the expected call count drift.
const GAME_LIST_CALLS_PER_LOAD = 3;

const EMPTY_GAMES_PAGE = { games: [], nextCursor: null };

const mockCheckAuth = jest.fn(() => authDeferred.promise);
const mockGameList = jest.fn((_sort?: string, _options?: any) => {
  // The deferred queue drives the UPCOMING section (the one these tests assert
  // renders). The past-recap and marquee sections aren't under test here, so
  // they resolve empty — that lets the load's Promise.all settle instead of
  // relying on them throwing. Over-calling is still caught: the call-count
  // assertions below pin the exact number of loads.
  const next = gameDeferredQueue.shift();
  if (!next) return Promise.resolve(EMPTY_GAMES_PAGE);
  return next.promise;
});

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({
    push: mockRouterPush,
    replace: jest.fn(),
    back: jest.fn(),
  }),
}));

jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: () => void | (() => void)) => {
    capturedFocusEffect = cb;
  },
}));

jest.mock('@react-navigation/bottom-tabs', () => ({
  useBottomTabBarHeight: () => 0,
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@/api/entities', () => ({
  Advertisement: {
    forFeed: jest.fn(async () => ({ ads: [] })),
    report: jest.fn(),
  },
  Event: {
    filter: (...args: any[]) => mockEventFilter(...args),
    rsvp: jest.fn(),
    rsvpStatus: jest.fn(async () => ({ going: false, count: 0 })),
  },
  Game: {
    list: (...args: any[]) => mockGameList(...args),
    votesSummaryBatch: jest.fn(async () => ({})),
    postsSummaryBatch: (...args: any[]) => mockPostsSummary(...args),
  },
  Feed: {
    bundle: (params: any) => mockFeedBundle(params),
  },
  Highlights: {
    fetch: jest.fn(async () => null),
  },
  Message: {
    unreadCount: jest.fn(async () => ({ count: 0 })),
  },
  Notification: {
    unreadCount: jest.fn(async () => 0),
    listPage: jest.fn(async () => ({ items: [] })),
    markRead: jest.fn(async () => ({})),
  },
  Post: {
    filterPage: jest.fn(async () => ({ items: [] })),
  },
  User: {
    me: jest.fn(),
  },
}));

jest.mock('@/context/AuthProvider', () => ({
  useAuth: () => ({
    user: mockViewer,
    checkAuth: mockCheckAuth,
  }),
}));

jest.mock('@/components/BannerAd', () => ({
  BannerAd: () => null,
}));

jest.mock('@/components/PostCard', () => () => null);

jest.mock('@/components/ui/SkeletonCard', () => ({
  PostCardSkeleton: () => <View testID="feed-skeleton" />,
}));

jest.mock('@/hooks/useColorScheme', () => ({
  useColorScheme: () => 'light',
}));

jest.mock('@/constants/Colors', () => ({
  Colors: {
    light: {
      text: '#111',
      mutedText: '#666',
      tint: '#0A84FF',
      border: '#ddd',
      background: '#fff',
      card: '#f5f5f5',
    },
    dark: {
      text: '#fff',
      mutedText: '#999',
      tint: '#0A84FF',
      border: '#333',
      background: '#000',
      card: '#111',
    },
  },
}));

jest.mock('expo-image', () => ({
  Image: () => null,
}));

jest.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ children }: any) => <>{children}</>,
}));

jest.mock('expo-linking', () => ({
  openURL: jest.fn(),
}));

jest.mock('expo-location', () => ({
  getForegroundPermissionsAsync: jest.fn(async () => ({ status: 'denied' })),
  requestForegroundPermissionsAsync: jest.fn(async () => ({ status: 'denied' })),
  getLastKnownPositionAsync: jest.fn(async () => null),
  getCurrentPositionAsync: jest.fn(async () => null),
}));

jest.mock('@/utils/imageUrl', () => ({
  optimizeImageUrl: (url: string) => url,
}));

jest.mock('@/utils/notificationPresentation', () => ({
  getNotificationHref: jest.fn(() => '/'),
  getNotificationTitle: jest.fn(() => 'Notification'),
}));

jest.mock('./../app/game-details/GameVerticalFeedScreen', () => () => null);

jest.mock('date-fns', () => ({
  format: () => 'Apr 25',
}));

import FeedScreen from '../app/feed';
import { queryClient } from '@/lib/queryClient';

describe('Feed startup performance', () => {
  let now = new Date('2026-04-25T12:00:00.000Z').getTime();

  beforeEach(() => {
    jest.clearAllMocks();
    // FeedScreen reads games through the shared singleton queryClient; clear it
    // so each test starts with an empty cache and the 30s staleTime math isn't
    // polluted by the prior test's cached ['feed-games'] entry.
    queryClient.clear();
    capturedFocusEffect = null;
    mockViewer = null;
    mockFeedBundle.mockReset().mockResolvedValue(null);
    authDeferred = createDeferred<any>();
    firstGameDeferred = createDeferred<any>();
    gameDeferredQueue = [firstGameDeferred];
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['selective', 'people'],
    ['legacy-full', 'people'],
    ['selective', 'teams'],
    ['legacy-full', 'teams'],
  ])(
    'paginates only the requested social section with a %s response for %s',
    async (mode, section) => {
      const people = section === 'people';
      mockViewer = { id: 'viewer', email_verified: true, preferences: { country_code: 'US' } };
      const original = {
        posts: { items: [{ id: 'p1' }], nextCursor: 'people-next' },
        posts_followed_teams: { items: [{ id: 't1' }], nextCursor: 'teams-next' },
        errors: [],
        unread_notifications: 3,
        unread_messages: 2,
      };
      mockFeedBundle.mockResolvedValueOnce(original).mockResolvedValueOnce({
        ...(mode === 'legacy-full'
          ? {
              posts: { items: [], nextCursor: null },
              posts_followed_teams: { items: [], nextCursor: null },
            }
          : {}),
        [people ? 'posts' : 'posts_followed_teams']: {
          items: [{ id: people ? 'p2' : 't2' }],
          nextCursor: null,
        },
        errors: [],
      });
      const view = render(<FeedScreen />);
      await act(async () => {
        firstGameDeferred.resolve(EMPTY_GAMES_PAGE);
        authDeferred.resolve(mockViewer);
      });
      const button = people ? 'feed-load-more-followed-posts' : 'feed-load-more-team-posts';
      await waitFor(() => expect(view.getByTestId(button)).toBeTruthy());
      fireEvent.press(view.getByTestId(button));
      await waitFor(() =>
        expect(mockFeedBundle).toHaveBeenLastCalledWith(
          expect.objectContaining({
            sections: [people ? 'posts' : 'posts_followed_teams'],
            [people ? 'posts_cursor' : 'posts_followed_teams_cursor']: people
              ? 'people-next'
              : 'teams-next',
          })
        )
      );
      await waitFor(() => {
        const rows = view.UNSAFE_getByType(FlatList).props.data;
        expect(
          rows.filter((r: any) => r._t === 'followed_post').map((r: any) => r.data.id)
        ).toEqual(people ? ['p1', 'p2'] : ['p1']);
        expect(
          rows.filter((r: any) => r._t === 'followed_teams_post').map((r: any) => r.data.id)
        ).toEqual(people ? ['t1'] : ['t1', 't2']);
      });
    }
  );
  it('retains the social continuation for retry when the requested slice fails', async () => {
    mockViewer = { id: 'viewer', preferences: {} };
    mockFeedBundle
      .mockResolvedValueOnce({
        posts: { items: [{ id: 'p1' }], nextCursor: 'people-next' },
        posts_followed_teams: { items: [], nextCursor: null },
        errors: [],
      })
      .mockResolvedValueOnce({
        posts: { items: [], nextCursor: null },
        errors: [{ slice: 'posts', code: 'SLICE_FAILED' }],
      });
    const view = render(<FeedScreen />);
    await act(async () => {
      firstGameDeferred.resolve(EMPTY_GAMES_PAGE);
      authDeferred.resolve(mockViewer);
    });
    await waitFor(() => expect(view.getByTestId('feed-load-more-followed-posts')).toBeTruthy());
    fireEvent.press(view.getByTestId('feed-load-more-followed-posts'));
    expect(await view.findByText('Unable to load more posts right now.')).toBeTruthy();
    expect(view.getByTestId('feed-load-more-followed-posts')).toBeTruthy();
  });

  it('renders game cards before user/background hydration finishes', async () => {
    const screen = render(<FeedScreen />);

    expect(screen.getAllByTestId('feed-skeleton')).toHaveLength(3);

    await act(async () => {
      firstGameDeferred.resolve({
        games: [
          {
            id: 'game-1',
            title: 'Central vs West',
            date: '2026-04-25T18:00:00.000Z',
            location: 'Main Gym',
          },
        ],
        nextCursor: null,
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId('feed-game-card-game-1')).toBeTruthy();
    });

    expect(screen.queryByTestId('feed-skeleton')).toBeNull();
    expect(mockCheckAuth).toHaveBeenCalledTimes(1);
    // Exactly one load — its three section queries, and no duplicate load.
    expect(mockGameList).toHaveBeenCalledTimes(GAME_LIST_CALLS_PER_LOAD);
  });

  it('reuses all three game pages on a warm remount one millisecond later', async () => {
    const first = render(<FeedScreen />);
    await act(async () =>
      firstGameDeferred.resolve({
        games: [{ id: 'cached-game', title: 'Cached', date: '2026-04-25T18:00:00Z' }],
        nextCursor: 'cursor-1',
      })
    );
    await waitFor(() => expect(first.getByTestId('feed-game-card-cached-game')).toBeTruthy());
    first.unmount();
    now += 1;
    const second = render(<FeedScreen />);
    await waitFor(() => expect(second.getByTestId('feed-game-card-cached-game')).toBeTruthy());
    expect(mockGameList).toHaveBeenCalledTimes(3);
    await waitFor(() => expect(mockEventFilter).toHaveBeenCalledTimes(4));
    const originalOptions = mockGameList.mock.calls[0][1];
    await act(async () => {
      await second.UNSAFE_getByType(FlatList).props.onEndReached();
    });
    expect(mockGameList).toHaveBeenLastCalledWith('date', {
      ...originalOptions,
      cursor: 'cursor-1',
    });
  });

  it('refreshes the cached pages on an explicit pull even within the freshness window', async () => {
    const view = render(<FeedScreen />);
    await act(async () => {
      authDeferred.resolve(null);
      firstGameDeferred.resolve({
        games: [{ id: 'refresh-game', date: '2026-04-25T18:00:00Z' }],
        nextCursor: null,
      });
    });
    await waitFor(() => expect(view.getByTestId('feed-game-card-refresh-game')).toBeTruthy());
    mockGameList.mockClear();
    gameDeferredQueue.push({
      ...createDeferred(),
      promise: Promise.resolve({
        games: [{ id: 'new-game', date: '2026-04-25T18:00:00Z' }],
        nextCursor: null,
      }),
    });
    await act(async () => {
      await view.UNSAFE_getByType(RefreshControl).props.onRefresh();
    });
    expect(mockGameList).toHaveBeenCalledTimes(3);
    expect(view.getByTestId('feed-game-card-new-game')).toBeTruthy();
  });

  it('does not reuse another viewer’s cached game pages', async () => {
    mockViewer = { id: 'viewer-one' };
    const first = render(<FeedScreen />);
    await act(async () =>
      firstGameDeferred.resolve({
        games: [{ id: 'private-game', date: '2026-04-25T18:00:00Z' }],
        nextCursor: null,
      })
    );
    await waitFor(() => expect(first.getByTestId('feed-game-card-private-game')).toBeTruthy());
    first.unmount();
    mockViewer = { id: 'viewer-two' };
    const second = render(<FeedScreen />);
    await waitFor(() => expect(mockGameList.mock.calls.length).toBeGreaterThanOrEqual(6));
    expect(second.queryByTestId('feed-game-card-private-game')).toBeNull();
  });

  it('refetches invalidated pages on warm remount instead of restoring a stale event', async () => {
    const first = render(<FeedScreen />);
    await act(async () =>
      firstGameDeferred.resolve({
        games: [{ id: 'old-event', date: '2026-04-25T18:00:00Z' }],
        nextCursor: null,
      })
    );
    await waitFor(() => expect(first.getByTestId('feed-game-card-old-event')).toBeTruthy());
    first.unmount();
    await queryClient.invalidateQueries({
      predicate: query => String(query.queryKey[0]).startsWith('feed-'),
      refetchType: 'none',
    });
    gameDeferredQueue.push({
      ...createDeferred<any>(),
      promise: Promise.resolve({
        games: [{ id: 'edited-event', date: '2026-04-25T18:00:00Z' }],
        nextCursor: null,
      }),
    });
    now += 1;
    const second = render(<FeedScreen />);
    await waitFor(() => expect(second.getByTestId('feed-game-card-edited-event')).toBeTruthy());
    expect(second.queryByTestId('feed-game-card-old-event')).toBeNull();
    expect(mockGameList).toHaveBeenCalledTimes(6);
  });

  it('stops post-activity polling after blur and while backgrounded', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
    let appStateChanged: (state: string) => void = () => {};
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, callback: any) => {
      appStateChanged = callback;
      return { remove: jest.fn() };
    });
    const view = render(<FeedScreen />);
    await act(async () =>
      firstGameDeferred.resolve({
        games: [{ id: 'live-game', date: new Date(now - 60_000).toISOString() }],
        nextCursor: null,
      })
    );
    await waitFor(() => expect(view.getByTestId('feed-post-counter')).toBeTruthy());
    let cleanup: any;
    await act(async () => {
      cleanup = capturedFocusEffect?.();
    });
    mockPostsSummary.mockClear();
    await act(async () => {
      appStateChanged('background');
      jest.advanceTimersByTime(60_000);
    });
    expect(mockPostsSummary).not.toHaveBeenCalled();
    await act(async () => {
      appStateChanged('active');
    });
    expect(mockPostsSummary).toHaveBeenCalledTimes(1);
    cleanup?.();
    mockPostsSummary.mockClear();
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    expect(mockPostsSummary).not.toHaveBeenCalled();
    view.unmount();
    jest.useRealTimers();
  });

  it('queues one current refresh after an obsolete in-flight poll finishes', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(now);
    let appStateChanged: (state: string) => void = () => {};
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, callback: any) => {
      appStateChanged = callback;
      return { remove: jest.fn() };
    });
    const pending = createDeferred<any>();
    mockPostsSummary
      .mockReset()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ 'live-game': 2 });
    const view = render(<FeedScreen />);
    await act(async () =>
      firstGameDeferred.resolve({
        games: [{ id: 'live-game', date: new Date(now - 60_000).toISOString() }],
        nextCursor: null,
      })
    );
    await waitFor(() => expect(view.getByTestId('feed-post-counter')).toBeTruthy());
    let cleanup: any;
    await act(async () => {
      cleanup = capturedFocusEffect?.();
    });
    await act(async () => {
      appStateChanged('background');
      appStateChanged('active');
      jest.advanceTimersByTime(60_000);
    });
    expect(mockPostsSummary).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve({ 'live-game': 99 });
    });
    expect(mockPostsSummary).toHaveBeenCalledTimes(2);
    expect(view.getByLabelText('2 posts')).toBeTruthy();
    expect(view.queryByLabelText('99 posts')).toBeNull();
    cleanup?.();
    view.unmount();
    jest.useRealTimers();
  });

  it('keeps existing feed content visible during silent focus refresh', async () => {
    const screen = render(<FeedScreen />);

    await act(async () => {
      firstGameDeferred.resolve({
        games: [
          {
            id: 'game-1',
            title: 'Central vs West',
            date: '2026-04-25T18:00:00.000Z',
            location: 'Main Gym',
          },
        ],
        nextCursor: null,
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId('feed-game-card-game-1')).toBeTruthy();
    });

    // Simulate the initial focus: real navigation fires useFocusEffect on
    // first focus, and the screen's hasFocusedOnce gate skips the duplicate
    // load there. Only the SECOND focus (below) should silently refresh.
    await act(async () => {
      const initialFocusCleanup = capturedFocusEffect?.();
      if (typeof initialFocusCleanup === 'function') initialFocusCleanup();
      await Promise.resolve();
    });

    jest.useFakeTimers();
    now += 31_000;
    jest.setSystemTime(now);
    const secondGamesDeferred = createDeferred<any>();
    gameDeferredQueue.push(secondGamesDeferred);

    let cleanup: unknown;
    await act(async () => {
      cleanup = capturedFocusEffect?.();
      await Promise.resolve();
    });

    // The silent focus refresh is the SECOND load — two loads' worth of section
    // queries total, confirming the refresh ran exactly once.
    expect(mockGameList).toHaveBeenCalledTimes(2 * GAME_LIST_CALLS_PER_LOAD);
    expect(mockCheckAuth).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('feed-game-card-game-1')).toBeTruthy();
    expect(screen.queryByTestId('feed-skeleton')).toBeNull();

    if (typeof cleanup === 'function') cleanup();
    await act(async () => {
      jest.advanceTimersByTime(10_000);
    });
    jest.useRealTimers();
  });
});
