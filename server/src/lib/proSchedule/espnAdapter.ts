import type { ProLeague } from '@prisma/client';
import { geocodeVenue, type GeocodeFn } from './geocodeVenue.js';
import { resolveProTeamRef } from './resolveProTeamRef.js';
import type { ProFixture, ProScheduleAdapter, ProviderTeam } from './types.js';
import { isNcaaLeague } from './types.js';

/**
 * ESPN public scoreboard adapter.
 *
 * Covers ESPN-backed pro and major NCAA league sports via one date-range call
 * per league. WWE is a touring promotion ESPN does not carry — it is
 * intentionally excluded and needs its own source.
 *
 * ESPN provides no venue coordinates. For a HOME game that is fine —
 * resolveFixture falls back to the home team's seeded stadium. But a
 * neutral-site/international game (venue != the home stadium) must NOT inherit
 * the home geofence, or fans in London would be geofenced to Jacksonville. The
 * adapter detects those and geocodes their venue; a venue that won't geocode is
 * left coord-less and quarantined downstream — accurate by refusal.
 */

const ESPN_PATH: Partial<Record<ProLeague, string>> = {
  nfl: 'football/nfl',
  nba: 'basketball/nba',
  wnba: 'basketball/wnba',
  mlb: 'baseball/mlb',
  atp: 'tennis/atp',
  wta: 'tennis/wta',
  ncaaf: 'football/college-football',
  ncaamb: 'basketball/mens-college-basketball',
  ncaawb: 'basketball/womens-college-basketball',
  ncaabaseball: 'baseball/college-baseball',
  ncaamhockey: 'hockey/mens-college-hockey',
};

export const ESPN_LEAGUES = Object.keys(ESPN_PATH) as ProLeague[];

type EspnTeam = {
  id?: string;
  displayName?: string;
  shortDisplayName?: string;
  abbreviation?: string;
  location?: string;
  name?: string;
  color?: string;
};
type EspnCompetitor = { homeAway: 'home' | 'away'; team?: EspnTeam };
type EspnTennisCompetitor = {
  homeAway?: 'home' | 'away';
  athlete?: { displayName?: string; shortName?: string };
  roster?: { displayName?: string; shortDisplayName?: string };
};
type EspnEvent = {
  id: string;
  date: string;
  endDate?: string;
  name?: string;
  shortName?: string;
  venue?: { displayName?: string };
  groupings?: Array<{
    grouping?: { slug?: string; displayName?: string };
    competitions?: EspnTennisCompetition[];
  }>;
  competitions?: Array<{
    venue?: { fullName?: string; address?: { city?: string; state?: string; country?: string } };
    status?: { type?: { name?: string } };
    competitors?: EspnCompetitor[];
  }>;
};
type EspnTennisCompetition = {
  id: string;
  date?: string;
  startDate?: string;
  timeValid?: boolean;
  venue?: { fullName?: string; court?: string };
  status?: { type?: { name?: string } };
  competitors?: EspnTennisCompetitor[];
  type?: { text?: string; slug?: string };
  round?: { displayName?: string };
};

/** A parsed fixture before geocoding; `_geocodeQuery` is set only for neutral-site games. */
export type EspnPreGeocode = ProFixture & { _geocodeQuery: string | null };

type EspnAdapter = ProScheduleAdapter & {
  /** Test-only pure parser (no network, no geocode). */
  __parseScoreboard?: (league: ProLeague, raw: unknown, from: Date, to: Date) => EspnPreGeocode[];
};

/** ESPN status type name → our fixture status. Future-window games are scheduled. */
function mapStatus(name?: string): ProFixture['status'] {
  const n = (name ?? '').toUpperCase();
  if (n.includes('CANCEL')) return 'cancelled';
  if (n.includes('POSTPON')) return 'postponed';
  return 'scheduled';
}

function normalizeColor(color?: string): string | null {
  if (!color) return null;
  const trimmed = color.trim().replace(/^#/, '');
  return /^[0-9a-f]{6}$/i.test(trimmed) ? `#${trimmed}` : null;
}

function varchar(value: string | null | undefined, max: number): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function ncaaTeamRef(league: ProLeague, team?: EspnTeam | null): string | null {
  if (!team?.id) return null;
  return `${league}:espn-${team.id}`;
}

function providerTeam(league: ProLeague, team?: EspnTeam | null): ProviderTeam | null {
  const externalRef = ncaaTeamRef(league, team);
  if (!externalRef || !team?.displayName) return null;
  return {
    external_ref: externalRef,
    league,
    name: varchar(team.displayName, 120) ?? externalRef,
    short_name: varchar(team.shortDisplayName || team.name || team.displayName, 60) ?? externalRef,
    abbreviation: varchar(team.abbreviation, 8),
    city: varchar(team.location, 100),
    state: null,
    conference: null,
    division: null,
    venue_name: null,
    venue_address: null,
    venue_lat: null,
    venue_lng: null,
    timezone: null,
    primary_color: normalizeColor(team.color),
  };
}

function tennisCompetitorName(competitor?: EspnTennisCompetitor | null): string | null {
  return (
    varchar(
      competitor?.athlete?.displayName ||
        competitor?.athlete?.shortName ||
        competitor?.roster?.displayName ||
        competitor?.roster?.shortDisplayName,
      120
    ) ?? null
  );
}

const TENNIS_TOURNAMENT_VENUES: Record<
  string,
  {
    venue_name: string;
    venue_address: string;
    venue_lat: number;
    venue_lng: number;
    timezone: string;
  }
> = {
  'us open': {
    venue_name: 'USTA Billie Jean King National Tennis Center',
    venue_address: 'Flushing Meadows Corona Park, Queens, NY 11368',
    venue_lat: 40.7499,
    venue_lng: -73.8476,
    timezone: 'America/New_York',
  },
  'winston-salem open': {
    venue_name: 'Wake Forest Tennis Complex',
    venue_address: '100 W 32nd St, Winston-Salem, NC 27105',
    venue_lat: 36.1302,
    venue_lng: -80.2548,
    timezone: 'America/New_York',
  },
};

function tennisVenueFor(event: EspnEvent) {
  const key = (event.name || event.shortName || '').trim().toLowerCase();
  return TENNIS_TOURNAMENT_VENUES[key] ?? null;
}

function tennisDrawMatchesLeague(league: ProLeague, drawSlug?: string | null): boolean {
  const slug = (drawSlug ?? '').toLowerCase();
  if (league === 'atp') return slug.startsWith('mens-');
  if (league === 'wta') return slug.startsWith('womens-');
  return false;
}

function tennisTitle(event: EspnEvent, competition: EspnTennisCompetition): string | null {
  const home = tennisCompetitorName(
    competition.competitors?.find(c => c.homeAway === 'home') ?? null
  );
  const away = tennisCompetitorName(
    competition.competitors?.find(c => c.homeAway === 'away') ?? null
  );
  const tournament = varchar(event.shortName || event.name, 80);
  if (home && away && home !== 'TBD' && away !== 'TBD') {
    return tournament ? `${away} vs ${home} - ${tournament}` : `${away} vs ${home}`;
  }
  return null;
}

function timeZoneParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const value = (type: string) => Number(parts.find(part => part.type === type)?.value);
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour') % 24,
    minute: value('minute'),
    second: value('second'),
  };
}

/**
 * Tennis events are grouped into ONE event per league per tournament-day (owner
 * decision 2026-09-12: no more AM/PM half-day windows, and no date/time baked
 * into the title). `starts_at` is the actual earliest match that day; the client
 * shows the date via its own chip, so the public title carries no date or time.
 */
function tennisDayKey(startsAt: Date, timeZone: string) {
  const parts = timeZoneParts(startsAt, timeZone);
  const dateKey = `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(
    parts.day
  ).padStart(2, '0')}`;
  return { dateKey };
}

function tennisDayTitle(event: EspnEvent, league: ProLeague) {
  const tournament = varchar(event.shortName || event.name, 80);
  const leagueLabel = league.toUpperCase();
  return tournament ? `${tournament} ${leagueLabel}` : `${leagueLabel} Tennis`;
}

function parseTennisScoreboard(
  league: ProLeague,
  raw: unknown,
  from: Date,
  to: Date
): EspnPreGeocode[] {
  const events = (raw as { events?: EspnEvent[] })?.events;
  if (!Array.isArray(events)) return [];

  const buckets = new Map<string, EspnPreGeocode & { hasScheduled: boolean }>();
  for (const event of events) {
    const venue = tennisVenueFor(event);
    if (!venue) continue;
    for (const grouping of event.groupings ?? []) {
      if (!tennisDrawMatchesLeague(league, grouping.grouping?.slug)) continue;
      for (const competition of grouping.competitions ?? []) {
        const startsAt = new Date(competition.startDate || competition.date || event.date);
        if (Number.isNaN(startsAt.getTime())) continue;
        if (startsAt < from || startsAt > to) continue;
        // A day-event only exists if the day has ≥1 real (non-TBD) matchup.
        const matchTitle = tennisTitle(event, competition);
        if (!matchTitle) continue;
        const { dateKey } = tennisDayKey(startsAt, venue.timezone);
        const status = mapStatus(competition.status?.type?.name);
        const externalRef = `${league}:${event.id}:${dateKey}`;
        const existing = buckets.get(externalRef);
        if (existing) {
          existing.hasScheduled = existing.hasScheduled || status === 'scheduled';
          existing.status = existing.hasScheduled ? 'scheduled' : existing.status;
          // Anchor the event to the day's EARLIEST actual match start.
          if (startsAt < existing.starts_at) existing.starts_at = startsAt;
          continue;
        }
        buckets.set(externalRef, {
          external_ref: externalRef,
          league,
          starts_at: startsAt,
          home_team_ref: null,
          away_team_ref: null,
          home_team: null,
          away_team: null,
          title: tennisDayTitle(event, league),
          venue_name: venue.venue_name,
          venue_address: venue.venue_address,
          venue_lat: venue.venue_lat,
          venue_lng: venue.venue_lng,
          timezone: venue.timezone,
          venue_is_neutral: false,
          status,
          _geocodeQuery: null,
          hasScheduled: status === 'scheduled',
        });
      }
    }
  }
  return [...buckets.values()].map(({ hasScheduled: _hasScheduled, ...fixture }) => fixture);
}

/** UTC yyyymmdd for ESPN's `dates=START-END` range param. */
function yyyymmdd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

export function parseScoreboard(
  league: ProLeague,
  raw: unknown,
  from: Date,
  to: Date
): EspnPreGeocode[] {
  if (league === 'atp' || league === 'wta') return parseTennisScoreboard(league, raw, from, to);

  const events = (raw as { events?: EspnEvent[] })?.events;
  if (!Array.isArray(events)) return [];

  const out: EspnPreGeocode[] = [];
  for (const e of events) {
    const comp = e.competitions?.[0];
    if (!comp) continue;
    const startsAt = new Date(e.date);
    if (Number.isNaN(startsAt.getTime())) continue;
    if (startsAt < from || startsAt > to) continue;

    const homeTeam = comp.competitors?.find(c => c.homeAway === 'home')?.team ?? null;
    const awayTeam = comp.competitors?.find(c => c.homeAway === 'away')?.team ?? null;
    const home = homeTeam?.displayName ?? null;
    const away = awayTeam?.displayName ?? null;
    const collegeLeague = isNcaaLeague(league);
    const homeRef = collegeLeague ? ncaaTeamRef(league, homeTeam) : resolveProTeamRef(league, home);
    const awayRef = collegeLeague ? ncaaTeamRef(league, awayTeam) : resolveProTeamRef(league, away);

    const venueName = comp.venue?.fullName ?? null;
    const addr = comp.venue?.address ?? {};

    // Neutral-site (international) detection. ESPN is inconsistent about the
    // country field — NFL stamps "USA" on domestic games, MLB leaves it null —
    // so the reliable signal is "country is set AND it isn't the home nation".
    // That flags only genuinely international games (London, Melbourne, Mexico
    // City…), which are exactly the ones that must not inherit the home
    // stadium's geofence. Toronto's home games read as USA-null domestic, so the
    // Blue Jays are unaffected. (A US team playing IN Canada would geocode via
    // the cache — correct coords, negligible cost.)
    const country = (addr.country ?? '').trim();
    const DOMESTIC = new Set(['usa', 'us', 'united states']);
    const isNeutral = country.length > 0 && !DOMESTIC.has(country.toLowerCase());
    // Pro leagues have seeded home venues, so ordinary domestic games can
    // inherit the home team's geofence. NCAA teams are provider-created and do
    // not have seeded stadium coordinates, so their fixture venue must be
    // geocoded before ingest can publish the event.
    const shouldGeocodeVenue = isNeutral || collegeLeague;
    const venueAddress = [addr.city, addr.state, country].filter(Boolean).join(', ') || null;
    const geocodeQuery =
      shouldGeocodeVenue && venueName
        ? [venueName, addr.city, addr.state, country].filter(Boolean).join(', ')
        : null;

    out.push({
      external_ref: `${league}:${e.id}`,
      league,
      starts_at: startsAt,
      home_team_ref: homeRef,
      away_team_ref: awayRef,
      home_team: collegeLeague ? providerTeam(league, homeTeam) : null,
      away_team: collegeLeague ? providerTeam(league, awayTeam) : null,
      title: null, // resolveFixture derives "Away at Home" from short names
      venue_name: venueName,
      venue_address: venueAddress,
      venue_lat: null,
      venue_lng: null,
      venue_is_neutral: isNeutral,
      status: mapStatus(comp.status?.type?.name),
      _geocodeQuery: geocodeQuery,
    });
  }
  return out;
}

export function espnAdapter(geocode: GeocodeFn = geocodeVenue): EspnAdapter {
  return {
    name: 'espn',
    leagues: ESPN_LEAGUES,
    __parseScoreboard: parseScoreboard,
    async fetchFixtures(league: ProLeague, from: Date, to: Date): Promise<ProFixture[]> {
      const path = ESPN_PATH[league];
      if (!path) return []; // e.g. WWE — not served by ESPN
      const rangedUrl =
        `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard` +
        `?dates=${yyyymmdd(from)}-${yyyymmdd(to)}&limit=1000`;
      let res = await fetch(rangedUrl);
      let url = rangedUrl;
      if (!res.ok && (league === 'ncaamb' || league === 'ncaawb')) {
        // ESPN's college basketball site API returns 404 for some preseason
        // date ranges while the undated scoreboard returns the next slate.
        url = `https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?limit=1000`;
        res = await fetch(url);
      }
      if (!res.ok) throw new Error(`[espn] ${res.status} for ${league} (${url})`);
      const parsed = parseScoreboard(league, await res.json(), from, to);

      const fixtures: ProFixture[] = [];
      for (const p of parsed) {
        const { _geocodeQuery, ...fixture } = p;
        if (_geocodeQuery) {
          const coords = await geocode(_geocodeQuery);
          if (coords) {
            fixture.venue_lat = coords.lat;
            fixture.venue_lng = coords.lng;
          }
          // If geocoding fails, coords stay null. For a neutral game the home
          // stadium is the wrong place, so resolveFixture will quarantine it
          // (NO_VENUE_COORDS) rather than publish a wrong geofence.
        }
        fixtures.push(fixture);
      }
      return fixtures;
    },
  };
}
