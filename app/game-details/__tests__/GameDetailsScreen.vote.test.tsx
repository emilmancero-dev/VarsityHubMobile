// Always use fake timers for this test file
jest.useFakeTimers();
// Mock Animated.timing and related methods to complete animations instantly in tests
jest.mock('react-native/Libraries/Animated/Animated', () => {
  const ActualAnimated = jest.requireActual('react-native/Libraries/Animated/Animated');
  return {
    ...ActualAnimated,
    timing: (value: any, config: any) => {
      return {
        start: (cb?: () => void) => {
          value.setValue(config.toValue);
          if (cb) cb();
        },
      };
    },
    parallel: (animations: any[]) => {
      return {
        start: (cb?: () => void) => {
          animations.forEach(anim => anim.start && anim.start());
          if (cb) cb();
        },
      };
    },
    sequence: (animations: any[]) => {
      return {
        start: (cb?: () => void) => {
          animations.forEach(anim => anim.start && anim.start());
          if (cb) cb();
        },
      };
    },
  };
});

// Mock requestAnimationFrame and cancelAnimationFrame for React Native animations
beforeAll(() => {
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback): number =>
    setTimeout(cb, 16) as unknown as number;
  globalThis.cancelAnimationFrame = (id: number) => clearTimeout(id);
});

afterAll(() => {
  (globalThis as any).requestAnimationFrame = undefined;
  (globalThis as any).cancelAnimationFrame = undefined;
});
// Use fake timers for all tests in this file

import { Event, Game } from '@/api/entities';
import { act, fireEvent, render, waitFor } from '@testing-library/react-native';
import GameDetailsScreen from '../GameDetailsScreen';
// Disable setInterval and setTimeout in tests to prevent polling loops
// Remove global setTimeout/setInterval mocks; rely on jest fake timers

let mockParams: { id?: string; eventId?: string } = { id: 'game-1', eventId: 'event-1' };

jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    canGoBack: () => true,
  }),
  useLocalSearchParams: () => mockParams,
}));

jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb: any) => {
    const React = require('react');
    React.useEffect(() => cb(), []);
  },
}));

jest.mock('react-native-gesture-handler', () => {
  const chain: any = {};
  chain.onUpdate = jest.fn(() => chain);
  chain.onEnd = jest.fn(() => chain);
  chain.runOnJS = jest.fn(() => chain);
  return {
    Gesture: {
      Pinch: jest.fn(() => chain),
      Pan: jest.fn(() => chain),
      Tap: jest.fn(() => chain),
      Simultaneous: jest.fn(() => chain),
    },
    GestureDetector: ({ children }: any) => children,
  };
});

jest.mock('react-native-reanimated', () => ({
  default: {
    View: 'Animated.View',
    Image: 'Animated.Image',
  },
  useAnimatedStyle: jest.fn(factory => factory()),
  useSharedValue: jest.fn(value => ({ value })),
  withSpring: jest.fn(value => value),
  withTiming: jest.fn(value => value),
  runOnJS: jest.fn(fn => fn),
}));

jest.mock('expo-image', () => {
  const React = require('react');
  return { Image: (props: any) => React.createElement('Image', props, props.children) };
});

jest.mock('expo-linear-gradient', () => {
  const React = require('react');
  return {
    LinearGradient: (props: any) => React.createElement('LinearGradient', props, props.children),
  };
});

jest.mock('expo-image-picker', () => ({
  VideoExportPreset: { MediumQuality: 2 },
}));

jest.mock('expo-video', () => ({
  VideoView: 'VideoView',
  useVideoPlayer: jest.fn(() => ({ play: jest.fn(), pause: jest.fn(), muted: false })),
}));

jest.mock('expo-media-library', () => ({
  requestPermissionsAsync: jest.fn(),
  saveToLibraryAsync: jest.fn(),
}));

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  return {
    SafeAreaView: (props: any) => React.createElement('SafeAreaView', props, props.children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});

jest.mock('@/hooks/useColorScheme', () => ({
  useColorScheme: () => 'light',
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

jest.mock('@/hooks/useShareLink', () => ({
  useShareLink: () => ({ share: jest.fn() }),
}));

jest.mock('@/hooks/useThemeColor', () => ({
  useThemeColor: () => '#111111',
}));

jest.mock('@/context/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'viewer-1' } }),
}));

jest.mock('@/utils/retryWithBackoff', () => ({
  retryWithBackoff: (fn: any) => fn(),
}));

jest.mock('@/api/upload', () => ({ uploadFile: jest.fn() }));

jest.mock('@/components/VideoPlayer', () => {
  const React = require('react');
  return (props: any) => React.createElement('VideoPlayer', props, props.children);
});

jest.mock('../../components/MatchBanner', () => {
  const React = require('react');
  return (props: any) => React.createElement('MatchBanner', props, props.children);
});

jest.mock('../GameVerticalFeedScreen', () => {
  const React = require('react');
  const MockScreen = (props: any) =>
    React.createElement('GameVerticalFeedScreen', props, props.children);
  return {
    __esModule: true,
    default: MockScreen,
    mapHighlightToFeedPost: (post: any) => post,
  };
});

jest.mock('@/api/entities', () => ({
  Game: {
    summary: jest.fn(),
    get: jest.fn(),
    posts: jest.fn(),
    media: jest.fn(),
    votesSummary: jest.fn(),
    castVote: jest.fn(),
    clearVote: jest.fn(),
    deleteMedia: jest.fn(),
  },
  Post: {
    feedForGame: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getByEvent: jest.fn().mockResolvedValue({ items: [] }),
  },
  Event: {
    stories: jest.fn().mockResolvedValue({ items: [] }),
    get: jest.fn().mockResolvedValue({
      id: 'event-1',
      title: 'UMass at Rutgers',
      date: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      location: 'Test Field',
      banner_url: null,
      cover_image_url: null,
      capacity: 100,
      attendees_count: 0,
      event_type: 'game',
    }),
    rsvp: jest.fn(),
    rsvpStatus: jest.fn().mockResolvedValue({ count: 0, capacity: 100, going: false }),
    votesSummary: jest.fn(),
    castVote: jest.fn(),
    clearVote: jest.fn(),
  },
  Team: {
    list: jest.fn().mockResolvedValue([]),
  },
  User: {
    me: jest.fn().mockResolvedValue(null),
  },
}));

const baseSummary = {
  id: 'game-1',
  gameId: 'game-1',
  eventId: 'event-1',
  title: 'Home vs Away',
  date: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  homeTeam: 'Home',
  awayTeam: 'Away',
  teams: [],
  posts: [],
  media: [],
  isPast: false,
  location: 'Test Field',
  rsvpCount: 0,
  capacity: 100,
  userRsvped: false,
  reviewsCount: 0,
  userVote: null,
  event_type: 'game',
  // Add any other fields your GameVM expects
};

describe('GameDetailsScreen voting UI', () => {
  beforeEach(() => {
    jest.setTimeout(15000);
    mockParams = { id: 'game-1', eventId: 'event-1' };
    (Game.summary as jest.Mock).mockResolvedValue(baseSummary);
    (Game.get as jest.Mock).mockResolvedValue(baseSummary);
    (Game.posts as jest.Mock).mockResolvedValue([]);
    (Game.media as jest.Mock).mockResolvedValue([]);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('casts a vote when pressing team A', async () => {
    // First call: before voting, Second call: after voting
    (Game.votesSummary as jest.Mock)
      .mockResolvedValueOnce({ teamA: 0, teamB: 0, userVote: null })
      .mockResolvedValueOnce({ teamA: 1, teamB: 0, userVote: 'A' });
    (Game.castVote as jest.Mock).mockResolvedValue({ teamA: 1, teamB: 0, userVote: 'A' });

    if (__DEV__) console.log('Rendering GameDetailsScreen');
    const screen = render(<GameDetailsScreen />);
    if (__DEV__) console.log('Rendered GameDetailsScreen');
    // Flush timers and microtasks to allow all effects to run
    await act(async () => {
      jest.runOnlyPendingTimers();
      await Promise.resolve();
    });

    const voteAButton = await screen.findByLabelText('Vote for Home');

    fireEvent.press(voteAButton);
    await act(async () => {
      jest.runAllTimers();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(Game.castVote).toHaveBeenCalledWith('game-1', 'A');
    });
  });

  it('clears a vote on long press when already selected', async () => {
    (Game.votesSummary as jest.Mock).mockResolvedValue({ teamA: 1, teamB: 0, userVote: 'A' });
    (Game.clearVote as jest.Mock).mockResolvedValue({ teamA: 0, teamB: 0, userVote: null });

    if (__DEV__) console.log('Rendering GameDetailsScreen');
    const screen = render(<GameDetailsScreen />);
    if (__DEV__) console.log('Rendered GameDetailsScreen');
    await act(async () => {
      jest.runOnlyPendingTimers();
      await Promise.resolve();
    });

    await screen.findByText(/Your pick: Home/);
    const voteAButton = screen
      .UNSAFE_getAllByProps({ accessibilityLabel: 'Vote for Home' })
      .find(node => typeof node.props.onLongPress === 'function');

    await act(async () => {
      expect(voteAButton?.props.onLongPress).toEqual(expect.any(Function));
      voteAButton!.props.onLongPress();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(Game.clearVote).toHaveBeenCalledWith('game-1');
    });
  });

  it('casts a persistent vote on event-only competitive pages', async () => {
    mockParams = { id: 'event-1', eventId: 'event-1' };
    (Event.votesSummary as jest.Mock).mockResolvedValue({ teamA: 0, teamB: 0, userVote: null });
    (Event.castVote as jest.Mock).mockResolvedValue({ teamA: 1, teamB: 0, userVote: 'A' });

    const screen = render(<GameDetailsScreen />);
    await act(async () => {
      jest.runOnlyPendingTimers();
      await Promise.resolve();
    });

    const voteAButton = await screen.findByLabelText('Vote for UMass');

    fireEvent.press(voteAButton);
    await act(async () => {
      jest.runAllTimers();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(Event.castVote).toHaveBeenCalledWith('event-1', 'A');
    });
    expect(Game.castVote).not.toHaveBeenCalledWith('event-1', 'A');
  });
});
