const NORMALIZED_PLACEHOLDERS = new Set([
  'no description',
  'no description provided',
  'no team description provided',
  'team description',
  'team overview',
  'about this team',
  'official team page',
]);

function normalize(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[.!?,:;'"`]+/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * Remove promotional links from an ingested event/game description before it is
 * shown to users. Pro/NCAA fixtures arrive with a trailing "Official fixture:
 * <url>" credit (and occasionally a bare URL); owners asked that the raw link
 * not render on the event page (Sep 2026). Strips any bare URLs and the now-empty
 * "Official fixture:" label, then collapses the whitespace left behind.
 * Returns null when nothing meaningful remains.
 */
export function stripLinksFromDescription(value?: string | null): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    // Remove bare URLs first (http/https).
    .replace(/https?:\/\/\S+/gi, '')
    // Remove a now-empty "Official fixture:" credit label left behind.
    .replace(/\bofficial fixture:\s*/gi, '')
    // Collapse the whitespace / stray punctuation the removals leave behind.
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\s+([.!?,;:])/g, '$1')
    .trim();
  return cleaned.length ? cleaned : null;
}

export function sanitizePublicDescription(value?: string | null): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const normalized = normalize(trimmed);
  if (NORMALIZED_PLACEHOLDERS.has(normalized)) return null;

  if (
    normalized.startsWith('welcome to the official team page') ||
    normalized.startsWith('this is the official team page')
  ) {
    return null;
  }

  return trimmed;
}
