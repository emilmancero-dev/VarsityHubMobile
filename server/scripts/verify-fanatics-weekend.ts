/**
 * READ-ONLY end-of-weekend readiness check for the four Fanatics Fest NYC 2026
 * day events. One report that confirms everything the fest depends on, so we
 * can say the remaining days will run smoothly:
 *
 *   1. All four events + linked games exist, approved, and event-visible.
 *   2. Event date is the real start (per-day expected UTC), not a nudged value.
 *   3. live_window_hours_after_start == 18 (the geofenced post/story window).
 *   4. Venue coordinates present on event AND game (geofencing needs them).
 *   5. Linked game is teamless + approved + opponent_approval not blocking
 *      (feed-eligible) and its date is not nudged away from the event start.
 *   6. Computed posting-window state right now, and the full open/close timeline
 *      for each day (posts: open..+18h live then +7d grace; stories: open..+18h).
 *      There is no early cutoff — posting is open any time up to the live close.
 *
 * No writes. Mirrors server/src/lib/geofencing.ts window math exactly.
 * Run via CI with PRODUCTION_DATABASE_URL.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const DEFAULT_HOURS = 3;
const GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const JAVITS = { lat: 40.75687, lng: -74.001762 };

// (event id, expected real start UTC, human day)
const FEST_DAYS = [
  {
    id: 'cmrblzxwi0001x1lasw8q7cc0',
    start: '2026-07-16T17:00:00.000Z',
    label: 'Day 1 (Thu Jul 16, 1:00 PM EDT)',
  },
  {
    id: 'cmrblzxxn0003x1lanq5vn4bs',
    start: '2026-07-17T14:00:00.000Z',
    label: 'Day 2 (Fri Jul 17, 10:00 AM EDT)',
  },
  {
    id: 'cmrblzxyc0005x1la8stvo3e0',
    start: '2026-07-18T14:00:00.000Z',
    label: 'Day 3 (Sat Jul 18, 10:00 AM EDT)',
  },
  {
    id: 'cmrblzy070007x1lajr3u9bmi',
    start: '2026-07-19T14:00:00.000Z',
    label: 'Day 4 (Sun Jul 19, 10:00 AM EDT)',
  },
];

function windowState(date: Date, hours: number | null, now: Date) {
  const afterHours = typeof hours === 'number' && hours > 0 ? hours : DEFAULT_HOURS;
  const liveCutoff = new Date(date.getTime() + afterHours * 60 * 60 * 1000);
  const graceEnd = new Date(liveCutoff.getTime() + GRACE_MS);
  // No early cutoff (owner rule 2026-08-28): open any time up to liveCutoff.
  let state: string;
  if (now <= liveCutoff) state = 'LIVE (geofenced post + story)';
  else if (now <= graceEnd) state = 'grace (posts: unlocked users only; stories closed)';
  else state = 'closed';
  return { liveCutoff, graceEnd, afterHours, state };
}

const near = (a: number | null | undefined, b: number, tol = 0.01) =>
  typeof a === 'number' && Math.abs(a - b) <= tol;

async function main() {
  const now = new Date();
  console.log(`[weekend-check] now = ${now.toISOString()}\n`);

  let problems = 0;
  const warn = (msg: string) => {
    problems++;
    console.log(`   ⚠ ${msg}`);
  };

  for (const day of FEST_DAYS) {
    const event = await prisma.event.findUnique({
      where: { id: day.id },
      select: {
        id: true,
        title: true,
        date: true,
        latitude: true,
        longitude: true,
        game_id: true,
        approval_status: true,
        status: true,
        live_window_hours_after_start: true,
      },
    });
    console.log(`── ${day.label} ─────────────────────────────`);
    if (!event) {
      warn(`EVENT ${day.id} NOT FOUND`);
      console.log('');
      continue;
    }

    // Event checks
    if (event.approval_status !== 'approved')
      warn(`event.approval_status=${event.approval_status} (expected approved)`);
    if (event.status !== 'approved') warn(`event.status=${event.status} (expected approved)`);
    if (event.date.toISOString() !== day.start)
      warn(`event.date ${event.date.toISOString()} != expected real start ${day.start} (nudged?)`);
    if (event.live_window_hours_after_start !== 18)
      warn(
        `event.live_window_hours_after_start=${event.live_window_hours_after_start ?? 'null'} (expected 18)`
      );
    if (!near(event.latitude, JAVITS.lat) || !near(event.longitude, JAVITS.lng))
      warn(`event coords (${event.latitude},${event.longitude}) not at Javits — geofence may fail`);
    if (!event.game_id) warn('event has no linked game_id — will not appear in the feed');

    // Linked game checks
    const game = event.game_id
      ? await prisma.game.findUnique({
          where: { id: event.game_id },
          select: {
            id: true,
            date: true,
            approval_status: true,
            opponent_approval_status: true,
            home_team_id: true,
            away_team_id: true,
            latitude: true,
            longitude: true,
          },
        })
      : null;
    if (event.game_id && !game) warn(`linked game ${event.game_id} NOT FOUND`);
    if (game) {
      if (game.approval_status !== 'approved')
        warn(`game.approval_status=${game.approval_status} (feed hides non-approved)`);
      if (!['not_required', 'approved'].includes(game.opponent_approval_status))
        warn(`game.opponent_approval_status=${game.opponent_approval_status} (blocks feed)`);
      if (game.home_team_id || game.away_team_id)
        warn(
          `game is not teamless (home=${game.home_team_id} away=${game.away_team_id}) — marquee expects teamless`
        );
      if (!near(game.latitude, JAVITS.lat) || !near(game.longitude, JAVITS.lng))
        warn(`game coords (${game.latitude},${game.longitude}) not at Javits`);
      // The game date can legitimately differ (feed reads server bounds), but a
      // wild drift is worth surfacing.
      const driftH = Math.abs(game.date.getTime() - event.date.getTime()) / 3_600_000;
      if (driftH > 24)
        warn(`game.date drifts ${driftH.toFixed(1)}h from event.date (was it left nudged?)`);
    }

    const { liveCutoff, afterHours, state } = windowState(
      event.date,
      event.live_window_hours_after_start,
      now
    );
    console.log(`   start:  ${event.date.toISOString()}  (window ${afterHours}h)`);
    console.log(`   posts/stories open:  (no early cutoff — open until close)`);
    console.log(`   live cutoff (+${afterHours}h): ${liveCutoff.toISOString()}`);
    console.log(`   STATE NOW: ${state}`);
    console.log('');
  }

  console.log(
    problems === 0
      ? '[weekend-check] ✓ ALL GREEN — every fest day is approved, event-visible, at its real start, 18h window, geofence-ready.'
      : `[weekend-check] ⚠ ${problems} issue(s) above need a look.`
  );
}

main()
  .catch(err => {
    console.error('[weekend-check] Failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
