/**
 * Render smoke test for the react-query-migrated Discover/Community screen
 * (app/(tabs)/discover/mobile-community.tsx). Verifies the games +
 * personalization queries mount after the InteractionManager deferral and an
 * upcoming game row renders.
 */
import { QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { Alert, FlatList, InteractionManager } from 'react-native';

jest.mock('expo-image', () => require('@/test-utils/screenMocks').expoImageMock());
jest.mock('expo-linear-gradient', () =>
  require('@/test-utils/screenMocks').expoLinearGradientMock()
);
jest.mock('react-native-safe-area-context', () =>
  require('@/test-utils/screenMocks').safeAreaMock()
);
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  ...require('@/test-utils/screenMocks').expoRouterOverrides(),
}));
// Heavy children irrelevant to the query wiring under test.
jest.mock('@/components/EventMap', () =>
  require('@/test-utils/screenMocks').childSentinelMock('EventMap')()
);
jest.mock('@/components/PostCard', () => ({
  __esModule: true,
  default: (props: any) => {
    const React = require('react');
    const { Text } = require('react-native');
    return React.createElement(Text, null, props.post?.caption ?? 'Post');
  },
}));
jest.mock('@/components/QuickAddGameModal', () =>
  require('@/test-utils/screenMocks').childSentinelMock('QuickAddGameModal')()
);
jest.mock('@/components/SwipeBackContainer', () =>
  require('@/test-utils/screenMocks').childSentinelMock('SwipeBackContainer')()
);
jest.mock('react-native-calendars', () => ({
  Calendar: require('@/test-utils/screenMocks').hostPassthrough('Calendar'),
}));
jest.mock('../game-details/GameVerticalFeedScreen', () => ({
  __esModule: true,
  default: require('@/test-utils/screenMocks').hostPassthrough('GameVerticalFeedScreen'),
}));
jest.mock('@/hooks/useDeviceLocation', () => ({
  useDeviceLocation: () => ({
    location: null,
    loading: false,
    error: null,
    permissionGranted: false,
    requestPermission: jest.fn(),
    needsPreciseAccuracy: false,
    openSettings: jest.fn(),
  }),
}));

const mockGameList = jest.fn();
const mockEventFilter = jest.fn();
const mockTrendingPage = jest.fn();
const mockPostListPage = jest.fn();
const mockPostList = jest.fn();
const mockSuggested = jest.fn();
const mockFollow = jest.fn();
const mockUnfollow = jest.fn();
const mockHttpGet = jest.fn();
let mockAuthUser: any = { id: 'u1' };
const originalConsoleError = console.error;
jest.mock('@/api/entities', () => ({
  __esModule: true,
  Game: { list: (...args: any[]) => mockGameList(...args), create: jest.fn() },
  Event: { filter: (...args: any[]) => mockEventFilter(...args) },
  Post: {
    trendingPage: (...args: any[]) => mockTrendingPage(...args),
    listPage: (...args: any[]) => mockPostListPage(...args),
    list: (...args: any[]) => mockPostList(...args),
  },
  Team: { allMembers: jest.fn().mockResolvedValue([]), managed: jest.fn().mockResolvedValue([]) },
  User: {
    listAll: jest.fn().mockResolvedValue([]),
    suggested: (...args: any[]) => mockSuggested(...args),
    follow: (...args: any[]) => mockFollow(...args),
    unfollow: (...args: any[]) => mockUnfollow(...args),
  },
  Search: { unified: jest.fn().mockResolvedValue({}) },
  Organization: { list: jest.fn().mockResolvedValue([]) },
}));
jest.mock('@/api/http', () => ({
  httpGet: (...args: any[]) => mockHttpGet(...args),
}));
jest.mock('@/context/AuthProvider', () => ({
  useAuth: () => ({
    user: mockAuthUser,
    checkAuth: jest
      .fn()
      .mockResolvedValue(
        mockAuthUser ? { ...mockAuthUser, preferences: mockAuthUser.preferences ?? {} } : null
      ),
  }),
}));
jest.mock('@/hooks/useColorScheme', () => ({ useColorScheme: () => 'light' }));
jest.mock('@/utils/authState', () => ({
  ...jest.requireActual('@/utils/authState'),
  getAuthSnapshot: jest
    .fn()
    .mockImplementation(async () =>
      mockAuthUser ? { ...mockAuthUser, preferences: mockAuthUser.preferences ?? {} } : null
    ),
  getCanonicalOrganizationId: jest.fn().mockReturnValue(null),
}));
jest.mock('@/utils/analytics', () => ({
  analytics: { track: jest.fn() },
  ANALYTICS_EVENTS: new Proxy({}, { get: (_t, p) => String(p) }),
}));
jest.mock('@/utils/sentry', () => ({
  captureBreadcrumb: jest.fn(),
  captureException: jest.fn(),
}));

import MobileCommunityScreen from '../(tabs)/discover/mobile-community';
import { createTestQueryClient } from '../../test-utils/screenMocks';

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const renderScreen = () => {
  const queryClient = createTestQueryClient();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MobileCommunityScreen />
    </QueryClientProvider>
  );
  return { ...view, queryClient };
};

const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const sampleGame = {
  id: 'g1',
  title: 'Tigers vs Sharks',
  date: tomorrow,
  location: 'Main Gym',
  home_team: 'Tigers',
  away_team: 'Sharks',
};

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation((message?: any, ...args: any[]) => {
    if (String(message).includes('not wrapped in act')) return;
    originalConsoleError(message, ...args);
  });
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  jest.spyOn(InteractionManager, 'runAfterInteractions').mockImplementation((callback: any) => {
    if (typeof callback === 'function') callback();
    else callback?.gen?.();
    return { cancel: jest.fn() } as any;
  });
  mockAuthUser = { id: 'u1' };
  mockGameList.mockReset().mockResolvedValue([sampleGame]);
  mockEventFilter.mockReset().mockResolvedValue([]);
  mockTrendingPage.mockReset().mockResolvedValue({ items: [] });
  mockPostListPage.mockReset().mockResolvedValue({ items: [] });
  mockPostList.mockReset().mockResolvedValue([]);
  mockSuggested.mockReset().mockResolvedValue({ items: [] });
  mockFollow.mockReset().mockResolvedValue({});
  mockUnfollow.mockReset().mockResolvedValue({});
  mockHttpGet.mockReset().mockResolvedValue({ items: [] });
});

afterEach(() => jest.restoreAllMocks());

describe('MobileCommunityScreen (react-query render smoke)', () => {
  it('mounts, runs the games + personalization queries, and renders a game row', async () => {
    await renderScreen();
    await waitFor(() =>
      expect(mockGameList).toHaveBeenCalledWith(
        'date',
        expect.objectContaining({ dateFrom: expect.any(String), limit: 100 })
      )
    );
    await waitFor(() => expect(mockEventFilter).toHaveBeenCalled());
    await waitFor(() => expect(mockTrendingPage).toHaveBeenCalled());
    expect(await screen.findByText('Tigers vs Sharks')).toBeTruthy();
    expect(mockSuggested).toHaveBeenCalledTimes(1);
    expect(mockSuggested).toHaveBeenCalledWith(20);
  });

  it('renders ready games while people suggestions are still pending', async () => {
    const suggestions = deferred<any>();
    mockSuggested.mockReturnValueOnce(suggestions.promise);

    await renderScreen();

    expect(await screen.findByText('Tigers vs Sharks')).toBeTruthy();
    expect(screen.getByText('Loading people suggestions…')).toBeTruthy();
  });

  it('shows a retry state when all post methods fail without calling legacy post methods', async () => {
    mockTrendingPage.mockRejectedValueOnce(new Error('offline'));
    mockPostListPage.mockRejectedValue(new Error('legacy page failed'));
    mockPostList.mockRejectedValue(new Error('legacy list failed'));

    await renderScreen();

    expect(await screen.findByText('Posts are temporarily unavailable.')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Retry posts'));
    await waitFor(() => expect(mockTrendingPage).toHaveBeenCalledTimes(2));
    expect(mockPostListPage).not.toHaveBeenCalled();
    expect(mockPostList).not.toHaveBeenCalled();
  });

  it('keeps successful posts visible and reports a failed refresh', async () => {
    mockTrendingPage
      .mockResolvedValueOnce({ items: [{ id: 'p1', caption: 'Winning play' }] })
      .mockRejectedValueOnce(new Error('refresh failed'));
    const view = await renderScreen();
    expect(await screen.findByText('Winning play')).toBeTruthy();

    act(() => {
      void view.UNSAFE_getByType(FlatList).props.onRefresh();
    });

    expect(await screen.findByText('Could not refresh posts. Showing saved results.')).toBeTruthy();
    expect(screen.getByText('Winning play')).toBeTruthy();
    expect(screen.getByLabelText('Retry posts')).toBeTruthy();
  });

  it('shows an honest empty state when suggestions return no people', async () => {
    await renderScreen();

    expect(await screen.findByText('No people suggestions right now.')).toBeTruthy();
  });

  it('shows an actionable error when people suggestions fail', async () => {
    mockSuggested.mockRejectedValueOnce(new Error('offline'));
    await renderScreen();

    expect(await screen.findByText('People suggestions are temporarily unavailable.')).toBeTruthy();
    fireEvent.press(screen.getByLabelText('Retry people suggestions'));
    await waitFor(() => expect(mockSuggested).toHaveBeenCalledTimes(2));
  });

  it('reports a failed follow action instead of silently swallowing it', async () => {
    mockSuggested.mockResolvedValueOnce({ items: [{ id: 'friend-1', username: 'teammate' }] });
    mockFollow.mockRejectedValueOnce(new Error('follow failed'));
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    await renderScreen();

    fireEvent.press(await screen.findByText('Follow'));

    await waitFor(() =>
      expect(alertSpy).toHaveBeenCalledWith(
        'Unable to follow',
        'Please try again. Your follow was not changed.'
      )
    );
  });

  it('does not show a permanent calendar loading state to signed-out viewers', async () => {
    mockAuthUser = null;
    await renderScreen();

    expect(await screen.findByText('Tigers vs Sharks')).toBeTruthy();
    expect(screen.queryByText('Loading calendar…')).toBeNull();
  });

  it('refreshes the followed calendar with the active list surface', async () => {
    const view = await renderScreen();
    await waitFor(() =>
      expect(mockHttpGet).toHaveBeenCalledWith('/event-discovery?scope=following')
    );

    act(() => {
      void view.UNSAFE_getByType(FlatList).props.onRefresh();
    });

    await waitFor(() =>
      expect(
        mockHttpGet.mock.calls.filter(([path]) => path === '/event-discovery?scope=following')
      ).toHaveLength(2)
    );
  });

  it('isolates suggestions when the signed-in viewer changes mid-request', async () => {
    const firstViewer = deferred<any>();
    const secondViewer = deferred<any>();
    mockSuggested
      .mockReturnValueOnce(firstViewer.promise)
      .mockReturnValueOnce(secondViewer.promise);
    const view = await renderScreen();
    await waitFor(() => expect(mockSuggested).toHaveBeenCalledTimes(1));

    mockAuthUser = { id: 'u2' };
    view.rerender(
      <QueryClientProvider client={view.queryClient}>
        <MobileCommunityScreen />
      </QueryClientProvider>
    );
    await waitFor(() => expect(mockSuggested).toHaveBeenCalledTimes(2));

    act(() => {
      secondViewer.resolve({ items: [{ id: 'new-user', username: 'newviewerfriend' }] });
    });
    expect(await screen.findAllByText('newviewerfriend')).toHaveLength(2);

    act(() => {
      firstViewer.resolve({ items: [{ id: 'old-user', username: 'oldviewerfriend' }] });
    });
    await waitFor(() => expect(screen.queryByText('oldviewerfriend')).toBeNull());
  });
});
