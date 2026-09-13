import type { ProLeague } from '@prisma/client';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { compositeAdapter } from './compositeAdapter.js';
import { espnAdapter } from './espnAdapter.js';
import { seatGeekAdapter } from './seatGeekAdapter.js';
import type { ProFixture, ProScheduleAdapter } from './types.js';
import { PRO_SCHEDULE_LEAGUES } from './types.js';
import { wweAdapter } from './wweAdapter.js';

/**
 * Schedule provider adapters.
 *
 * Schedule facts are normalized at the provider boundary. ESPN remains the
 * source for the major leagues, while SeatGeek is used for NCAA, minor-league,
 * and other sporting events. Provider coverage is bounded by what each
 * upstream actually publishes; ingestion never invents missing fixtures.
 *
 * IMPORTANT when adding one: schedule facts themselves are not owned by the
 * leagues (Feist; NBA v. Motorola), but the provider's terms of service are a
 * real contract. Read them before shipping, and never substitute scraping a
 * league or broadcaster site — that is the one path here with actual legal
 * exposure.
 */

const fixtureSchema = z.object({
  external_ref: z.string().min(1).max(200),
  league: z.enum(PRO_SCHEDULE_LEAGUES),
  starts_at: z.coerce.date(),
  home_team_ref: z.string().nullable().default(null),
  away_team_ref: z.string().nullable().default(null),
  title: z.string().nullable().optional(),
  venue_name: z.string().nullable().optional(),
  venue_address: z.string().nullable().optional(),
  venue_lat: z.number().nullable().optional(),
  venue_lng: z.number().nullable().optional(),
  timezone: z.string().nullable().optional(),
  status: z.enum(['scheduled', 'postponed', 'cancelled']).default('scheduled'),
});

/**
 * Reads fixtures from a local JSON file already in normalized form.
 *
 * This is not a stopgap — it is how you load a provider's bulk season export,
 * how you stage a single league for a launch test, and how the ingester gets
 * exercised end to end without a live key. The file is validated, so a
 * malformed export fails at the boundary with a useful message rather than
 * halfway through a write loop.
 */
export function jsonFileAdapter(path: string): ProScheduleAdapter {
  return {
    name: `json:${path}`,
    leagues: PRO_SCHEDULE_LEAGUES,
    async fetchFixtures(league: ProLeague, from: Date, to: Date): Promise<ProFixture[]> {
      const raw = await readFile(path, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error(`[proSchedule] ${path} must contain a JSON array of fixtures`);
      }

      const fixtures: ProFixture[] = [];
      parsed.forEach((entry, i) => {
        const result = fixtureSchema.safeParse(entry);
        if (!result.success) {
          throw new Error(
            `[proSchedule] ${path}[${i}] is not a valid fixture: ${result.error.issues
              .map(iss => `${iss.path.join('.')} ${iss.message}`)
              .join('; ')}`
          );
        }
        const f = result.data;
        if (f.league !== league) return;
        if (f.starts_at < from || f.starts_at > to) return;
        fixtures.push(f as ProFixture);
      });

      return fixtures;
    },
  };
}

/**
 * Resolves the configured adapter, or null when none is configured.
 *
 * Returning null for no provider is deliberate. A selected provider without its
 * required credentials is different: that is a deployment error and must fail
 * loudly instead of silently dropping NCAA/minor schedules.
 */
export function resolveConfiguredAdapter(env = process.env): ProScheduleAdapter | null {
  const file = env.PRO_SCHEDULE_JSON_PATH;
  if (file) return jsonFileAdapter(file);

  // Live rolling sources are composed so each league has one owner. SeatGeek
  // supplies the NCAA and minor-league feeds that ESPN does not expose here.
  if (env.PRO_SCHEDULE_PROVIDER === 'espn') {
    return compositeAdapter([espnAdapter(), wweAdapter()]);
  }
  if (env.PRO_SCHEDULE_PROVIDER === 'seatgeek') {
    if (!env.SEATGEEK_CLIENT_ID) {
      throw new Error('[proSchedule] PRO_SCHEDULE_PROVIDER=seatgeek requires SEATGEEK_CLIENT_ID');
    }
    return seatGeekAdapter(env.SEATGEEK_CLIENT_ID);
  }
  if (env.PRO_SCHEDULE_PROVIDER === 'combined') {
    if (!env.SEATGEEK_CLIENT_ID) {
      throw new Error('[proSchedule] PRO_SCHEDULE_PROVIDER=combined requires SEATGEEK_CLIENT_ID');
    }
    return compositeAdapter([espnAdapter(), wweAdapter(), seatGeekAdapter(env.SEATGEEK_CLIENT_ID)]);
  }

  return null;
}

export const NO_ADAPTER_MESSAGE =
  '[proSchedule] no schedule provider configured — set PRO_SCHEDULE_JSON_PATH, or set ' +
  'PRO_SCHEDULE_PROVIDER=combined with SEATGEEK_CLIENT_ID. Skipping ingest.';
