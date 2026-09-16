/**
 * Event-page post grid — the "scrapbook" layout plan.
 *
 * The event page's post PREVIEW (not the feed — the feed is deliberately
 * single-column hero cards, see app/feed.tsx) mixes 2-across and 3-across rows
 * so it reads like a scrapbook page rather than a uniform 2-up grid. Landscape
 * posts take a wider cell in their row to complement that rhythm.
 *
 * This module is the whole layout decision: posts + seed in, row plan out. The
 * renderer is dumb — it draws what the plan says. Same shape as
 * `buildProgramDisplayPlan` in constants/programs.ts.
 */

/** The preview shows at most this many posts; the rest live behind "View All Posts". */
export const EVENT_POST_PREVIEW_CAP = 12;

/**
 * width/height at or above this reads as "horizontal" and earns a wider cell.
 * 1.2 (not 1.0) so near-square posts stay square instead of drifting wide.
 */
const LANDSCAPE_ASPECT_MIN = 1.2;

/** A landscape cell claims this many portrait cells' worth of its row. */
const LANDSCAPE_WEIGHT = 1.5;
const DEFAULT_WEIGHT = 1;

/**
 * Row-size rotations. Every rotation is a mix of 2s and 3s — the seed picks
 * which one, so different events (and different days) open on a different
 * rhythm without any of them degrading into a uniform grid.
 */
const ROW_PATTERNS: number[][] = [
  [2, 3, 3, 2],
  [3, 2, 2, 3],
  [2, 2, 3, 3],
  [3, 3, 2, 2],
];

/** Row height by column count. Fewer columns => taller cells. */
const ROW_HEIGHTS: Record<number, number> = {
  1: 260,
  2: 240,
  3: 170,
};

export type ScrapbookInput = {
  id: string;
  /** Pixel dimensions when known. Most posts have neither — see mediaAspect(). */
  media_width?: number | null;
  media_height?: number | null;
};

export type ScrapbookCell<T> = {
  post: T;
  /** Fraction of the row's width, 0..1. Cells in a row always sum to 1. */
  widthRatio: number;
  isLandscape: boolean;
};

export type ScrapbookRow<T> = {
  cells: ScrapbookCell<T>[];
  height: number;
};

export type ScrapbookPlan<T> = {
  rows: ScrapbookRow<T>[];
  /** How many posts the plan actually placed (<= cap). */
  shownCount: number;
  /** True when posts were held back — i.e. "View All Posts" reveals more. */
  hasMore: boolean;
};

/**
 * FNV-1a + murmur3 finalizer. Same idea as getDeterministicGameCardGradient in
 * utils/feedGameCard.ts — a stable seed gives a stable pick, and there is no
 * Math.random anywhere in this module — but with real avalanche.
 *
 * The plain `hash * 31 + c` variant is NOT good enough here. It only avalanches
 * in the low bits, so for sequential ids ("p0", "p1", "p2", …) the high bits
 * stay ordered and sorting by the hash hands back the ORIGINAL order — i.e. no
 * shuffle at all. feedGameCard.ts gets away with it because it only takes `% 2`;
 * we sort on the full value, so it needs to mix properly.
 */
function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // murmur3 fmix32 — spreads the entropy across all 32 bits.
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/**
 * Seed for a given event + day. Stable for the whole day, so the grid never
 * reshuffles under the user's thumb (scroll, refetch, or coming back from
 * post-detail all rebuild the same plan), but a visit tomorrow gets a fresh
 * arrangement. `now` is injectable so tests don't depend on the wall clock.
 */
export function eventScrapbookSeed(eventId: string | number | null | undefined, now = new Date()) {
  const day = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  return `${String(eventId ?? 'event')}:${day}`;
}

function mediaAspect(post: ScrapbookInput): number | null {
  const w = post.media_width;
  const h = post.media_height;
  // Most rows carry neither (they predate the columns, or the provider didn't
  // report them). Unknown aspect is NOT landscape — phone clips are portrait by
  // default, so guessing wide would be wrong far more often than right.
  if (typeof w !== 'number' || typeof h !== 'number') return null;
  if (!(w > 0) || !(h > 0)) return null;
  return w / h;
}

export function isLandscapePost(post: ScrapbookInput): boolean {
  const aspect = mediaAspect(post);
  return aspect !== null && aspect >= LANDSCAPE_ASPECT_MIN;
}

/**
 * Order posts by hash(seed + post id) rather than shuffling the array.
 *
 * This is the important property: a post's position depends only on its own id
 * and the seed, so a new post arriving (or one being deleted) slots into place
 * without reordering everything else. A plain seeded array shuffle would
 * rearrange the entire grid every time the query refetched.
 */
function stableShuffle<T extends ScrapbookInput>(posts: T[], seed: string): T[] {
  return (
    [...posts]
      .map(post => ({ post, key: hashSeed(`${seed}|${post.id}`) }))
      // Tie-break on id so equal hashes still produce a total, stable order.
      .sort((a, b) => a.key - b.key || String(a.post.id).localeCompare(String(b.post.id)))
      .map(entry => entry.post)
  );
}

/**
 * Build the event-page preview grid: shuffle stably, cap at 12, then lay the
 * survivors into a mix of 2-across and 3-across rows with landscape posts
 * taking the wider share of their row.
 */
export function buildEventScrapbookPlan<T extends ScrapbookInput>(
  posts: T[],
  seed: string,
  options: { cap?: number } = {}
): ScrapbookPlan<T> {
  const cap = options.cap ?? EVENT_POST_PREVIEW_CAP;
  const all = Array.isArray(posts) ? posts.filter(Boolean) : [];
  if (all.length === 0 || cap <= 0) {
    return { rows: [], shownCount: 0, hasMore: all.length > 0 };
  }

  const ordered = stableShuffle(all, seed).slice(0, cap);
  const pattern = ROW_PATTERNS[hashSeed(seed) % ROW_PATTERNS.length];

  const rows: ScrapbookRow<T>[] = [];
  let cursor = 0;
  let rowIndex = 0;

  while (cursor < ordered.length) {
    const remaining = ordered.length - cursor;
    // A trailing 1 is fine (it renders as a full-width end cap) but a trailing
    // row should never be *emptier* than it needs to be.
    const size = Math.min(pattern[rowIndex % pattern.length], remaining);
    const slice = ordered.slice(cursor, cursor + size);

    const weights = slice.map(post => (isLandscapePost(post) ? LANDSCAPE_WEIGHT : DEFAULT_WEIGHT));
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);

    rows.push({
      cells: slice.map((post, i) => ({
        post,
        widthRatio: weights[i] / totalWeight,
        isLandscape: weights[i] === LANDSCAPE_WEIGHT,
      })),
      height: ROW_HEIGHTS[size] ?? ROW_HEIGHTS[2],
    });

    cursor += size;
    rowIndex += 1;
  }

  return {
    rows,
    shownCount: ordered.length,
    hasMore: all.length > ordered.length,
  };
}

/**
 * Stale-while-revalidate merge for a game-less event page's view-model on a
 * SOFT refresh (focus regain, pull-to-refresh, or a realtime socket event).
 *
 * The event loader rebuilds a fresh view-model with `posts: []` / `media: []`
 * every time it runs, because those arrive via deferred fetches that resolve
 * after the initial render. Applying that fresh payload verbatim on a refresh
 * blanks the Posts grid back to "Loading…" until the re-fetch lands — the
 * user-reported flicker (posts "going away then coming back"). When the refresh
 * is for the SAME event, keep whatever posts/media are already on screen so the
 * grid never empties; the deferred fetches then update the arrays in place.
 *
 * A genuinely new event (prev is null, or a different event/game) starts clean.
 */
export function mergeEventVmRefresh<
  T extends {
    eventId: string | null;
    gameId: string | null;
    posts?: unknown[];
    media?: unknown[];
  },
>(prev: T | null | undefined, next: T): T {
  const sameEvent = !!prev && !prev.gameId && prev.eventId === next.eventId;
  if (!sameEvent) return next;
  return {
    ...next,
    posts: Array.isArray(prev.posts) && prev.posts.length ? prev.posts : next.posts,
    media: Array.isArray(prev.media) && prev.media.length ? prev.media : next.media,
  };
}
