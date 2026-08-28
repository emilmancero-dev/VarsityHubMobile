/**
 * serializeLiveWindow — the server ships computed posting-window bounds so the
 * app stops re-deriving them (2026-07-16 Fanatics Fest).
 *
 * The app hardcoded the cutoff (2h in feed.tsx, 3h in create-post.tsx) and had
 * no way to learn about `live_window_hours_after_start`. Fanatics Fest Day 1
 * carries an 18h override, so the event read as "ended" in the app at 4:00 PM ET
 * and dropped out of the feed while this server kept accepting posts until
 * 7:00 AM ET.
 *
 * Numbers below are the real prod row for Day 1.
 */

import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { serializeLiveWindow } from '../lib/geofencing.js';

const FEST_DAY1_START = new Date('2026-07-16T17:00:00.000Z');

describe('serializeLiveWindow', () => {
  it('honors an 18h per-event override', () => {
    // live_from is start − 12h (game day, owner rule 2026-08-28); live_until is
    // the 18h after-start override.
    expect(serializeLiveWindow(FEST_DAY1_START, 18)).toEqual({
      starts_at: '2026-07-16T17:00:00.000Z',
      live_from: '2026-07-16T05:00:00.000Z',
      live_until: '2026-07-17T11:00:00.000Z',
    });
  });

  it('falls back to the 3h default when no override is set', () => {
    expect(serializeLiveWindow(FEST_DAY1_START, null).live_until).toBe('2026-07-16T20:00:00.000Z');
    expect(serializeLiveWindow(FEST_DAY1_START, undefined).live_until).toBe(
      '2026-07-16T20:00:00.000Z'
    );
    // 0 / negative are not a real window — treat as unset, not as "closes at start".
    expect(serializeLiveWindow(FEST_DAY1_START, 0).live_until).toBe('2026-07-16T20:00:00.000Z');
  });

  it('accepts an ISO string as well as a Date', () => {
    expect(serializeLiveWindow('2026-07-16T17:00:00.000Z', 18)).toEqual(
      serializeLiveWindow(FEST_DAY1_START, 18)
    );
  });

  it('returns nulls for a missing or unparseable date rather than throwing', () => {
    const empty = { starts_at: null, live_from: null, live_until: null };
    expect(serializeLiveWindow(null, 18)).toEqual(empty);
    expect(serializeLiveWindow(undefined, 18)).toEqual(empty);
    expect(serializeLiveWindow('not-a-date', 18)).toEqual(empty);
  });
});

describe('GET /games ships the bounds', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'routes', 'games.ts'), 'utf8');

  it('serializes the window from the EVENT, not the game row', () => {
    // The game row's own date can disagree with its event's (prod: fest Day 1
    // game says 03:39Z, its event says 17:00Z). The posting checks enforce
    // against the event, so the client must be told the same thing.
    expect(src).toMatch(/serializeLiveWindow\(\s*event\?\.date \?\? rest\.date,/);
    expect(src).toMatch(/event\?\.live_window_hours_after_start/);
  });

  it('spreads the window onto the payload', () => {
    expect(src).toMatch(/\.\.\.liveWindow,/);
  });
});
