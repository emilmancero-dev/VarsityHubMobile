import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  getPostPostingWindowState,
  isWithinGeofence,
  DEFAULT_LIVE_WINDOW_HOURS_AFTER_START,
} from '../lib/geofencing.js';
import { resolveFixture, type ProTeamVenue } from '../lib/proSchedule/resolveFixture.js';
import type { ProFixture } from '../lib/proSchedule/types.js';

/**
 * Pro events are ordinary Event rows and must go through the existing posting
 * gate with no special-casing. If someone adds a field to the gate that pro
 * ingestion does not populate, pro event pages silently stop accepting posts —
 * these tests fail instead.
 */

const lakers: ProTeamVenue = {
  id: 'pt_lakers',
  external_ref: 'nba:los-angeles-lakers',
  name: 'Los Angeles Lakers',
  short_name: 'Lakers',
  venue_name: 'Crypto.com Arena',
  venue_address: '1111 S Figueroa St, Los Angeles, CA 90015',
  venue_lat: 34.043,
  venue_lng: -118.2673,
  timezone: 'America/Los_Angeles',
};

const teams = new Map([[lakers.external_ref, lakers]]);

const tipoff = new Date('2026-11-12T03:30:00.000Z');

const fixture: ProFixture = {
  external_ref: 'nba:0022600123',
  league: 'nba',
  starts_at: tipoff,
  home_team_ref: lakers.external_ref,
  away_team_ref: null,
  title: 'Celtics at Lakers',
  status: 'scheduled',
};

function resolved() {
  const r = resolveFixture(fixture, teams);
  if (!r.ok) throw new Error(`fixture did not resolve: ${r.error.code}`);
  return r.value;
}

describe('pro event / geofence parity', () => {
  it('populates every field the posting gate selects', () => {
    // The gate's select list, read from source so this test tracks it rather
    // than restating a stale copy.
    const source = readFileSync(path.join(process.cwd(), 'src/lib/geofencing.ts'), 'utf8');
    const block = source.split('const postingEventSelect = {')[1]?.split('} as const;')[0];
    expect(block).toBeTruthy();

    const selectedFields = [...(block ?? '').matchAll(/^\s*(\w+):\s*true,/gm)].map(m => m[1]);
    expect(selectedFields.length).toBeGreaterThan(0);

    const v = resolved();
    // Fields the gate reads that ingestion is responsible for supplying.
    // id is assigned by the DB; game_id and exclusive_poster_id are legitimately
    // null on a pro event (no linked Game, no exclusive poster).
    const ingestionOwned = selectedFields.filter(
      f => !['id', 'game_id', 'exclusive_poster_id'].includes(f)
    );

    for (const field of ingestionOwned) {
      expect(v).toHaveProperty(field);
      expect(v[field as keyof typeof v]).not.toBeUndefined();
    }
  });

  it('supplies coordinates the geofence can actually evaluate', () => {
    const v = resolved();
    expect(v.latitude).not.toBeNull();
    expect(v.longitude).not.toBeNull();

    // Inside the arena passes; 50km away does not.
    expect(isWithinGeofence(34.0431, -118.2674, v.latitude!, v.longitude!)).toBe(true);
    expect(isWithinGeofence(34.5, -118.9, v.latitude!, v.longitude!)).toBe(false);
  });

  it('opens the live window on game day (12h before tip) and closes it on the league bound', () => {
    const v = resolved();

    const beforeOpen = new Date(tipoff.getTime() - 13 * 60 * 60 * 1000);
    const justOpen = new Date(tipoff.getTime() - 30 * 60 * 1000);
    const during = new Date(tipoff.getTime() + 60 * 60 * 1000);
    const afterClose = new Date(
      tipoff.getTime() + (v.live_window_hours_after_start + 1) * 3600_000
    );

    expect(getPostPostingWindowState(v.date, beforeOpen, v.live_window_hours_after_start)).toBe(
      'before_open'
    );
    expect(getPostPostingWindowState(v.date, justOpen, v.live_window_hours_after_start)).toBe(
      'live'
    );
    expect(getPostPostingWindowState(v.date, during, v.live_window_hours_after_start)).toBe('live');
    // Past the live cutoff it becomes 'grace' — open only to users who already
    // earned an unlock, which is the same rule school events follow.
    expect(getPostPostingWindowState(v.date, afterClose, v.live_window_hours_after_start)).toBe(
      'grace'
    );
  });

  it('uses the platform default window for basketball, not a bespoke pro rule', () => {
    expect(resolved().live_window_hours_after_start).toBe(DEFAULT_LIVE_WINDOW_HOURS_AFTER_START);
  });
});
