import type { ProLeague } from '@prisma/client';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { espnAdapter } from './espnAdapter.js';
import type { ProFixture, ProScheduleAdapter } from './types.js';
import { PRO_SCHEDULE_LEAGUES } from './types.js';

/**
 * Schedule provider adapters.
 *
 * ESPN is the configured live source. The owner permits ESPN or Yahoo only;
 * do not silently add a third-party fallback under the ESPN setting.
 * JSON files remain the explicit normalized bulk-import/testing interface.
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
 * Returning null rather than throwing is deliberate: the ingest job runs on a
 * schedule, and an unconfigured provider is an expected state (the feature ships
 * dark until a provider is licensed). It must log and no-op, not crash the boot.
 */
export function resolveConfiguredAdapter(env = process.env): ProScheduleAdapter | null {
  const file = env.PRO_SCHEDULE_JSON_PATH;
  if (file) return jsonFileAdapter(file);

  // Only verified ESPN leagues are advertised. Missing leagues remain
  // unsupported until an approved source is actually connected.
  if (env.PRO_SCHEDULE_PROVIDER === 'espn') {
    return espnAdapter();
  }

  return null;
}

export const NO_ADAPTER_MESSAGE =
  '[proSchedule] no schedule provider configured — set PRO_SCHEDULE_JSON_PATH for a bulk ' +
  'export, or wire a licensed provider in resolveConfiguredAdapter(). Skipping ingest.';
