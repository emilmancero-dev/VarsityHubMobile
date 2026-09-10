import crypto from 'node:crypto';
import { prisma } from './prisma.js';

export function verifyMediaWebhookSignature(
  raw: Buffer,
  timestamp: string,
  signature: string,
  secret: string,
  now = Date.now()
) {
  if (!/^\d{10}$/.test(timestamp) || !/^[a-f0-9]{40}$/i.test(signature)) return false;
  const age = now / 1000 - Number(timestamp);
  if (age > 3600 || age < -300) return false;
  const expected = crypto.createHash('sha1').update(raw).update(timestamp).update(secret).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}

/** Normalize qualifier ordering only; preserve transform chain, version, host and asset. */
export function canonicalEagerUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'res.cloudinary.com' ||
      url.search ||
      url.hash
    )
      return null;
    const path = decodeURIComponent(url.pathname).split('/');
    const uploadIndex = path.indexOf('upload');
    const versionIndex = path.findIndex((part, i) => i > uploadIndex && /^v\d+$/.test(part));
    if (uploadIndex < 0 || versionIndex < 0) return null;
    for (let i = uploadIndex + 1; i < versionIndex; i++)
      path[i] = path[i].split(',').sort().join(',');
    return `${url.origin}${path.join('/')}`;
  } catch {
    return null;
  }
}

export async function applyMediaUploadNotification(id: string, data: any) {
  const session = await prisma.mediaUpload.findUnique({ where: { id } });
  if (!session || !['verifying', 'processing', 'failed'].includes(session.state)) return;
  if (
    data?.public_id !== session.public_id ||
    (data.resource_type && data.resource_type !== 'video') ||
    (data.type && data.type !== 'upload') ||
    (data.notification_type && data.notification_type !== 'eager')
  )
    return;
  const result = session.result as Record<string, any> | null;
  if (!result) throw new Error('Upload result not yet persisted');
  const eager = Array.isArray(data.eager) ? data.eager : [];
  const failed =
    data.error ||
    data.status === 'failed' ||
    eager.some((item: any) => item?.error || item?.status === 'failed');
  if (failed) {
    await prisma.mediaUpload.updateMany({
      where: { id, state: { in: ['verifying', 'processing', 'failed'] } },
      data: { state: 'failed' },
    });
    return;
  }
  const successfulUrls = new Set(
    eager
      .filter((item: any) => !item.error && (!item.status || item.status === 'success'))
      .map((item: any) => canonicalEagerUrl(item.secure_url))
  );
  const expected = [result.url, result.streaming_url, result.poster_url].map(canonicalEagerUrl);
  if (expected.some(value => !value || !successfulUrls.has(value))) return;
  await prisma.mediaUpload.updateMany({
    where: { id, state: { in: ['verifying', 'processing', 'failed'] } },
    data: { state: 'ready' },
  });
}
