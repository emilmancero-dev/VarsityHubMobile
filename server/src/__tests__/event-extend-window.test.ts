/**
 * Regression test: POST /events/:id/extend-window (VARSITYHUB COMMANDMENTS,
 * Workflow 2 — "Coach can extend window by 6 more hours (18 total) if
 * needed... costs nothing").
 *
 * This is a hard ceiling, not a per-call increment: the route must only
 * transition an event from exactly the 12h all-day window to 18h, and must
 * no-op (not error) once already at 18h, so repeated calls can never push an
 * event's live window past 18h total.
 */

import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  COACH_ALL_DAY_EXTENDED_LIVE_WINDOW_HOURS,
  COACH_ALL_DAY_LIVE_WINDOW_HOURS,
} from '../lib/geofencing.js';

const eventsSrc = readFileSync(join(process.cwd(), 'src', 'routes', 'events.ts'), 'utf8');

describe('extend-window ceiling constants', () => {
  it('the extended ceiling is exactly 6h above the all-day window', () => {
    expect(COACH_ALL_DAY_EXTENDED_LIVE_WINDOW_HOURS - COACH_ALL_DAY_LIVE_WINDOW_HOURS).toBe(6);
    expect(COACH_ALL_DAY_EXTENDED_LIVE_WINDOW_HOURS).toBe(18);
  });
});

describe('POST /events/:id/extend-window route', () => {
  it('is registered and gated behind auth/verified/onboarded', () => {
    expect(eventsSrc).toMatch(
      /eventsRouter\.post\(\s*'\/:id\/extend-window',\s*requireAuth as any,\s*requireVerified as any,\s*requireOnboarded as any,/
    );
  });

  it('reuses the shared coach/creator/admin authorization helper, not an ad-hoc check', () => {
    const routeBody = eventsSrc.split("'/:id/extend-window'")[1]?.slice(0, 1200) ?? '';
    expect(routeBody).toMatch(/loadEditableEventForAction/);
  });

  it('no-ops (does not throw/reject) once already at the extended ceiling', () => {
    const routeBody = eventsSrc.split("'/:id/extend-window'")[1]?.slice(0, 1500) ?? '';
    expect(routeBody).toMatch(/currentHours >= COACH_ALL_DAY_EXTENDED_LIVE_WINDOW_HOURS/);
    expect(routeBody).toMatch(/extended:\s*false/);
  });

  it('rejects extending an event that is not currently the 12h all-day window', () => {
    const routeBody = eventsSrc.split("'/:id/extend-window'")[1]?.slice(0, 1500) ?? '';
    expect(routeBody).toMatch(/currentHours !== COACH_ALL_DAY_LIVE_WINDOW_HOURS/);
    expect(routeBody).toMatch(/sendError\(\s*res,\s*400,/);
  });

  it('persists the extension as a real DB write, not a client-only flag', () => {
    const routeBody = eventsSrc.split("'/:id/extend-window'")[1]?.slice(0, 1800) ?? '';
    expect(routeBody).toMatch(
      /prisma\.event\.update\(\s*\{\s*where:\s*\{\s*id:\s*eventId\s*\},\s*data:\s*\{\s*live_window_hours_after_start:\s*COACH_ALL_DAY_EXTENDED_LIVE_WINDOW_HOURS/
    );
  });
});

describe('is_all_day / window_extended serialization stays truthful after extension', () => {
  it('is_all_day uses >= so an 18h window still reads as all-day, not reset to false', () => {
    expect(eventsSrc).toMatch(
      /is_all_day:\s*\(event\.live_window_hours_after_start \?\? 0\) >= COACH_ALL_DAY_LIVE_WINDOW_HOURS/
    );
  });

  it('window_extended flags exactly the 18h ceiling', () => {
    expect(eventsSrc).toMatch(
      /window_extended:\s*\n?\s*\(event\.live_window_hours_after_start \?\? 0\) >= COACH_ALL_DAY_EXTENDED_LIVE_WINDOW_HOURS/
    );
  });
});
