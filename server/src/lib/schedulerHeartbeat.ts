/**
 * Scheduler heartbeat — an aggregate "did every scheduled job actually run this
 * cycle" signal, so a job that silently STOPS being scheduled is detected even
 * though no error is ever thrown (Sentry failure alerts only fire when a job
 * runs and throws — they cannot see a job that never starts). This needs no
 * paid Sentry cron-monitor seats: every monitored run stamps a per-job
 * lastRunAt into Redis, and /health/scheduler reports whether any enabled job
 * is overdue relative to its own cron cadence.
 *
 * Fail-closed: if the store is configured but unreachable, the report is NOT ok
 * (can't verify != healthy).
 *
 * @module lib/schedulerHeartbeat
 */

const HEARTBEAT_KEY = 'scheduler:heartbeat';

/** When this process started — a job with no record yet is only "overdue" once
 * the process has been up long enough that it should have run at least once. */
const PROCESS_STARTED_AT = Date.now();

export interface HeartbeatEntry {
  lastRunAt: number;
  lastStatus?: 'ok' | 'error';
}

// ── Expected interval from a 5-field cron ────────────────────────────────────
// Minimal, dependency-free cron reader: supports `*`, `*/n`, `a`, `a-b`,
// `a-b/n`, and comma lists — which covers every pattern in SCHEDULED_JOBS. We
// step minute-by-minute over a 35-day window and return the MAX gap between
// consecutive fires (the longest a healthy job can legitimately be silent).
// NOTE: day-of-month and day-of-week are AND-ed here; standard cron ORs them
// when BOTH are restricted. No current job restricts both (dow is always `*`),
// so this is exact for our set; revisit if a `dom`+`dow` cron is added.
const intervalCache = new Map<string, number>();

function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const token of field.split(',')) {
    let step = 1;
    let range = token;
    const slash = token.indexOf('/');
    if (slash !== -1) {
      step = parseInt(token.slice(slash + 1), 10) || 1;
      range = token.slice(0, slash);
    }
    let lo = min;
    let hi = max;
    if (range === '*') {
      // full range
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = parseInt(a, 10);
      hi = parseInt(b, 10);
    } else {
      lo = hi = parseInt(range, 10);
    }
    if (Number.isNaN(lo) || Number.isNaN(hi)) continue;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

/** Longest gap (ms) between consecutive fires of a 5-field cron. Infinity if
 * the expression is unparseable (treated as "cannot judge cadence"). Memoized. */
export function expectedIntervalMs(cron: string): number {
  const cached = intervalCache.get(cron);
  if (cached !== undefined) return cached;

  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) {
    intervalCache.set(cron, Infinity);
    return Infinity;
  }
  const [m, h, dom, mon, dow] = parts;
  const mins = parseField(m, 0, 59);
  const hrs = parseField(h, 0, 23);
  const doms = parseField(dom, 1, 31);
  const mons = parseField(mon, 1, 12);
  const dows = parseField(dow, 0, 6);

  const STEP = 60_000;
  const WINDOW_MINUTES = 35 * 24 * 60;
  const start = Date.UTC(2025, 0, 1, 0, 0, 0); // fixed epoch for determinism
  let last = -1;
  let maxGap = 0;
  for (let i = 0; i < WINDOW_MINUTES; i++) {
    const t = start + i * STEP;
    const d = new Date(t);
    if (
      mins.has(d.getUTCMinutes()) &&
      hrs.has(d.getUTCHours()) &&
      doms.has(d.getUTCDate()) &&
      mons.has(d.getUTCMonth() + 1) &&
      dows.has(d.getUTCDay())
    ) {
      if (last !== -1) maxGap = Math.max(maxGap, t - last);
      last = t;
    }
  }
  const result = maxGap || Infinity;
  intervalCache.set(cron, result);
  return result;
}

// ── Evaluation (pure) ────────────────────────────────────────────────────────
export interface HeartbeatJobInput {
  name: string;
  cron: string;
}
export interface JobHeartbeat {
  name: string;
  disabled: boolean;
  lastRunAt: number | null;
  ageMs: number | null;
  intervalMs: number;
  overdue: boolean;
  lastStatus?: 'ok' | 'error';
}
export interface HeartbeatReport {
  ok: boolean;
  reason?: string;
  generatedAt: string;
  total: number;
  overdueCount: number;
  stale: string[];
  jobs: JobHeartbeat[];
}

export interface EvaluateInput {
  jobs: HeartbeatJobInput[];
  now: number;
  processStartedAt: number;
  heartbeats: Record<string, HeartbeatEntry>;
  isEnabled: (name: string) => boolean;
  storeError?: boolean;
}

/** A job is overdue if it has been silent for longer than two full expected
 * cycles plus 5 minutes of slack — tolerates one skipped fire (transient), flags
 * a real stall. */
export function overdueThresholdMs(intervalMs: number): number {
  return 2 * intervalMs + 5 * 60_000;
}

export function evaluateSchedulerHeartbeat(input: EvaluateInput): HeartbeatReport {
  const { jobs, now, processStartedAt, heartbeats, isEnabled, storeError } = input;
  const uptime = now - processStartedAt;

  const jobResults: JobHeartbeat[] = jobs.map(job => {
    const disabled = !isEnabled(job.name);
    const intervalMs = expectedIntervalMs(job.cron);
    const entry = heartbeats[job.name];
    const lastRunAt = entry?.lastRunAt ?? null;
    const ageMs = lastRunAt === null ? null : now - lastRunAt;

    let overdue = false;
    if (!disabled && Number.isFinite(intervalMs)) {
      const threshold = overdueThresholdMs(intervalMs);
      if (lastRunAt === null) {
        // Never recorded — only overdue once the process has been up long
        // enough that a healthy job would already have fired.
        overdue = uptime > threshold;
      } else {
        overdue = (ageMs as number) > threshold;
      }
    }
    return {
      name: job.name,
      disabled,
      lastRunAt,
      ageMs,
      intervalMs,
      overdue,
      lastStatus: entry?.lastStatus,
    };
  });

  const stale = jobResults.filter(r => r.overdue).map(r => r.name);
  const ok = !storeError && stale.length === 0;
  return {
    ok,
    reason: storeError
      ? 'heartbeat store unreachable'
      : stale.length
        ? `overdue: ${stale.join(', ')}`
        : undefined,
    generatedAt: new Date(now).toISOString(),
    total: jobs.length,
    overdueCount: stale.length,
    stale,
    jobs: jobResults,
  };
}

// ── Store (Redis-first, in-memory fallback) ──────────────────────────────────
// Redis so any replica's /health can read what a job wrote on another replica
// (the worker runs on all replicas under numReplicas>1). Mirrors the lazy
// getRedisForDedup pattern in scheduler.ts.
const memory = new Map<string, HeartbeatEntry>();
let _redis: any = null;
// Shutdown-race guard: once closeHeartbeatStore() starts, getRedis() must never
// open a NEW connection — otherwise a fire-and-forget recordHeartbeat() landing
// during drain would reopen a connection nothing closes, reintroducing the very
// process-hang the graceful-shutdown fix removed. In-flight writes are tracked
// so close() can let them settle before quitting.
let _closing = false;
const _pendingWrites = new Set<Promise<void>>();

async function getRedis(): Promise<any | null> {
  if (_closing) return null;
  if (_redis) return _redis;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    const { default: Redis } = await import('ioredis');
    const RedisCtor = Redis as unknown as new (u: string, o?: any) => any;
    _redis = new RedisCtor(url, { maxRetriesPerRequest: 1, lazyConnect: true });
    await _redis.connect();
    return _redis;
  } catch {
    _redis = null;
    return null;
  }
}

/** Best-effort: records that a job ran. Never throws — a heartbeat-write
 * failure must never fail the job. */
export async function recordHeartbeat(name: string, status: 'ok' | 'error'): Promise<void> {
  const entry: HeartbeatEntry = { lastRunAt: Date.now(), lastStatus: status };
  memory.set(name, entry);
  const write = (async () => {
    try {
      const redis = await getRedis();
      if (redis) await redis.hset(HEARTBEAT_KEY, name, JSON.stringify(entry));
    } catch {
      // best-effort; the in-memory copy is already updated
    }
  })();
  // Track so closeHeartbeatStore() can drain in-flight writes before quitting.
  _pendingWrites.add(write);
  void write.finally(() => _pendingWrites.delete(write));
  await write;
}

/** Reads all heartbeats. `storeError` is true when Redis IS configured but
 * unreachable, so the caller can fail closed. With no REDIS_URL the in-memory
 * map is authoritative (single-process dev) and is not an error. */
export async function readHeartbeats(): Promise<{
  data: Record<string, HeartbeatEntry>;
  storeError: boolean;
}> {
  if (!process.env.REDIS_URL) {
    return { data: Object.fromEntries(memory), storeError: false };
  }
  try {
    const redis = await getRedis();
    if (!redis) return { data: Object.fromEntries(memory), storeError: true };
    const raw: Record<string, string> = await redis.hgetall(HEARTBEAT_KEY);
    const data: Record<string, HeartbeatEntry> = {};
    for (const [k, v] of Object.entries(raw || {})) {
      try {
        data[k] = JSON.parse(v) as HeartbeatEntry;
      } catch {
        // skip a corrupt entry rather than failing the whole read
      }
    }
    return { data, storeError: false };
  } catch {
    return { data: Object.fromEntries(memory), storeError: true };
  }
}

/** Close the heartbeat Redis connection on shutdown (called from the scheduler
 * drain so it can't keep the process alive). */
export async function closeHeartbeatStore(): Promise<void> {
  // Block any further reconnects first, then let in-flight writes settle so the
  // last heartbeat lands and no write races the quit.
  _closing = true;
  if (_pendingWrites.size) await Promise.allSettled([..._pendingWrites]);
  if (_redis) {
    try {
      await _redis.quit();
    } catch {
      _redis.disconnect?.();
    }
    _redis = null;
  }
}

/** Compose the live report over the real SCHEDULED_JOBS. Imports scheduler.ts
 * lazily to avoid a module load cycle (scheduler -> schedulerMonitoring ->
 * schedulerHeartbeat). */
export async function getSchedulerHeartbeatReport(): Promise<HeartbeatReport> {
  const [{ SCHEDULED_JOBS }, { schedulerMonitorEnabled }] = await Promise.all([
    import('../jobs/scheduler.js'),
    import('./schedulerMonitoring.js'),
  ]);
  const { data, storeError } = await readHeartbeats();
  return evaluateSchedulerHeartbeat({
    jobs: SCHEDULED_JOBS.map(j => ({ name: j.name, cron: j.cron })),
    now: Date.now(),
    processStartedAt: PROCESS_STARTED_AT,
    heartbeats: data,
    isEnabled: schedulerMonitorEnabled,
    storeError,
  });
}
