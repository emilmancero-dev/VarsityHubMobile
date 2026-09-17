// A no-photo card/banner shows a RANDOM COLOR gradient with the sport emoji
// centered (owner rule). These must read as an actual, vibrant gradient — the
// old pair was two near-identical dark navies, so it looked like a flat box.
// Mid-tone, distinct-hue pairs keep the white shade overlay + emoji legible.
const GAME_CARD_GRADIENTS: [string, string][] = [
  ['#4F46E5', '#9333EA'], // indigo → purple
  ['#2563EB', '#06B6D4'], // blue → cyan
  ['#0D9488', '#22C55E'], // teal → green
  ['#F97316', '#E11D48'], // orange → rose
  ['#C026D3', '#7C3AED'], // fuchsia → violet
  ['#0EA5E9', '#4F46E5'], // sky → indigo
  ['#F43F5E', '#FB923C'], // rose → amber
  ['#059669', '#0EA5E9'], // emerald → sky
];

function hashSeed(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function getDeterministicGameCardGradient(
  gameId: string | number | null | undefined,
  title?: string | null
): [string, string] {
  const seed = String(gameId ?? title ?? 'varsityhub-game-card');
  return GAME_CARD_GRADIENTS[hashSeed(seed) % GAME_CARD_GRADIENTS.length];
}

/** Accepts `#RGB` / `#RRGGBB`, returns a normalized `#RRGGBB` or null. */
function normalizeHex(color?: string | null): string | null {
  if (!color) return null;
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(color.trim());
  if (!m) return null;
  let hex = m[1];
  if (hex.length === 3)
    hex = hex
      .split('')
      .map(c => c + c)
      .join('');
  return `#${hex.toLowerCase()}`;
}

/** Darken a hex color by `amount` (0–1) — used to pair a lone team color. */
function darken(hex: string, amount = 0.45): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 0xff) * (1 - amount));
  const g = Math.round(((n >> 8) & 0xff) * (1 - amount));
  const b = Math.round((n & 0xff) * (1 - amount));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

/**
 * Branded gradient for a pro game from its two teams' accent colors, so a
 * banner-less pro card reads as intentional instead of an empty dark box. Falls
 * back to null (→ deterministic gradient) when neither color is a valid hex.
 * Pro teams carry no logos (trademark), so color is the only brand signal.
 */
export function proGameCardGradient(
  homeColor?: string | null,
  awayColor?: string | null
): [string, string] | null {
  const a = normalizeHex(awayColor);
  const b = normalizeHex(homeColor);
  if (a && b) return [a, b];
  if (b) return [darken(b), b];
  if (a) return [a, darken(a)];
  return null;
}
