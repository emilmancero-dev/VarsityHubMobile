import crypto from 'node:crypto';
import { getCloudinaryCredentials, getCloudinaryFolder } from './cloudinary.js';
import { runWithBreaker } from './circuitBreaker.js';
import { prisma } from './prisma.js';

export const VIDEO_MP4_TRANSFORM = 'c_limit,w_1920,h_1920,vc_h264,ac_aac,f_mp4,q_auto';
const EAGER = `${VIDEO_MP4_TRANSFORM}/mp4|sp_full_hd/m3u8|so_0,w_480,f_jpg/jpg`;
const MAX_BYTES = 150 * 1024 * 1024;

function notificationUrl(id: string): string | null {
  const base =
    process.env.API_BASE_URL?.trim() ||
    (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN.trim()}`
      : '');
  if (base) {
    try {
      const url = new URL(base);
      if (url.protocol === 'https:' && !url.username && !url.password)
        return `${url.origin}/webhooks/media/cloudinary/${id}`;
    } catch {
      /* invalid server configuration; handled below */
    }
  }
  if (process.env.NODE_ENV === 'production')
    throw new Error('Public HTTPS API URL is required for media processing callbacks');
  return null;
}

export function validateUploadedVideo(
  session: { public_id: string; expected_bytes: number },
  data: any
): void {
  if (
    data?.public_id !== session.public_id ||
    data.resource_type !== 'video' ||
    !Number.isInteger(data.bytes) ||
    data.bytes !== session.expected_bytes ||
    data.bytes > MAX_BYTES ||
    !Number.isFinite(data.duration) ||
    data.duration <= 0 ||
    // Match client trim guards: allow 250ms of frame/audio-container rounding.
    data.duration > 90.25 ||
    !(data.width > 0) ||
    !(data.height > 0) ||
    !Number.isInteger(data.version)
  ) {
    throw Object.assign(
      new Error('Uploaded video does not match the allowed asset, size or duration'),
      {
        status: 422,
        validation: {
          publicIdMatches: data?.public_id === session.public_id,
          type: data?.resource_type,
          expectedBytes: session.expected_bytes,
          actualBytes: data?.bytes,
          duration: data?.duration,
          width: data?.width,
          height: data?.height,
          version: data?.version,
        },
      }
    );
  }
}

export function videoDeliveryUrls(cloud: string, data: { version: number; public_id: string }) {
  const base = `https://res.cloudinary.com/${cloud}/video/upload`;
  const path = `v${data.version}/${data.public_id}`;
  return {
    url: `${base}/${VIDEO_MP4_TRANSFORM}/${path}.mp4`,
    streaming_url: `${base}/sp_full_hd/${path}.m3u8`,
    poster_url: `${base}/so_0,w_480,f_jpg/${path}.jpg`,
  };
}

function sign(fields: Record<string, string>, secret: string) {
  return crypto
    .createHash('sha1')
    .update(
      Object.keys(fields)
        .sort()
        .map(key => `${key}=${fields[key]}`)
        .join('&') + secret
    )
    .digest('hex');
}

export async function openVideoUpload(
  owner: string,
  input: { id: string; content_type: string; bytes: number }
) {
  if (
    !/^[a-f0-9-]{36}$/i.test(input.id) ||
    !['video/mp4', 'video/quicktime', 'video/webm', 'video/x-m4v'].includes(input.content_type) ||
    !Number.isInteger(input.bytes) ||
    input.bytes <= 0 ||
    input.bytes > MAX_BYTES
  ) {
    throw Object.assign(new Error('Invalid video upload request'), { status: 400 });
  }
  const credentials = getCloudinaryCredentials();
  const id = crypto.createHash('sha256').update(`${owner}:${input.id}`).digest('hex');
  notificationUrl(id);
  const publicId = `${getCloudinaryFolder()}/media/${id}`;
  const session = await prisma.mediaUpload.upsert({
    where: { id },
    update: {},
    create: {
      id,
      owner_id: owner,
      content_type: input.content_type,
      expected_bytes: input.bytes,
      public_id: publicId,
    },
  });
  if (['expiring', 'expired'].includes(session.state)) {
    throw Object.assign(new Error('Upload session expired. Select the video again.'), {
      status: 410,
    });
  }
  if (
    session.owner_id !== owner ||
    session.expected_bytes !== input.bytes ||
    session.content_type !== input.content_type
  ) {
    throw Object.assign(new Error('Upload session does not match this file'), { status: 409 });
  }
  const fields = {
    public_id: publicId,
    timestamp: String(Math.floor(Date.now() / 1000)),
    overwrite: 'false',
    allowed_formats: 'mp4,mov,webm,m4v',
  };
  return {
    id,
    state: session.state === 'verifying' ? 'processing' : session.state,
    result: session.result,
    owner_id: owner,
    upload_url: `https://api.cloudinary.com/v1_1/${credentials.cloudName}/video/upload`,
    fields: {
      ...fields,
      signature: sign(fields, credentials.apiSecret),
      api_key: credentials.apiKey,
    },
  };
}

async function providerFetch(url: string, init: RequestInit = {}, pendingAllowed = false) {
  return runWithBreaker(
    'cloudinary-media-finalize',
    async () => {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
      if (pendingAllowed && [404, 423].includes(response.status)) return response;
      if (!response.ok)
        throw Object.assign(new Error('Media processing is temporarily unavailable'), {
          status: response.status === 404 ? 409 : 503,
        });
      return response;
    },
    { timeout: 22000 }
  );
}

function isReadinessTransportFailure(error: any): boolean {
  const code = error?.code || error?.cause?.code;
  return (
    error?.name === 'TimeoutError' ||
    error?.name === 'AbortError' ||
    error?.isCircuitOpen === true ||
    [
      'ETIMEDOUT',
      'ECONNRESET',
      'ECONNREFUSED',
      'EAI_AGAIN',
      'ENOTFOUND',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_SOCKET',
    ].includes(code) ||
    (error instanceof TypeError && error.message === 'fetch failed')
  );
}

export async function completeVideoUpload(owner: string, id: string) {
  const session = await prisma.mediaUpload.findFirst({ where: { id, owner_id: owner } });
  if (!session) throw Object.assign(new Error('Upload session not found'), { status: 404 });
  if (['expiring', 'expired'].includes(session.state)) {
    throw Object.assign(new Error('Upload session expired. Select the video again.'), {
      status: 410,
    });
  }
  if (session.state === 'ready') return { state: 'ready', result: session.result };
  if (session.state === 'failed')
    throw Object.assign(
      new Error('This video could not be processed. Select a different video or export it as MP4.'),
      { status: 422 }
    );
  const { cloudName, apiKey, apiSecret } = getCloudinaryCredentials();
  if (session.state === 'processing' && session.result) {
    const result = session.result as Record<string, any>;
    if (result.webhook_expected && Date.now() - session.updated_at.getTime() < 60000)
      return { state: 'processing' };
    const urls = [result.url, result.streaming_url, result.poster_url];
    // These are optional delivery observations, not asset verification. A slow
    // still-encoding derivative must not turn a successfully uploaded draft into
    // an immediate failure. Keep the breaker/20s deadline and inspect every
    // result so a simultaneous permanent rejection is never swallowed.
    const responses = await Promise.allSettled(
      urls.map(url => providerFetch(url, { method: 'HEAD' }, true))
    );
    for (const response of responses) {
      if (response.status === 'rejected' && !isReadinessTransportFailure(response.reason))
        throw response.reason;
    }
    if (responses.every(response => response.status === 'fulfilled' && response.value.ok)) {
      const ready = await prisma.mediaUpload.updateMany({
        where: { id, state: 'processing' },
        data: { state: 'ready' },
      });
      if (ready.count !== 1) return { state: 'processing' };
      return { state: 'ready', result };
    }
    return { state: 'processing' };
  }
  const leaseTime = new Date();
  const staleBefore = new Date(leaseTime.getTime() - 60000);
  const claim = await prisma.mediaUpload.updateMany({
    where: {
      id,
      owner_id: owner,
      OR: [{ state: 'uploading' }, { state: 'verifying', updated_at: { lt: staleBefore } }],
    },
    data: { state: 'verifying', updated_at: leaseTime },
  });
  if (claim.count !== 1) return { state: 'processing' };
  let metadataPersisted = false;
  try {
    const resource = (await (
      await providerFetch(
        `https://api.cloudinary.com/v1_1/${cloudName}/resources/video/upload/${encodeURIComponent(session.public_id)}?media_metadata=true`,
        {
          headers: {
            Authorization: `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}`,
          },
        }
      )
    ).json()) as any;
    validateUploadedVideo(session, resource);
    const callbackUrl = notificationUrl(id);
    const result = {
      ...videoDeliveryUrls(cloudName, resource),
      type: 'video',
      mime: 'video/mp4',
      provider: 'cloudinary',
      width: resource.width,
      height: resource.height,
      bytes: resource.bytes,
      duration: resource.duration,
      webhook_expected: Boolean(callbackUrl),
    };
    // Persist verified metadata before dispatch: a fast webhook must see it.
    const prepared = await prisma.mediaUpload.updateMany({
      where: { id, state: 'verifying', updated_at: leaseTime },
      data: { result, updated_at: leaseTime },
    });
    if (prepared.count !== 1) return { state: 'processing' };
    metadataPersisted = true;
    const fields: Record<string, string> = {
      public_id: session.public_id,
      type: 'upload',
      timestamp: String(Math.floor(Date.now() / 1000)),
      eager: EAGER,
      eager_async: 'true',
      ...(callbackUrl ? { eager_notification_url: callbackUrl } : {}),
    };
    const body = new URLSearchParams({
      ...fields,
      api_key: apiKey,
      signature: sign(fields, apiSecret),
    });
    await providerFetch(`https://api.cloudinary.com/v1_1/${cloudName}/video/explicit`, {
      method: 'POST',
      body,
    });
    await prisma.mediaUpload.updateMany({
      where: { id, state: 'verifying', updated_at: leaseTime },
      data: { state: 'processing' },
    });
    // A signed callback can finish while the explicit request is returning.
    // Return that verified result now instead of imposing another client poll.
    const completed = await prisma.mediaUpload.findFirst({ where: { id, owner_id: owner } });
    if (completed?.state === 'ready') return { state: 'ready', result: completed.result };
    return { state: 'processing' };
  } catch (error) {
    if (!metadataPersisted)
      await prisma.mediaUpload.updateMany({
        where: { id, state: 'verifying', updated_at: leaseTime },
        data: { state: 'uploading' },
      });
    throw error;
  }
}
