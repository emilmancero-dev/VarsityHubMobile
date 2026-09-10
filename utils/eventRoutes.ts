import type { Href } from 'expo-router';

// Kept only as the legacy deep-link/notification landing (varsityhub://event/:id
// maps here); the screen itself is a pure redirector — see app/(tabs)/event-detail.tsx.
export const EVENT_DETAIL_PATHNAME = '/event-detail' as const;

// The real event experience: the guest-browseable page fans upload posts to.
export const PUBLIC_EVENT_PATHNAME = '/public-event' as const;

function normalizeEventId(eventId: string | number): string {
  return String(eventId).trim();
}

export function buildEventDetailRoute(
  eventId: string | number,
  gameId?: string | number | null
): Href {
  // ONE canonical rich detail screen for both games and events. The rich
  // GameDetailsScreen (/game/[id]) already renders event-only entities via
  // loadVirtualFromEvent, so a standalone event no longer falls through to the
  // stripped-down public-event page (owner: "this is not an event page",
  // 2026-07-14). Game-linked events pass the gameId; standalone events pass
  // their id in BOTH slots so GameDetailsScreen.load() dispatches to the event
  // loader (it takes the event path when id === eventId). public-event.tsx
  // remains ONLY as the web share/OG landing for shared event URLs.
  const normalizedGameId = gameId != null ? String(gameId).trim() : '';
  if (normalizedGameId) {
    return {
      pathname: '/game/[id]',
      params: { id: normalizedGameId },
    } as Href;
  }
  const normalizedEventId = normalizeEventId(eventId);
  return {
    pathname: '/game/[id]',
    params: { id: normalizedEventId, eventId: normalizedEventId },
  } as Href;
}

export function buildEventDetailHref(eventId: string | number): string {
  const id = encodeURIComponent(normalizeEventId(eventId));
  return `/game/${id}?eventId=${id}`;
}
