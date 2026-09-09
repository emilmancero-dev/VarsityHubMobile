import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

// Map-only league-level filter (Major / Minor / NCAA / Other) on the events map.
// Pins that the chips filter the loaded markers client-side from the existing
// `league_level` metadata — no extra HTTP request — and that "Other" catches
// events with no league level. This filter regressed out of the production
// bundle once (a later OTA published from a branch that lacked it); this test
// keeps it from silently disappearing again.

const mockHttpGet = jest.fn();
const mockRouter = { push: jest.fn(), back: jest.fn() };
let mockMapProps: any;

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
  render(<GameMapScreen />);
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

  it('filters markers by level from metadata and never refetches', async () => {
    await openMap();

    for (const [label, title] of [
      ['NCAA', 'NCAA game'],
      ['Major', 'Major game'],
      ['Minor', 'Minor game'],
    ] as const) {
      fireEvent.press(screen.getByLabelText(`${label} leagues`));
      expect(mockMapProps.events.map((e: any) => e.title)).toEqual([title]);
    }

    // "Other" catches everything outside major/minor/college — here the
    // league-less school event.
    fireEvent.press(screen.getByLabelText('Other leagues'));
    expect(mockMapProps.events.map((e: any) => e.title)).toEqual(['School event']);

    // "All" restores every marker.
    fireEvent.press(screen.getByLabelText('All leagues'));
    expect(mockMapProps.events).toHaveLength(4);

    // Every filter change was client-side — the map loaded exactly once.
    expect(mockHttpGet).toHaveBeenCalledTimes(1);
  });

  it('re-tapping the active level chip toggles back to All', async () => {
    await openMap();
    fireEvent.press(screen.getByLabelText('Major leagues'));
    expect(mockMapProps.events.map((e: any) => e.title)).toEqual(['Major game']);
    fireEvent.press(screen.getByLabelText('Major leagues'));
    expect(mockMapProps.events).toHaveLength(4);
  });
});
