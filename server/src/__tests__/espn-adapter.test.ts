import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { espnAdapter, ESPN_LEAGUES } from '../lib/proSchedule/espnAdapter.js';
import { resolveProTeamRef } from '../lib/proSchedule/resolveProTeamRef.js';
import { resolveFixture } from '../lib/proSchedule/resolveFixture.js';

const sample = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/espn-wnba-sample.json', import.meta.url)), 'utf8')
);

const adapter = espnAdapter();
const parse = (from: Date, to: Date) => adapter.__parseScoreboard!('wnba', sample, from, to);

describe('espnAdapter parser', () => {
  it('maps a scoreboard game to a normalized fixture with resolved team refs', () => {
    const all = parse(new Date('2000-01-01'), new Date('2100-01-01'));
    expect(all.length).toBe(sample.events.length);
    const g = all[0];
    expect(g.league).toBe('wnba');
    expect(g.external_ref).toMatch(/^wnba:\d+$/);
    expect(g.home_team_ref).toMatch(/^wnba:/);
    expect(g.away_team_ref).toMatch(/^wnba:/);
    expect(g.starts_at).toBeInstanceOf(Date);
    expect(g.venue_lat).toBeNull(); // ESPN has none — resolveFixture falls back to the home stadium
  });

  it('filters to the [from, to] window', () => {
    const all = parse(new Date('2000-01-01'), new Date('2100-01-01'));
    const none = parse(new Date('2000-01-01'), new Date('2000-01-02'));
    expect(all.length).toBeGreaterThan(0);
    expect(none.length).toBe(0);
  });

  it('leaves an unmapped team ref null so ingest quarantines it', () => {
    const bad = {
      events: [
        {
          id: '999',
          date: '2026-07-31T23:30Z',
          competitions: [
            {
              venue: { fullName: 'Nowhere Arena' },
              status: { type: { name: 'STATUS_SCHEDULED' } },
              competitors: [
                { homeAway: 'home', team: { displayName: 'Atlanta Dream' } },
                { homeAway: 'away', team: { displayName: 'Springfield Isotopes' } },
              ],
            },
          ],
        },
      ],
    };
    const parsed = adapter.__parseScoreboard!(
      'wnba',
      bad,
      new Date('2000-01-01'),
      new Date('2100-01-01')
    );
    expect(parsed[0].home_team_ref).toBe('wnba:atlanta-dream');
    expect(parsed[0].away_team_ref).toBeNull();
  });

  it('carries NCAA provider teams and venue geocode queries for ingest', () => {
    const ncaa = {
      events: [
        {
          id: '401864494',
          date: '2026-08-29T19:00Z',
          competitions: [
            {
              venue: {
                fullName: 'Los Angeles Memorial Coliseum',
                address: { city: 'Los Angeles', state: 'CA', country: 'USA' },
              },
              status: { type: { name: 'STATUS_SCHEDULED' } },
              competitors: [
                {
                  homeAway: 'home',
                  team: {
                    id: '30',
                    displayName: 'USC Trojans',
                    shortDisplayName: 'Trojans',
                    abbreviation: 'USC',
                    location: 'USC',
                    color: '990000',
                  },
                },
                {
                  homeAway: 'away',
                  team: {
                    id: '23',
                    displayName: 'San José State Spartans',
                    shortDisplayName: 'Spartans',
                    abbreviation: 'SJSU',
                    location: 'San José State',
                    color: '0055a2',
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    const [parsed] = adapter.__parseScoreboard!(
      'ncaaf',
      ncaa,
      new Date('2026-08-01T00:00:00.000Z'),
      new Date('2026-09-30T00:00:00.000Z')
    );

    expect(parsed.home_team_ref).toBe('ncaaf:espn-30');
    expect(parsed.away_team_ref).toBe('ncaaf:espn-23');
    expect(parsed.home_team).toMatchObject({
      external_ref: 'ncaaf:espn-30',
      name: 'USC Trojans',
      short_name: 'Trojans',
      primary_color: '#990000',
    });
    expect(parsed.venue_address).toBe('Los Angeles, CA, USA');
    expect(parsed._geocodeQuery).toBe('Los Angeles Memorial Coliseum, Los Angeles, CA, USA');
  });
});

describe('neutral-site detection', () => {
  const neutralSample = {
    events: [
      {
        id: '555',
        date: '2026-09-13T14:30Z',
        competitions: [
          {
            venue: {
              fullName: 'Wembley Stadium',
              address: { city: 'London', country: 'England' },
            },
            status: { type: { name: 'STATUS_SCHEDULED' } },
            competitors: [
              // Home team is real, but the game is at Wembley, not their stadium.
              { homeAway: 'home', team: { displayName: 'Atlanta Dream' } },
              { homeAway: 'away', team: { displayName: 'Seattle Storm' } },
            ],
          },
        ],
      },
    ],
  };

  it('flags a game away from the home stadium as neutral and sets a geocode query', () => {
    const [g] = adapter.__parseScoreboard!(
      'wnba',
      neutralSample,
      new Date('2000-01-01'),
      new Date('2100-01-01')
    );
    expect(g.venue_is_neutral).toBe(true);
    expect(g._geocodeQuery).toContain('Wembley Stadium');
    expect(g._geocodeQuery).toContain('London');
  });

  it('does NOT flag a normal home game as neutral', () => {
    // The WNBA sample's games are at home venues.
    const home = adapter.__parseScoreboard!(
      'wnba',
      sample,
      new Date('2000-01-01'),
      new Date('2100-01-01')
    );
    expect(home.every(g => g.venue_is_neutral === false)).toBe(true);
    expect(home.every(g => g._geocodeQuery === null)).toBe(true);
  });
});

describe('resolveFixture neutral-site safety', () => {
  const home = {
    id: 'wnba:atlanta-dream',
    external_ref: 'wnba:atlanta-dream',
    name: 'Atlanta Dream',
    short_name: 'Dream',
    venue_name: 'Gateway Center Arena',
    venue_address: null,
    venue_lat: 33.65,
    venue_lng: -84.45,
    timezone: null,
  };
  const byRef = new Map([[home.external_ref, home]]);

  it('quarantines a neutral game that has no coords instead of pinning it to the home stadium', () => {
    // A London game with no geocoded coords must NOT inherit Atlanta's geofence.
    const r = resolveFixture(
      {
        external_ref: 'wnba:x',
        league: 'wnba',
        starts_at: new Date('2026-09-13T14:30Z'),
        home_team_ref: 'wnba:atlanta-dream',
        away_team_ref: null,
        venue_name: 'Wembley Stadium',
        venue_is_neutral: true,
        venue_lat: null,
        venue_lng: null,
        status: 'scheduled',
      },
      byRef
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NO_VENUE_COORDS');
  });

  it('still uses the home stadium for an ordinary home game (neutral flag false)', () => {
    const r = resolveFixture(
      {
        external_ref: 'wnba:y',
        league: 'wnba',
        starts_at: new Date('2026-09-13T14:30Z'),
        home_team_ref: 'wnba:atlanta-dream',
        away_team_ref: null,
        venue_name: null,
        venue_is_neutral: false,
        venue_lat: null,
        venue_lng: null,
        status: 'scheduled',
      },
      byRef
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.latitude).toBeCloseTo(33.65, 2);
      expect(r.value.longitude).toBeCloseTo(-84.45, 2);
    }
  });
});

describe('espnAdapter coverage', () => {
  it('serves ESPN league sports including NCAA, not WWE', () => {
    expect(ESPN_LEAGUES.sort()).toEqual([
      'atp',
      'mlb',
      'nba',
      'ncaabaseball',
      'ncaaf',
      'ncaamb',
      'ncaamhockey',
      'ncaawb',
      'nfl',
      'wnba',
      'wta',
    ]);
    expect(ESPN_LEAGUES).not.toContain('wwe');
  });

  it('does not filter out NFL preseason games', () => {
    const preseason = {
      events: [
        {
          id: 'p1',
          date: '2026-08-13T00:00:00Z',
          competitions: [
            {
              season: { type: { name: 'PRESEASON' }, displayName: 'Preseason' },
              status: { type: { name: 'STATUS_SCHEDULED' } },
              venue: { fullName: 'Arrowhead Stadium' },
              competitors: [
                { homeAway: 'home', team: { displayName: 'Kansas City Chiefs' } },
                { homeAway: 'away', team: { displayName: 'Chicago Bears' } },
              ],
            },
          ],
        },
      ],
    };
    const parsed = adapter.__parseScoreboard!(
      'nfl',
      preseason,
      new Date('2026-08-01T00:00:00Z'),
      new Date('2026-08-31T23:59:59Z')
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].home_team_ref).toBe('nfl:kansas-city-chiefs');
    expect(parsed[0].away_team_ref).toBe('nfl:chicago-bears');
  });
});

describe('espnAdapter tennis parser', () => {
  const tennisSample = {
    events: [
      {
        id: '189-2026',
        date: '2026-08-24T04:00Z',
        name: 'US Open',
        shortName: 'US Open',
        venue: { displayName: 'New York, USA' },
        groupings: [
          {
            grouping: { slug: 'mens-singles', displayName: "Men's Singles" },
            competitions: [
              {
                id: '184607',
                startDate: '2026-09-02T16:00Z',
                venue: { fullName: 'New York, USA', court: 'Arthur Ashe Stadium' },
                status: { type: { name: 'STATUS_SCHEDULED' } },
                type: { text: "Men's Singles", slug: 'mens-singles' },
                round: { displayName: 'Quarterfinal' },
                competitors: [
                  {
                    homeAway: 'home',
                    athlete: { displayName: 'Carlos Alcaraz', shortName: 'C. Alcaraz' },
                  },
                  {
                    homeAway: 'away',
                    athlete: { displayName: 'Novak Djokovic', shortName: 'N. Djokovic' },
                  },
                ],
              },
              {
                id: '184609',
                startDate: '2026-09-02T18:00Z',
                venue: { fullName: 'New York, USA', court: 'Grandstand' },
                status: { type: { name: 'STATUS_SCHEDULED' } },
                type: { text: "Men's Singles", slug: 'mens-singles' },
                round: { displayName: 'Quarterfinal' },
                competitors: [
                  {
                    homeAway: 'home',
                    athlete: { displayName: 'Jannik Sinner', shortName: 'J. Sinner' },
                  },
                  {
                    homeAway: 'away',
                    athlete: { displayName: 'Taylor Fritz', shortName: 'T. Fritz' },
                  },
                ],
              },
            ],
          },
          {
            grouping: { slug: 'womens-singles', displayName: "Women's Singles" },
            competitions: [
              {
                id: '184608',
                startDate: '2026-09-02T17:00Z',
                venue: { fullName: 'New York, USA', court: 'Louis Armstrong Stadium' },
                status: { type: { name: 'STATUS_SCHEDULED' } },
                type: { text: "Women's Singles", slug: 'womens-singles' },
                round: { displayName: 'Quarterfinal' },
                competitors: [
                  {
                    homeAway: 'home',
                    athlete: { displayName: 'Coco Gauff', shortName: 'C. Gauff' },
                  },
                  {
                    homeAway: 'away',
                    athlete: { displayName: 'Iga Swiatek', shortName: 'I. Swiatek' },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  it('collapses ATP tournament matches into ONE day event anchored to the earliest match, no time in the title', () => {
    const parsed = adapter.__parseScoreboard!(
      'atp',
      tennisSample,
      new Date('2026-09-01T00:00:00.000Z'),
      new Date('2026-09-03T00:00:00.000Z')
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      external_ref: 'atp:189-2026:2026-09-02',
      league: 'atp',
      title: 'US Open ATP',
      // earliest of the day's ATP matches (16:00Z vs 18:00Z)
      starts_at: new Date('2026-09-02T16:00:00.000Z'),
      venue_name: 'USTA Billie Jean King National Tennis Center',
      venue_address: 'Flushing Meadows Corona Park, Queens, NY 11368',
      venue_lat: 40.7499,
      venue_lng: -73.8476,
      timezone: 'America/New_York',
    });
  });

  it('collapses WTA tournament matches without duplicating ATP draws, no time in the title', () => {
    const parsed = adapter.__parseScoreboard!(
      'wta',
      tennisSample,
      new Date('2026-09-01T00:00:00.000Z'),
      new Date('2026-09-03T00:00:00.000Z')
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].external_ref).toBe('wta:189-2026:2026-09-02');
    expect(parsed[0].title).toBe('US Open WTA');
    expect(parsed[0].starts_at).toEqual(new Date('2026-09-02T17:00:00.000Z'));
  });

  it('does not create generic round events when ESPN omits tennis competitors', () => {
    const genericRound = {
      events: [
        {
          id: '189-2026',
          date: '2026-09-03T04:00Z',
          name: 'US Open',
          shortName: 'US Open',
          groupings: [
            {
              grouping: { slug: 'mens-singles', displayName: "Men's Singles" },
              competitions: [
                {
                  id: 'round-container',
                  startDate: '2026-09-03T04:00Z',
                  type: { text: "Men's Singles", slug: 'mens-singles' },
                  round: { displayName: 'Round 2' },
                  competitors: [],
                },
              ],
            },
          ],
        },
      ],
    };

    const parsed = adapter.__parseScoreboard!(
      'atp',
      genericRound,
      new Date('2026-09-01T00:00:00.000Z'),
      new Date('2026-09-04T00:00:00.000Z')
    );

    expect(parsed).toEqual([]);
  });
});

describe('resolveProTeamRef', () => {
  it('resolves current teams and rejects unknowns', () => {
    expect(resolveProTeamRef('wnba', 'Seattle Storm')).toBe('wnba:seattle-storm');
    expect(resolveProTeamRef('nfl', 'Kansas City Chiefs')).toBe('nfl:kansas-city-chiefs');
    expect(resolveProTeamRef('nfl', 'Oakland Raiders')).toBe('nfl:las-vegas-raiders'); // alias
    expect(resolveProTeamRef('mlb', 'Springfield Isotopes')).toBeNull();
  });
});
