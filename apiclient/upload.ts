import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { uploadVideo } from './videoUpload';
import { throwIfUploadAborted } from '@/utils/resumableUpload';
import {
  isEmailVerificationRequiredError,
  openVerificationGate,
} from '@/hooks/useVerificationGate';
import { compressImageForUpload } from '@/utils/ensureUploadableUri';
import { emitSessionExpired } from '@/utils/sessionEvents';
import { captureException } from '@/utils/sentry';
import auth from './auth';
import {
  getAccessTokenForRequest,
  getApiBaseUrl,
  refreshAccessTokenWithCache,
  type RefreshOutcome,
} from './http';

function computeBase(provided?: string | null) {
  if (provided) return provided.replace(/\/$/, '');
  return getApiBaseUrl();
}

function buildUploadUrl(
  target: string,
  formFields?: Record<string, string | number | boolean | null | undefined>
) {
  if (!formFields) return target;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(formFields)) {
    if (value == null) continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `${target}?${query}` : target;
}

export interface UploadProgressCallback {
  (progress: number, loaded: number, total: number): void;
}

export interface UploadOptions {
  signal?: AbortSignal;
  onPhase?: (phase: 'uploading' | 'processing') => void;
  retries?: number;
  backoffMs?: number;
  timeoutMs?: number;
  onProgress?: UploadProgressCallback;
  formFields?: Record<string, string | number | boolean | null | undefined>;
}

interface UploadFetchConfig {
  target: string;
  uri: string;
  filename: string;
  mimeType: string;
  options?: UploadOptions;
  timeoutMs: number;
  debugLabel?: string;
  coerceFinal401ToUnauthorized?: boolean;
}

interface PreparedUploadInput {
  finalBase: string;
  finalUri: string;
  finalFilename: string;
  finalMimeType: string;
  isMedia: boolean;
}

const MIME_MAP: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  m4v: 'video/x-m4v',
  avi: 'video/x-msvideo',
  mkv: 'video/x-matroska',
};

function inferMimeFromPath(pathLike?: string): string | null {
  if (!pathLike) return null;
  const match = pathLike
    .toLowerCase()
    .match(/\.(jpg|jpeg|png|gif|webp|heic|heif|mp4|mov|webm|m4v|avi|mkv)(?:[?#].*)?$/);
  const ext = match?.[1];
  return (ext && MIME_MAP[ext]) || null;
}

function normalizeLocalUploadUri(uri: string): string {
  const trimmed = String(uri || '').trim();
  if (!trimmed) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('/')) return `file://${trimmed}`;
  return trimmed;
}

function detectMime(mimeType?: string, filename?: string, uri?: string): string {
  const inferredFromUri = inferMimeFromPath(uri);
  const inferredFromFilename = inferMimeFromPath(filename);

  if (mimeType && mimeType !== 'application/octet-stream') {
    const normalizedMime = mimeType.toLowerCase();
    const inferred = inferredFromUri || inferredFromFilename;
    if (
      inferred &&
      inferred.split('/')[0] === normalizedMime.split('/')[0] &&
      inferred !== normalizedMime
    ) {
      return inferred;
    }
    return mimeType;
  }

  return inferredFromUri || inferredFromFilename || 'image/jpeg';
}

async function buildUploadFormData(
  uri: string,
  filename: string,
  mimeType: string,
  formFields?: Record<string, string | number | boolean | null | undefined>
): Promise<FormData> {
  const form = new FormData();
  if (Platform.OS === 'web') {
    const response = await fetch(uri);
    const blob = await response.blob();
    form.append('file', blob, filename);
  } else {
    form.append('file', { uri, name: filename, type: mimeType } as any);
  }
  for (const [key, value] of Object.entries(formFields || {})) {
    if (value == null) continue;
    form.append(key, String(value));
  }
  return form;
}

function buildUploadNetworkError(error: any, coerceFinal401ToUnauthorized = false): Error {
  if (error?.name === 'AbortError') {
    return new Error('Upload timed out. Please check your connection and try again.');
  }
  if (error instanceof TypeError && error.message === 'Network request failed') {
    return new Error('Network error: unable to reach upload endpoint.');
  }
  if (coerceFinal401ToUnauthorized && error?.status === 401) {
    const unauthorized: any = new Error('Unauthorized');
    unauthorized.status = 401;
    if (error?.isSessionExpired === true) unauthorized.isSessionExpired = true;
    if (error?.isTransientAuthError === true) unauthorized.isTransientAuthError = true;
    return unauthorized;
  }
  return error;
}

async function resolveUploadHeaders(): Promise<Record<string, string>> {
  const token = await getAccessTokenForRequest({ allowRefresh: true });
  if (!token) {
    const err: any = new Error('Unauthorized');
    err.status = 401;
    throw err;
  }
  return { Authorization: `Bearer ${token}` };
}

function buildTransientUploadAuthError(refreshResult: RefreshOutcome): Error {
  const transientAuthErr: any = new Error('Unable to refresh session right now. Please try again.');
  transientAuthErr.status = 503;
  transientAuthErr.isTransientAuthError = true;
  transientAuthErr.refreshFailureReason = refreshResult.reason;
  transientAuthErr.originalError =
    refreshResult && 'error' in refreshResult ? refreshResult.error : undefined;
  return transientAuthErr;
}

async function applyRefreshResultToUploadBoundary(
  refreshResult: RefreshOutcome,
  headers: Record<string, string>,
  error?: any
): Promise<boolean> {
  if (refreshResult?.accessToken) {
    headers.Authorization = `Bearer ${refreshResult.accessToken}`;
    return true;
  }

  if (refreshResult?.reason === 'auth' || refreshResult?.reason === 'missing') {
    await auth.clearTokensOnly();
    if (error) error.isSessionExpired = true;
    emitSessionExpired(refreshResult.reason === 'missing' ? 'refresh_missing' : 'refresh_failed');
    return false;
  }

  throw buildTransientUploadAuthError(refreshResult);
}

async function handleUploadAccessBoundary(
  error: any,
  headers: Record<string, string>,
  verificationPromptedRef: { current: boolean },
  refreshAttemptedRef: { current: boolean }
): Promise<boolean> {
  if (error?.status === 401 && !refreshAttemptedRef.current) {
    refreshAttemptedRef.current = true;
    const refreshed = await refreshAccessTokenWithCache();
    return applyRefreshResultToUploadBoundary(refreshed, headers, error);
  }

  if (
    isEmailVerificationRequiredError(error?.status, error?.data) &&
    !verificationPromptedRef.current
  ) {
    verificationPromptedRef.current = true;
    const verified = await openVerificationGate();
    if (verified) {
      const refreshedToken = await getAccessTokenForRequest({ allowRefresh: true });
      if (refreshedToken) {
        headers.Authorization = `Bearer ${refreshedToken}`;
        return true;
      }
    }
  }

  return false;
}

async function prepareUploadInput(
  baseUrl: string | null | undefined,
  uri: string,
  filename?: string,
  mimeType?: string
): Promise<PreparedUploadInput> {
  const finalBase = computeBase(baseUrl);
  let finalUri = normalizeLocalUploadUri(uri);
  let finalFilename = filename || finalUri.split('/').pop() || 'upload';
  let finalMimeType = detectMime(mimeType, finalFilename, finalUri);
  const isMedia = finalMimeType.startsWith('image/') || finalMimeType.startsWith('video/');

  if (finalMimeType.startsWith('image/')) {
    const compressed = await compressImageForUpload(finalUri, finalMimeType);
    finalUri = normalizeLocalUploadUri(compressed.uri);
    finalMimeType = compressed.mimeType || finalMimeType;
    if (finalMimeType === 'image/jpeg')
      finalFilename = `${finalFilename.replace(/\.[^.]+$/, '')}.jpg`;
    const imageSize =
      Platform.OS === 'web'
        ? (await (await fetch(finalUri)).blob()).size
        : await getLocalFileSize(finalUri);
    if (!imageSize || imageSize > 10 * 1024 * 1024) {
      throw new Error('Image is unreadable or too large. The upload limit is 10 MB.');
    }
  }

  return {
    finalBase,
    finalUri,
    finalFilename,
    finalMimeType,
    isMedia,
  };
}

async function uploadViaFetchWithRetries({
  target,
  uri,
  filename,
  mimeType,
  options,
  timeoutMs,
  debugLabel,
  coerceFinal401ToUnauthorized = false,
}: UploadFetchConfig): Promise<any> {
  const form = await buildUploadFormData(uri, filename, mimeType, options?.formFields);
  const headers = await resolveUploadHeaders();
  const retries = Math.max(0, options?.retries ?? 2);
  const backoffMs = Math.max(50, options?.backoffMs ?? 500);
  const refreshAttemptedRef = { current: false };
  const verificationPromptedRef = { current: false };
  let attempt = 0;
  let lastErr: any = null;

  while (attempt <= retries) {
    const controller = new AbortController();
    throwIfUploadAborted(options?.signal);
    const cancel = () => controller.abort();
    options?.signal?.addEventListener('abort', cancel, { once: true });
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      if (__DEV__ && debugLabel) {
        console.log('[upload]', debugLabel, attempt + 1, '/', retries + 1, '| file:', filename);
      }
      const res = await fetch(target, {
        method: 'POST',
        headers,
        body: form as any,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      options?.signal?.removeEventListener('abort', cancel);
      const text = await res.text();
      if (!text) throw new Error(`Empty response (HTTP ${res.status})`);
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`Non-JSON response (HTTP ${res.status}): ${text.substring(0, 100)}`);
      }
      if (!res.ok) {
        const err: any = new Error(data?.error || data?.message || `HTTP ${res.status}`);
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    } catch (err: any) {
      clearTimeout(timeoutId);
      options?.signal?.removeEventListener('abort', cancel);
      throwIfUploadAborted(options?.signal);
      lastErr = err;

      if (
        await handleUploadAccessBoundary(err, headers, verificationPromptedRef, refreshAttemptedRef)
      ) {
        continue;
      }

      const isNetwork = err instanceof TypeError && err.message === 'Network request failed';
      const isTimeout =
        err?.name === 'AbortError' || /timeout|timed out/i.test(String(err?.message || ''));
      if (attempt < retries && (isNetwork || isTimeout)) {
        await new Promise(resolve => setTimeout(resolve, backoffMs * Math.pow(2, attempt)));
        attempt++;
        continue;
      }
      break;
    }
  }

  throw buildUploadNetworkError(lastErr, coerceFinal401ToUnauthorized);
}

// -----------------------------------------------
// Direct-to-R2 upload (Cloudflare R2 / any S3-compatible store)
// Phone → storage, zero-egress delivery. Server-driven activation: the client
// simply TRIES GET /uploads/r2-presign; while R2 is unprovisioned the server
// 503s, we cache the miss for a few minutes, and every upload proceeds down
// the existing Cloudinary path with no behavior change. The moment R2 env
// vars exist on the server, uploads start landing on R2 — no client flag.
// -----------------------------------------------

const R2_UNAVAILABLE_TTL_MS = 5 * 60_000;
let _r2UnavailableAt = 0;

interface R2UploadTicket {
  uploadUrl: string;
  key: string;
  publicUrl: string | null;
  expiresIn: number;
  contentLength: number;
  maxBytes: number;
}

async function getR2UploadTicket(
  baseUrl: string,
  contentType: string,
  contentLength: number,
  options?: UploadOptions
): Promise<R2UploadTicket | null> {
  if (Date.now() - _r2UnavailableAt < R2_UNAVAILABLE_TTL_MS) return null;
  const token = await getAccessTokenForRequest({ allowRefresh: true });
  if (!token) return null;
  if (!Number.isFinite(contentLength) || contentLength <= 0) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SIG_FETCH_TIMEOUT_MS);
  try {
    const params = new URLSearchParams({
      content_type: contentType,
      content_length: String(Math.round(contentLength)),
    });
    for (const [key, value] of Object.entries(options?.formFields || {})) {
      if (value != null) params.set(key, String(value));
    }
    const res = await fetch(`${baseUrl}/uploads/r2-presign?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (res.status === 503) {
      // R2 not provisioned server-side — remember and stop asking for a while.
      _r2UnavailableAt = Date.now();
      return null;
    }
    if (!res.ok)
      throw Object.assign(new Error('Upload authorization or file validation failed'), {
        status: res.status,
      });
    const data = (await res.json().catch(() => null)) as R2UploadTicket | null;
    // Without a public delivery URL the asset would be unreachable — treat as
    // unavailable rather than uploading into a black hole.
    if (!data?.uploadUrl || !data?.publicUrl) return null;
    return data;
  } catch (error: any) {
    if (error?.status >= 400 && error?.status < 500) throw error;
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function getLocalFileSize(uri: string): Promise<number | null> {
  if (!uri.startsWith('file://')) return null;
  try {
    const info = await FileSystem.getInfoAsync(uri, { size: true } as any);
    if (!info.exists || typeof (info as any).size !== 'number') return null;
    return (info as any).size;
  } catch {
    return null;
  }
}

async function uploadDirectToR2(
  uri: string,
  mimeType: string,
  ticket: R2UploadTicket,
  options?: UploadOptions
): Promise<{ url: string; type: string; mime: string; provider: 'r2' }> {
  const isVideo = mimeType.startsWith('video/');
  const timeoutMs = options?.timeoutMs ?? (isVideo ? 300000 : 120000);

  // Binary PUT straight from disk — no FormData, no base64, no JS copy of the
  // bytes. Content-Type must match exactly: the server pinned it into the
  // presigned signature.
  const task = FileSystem.createUploadTask(
    ticket.uploadUrl,
    uri,
    {
      httpMethod: 'PUT',
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(ticket.contentLength),
      },
    },
    options?.onProgress
      ? progress => {
          const total = progress.totalBytesExpectedToSend || 0;
          if (total > 0) {
            options.onProgress!(
              Math.round((progress.totalBytesSent / total) * 100),
              progress.totalBytesSent,
              total
            );
          }
        }
      : undefined
  );

  throwIfUploadAborted(options?.signal);
  const cancel = () => {
    void task.cancelAsync().catch(() => {});
  };
  options?.signal?.addEventListener('abort', cancel, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    task.cancelAsync().catch(() => {});
  }, timeoutMs);
  try {
    const result = await task.uploadAsync();
    throwIfUploadAborted(options?.signal);
    if (timedOut) throw new Error('R2 upload timed out');
    if (!result || result.status < 200 || result.status >= 300) {
      throw new Error(
        `R2 upload failed: HTTP ${result?.status ?? 'unknown'}${
          result?.body ? ` — ${String(result.body).slice(0, 200)}` : ''
        }`
      );
    }
    return {
      url: ticket.publicUrl!,
      type: isVideo ? 'video' : 'image',
      mime: mimeType,
      provider: 'r2',
    };
  } finally {
    clearTimeout(timer);
    options?.signal?.removeEventListener('abort', cancel);
  }
}

/**
 * Try the R2 path for a media file. Returns null when R2 is unavailable or the
 * ticket can't be fetched (callers fall back to Cloudinary); throws only when
 * an actual R2 upload was attempted and failed — callers still fall back.
 */
async function tryUploadToR2(
  baseUrl: string,
  uri: string,
  mimeType: string,
  options?: UploadOptions
): Promise<{ url: string; type: string; mime: string; provider: 'r2' } | null> {
  const contentLength = await getLocalFileSize(uri);
  if (!contentLength) return null;
  const ticket = await getR2UploadTicket(baseUrl, mimeType, contentLength, options);
  if (!ticket) return null;
  try {
    if (__DEV__) console.log('[upload] Using direct R2 upload:', ticket.key);
    return await uploadDirectToR2(uri, mimeType, ticket, options);
  } catch (err: any) {
    if (__DEV__)
      console.warn('[upload] R2 upload failed, falling back to Cloudinary:', err?.message);
    captureException(err instanceof Error ? err : new Error(String(err)), {
      tags: { context: 'r2_upload', stage: 'direct_put_failed' },
    });
    throw err;
  }
}

// -----------------------------------------------
// Direct-to-Cloudinary upload (skips your server)
// Phone → Cloudinary CDN. ~2x faster than proxying through Railway.
// -----------------------------------------------

// Cache signature for 55s (signatures valid ~60min, but re-fetch well before expiry)
let _sigCache: {
  sig: { cloudName: string; apiKey: string; signature: string; timestamp: number; folder: string };
  fetchedAt: number;
  scope: string;
} | null = null;
const SIG_CACHE_TTL_MS = 55_000;
// The signature request gates EVERY media upload and runs before any bytes are
// sent. Without a timeout it hangs for the OS socket timeout (60s+) on congested
// stadium wifi, leaving the progress bar pinned at 0%. Abort fast so callers can
// fall through to their fallback (server proxy for images, fresh-sig retry for
// video) instead of appearing frozen.
const SIG_FETCH_TIMEOUT_MS = 12_000;

async function getCloudinarySignature(
  baseUrl: string,
  options?: UploadOptions,
  forceRefresh = false
): Promise<{
  cloudName: string;
  apiKey: string;
  signature: string;
  timestamp: number;
  folder: string;
  allowed_formats?: string;
  max_bytes?: string;
} | null> {
  throwIfUploadAborted(options?.signal);
  let token = await getAccessTokenForRequest({ allowRefresh: true });
  if (!token) return null;
  const scope = JSON.stringify([baseUrl, token, options?.formFields || {}]);
  if (
    !forceRefresh &&
    _sigCache?.scope === scope &&
    Date.now() - _sigCache.fetchedAt < SIG_CACHE_TTL_MS
  )
    return _sigCache.sig;

  let refreshAttempted = false;
  let verificationPrompted = false;

  while (token) {
    try {
      const sigController = new AbortController();
      const sigTimeout = setTimeout(() => sigController.abort(), SIG_FETCH_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(
          buildUploadUrl(`${baseUrl}/uploads/cloudinary-signature`, options?.formFields),
          {
            headers: { Authorization: `Bearer ${token}` },
            signal: sigController.signal,
          }
        );
      } finally {
        clearTimeout(sigTimeout);
      }
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        if (res.status === 401 && !refreshAttempted) {
          refreshAttempted = true;
          const refreshed = await refreshAccessTokenWithCache();
          token = refreshed?.accessToken ?? null;
          if (token) continue;
          if (refreshed.reason === 'auth' || refreshed.reason === 'missing') {
            await auth.clearTokensOnly();
            emitSessionExpired(
              refreshed.reason === 'missing' ? 'refresh_missing' : 'refresh_failed'
            );
            return null;
          }
          throw buildTransientUploadAuthError(refreshed);
        }
        if (isEmailVerificationRequiredError(res.status, data) && !verificationPrompted) {
          verificationPrompted = true;
          const verified = await openVerificationGate();
          if (verified) {
            token = await getAccessTokenForRequest({ allowRefresh: true });
            if (token) continue;
          }
        }
        if (__DEV__)
          console.warn('[upload] Cloudinary signature failed:', res.status, data || res.statusText);
        const signatureErr: any = new Error(
          data?.error || data?.message || res.statusText || 'Cloudinary signature request failed'
        );
        signatureErr.status = res.status;
        signatureErr.data = data;
        throw signatureErr;
      }
      const sig = data as any;
      _sigCache = { sig, fetchedAt: Date.now(), scope };
      return sig;
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        const timeoutErr: any = new Error(
          'Upload service timed out before video upload could begin.'
        );
        timeoutErr.code = 'UPLOAD_SIGNATURE_TIMEOUT';
        throw timeoutErr;
      }
      if (error instanceof TypeError && error.message === 'Network request failed') {
        const networkErr: any = new Error('Network error while preparing video upload.');
        networkErr.code = 'UPLOAD_SIGNATURE_NETWORK';
        throw networkErr;
      }
      throw error;
    }
  }

  return null;
}

async function uploadDirectToCloudinary(
  uri: string,
  filename: string,
  mimeType: string,
  sig: {
    cloudName: string;
    apiKey: string;
    signature: string;
    timestamp: number;
    folder: string;
    allowed_formats?: string;
    max_bytes?: string;
  },
  options?: UploadOptions
): Promise<{
  url: string;
  type: string;
  mime: string;
  provider: 'cloudinary';
  width?: number;
  height?: number;
  bytes?: number;
  duration?: number;
}> {
  const isVideo = mimeType.startsWith('video/');
  const resourceType = isVideo ? 'video' : 'image';
  const timeoutMs = options?.timeoutMs ?? (isVideo ? 300000 : 120000);

  const form = new FormData();
  if (Platform.OS === 'web') {
    const response = await fetch(uri, { signal: options?.signal });
    const blob = await response.blob();
    form.append('file', blob, filename);
  } else {
    form.append('file', { uri, name: filename, type: mimeType } as any);
  }
  form.append('api_key', sig.apiKey);
  form.append('timestamp', String(sig.timestamp));
  form.append('folder', sig.folder);
  form.append('signature', sig.signature);
  // v1.0.3: mirror every SIGNED param back in the form. The server signed these
  // constraints into the signature; sending the form without them causes
  // Cloudinary to compute a different hash and reject with "Invalid Signature"
  // — the Sentry error that was surfacing to users as "Sign-in Required" in
  // production. Order doesn't matter for transport; Cloudinary sorts keys
  // before verifying.
  if (sig.allowed_formats) form.append('allowed_formats', sig.allowed_formats);
  if (sig.max_bytes) form.append('max_bytes', sig.max_bytes);

  throwIfUploadAborted(options?.signal);
  return new Promise((rawResolve, rawReject) => {
    const xhr = new XMLHttpRequest();
    const cancel = () => xhr.abort();
    const resolve = (value: any) => {
      options?.signal?.removeEventListener('abort', cancel);
      rawResolve(value);
    };
    const reject = (error: any) => {
      options?.signal?.removeEventListener('abort', cancel);
      rawReject(error);
    };
    xhr.onabort = () =>
      reject(Object.assign(new Error('Upload cancelled'), { name: 'AbortError' }));
    options?.signal?.addEventListener('abort', cancel, { once: true });

    if (options?.onProgress) {
      xhr.upload.onprogress = event => {
        if (event.lengthComputable) {
          options.onProgress!(
            Math.round((event.loaded / event.total) * 100),
            event.loaded,
            event.total
          );
        }
      };
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText);
          const url = data.secure_url || data.url;
          if (!url) {
            reject(new Error('Cloudinary returned no URL'));
            return;
          }
          // Surface the dimensions/size/duration Cloudinary returns so the
          // caller can persist them (aspect-ratio hints + migration tooling).
          resolve({
            url,
            type: resourceType,
            mime: mimeType,
            provider: 'cloudinary',
            width: typeof data.width === 'number' ? data.width : undefined,
            height: typeof data.height === 'number' ? data.height : undefined,
            bytes: typeof data.bytes === 'number' ? data.bytes : undefined,
            duration: typeof data.duration === 'number' ? data.duration : undefined,
          });
        } catch {
          reject(new Error('Cloudinary returned invalid response'));
        }
      } else {
        // Surface Cloudinary's actual error (e.g. "Invalid Signature", "Stale
        // request", "Unsupported video format"). The server never sees this
        // rejection — the upload goes phone→Cloudinary directly — so discarding
        // the body here is how a signature outage stayed invisible. Keep the
        // detail so the next failure is diagnosable from the error/Sentry alone.
        let detail = '';
        try {
          const parsed = JSON.parse(xhr.responseText);
          detail = parsed?.error?.message ? ` — ${parsed.error.message}` : '';
        } catch {
          const raw = String(xhr.responseText || '').trim();
          if (raw) detail = ` — ${raw.slice(0, 200)}`;
        }
        // Keep the full "provider + raw upstream body" string for Sentry/logging
        // on a NON-message field (see captureException calls in uploadFile /
        // uploadFileWithProgress, which forward `debugDetail`). The user-facing
        // `.message` stays generic so we never disclose the provider name or the
        // raw upstream response body on screen.
        const cloudinaryErr: any = new Error('Upload failed. Please try again.');
        cloudinaryErr.debugDetail = `Cloudinary upload failed: HTTP ${xhr.status}${detail}`;
        cloudinaryErr.isUploadError = true;
        cloudinaryErr.status = xhr.status;
        reject(cloudinaryErr);
      }
    };

    xhr.onerror = () => reject(new Error('Network error during direct upload'));
    xhr.ontimeout = () => reject(new Error('Direct upload timed out'));
    xhr.timeout = timeoutMs;
    xhr.open('POST', `https://api.cloudinary.com/v1_1/${sig.cloudName}/${resourceType}/upload`);
    if (options?.signal?.aborted) {
      reject(Object.assign(new Error('Upload cancelled'), { name: 'AbortError' }));
      return;
    }
    xhr.send(form as any);
  });
}

// -----------------------------------------------
// Main upload function — tries direct Cloudinary, falls back to server proxy
// -----------------------------------------------
//
// Routing rules:
//   image/*, video/*  →  direct-to-Cloudinary (fast CDN path), then fall back to
//                        POST /uploads which is also image/video-only on the server.
//   everything else   →  POST /uploads/files (general multer endpoint that accepts
//                        PDFs and other document types). The Cloudinary signature
//                        endpoint is not configured for resource_type=raw, and the
//                        POST /uploads endpoint validates magic bytes against image
//                        or video MIME types — sending a PDF there was the root cause
//                        of the silent supporting-document upload failure during
//                        coach onboarding. Route PDFs (and any non-media) to
//                        /uploads/files so multer stores them without media-only
//                        validation.
export async function uploadFile(
  baseUrl: string | null | undefined,
  uri: string,
  filename?: string,
  mimeType?: string,
  options?: UploadOptions
): Promise<any> {
  const { finalBase, finalUri, finalFilename, finalMimeType, isMedia } = await prepareUploadInput(
    baseUrl,
    uri,
    filename,
    mimeType
  );
  if (options?.signal?.aborted)
    throw Object.assign(new Error('Upload cancelled'), { name: 'AbortError' });
  if (!isMedia)
    return uploadRawViaServer(finalBase, finalUri, finalFilename, finalMimeType, options);
  if (finalMimeType.startsWith('video/'))
    return uploadVideo(finalUri, finalFilename, finalMimeType, options);
  const r2Result = await tryUploadToR2(finalBase, finalUri, finalMimeType, options);
  if (r2Result) return r2Result;
  try {
    const signature = await getCloudinarySignature(finalBase, options);
    if (signature)
      return await uploadDirectToCloudinary(
        finalUri,
        finalFilename,
        finalMimeType,
        signature,
        options
      );
  } catch (error: any) {
    if (
      options?.signal?.aborted ||
      error?.name === 'AbortError' ||
      (error?.status >= 400 && error?.status < 500)
    )
      throw error;
    captureException(error, { tags: { context: 'image_upload', stage: 'direct_failed' } });
  }
  return uploadViaServer(finalBase, finalUri, finalFilename, finalMimeType, options);
}

// -----------------------------------------------
// Raw/document upload — POST /uploads/files (not /uploads).
// The /uploads endpoint is image/video only and magic-byte-validates against those;
// /uploads/files accepts general files including PDFs.
// -----------------------------------------------
async function uploadRawViaServer(
  base: string,
  uri: string,
  filename: string,
  mimeType: string,
  options?: UploadOptions
): Promise<any> {
  const target = buildUploadUrl(`${base}/uploads/files`, options?.formFields);
  const timeoutMs = options?.timeoutMs ?? 180000;
  return uploadViaFetchWithRetries({
    target,
    uri,
    filename,
    mimeType,
    options,
    timeoutMs,
  });
}

// -----------------------------------------------
// XHR upload with progress — tries direct Cloudinary, falls back to server proxy for images only
// -----------------------------------------------
// Same transport and auth policy; progress is an option, not a second pipeline.
export const uploadFileWithProgress = uploadFile;

// -----------------------------------------------
// Server-proxy upload (original path, kept as fallback)
// -----------------------------------------------
async function uploadViaServer(
  base: string,
  uri: string,
  filename: string,
  mimeType: string,
  options?: UploadOptions
): Promise<any> {
  const target = buildUploadUrl(`${base}/uploads`, options?.formFields);
  const isVideo = mimeType.startsWith('video/');
  const timeoutMs = options?.timeoutMs ?? (isVideo ? 300000 : 120000);
  return uploadViaFetchWithRetries({
    target,
    uri,
    filename,
    mimeType,
    options,
    timeoutMs,
    debugLabel: 'Server proxy attempt',
    coerceFinal401ToUnauthorized: true,
  });
}

export default { uploadFile, uploadFileWithProgress };
