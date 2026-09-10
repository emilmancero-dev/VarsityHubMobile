import { toUserMessage } from '@/utils/toUserMessage';
/**
 * VideoTrimmer — Native Video Trimming Component
 *
 * REQUIRES: react-native-video-trim (native module)
 * This component will NOT work in Expo Go. It requires a custom dev build via EAS.
 *
 * ─── Setup Steps ───────────────────────────────────────────────────────
 *
 * 1. Install the native module (already in package.json):
 *      npx expo install react-native-video-trim
 *
 * 2. Create a custom dev build with EAS:
 *      npx eas-cli build --profile development --platform ios
 *      npx eas-cli build --profile development --platform android
 *
 *    Or for production App Store / Play Store submission:
 *      npx eas-cli build --profile production --platform ios
 *      npx eas-cli build --profile production --platform android
 *
 * 3. For local development with the custom build:
 *      npx expo start --dev-client
 *
 * ─── How It Works ──────────────────────────────────────────────────────
 *
 * - The `trim` function is lazily loaded via try/catch require().
 * - If the native module is missing (Expo Go), trim is null and the
 *   component shows an alert directing the user to use a dev build.
 * - When available, it calls react-native-video-trim's trim() with
 *   startTime/endTime in seconds, returning the trimmed file path.
 *
 * ─── EAS Build Profiles (eas.json) ────────────────────────────────────
 *
 * Ensure your eas.json has these profiles:
 *
 *   "development": {
 *     "developmentClient": true,
 *     "distribution": "internal"
 *   },
 *   "production": {
 *     "autoIncrement": true
 *   }
 *
 * ─── Post-Launch Note ──────────────────────────────────────────────────
 *
 * Video trim is fully wired up in the UI. Once the app is submitted
 * via EAS Build (not Expo Go), trimming will work automatically with
 * no code changes needed.
 * ────────────────────────────────────────────────────────────────────────
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { Image } from 'expo-image';
import { useVideoPlayer } from 'expo-video';
import { useEventListener } from 'expo';
import * as FileSystem from 'expo-file-system/legacy';
import { captureException } from '@/utils/sentry';

// Trim failures were only logged under __DEV__ (stripped in prod), so there was
// no telemetry on why real-device trimming failed. Surface them to Sentry with
// the URI scheme (not the full path — avoids leaking local file paths) + module
// availability so the cause is diagnosable.
function reportTrimFailure(stage: string, error: unknown, uri?: string) {
  const scheme = typeof uri === 'string' ? uri.split(':')[0] : 'unknown';
  captureException(
    error instanceof Error ? error : new Error(String((error as any)?.message || error)),
    {
      tags: {
        context: 'video_trim',
        stage,
        uri_scheme: scheme,
        native_module: trim ? 'present' : 'missing',
      },
    }
  );
}

function getTrimFailureMessage(error: unknown) {
  return toUserMessage(error, 'Unable to trim this video. Please try again.');
}

let trim:
  | ((
      uri: string,
      options: { startTime: number; endTime: number }
    ) => Promise<{
      success: boolean;
      outputPath?: string;
      startTime?: number;
      endTime?: number;
      duration?: number;
    }>)
  | null = null;
try {
  trim = require('react-native-video-trim').trim;
} catch {
  // Native module not available (e.g. running in Expo Go)
}

interface VideoTrimmerProps {
  uri: string;
  onTrimComplete: (trimmedUri: string) => void;
  onTrimReset: () => void;
  /**
   * Hard cap on the selectable window, in seconds. When the source clip is
   * longer, the selection initializes to the first maxDurationS seconds, the
   * handles refuse to open wider, and Apply Trim shows immediately — the
   * parent is expected to block submit until a trim lands (force-trim UX).
   */
  maxDurationS?: number;
}

const THUMB_COUNT = 10;
const FILMSTRIP_HEIGHT = 50;
const HANDLE_WIDTH = 16;
const MIN_TRIM_SECONDS = 1;
const SCREEN_PADDING = 32; // 16px each side

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function VideoTrimmer({
  uri,
  onTrimComplete,
  onTrimReset,
  maxDurationS,
}: VideoTrimmerProps) {
  const [duration, setDuration] = useState(0);
  const [thumbnails, setThumbnails] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [trimming, setTrimming] = useState(false);
  const [hasMoved, setHasMoved] = useState(false);
  const [startLabel, setStartLabel] = useState('0:00');
  const [endLabel, setEndLabel] = useState('0:00');

  const trackWidth = Dimensions.get('window').width - SCREEN_PADDING - HANDLE_WIDTH * 2;

  const leftX = useSharedValue(0);
  const rightX = useSharedValue(trackWidth);
  const leftCtx = useSharedValue(0);
  const rightCtx = useSharedValue(trackWidth);
  const durationRef = useRef(0);
  // Synchronous re-entrancy guard. `trimming` is React state, so the button's
  // `disabled` prop only engages on the NEXT render — a fast double-tap fires
  // handleTrim twice, the two native ffmpeg sessions collide, and one returns
  // "Command failed with rc 1", surfacing a spurious "Trim Failed" alert.
  const trimInFlightRef = useRef(false);
  // Range of the last successfully applied trim. Re-tapping Apply Trim without
  // moving the handles is a no-op, not a failure.
  const appliedRangeRef = useRef<{ startMs: number; endMs: number } | null>(null);

  // Prepare URI for ffmpeg (handle ph:// iOS PhotoKit URIs)
  const [processableUri, setProcessableUri] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (Platform.OS === 'ios' && uri.startsWith('ph://')) {
        // Copy from PhotoKit to a temp file
        const dest = `${FileSystem.cacheDirectory}trim_input_${Date.now()}.mp4`;
        try {
          await FileSystem.copyAsync({ from: uri, to: dest });
          if (!cancelled) setProcessableUri(dest);
        } catch (e) {
          if (__DEV__) console.warn('[VideoTrimmer] Failed to copy ph:// URI:', e);
          reportTrimFailure('ph_copy', e, uri);
          if (!cancelled) setProcessableUri(uri);
        }
      } else {
        setProcessableUri(uri);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [uri]);

  // Create a player to read duration and generate thumbnails
  const player = useVideoPlayer(uri, p => {
    p.muted = true;
  });

  // Clip is longer than the allowed window — trimming is mandatory, not optional.
  const overLimit = maxDurationS != null && duration > maxDurationS + 0.25;

  useEventListener(player, 'statusChange', ({ status }) => {
    if (status === 'readyToPlay' && player.duration > 0) {
      // Always update duration ref when available
      if (durationRef.current <= 0) {
        const dur = player.duration;
        setDuration(dur);
        durationRef.current = dur;
        if (maxDurationS != null && dur > maxDurationS + 0.25) {
          // Initialize the selection to the first maxDurationS seconds and
          // surface Apply Trim immediately — the full clip is not a valid choice.
          rightX.value = (maxDurationS / dur) * trackWidth;
          setEndLabel(formatTime(maxDurationS));
          setHasMoved(true);
        } else {
          rightX.value = trackWidth;
          setEndLabel(formatTime(dur));
        }
      }

      // Generate thumbnails only once
      if (thumbnails.length === 0) {
        const dur = durationRef.current > 0 ? durationRef.current : player.duration;
        const times = Array.from({ length: THUMB_COUNT }, (_, i) =>
          THUMB_COUNT > 1 ? (i / (THUMB_COUNT - 1)) * dur : 0
        );

        player
          .generateThumbnailsAsync(times, { maxHeight: FILMSTRIP_HEIGHT })
          .then(thumbs => {
            setThumbnails(thumbs);
            setLoading(false);
          })
          .catch(e => {
            if (__DEV__) console.warn('[VideoTrimmer] Thumbnail generation failed:', e);
            reportTrimFailure('thumbnail_gen', e, uri);
            setLoading(false);
          });
      }
    }
  });

  const updateLabels = useCallback(
    (lx: number, rx: number) => {
      if (durationRef.current <= 0) return;
      const start = (lx / trackWidth) * durationRef.current;
      const end = (rx / trackWidth) * durationRef.current;
      setStartLabel(formatTime(Math.max(0, start)));
      setEndLabel(formatTime(Math.min(durationRef.current, end)));
    },
    [trackWidth]
  );

  const markMoved = useCallback(() => setHasMoved(true), []);

  // Minimum gap in pixels
  const minGapPx = useMemo(() => {
    if (duration <= 0) return 20;
    return (MIN_TRIM_SECONDS / duration) * trackWidth;
  }, [duration, trackWidth]);

  // Maximum gap in pixels — the duration cap expressed as handle distance.
  const maxGapPx = useMemo(() => {
    if (duration <= 0 || maxDurationS == null || duration <= maxDurationS) return trackWidth;
    return (maxDurationS / duration) * trackWidth;
  }, [duration, maxDurationS, trackWidth]);

  // Left handle gesture
  const leftGesture = Gesture.Pan()
    .activeOffsetX([-5, 5])
    .onStart(() => {
      leftCtx.value = leftX.value;
    })
    .onUpdate(e => {
      const raw = leftCtx.value + e.translationX;
      // Window stays within [minGapPx, maxGapPx] of the other handle.
      const clamped = Math.max(0, rightX.value - maxGapPx, Math.min(raw, rightX.value - minGapPx));
      leftX.value = clamped;
      runOnJS(updateLabels)(clamped, rightX.value);
      runOnJS(markMoved)();
    });

  // Right handle gesture
  const rightGesture = Gesture.Pan()
    .activeOffsetX([-5, 5])
    .onStart(() => {
      rightCtx.value = rightX.value;
    })
    .onUpdate(e => {
      const raw = rightCtx.value + e.translationX;
      const clamped = Math.min(
        trackWidth,
        leftX.value + maxGapPx,
        Math.max(raw, leftX.value + minGapPx)
      );
      rightX.value = clamped;
      runOnJS(updateLabels)(leftX.value, clamped);
      runOnJS(markMoved)();
    });

  // Animated styles
  const leftDimStyle = useAnimatedStyle(() => ({
    width: leftX.value,
  }));

  const rightDimStyle = useAnimatedStyle(() => ({
    width: trackWidth - rightX.value,
  }));

  const selectedStyle = useAnimatedStyle(() => ({
    left: leftX.value,
    width: rightX.value - leftX.value,
  }));

  const leftHandleStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: leftX.value - HANDLE_WIDTH }],
  }));

  const rightHandleStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: rightX.value }],
  }));

  const handleReset = useCallback(() => {
    leftX.value = 0;
    appliedRangeRef.current = null;
    setStartLabel('0:00');
    const dur = durationRef.current;
    if (maxDurationS != null && dur > maxDurationS + 0.25) {
      // Over the cap there is no "full clip" to reset to — go back to the
      // first maxDurationS window and keep Apply Trim visible.
      rightX.value = (maxDurationS / dur) * trackWidth;
      setEndLabel(formatTime(maxDurationS));
      setHasMoved(true);
    } else {
      rightX.value = trackWidth;
      setEndLabel(formatTime(dur));
      setHasMoved(false);
    }
    onTrimReset();
  }, [leftX, rightX, trackWidth, onTrimReset, maxDurationS]);

  const handleTrim = useCallback(async () => {
    // Use state duration, falling back to ref (set from player) if state hasn't updated yet
    const dur = duration > 0 ? duration : durationRef.current;

    if (!processableUri || dur <= 0) {
      Alert.alert('Not Ready', 'Video is still loading. Please wait a moment and try again.');
      return;
    }

    if (!trim) {
      Alert.alert(
        'Development Build Required',
        'Video trimming requires a custom development build. It is not supported in Expo Go.'
      );
      return;
    }

    // Bail out synchronously on a double-tap. `trimming` state (and the button's
    // `disabled`) only takes effect after a re-render, so without this a rapid
    // second tap starts a concurrent native ffmpeg session and one of them dies
    // with "Command failed with rc 1" — a spurious "Trim Failed" alert.
    if (trimInFlightRef.current) return;

    const startSec = (leftX.value / trackWidth) * dur;
    const endSec = (rightX.value / trackWidth) * dur;
    // react-native-video-trim expects milliseconds
    const startMs = Math.round(startSec * 1000);
    const endMs = Math.round(endSec * 1000);

    // Re-tapping Apply Trim on a range that was already applied is a no-op, not
    // a failure. Tolerance absorbs sub-pixel handle rounding.
    const applied = appliedRangeRef.current;
    if (
      applied &&
      Math.abs(applied.startMs - startMs) <= 50 &&
      Math.abs(applied.endMs - endMs) <= 50
    ) {
      Alert.alert(
        'Already Trimmed',
        'This clip is already trimmed to the selected range. Move the handles to trim it differently, or tap Reset to start over.'
      );
      return;
    }

    trimInFlightRef.current = true;
    setTrimming(true);

    try {
      const result = await trim(processableUri, {
        startTime: startMs,
        endTime: endMs,
      });

      if (result.success && result.outputPath) {
        // The native module reports the duration it actually cut to. Compare
        // against what we requested — if the native trim silently no-ops
        // (e.g. ffmpeg -to being ignored as an input option on some builds),
        // "success" is still true but the output is the untrimmed length.
        const requestedMs = endMs - startMs;
        const actualMs =
          typeof result.duration === 'number'
            ? result.duration
            : typeof result.endTime === 'number' && typeof result.startTime === 'number'
              ? result.endTime - result.startTime
              : null;
        if (actualMs !== null && Math.abs(actualMs - requestedMs) > 500) {
          if (__DEV__) {
            console.warn(
              `[VideoTrimmer] Native trim duration mismatch — requested ${requestedMs}ms, got ${actualMs}ms`
            );
          }
          reportTrimFailure(
            'trim_duration_mismatch',
            new Error(
              `Native trim returned success but output duration (${actualMs}ms) does not match requested range (${requestedMs}ms, start=${startMs} end=${endMs})`
            ),
            processableUri ?? undefined
          );
          // Do NOT silently deliver an untrimmed clip — let the user decide.
          const outputPath = result.outputPath;
          Alert.alert(
            'Trim May Not Have Applied',
            'The trimmed clip does not match the length you selected. Use it anyway, or try trimming again.',
            [
              { text: 'Try Again', style: 'cancel' },
              {
                text: 'Use Anyway',
                onPress: () => {
                  appliedRangeRef.current = { startMs, endMs };
                  onTrimComplete(outputPath);
                },
              },
            ]
          );
          return;
        }
        appliedRangeRef.current = { startMs, endMs };
        onTrimComplete(result.outputPath);
      } else {
        Alert.alert('Trim Failed', 'Could not trim the video. Please try again.');
        if (__DEV__) console.warn('[VideoTrimmer] Trim failed:', result);
        reportTrimFailure(
          'trim_result',
          new Error('react-native-video-trim returned an unsuccessful result'),
          processableUri ?? undefined
        );
      }
    } catch (e: any) {
      Alert.alert('Trim Failed', getTrimFailureMessage(e));
      if (__DEV__) console.warn('[VideoTrimmer] Trim error:', e);
      reportTrimFailure('trim_error', e, processableUri ?? undefined);
    } finally {
      // Runs on every path (success, mismatch early-return, throw), so a failed
      // trim never wedges the button.
      trimInFlightRef.current = false;
      setTrimming(false);
    }
  }, [processableUri, duration, leftX, rightX, trackWidth, onTrimComplete]);

  const clipDuration = useMemo(() => {
    if (duration <= 0) return 0;
    const startSec = (leftX.value / trackWidth) * duration;
    const endSec = (rightX.value / trackWidth) * duration;
    return Math.max(0, endSec - startSec);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [duration, startLabel, endLabel, trackWidth]);

  const thumbWidth = trackWidth / THUMB_COUNT;

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Trim Video</Text>
        {hasMoved && (
          <Pressable onPress={handleReset}>
            <Text style={styles.resetText}>Reset</Text>
          </Pressable>
        )}
      </View>

      {overLimit && (
        <Text style={styles.capNotice}>
          Clips are limited to {formatTime(maxDurationS!)} — drag the handles to pick your best
          moment, then tap Apply Trim.
        </Text>
      )}

      {/* Filmstrip */}
      <View style={[styles.filmstripContainer, { width: trackWidth + HANDLE_WIDTH * 2 }]}>
        {/* Left handle */}
        <GestureDetector gesture={leftGesture}>
          <Animated.View style={[styles.handle, styles.leftHandle, leftHandleStyle]}>
            <View style={styles.handleBar} />
          </Animated.View>
        </GestureDetector>

        {/* Filmstrip track */}
        <View style={[styles.filmstrip, { width: trackWidth, marginLeft: HANDLE_WIDTH }]}>
          {loading ? (
            <View style={styles.loadingRow}>
              {Array.from({ length: THUMB_COUNT }).map((_, i) => (
                <View key={i} style={[styles.thumbPlaceholder, { width: thumbWidth }]}>
                  {i === Math.floor(THUMB_COUNT / 2) && (
                    <ActivityIndicator size="small" color="#999" />
                  )}
                </View>
              ))}
            </View>
          ) : (
            <View style={styles.thumbRow}>
              {thumbnails.map((thumb, i) => (
                <Image
                  key={i}
                  source={thumb}
                  style={[styles.thumb, { width: thumbWidth }]}
                  contentFit="cover"
                />
              ))}
            </View>
          )}

          {/* Dim overlays */}
          <Animated.View style={[styles.dimOverlay, styles.dimLeft, leftDimStyle]} />
          <Animated.View style={[styles.dimOverlay, styles.dimRight, rightDimStyle]} />

          {/* Selected region border */}
          <Animated.View style={[styles.selectedBorder, selectedStyle]} />
        </View>

        {/* Right handle */}
        <GestureDetector gesture={rightGesture}>
          <Animated.View style={[styles.handle, styles.rightHandle, rightHandleStyle]}>
            <View style={styles.handleBar} />
          </Animated.View>
        </GestureDetector>
      </View>

      {/* Time labels */}
      <View style={styles.timeRow}>
        <Text style={styles.timeLabel}>{startLabel}</Text>
        <Text style={styles.durationLabel}>Duration: {formatTime(clipDuration)}</Text>
        <Text style={styles.timeLabel}>{endLabel}</Text>
      </View>

      {/* Apply Trim button */}
      {hasMoved && (
        <Pressable
          style={[styles.trimButton, trimming && styles.trimButtonDisabled]}
          onPress={handleTrim}
          disabled={trimming}
        >
          {trimming ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={styles.trimButtonText}>✂ Apply Trim</Text>
          )}
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  headerTitle: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  resetText: {
    color: '#4A90D9',
    fontSize: 14,
  },
  capNotice: {
    color: '#FFD700',
    fontSize: 12,
    marginBottom: 8,
  },
  filmstripContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    height: FILMSTRIP_HEIGHT,
  },
  filmstrip: {
    height: FILMSTRIP_HEIGHT,
    overflow: 'hidden',
    borderRadius: 4,
    backgroundColor: '#1a1a1a',
  },
  loadingRow: {
    flexDirection: 'row',
    height: FILMSTRIP_HEIGHT,
  },
  thumbPlaceholder: {
    height: FILMSTRIP_HEIGHT,
    backgroundColor: '#2a2a2a',
    justifyContent: 'center',
    alignItems: 'center',
  },
  thumbRow: {
    flexDirection: 'row',
    height: FILMSTRIP_HEIGHT,
  },
  thumb: {
    height: FILMSTRIP_HEIGHT,
  },
  dimOverlay: {
    position: 'absolute',
    top: 0,
    height: FILMSTRIP_HEIGHT,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  dimLeft: {
    left: 0,
  },
  dimRight: {
    right: 0,
  },
  selectedBorder: {
    position: 'absolute',
    top: 0,
    height: FILMSTRIP_HEIGHT,
    borderWidth: 2,
    borderColor: '#FFD700',
    borderRadius: 4,
  },
  handle: {
    width: HANDLE_WIDTH,
    height: FILMSTRIP_HEIGHT + 12,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#FFD700',
    borderRadius: 4,
    position: 'absolute',
    zIndex: 10,
  },
  leftHandle: {
    left: HANDLE_WIDTH,
    borderTopRightRadius: 0,
    borderBottomRightRadius: 0,
  },
  rightHandle: {
    left: HANDLE_WIDTH,
    borderTopLeftRadius: 0,
    borderBottomLeftRadius: 0,
  },
  handleBar: {
    width: 3,
    height: 20,
    backgroundColor: '#000',
    borderRadius: 1.5,
  },
  timeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 6,
  },
  timeLabel: {
    color: '#ccc',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
  },
  durationLabel: {
    color: '#999',
    fontSize: 12,
  },
  trimButton: {
    marginTop: 10,
    alignSelf: 'center',
    backgroundColor: '#4A90D9',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    minWidth: 140,
    alignItems: 'center',
  },
  trimButtonDisabled: {
    opacity: 0.6,
  },
  trimButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
});
