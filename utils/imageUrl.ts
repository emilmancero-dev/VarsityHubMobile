function applyCloudinaryTransform(
  url: string | undefined | null,
  transform: string
): string | undefined {
  if (!url) return undefined;
  if (!url.includes('res.cloudinary.com')) return url;
  return url.replace('/upload/', `/upload/${transform}/`);
}

/**
 * Apply Cloudinary transforms to an image URL for optimized delivery.
 * Only transforms Cloudinary URLs; returns others unchanged.
 */
export function optimizeImageUrl(
  url: string | undefined | null,
  width?: number
): string | undefined {
  if (url) {
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
