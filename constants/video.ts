import * as ImagePicker from 'expo-image-picker';

/**
 * Camera passthrough preserves captured video. iOS library acquisition uses the
 * app-owned PHPicker provider path in utils/pickMedia.ts, avoiding SDK 54's
 * network-disabled PHAssetResource fast path without forcing a video export.
 */
export const VIDEO_CAPTURE_PRESET = ImagePicker.VideoExportPreset.Passthrough;

/** Image upload cap — shared by create-post and BannerUpload (was two independent 10MB literals). */
export const MAX_IMAGE_SIZE_MB = 10;
export const MAX_IMAGE_SIZE_BYTES = MAX_IMAGE_SIZE_MB * 1024 * 1024;

/**
 * Duration caps (2026-07-13, highlights-first product decision): over-limit
 * picks are never rejected — the surface opens VideoTrimmer with the cap as
 * the max selectable window ("pick your best N seconds") and blocks submit
 * until a trim is applied.
 */
/** Feed posts: sports highlights, hard cap at 90 seconds. */
export const POST_MAX_DURATION_S = 90;
/** Stories are short-form: hard cap at 20 seconds. */
export const STORY_MAX_DURATION_S = 20;
/** Team-chat clips: same cap as posts today, but an independent knob. */
export const CHAT_VIDEO_MAX_DURATION_S = 90;

/**
 * Upload size cap. MUST equal the server-signed Cloudinary max_bytes in
 * server/src/routes/uploads.ts (enforced by
 * app/__tests__/video-upload-limits.contract.test.ts).
 */
export const MAX_VIDEO_SIZE_MB = 150;
export const MAX_VIDEO_SIZE_BYTES = 150 * 1024 * 1024;

/**
 * Pick-time sanity ceiling — NOT the upload cap.
 *
 * The upload cap above applies to the bytes we actually send, i.e. AFTER
 * `prepareVideoForUpload` re-encodes at VIDEO_TARGET_BITRATE_BPS. Every pick
 * surface used to gate the freshly-picked file against MAX_VIDEO_SIZE_BYTES,
 * which compares PRE-compression bytes to a POST-compression limit. That is the
 * wrong comparison at the wrong time: iOS exports a 1080p clip at roughly
 * 14-16 Mbps, so a 90s highlight lands around 160-180MB and was rejected at the
 * picker — even though POST_MAX_DURATION_S explicitly allows 90s and
 * compression would have brought it to ~45MB (90s x 4 Mbps). It also fought the
 * documented duration policy above: over-limit picks are supposed to open the
 * trimmer, not get bounced.
 *
 * The real post-compression bound is duration, and duration is already enforced
 * (trimmer + the POST_MAX_DURATION_S submit gate), and `prepareVideoForUpload`
 * still re-validates the final asset against MAX_VIDEO_SIZE_BYTES before it is
 * uploaded — that is the authoritative gate. So all a pick-time byte check
 * should do is refuse a pathological pick (a multi-GB 4K movie) before we spend
 * minutes trimming and transcoding it. 600MB clears the ~180MB worst case for a
 * 90s 1080p export with room to spare, and still leaves headroom for a ~5 minute
 * pick that the trimmer will cut down.
 */
export const MAX_PICKED_VIDEO_SIZE_MB = 600;
export const MAX_PICKED_VIDEO_SIZE_BYTES = MAX_PICKED_VIDEO_SIZE_MB * 1024 * 1024;

/**
 * Upload encode target: preserve 1080p detail while bounding transfer bytes.
 * Manual mode avoids the encoder's aggressive auto bitrate clamp. At 4 Mbps,
 * 20 seconds is ~10 MB and 90 seconds ~45 MB before audio/container overhead.
 * This is a target, not a guaranteed output size; always inspect final bytes.
 */
export const VIDEO_TARGET_BITRATE_BPS = 4_000_000;
/** Encode only when estimated payload savings exceed 20%, excluding tiny clips. */
export const VIDEO_BITRATE_HEADROOM = 1.25;

/**
 * Resolution ceiling (long edge, px). A clip taller/wider than this is
 * downscaled to 1080p by the compressor; a clip already at or under it is left
 * alone. 1920 keeps full 1080p in either orientation (1080x1920 / 1920x1080).
 * This is the "smart" half of the compression decision: we re-encode a video
 * when it is genuinely too big (over the upload cap) OR too large on screen
 * (4K/1440p), and skip the transcode when it is already a lean 1080p clip.
 */
export const VIDEO_MAX_LONG_EDGE_PX = 1920;

/**
 * Client-side compression threshold.
 *
 * Videos below this size are usually already small enough after the picker's
 * export preset and do not need another compression pass before upload.
 */
export const VIDEO_COMPRESSION_THRESHOLD_MB = 3;
export const VIDEO_COMPRESSION_THRESHOLD_BYTES = VIDEO_COMPRESSION_THRESHOLD_MB * 1024 * 1024;

export function isNativeVideoTrimSupported(platform: string): boolean {
  return platform === 'ios' || platform === 'android';
}
