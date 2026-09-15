import { Colors } from '@/constants/Colors';
import { useColorScheme } from '@/hooks/useColorScheme';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

// @ts-ignore JS exports
import { Game } from '@/api/entities';
import VideoPlayer from '@/components/VideoPlayer';
import { useAuth } from '@/context/AuthProvider';
import { getAuthSnapshot } from '@/utils/authState';
import { optimizeImageUrl } from '@/utils/imageUrl';

export const VIDEO_EXT = /\.(mp4|mov|webm|m4v|avi)$/i;

export type MediaItem = {
  id: string;
  url: string;
  thumbnail_url?: string;
  kind: 'photo' | 'video';
  created_at?: string;
  caption?: string | null;
  user_id?: string | null;
  expires_at?: string | null;
};

type StoriesViewerProps = {
  visible: boolean;
  items: MediaItem[];
  index: number;
  onClose: () => void;
  onSeen: (id: string) => void;
  onDelete?: (id: string) => void;
  gameId?: string | null;
  currentUserId?: string | null;
};

export default function StoriesViewer({
  visible,
  items,
  index,
  onClose,
  onSeen,
  onDelete,
  gameId,
  currentUserId,
}: StoriesViewerProps) {
  const insets = useSafeAreaInsets();
  const { user, checkAuth } = useAuth();
  const colorScheme = useColorScheme() ?? 'light';
  const styles = useMemo(() => createStyles(colorScheme), [colorScheme]);
  const [current, setCurrent] = useState(index);
  const [resolvedCurrentUserId, setCurrentUserId] = useState<string | null>(currentUserId ?? null);
  const w = useWindowDimensions().width;
  const progress = useRef(new Animated.Value(0)).current;
  const [paused, setPaused] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // v1.0.2 audit fix: guard setState against resolution after unmount / visibility change.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    getAuthSnapshot(checkAuth, user)
      .then((user: any) => {
        if (!cancelled) setCurrentUserId(user?.id || null);
      })
      .catch(() => {
        if (!cancelled) setCurrentUserId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [checkAuth, user, visible]);

  // Sync starting index when viewer opens or caller changes it
  useEffect(() => {
    if (visible) setCurrent(index);
  }, [visible, index]);

  const goNext = useCallback(() => {
    setCurrent(prev => {
      const next = prev + 1;
      if (next >= items.length) {
        // Defer onClose to avoid setState during render
        setTimeout(() => onClose(), 0);
        return prev;
      }
      return next;
    });
  }, [items.length, onClose]);

  const goPrev = useCallback(() => {
    setCurrent(prev => Math.max(0, prev - 1));
  }, []);

  // Guard taps right after long-press to avoid accidental nav
  const skipTapUntil = useRef<number>(0);
  const onLongPress = useCallback(() => {
    setPaused(true);
    skipTapUntil.current = Date.now() + 120;
  }, []);
  const onPressOut = useCallback(() => {
    setPaused(false);
  }, []);
  const onNavLeft = useCallback(() => {
    if (Date.now() < skipTapUntil.current) return;
    goPrev();
  }, [goPrev]);
  const onNavRight = useCallback(() => {
    if (Date.now() < skipTapUntil.current) return;
    goNext();
  }, [goNext]);

  // Handle delete story
  const handleDelete = useCallback(async () => {
    const item = items[current];
    if (!item || !gameId || deleting) {
      return;
    }

    Alert.alert(
      'Delete Story',
      'Are you sure you want to delete this story? This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeleting(true);
            try {
              await Game.deleteMedia(gameId, item.id);
              // Call parent's onDelete callback if provided
              if (onDelete) {
                onDelete(item.id);
              }
              // If this was the last item, close the viewer
              if (items.length === 1) {
                // Defer onClose to avoid setState during render
                setTimeout(() => onClose(), 0);
              } else {
                // Move to next item or previous if at the end
                if (current >= items.length - 1) {
                  goPrev();
                } else {
                  goNext();
                }
              }
            } catch (err) {
              if (__DEV__) console.error('Failed to delete story', err);
              Alert.alert('Error', 'Unable to delete story. Please try again.');
            } finally {
              setDeleting(false);
            }
          },
        },
      ]
    );
  }, [items, current, gameId, deleting, onDelete, onClose, goPrev, goNext]);

  // Reset progress when current changes and autoplay videos
  useEffect(() => {
    progress.stopAnimation();
    progress.setValue(0);
  }, [current, progress, items]);

  // Mark story as seen when it becomes visible (no auto-advance — user swipes manually).
  useEffect(() => {
    const item = items[current];
    if (!item) return;
    onSeen(item.id);
  }, [current, items, onSeen]);

  if (!visible) return null;
  const item = items[current];
  const isVideo = item?.kind === 'video' || (item?.url && VIDEO_EXT.test(item.url));

  // Check if user can delete this story
  const canDelete =
    resolvedCurrentUserId && item?.user_id && resolvedCurrentUserId === item.user_id;

  const showDeleteButton = canDelete;

  return (
    <Modal
      visible={visible}
      animationType="none"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
      hardwareAccelerated
      statusBarTranslucent
    >
      <View
        style={styles.storyViewerRoot}
        needsOffscreenAlphaCompositing
        renderToHardwareTextureAndroid
      >
        <View style={[styles.storyViewerTopBar, { paddingTop: insets.top + 8 }]}>
          <View style={styles.storyProgressRow}>
            {items.map((_, i) => {
              const isPast = i < current;
              const isFuture = i > current;
              const isActive = i === current;
              return (
                <View key={i} style={styles.storyProgressSegment}>
                  <View style={styles.storyProgressTrack} />
                  {isPast ? (
                    <View style={[styles.storyProgressFillAbs, { transform: [{ scaleX: 1 }] }]} />
                  ) : isFuture ? (
                    <View style={[styles.storyProgressFillAbs, { transform: [{ scaleX: 0 }] }]} />
                  ) : isActive ? (
                    <Animated.View
                      style={[styles.storyProgressFillAbs, { transform: [{ scaleX: progress }] }]}
                    />
                  ) : null}
                </View>
              );
            })}
          </View>
          <View style={styles.storyTopRight}>
            <Text style={styles.storyTopLabel}>
              {current + 1} / {items.length}
            </Text>
            {showDeleteButton && (
              <Pressable
                onPress={e => {
                  e?.stopPropagation?.();
                  void handleDelete();
                }}
                style={({ pressed }) => [
                  styles.storyDeleteBtn,
                  {
                    zIndex: 9999,
                    opacity: pressed ? 0.7 : 1,
                    transform: pressed ? [{ scale: 0.95 }] : [{ scale: 1 }],
                  },
                ]}
                accessibilityLabel="Delete story"
                disabled={deleting}
                hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              >
                <Ionicons name="trash-outline" size={22} color={deleting ? '#9CA3AF' : '#EF4444'} />
              </Pressable>
            )}
            <Pressable
              onPress={onClose}
              style={styles.storyCloseBtn}
              accessibilityLabel="Close stories"
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Ionicons name="close" size={24} color={Colors[colorScheme].text} />
            </Pressable>
          </View>
        </View>

        <View style={{ flex: 1, flexDirection: 'column' }}>
          <View
            style={styles.storyStage}
            needsOffscreenAlphaCompositing
            renderToHardwareTextureAndroid
            collapsable={false}
          >
            {isVideo ? (
              // Videos autoplay when story opens - no controls, just video
              <View
                style={{
                  width: w,
                  aspectRatio: 9 / 16,
                  backgroundColor: Colors[colorScheme].surface,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <VideoPlayer
                  key={item.id}
                  uri={item.url}
                  poster={item.thumbnail_url}
                  autoPlay={!paused}
                  nativeControls={false}
                  paused={paused}
                  style={{ width: '100%', height: '100%' }}
                />
              </View>
            ) : (
              <Image
                source={{ uri: optimizeImageUrl(item.url, 1200) }}
                style={{
                  width: w,
                  aspectRatio: 9 / 16,
                  backgroundColor: Colors[colorScheme].surface,
                  borderWidth: 0,
                }}
                contentFit="cover"
                transition={0}
                cachePolicy="memory-disk"
                recyclingKey={item.url}
              />
            )}
          </View>

          {/* Caption below media - separate section to avoid overlap */}
          {item?.caption?.trim() ? (
            <View style={[styles.storyCaptionWrap, { paddingBottom: insets.bottom + 12 }]}>
              <Text style={styles.storyCaptionText} numberOfLines={3}>
                {item.caption.trim()}
              </Text>
            </View>
          ) : null}
        </View>

        {/* Preload the next story's image to minimize flicker on advance. For a
            photo that's the photo itself; for a video it's the poster, so the
            next video shows its first frame the instant it opens rather than a
            spinner while the player instantiates and buffers. */}
        {(() => {
          const nextIndex = current + 1;
          const next = nextIndex < items.length ? items[nextIndex] : null;
          if (!next) return null;
          const nextUri = next.kind === 'video' ? next.thumbnail_url : next.url;
          if (!nextUri) return null;
          return (
            <Image
              source={{ uri: optimizeImageUrl(nextUri, 1200) }}
              style={{
                width: 1,
                height: 1,
                position: 'absolute',
                left: -1000,
                top: -1000,
                opacity: 0,
              }}
              contentFit="cover"
              transition={0}
              cachePolicy="memory-disk"
              recyclingKey={nextUri}
            />
          );
        })()}

        <View style={[styles.storyTouchLayer, { pointerEvents: 'box-none' }]}>
          <Pressable
            style={styles.storyTouchHalf}
            onPress={onNavLeft}
            onLongPress={onLongPress}
            onPressOut={onPressOut}
            delayLongPress={150}
          />
          <Pressable
            style={styles.storyTouchHalf}
            onPress={onNavRight}
            onLongPress={onLongPress}
            onPressOut={onPressOut}
            delayLongPress={150}
          />
        </View>
      </View>
    </Modal>
  );
}

const createStyles = (_colorScheme: 'light' | 'dark') =>
  StyleSheet.create({
    storyViewerRoot: {
      flex: 1,
      backgroundColor: '#121212',
      justifyContent: 'center',
      alignItems: 'center',
    },
    storyViewerTopBar: {
      position: 'absolute',
      left: 12,
      right: 12,
      top: 0,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 10,
      zIndex: 1000,
    },
    storyTopRight: { flexDirection: 'row', alignItems: 'center', gap: 8, zIndex: 1001 },
    storyTopLabel: { color: '#fff', fontWeight: '800' },
    storyDeleteBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: 'rgba(239,68,68,0.25)',
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 2,
      borderColor: 'rgba(239,68,68,0.5)',
      elevation: 5,
      ...(Platform.OS === 'web'
        ? { boxShadow: '0px 2px 4px rgba(0, 0, 0, 0.3)' }
        : {
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.3,
            shadowRadius: 4,
          }),
    },
    storyCloseBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: 'rgba(255,255,255,0.12)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    storyStage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    storyTouchLayer: { ...StyleSheet.absoluteFillObject, flexDirection: 'row' },
    storyTouchHalf: { flex: 1 },
    storyProgressRow: { flex: 1, flexDirection: 'row', gap: 4, marginRight: 8 },
    storyProgressSegment: {
      flex: 1,
      height: 3,
      borderRadius: 2,
      overflow: 'hidden',
      backgroundColor: 'transparent',
    },
    storyProgressTrack: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(255,255,255,0.35)',
    },
    storyProgressFillAbs: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: '#fff',
      transformOrigin: 'left center' as any,
    },
    storyCaptionWrap: {
      paddingHorizontal: 16,
      paddingVertical: 12,
      backgroundColor: 'rgba(15,23,42,0.95)',
      borderTopWidth: 0,
    },
    storyCaptionText: { color: '#e2e8f0', fontSize: 14, fontWeight: '600' },
  });
