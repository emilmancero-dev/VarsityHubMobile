import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';
import { AppState } from 'react-native';
let mockFocused = true;
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => mockFocused }));
const mockPlayers: any[] = [];
jest.mock('expo-video', () => ({
  createVideoPlayer: (source: any) => {
    const listeners: Record<string, Set<any>> = {};
    const player = {
      source,
      status: 'loading',
      volume: 0,
      muted: true,
      play: jest.fn(),
      pause: jest.fn(),
      replay: jest.fn(),
      release: jest.fn(),
      replaceAsync: jest.fn().mockResolvedValue(undefined),
      addListener: (name: string, callback: any) => {
        (listeners[name] ||= new Set()).add(callback);
        return { remove: () => listeners[name].delete(callback) };
      },
      emit: (name: string, event: any) => {
        listeners[name]?.forEach(callback => callback(event));
        if (event.status) player.status = event.status;
      },
    };
    mockPlayers.push(player);
    return player;
  },
  VideoView: () => null,
}));
jest.mock('expo-modules-core', () => ({
  useReleasingSharedObject: (factory: () => any, dependencies: any[]) => {
    const React = require('react');
    const ref = React.useRef(null);
    const player = React.useMemo(() => {
      ref.current?.release();
      ref.current = factory();
      return ref.current;
    }, dependencies);
    React.useEffect(() => () => ref.current?.release(), []);
    return player;
  },
}));
jest.mock('expo', () => ({ useEventListener: jest.fn() }));
jest.mock('@/utils/audioSession', () => ({ ensurePlaybackAudioSession: jest.fn() }));
jest.mock('expo-image', () => require('@/test-utils/screenMocks').expoImageMock());
import { VideoPlayer } from '../VideoPlayer';
const uri = 'https://example.com/clip.mp4';
const player = () => mockPlayers[mockPlayers.length - 1];
let appChange: (state: string) => void;
beforeEach(() => {
  jest.useFakeTimers();
  mockPlayers.length = 0;
  mockFocused = true;
  Object.defineProperty(AppState, 'currentState', { configurable: true, value: 'active' });
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_, callback: any) => {
    appChange = callback;
    return { remove: jest.fn() };
  });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});
it('autoplays with sound only on opted-in surfaces', () => {
  const view = render(<VideoPlayer uri={uri} autoPlay={false} />);
  expect(player().play).not.toHaveBeenCalled();
  view.rerender(<VideoPlayer uri={uri} autoPlay />);
  expect(player().play).toHaveBeenCalled();
  expect(player().muted).toBe(false);
  expect(player().volume).toBe(1);
});
it('resumes without replaying or recreating on pause or focus changes', () => {
  const view = render(<VideoPlayer uri={uri} autoPlay />);
  view.rerender(<VideoPlayer uri={uri} autoPlay paused />);
  player().play.mockClear();
  mockFocused = false;
  view.rerender(<VideoPlayer uri={uri} autoPlay />);
  expect(player().play).not.toHaveBeenCalled();
  mockFocused = true;
  view.rerender(<VideoPlayer uri={uri} autoPlay />);
  expect(player().play).toHaveBeenCalled();
  expect(player().replay).not.toHaveBeenCalled();
  expect(mockPlayers).toHaveLength(1);
});
it('pauses in background and respects active-item intent when returning', () => {
  const view = render(<VideoPlayer uri={uri} autoPlay />);
  act(() => appChange('background'));
  expect(player().pause).toHaveBeenCalled();
  player().play.mockClear();
  view.rerender(<VideoPlayer uri={uri} autoPlay paused />);
  act(() => appChange('active'));
  expect(player().play).not.toHaveBeenCalled();
});
it('retry reloads the actual native source, without creating concurrent attempts', async () => {
  const view = render(<VideoPlayer uri={uri} autoPlay />);
  act(() => player().emit('statusChange', { status: 'error', error: new Error('broken') }));
  await act(async () => fireEvent.press(view.getByLabelText('Retry video playback')));
  expect(player().replaceAsync).toHaveBeenCalledWith({ uri });
  expect(mockPlayers).toHaveLength(1);
  act(() => player().emit('statusChange', { status: 'readyToPlay' }));
  expect(view.queryByLabelText('Retry video playback')).toBeNull();
});
it('turns endless loading into a retryable failure', () => {
  const view = render(<VideoPlayer uri={uri} autoPlay />);
  act(() => jest.advanceTimersByTime(30_000));
  expect(view.getByLabelText('Retry video playback')).toBeTruthy();
});
it('source changes ignore completion of the previous retry', async () => {
  const view = render(<VideoPlayer uri={uri} autoPlay />);
  const oldPlayer = player();
  let finish!: () => void;
  oldPlayer.replaceAsync.mockImplementation(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      })
  );
  act(() => oldPlayer.emit('statusChange', { status: 'error' }));
  fireEvent.press(view.getByLabelText('Retry video playback'));
  view.rerender(<VideoPlayer uri="https://example.com/new.mp4" autoPlay />);
  await act(async () => {
    finish();
  });
  expect(player()).not.toBe(oldPlayer);
  expect(view.queryByLabelText('Retry video playback')).toBeNull();
});
it('surfaces failed native replacement and permits another retry', async () => {
  const view = render(<VideoPlayer uri={uri} autoPlay />);
  player().replaceAsync.mockRejectedValueOnce(new Error('network unavailable'));
  act(() => player().emit('statusChange', { status: 'error' }));
  await act(async () => fireEvent.press(view.getByLabelText('Retry video playback')));
  expect(view.getByLabelText('Retry video playback')).toBeTruthy();
  await act(async () => fireEvent.press(view.getByLabelText('Retry video playback')));
  expect(player().replaceAsync).toHaveBeenCalledTimes(2);
});
it('does not autoplay an inactive item when it becomes ready', () => {
  render(<VideoPlayer uri={uri} autoPlay paused />);
  act(() => player().emit('statusChange', { status: 'readyToPlay' }));
  expect(player().play).not.toHaveBeenCalled();
});
it('recreates a player when native replacement hangs and ignores its late completion', async () => {
  const view = render(<VideoPlayer uri={uri} autoPlay />);
  const hung = player();
  let finish!: () => void;
  hung.replaceAsync.mockImplementation(
    () =>
      new Promise<void>(resolve => {
        finish = resolve;
      })
  );
  act(() => hung.emit('statusChange', { status: 'error' }));
  fireEvent.press(view.getByLabelText('Retry video playback'));
  act(() => jest.advanceTimersByTime(30_000));
  fireEvent.press(view.getByLabelText('Retry video playback'));
  expect(player()).not.toBe(hung);
  expect(hung.release).toHaveBeenCalledTimes(1);
  const recovered = player();
  await act(async () => {
    finish();
    hung.emit('statusChange', { status: 'error' });
  });
  act(() => recovered.emit('statusChange', { status: 'readyToPlay' }));
  expect(view.queryByLabelText('Retry video playback')).toBeNull();
});
