/** Persist only public upload results and the exact pending request; never credentials. */
export type PostRecovery = {
  ownerId: string;
  sourceUri?: string;
  upload?: { url: string; posterUrl?: string; meta?: Record<string, number> };
  pendingPayload?: Record<string, any>;
};
export function recoveryForOwner(
  value: PostRecovery | null,
  ownerId?: string
): PostRecovery | null {
  return ownerId && value?.ownerId === ownerId ? value : null;
}
export function reusableUpload(value: PostRecovery | null, ownerId: string, sourceUri: string) {
  const owned = recoveryForOwner(value, ownerId);
  return owned?.sourceUri === sourceUri && owned.upload?.url ? owned.upload : null;
}
export function newPostRequestId(): string {
  // Uniqueness token, never an authorization credential. Works in native and web runtimes.
  return `${Date.now().toString(36)}-${Array.from({ length: 4 }, () => Math.random().toString(36).slice(2)).join('')}`;
}

/** Release only a fresh request's explicit editable rejection. An existing or
 * restored pending key may already have committed, even if a later retry is
 * rejected before the server's replay lookup. Never replace that unknown key. */
export function recoveryAfterPostRejection(
  recovery: PostRecovery | null,
  error: unknown,
  firstDispatch: boolean
): PostRecovery | null {
  if (!firstDispatch || !recovery?.pendingPayload || !error || typeof error !== 'object')
    return null;
  const rejected = error as { status?: unknown; data?: any; isProtocolError?: unknown };
  if (rejected.isProtocolError || !rejected.data || typeof rejected.data !== 'object') return null;
  const { status, data } = rejected;
  const editable =
    (status === 400 && data.error === 'Invalid payload' && Array.isArray(data.issues)) ||
    (status === 404 && data.error === 'Team not found') ||
    (status === 403 &&
      [
        'EVENT_NOT_FOUND',
        'EXCLUSIVE_POSTER_ONLY',
        'POSTING_WINDOW_CLOSED',
        'NO_EVENT_LOCATION',
        'LOCATION_REQUIRED',
        'TOO_FAR_FROM_VENUE',
        'LOCATION_VERIFICATION_FAILED',
        'Only team staff or organization admins can post to their team page',
      ].includes(data.error));
  // MEDIA_NOT_READY remains unresolved: the lower upload checkpoint may still
  // return the rejected URL. Rotating only this request would not repair it.
  if (!editable) return null;
  const { pendingPayload: _rejectedPayload, ...retained } = recovery;
  return retained;
}

/** A fulfilled request alone cannot confirm that a post was created. Keep the
 * exact pending request until a create/replay response identifies the post. */
export function assertCreatedPost(response: unknown): asserts response is { id: string } {
  if (
    !response ||
    typeof response !== 'object' ||
    Array.isArray(response) ||
    !('id' in response) ||
    typeof response.id !== 'string' ||
    !response.id.trim()
  ) {
    throw new Error(
      'Could not confirm your post. Your draft is saved. Please retry to confirm it.'
    );
  }
}
