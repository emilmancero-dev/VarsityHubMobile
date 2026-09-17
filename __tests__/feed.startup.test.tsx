import React from 'react';
import { act, render, waitFor } from '@testing-library/react-native';
import { AppState, type AppStateStatus, InteractionManager, View } from 'react-native';

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
let capturedFocusEffects: Array<() => void | (() => void)> = [];
let capturedAppStateListeners = new Set<(state: AppStateStatus) => void>();
let mockAppState: AppStateStatus = 'active';
let mockAuthUser: { id: string } | null = null;
let mockAuthListeners = new Set<() => void>();
let authDeferred: Deferred<any>;
let firstGameDeferred: Deferred<any>;
let gameDeferredQueue: Deferred<any>[] = [];
const mockPostsSummaryBatch = jest.fn(
  async (_ids: string[]): Promise<Record<string, number>> => ({})
);
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
const mockGameList = jest.fn(() => {
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
    const React = require('react');
    React.useEffect(() => {
      capturedFocusEffects.push(cb);
      return () => {
        capturedFocusEffects = capturedFocusEffects.filter(effect => effect !== cb);
      };
    }, [cb]);
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
    filter: jest.fn(async () => []),
    rsvp: jest.fn(),
    rsvpStatus: jest.fn(async () => ({ going: false, count: 0 })),
  },
  Game: {
    list: () => mockGameList(),
    votesSummaryBatch: jest.fn(async () => ({})),
    postsSummaryBatch: (ids: string[]) => mockPostsSummaryBatch(ids),
  },
  Feed: {
    bundle: jest.fn(async () => null),
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
  useAuth: () => {
    const React = require('react');
    const user = React.useSyncExternalStore(
      (listener: () => void) => {
        mockAuthListeners.add(listener);
        return () => mockAuthListeners.delete(listener);
      },
      () => mockAuthUser,
      () => mockAuthUser
    );
    return { user, checkAuth: mockCheckAuth };
  },
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

const originalAppStateDescriptor = Object.getOwnPropertyDescriptor(AppState, 'currentState');

const runFocusEffects = () => capturedFocusEffects.map(effect => effect());
const runActivityFocusEffect = () => capturedFocusEffects[0]?.();

const cleanupFocusEffects = (cleanups: Array<void | (() => void)>) => {
  cleanups.forEach(cleanup => {
    if (typeof cleanup === 'function') cleanup();
  });
};

const emitAppState = (state: AppStateStatus) => {
  mockAppState = state;
  (AppState as { currentState: AppStateStatus }).currentState = state;
  capturedAppStateListeners.forEach(listener => listener(state));
};

const useFeedFakeTimers = (now: number) => {
  jest.useFakeTimers({ now });
};

const setMockAuthUser = (user: { id: string } | null) => {
  mockAuthUser = user;
  mockAuthListeners.forEach(listener => listener());
};

describe('Feed startup performance', () => {
  let now = new Date('2026-04-25T12:00:00.000Z').getTime();

  beforeEach(() => {
    now = new Date('2026-04-25T12:00:00.000Z').getTime();
    jest.clearAllMocks();
    // FeedScreen reads games through the shared singleton queryClient; clear it
    // so each test starts with an empty cache and the 30s staleTime math isn't
    // polluted by the prior test's cached ['feed-games'] entry.
    queryClient.clear();
    capturedFocusEffects = [];
    capturedAppStateListeners = new Set();
    mockAppState = 'active';
    mockAuthUser = null;
    mockAuthListeners = new Set();
    authDeferred = createDeferred<any>();
    firstGameDeferred = createDeferred<any>();
    gameDeferredQueue = [firstGameDeferred];
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    jest.spyOn(InteractionManager, 'runAfterInteractions').mockImplementation((callback: any) => {
      callback();
      return { cancel: jest.fn() } as any;
    });
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      capturedAppStateListeners.add(listener);
      return {
        remove: jest.fn(() => capturedAppStateListeners.delete(listener)),
      } as any;
    });
    Object.defineProperty(AppState, 'currentState', {
      configurable: true,
      writable: true,
      value: mockAppState,
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (originalAppStateDescriptor) {
      Object.defineProperty(AppState, 'currentState', originalAppStateDescriptor);
    }
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
      cleanupFocusEffects(runFocusEffects());
      await Promise.resolve();
    });

    useFeedFakeTimers(now);
    now += 31_000;
    jest.setSystemTime(now);
    const secondGamesDeferred = createDeferred<any>();
    gameDeferredQueue.push(secondGamesDeferred);

    let cleanups: Array<void | (() => void)> = [];
    await act(async () => {
      cleanups = runFocusEffects();
      await Promise.resolve();
    });

    // The silent focus refresh is the SECOND load — two loads' worth of section
    // queries total, confirming the refresh ran exactly once.
    expect(mockGameList).toHaveBeenCalledTimes(2 * GAME_LIST_CALLS_PER_LOAD);
    expect(mockCheckAuth).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('feed-game-card-game-1')).toBeTruthy();
    expect(screen.queryByTestId('feed-skeleton')).toBeNull();

    cleanupFocusEffects(cleanups);
    await act(async () => {
      secondGamesDeferred.resolve({
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
      jest.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
  });

  it('polls activity only while focused and active, then refreshes once on return', async () => {
    useFeedFakeTimers(now);
    const screen = render(<FeedScreen />);
    let focusCleanups: Array<void | (() => void)> = [];

    await act(async () => {
      focusCleanups = [runActivityFocusEffect()];
      firstGameDeferred.resolve({
        games: [
          {
            id: 'live-game',
            title: 'Central vs West',
            date: '2026-04-25T11:00:00.000Z',
            location: 'Main Gym',
          },
          {
            id: 'past-event',
            title: 'Alumni Showcase',
            date: '2026-04-24T00:00:00.000Z',
            location: 'Main Gym',
            source_type: 'event',
          },
          {
            id: 'future-game',
            title: 'North vs South',
            date: '2026-04-26T18:00:00.000Z',
            location: 'North Gym',
          },
        ],
        nextCursor: null,
      });
      await Promise.resolve();
    });

    expect(screen.getByTestId('feed-game-card-live-game')).toBeTruthy();
    expect(mockPostsSummaryBatch).toHaveBeenCalledTimes(1);
    const initialActivityIds = mockPostsSummaryBatch.mock.calls[0][0];
    expect(initialActivityIds).toEqual(expect.arrayContaining(['live-game', 'past-event']));
    expect(initialActivityIds).not.toContain('future-game');

    cleanupFocusEffects(focusCleanups);
    expect(capturedAppStateListeners.size).toBe(0);
    await act(async () => {
      jest.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    expect(mockPostsSummaryBatch).toHaveBeenCalledTimes(1);

    await act(async () => {
      focusCleanups = [runActivityFocusEffect()];
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(capturedAppStateListeners.size).toBe(1);
    expect(mockPostsSummaryBatch).toHaveBeenCalledTimes(2);

    await act(async () => {
      emitAppState('background');
      jest.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    expect(mockPostsSummaryBatch).toHaveBeenCalledTimes(2);

    await act(async () => {
      emitAppState('active');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockPostsSummaryBatch).toHaveBeenCalledTimes(3);

    cleanupFocusEffects(focusCleanups);
  });

  it('does not overlap activity requests when a polling tick beats a slow response', async () => {
    useFeedFakeTimers(now);
    const activityDeferred = createDeferred<Record<string, number>>();
    mockPostsSummaryBatch.mockImplementationOnce(() => activityDeferred.promise);
    render(<FeedScreen />);
    let focusCleanups: Array<void | (() => void)> = [];

    await act(async () => {
      focusCleanups = [runActivityFocusEffect()];
      firstGameDeferred.resolve({
        games: [
          {
            id: 'live-game',
            title: 'Central vs West',
            date: '2026-04-25T11:00:00.000Z',
            location: 'Main Gym',
          },
        ],
        nextCursor: null,
      });
      await Promise.resolve();
    });

    expect(mockPostsSummaryBatch).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(90_000);
      await Promise.resolve();
    });
    expect(mockPostsSummaryBatch).toHaveBeenCalledTimes(1);

    await act(async () => {
      activityDeferred.resolve({ 'live-game': 0 });
      await Promise.resolve();
    });
    await act(async () => {
      jest.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(mockPostsSummaryBatch).toHaveBeenCalledTimes(2);

    cleanupFocusEffects(focusCleanups);
  });

  it('does not queue unchanged enrichment ids behind the initial activity request', async () => {
    useFeedFakeTimers(now);
    const activityDeferred = createDeferred<Record<string, number>>();
    const pastGamesDeferred = createDeferred<any>();
    const marqueeGamesDeferred = createDeferred<any>();
    gameDeferredQueue = [firstGameDeferred, pastGamesDeferred, marqueeGamesDeferred];
    mockPostsSummaryBatch.mockImplementationOnce(() => activityDeferred.promise);
    render(<FeedScreen />);
    let focusCleanups: Array<void | (() => void)> = [];
    const liveGame = {
      id: 'live-game',
      title: 'Central vs West',
      date: '2026-04-25T11:00:00.000Z',
      location: 'Main Gym',
    };

    await act(async () => {
      focusCleanups = [runActivityFocusEffect()];
      firstGameDeferred.resolve({ games: [liveGame], nextCursor: null });
      await Promise.resolve();
    });
    expect(mockPostsSummaryBatch).toHaveBeenCalledTimes(1);

    await act(async () => {
      pastGamesDeferred.resolve({ games: [liveGame], nextCursor: null });
      marqueeGamesDeferred.resolve(EMPTY_GAMES_PAGE);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockPostsSummaryBatch).toHaveBeenCalledTimes(1);

    await act(async () => {
      activityDeferred.resolve({ 'live-game': 0 });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockPostsSummaryBatch).toHaveBeenCalledTimes(1);

    cleanupFocusEffects(focusCleanups);
  });

  it('queues changed enrichment ids behind the initial activity request', async () => {
    useFeedFakeTimers(now);
    const activityDeferred = createDeferred<Record<string, number>>();
    const pastGamesDeferred = createDeferred<any>();
    const marqueeGamesDeferred = createDeferred<any>();
    gameDeferredQueue = [firstGameDeferred, pastGamesDeferred, marqueeGamesDeferred];
    mockPostsSummaryBatch.mockImplementationOnce(() => activityDeferred.promise);
    render(<FeedScreen />);
    let focusCleanups: Array<void | (() => void)> = [];
    const liveGame = {
      id: 'live-game',
      title: 'Central vs West',
      date: '2026-04-25T11:00:00.000Z',
      location: 'Main Gym',
    };
    const newLiveGame = {
      id: 'new-live-game',
      title: 'North vs South',
      date: '2026-04-25T11:30:00.000Z',
      location: 'North Gym',
    };

    await act(async () => {
      focusCleanups = [runActivityFocusEffect()];
      firstGameDeferred.resolve({ games: [liveGame], nextCursor: null });
      await Promise.resolve();
    });
    expect(mockPostsSummaryBatch).toHaveBeenCalledTimes(1);

    await act(async () => {
      pastGamesDeferred.resolve({ games: [newLiveGame], nextCursor: null });
      marqueeGamesDeferred.resolve(EMPTY_GAMES_PAGE);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockPostsSummaryBatch).toHaveBeenCalledTimes(1);

    await act(async () => {
      activityDeferred.resolve({ 'live-game': 0 });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockPostsSummaryBatch).toHaveBeenCalledTimes(2);
    expect(mockPostsSummaryBatch).toHaveBeenLastCalledWith(['live-game', 'new-live-game']);

    cleanupFocusEffects(focusCleanups);
  });

  it('queues unchanged enrichment ids when the in-flight request belongs to an old viewer', async () => {
    useFeedFakeTimers(now);
    mockAuthUser = { id: 'viewer-a' };
    const activityDeferred = createDeferred<Record<string, number>>();
    const pastGamesDeferred = createDeferred<any>();
    const marqueeGamesDeferred = createDeferred<any>();
    gameDeferredQueue = [firstGameDeferred, pastGamesDeferred, marqueeGamesDeferred];
    mockPostsSummaryBatch.mockImplementationOnce(() => activityDeferred.promise);
    render(<FeedScreen />);
    let focusCleanups: Array<void | (() => void)> = [];
    const liveGame = {
      id: 'live-game',
      title: 'Central vs West',
      date: '2026-04-25T11:00:00.000Z',
      location: 'Main Gym',
    };

    await act(async () => {
      focusCleanups = [runActivityFocusEffect()];
      firstGameDeferred.resolve({ games: [liveGame], nextCursor: null });
      await Promise.resolve();
    });
    expect(mockPostsSummaryBatch).toHaveBeenCalledTimes(1);

    await act(async () => {
      setMockAuthUser({ id: 'viewer-b' });
      pastGamesDeferred.resolve({ games: [liveGame], nextCursor: null });
      marqueeGamesDeferred.resolve(EMPTY_GAMES_PAGE);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockPostsSummaryBatch).toHaveBeenCalledTimes(1);

    await act(async () => {
      activityDeferred.resolve({ 'live-game': 1 });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockPostsSummaryBatch).toHaveBeenCalledTimes(2);
    expect(mockPostsSummaryBatch).toHaveBeenLastCalledWith(['live-game']);

    cleanupFocusEffects(focusCleanups);
  });

  it('ignores late activity responses after background and blur ownership ends', async () => {
    useFeedFakeTimers(now);
    const backgroundDeferred = createDeferred<Record<string, number>>();
    const blurDeferred = createDeferred<Record<string, number>>();
    mockPostsSummaryBatch
      .mockImplementationOnce(() => backgroundDeferred.promise)
      .mockImplementationOnce(() => blurDeferred.promise);
    const screen = render(<FeedScreen />);
    let focusCleanups: Array<void | (() => void)> = [];

    await act(async () => {
      focusCleanups = [runActivityFocusEffect()];
      firstGameDeferred.resolve({
        games: [
          {
            id: 'live-game',
            title: 'Central vs West',
            date: '2026-04-25T11:00:00.000Z',
            location: 'Main Gym',
          },
        ],
        nextCursor: null,
      });
      await Promise.resolve();
    });

    expect(mockPostsSummaryBatch).toHaveBeenCalledTimes(1);
    await act(async () => {
      emitAppState('background');
      backgroundDeferred.resolve({ 'live-game': 1 });
      await Promise.resolve();
    });
    expect(screen.getByTestId('feed-game-card-live-game')).toHaveStyle({
      borderColor: '#EF4444',
    });

    await act(async () => {
      emitAppState('active');
      await Promise.resolve();
    });
    expect(mockPostsSummaryBatch).toHaveBeenCalledTimes(2);

    cleanupFocusEffects(focusCleanups);
    await act(async () => {
      blurDeferred.resolve({ 'live-game': 1 });
      await Promise.resolve();
    });
    expect(screen.getByTestId('feed-game-card-live-game')).toHaveStyle({
      borderColor: '#EF4444',
    });
  });

  it('consumes a queued return refresh when a fresh request starts', async () => {
    useFeedFakeTimers(now);
    const firstActivityDeferred = createDeferred<Record<string, number>>();
    const returnActivityDeferred = createDeferred<Record<string, number>>();
    mockPostsSummaryBatch
      .mockImplementationOnce(() => firstActivityDeferred.promise)
      .mockImplementationOnce(() => returnActivityDeferred.promise);
    render(<FeedScreen />);
    let focusCleanups: Array<void | (() => void)> = [];

    await act(async () => {
      focusCleanups = [runActivityFocusEffect()];
      firstGameDeferred.resolve({
        games: [
          {
            id: 'live-game',
            title: 'Central vs West',
            date: '2026-04-25T11:00:00.000Z',
            location: 'Main Gym',
          },
        ],
        nextCursor: null,
      });
      await Promise.resolve();
    });
    expect(mockPostsSummaryBatch).toHaveBeenCalledTimes(1);

    await act(async () => {
      emitAppState('background');
      emitAppState('active');
      emitAppState('background');
      firstActivityDeferred.resolve({ 'live-game': 0 });
      await Promise.resolve();
    });
    expect(mockPostsSummaryBatch).toHaveBeenCalledTimes(1);

    await act(async () => {
      emitAppState('active');
      await Promise.resolve();
    });
    expect(mockPostsSummaryBatch).toHaveBeenCalledTimes(2);

    await act(async () => {
      returnActivityDeferred.resolve({ 'live-game': 0 });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockPostsSummaryBatch).toHaveBeenCalledTimes(2);

    cleanupFocusEffects(focusCleanups);
  });

  it('coalesces a focus reload for unchanged activity ids but fetches newly loaded ids', async () => {
    useFeedFakeTimers(now);
    render(<FeedScreen />);
    let focusCleanups: Array<void | (() => void)> = [];
    const liveGame = {
      id: 'live-game',
      title: 'Central vs West',
      date: '2026-04-25T11:00:00.000Z',
      location: 'Main Gym',
    };

    await act(async () => {
      focusCleanups = runFocusEffects();
      firstGameDeferred.resolve({ games: [liveGame], nextCursor: null });
      await Promise.resolve();
    });
    expect(mockPostsSummaryBatch).toHaveBeenCalledTimes(1);
    cleanupFocusEffects(focusCleanups);

    await act(async () => {
      jest.advanceTimersByTime(31_000);
      await Promise.resolve();
    });
    const unchangedReload = createDeferred<any>();
    gameDeferredQueue.push(unchangedReload);
    await act(async () => {
      focusCleanups = runFocusEffects();
      await Promise.resolve();
    });
    expect(mockPostsSummaryBatch).toHaveBeenCalledTimes(2);
    await act(async () => {
      unchangedReload.resolve({ games: [liveGame], nextCursor: null });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockPostsSummaryBatch).toHaveBeenCalledTimes(2);
    cleanupFocusEffects(focusCleanups);

    await act(async () => {
      jest.advanceTimersByTime(31_000);
      await Promise.resolve();
    });
    const changedReload = createDeferred<any>();
    gameDeferredQueue.push(changedReload);
    await act(async () => {
      focusCleanups = runFocusEffects();
      await Promise.resolve();
    });
    expect(mockPostsSummaryBatch).toHaveBeenCalledTimes(3);
    await act(async () => {
      changedReload.resolve({
        games: [
          liveGame,
          {
            id: 'new-live-game',
            title: 'North vs South',
            date: '2026-04-25T11:30:00.000Z',
            location: 'North Gym',
          },
        ],
        nextCursor: null,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockPostsSummaryBatch).toHaveBeenCalledTimes(4);
    expect(mockPostsSummaryBatch).toHaveBeenLastCalledWith(['live-game', 'new-live-game']);

    cleanupFocusEffects(focusCleanups);
  });

  it('ignores a late activity response after the viewer identity changes', async () => {
    useFeedFakeTimers(now);
    mockAuthUser = { id: 'viewer-a' };
    const activityDeferred = createDeferred<Record<string, number>>();
    mockPostsSummaryBatch.mockImplementationOnce(() => activityDeferred.promise);
    const screen = render(<FeedScreen />);
    let focusCleanups: Array<void | (() => void)> = [];

    await act(async () => {
      focusCleanups = [runActivityFocusEffect()];
      firstGameDeferred.resolve({
        games: [
          {
            id: 'live-game',
            title: 'Central vs West',
            date: '2026-04-25T11:00:00.000Z',
            location: 'Main Gym',
          },
        ],
        nextCursor: null,
      });
      await Promise.resolve();
    });

    expect(mockPostsSummaryBatch).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('feed-game-card-live-game')).toHaveStyle({
      borderColor: '#EF4444',
    });

    const identityRefreshDeferred = createDeferred<any>();
    gameDeferredQueue.push(identityRefreshDeferred);
    await act(async () => {
      setMockAuthUser({ id: 'viewer-b' });
      await Promise.resolve();
    });
    await act(async () => {
      activityDeferred.resolve({ 'live-game': 1 });
      await Promise.resolve();
    });

    expect(screen.getByTestId('feed-game-card-live-game')).toHaveStyle({
      borderColor: '#EF4444',
    });

    await act(async () => {
      identityRefreshDeferred.resolve({
        games: [
          {
            id: 'live-game',
            title: 'Central vs West',
            date: '2026-04-25T11:00:00.000Z',
            location: 'Main Gym',
          },
        ],
        nextCursor: null,
      });
      await Promise.resolve();
    });
    cleanupFocusEffects(focusCleanups);
  });
});
