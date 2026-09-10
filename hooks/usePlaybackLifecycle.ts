import { useIsFocused } from '@react-navigation/native';
import { createVideoPlayer } from 'expo-video';
import { useReleasingSharedObject } from 'expo-modules-core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { ensurePlaybackAudioSession } from '@/utils/audioSession';
import { getVideoPlaybackSource } from '@/utils/imageUrl';
import { toUserMessage } from '@/utils/toUserMessage';

export const VIDEO_LOAD_TIMEOUT_MS = 30_000;

/** One owner for native playback intent, loading and retry on every media surface. */
export function usePlaybackLifecycle(
  uri: string | null | undefined,
  {
    autoPlay,
    paused = false,
    loop = false,
  }: { autoPlay: boolean; paused?: boolean; loop?: boolean }
) {
  const focused = useIsFocused();
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const [isLoading, setIsLoading] = useState(Boolean(uri));
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const playbackSource = useMemo(
    () => (uri ? getVideoPlaybackSource(uri, Platform.OS) : null),
    [uri]
  );
  const [replacementReset, setReplacementReset] = useState({ uri, generation: 0 });
  // Use the same releasing primitive as expo-video's hook, with an explicit
  // native-instance generation for cancelling a replacement that never settles.
  const resetCurrentSource = replacementReset.uri === uri && replacementReset.generation > 0;
  const sourceUri = resetCurrentSource ? playbackSource?.fallbackUri || uri : playbackSource?.uri;
  const player = useReleasingSharedObject(() => {
    const p = createVideoPlayer(sourceUri ? { uri: sourceUri } : null);
    p.volume = 1;
    p.muted = false;
    p.loop = loop;
    return p;
  }, [sourceUri, replacementReset.generation]);
  const eligible = Boolean(uri) && focused && appActive && !paused;
  const intent = useRef({ eligible, autoPlay });
  intent.current = { eligible, autoPlay };
  const retryAction = useRef<() => void>(() => {});

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state =>
      setAppActive(state === 'active')
    );
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    let disposed = false;
    let replacing = false;
    let replacementTimedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const clearTimer = () => {
      if (timeout) clearTimeout(timeout);
      timeout = undefined;
    };
    const fail = (error: unknown) => {
      if (disposed) return;
      clearTimer();
      setIsLoading(false);
      setErrorMessage(toUserMessage(error, 'Video unavailable'));
      try {
        player.pause();
      } catch {
        /* Player may have been released during navigation. */
      }
    };
    const loading = () => {
      setIsLoading(true);
      setErrorMessage(null);
      if (!timeout)
        timeout = setTimeout(() => {
          replacementTimedOut = replacing;
          fail(new Error('Video loading timed out. Tap to retry.'));
        }, VIDEO_LOAD_TIMEOUT_MS);
    };
    const syncStatus = (status = player.status) => {
      if (disposed || !uri) return;
      if (status === 'readyToPlay') {
        clearTimer();
        setIsLoading(false);
        setErrorMessage(null);
        if (intent.current.eligible && intent.current.autoPlay) {
          try {
            player.play();
          } catch (error) {
            fail(error);
          }
        }
      } else if (status === 'error') {
        fail(new Error('Video unavailable'));
      } else {
        loading();
      }
    };
    setErrorMessage(null);
    setIsLoading(Boolean(uri));
    const statusSubscription = player.addListener('statusChange', ({ status, error }) => {
      if (status === 'error') fail(error);
      else syncStatus(status);
    });
    // Native controls cannot leave hidden/backgrounded media playing.
    const playingSubscription = player.addListener('playingChange', ({ isPlaying }) => {
      if (isPlaying && !intent.current.eligible) player.pause();
      else if (isPlaying) ensurePlaybackAudioSession();
    });
    syncStatus(); // A local/cached asset may be ready before listeners attach.
    retryAction.current = () => {
      if (!uri || disposed) return;
      if (replacementTimedOut) {
        setReplacementReset(previous => ({ uri, generation: previous.generation + 1 }));
        return;
      }
      if (replacing) return;
      replacing = true;
      clearTimer();
      loading();
      // The SDK keys useVideoPlayer on serialized source; a UI key cannot reload it.
      // Read readiness from events: iOS resolves before its main-thread item swap.
      void player
        .replaceAsync({ uri: playbackSource?.fallbackUri || uri })
        .catch(fail)
        .finally(() => {
          replacing = false;
        });
    };
    return () => {
      disposed = true;
      clearTimer();
      retryAction.current = () => {};
      statusSubscription.remove();
      playingSubscription.remove();
    };
  }, [player, uri, playbackSource]);

  useEffect(() => {
    try {
      if (eligible && autoPlay && !errorMessage) {
        ensurePlaybackAudioSession();
        player.play();
      } else {
        player.pause();
      }
    } catch (error) {
      setIsLoading(false);
      setErrorMessage(toUserMessage(error, 'Video unavailable'));
    }
    return () => {
      try {
        player.pause();
      } catch {
        /* The native hook owns release. */
      }
    };
  }, [player, eligible, autoPlay, errorMessage]);

  const retry = useCallback(() => retryAction.current(), []);
  return { player, isLoading, errorMessage, retry };
}
