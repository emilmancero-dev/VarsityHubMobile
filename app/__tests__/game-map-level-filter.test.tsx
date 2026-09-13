import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';

const mockHttpGet = jest.fn();
const mockRouter = { push: jest.fn(), back: jest.fn() };
let mockMapProps: any;

jest.mock('@/context/AuthProvider', () => ({ useAuth: () => ({ user: { id: 'viewer' } }) }));
jest.mock('@/api/http', () => ({ httpGet: (...args: any[]) => mockHttpGet(...args) }));
jest.mock('@/hooks/useColorScheme', () => ({ useColorScheme: () => 'light' }));
jest.mock('expo-router', () => ({ useRouter: () => mockRouter, Stack: { Screen: () => null } }));
jest.mock('@expo/vector-icons/MaterialIcons', () => 'MaterialIcons');
jest.mock('@react-native-community/datetimepicker', () => 'DateTimePicker');
jest.mock('@/components/EventMap', () => {
  const { View, Text } = require('react-native');
  return {
    __esModule: true,
    default: (props: any) => {
      mockMapProps = props;
      return (
        <View>
          {props.events.map((event: any) => (
            <Text key={event.id}>{event.title}</Text>
          ))}
        </View>
      );
    },
  };
});
jest.mock('@/components/SportFilterBar', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: () => <View /> };
});

import GameMapScreen from '../game-map';

const card = (id: string, sport = 'basketball', level: string | null = null) => ({
  id,
  source_type: 'game',
  title: id,
  date: '2026-09-06T16:00:00.000Z',
  latitude: 40,
  longitude: -74,
  sport,
  league_level: level,
  upload_access: { can_upload_post: false },
});

async function openMap() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000, gcTime: 300_000 } },
  });
  render(
    <QueryClientProvider client={client}>
      <GameMapScreen />
    </QueryClientProvider>
  );
  await waitFor(() => expect(mockMapProps?.dataLoaded).toBe(true));
}

describe('Game map league-level filter', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-09-05T12:00:00.000Z') });
    mockMapProps = null;
    mockHttpGet.mockReset().mockResolvedValue({
      items: [
        card('NCAA game', 'football', 'college'),
        card('Major game', 'basketball', 'major'),
        card('Minor game', 'baseball', 'minor'),
        card('School event', 'soccer', null),
      ],
    });
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('requests each level before the server result limit and reuses cached All results', async () => {
    await openMap();

    for (const [label, title] of [
      ['NCAA', 'NCAA game'],
      ['Major', 'Major game'],
      ['Minor', 'Minor game'],
    ] as const) {
      fireEvent.press(screen.getByLabelText(`${label} leagues`));
      await waitFor(() => expect(mockMapProps.events.map((e: any) => e.title)).toEqual([title]));
    }

    // "Other" catches everything outside major/minor/college — here the
    // league-less school event.
    fireEvent.press(screen.getByLabelText('Other leagues'));
    await waitFor(() =>
      expect(mockMapProps.events.map((e: any) => e.title)).toEqual(['School event'])
    );

    // "All" restores every marker.
    fireEvent.press(screen.getByLabelText('All leagues'));
    expect(mockMapProps.events).toHaveLength(4);

    expect(mockHttpGet).toHaveBeenCalledTimes(5);
    for (const level of ['major', 'minor', 'college', 'other']) {
      expect(
        mockHttpGet.mock.calls.some(
          ([path]) => new URL(path, 'https://test').searchParams.get('level') === level
        )
      ).toBe(true);
    }
  });

  it('loads minor fixtures even when the bounded All response contains only major fixtures', async () => {
    mockHttpGet.mockImplementation((path: string) =>
      Promise.resolve({
        items: path.includes('level=minor')
          ? [card('Minor game', 'baseball', 'minor')]
          : [card('Major game', 'basketball', 'major')],
      })
    );
    await openMap();
    fireEvent.press(screen.getByLabelText('Minor leagues'));
    await waitFor(() =>
      expect(mockMapProps.events.map((e: any) => e.title)).toEqual(['Minor game'])
    );
  });

  it('does not replace a newer selection with a late response', async () => {
    await openMap();
    let resolveMinor!: (value: unknown) => void;
    mockHttpGet.mockImplementation((path: string) =>
      path.includes('level=minor')
        ? new Promise(resolve => {
            resolveMinor = resolve;
          })
        : Promise.resolve({ items: [card('Major game', 'basketball', 'major')] })
    );
    fireEvent.press(screen.getByLabelText('Minor leagues'));
    fireEvent.press(screen.getByLabelText('Major leagues'));
    await waitFor(() =>
      expect(mockMapProps.events.map((e: any) => e.title)).toEqual(['Major game'])
    );
    await act(async () => {
      resolveMinor({ items: [card('Minor game', 'baseball', 'minor')] });
    });
    expect(mockMapProps.events.map((e: any) => e.title)).toEqual(['Major game']);
  });

  it('shows a safe error instead of representing a failed request as an empty map', async () => {
    await openMap();
    mockHttpGet.mockRejectedValueOnce(new Error('database password=secret'));
    fireEvent.press(screen.getByLabelText('Minor leagues'));
    await screen.findByText('Unable to load events. Please check your connection.');
    expect(screen.queryByText(/password/)).toBeNull();
  });

  it('re-tapping the active level chip toggles back to All', async () => {
    await openMap();
    fireEvent.press(screen.getByLabelText('Major leagues'));
    await waitFor(() =>
      expect(mockMapProps.events.map((e: any) => e.title)).toEqual(['Major game'])
    );
    fireEvent.press(screen.getByLabelText('Major leagues'));
    expect(mockMapProps.events).toHaveLength(4);
  });
});
