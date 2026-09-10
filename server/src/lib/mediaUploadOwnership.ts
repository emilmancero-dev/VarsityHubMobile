import { prisma } from './prisma.js';

/** New session-backed assets must be published only after verified processing. */
export async function assertReadyMediaForOwner(
  owner: string,
  url?: string,
  posterUrl?: string,
  maxDurationSeconds?: number
) {
  const sessionId = (value?: string) => {
    if (!value) return null;
    try {
      return (
        decodeURIComponent(new URL(value).pathname).match(
          /\/media\/([a-f0-9]{64})(?:[./]|$)/i
        )?.[1] || null
      );
    } catch {
      return null;
    }
  };
  const id = sessionId(url);
  const posterId = sessionId(posterUrl);
  if (!id && !posterId) return null; // Existing, pre-session uploads remain compatible.
  if (!id || (posterId && posterId !== id)) {
    throw Object.assign(new Error('Media and poster do not match the upload session'), {
      status: 422,
    });
  }
  const session = await prisma.mediaUpload.findFirst({ where: { id, owner_id: owner } });
  const result = session?.result as Record<string, any> | null;
  if (
    !session ||
    session.state !== 'ready' ||
    !result ||
    result.url !== url ||
    (posterUrl && result.poster_url !== posterUrl)
  ) {
    throw Object.assign(new Error('Media upload is not ready or does not belong to this account'), {
      status: 422,
    });
  }
  if (
    maxDurationSeconds !== undefined &&
    (!Number.isFinite(result.duration) ||
      result.duration <= 0 ||
      result.duration > maxDurationSeconds)
  ) {
    throw Object.assign(
      new Error(
        `Stories are limited to ${Math.floor(maxDurationSeconds)} seconds. Trim this video and retry.`
      ),
      { status: 422, code: 'MEDIA_DURATION_EXCEEDED' }
    );
  }
  return result;
}
