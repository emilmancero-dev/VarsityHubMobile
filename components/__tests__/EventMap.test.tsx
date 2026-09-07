import { cleanup, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import EventMap, {
  resolveMarkerColor,
  GAME_MARKER_COLOR,
  SPORT_TEAM_MARKER_COLOR,
} from '../EventMap';
import type { EventMapProps } from '../EventMap.types';

const flushPromises = () => new Promise<void>(resolve => setImmediate(resolve));

// Mock react-native-maps. The MapView mock forwards the ref and exposes no-op
// implementations of the imperative methods EventMap calls (fitToCoordinates,
// animateToRegion), so ref-based calls don't throw during tests.
jest.mock('react-native-maps', () => {
  const ReactMock = require('react');
  const { View } = require('react-native');
  const MapViewMock = ReactMock.forwardRef((props: any, ref: any) => {
    ReactMock.useImperativeHandle(ref, () => ({
      fitToCoordinates: jest.fn(),
      animateToRegion: jest.fn(),
    }));
    return ReactMock.createElement(View, { testID: 'MapView', ...props }, props.children);
  });
  return {
    __esModule: true,
    default: MapViewMock,
    MapView: MapViewMock,
    Marker: (props: any) =>
      ReactMock.createElement(View, { testID: 'Marker', ...props }, props.children),
  };
});

jest.mock('expo-location', () => ({
  requestForegroundPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'granted' })),
  getCurrentPositionAsync: jest.fn(() =>
    Promise.resolve({
      coords: {
        latitude: 37.7749,
        longitude: -122.4194,
        altitude: null,
        accuracy: 10,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
      },
      timestamp: Date.now(),
    })
  ),
}));

jest.mock('@/hooks/useColorScheme', () => ({
  useColorScheme: () => 'light',
}));

jest.mock('@/utils/sentry', () => ({
  captureBreadcrumb: jest.fn(),
}));

const mockEvents = [
  {
    id: '1',
    title: 'Test Event',
    latitude: 37.7749,
    longitude: -122.4194,
    date: new Date().toISOString(),
  },
];

const baseRegion = {
  latitude: 37.7749,
  longitude: -122.4194,
  latitudeDelta: 0.1,
  longitudeDelta: 0.1,
};

// Skip the initial loading-state await by not requesting user location —
// EventMap gates the map render on an async Location call when showUserLocation
// is true, which is the only reason the "Loading map..." view is visible.
const baseProps = (overrides: Partial<EventMapProps> = {}): EventMapProps => ({
  events: mockEvents,
  onEventPress: jest.fn(),
  initialRegion: baseRegion,
  showUserLocation: false,
  ...overrides,
});

describe('EventMap', () => {
  afterEach(async () => {
    cleanup();
    jest.clearAllTimers();
    await flushPromises();
  });

  it('renders a Marker for each event with coordinates', async () => {
    const { findAllByTestId } = render(<EventMap {...baseProps()} />);
    const markers = await findAllByTestId('Marker');
    expect(markers.length).toBe(1);
  });

  it('colors game pins with the game category color', () => {
    expect(resolveMarkerColor({ type: 'game' })).toBe(GAME_MARKER_COLOR);
  });

  it('does not render native markers for invalid coordinates', async () => {
    const events = [
      mockEvents[0],
      { ...mockEvents[0], id: 'nan-lat', latitude: Number.NaN },
      { ...mockEvents[0], id: 'inf-lng', longitude: Number.POSITIVE_INFINITY },
      { ...mockEvents[0], id: 'bad-lat', latitude: 91 },
      { ...mockEvents[0], id: 'bad-lng', longitude: -181 },
      { ...mockEvents[0], id: 'string-lat', latitude: '37.7749' as any },
    ];

    const { findAllByTestId } = render(<EventMap {...baseProps({ events })} />);
    const markers = await findAllByTestId('Marker');

    expect(markers.length).toBe(1);
    expect(markers[0].props.coordinate).toEqual({
      latitude: mockEvents[0].latitude,
      longitude: mockEvents[0].longitude,
    });
  });

  it('shows a marker preview first, then opens details from the preview', async () => {
    const onEventPress = jest.fn();
    const { findByTestId, findByText } = render(<EventMap {...baseProps({ onEventPress })} />);
    const marker = await findByTestId('Marker');
    fireEvent.press(marker);

    expect(onEventPress).not.toHaveBeenCalled();
    expect(await findByText('Test Event')).toBeTruthy();

    fireEvent.press(await findByTestId('map-marker-preview'));
    expect(onEventPress).toHaveBeenCalledWith('1', undefined);
  });

  it('does not surface a create-post shortcut from marker previews', async () => {
    const onEventPress = jest.fn();
    const onCreatePostPress = jest.fn();
    const eventWithTarget = {
      ...mockEvents[0],
      event_id: 'event-1',
      game_id: 'game-1',
      type: 'game' as const,
    };
    const { findByTestId, queryByTestId } = render(
      <EventMap
        {...baseProps({
          events: [eventWithTarget],
          onEventPress,
          onCreatePostPress,
        })}
      />
    );

    fireEvent.press(await findByTestId('Marker'));

    expect(queryByTestId('map-marker-create-post')).toBeNull();
    expect(onCreatePostPress).not.toHaveBeenCalled();
    expect(onEventPress).not.toHaveBeenCalled();
  });

  it('removes a selected preview when filtering removes its event', async () => {
    const screen = render(<EventMap {...baseProps()} />);
    fireEvent.press(await screen.findByTestId('Marker'));
    expect(screen.queryByTestId('map-marker-preview')).toBeTruthy();
    screen.rerender(<EventMap {...baseProps({ events: [] })} />);
    expect(screen.queryByTestId('map-marker-preview')).toBeNull();
  });

  it('closes marker previews without navigating', async () => {
    const onEventPress = jest.fn();
    const { findByTestId, queryByText } = render(<EventMap {...baseProps({ onEventPress })} />);

    fireEvent.press(await findByTestId('Marker'));
    expect(queryByText('Test Event')).toBeTruthy();

    fireEvent.press(await findByTestId('map-marker-preview-close'));

    expect(queryByText('Test Event')).toBeNull();
    expect(onEventPress).not.toHaveBeenCalled();
  });

  it('dedupes preview press + native callout press so one tap cannot open two pages', async () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValueOnce(1000).mockReturnValueOnce(1100);
    const onEventPress = jest.fn();
    const { findByTestId } = render(<EventMap {...baseProps({ onEventPress })} />);
    const marker = await findByTestId('Marker');

    fireEvent.press(marker);
    fireEvent.press(await findByTestId('map-marker-preview'));
    fireEvent(marker, 'onCalloutPress');

    expect(onEventPress).toHaveBeenCalledTimes(1);
    nowSpy.mockRestore();
  });

  it('renders empty state when no events', async () => {
    const { findByText } = render(<EventMap {...baseProps({ events: [] })} />);
    const empty = await findByText(/no matching events/i);
    expect(empty).toBeTruthy();
  });

  it('searches loaded map event pins by venue, sport, and league metadata', async () => {
    const events = [
      {
        id: 'tennis-1',
        title: 'Player One vs Player Two - US Open',
        location: 'USTA Billie Jean King National Tennis Center',
        latitude: 40.7499,
        longitude: -73.8476,
        date: new Date().toISOString(),
        sport: 'tennis',
        league_slug: 'wta',
        league_name: 'WTA Tour',
      },
      {
        id: 'baseball-1',
        title: 'Rays at Yankees',
        location: 'Yankee Stadium',
        latitude: 40.8296,
        longitude: -73.9262,
        date: new Date().toISOString(),
        sport: 'baseball',
        league_slug: 'mlb',
        league_name: 'MLB',
      },
    ];
    const { findAllByTestId, getByPlaceholderText } = render(
      <EventMap {...baseProps({ events })} />
    );

    expect(await findAllByTestId('Marker')).toHaveLength(2);

    fireEvent.changeText(getByPlaceholderText('Search games or events...'), 'USTA');
    expect(await findAllByTestId('Marker')).toHaveLength(1);

    fireEvent.changeText(getByPlaceholderText('Search games or events...'), 'mlb');
    expect(await findAllByTestId('Marker')).toHaveLength(1);
  });

  it('collapses every non-game pin to the single sport/team color, ignoring brand and sport colors', () => {
    // Owner rule (2026-09): the legend has exactly three categories, so a pin's
    // color comes only from its category. Custom marker/pro-team brand colors and
    // per-sport colors no longer change a pin's color — that mismatch was the bug.
    expect(resolveMarkerColor({ type: 'event' })).toBe(SPORT_TEAM_MARKER_COLOR);
    expect(resolveMarkerColor({ type: 'post' })).toBe(SPORT_TEAM_MARKER_COLOR);
    expect(
      resolveMarkerColor({ type: 'event', marker_color: '#111111', sport: 'mma' } as any)
    ).toBe(SPORT_TEAM_MARKER_COLOR);
    expect(resolveMarkerColor({ type: 'event', pro_home_color: '#222222' } as any)).toBe(
      SPORT_TEAM_MARKER_COLOR
    );
  });
});

it('records map lifecycle and bounded data counts without search text or coordinates', async () => {
  const { captureBreadcrumb } = require('@/utils/sentry');
  captureBreadcrumb.mockClear();
  const view = render(<EventMap {...baseProps()} />);
  await view.findByTestId('MapView');
  fireEvent(view.getByTestId('MapView'), 'mapReady');
  fireEvent.changeText(view.getByPlaceholderText('Search games or events...'), 'private search');
  view.unmount();
  const calls = captureBreadcrumb.mock.calls;
  expect(calls).toEqual(
    expect.arrayContaining([
      [
        'Map mounted',
        'map.lifecycle',
        expect.objectContaining({ map_instance: expect.any(String) }),
      ],
      ['Native map ready', 'map.lifecycle', expect.any(Object)],
      [
        'Map marker data updated',
        'map.data',
        expect.objectContaining({ input_count: 1, valid_count: 0, has_query: true }),
      ],
      ['Map unmounted', 'map.lifecycle', expect.any(Object)],
    ])
  );
  const dataCalls = calls.filter((call: any[]) => ['map.lifecycle', 'map.data'].includes(call[1]));
  expect(JSON.stringify(dataCalls)).not.toContain('private search');
  expect(JSON.stringify(dataCalls)).not.toContain('37.7749');
});
