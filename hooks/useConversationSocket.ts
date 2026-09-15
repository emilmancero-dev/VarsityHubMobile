import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { getApiBaseUrl, getAccessTokenForRequest } from '@/api/http';

/**
 * Realtime conversation updates (pilot). Subscribes to a conversation room and
 * invokes `onMessage` when the server pushes a new message, replacing per-thread
 * polling latency. Purely additive: if the socket can't connect, the screen's
 * existing polling fallback still delivers messages.
 *
 * socket.io-client is pure JS (no native module), so this ships safely via
 * `eas update` without a new App Store binary.
 */

// One shared socket across all hook instances — joins/leaves rooms per screen.
let socket: Socket | null = null;
let connectPromise: Promise<Socket> | null = null;

export async function getSocket(): Promise<Socket> {
  if (socket?.connected) return socket;
  if (connectPromise) return connectPromise;
  connectPromise = (async () => {
    const token = await getAccessTokenForRequest();
    const s = io(getApiBaseUrl(), {
      path: '/realtime',
      transports: ['websocket'],
      auth: { token },
      reconnection: true,
    });
    socket = s;
    return s;
  })();
  try {
    return await connectPromise;
  } finally {
    connectPromise = null;
  }
}

export function useConversationSocket(
  conversationId: string | null | undefined,
  onMessage: (message: any) => void
): boolean {
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;
  // Connection state lets the screen's polling fallback back off while
  // realtime delivery is healthy.
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let active = true;
    let sock: Socket | null = null;

    if (conversationId) {
      const onNew = (msg: any) => {
        // The shared socket may be in several rooms; only forward this thread's.
        if (active && msg?.conversation_id === conversationId) handlerRef.current(msg);
      };
      const onConnect = () => {
        sock?.emit('conversation:join', conversationId);
        if (active) setConnected(true);
      };
      const onDisconnect = () => {
        if (active) setConnected(false);
      };

      getSocket()
        .then(s => {
          if (!active) return;
          sock = s;
          s.on('message:new', onNew);
          s.on('connect', onConnect);
          s.on('disconnect', onDisconnect);
          s.emit('conversation:join', conversationId);
          setConnected(s.connected);
        })
        .catch(() => {
          /* socket is optional; polling fallback covers delivery */
        });

      return () => {
        active = false;
        if (sock) {
          sock.emit('conversation:leave', conversationId);
          sock.off('message:new', onNew);
          sock.off('connect', onConnect);
          sock.off('disconnect', onDisconnect);
        }
      };
    }

    setConnected(false);
    return () => {
      active = false;
    };
  }, [conversationId]);

  return connected;
}
