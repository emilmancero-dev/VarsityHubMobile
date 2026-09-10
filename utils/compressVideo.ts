import * as FileSystem from 'expo-file-system/legacy';

import {
  MAX_VIDEO_SIZE_BYTES,
  MAX_VIDEO_SIZE_MB,
  VIDEO_COMPRESSION_THRESHOLD_MB,
  VIDEO_MAX_LONG_EDGE_PX,
  VIDEO_TARGET_BITRATE_BPS,
} from '@/constants/video';
import { captureException } from '@/utils/sentry';

// Module-level dynamic require (OfflineBanner pattern): resolves at bundle
// time, never crashes binaries that predate the native module.
let CompressorVideo: {
  compress: (uri: string, opts: object, onProgress?: (fraction: number) => void) => Promise<string>;
} | null = null;
// getVideoMetaData reads width/height/size/duration from the file header
// natively — no transcode — so we can decide whether a clip needs compressing
// based on what it actually IS (resolution), not just its byte size.
let getVideoMetaData:
  | ((uri: string) => Promise<{ width: number; height: number; size: number; duration: number }>)
  | null = null;
try {
  const compressor = require('react-native-compressor');
  CompressorVideo = compressor.Video;
  getVideoMetaData = compressor.getVideoMetaData ?? null;
} catch {
  CompressorVideo = null;
  getVideoMetaData = null;
}

// Report the missing module once per session, not per call — old binaries
// would otherwise spam Sentry on every upload.
let reportedModuleMissing = false;

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Safe video compression wrapper.
 *
 * Uses react-native-compressor when the native module is available (i.e. in a
 * build that includes it).  Falls back to the original URI so the app never
 * crashes on binaries that predate the module — but both failure modes
 * (module missing vs. compression crashed mid-way) are reported to Sentry so
 * they are distinguishable and visible instead of silently swallowed.
 *
 * iOS also benefits from ImagePicker's videoExportPreset at the picker level,
 * so even without the compressor the file is transcoded by the OS.
 *
 * `onProgress` receives a 0..1 fraction. react-native-compressor has always
 * exposed this (third arg of Video.compress, backed by the native
 * `videoCompressProgress` event on both platforms) — we simply never passed it,
 * which is why the longest phase of an upload rendered as a frozen 0% bar. It
 * is never invoked when the native module is missing or when the compressor
 * decides not to re-encode, so callers must treat "no callback" as normal.
 */
export async function compressVideoSafe(
  uri: string,
  onProgress?: (fraction: number) => void
): Promise<string> {
  if (!CompressorVideo) {
    if (!reportedModuleMissing) {
      reportedModuleMissing = true;
      captureException(new Error('react-native-compressor native module unavailable'), {
        tags: { context: 'video_compress', stage: 'module_missing' },
      });
    }
    return uri;
  }
  try {
    // Progress arrives many times per second on both platforms; collapse it to
    // whole-percent transitions so the UI does at most 100 state updates per
    // pass instead of one per encoded frame. Deliberately NOT using the
    // package's own `progressDivider`: its native filter is
    // `round(pct) % divider === 0`, so any percentage the encoder skips over is
    // silently dropped and the bar can stall for good.
    let lastReportedPct = -1;
    const forward = onProgress
      ? (fraction: number) => {
          const pct = Math.round(clampFraction(fraction) * 100);
          if (pct === lastReportedPct) return;
          lastReportedPct = pct;
          onProgress(pct / 100);
        }
      : undefined;
    const compressed: string = await CompressorVideo.compress(
      uri,
      {
        // 'manual' — NOT 'auto'. This is the fix for "the video quality is still
        // bad even though it's 1080p" (2026-07-16).
        //
        // 'auto' hard-caps the output bitrate at 1,669,000 bps regardless of
        // resolution: see makeVideoBitrate() in the package's
        // ios/Video/VideoMain.swift and android AutoVideoCompression.kt, both of
        // which clamp to `maxBitrate = 1669000`. maxSize only ever controlled the
        // RESOLUTION, so the earlier maxSize:1920 fix (1df5d898) worked — the
        // owner's fest clips really did land at 1080x1920 — and yet they still
        // looked bad, because 1.67 Mbps over 1080x1920@30fps is ~0.027 bits per
        // pixel. On high-motion sports footage that smears and blocks.
        //
        // 'manual' honours maxSize the same way (it scales the long edge, portrait
        // included) but uses the bitrate we pass instead of the auto clamp.
        compressionMethod: 'manual',
        bitrate: VIDEO_TARGET_BITRATE_BPS,
        minimumFileSizeForCompress: 1, // compress any video (value is in MB)
        // CRITICAL: react-native-compressor defaults maxSize to 640px on the
        // longest side when omitted (see its Video/index.js), which silently
        // downscaled every >8MB upload to ~360-640p and undid the 1080p capture
        // preset. 1920 preserves 1080p for both portrait (1080x1920) and
        // landscape (1920x1080); the 150MB MAX_VIDEO_SIZE guard + post-compress
        // size check still bound the result.
        maxSize: VIDEO_MAX_LONG_EDGE_PX,
      },
      forward
    );
    return compressed ?? uri;
  } catch (e) {
    // Compression failed mid-way — fall back to the original, but make the
    // failure visible (an empty catch here hid a 3-month compression outage).
    captureException(e instanceof Error ? e : new Error(String(e)), {
      tags: { context: 'video_compress', stage: 'compress_failed' },
    });
    return uri;
  }
}

export async function getVideoFileSize(uri: string): Promise<number> {
  try {
    const info = await FileSystem.getInfoAsync(uri, { size: true } as any);
    if (info && info.exists && typeof (info as any).size === 'number') {
      return (info as any).size;
    }
  } catch {
    // Ignore size lookup failures — upload prep remains best-effort.
  }
  return 0;
}

type PrepareVideoForUploadOptions = {
  compressionThresholdBytes?: number;
  /**
   * 0..1 progress for the compression pass. Not called at all when the clip is
   * under the threshold, when the native module is missing, or when the
   * encoder finishes before emitting — treat silence as "no signal", never as
   * "stuck at 0".
   */
  onCompressProgress?: (fraction: number) => void;
};

/**
 * Read a source video's resolution (long edge, px) without transcoding.
 * Best-effort: returns 0 when the native metadata reader is unavailable (old
 * binary) or fails, so callers fall back to a size-only decision.
 */
async function getVideoLongEdgePx(uri: string): Promise<number> {
  if (!getVideoMetaData) return 0;
  try {
    const meta = await getVideoMetaData(uri);
    const w = typeof meta?.width === 'number' ? meta.width : 0;
    const h = typeof meta?.height === 'number' ? meta.height : 0;
    return Math.max(w, h);
  } catch {
    return 0;
  }
}

/**
 * Prepare the final video asset right before upload — the SINGLE decision point
 * for whether a clip gets compressed.
 *
 * We compress at the upload boundary (not pick time) so a trim operates on the
 * selected asset without an extra pass and each clip is normalized at most once.
 *
 * Smart compression policy (owner: "strong and smart, not a patch"): a video is
 * re-encoded to 1080p H.264 @ VIDEO_TARGET_BITRATE_BPS only when it is genuinely
 * over-spec — either it exceeds the 150MB upload cap (size) OR it is larger than
 * 1080p on screen (a 4K/1440p clip, which is needless bandwidth for phone-viewed
 * highlights). A clip that already fits AND is already <= 1080p uploads as-is at
 * capture quality — the on-device transcode (the slowest step of an upload) is
 * skipped. The picker runs Passthrough, so this is the ONLY transcode a video
 * ever gets, and only when it earns one. Callers may force a lower size bound
 * via `compressionThresholdBytes`.
 *
 * Trade-off: a skipped clip keeps its source codec (e.g. HEVC). Native players
 * handle it; if universal desktop-web playback is ever required, normalize with
 * a lightweight remux or a server-side derivative — never a blanket re-encode,
 * which is exactly the slowness this avoids.
 */
export async function prepareVideoForUpload(
  uri: string,
  options: PrepareVideoForUploadOptions = {}
): Promise<{
  uri: string;
  originalSizeBytes: number;
  finalSizeBytes: number;
  wasCompressed: boolean;
}> {
  const sizeThresholdBytes = options.compressionThresholdBytes ?? MAX_VIDEO_SIZE_BYTES;
  const originalSizeBytes = await getVideoFileSize(uri);
  const longEdgePx = await getVideoLongEdgePx(uri);

  const overSize = originalSizeBytes <= 0 || originalSizeBytes >= sizeThresholdBytes;
  const overResolution = longEdgePx > VIDEO_MAX_LONG_EDGE_PX;

  // In-spec clip (known size that fits AND <= 1080p) → upload as-is, no
  // transcode. Unknown size (lookup failed) is treated as over-size so the cap
  // is still enforced. Resolution is best-effort: when unreadable it is 0 and
  // the decision falls back to size alone.
  if (!overSize && !overResolution) {
    return {
      uri,
      originalSizeBytes,
      finalSizeBytes: originalSizeBytes,
      wasCompressed: false,
    };
  }

  const compressedUri = await compressVideoSafe(uri, options.onCompressProgress);
  let finalUri = compressedUri;
  let finalSizeBytes =
    compressedUri !== uri ? await getVideoFileSize(compressedUri) : originalSizeBytes;

  // Re-encoding already-compressed input can produce a LARGER file. Never
  // upload a worse asset than the one we started with.
  if (
    compressedUri !== uri &&
    originalSizeBytes > 0 &&
    finalSizeBytes > 0 &&
    finalSizeBytes >= originalSizeBytes
  ) {
    finalUri = uri;
    finalSizeBytes = originalSizeBytes;
  }

  // THIS is the authoritative upload-cap gate. Pick surfaces only apply a loose
  // sanity ceiling (MAX_PICKED_VIDEO_SIZE_BYTES) to the pre-compression file —
  // they cannot enforce MAX_VIDEO_SIZE_BYTES, because that limit is about the
  // bytes we send and those don't exist until this function has run. "too large"
  // in the message routes this through uploadErrorAlert's isSize branch.
  if (finalSizeBytes > MAX_VIDEO_SIZE_BYTES) {
    const err: any = new Error(
      `Video is too large after processing (${Math.round(finalSizeBytes / (1024 * 1024))}MB) — the limit is ${MAX_VIDEO_SIZE_MB}MB. Trim it shorter and try again.`
    );
    err.code = 'VIDEO_TOO_LARGE';
    throw err;
  }

  return {
    uri: finalUri,
    originalSizeBytes,
    finalSizeBytes,
    wasCompressed: finalUri !== uri,
  };
}

/**
 * Size-aware upload timeout: 6s per MB (≈1.4 Mbps sustained), floored at the
 * historical 5-minute default and capped at 15 minutes. A fixed 5-minute
 * timeout made 150MB uploads mathematically impossible on slow cellular.
 */
export function uploadTimeoutMsForSize(sizeBytes: number): number {
  if (!sizeBytes || sizeBytes <= 0) return 300_000;
  const scaled = Math.round(sizeBytes / (1024 * 1024)) * 6_000;
  return Math.min(900_000, Math.max(300_000, scaled));
}

export { VIDEO_COMPRESSION_THRESHOLD_MB };
