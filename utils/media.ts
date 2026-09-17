import { getApiBaseUrl } from '@/api/http';

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.m4v', '.avi', '.mkv'];
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '10.0.2.2']);

export type ResolvedMediaType = 'image' | 'video' | null;

/** Full-screen post media must remain completely visible inside its viewport. */
export function getVerticalPostContentFit(): 'contain' {
  return 'contain';
}

/** Bound a zoomed image translation to the extra scaled area. */
export function clampFullscreenMediaOffset(
  proposedOffset: number,
  scale: number,
  viewportSize: number
): number {
  'worklet';
  if (!Number.isFinite(scale) || scale <= 1 || !Number.isFinite(viewportSize)) return 0;
  const limit = Math.max(0, (viewportSize * (scale - 1)) / 2);
  return Math.max(-limit, Math.min(limit, proposedOffset));
}

type MediaLike = {
  media_url?: string | null;
  preview_url?: string | null;
  media_type?: string | null;
};

export const normalizeMediaUrl = (value?: string | null): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const base = getApiBaseUrl();
  if (trimmed.startsWith('/uploads/')) {
    return `${base}${trimmed}`;
  }
  if (trimmed.startsWith('uploads/')) {
    return `${base}/${trimmed}`;
  }

  try {
    const parsed = new URL(trimmed);
    if (LOCAL_HOSTS.has(parsed.hostname)) {
      const baseParsed = new URL(base);
      parsed.protocol = baseParsed.protocol;
      parsed.host = baseParsed.host;
      return parsed.toString();
    }
    return parsed.toString();
  } catch {
    return trimmed;
  }
};

const sanitizeForExtensionCheck = (url: string) => url.split('?')[0].split('#')[0].toLowerCase();

export const getCloudinaryVideoPreviewUrl = (url?: string | null): string | null => {
  if (!url) return null;
  const normalized = normalizeMediaUrl(url);
  if (!normalized || resolveMediaType(normalized, 'video') !== 'video') return null;
  const match = normalized.match(
    /^(https?:\/\/res\.cloudinary\.com\/[^/]+\/video\/upload\/)((?:[^v][^/]*\/)*)?(v\d+\/.+)$/
  );
  if (!match) return null;
  const [, base, , rest] = match;
  return `${base}f_webp,fl_awebp,du_3,so_0,w_480,q_60/${rest}`;
};

export const resolveMediaType = (
  mediaUrl?: string | null,
  explicitType?: string | null
): ResolvedMediaType => {
  const normalizedMediaUrl = normalizeMediaUrl(mediaUrl);
  if (!normalizedMediaUrl) return null;

  const normalizedExplicitType =
    typeof explicitType === 'string' ? explicitType.trim().toLowerCase() : null;
  if (normalizedExplicitType === 'video' || normalizedExplicitType === 'image') {
    return normalizedExplicitType;
  }

  const sanitized = sanitizeForExtensionCheck(normalizedMediaUrl);
  return VIDEO_EXTENSIONS.some(ext => sanitized.endsWith(ext)) ? 'video' : 'image';
};

export const resolvePostMedia = (item: MediaLike | null | undefined) => {
  const mediaUrl = normalizeMediaUrl(item?.media_url);
  const previewUrl = normalizeMediaUrl(item?.preview_url) || getCloudinaryVideoPreviewUrl(mediaUrl);
  const mediaType = resolveMediaType(mediaUrl, item?.media_type);
  const isVideo = mediaType === 'video';

  return {
    mediaUrl,
    previewUrl,
    mediaType,
    isVideo,
    hasMedia: Boolean(mediaUrl),
    displayImageUrl: isVideo ? previewUrl : mediaUrl,
  };
};
