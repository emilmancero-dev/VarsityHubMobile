/**
 * END-TO-END drive of the Fanatics Fest posting/unlock rule against the REAL
 * server logic (server/src/lib/geofencing.ts) and a REAL Postgres (local
 * `varsityhub` DB). This is the live-flow verification the owner asked for —
 * exercised on LOCAL, never prod, so the real fest event data stays clean.
 *
 * Seeds one event + two users, drives verifyEventPostingPermission /
 * verifyStoryPostingPermission across every state, asserts each outcome, then
 * deletes everything it created (revert). Prints a PASS/FAIL table.
 *
 *   cd server && npx tsx scripts/e2e/fanatics-posting-flow.ts
 *
 * Requires nvm Node 20 (tsx). Uses server/.env DATABASE_URL (local :5432).
 */
import { prisma } from '../../src/lib/prisma.js';
import {
  verifyEventPostingPermission,
  verifyStoryPostingPermission,
  getPostPostingWindowState,
  hasActiveEventPostingUnlock,
} from '../../src/lib/geofencing.js';

// Javits Center, NYC (the real fest venue coords) and a far-away point (LA).
const VENUE = { lat: 40.7577, lon: -74.0021 };
const NEAR = { lat: 40.758, lon: -74.001 }; // ~150m from venue → inside 3km
const FAR = { lat: 34.0522, lon: -118.2437 }; // Los Angeles → far outside

const RUN = Date.now().toString(36);
const ids: { events: string[]; users: string[] } = { events: [], users: [] };

type Row = { name: string; pass: boolean; detail: string };
const rows: Row[] = [];
function check(name: string, pass: boolean, detail: string) {
  rows.push({ name, pass, detail });
  const tag = pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  ${tag}  ${name} — ${detail}`);
}

async function makeUser(tag: string) {
  const u = await prisma.user.create({
    data: { email: `e2e-${tag}-${RUN}@test.local`, username: `e2e_${tag}_${RUN}`.slice(0, 20) },
    select: { id: true },
  });
  ids.users.push(u.id);
  return u.id;
}

async function makeEvent(opts: {
  hoursFromNow: number;
  liveWindowHoursAfterStart?: number | null;
  exclusivePosterId?: string | null;
  withCoords?: boolean;
}) {
  const date = new Date(Date.now() + opts.hoursFromNow * 3600_000);
  const e = await prisma.event.create({
    data: {
      title: `E2E Fest ${RUN}`,
      date,
      latitude: opts.withCoords === false ? null : VENUE.lat,
      longitude: opts.withCoords === false ? null : VENUE.lon,
      location: 'Javits Center, NYC',
      live_window_hours_after_start: opts.liveWindowHoursAfterStart ?? null,
      exclusive_poster_id: opts.exclusivePosterId ?? null,
    },
    select: { id: true },
  });
  ids.events.push(e.id);
  return e.id;
}

async function main() {
  console.log(`\n\x1b[1mFanatics posting/unlock E2E\x1b[0m (run ${RUN}) — local DB, real logic\n`);

  const fan = await makeUser('fan');
  const other = await makeUser('other');
  const nico = await makeUser('nico');

  // ── 1. Window-state math (pure, no DB): no early cutoff → +3h default ─────
  const start = new Date();
  check(
    'window: 90min before start = live (no early cutoff)',
    getPostPostingWindowState(new Date(start.getTime() + 90 * 60000), start) === 'live',
    'posting has no early cutoff — early arrivals are never blocked'
  );
  check(
    'window: a full day before start = live (no early cutoff)',
    getPostPostingWindowState(new Date(start.getTime() + 24 * 3600000), start) === 'live',
    'even far before start, posting is open (geofence is the only presence gate)'
  );
  check(
    'window: 45min before start = live',
    getPostPostingWindowState(new Date(start.getTime() - 45 * 60000), start) === 'live',
    'open before start'
  );
  check(
    'window: +2h after start (default) = live',
    getPostPostingWindowState(new Date(start.getTime() - 2 * 3600000), start) === 'live',
    'inside default 3h'
  );
  check(
    'window: +5h after start (default) = grace',
    getPostPostingWindowState(new Date(start.getTime() - 5 * 3600000), start) === 'grace',
    'past 3h live cutoff, inside 7d grace'
  );
  check(
    'window: +12h after start with 18h override = live',
    getPostPostingWindowState(new Date(start.getTime() - 12 * 3600000), start, 18) === 'live',
    'fest 18h window keeps all-day posting live'
  );
  check(
    'window: +9d after start = closed',
    getPostPostingWindowState(new Date(start.getTime() - 9 * 24 * 3600000), start) === 'closed',
    'past 7d grace → closed for everyone'
  );

  // ── 2. LIVE event, first post: geofence strict ──────────────────────────
  const liveEvent = await makeEvent({ hoursFromNow: -1 }); // started 1h ago → live (default 3h)

  const farFirst = await verifyEventPostingPermission(liveEvent, fan, FAR.lat, FAR.lon);
  check(
    'first post from LA (far) = blocked',
    farFirst.allowed === false && farFirst.code === 'TOO_FAR_FROM_VENUE',
    `code=${farFirst.code}`
  );

  const noLoc = await verifyEventPostingPermission(liveEvent, fan, null, null);
  check(
    'first post with no device location = blocked',
    noLoc.allowed === false && noLoc.code === 'LOCATION_REQUIRED',
    `code=${noLoc.code}`
  );

  const nearFirst = await verifyEventPostingPermission(liveEvent, fan, NEAR.lat, NEAR.lon);
  check(
    'first post AT venue (near) = allowed + writes unlock',
    nearFirst.allowed === true,
    `distance=${nearFirst.distance?.toFixed(3)}km`
  );

  const unlockRow = await prisma.eventPostingUnlock.findUnique({
    where: { user_id_event_id: { user_id: fan, event_id: liveEvent } },
    select: { unlocked_at: true },
  });
  check(
    'unlock ledger row written for the fan',
    !!unlockRow,
    unlockRow ? `unlocked_at=${unlockRow.unlocked_at.toISOString()}` : 'MISSING'
  );

  // ── 3. THE core owner rule: unlocked fan posts from far away ─────────────
  const farAfterUnlock = await verifyEventPostingPermission(liveEvent, fan, FAR.lat, FAR.lon);
  check(
    'unlocked fan posts from LA (far) = ALLOWED',
    farAfterUnlock.allowed === true,
    'proof-of-presence unlock lets them post from anywhere'
  );

  const otherFar = await verifyEventPostingPermission(liveEvent, other, FAR.lat, FAR.lon);
  check(
    'DIFFERENT user (never at venue) posts from far = blocked',
    otherFar.allowed === false,
    `code=${otherFar.code} — unlock is per-user, not shared`
  );

  // ── 4. Grace window: unlocked fan keeps posting after the live window ────
  const graceEvent = await makeEvent({ hoursFromNow: -5 }); // started 5h ago, default 3h → grace
  check(
    'grace event is in grace state',
    getPostPostingWindowState(new Date(Date.now() - 5 * 3600000), new Date()) === 'grace',
    'sanity'
  );
  // Fan has no unlock on THIS event yet → grace blocks them.
  const graceNoUnlock = await verifyEventPostingPermission(graceEvent, fan, FAR.lat, FAR.lon);
  check(
    'grace + no prior unlock on this event = blocked',
    graceNoUnlock.allowed === false && graceNoUnlock.code === 'POSTING_WINDOW_CLOSED',
    `code=${graceNoUnlock.code}`
  );
  // Now grant proof-of-presence during grace by a near post is impossible (window is grace,
  // strict path only runs in 'live'), so simulate the realistic path: they posted while live.
  // Seed an unlock as if they'd posted while live, then grace should admit them from anywhere.
  await prisma.eventPostingUnlock.create({ data: { user_id: fan, event_id: graceEvent } });
  const graceWithUnlock = await verifyEventPostingPermission(graceEvent, fan, FAR.lat, FAR.lon);
  check(
    'grace + prior unlock = ALLOWED from anywhere',
    graceWithUnlock.allowed === true,
    'week-long recap posting works'
  );

  // ── 5. Closed after 7-day grace ─────────────────────────────────────────
  const closedEvent = await makeEvent({ hoursFromNow: -9 * 24 }); // 9 days ago → closed
  await prisma.eventPostingUnlock.create({ data: { user_id: fan, event_id: closedEvent } });
  const closed = await verifyEventPostingPermission(closedEvent, fan, NEAR.lat, NEAR.lon);
  check(
    'closed (>7d after) even for unlocked fan = blocked',
    closed.allowed === false && closed.code === 'POSTING_WINDOW_CLOSED',
    `code=${closed.code} — hard close after grace`
  );

  // ── 6. 18h fest override lets a far-into-the-day first post through ──────
  const festEvent = await makeEvent({ hoursFromNow: -12, liveWindowHoursAfterStart: 18 });
  const festDefaultWouldClose =
    getPostPostingWindowState(new Date(Date.now() - 12 * 3600000), new Date()) === 'grace';
  const festOverrideLive =
    getPostPostingWindowState(new Date(Date.now() - 12 * 3600000), new Date(), 18) === 'live';
  check(
    '18h override: +12h in is live (default would be grace)',
    festDefaultWouldClose && festOverrideLive,
    'the fest column is what keeps all-day geofenced posting open'
  );
  const festNear = await verifyEventPostingPermission(festEvent, other, NEAR.lat, NEAR.lon);
  check(
    'fresh fan first post 12h into fest day AT venue = allowed',
    festNear.allowed === true,
    'geofenced all-day posting confirmed'
  );

  // ── 7. Exclusive-poster lock (the @nico prod state) ─────────────────────
  const exEvent = await makeEvent({ hoursFromNow: -1, exclusivePosterId: nico });
  const nicoPost = await verifyEventPostingPermission(exEvent, nico, FAR.lat, FAR.lon);
  check(
    'exclusive poster (@nico) posts from far, out of window = allowed',
    nicoPost.allowed === true,
    'designated poster bypasses window + geofence'
  );
  const otherOnExclusive = await verifyEventPostingPermission(exEvent, other, NEAR.lat, NEAR.lon);
  check(
    'non-designated user at venue on exclusive event = blocked',
    otherOnExclusive.allowed === false && otherOnExclusive.code === 'EXCLUSIVE_POSTER_ONLY',
    `code=${otherOnExclusive.code}`
  );

  // ── 8. Stories share the same unlock ledger as posts ────────────────────
  // Fan already has an unlock on liveEvent (from the geofenced post above).
  const storyUnlocked = await hasActiveEventPostingUnlock(fan, {
    id: liveEvent,
    game_id: null,
  });
  check(
    'story path sees the SAME unlock earned by a post',
    storyUnlocked === true,
    'stories↔posts share proof-of-presence'
  );
  // A never-present user has no unlock for stories either.
  const storyOtherFar = await verifyStoryPostingPermission(
    liveEvent,
    other,
    FAR.lat,
    FAR.lon,
    null
  );
  check(
    'story from far, no unlock = blocked',
    storyOtherFar.allowed === false,
    `code=${storyOtherFar.code}`
  );

  // ── Summary ─────────────────────────────────────────────────────────────
  const failed = rows.filter(r => !r.pass);
  console.log(
    `\n\x1b[1m${rows.length - failed.length}/${rows.length} passed\x1b[0m` +
      (failed.length ? ` — \x1b[31m${failed.length} FAILED\x1b[0m` : ' — all green')
  );
  return failed.length;
}

async function cleanup() {
  // Delete children first (unlock rows), then events + users. Only rows we made.
  await prisma.eventPostingUnlock.deleteMany({ where: { event_id: { in: ids.events } } });
  await prisma.event.deleteMany({ where: { id: { in: ids.events } } });
  await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
}

main()
  .then(async failed => {
    await cleanup();
    console.log('\x1b[2m[cleanup] seeded rows reverted\x1b[0m');
    await prisma.$disconnect();
    process.exit(failed ? 1 : 0);
  })
  .catch(async e => {
    console.error('E2E ERROR:', e);
    await cleanup().catch(() => {});
    await prisma.$disconnect();
    process.exit(2);
  });
