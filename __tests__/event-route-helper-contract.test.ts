import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildEventDetailHref, EVENT_DETAIL_PATHNAME } from '@/utils/eventRoutes';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const routeHelper = read('utils/eventRoutes.ts');
const highlights = read('app/highlights.tsx');
const gameMap = read('app/game-map.tsx');
const rsvpHistory = read('app/rsvp-history.tsx');
const discover = read('app/(tabs)/discover/mobile-community.tsx');
const notifications = read('components/NotificationTapHandler.tsx');
const notificationPresentation = read('utils/notificationPresentation.ts');
const editEvent = read('app/(tabs)/edit-event.tsx');
const eventDetail = read('app/(tabs)/event-detail.tsx');
const debugScreen = read('app/debug.tsx');

describe('event route helper contract', () => {
  it('builds the canonical event detail href from one shared pathname constant', () => {
    expect(routeHelper).toContain("export const EVENT_DETAIL_PATHNAME = '/event-detail' as const;");
    expect(buildEventDetailHref(' event_123 ')).toBe('/game/event_123?eventId=event_123');
    expect(EVENT_DETAIL_PATHNAME).toBe('/event-detail');
  });

  it('keeps event entry points on the shared helper instead of duplicating inline event-detail routes', () => {
    for (const source of [highlights, gameMap, rsvpHistory, discover, notifications, debugScreen]) {
      expect(source).toContain('buildEventDetailRoute');
    }

    for (const source of [editEvent, notificationPresentation]) {
      expect(source).toContain('buildEventDetailHref');
    }
    // event-detail.tsx (deep-link / notification landing) now forwards through
    // the shared helper too, so every entry point lands on the canonical rich
    // page — no inline /public-event route (2026-07-14, owner: one event page).
    expect(eventDetail).toContain('buildEventDetailRoute');
    expect(eventDetail).not.toContain("pathname: '/public-event'");

    expect(highlights).not.toContain("pathname: '/event-detail'");
    expect(gameMap).not.toContain('/event-detail?id=');
    expect(rsvpHistory).not.toContain('/event-detail?id=');
    expect(discover).not.toContain("pathname: '/event-detail'");
    expect(notifications).not.toContain("pathname: '/event-detail'");
  });

  it('keeps search-driven event lists tappable while the keyboard is open', () => {
    expect(rsvpHistory).toContain('keyboardShouldPersistTaps="handled"');
    expect(rsvpHistory).toContain('keyboardDismissMode="interactive"');
  });
});
