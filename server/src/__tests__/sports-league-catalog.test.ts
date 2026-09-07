import { resolveConfiguredAdapter } from '../lib/proSchedule/adapters.js';
import { ESPN_LEAGUES } from '../lib/proSchedule/espnAdapter.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SPORTS_LEAGUE_CATALOG } from '../lib/sportsLeagueCatalog.js';

const sportsTaxonomy = JSON.parse(
  readFileSync(path.join(process.cwd(), '../shared/sports-taxonomy.json'), 'utf8')
) as { sports: Array<{ slug: string }> };

describe('sports league catalog', () => {
  const slugs = SPORTS_LEAGUE_CATALOG.map(league => league.slug);
  const taxonomySlugs = new Set(sportsTaxonomy.sports.map(sport => sport.slug));

  it('has unique, safe slugs and ids', () => {
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(SPORTS_LEAGUE_CATALOG.map(league => league.id)).size).toBe(
      SPORTS_LEAGUE_CATALOG.length
    );
    for (const league of SPORTS_LEAGUE_CATALOG) {
      expect(league.slug).toMatch(/^[a-z0-9_]+$/);
      expect(league.id).toBe(`sports_league_${league.slug}`);
      expect(league.active).toBe(Boolean(league.provider && league.provider_league_id));
    }
  });

  it('covers major, minor, and NCAA league categories', () => {
    expect(slugs).toEqual(
      expect.arrayContaining([
        'nfl',
        'nba',
        'wnba',
        'mlb',
        'nhl',
        'mls',
        'nwsl',
        'wwe',
        'ufc',
        'fiba_womens_world_cup',
        'milb_triple_a',
        'milb_double_a',
        'milb_high_a',
        'milb_single_a',
        'ahl',
        'echl',
        'nba_g_league',
        'usl_championship',
        'usl_league_one',
        'ncaaf',
        'ncaamb',
        'ncaawb',
        'ncaabaseball',
        'ncaasoftball',
        'ncaamhockey',
        'ncaawhockey',
        'ncaamsoccer',
        'ncaawsoccer',
        'ncaawvolleyball',
        'ncaawbeach_volleyball',
        'ncaafencing',
        'ncaarifle',
        'ncaaskiing',
        'ncaawrowing',
        'ncaawstunt',
      ])
    );
    expect(SPORTS_LEAGUE_CATALOG.some(league => league.level === 'major')).toBe(true);
    expect(SPORTS_LEAGUE_CATALOG.some(league => league.level === 'minor')).toBe(true);
    expect(SPORTS_LEAGUE_CATALOG.some(league => league.level === 'college')).toBe(true);
    expect(SPORTS_LEAGUE_CATALOG.some(league => league.level === 'international')).toBe(true);
  });

  it('classifies FIBA women as international basketball, not WNBA', () => {
    expect(SPORTS_LEAGUE_CATALOG).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slug: 'fiba_womens_world_cup',
          sport_slug: 'basketball',
          level: 'international',
          gender: 'women',
          provider: 'fiba',
        }),
      ])
    );
  });

  it('uses sports that the map can normalize and filter', () => {
    for (const league of SPORTS_LEAGUE_CATALOG) {
      expect(taxonomySlugs.has(league.sport_slug)).toBe(true);
    }
  });
});

it('does not advertise unsupported minor league or MLS NEXT feeds as active', () => {
  for (const slug of [
    'milb_triple_a',
    'milb_double_a',
    'milb_high_a',
    'milb_single_a',
    'mls_next_pro',
  ]) {
    expect(SPORTS_LEAGUE_CATALOG.find(league => league.slug === slug)?.active).toBe(false);
  }
});

it('uses only ESPN in the live provider configuration, without a TheSportsDB fallback', () => {
  const adapter = resolveConfiguredAdapter({ PRO_SCHEDULE_PROVIDER: 'espn' });
  expect(adapter?.name).toBe('espn');
  expect(adapter?.leagues).toEqual(ESPN_LEAGUES);
  expect(SPORTS_LEAGUE_CATALOG.find(league => league.slug === 'wwe')).toMatchObject({
    provider: null,
    provider_league_id: null,
    active: false,
  });
});
