/**
 * Render smoke test for the react-query-migrated Discover/Community screen
 * (app/(tabs)/discover/mobile-community.tsx). Verifies the games +
 * personalization queries mount after the InteractionManager deferral and an
 * upcoming game row renders.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { RefreshControl } from 'react-native';

beforeAll(() => jest.useFakeTimers());
afterAll(() => jest.useRealTimers());

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
jest.mock('@/components/PostCard', () =>
  require('@/test-utils/screenMocks').childSentinelMock('PostCard')()
);
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
const mockSuggested = jest.fn();
const mockHttpGet = jest.fn();
const mockTeamFollow = jest.fn();
const mockTeamUnfollow = jest.fn();
const mockSearch = jest.fn();
jest.mock('@/api/entities', () => ({
  __esModule: true,
  Game: { list: (...args: any[]) => mockGameList(...args), create: jest.fn() },
  Event: { filter: (...args: any[]) => mockEventFilter(...args) },
  Post: {
    trendingPage: (...args: any[]) => mockTrendingPage(...args),
    listPage: jest.fn().mockResolvedValue({ items: [] }),
    list: jest.fn().mockResolvedValue([]),
  },
  Team: {
    allMembers: jest.fn().mockResolvedValue([]),
    follow: (...args: any[]) => mockTeamFollow(...args),
    unfollow: (...args: any[]) => mockTeamUnfollow(...args),
  },
  User: {
    listAll: jest.fn().mockResolvedValue([]),
    suggested: (...args: any[]) => mockSuggested(...args),
    follow: jest.fn(),
    unfollow: jest.fn(),
  },
  Search: { unified: (...args: any[]) => mockSearch(...args) },
  Organization: { list: jest.fn().mockResolvedValue([]) },
}));
jest.mock('@/api/http', () => ({
  httpGet: (...args: any[]) => mockHttpGet(...args),
}));
jest.mock('@/context/AuthProvider', () => ({
  useAuth: () => ({
    user: { id: 'u1' },
    checkAuth: jest.fn().mockResolvedValue({ id: 'u1', preferences: {} }),
  }),
}));
jest.mock('@/hooks/useColorScheme', () => ({ useColorScheme: () => 'light' }));
jest.mock('@/utils/authState', () => ({
  ...jest.requireActual('@/utils/authState'),
  getAuthSnapshot: jest.fn().mockResolvedValue({ id: 'u1', preferences: {} }),
  getCanonicalOrganizationId: jest.fn().mockReturnValue(null),
}));
jest.mock('@/utils/analytics', () => ({
  analytics: { track: jest.fn() },
  ANALYTICS_EVENTS: new Proxy({}, { get: (_t, p) => String(p) }),
}));

import MobileCommunityScreen from '../(tabs)/discover/mobile-community';
import { QueryWrapper } from '../../test-utils/screenMocks';

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
  mockGameList.mockReset().mockResolvedValue([sampleGame]);
  mockEventFilter.mockReset().mockResolvedValue([]);
  mockTrendingPage.mockReset().mockResolvedValue({ items: [] });
  mockSuggested.mockReset().mockResolvedValue({ items: [] });
  mockHttpGet.mockReset().mockResolvedValue({ items: [] });
  mockTeamFollow.mockReset().mockResolvedValue({});
  mockTeamUnfollow.mockReset().mockResolvedValue({});
  mockSearch.mockReset().mockResolvedValue({});
});

describe('MobileCommunityScreen (react-query render smoke)', () => {
  it('reloads the followed calendar after following and unfollowing a team', async () => {
    mockSearch.mockResolvedValue({ teams: [{ id: 't1', name: 'Tigers', is_following: false }] });
    render(
      <QueryWrapper>
        <MobileCommunityScreen />
      </QueryWrapper>
    );
    act(() => {
      jest.runOnlyPendingTimers();
    });
    expect(await screen.findByText('Tigers vs Sharks')).toBeTruthy();
    await waitFor(() =>
      expect(mockHttpGet).toHaveBeenCalledWith('/event-discovery?scope=following')
    );
    fireEvent.changeText(
      screen.getByPlaceholderText('Search people, teams, organizations, games, events, or zip...'),
      'Tigers'
    );
    act(() => {
      jest.advanceTimersByTime(250);
    });
    const follow = await screen.findByLabelText('Follow team Tigers');
    mockHttpGet.mockClear();
    fireEvent.press(follow, { stopPropagation: jest.fn() });
    await waitFor(() => expect(mockTeamFollow).toHaveBeenCalledWith('t1'));
    await waitFor(() =>
      expect(mockHttpGet).toHaveBeenCalledWith('/event-discovery?scope=following')
    );
    mockHttpGet.mockClear();
    fireEvent.press(await screen.findByLabelText('Unfollow team Tigers'), {
      stopPropagation: jest.fn(),
    });
    await waitFor(() => expect(mockTeamUnfollow).toHaveBeenCalledWith('t1'));
    await waitFor(() =>
      expect(mockHttpGet).toHaveBeenCalledWith('/event-discovery?scope=following')
    );
  });
  it('refreshes the followed calendar together with games, posts and suggestions', async () => {
    const view = render(
      <QueryWrapper>
        <MobileCommunityScreen />
      </QueryWrapper>
    );
    act(() => {
      jest.runOnlyPendingTimers();
    });
    expect(await screen.findByText('Tigers vs Sharks')).toBeTruthy();
    await waitFor(() =>
      expect(mockHttpGet).toHaveBeenCalledWith('/event-discovery?scope=following')
    );
    mockHttpGet.mockClear();
    mockSuggested.mockClear();
    await act(async () => {
      await view.UNSAFE_getByType(RefreshControl).props.onRefresh();
    });
    expect(mockHttpGet).toHaveBeenCalledWith('/event-discovery?scope=following');
    expect(mockSuggested).toHaveBeenCalledTimes(1);
  });
  it('shows games while suggestions are still pending, with only one suggestions request', async () => {
    mockSuggested.mockReturnValue(new Promise(() => {}));
    render(
      <QueryWrapper>
        <MobileCommunityScreen />
      </QueryWrapper>
    );
    act(() => {
      jest.runOnlyPendingTimers();
    });
    expect(await screen.findByText('Tigers vs Sharks')).toBeTruthy();
    expect(mockSuggested).toHaveBeenCalledTimes(1);
  });

  it('shows a posts error instead of converting a failed request into empty success', async () => {
    mockTrendingPage.mockRejectedValue(
      Object.assign(new Error('Network unavailable'), { status: 503 })
    );
    render(
      <QueryWrapper>
        <MobileCommunityScreen />
      </QueryWrapper>
    );
    act(() => {
      jest.runOnlyPendingTimers();
    });
    expect(await screen.findByText('Tigers vs Sharks')).toBeTruthy();
    expect(
      await screen.findByText('Posts are temporarily unavailable. Pull to refresh to try again.')
    ).toBeTruthy();
  });

  it('shows a suggestions error without holding the games list', async () => {
    mockSuggested.mockRejectedValue(new Error('Network unavailable'));
    render(
      <QueryWrapper>
        <MobileCommunityScreen />
      </QueryWrapper>
    );
    act(() => {
      jest.runOnlyPendingTimers();
    });
    expect(await screen.findByText('Tigers vs Sharks')).toBeTruthy();
    expect(
      await screen.findByText(
        'People suggestions are temporarily unavailable. Pull to refresh to try again.'
      )
    ).toBeTruthy();
  });
  it('mounts, runs the games + personalization queries, and renders a game row', async () => {
    render(
      <QueryWrapper>
        <MobileCommunityScreen />
      </QueryWrapper>
    );
    // Queries are gated behind InteractionManager.runAfterInteractions.
    act(() => {
      jest.runOnlyPendingTimers();
    });
    await waitFor(() =>
      expect(mockGameList).toHaveBeenCalledWith(
        'date',
        expect.objectContaining({ dateFrom: expect.any(String), limit: 100 })
      )
    );
    await waitFor(() => expect(mockEventFilter).toHaveBeenCalled());
    await waitFor(() => expect(mockTrendingPage).toHaveBeenCalled());
    expect(await screen.findByText('Tigers vs Sharks')).toBeTruthy();
  });
});
