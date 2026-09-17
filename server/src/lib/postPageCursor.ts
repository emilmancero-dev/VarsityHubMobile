type PageKind = 'p1' | 'c1';
export type PostPageAnchor = { id: string; created_at: Date; is_pinned: boolean | null };

// These are ordering boundaries, never authorization: callers retain their
// complete visibility/scoping predicates when applying the returned clause.
export function encodePostPageCursor(
  kind: PageKind,
  row: { id: string; created_at: Date; is_pinned?: boolean },
  pinned = false
): string {
  return `${kind}:${Buffer.from(JSON.stringify([row.created_at.toISOString(), row.id, pinned ? row.is_pinned === true : null])).toString('base64url')}`;
}

export function decodePostPageCursor(
  cursor: string | null,
  kind: PageKind,
  pinned = false
): PostPageAnchor | null {
  if (!cursor || !/^[pc]1:/.test(cursor)) return null; // legacy ID cursor
  if (!cursor.startsWith(`${kind}:`) || cursor.length > 1024)
    throw new Error('Invalid pagination cursor');
  let parts: unknown;
  try {
    parts = JSON.parse(Buffer.from(cursor.slice(3), 'base64url').toString('utf8'));
  } catch {
    throw new Error('Invalid pagination cursor');
  }
  if (!Array.isArray(parts) || parts.length !== 3) throw new Error('Invalid pagination cursor');
  const [timestamp, id, pin] = parts;
  const date = new Date(timestamp);
  if (
    typeof timestamp !== 'string' ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString() !== timestamp ||
    typeof id !== 'string' ||
    !id.length ||
    id.length > 128 ||
    (pinned ? typeof pin !== 'boolean' : pin !== null)
  ) {
    throw new Error('Invalid pagination cursor');
  }
  return { id, created_at: date, is_pinned: pin };
}

export function postPageBoundary(anchor: PostPageAnchor): object {
  const older = {
    OR: [
      { created_at: { lt: anchor.created_at } },
      { created_at: anchor.created_at, id: { lt: anchor.id } },
    ],
  };
  if (anchor.is_pinned === null) return older;
  const samePin = { is_pinned: anchor.is_pinned, ...older };
  return anchor.is_pinned ? { OR: [{ is_pinned: false }, samePin] } : samePin;
}
