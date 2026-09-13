import { prisma } from './prisma.js';
import { destroyCloudinaryAsset } from './cloudinary.js';
import { captureException } from './sentry.js';

const ABANDONED_AFTER_MS = 48 * 60 * 60 * 1000;
const EXPIRABLE_STATES = ['uploading', 'verifying', 'processing', 'failed', 'expiring'];

/**
 * Reap only abandoned, unpublished sessions. The expiring CAS is a permanent
 * barrier to completion; ready/published rows can never be claimed. Retain the
 * expired tombstone so old clients cannot recreate a deleted upload session.
 */
export async function cleanupAbandonedMediaUploads(now = new Date()) {
  const cutoff = new Date(now.getTime() - ABANDONED_AFTER_MS);
  const candidates = await prisma.mediaUpload.findMany({
    where: { state: { in: EXPIRABLE_STATES }, created_at: { lt: cutoff } },
    select: { id: true, public_id: true, state: true, updated_at: true },
    orderBy: { updated_at: 'asc' },
    take: 100,
  });
  let expired = 0;
  let failed = 0;
  for (const candidate of candidates) {
    const claim = await prisma.mediaUpload.updateMany({
      where: {
        id: candidate.id,
        state: candidate.state,
        updated_at: candidate.updated_at,
        created_at: { lt: cutoff },
      },
      data: { state: 'expiring' },
    });
    if (claim.count !== 1) continue;
    try {
      const result = await destroyCloudinaryAsset(candidate.public_id, 'video');
      if (!result.ok) throw new Error(result.error || 'Cloudinary upload cleanup failed');
      await prisma.mediaUpload.updateMany({
        where: { id: candidate.id, state: 'expiring' },
        data: { state: 'expired' },
      });
      expired += 1;
    } catch (error) {
      // Keep expiring for a later sweep, including a crash after deletion but
      // before tombstone update. Cloudinary "not found" is an idempotent success.
      failed += 1;
      captureException(error instanceof Error ? error : new Error(String(error)), {
        tags: { context: 'media_upload_cleanup' },
        uploadId: candidate.id,
      });
    }
  }
  if (failed)
    throw new Error(
      `Media upload cleanup failed for ${failed} session(s); retry queued for next sweep`
    );
  return { checked: candidates.length, expired };
}
