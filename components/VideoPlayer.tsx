import { useEventListener } from 'expo';
import { Image } from 'expo-image';
import { VideoView, type VideoContentFit } from 'expo-video';
import { usePlaybackLifecycle } from '@/hooks/usePlaybackLifecycle';
import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

interface VideoPlayerProps {
  uri?: string | null;
  style?: StyleProp<ViewStyle>;
  onEnd?: () => void;
  /**
   * REQUIRED — there is deliberately no default.
   *
   * Autoplay here always means autoplay WITH SOUND: `ensurePlaybackAudioSession`
   * puts the process in the `playback` category (`playsInSilentMode`, `duckOthers`)
   * permanently, and there is no mute toggle (owner decision 2026-07-16).
   *
   * That is the right behaviour on CONSUMPTION surfaces — feed, post detail,
   * stories, highlights, media lightboxes — where a fan is watching content and
   * "videos should always play right away" with sound.
   *
   * It is the WRONG behaviour on COMPOSER/PREVIEW surfaces — the create-post
   * preview, the story/video trimmers, team-contacts — where the user is
   * authoring, not watching. Blasting audio through the hardware silent switch
   * because someone picked a clip to post is not the owner's rule; pass `false`.
   *
   * Both defaults were footguns in opposite directions (a default of `true`
   * silently opted composer surfaces in; a default of `false` would silently
   * reintroduce the "video sitting at 0:00" bug on a consumption surface), and
   * the call sites split evenly 4/4 — so neither default is the narrow one.
   * Making it required moves the decision to the type checker: a new surface
   * cannot compile without stating which kind it is.
   */
  autoPlay: boolean;
  nativeControls?: boolean;
  paused?: boolean;
  contentFit?: VideoContentFit;
  /**
   * Still image shown while the video buffers, so a consumption surface shows
   * the first frame instead of a bare spinner over an empty box. Remote video
   * on a congested network can take seconds to produce its first frame; the
   * poster is already a cached image by then on any surface that rendered the
   * tile. Optional — without it the spinner-only behaviour is unchanged.
   */
  poster?: string | null;
}

export function VideoPlayer({
  uri,
  style,
  onEnd,
  autoPlay,
  nativeControls = true,
  paused,
  contentFit = 'contain',
  poster,
}: VideoPlayerProps) {
  const { player, isLoading, errorMessage, retry } = usePlaybackLifecycle(uri, {
    autoPlay,
    paused,
  });
  useEventListener(player, 'playToEnd', () => onEnd?.());

  return (
    <View style={style}>
      <VideoView
        // NOT absoluteFill: on web the RN style becomes left/right/top/bottom
        // CSS on the <video> element, and an absolutely-positioned REPLACED
        // element with auto width/height renders at its intrinsic video size
        // instead of stretching — the video overflowed its box and its native
        // controls floated over unrelated content. Explicit 100% sizes behave
        // identically on native and correctly on web.
        style={styles.videoSurface}
        player={player}
        nativeControls={nativeControls}
        contentFit={contentFit}
        allowsFullscreen
        allowsPictureInPicture
      />
      {/* Poster sits above the video surface only while it buffers, then
          unmounts so it can never cover playback. */}
      {poster && uri && isLoading && !errorMessage ? (
        <View style={[styles.videoSurface, { pointerEvents: 'none' }]}>
          <Image
            source={{ uri: poster }}
            style={StyleSheet.absoluteFill}
            contentFit={contentFit === 'contain' ? 'contain' : 'cover'}
            transition={0}
            cachePolicy="memory-disk"
          />
        </View>
      ) : null}
      {!uri ? (
        <View style={styles.overlay}>
          <Text style={styles.errorTitle}>Video unavailable</Text>
        </View>
      ) : isLoading && !errorMessage ? (
        <View style={styles.overlay}>
          <ActivityIndicator size="small" color="#fff" />
        </View>
      ) : null}
      {uri && errorMessage ? (
        <Pressable
          onPress={retry}
          style={styles.overlay}
          accessibilityRole="button"
          accessibilityLabel="Retry video playback"
        >
          <Text style={styles.errorTitle}>Video unavailable</Text>
          <Text style={styles.errorCaption}>Tap to retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  videoSurface: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: '100%',
    height: '100%',
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(15, 23, 42, 0.32)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 20,
  },
  errorTitle: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  errorCaption: {
    color: '#e2e8f0',
    fontSize: 13,
    fontWeight: '600',
  },
});

export default VideoPlayer;
