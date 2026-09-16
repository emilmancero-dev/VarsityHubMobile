import {
  persistPreparedMedia,
  deleteConfirmedMediaDraft,
  isOwnedMediaDraft,
} from './mediaDraftFiles';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

import {
  MAX_VIDEO_SIZE_BYTES,
  MAX_VIDEO_SIZE_MB,
  POST_MAX_DURATION_S,
  VIDEO_COMPRESSION_THRESHOLD_MB,
  VIDEO_COMPRESSION_THRESHOLD_BYTES,
  VIDEO_MAX_LONG_EDGE_PX,
  VIDEO_TARGET_BITRATE_BPS,
  VIDEO_BITRATE_HEADROOM,
} from '@/constants/video';
import { captureException } from '@/utils/sentry';
import { throwIfUploadAborted } from './resumableUpload';

// Module-level dynamic require (OfflineBanner pattern): resolves at bundle
// time, never crashes binaries that predate the native module.
let CompressorVideo: {
  compress: (uri: string, opts: object, onProgress?: (fraction: number) => void) => Promise<string>;
  cancelCompression?: (id: string) => void;
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
 * Library acquisition preserves source bytes; this is the only encoding pass.
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
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal
): Promise<string> {
  throwIfUploadAborted(signal);
  if (!CompressorVideo) {
    if (!reportedModuleMissing) {
      reportedModuleMissing = true;
      captureException(new Error('react-native-compressor native module unavailable'), {
        tags: { context: 'video_compress', stage: 'module_missing' },
      });
    }
    return uri;
  }
  let cancellationId: string | undefined;
  let reportedCancelFailure = false;
  const cancel = () => {
    // Existing Android binaries cancel the coroutine before it can settle the
    // JS promise. Keep the encoder slot until normal completion, then reject
    // the cancelled preparation without persisting or uploading its result.
    // An OTA cannot repair that native implementation.
    if (Platform.OS === 'android') return;
    if (!cancellationId) return;
    try {
      CompressorVideo?.cancelCompression?.(cancellationId);
    } catch (error) {
      if (!reportedCancelFailure) {
        reportedCancelFailure = true;
        captureException(error, { tags: { context: 'video_compress', stage: 'cancel_failed' } });
      }
    }
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    throwIfUploadAborted(signal);
    // Progress arrives many times per second on both platforms; collapse it to
    // whole-percent transitions so the UI does at most 100 state updates per
    // pass instead of one per encoded frame. Deliberately NOT using the
    // package's own `progressDivider`: its native filter is
    // `round(pct) % divider === 0`, so any percentage the encoder skips over is
    // silently dropped and the bar can stall for good.
    let lastReportedPct = -1;
    const forward =
      onProgress || signal
        ? (fraction: number) => {
            if (signal?.aborted) {
              // Native registration can lag the JS cancellation-ID callback.
              // A late progress event proves the job exists: retry its cancel,
              // but never publish progress from a cancelled preparation.
              cancel();
              return;
            }
            const pct = Math.round(clampFraction(fraction) * 100);
            if (pct === lastReportedPct) return;
            lastReportedPct = pct;
            onProgress?.(pct / 100);
          }
        : undefined;
    const compressed: string = await CompressorVideo.compress(
      uri,
      {
        // Manual bitrate preserves detail without the auto-mode low bitrate clamp.
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
        ...(signal
          ? {
              getCancellationId: (id: string) => {
                cancellationId = id;
                // The installed JS wrapper invokes this BEFORE starting native work.
                throwIfUploadAborted(signal);
              },
            }
          : {}),
      },
      forward
    );
    throwIfUploadAborted(signal);
    return compressed ?? uri;
  } catch (e) {
    // User cancellation is not an encoder failure and must never fall back to
    // the original video. Await native settlement so encoders cannot overlap.
    throwIfUploadAborted(signal);
    // Compression failed mid-way — fall back to the original, but make the
    // failure visible (an empty catch here hid a 3-month compression outage).
    captureException(e instanceof Error ? e : new Error(String(e)), {
      tags: { context: 'video_compress', stage: 'compress_failed' },
    });
    return uri;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

export async function getVideoFileSize(uri: string): Promise<number> {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    if (info.exists && !info.isDirectory && Number.isFinite(info.size)) {
      return info.size;
    }
  } catch {
    // Callers distinguish unreadable files from valid nonzero sizes.
  }
  return 0;
}

type PrepareVideoForUploadOptions = {
  signal?: AbortSignal;
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
async function readVideoMetadata(uri: string): Promise<{ longEdge: number; duration: number }> {
  if (!getVideoMetaData) return { longEdge: 0, duration: 0 };
  try {
    const meta = await getVideoMetaData(uri);
    const w = typeof meta?.width === 'number' ? meta.width : 0;
    const h = typeof meta?.height === 'number' ? meta.height : 0;
    return {
      longEdge: Math.max(w, h),
      duration: Number.isFinite(meta?.duration) ? meta.duration : 0,
    };
  } catch {
    return { longEdge: 0, duration: 0 };
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
 * over-spec — it exceeds the 150MB upload cap, has a bitrate above 5Mbps on
 * a clip larger than 3MB, OR it is larger than
 * 1080p on screen (a 4K/1440p clip, which is needless bandwidth for phone-viewed
 * highlights). A clip that already fits AND is already <= 1080p uploads as-is at
 * capture quality when its bitrate is also efficient — the on-device transcode is
 * skipped. The picker runs Passthrough, so this is the ONLY transcode a video
 * ever gets, and only when it earns one. Callers may force a lower size bound
 * via `compressionThresholdBytes`.
 *
 * Trade-off: a skipped clip keeps its source codec (e.g. HEVC). Native players
 * handle it; universal desktop-web playback requires a compatible encoded
 * derivative. Remuxing alone does not change an unsupported codec.
 */
async function prepareVideoUncached(
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
  throwIfUploadAborted(options.signal);
  if (!Number.isFinite(originalSizeBytes) || originalSizeBytes <= 0) {
    throw new Error('Could not read the selected video file. Please select it again.');
  }
  const metadata = await readVideoMetadata(uri);
  throwIfUploadAborted(options.signal);
  // Match the composer/trimmer tolerance for frame and AAC/container rounding.
  if (metadata.duration > POST_MAX_DURATION_S + 0.25) {
    throw new Error(
      `Video is too long. Trim it to ${POST_MAX_DURATION_S} seconds before uploading.`
    );
  }
  if (originalSizeBytes > VIDEO_COMPRESSION_THRESHOLD_BYTES && metadata.duration <= 0) {
    throw new Error(
      'Could not read video details to prepare this upload. Please select the video again.'
    );
  }
  const longEdgePx = metadata.longEdge;
  const overBitrate =
    metadata.duration > 0 &&
    originalSizeBytes > VIDEO_COMPRESSION_THRESHOLD_BYTES &&
    (originalSizeBytes * 8) / metadata.duration > VIDEO_TARGET_BITRATE_BPS * VIDEO_BITRATE_HEADROOM;

  const overSize = originalSizeBytes <= 0 || originalSizeBytes >= sizeThresholdBytes;
  const overResolution = longEdgePx > VIDEO_MAX_LONG_EDGE_PX;

  // In-spec clip (known size that fits AND <= 1080p) → upload as-is, no
  // transcode if bitrate is also efficient. Unknown size is rejected above;
  // unavailable duration/resolution cannot trigger a speculative transcode.
  if (!overSize && !overResolution && !overBitrate) {
    return {
      uri,
      originalSizeBytes,
      finalSizeBytes: originalSizeBytes,
      wasCompressed: false,
    };
  }

  const compressedUri = await compressVideoSafe(uri, options.onCompressProgress, options.signal);
  if (compressedUri === uri && (overBitrate || overResolution)) {
    throw new Error(
      'Could not prepare this video for upload. Please retry or select a shorter clip.'
    );
  }
  let finalUri = compressedUri;
  let finalSizeBytes =
    compressedUri !== uri ? await getVideoFileSize(compressedUri) : originalSizeBytes;
  throwIfUploadAborted(options.signal);

  if (!Number.isFinite(finalSizeBytes) || finalSizeBytes <= 0) {
    throw new Error('Could not read the prepared video file. Please select it again.');
  }

  // Re-encoding already-compressed input can produce a LARGER file. Never
  // send extra bytes solely for size reduction. Required resolution normalization
  // keeps its output, subject to final size/bitrate gates below.
  if (
    compressedUri !== uri &&
    originalSizeBytes > 0 &&
    finalSizeBytes > 0 &&
    finalSizeBytes >= originalSizeBytes &&
    !overResolution
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
    const err: Error & { code?: string } = new Error(
      `Video is too large after processing (${Math.round(finalSizeBytes / (1024 * 1024))}MB) — the limit is ${MAX_VIDEO_SIZE_MB}MB. Trim it shorter and try again.`
    );
    err.code = 'VIDEO_TOO_LARGE';
    throw err;
  }

  // Verify savings using actual output bytes, including audio/container data.
  // A resolved encoder promise does not prove that its bitrate settings were applied.
  const transferBudget = Math.max(
    VIDEO_COMPRESSION_THRESHOLD_BYTES,
    (metadata.duration * VIDEO_TARGET_BITRATE_BPS * VIDEO_BITRATE_HEADROOM) / 8
  );
  if (overBitrate && finalSizeBytes > transferBudget) {
    throw new Error('Video is still too large after processing. Please trim it shorter and retry.');
  }

  return {
    uri: finalUri,
    originalSizeBytes,
    finalSizeBytes,
    wasCompressed: finalUri !== uri,
  };
}

type PreparedVideo = Awaited<ReturnType<typeof prepareVideoUncached>>;
type PreparedEntry = { key: string; result: PreparedVideo; outputModified?: number };
const PREPARED_VIDEO_CACHE_KEY = 'media:prepared-videos:v1';
let preparationQueue: Promise<unknown> = Promise.resolve();

async function readPreparedEntries(): Promise<PreparedEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(PREPARED_VIDEO_CACHE_KEY);
    const entries: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(entries)) return [];
    return entries
      .filter(
        (entry): entry is PreparedEntry =>
          typeof entry?.key === 'string' &&
          typeof entry?.result?.uri === 'string' &&
          Number.isFinite(entry?.result?.finalSizeBytes) &&
          entry.result.finalSizeBytes > 0
      )
      .slice(-5);
  } catch (error) {
    captureException(error, { tags: { context: 'video_preparation_cache', stage: 'read' } });
    return [];
  }
}

/** Serialize encoder work and reuse the same prepared file across retries/restarts. */
export function prepareVideoForUpload(
  uri: string,
  options: PrepareVideoForUploadOptions = {}
): Promise<PreparedVideo> {
  const work = preparationQueue.then(async () => {
    throwIfUploadAborted(options.signal);
    if (Platform.OS === 'web') {
      // Browser Blob sources cannot be inspected by the native FileSystem SDK.
      // Preserve original codec; the verified server pipeline makes playback derivatives.
      const response = await fetch(uri, { signal: options.signal });
      throwIfUploadAborted(options.signal);
      if (!response.ok)
        throw new Error('Could not read the selected video file. Please select it again.');
      const size = (await response.blob()).size;
      throwIfUploadAborted(options.signal);
      if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_VIDEO_SIZE_BYTES) {
        throw new Error(
          `Video is unreadable or too large. The upload limit is ${MAX_VIDEO_SIZE_MB} MB.`
        );
      }
      return { uri, originalSizeBytes: size, finalSizeBytes: size, wasCompressed: false };
    }
    const source = await FileSystem.getInfoAsync(uri);
    throwIfUploadAborted(options.signal);
    if (!source.exists || source.isDirectory || !Number.isFinite(source.size) || source.size <= 0) {
      throw new Error('Could not read the selected video file. Please select it again.');
    }
    // Without a modification time there is no stable source identity: do not
    // reuse a potentially stale encode. Trimmed/replaced files get new keys.
    const key = Number.isFinite(source.modificationTime)
      ? JSON.stringify([
          uri,
          source.size,
          source.modificationTime,
          options.compressionThresholdBytes ?? MAX_VIDEO_SIZE_BYTES,
          VIDEO_TARGET_BITRATE_BPS,
          VIDEO_MAX_LONG_EDGE_PX,
          VIDEO_BITRATE_HEADROOM,
          VIDEO_COMPRESSION_THRESHOLD_BYTES,
        ])
      : null;
    const entries = key ? await readPreparedEntries() : [];
    throwIfUploadAborted(options.signal);
    const cached = entries.find(
      entry =>
        entry.key === key ||
        (entry.result.uri === uri &&
          entry.result.finalSizeBytes === source.size &&
          Number.isFinite(entry.outputModified) &&
          entry.outputModified === source.modificationTime &&
          (() => {
            try {
              const policy = JSON.parse(entry.key);
              return (
                policy[3] === (options.compressionThresholdBytes ?? MAX_VIDEO_SIZE_BYTES) &&
                policy[4] === VIDEO_TARGET_BITRATE_BPS &&
                policy[5] === VIDEO_MAX_LONG_EDGE_PX &&
                policy[6] === VIDEO_BITRATE_HEADROOM &&
                policy[7] === VIDEO_COMPRESSION_THRESHOLD_BYTES
              );
            } catch {
              return false;
            }
          })())
    );
    if (cached) {
      const output = await FileSystem.getInfoAsync(cached.result.uri);
      throwIfUploadAborted(options.signal);
      const outputSize = output.exists && !output.isDirectory ? output.size : 0;
      if (
        outputSize === cached.result.finalSizeBytes &&
        outputSize <= MAX_VIDEO_SIZE_BYTES &&
        output.exists &&
        Number.isFinite(cached.outputModified) &&
        cached.outputModified === output.modificationTime
      ) {
        return cached.result;
      }
    }
    const prepared = await prepareVideoUncached(uri, options);
    throwIfUploadAborted(options.signal);
    const result = { ...prepared, uri: await persistPreparedMedia(prepared.uri) };
    let indexed = false;
    try {
      if (key) {
        // Once the durable copy exists, finish indexing it even if cancellation
        // arrived during the copy/stat. Retry and confirmed-save cleanup must
        // still be able to find it. The final abort check prevents upload.
        // Index eviction never deletes source/output files: drafts or active
        // resumable uploads may still reference them. Confirmed saves own cleanup.
        const output = await FileSystem.getInfoAsync(result.uri);
        const outputModified = output.exists ? output.modificationTime : undefined;
        const next = [
          ...entries.filter(entry => entry.key !== key),
          { key, result, outputModified },
        ].slice(-5);
        try {
          await AsyncStorage.setItem(PREPARED_VIDEO_CACHE_KEY, JSON.stringify(next));
          indexed = true;
        } catch (error) {
          captureException(error, { tags: { context: 'video_preparation_cache', stage: 'write' } });
        }
      }
    } finally {
      if (
        options.signal?.aborted &&
        !indexed &&
        result.uri !== prepared.uri &&
        isOwnedMediaDraft(result.uri)
      ) {
        // Only this call's new, unreferenced copy is disposable. A reused file
        // may belong to another draft; never delete it on cancellation.
        try {
          await FileSystem.deleteAsync(result.uri, { idempotent: true });
        } catch (error) {
          captureException(error, {
            tags: { context: 'video_preparation_cache', stage: 'cancel_cleanup' },
          });
        }
      }
      throwIfUploadAborted(options.signal);
    }
    return result;
  });
  preparationQueue = work.then(
    () => undefined,
    () => undefined
  );
  return work;
}

/** Remove only this source's owned files after confirmed server publication. */
export function cleanupConfirmedVideoDraft(sourceUri: string): Promise<void> {
  const cleanup = preparationQueue.then(async () => {
    const entries = await readPreparedEntries();
    const matches = entries.filter(entry => {
      try {
        return JSON.parse(entry.key)[0] === sourceUri;
      } catch {
        return false;
      }
    });
    for (const entry of matches) await deleteConfirmedMediaDraft(entry.result.uri);
    await deleteConfirmedMediaDraft(sourceUri);
    await AsyncStorage.setItem(
      PREPARED_VIDEO_CACHE_KEY,
      JSON.stringify(entries.filter(entry => !matches.includes(entry)))
    );
  });
  preparationQueue = cleanup.then(
    () => undefined,
    () => undefined
  );
  return cleanup;
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
