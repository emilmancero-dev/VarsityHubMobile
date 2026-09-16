/**
 * Commandments parity guard.
 *
 * Binds docs/COMMANDMENTS.md (the code-verified spec) to the source constants it
 * describes, so the two cannot silently drift. Every number asserted here is a
 * load-bearing claim in the commandments; if someone changes the code without
 * updating the doc (or reintroduces a corrected-away claim like SeatGeek), this
 * fails.
 *
 * Uses source-text assertions (like iap-config-invariants.test.ts) rather than
 * importing runtime modules, so it needs no DB/env and stays a pure check.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SERVER_ROOT = process.cwd();
const REPO_ROOT = join(SERVER_ROOT, '..');

const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8');

const geofencing = read(SERVER_ROOT, 'src/lib/geofencing.ts');
const adPricing = read(SERVER_ROOT, 'src/utils/adPricing.ts');
const posts = read(SERVER_ROOT, 'src/routes/posts.ts');
const espnAdapter = read(SERVER_ROOT, 'src/lib/proSchedule/espnAdapter.ts');
const feed = read(REPO_ROOT, 'app/feed.tsx');
const profile = read(REPO_ROOT, 'app/profile.tsx');
const usersRoute = read(SERVER_ROOT, 'src/routes/users.ts');
const commandments = read(REPO_ROOT, 'docs/COMMANDMENTS.md');

describe('commandments: live window', () => {
  it('opens 2h before start', () => {
    expect(geofencing).toMatch(/DEFAULT_LIVE_WINDOW_HOURS_BEFORE_START\s*=\s*2\b/);
  });
  it('standard window is 8h total (2 before + 6 after start)', () => {
    expect(geofencing).toMatch(/DEFAULT_LIVE_WINDOW_HOURS_AFTER_START\s*=\s*6\b/);
  });
  it('coach all-day window is 12h', () => {
    expect(geofencing).toMatch(/COACH_ALL_DAY_LIVE_WINDOW_HOURS\s*=\s*12\b/);
  });
  it('coach extended window is 18h', () => {
    expect(geofencing).toMatch(/COACH_ALL_DAY_EXTENDED_LIVE_WINDOW_HOURS\s*=\s*18\b/);
  });
  it('post grace window is 7 days', () => {
    expect(geofencing).toMatch(
      /REGULAR_POST_GRACE_WINDOW_MS\s*=\s*7\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/
    );
  });
});

describe('commandments: geo-fence radius', () => {
  // Owner decision 2026-09-15: flat 3.0km for both posts and stories, by design
  // (consistency + absorbs indoor GPS drift). Capacity-scaled tiers were rejected.
  it('posts use a flat 3.0km radius', () => {
    expect(geofencing).toMatch(/3\.0\);\s*\/\/\s*3km for posts/);
  });
  it('stories use the same flat 3.0km radius', () => {
    expect(geofencing).toMatch(/3\.0\);\s*\/\/\s*3km for stories/);
  });
});

describe('commandments: posting caps', () => {
  it('media is capped at 5 items per post', () => {
    // media_urls array in the create-post schema
    expect(posts).toMatch(/media_urls[\s\S]{0,200}?\.max\(5\)/);
  });
});

describe('commandments: ad pricing', () => {
  it('weekday block is $4.99', () => {
    expect(adPricing).toMatch(/WEEKDAY_BLOCK_PRICE\s*=\s*4\.99\b/);
  });
  it('weekend block is $7.99', () => {
    expect(adPricing).toMatch(/WEEKEND_BLOCK_PRICE\s*=\s*7\.99\b/);
  });
});

describe('commandments: data source is ESPN, not SeatGeek', () => {
  it('has an ESPN adapter defining league paths', () => {
    expect(existsSync(join(SERVER_ROOT, 'src/lib/proSchedule/espnAdapter.ts'))).toBe(true);
    expect(espnAdapter).toMatch(/ESPN_PATH/);
    expect(espnAdapter).toMatch(/college-football/);
  });
  it('has no SeatGeek adapter file', () => {
    expect(existsSync(join(SERVER_ROOT, 'src/lib/proSchedule/seatGeekAdapter.ts'))).toBe(false);
  });
  it('the commandments doc does not reintroduce SeatGeek as the source', () => {
    // The doc may reference SeatGeek only inside the CORRECTION note explaining
    // it is NOT used. It must never present SeatGeek as the ingest source.
    expect(commandments).not.toMatch(/Source:\s*SeatGeek/i);
    expect(commandments).toMatch(/Source:\**\s*ESPN/i);
  });
});

describe('commandments: NCAA scope is D1, five ESPN leagues (not "all divisions")', () => {
  const ncaaLeagues = ['ncaaf', 'ncaamb', 'ncaawb', 'ncaabaseball', 'ncaamhockey'];
  it.each(ncaaLeagues)('ingests NCAA league %s', league => {
    expect(espnAdapter).toMatch(new RegExp(`\\b${league}\\s*:`));
  });
  it('the doc does not claim D1-D3 all-sports coverage as current', () => {
    expect(commandments).toMatch(/Division I only/i);
  });
});

describe('commandments: doc exists and is the reconciled edition', () => {
  it('is labeled code-verified', () => {
    expect(commandments).toMatch(/Code-Verified Edition/);
  });

  it('assigns stable IDs and explicit statuses to the event-card claims', () => {
    expect(commandments).toMatch(/CMD-EVENT-005\s*\|\s*CURRENT/);
    expect(commandments).toMatch(/CMD-EVENT-006\s*\|\s*CURRENT/);
  });

  it('documents the live and past post counter instead of stale Watching-closed behavior', () => {
    expect(feed).toMatch(/const showPostCounter = isLive \|\| isEventPast/);
    expect(commandments).toMatch(/live and past[^\n]*post count/i);
  });

  it('documents the profile Events tab as shipped attendance history', () => {
    expect(profile).toMatch(/User\.eventPagesForProfile/);
    expect(profile).toMatch(/<EventFeedCard/);
    expect(usersRoute).toMatch(/eventPostingUnlock\.findMany/);
    expect(commandments).toMatch(/profile Events tab[^\n]*SHIPPED/i);
    expect(commandments).not.toMatch(/map legend, profile events\s+tab,/i);
  });
});
