/**
 * Realtime layer (websockets) — pilot channel: direct-message conversations.
 *
 * Replaces the message-thread `setInterval` polling with server-pushed updates,
 * cutting both latency and the per-client request load that polling multiplies
 * in a packed stadium. Polling is retained client-side as a fallback, so this is
 * additive: if the socket can't connect, messaging still works.
 *
 * Auth mirrors the HTTP auth middleware (verify JWT -> load user -> reject
 * banned/deleted/stale-session). Room access is authorized per conversation:
 * a socket may only join a conversation it participates in.
 *
 * A Redis adapter is wired in when REDIS_URL is set so rooms fan out correctly
 * across multiple Railway replicas (see the multi-replica step). Without Redis
 * it runs single-node.
 */
import type { Server as HttpServer } from 'node:http';
import { Server as IOServer, type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { verifyJwt } from '../lib/jwt.js';
import { prisma } from '../lib/prisma.js';
import { captureException } from '../lib/sentry.js';

let io: IOServer | null = null;

interface SocketUser {
  id: string;
}

/** Verify a handshake token the same way the HTTP auth middleware does. */
async function authenticateSocket(token: string | undefined): Promise<SocketUser | null> {
  if (!token) return null;
  const payload = verifyJwt<{ id: string; iat?: number; se?: number }>(token);
  if (!payload?.id) return null;

  let user;
  try {
    user = await prisma.user.findUnique({
      where: { id: payload.id },
      select: {
        session_epoch: true,
        password_changed_at: true,
        banned: true,
        banned_until: true,
        deleted_at: true,
        deletion_anonymized: true,
      },
    });
  } catch {
    return null;
  }

  if (!user || (user as any).deleted_at || (user as any).deletion_anonymized) return null;
  if (user.banned) return null;
  if (user.banned_until && new Date(user.banned_until) > new Date()) return null;
  if (
    payload.iat &&
    user.password_changed_at &&
    payload.iat < Math.floor(user.password_changed_at.getTime() / 1000)
  ) {
    return null;
  }
  if (typeof payload.se === 'number' && payload.se !== (user as any).session_epoch) return null;

  return { id: payload.id };
}

/** A user may join a conversation room only if they participate in it. */
async function userCanAccessConversation(userId: string, conversationId: string): Promise<boolean> {
  // dm:<a>__<b> — fast path, no DB round-trip.
  const dm = conversationId.match(/^dm:(.+)__(.+)$/);
  if (dm && (dm[1] === userId || dm[2] === userId)) return true;
  // Otherwise require an existing message in the conversation involving the user.
  const msg = await prisma.message.findFirst({
    where: {
      conversation_id: conversationId,
      OR: [{ sender_id: userId }, { recipient_id: userId }],
    },
    select: { id: true },
  });
  return !!msg;
}

function room(conversationId: string): string {
  return `conversation:${conversationId}`;
}

type EventRoomKind = 'game' | 'event';

function eventRoom(kind: EventRoomKind, id: string): string {
  return `${kind}:${id}`;
}

/**
 * A socket may join a game/event room unless the underlying game(s) belong
 * to a private team the viewer can't see (mirrors the public-surface privacy
 * rule other read endpoints already enforce via isTeamHiddenFromViewer).
 * Standalone events/pro-sports fixtures with no linked team are always
 * joinable — there is nothing to hide.
 */
async function userCanAccessEventRoom(
  userId: string,
  kind: EventRoomKind,
  id: string
): Promise<boolean> {
  const { isTeamHiddenFromViewer } = await import('../lib/privacyUtils.js');
  const teamIds: string[] = [];
  if (kind === 'game') {
    const game = await prisma.game.findUnique({
      where: { id },
      select: { home_team_id: true, away_team_id: true },
    });
    if (!game) return false;
    if (game.home_team_id) teamIds.push(game.home_team_id);
    if (game.away_team_id) teamIds.push(game.away_team_id);
  } else {
    const event = await prisma.event.findUnique({
      where: { id },
      select: {
        team_id: true,
        game: { select: { home_team_id: true, away_team_id: true } },
      },
    });
    if (!event) return false;
    if (event.team_id) teamIds.push(event.team_id);
    if (event.game?.home_team_id) teamIds.push(event.game.home_team_id);
    if (event.game?.away_team_id) teamIds.push(event.game.away_team_id);
  }
  if (teamIds.length === 0) return true;
  const hiddenFlags = await Promise.all(
    teamIds.map(teamId => isTeamHiddenFromViewer(teamId, userId))
  );
  // Visible if at least one linked team is visible to this viewer.
  return hiddenFlags.some(hidden => !hidden);
}

// Best-effort in-process cache so `event_status_changed` only fires on an
// actual transition, not on every read. This is a push OPTIMIZATION, not a
// source of truth — a missed transition (e.g. a different Railway replica
// saw the prior read) is still caught by the client's polling fallback, so
// no cross-replica coordination (Redis) is needed for this cache.
const lastKnownEventStatus = new Map<string, string>();

/** Initialize socket.io on the shared HTTP server. Idempotent. */
export function initRealtime(httpServer: HttpServer): IOServer {
  if (io) return io;

  io = new IOServer(httpServer, {
    path: '/realtime',
    serveClient: false,
    // The React Native client connects directly (no browser Origin), so CORS
    // isn't applicable; lock it down rather than echoing arbitrary origins.
    cors: { origin: false },
    pingTimeout: 30_000,
  });

  // Cross-replica fanout via Redis pub/sub. Mirrors the dynamic-import pattern
  // used in lib/cache.ts. Optional: single-node if REDIS_URL is unset.
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    import('ioredis')
      .then(({ default: Redis }) => {
        const RedisCtor = Redis as unknown as new (url: string, opts?: any) => any;
        const pub = new RedisCtor(redisUrl, { maxRetriesPerRequest: null });
        const sub = pub.duplicate();
        io?.adapter(createAdapter(pub, sub));
        console.log('[realtime] socket.io Redis adapter enabled (multi-replica safe)');
      })
      .catch(err => {
        console.error('[realtime] failed to enable Redis adapter; running single-node', err);
      });
  } else {
    console.warn(
      '[realtime] REDIS_URL not set — socket.io running single-node (no cross-replica fanout)'
    );
  }

  // Authenticate on handshake; reject unauthenticated sockets outright.
  io.use(async (socket, next) => {
    try {
      const token = (socket.handshake.auth?.token as string | undefined) ?? undefined;
      const user = await authenticateSocket(token);
      if (!user) return next(new Error('unauthorized'));
      (socket.data as any).userId = user.id;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const userId = (socket.data as any).userId as string;

    socket.on('conversation:join', async (conversationId: unknown, ack?: (ok: boolean) => void) => {
      if (typeof conversationId !== 'string' || !conversationId) {
        ack?.(false);
        return;
      }
      try {
        const allowed = await userCanAccessConversation(userId, conversationId);
        if (!allowed) {
          ack?.(false);
          return;
        }
        await socket.join(room(conversationId));
        ack?.(true);
      } catch (e) {
        captureException(e instanceof Error ? e : new Error(String(e)), {
          context: 'realtime_join',
        });
        ack?.(false);
      }
    });

    socket.on('conversation:leave', (conversationId: unknown) => {
      if (typeof conversationId === 'string' && conversationId) {
        void socket.leave(room(conversationId));
      }
    });

    socket.on('event:join', async (payload: unknown, ack?: (ok: boolean) => void) => {
      const kind = (payload as any)?.kind;
      const id = (payload as any)?.id;
      if ((kind !== 'game' && kind !== 'event') || typeof id !== 'string' || !id) {
        ack?.(false);
        return;
      }
      try {
        const allowed = await userCanAccessEventRoom(userId, kind, id);
        if (!allowed) {
          ack?.(false);
          return;
        }
        await socket.join(eventRoom(kind, id));
        ack?.(true);
      } catch (e) {
        captureException(e instanceof Error ? e : new Error(String(e)), {
          context: 'realtime_event_join',
        });
        ack?.(false);
      }
    });

    socket.on('event:leave', (payload: unknown) => {
      const kind = (payload as any)?.kind;
      const id = (payload as any)?.id;
      if ((kind === 'game' || kind === 'event') && typeof id === 'string' && id) {
        void socket.leave(eventRoom(kind, id));
      }
    });
  });

  return io;
}

/** Push an event to everyone currently in a conversation room. No-op if realtime isn't initialized (e.g. tests). */
export function emitToConversation(conversationId: string, event: string, payload: unknown): void {
  if (!io) return;
  io.to(room(conversationId)).emit(event, payload);
}

/**
 * Push a real-time event-page update (new_post/post_reacted/post_deleted) to
 * everyone currently viewing that game or event room. No-op if realtime
 * isn't initialized (e.g. tests) — callers must treat this as fire-and-forget,
 * never a source of truth (the client's fetch/poll path remains authoritative).
 */
export function emitToEventRoom(
  kind: EventRoomKind,
  id: string,
  event: string,
  payload: unknown
): void {
  if (!io || !id) return;
  io.to(eventRoom(kind, id)).emit(event, payload);
}

/**
 * Emit `event_status_changed` only when the derived status actually flipped
 * since the last read this replica observed for this id. Called from the
 * existing single-game/single-event detail read paths (games.ts `/:id/summary`,
 * events.ts `/:id`) rather than a new polling loop.
 */
export function checkAndEmitEventStatusChange(
  kind: EventRoomKind,
  id: string | null | undefined,
  status: string | null | undefined
): void {
  if (!io || !id || !status) return;
  const key = eventRoom(kind, id);
  const previous = lastKnownEventStatus.get(key);
  if (previous === status) return;
  lastKnownEventStatus.set(key, status);
  // Don't fire on the very first observation of an id (no real "change" yet,
  // and it would fire once per id per replica restart for no reason).
  if (previous === undefined) return;
  io.to(key).emit('event_status_changed', { status });
}
