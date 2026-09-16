import { z } from 'zod';
import { ValidationError } from './errors/ValidationError.js';

type Row = { id: string; created_at: Date; is_pinned?: boolean };
const cursorSchema = z.object({
  id: z.string().min(1).max(200),
  at: z.string().datetime(),
  pin: z.boolean().optional(),
});
const invalidCursor = () =>
  new ValidationError('Invalid or expired page cursor. Refresh the list.', {
    errorCode: 'INVALID_CURSOR',
  });

/** Last delivered (or scanned) position, independent of whether that row still exists. */
export function encodePostPageCursor(row: Row, pinned = false): string {
  return `p2:${Buffer.from(
    JSON.stringify({
      id: row.id,
      at: row.created_at.toISOString(),
      ...(pinned ? { pin: row.is_pinned } : {}),
    })
  ).toString('base64url')}`;
}

/** Only narrows a query; callers must retain their full authorization WHERE clause. */
export async function postPageBoundary(
  cursor: string | null,
  loadLegacy: (id: string) => Promise<Row | null>,
  pinned = false
): Promise<Record<string, unknown>> {
  if (!cursor) return {};
  let row: Row;
  let inclusive = false;
  if (cursor.startsWith('p2:')) {
    if (cursor.length > 1024) throw invalidCursor();
    let decoded;
    try {
      decoded = cursorSchema.safeParse(
        JSON.parse(Buffer.from(cursor.slice(3), 'base64url').toString())
      );
    } catch {
      throw invalidCursor();
    }
    if (!decoded.success || pinned !== (decoded.data.pin !== undefined)) throw invalidCursor();
    row = {
      id: decoded.data.id,
      created_at: new Date(decoded.data.at),
      is_pinned: decoded.data.pin,
    };
  } else {
    // Older servers issued the first UNSEEN ID, so compatibility is inclusive.
    // If that legacy row was deleted, no timestamp is recoverable: ask for refresh.
    if (cursor.length > 200) throw invalidCursor();
    const legacy = await loadLegacy(cursor);
    if (!legacy) throw invalidCursor();
    row = legacy;
    inclusive = true;
  }
  const chronological = {
    OR: [
      { created_at: { lt: row.created_at } },
      { created_at: row.created_at, id: { [inclusive ? 'lte' : 'lt']: row.id } },
    ],
  };
  if (!pinned) return chronological;
  return {
    OR: [
      ...(row.is_pinned ? [{ is_pinned: false }] : []),
      { is_pinned: !!row.is_pinned, ...chronological },
    ],
  };
}
