import { useEffect, useRef } from 'react';
import type { Socket } from 'socket.io-client';
import { getSocket } from './useConversationSocket';

/**
 * Real-time event-page updates (PDF commandments: `new_post`/`post_reacted`/
 * `post_deleted`/`event_status_changed` on a per-event/game room). Shares the
 * single socket.io-client connection `useConversationSocket` already opens —
 * joining/leaving rooms is additive, never a second connection.
 *
 * Purely additive: if the socket can't connect or a room join is denied
 * (private team, event not found), the screen's existing poll/refresh path
 * still delivers updates — this hook is a push OPTIMIZATION, not a source
 * of truth.
 */
export interface EventRealtimeHandlers {
  onNewPost?: (post: any) => void;
  onPostReacted?: (payload: { post_id: string; reaction_count: number }) => void;
  onPostDeleted?: (payload: { post_id: string }) => void;
  onEventStatusChanged?: (payload: { status: string }) => void;
}

export function useEventRealtime(
  ids: { gameId?: string | null; eventId?: string | null },
  handlers: EventRealtimeHandlers
): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const gameId = ids.gameId || null;
  const eventId = ids.eventId && ids.eventId !== gameId ? ids.eventId : null;

  useEffect(() => {
    if (!gameId && !eventId) return;
    let active = true;
    let sock: Socket | null = null;

    const rooms: { kind: 'game' | 'event'; id: string }[] = [];
    if (gameId) rooms.push({ kind: 'game', id: gameId });
    if (eventId) rooms.push({ kind: 'event', id: eventId });

    const onNewPost = (post: any) => {
      if (!active) return;
      if (post?.game_id === gameId || post?.event_id === eventId) {
        handlersRef.current.onNewPost?.(post);
      }
    };
    const onPostReacted = (payload: { post_id: string; reaction_count: number }) => {
      if (active) handlersRef.current.onPostReacted?.(payload);
    };
    const onPostDeleted = (payload: { post_id: string }) => {
      if (active) handlersRef.current.onPostDeleted?.(payload);
    };
    const onEventStatusChanged = (payload: { status: string }) => {
      if (active) handlersRef.current.onEventStatusChanged?.(payload);
    };
    const onConnect = () => {
      rooms.forEach(r => sock?.emit('event:join', r));
    };

    getSocket()
      .then(s => {
        if (!active) return;
        sock = s;
        s.on('new_post', onNewPost);
        s.on('post_reacted', onPostReacted);
        s.on('post_deleted', onPostDeleted);
        s.on('event_status_changed', onEventStatusChanged);
        s.on('connect', onConnect);
        rooms.forEach(r => s.emit('event:join', r));
      })
      .catch(() => {
        /* socket is optional; the screen's own fetch/refresh covers delivery */
      });

    return () => {
      active = false;
      if (sock) {
        rooms.forEach(r => sock?.emit('event:leave', r));
        sock.off('new_post', onNewPost);
        sock.off('post_reacted', onPostReacted);
        sock.off('post_deleted', onPostDeleted);
        sock.off('event_status_changed', onEventStatusChanged);
        sock.off('connect', onConnect);
      }
    };
  }, [gameId, eventId]);
}
