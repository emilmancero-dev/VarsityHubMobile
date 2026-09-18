function applyCloudinaryTransform(
  url: string | undefined | null,
  transform: string
): string | undefined {
  if (!url) return undefined;
  if (!url.includes('res.cloudinary.com')) return url;
  return url.replace('/upload/', `/upload/${transform}/`);
}

// Base URL of the R2 image-resizing Worker (see cloudflare/varsityhub-image-resizer).
// EMPTY = disabled: R2 URLs pass through untouched, so shipping this before the
// Worker/domain exists is a no-op. Set to e.g. 'https://media.varsityhub.app'
// (no trailing slash) once deployed, then `eas update` — R2 media (~1.3 MB
// full-res today) then loads resized (~20x smaller).
const R2_IMAGE_RESIZE_BASE = '';

/**
 * Rewrite a raw R2 public image URL (pub-*.r2.dev/<key>) to the resizing Worker
 * with a target width, preserving the object key. Returns null when disabled or
 * when the URL is not an R2 URL, so callers fall back to existing handling.
 */
function rewriteR2ImageUrl(url: string, width?: number): string | null {
  if (!R2_IMAGE_RESIZE_BASE) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.r2.dev')) return null;
    const key = parsed.pathname.replace(/^\/+/, '');
    if (!key) return null;
    const w = width && width > 0 ? Math.round(width) : 800;
    return `${R2_IMAGE_RESIZE_BASE}/${key}?w=${w}`;
  } catch {
    return null;
  }
}

/**
 * Apply delivery optimization to an image URL: resized R2 (via the Worker) when
 * configured, else Cloudinary transforms. Returns other URLs unchanged.
 */
export function optimizeImageUrl(
  url: string | undefined | null,
  width?: number
): string | undefined {
  if (url) {
    const resizedR2 = rewriteR2ImageUrl(url, width);
    if (resizedR2) return resizedR2;
    try {
      const parsed = new URL(url);
      if (
        parsed.protocol === 'https:' &&
        parsed.hostname === 'res.cloudinary.com' &&
        /\/video\/upload\/so_0,w_480,f_jpg\/v\d+\/.*\/media\/.+\.jpg$/.test(parsed.pathname)
      )
        return url;
    } catch {
      /* Non-URL inputs retain existing handling. */
    }
  }
  return applyCloudinaryTransform(url, `w_${width || 600},q_auto,f_auto`);
}

/**
 * Apply Cloudinary transforms to a video URL for optimized playback delivery.
 * Only transforms Cloudinary URLs; returns others unchanged.
 */
export function optimizeVideoUrl(url: string | undefined | null): string | undefined {
  if (url && isPreparedVideoUrl(url)) return url;
  return applyCloudinaryTransform(url, 'q_auto');
}

const PREPARED_VIDEO_PROFILES = [
  { transform: 'c_limit,w_1920,h_1920,vc_h264,ac_aac,f_mp4,q_auto', profile: 'full_hd' },
  { transform: 'c_limit,w_1280,h_1280,vc_h264,ac_aac,f_mp4,q_auto', profile: 'hd' },
];

function isPreparedVideoUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === 'res.cloudinary.com' &&
      PREPARED_VIDEO_PROFILES.some(({ transform }) =>
        parsed.pathname.includes(`/video/upload/${transform}/v`)
      ) &&
      /\/v\d+\/.*\/media\/.+\.mp4$/.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

/** Only verified, pre-generated uploads have an adaptive rendition. */
export function getVideoPlaybackSource(
  url: string,
  platform: string
): { uri: string; fallbackUri?: string } {
  if (platform !== 'web' && isPreparedVideoUrl(url)) {
    const prepared = PREPARED_VIDEO_PROFILES.find(({ transform }) =>
      url.includes(`/video/upload/${transform}/v`)
    )!;
    return {
      uri: url
        .replace(`/video/upload/${prepared.transform}/`, `/video/upload/sp_${prepared.profile}/`)
        .replace(/\.mp4(?=\?|#|$)/, '.m3u8'),
      fallbackUri: url,
    };
  }
  return { uri: url };
}
