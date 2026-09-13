import type { ProLeague } from '@prisma/client';
import { runWithBreaker } from '../circuitBreaker.js';
import type { ProFixture, ProScheduleAdapter } from './types.js';

type SeatGeekLeague = 'ncaa' | 'minor' | 'other';

type SeatGeekEvent = {
  id?: number | string;
  type?: string;
  datetime_utc?: string;
  title?: string;
  venue?: {
    name?: string;
    address?: string;
    city?: string;
    state?: string;
    country?: string;
    location?: { lat?: number; lon?: number };
  };
};

type SeatGeekResponse = {
  events?: SeatGeekEvent[];
  meta?: { page?: number; per_page?: number; total?: number; total_pages?: number };
};

const DEFAULT_QUERIES: Record<SeatGeekLeague, readonly string[]> = {
  // SeatGeek has no NCAA division filter. These sport-specific queries are
  // intentionally broad so D1, D2, and D3 events are not reduced to football
  // and basketball only.
  ncaa: [
    'NCAA',
    'college football',
    'college basketball',
    'college baseball',
    'college softball',
    'college soccer',
    'college hockey',
    'college volleyball',
    'college lacrosse',
    'college wrestling',
    'college gymnastics',
    'college tennis',
    'college golf',
    'college track',
    'college swimming',
    'college field hockey',
    'college rowing',
    'college fencing',
    'college water polo',
    'college skiing',
    'college bowling',
    'college beach volleyball',
    'college cross country',
  ],
  minor: [
    'minor league',
    'MiLB',
    'Triple-A',
    'Double-A',
    'High-A',
    'Single-A',
    'Rookie League',
    'NBA G League',
    'AHL',
    'ECHL',
    'SPHL',
    'USL Championship',
    'USL League One',
    'MLS NEXT Pro',
  ],
  other: ['sports'],
};

function configuredQueries(league: SeatGeekLeague): readonly string[] {
  const envKey = `SEATGEEK_${league.toUpperCase()}_QUERIES`;
  const configured = process.env[envKey]
    ?.split(',')
    .map(query => query.trim())
    .filter(Boolean);
  if (configured?.length) return configured;
  const legacy = process.env[`SEATGEEK_${league.toUpperCase()}_QUERY`]?.trim();
  return legacy ? [legacy] : DEFAULT_QUERIES[league];
}

function maxPages(): number {
  const parsed = Number.parseInt(process.env.SEATGEEK_MAX_PAGES ?? '100', 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 100) : 100;
}

function venueAddress(venue: SeatGeekEvent['venue']): string | null {
  if (!venue) return null;
  return [venue.address, venue.city, venue.state, venue.country].filter(Boolean).join(', ') || null;
}

function isSportsEvent(event: SeatGeekEvent, league: SeatGeekLeague): boolean {
  return event.type ? event.type.toLowerCase() === 'sports' : league !== 'other';
}

export function parseSeatGeekEvents(
  league: SeatGeekLeague,
  raw: unknown,
  from: Date,
  to: Date
): ProFixture[] {
  const events = (raw as SeatGeekResponse | null)?.events;
  if (!Array.isArray(events)) return [];

  return events.flatMap(event => {
    const startsAt = new Date(event.datetime_utc ?? '');
    const lat = event.venue?.location?.lat;
    const lng = event.venue?.location?.lon;
    if (
      !event.id ||
      !event.title?.trim() ||
      !isSportsEvent(event, league) ||
      Number.isNaN(startsAt.getTime()) ||
      startsAt < from ||
      startsAt > to ||
      typeof lat !== 'number' ||
      typeof lng !== 'number' ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      return [];
    }

    return [
      {
        external_ref: `seatgeek:${league}:${event.id}`,
        league,
        starts_at: startsAt,
        home_team_ref: null,
        away_team_ref: null,
        title: event.title.trim(),
        venue_name: event.venue?.name ?? null,
        venue_address: venueAddress(event.venue),
        venue_lat: lat,
        venue_lng: lng,
        venue_is_neutral: true,
        status: 'scheduled' as const,
      },
    ];
  });
}

async function fetchPage(
  clientId: string,
  league: SeatGeekLeague,
  query: string,
  from: Date,
  to: Date,
  page: number
): Promise<SeatGeekResponse> {
  const url = new URL('https://api.seatgeek.com/2/events');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('q', query);
  url.searchParams.set('datetime_utc.gte', from.toISOString());
  url.searchParams.set('datetime_utc.lte', to.toISOString());
  url.searchParams.set('per_page', '100');
  url.searchParams.set('page', String(page));

  const response = await runWithBreaker('seatgeek-schedule', () => fetch(url), {
    timeout: 10000,
  });
  if (!response.ok) {
    throw new Error(`[seatgeek] ${response.status} for ${league}/${query}/page-${page}`);
  }
  return (await response.json()) as SeatGeekResponse;
}

async function fetchLeague(
  clientId: string,
  league: SeatGeekLeague,
  from: Date,
  to: Date
): Promise<ProFixture[]> {
  const byId = new Map<string, ProFixture>();
  const requestBudget = Math.min(
    Math.max(Number.parseInt(process.env.SEATGEEK_MAX_REQUESTS_PER_LEAGUE ?? '100', 10), 1),
    500
  );
  let requestCount = 0;
  let budgetExhausted = false;
  for (const query of configuredQueries(league)) {
    const pageLimit = maxPages();
    for (let page = 1; page <= pageLimit; page += 1) {
      if (requestCount >= requestBudget) {
        budgetExhausted = true;
        break;
      }
      requestCount += 1;
      const response = await fetchPage(clientId, league, query, from, to, page);
      for (const fixture of parseSeatGeekEvents(league, response, from, to)) {
        byId.set(fixture.external_ref, fixture);
      }

      const totalPages =
        response.meta?.total_pages ??
        (response.meta?.total && response.meta?.per_page
          ? Math.ceil(response.meta.total / response.meta.per_page)
          : null);
      if (!response.events?.length || (totalPages !== null && page >= totalPages)) break;
      if (page === pageLimit) {
        console.warn(
          `[seatgeek] page cap reached for ${league}/${query}; increase ` +
            'SEATGEEK_MAX_PAGES if the coverage report shows truncation'
        );
      }
    }
    if (budgetExhausted) break;
  }
  if (budgetExhausted) {
    console.warn(
      `[seatgeek] request budget reached for ${league} after ${requestCount} requests; ` +
        'results are partial. Increase SEATGEEK_MAX_REQUESTS_PER_LEAGUE only after reviewing rate limits.'
    );
  }
  console.log(
    `[seatgeek] ${league}: requests=${requestCount}, unique_events=${byId.size}, ` +
      `partial=${budgetExhausted}`
  );
  return [...byId.values()];
}

export function seatGeekAdapter(clientId: string): ProScheduleAdapter {
  return {
    name: 'seatgeek',
    leagues: ['ncaa', 'minor', 'other'],
    async fetchFixtures(league: ProLeague, from: Date, to: Date): Promise<ProFixture[]> {
      if (league !== 'ncaa' && league !== 'minor' && league !== 'other') return [];
      return fetchLeague(clientId, league, from, to);
    },
  };
}
