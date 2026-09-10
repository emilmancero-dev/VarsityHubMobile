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
