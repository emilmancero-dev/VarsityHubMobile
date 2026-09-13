/**
 * Regression test for the team-page refetch storm (invalid/nonexistent id).
 *
 * Opening team-page with a bogus id (e.g. deep link
 * varsityhubmobile://team-page?id=bogus_team_999) must settle into the error
 * state after one fetch cycle. The bug: the focus-refetch useFocusEffect was
 * keyed on the useQuery result object, whose identity changes on every query
 * state transition — so each failed fetch re-ran the effect, which called
 * refetch(), which failed again, forever (~2 fetch cycles/sec, eventually
 * tripping the server rate limiter and pinning the screen on a spinner).
 */
import { act, render, screen, waitFor } from '@testing-library/react-native';

jest.mock('expo-image', () => require('@/test-utils/screenMocks').expoImageMock());
jest.mock('expo-linear-gradient', () =>
  require('@/test-utils/screenMocks').expoLinearGradientMock()
);
jest.mock('react-native-safe-area-context', () =>
  require('@/test-utils/screenMocks').safeAreaMock()
);
// The focus callback routes through useEffect keyed on the callback, matching
// the real useFocusEffect contract (re-runs when the callback identity
// changes) — which is exactly what the storm regression depends on.
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  ...require('@/test-utils/screenMocks').reactNavigationOverrides(),
}));
jest.mock('expo-router', () => ({
  ...jest.requireActual('expo-router'),
  ...require('@/test-utils/screenMocks').expoRouterOverrides(),
  useLocalSearchParams: () => ({ id: 'bogus_team_999' }),
}));
// Heavy media child pulls in expo-video, which can't load under jest.
jest.mock('../game-details/GameVerticalFeedScreen', () =>
  require('@/test-utils/screenMocks').childSentinelMock('GameVerticalFeed')()
);

const mockScreenSummary = jest.fn();
const mockTeamGet = jest.fn();
const mockTeamList = jest.fn();
jest.mock('@/api/entities', () => ({
  __esModule: true,
  Team: {
    screenSummary: (...args: any[]) => mockScreenSummary(...args),
    get: (...args: any[]) => mockTeamGet(...args),
    list: (...args: any[]) => mockTeamList(...args),
    follow: jest.fn(),
    unfollow: jest.fn(),
    members: jest.fn().mockResolvedValue([]),
  },
  Game: { list: jest.fn().mockResolvedValue([]) },
  Post: { filter: jest.fn().mockResolvedValue([]) },
}));
jest.mock('@/context/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'u1' } }),
}));
jest.mock('@/hooks/useCustomColorScheme', () => ({
  useCustomColorScheme: () => 'light',
}));

import TeamScreen from '../team-page';
import { QueryWrapper } from '../../test-utils/screenMocks';

beforeEach(() => {
  // Mirrors the production failure: screen-summary and get 404, and the
  // /teams list fallback also rejects (unauthenticated or rate-limited).
  mockScreenSummary.mockReset().mockRejectedValue(new Error('404: team not found'));
  mockTeamGet.mockReset().mockRejectedValue(new Error('404: team not found'));
  mockTeamList.mockReset().mockRejectedValue(new Error('429: too many requests'));
});

describe('TeamScreen with a nonexistent team id', () => {
  it('settles into the error state without a refetch storm', async () => {
    render(
      <QueryWrapper>
        <TeamScreen />
      </QueryWrapper>
    );

    await waitFor(() => expect(mockScreenSummary).toHaveBeenCalled());

    // Give the screen several async turns; a focus-effect refetch loop keeps
    // issuing new fetch cycles during this window.
    for (let i = 0; i < 8; i++) {
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 25));
      });
    }

    // One mount fetch only (test client has retry disabled) — the storm
    // regression pushes this into the dozens.
    expect(mockScreenSummary.mock.calls.length).toBeLessThanOrEqual(2);
    // Error copy now flows through the shared toUserMessage() fallback
    // ("Failed to load team data") instead of a hardcoded "Could not load
    // team" string — the storm-prevention behavior above is what this test
    // actually guards.
    expect(screen.getByText(/failed to load team data/i)).toBeTruthy();
  });
});
