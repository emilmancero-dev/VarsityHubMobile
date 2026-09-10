import * as ImagePicker from 'expo-image-picker';

/**
 * Single source of truth for the ImagePicker `videoExportPreset` across every
 * capture surface (enforced by video-capture-parity.contract.test.ts).
 *
 * ROOT-CAUSE FIX (2026-09-09): this was `H264_1920x1080`, which forced iOS to
 * run a FULL AVAssetExportSession re-encode of every picked/recorded video to
 * 1080p — the single slowest step of an upload, and it ran on the OS side
 * before any app code, on EVERY upload. Expo's own default here is
 * `Passthrough` (no re-encode); we now use it. The picker returns the source
 * as-is (camera-native or library original) essentially instantly.
 *
 * Quality is preserved or better: Passthrough keeps the untouched source rather
 * than transcoding it (every re-encode loses a little). Size + H.264
 * normalization is still handled downstream by `prepareVideoForUpload`
 * (react-native-compressor at 1080p / VIDEO_TARGET_BITRATE_BPS) — but only when
 * a clip actually exceeds MAX_VIDEO_SIZE_BYTES, so the common case (a clip that
 * already fits) now uploads with ZERO on-device transcodes.
 *
 * Web note: a native-codec (e.g. HEVC) clip that skips the compressor is stored
 * verbatim on R2; native players handle it, some desktop browsers don't. If
 * web HEVC playback becomes an issue, normalize with a lightweight remux, not a
 * blanket re-encode.
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
 * compression would have brought it to ~68MB (90s x 6 Mbps). It also fought the
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
 * Target H.264 bitrate for compressed uploads, in bits per second.
 *
 * react-native-compressor's 'auto' mode ignores this and clamps to 1,669,000
 * bps (`maxBitrate` in its native makeVideoBitrate) no matter the resolution —
 * which is why the owner's fest clips were a genuine 1080x1920 and still looked
 * bad. utils/compressVideo.ts therefore runs 'manual' mode and passes this.
 *
 * 6 Mbps at 1080x1920@30fps is ~0.1 bits/pixel — enough for high-motion sports
 * footage, and ~3.6x what auto allowed. Size stays well inside the 150MB cap:
 * the 90s POST_MAX_DURATION_S worst case is ~68MB. Raising this further trades
 * directly against upload time on congested venue wifi, so it is a knob, not a
 * constant to bump casually.
 */
export const VIDEO_TARGET_BITRATE_BPS = 6_000_000;

/**
 * Client-side compression threshold.
 *
 * Videos below this size are usually already small enough after the picker's
 * export preset and do not need another compression pass before upload.
 */
export const VIDEO_COMPRESSION_THRESHOLD_MB = 8;
export const VIDEO_COMPRESSION_THRESHOLD_BYTES = VIDEO_COMPRESSION_THRESHOLD_MB * 1024 * 1024;

export function isNativeVideoTrimSupported(platform: string): boolean {
  return platform === 'ios' || platform === 'android';
}
