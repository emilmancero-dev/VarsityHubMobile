import { renderHook, act, waitFor } from '@testing-library/react-native';

type Handler = (...args: any[]) => void;

function makeFakeSocket() {
  const handlers: Record<string, Handler[]> = {};
  return {
    connected: false,
    on: jest.fn((event: string, fn: Handler) => {
      (handlers[event] ||= []).push(fn);
    }),
    off: jest.fn((event: string, fn: Handler) => {
      handlers[event] = (handlers[event] || []).filter(h => h !== fn);
    }),
    emit: jest.fn(),
    fire(event: string, ...args: any[]) {
      (handlers[event] || []).forEach(h => h(...args));
    },
  };
}

const fakeSocket = makeFakeSocket();

jest.mock('socket.io-client', () => ({
  io: jest.fn(() => fakeSocket),
}));

jest.mock('@/api/http', () => ({
  getApiBaseUrl: () => 'http://localhost:4000',
  getAccessTokenForRequest: async () => 'test-token',
}));

import { useEventRealtime } from '@/hooks/useEventRealtime';

describe('useEventRealtime', () => {
  beforeEach(() => {
    fakeSocket.emit.mockClear();
    fakeSocket.on.mockClear();
    fakeSocket.off.mockClear();
  });

  it('joins the game room and forwards new_post for that game', async () => {
    const onNewPost = jest.fn();
    renderHook(() => useEventRealtime({ gameId: 'game-1', eventId: null }, { onNewPost }));

    await waitFor(() => {
      expect(fakeSocket.emit).toHaveBeenCalledWith('event:join', { kind: 'game', id: 'game-1' });
    });

    act(() => {
      fakeSocket.fire('new_post', { id: 'p1', game_id: 'game-1' });
    });
    expect(onNewPost).toHaveBeenCalledWith({ id: 'p1', game_id: 'game-1' });

    // A post for a different game must not be forwarded.
    onNewPost.mockClear();
    act(() => {
      fakeSocket.fire('new_post', { id: 'p2', game_id: 'other-game' });
    });
    expect(onNewPost).not.toHaveBeenCalled();
  });

  it('forwards post_reacted, post_deleted, and event_status_changed', async () => {
    const onPostReacted = jest.fn();
    const onPostDeleted = jest.fn();
    const onEventStatusChanged = jest.fn();
    renderHook(() =>
      useEventRealtime(
        { gameId: null, eventId: 'event-1' },
        { onPostReacted, onPostDeleted, onEventStatusChanged }
      )
    );

    await waitFor(() => {
      expect(fakeSocket.emit).toHaveBeenCalledWith('event:join', { kind: 'event', id: 'event-1' });
    });

    act(() => {
      fakeSocket.fire('post_reacted', { post_id: 'p1', reaction_count: 3 });
      fakeSocket.fire('post_deleted', { post_id: 'p1' });
      fakeSocket.fire('event_status_changed', { status: 'in_progress' });
    });

    expect(onPostReacted).toHaveBeenCalledWith({ post_id: 'p1', reaction_count: 3 });
    expect(onPostDeleted).toHaveBeenCalledWith({ post_id: 'p1' });
    expect(onEventStatusChanged).toHaveBeenCalledWith({ status: 'in_progress' });
  });

  it('does nothing when neither gameId nor eventId is provided', () => {
    renderHook(() => useEventRealtime({ gameId: null, eventId: null }, {}));
    expect(fakeSocket.emit).not.toHaveBeenCalled();
  });

  it('leaves the room on unmount', async () => {
    const { unmount } = renderHook(() => useEventRealtime({ gameId: 'game-2', eventId: null }, {}));

    await waitFor(() => {
      expect(fakeSocket.emit).toHaveBeenCalledWith('event:join', { kind: 'game', id: 'game-2' });
    });

    unmount();
    expect(fakeSocket.emit).toHaveBeenCalledWith('event:leave', { kind: 'game', id: 'game-2' });
  });
});
