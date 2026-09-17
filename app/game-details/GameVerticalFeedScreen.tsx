import CollageView, { type CollageData } from '@/components/CollageView';
import EventChip from '@/components/EventChip';
import ExpandableText from '@/components/ExpandableText';
import { Colors } from '@/constants/Colors';
import { useColorScheme } from '@/hooks/useColorScheme';
import { sanitizeTitle } from '@/lib/sanitizeTitle';
import { safeGoBack } from '@/utils/navigation';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as FileSystem from 'expo-file-system/legacy';
import { LinearGradient } from 'expo-linear-gradient';
import * as MediaLibrary from 'expo-media-library';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { VideoView } from 'expo-video';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  Share,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { captureRef } from 'react-native-view-shot';

import { Game, Highlights, Post, Report, User } from '@/api/entities';
import { httpGet } from '@/api/http';
import { useAuth } from '@/context/AuthProvider';
import { analytics, ANALYTICS_EVENTS } from '@/utils/analytics';
import { usePlaybackLifecycle } from '@/hooks/usePlaybackLifecycle';
import { getAuthSnapshot } from '@/utils/authState';
import { buildEventDetailRoute } from '@/utils/eventRoutes';
import events from '@/utils/events';
import { optimizeImageUrl, optimizeVideoUrl } from '@/utils/imageUrl';
import { AppLinks, buildNativeSharePayload } from '@/utils/links';
import { getVerticalPostContentFit, resolveMediaType } from '@/utils/media';
import { promptForSignIn } from '@/utils/requireSignIn';
import { toUserMessage } from '@/utils/toUserMessage';

// Initial guess only — cards/paging use the MEASURED container size (see
// `viewport` state). The window is wrong on web: the root layout constrains
// content to MAX_CONTENT_WIDTH, the phone-width install banner shortens the
// viewport, and module-level Dimensions never updates on browser resize.
const { height: windowHeight, width: windowWidth } = Dimensions.get('window');
const VIDEO_SHARE_CACHE_DIR = `${FileSystem.cacheDirectory || ''}shared-videos/`;

function getVideoShareExtension(url: string) {
  const cleanUrl = url.split('#')[0]?.split('?')[0] || url;
  const match = cleanUrl.match(/\.([a-z0-9]{2,5})$/i);
  return match ? `.${match[1].toLowerCase()}` : '.mp4';
}

async function getCachedShareableVideoUri(post: FeedPost) {
  if (!post.media_url) {
    throw new Error('Missing video URL');
  }
  if (!FileSystem.cacheDirectory) {
    throw new Error('Video cache unavailable');
  }

  const localUri = `${VIDEO_SHARE_CACHE_DIR}${post.id}${getVideoShareExtension(post.media_url)}`;
  const existing = await FileSystem.getInfoAsync(localUri);
  if (existing.exists) {
    return localUri;
  }

  await FileSystem.makeDirectoryAsync(VIDEO_SHARE_CACHE_DIR, { intermediates: true }).catch(
    () => {}
  );
  await FileSystem.downloadAsync(optimizeVideoUrl(post.media_url) || post.media_url, localUri);
  return localUri;
}

const FastImage = ({ source, style, resizeMode }: any) => (
  <Image
    source={source}
    style={style}
    contentFit={resizeMode === 'contain' ? 'contain' : 'cover'}
    cachePolicy="memory-disk"
    transition={120}
  />
);

export type FeedPost = {
  id: string;
  media_url: string | null;
  media_type: 'video' | 'image';
  caption: string | null;
  upvotes_count: number;
  comments_count: number;
  bookmarks_count: number;
  created_at: string | null;
  author: {
    id: string;
    username?: string | null;
    display_name?: string | null;
    avatar_url: string | null;
  } | null;
  has_upvoted: boolean;
  has_bookmarked: boolean;
  is_following_author: boolean;
  // Event/game link, denormalized server-side in both directions. Carried
  // through so tapping a post can route back to its event/game and the
  // context card resolves. Keep BOTH mappers (here + profile.toFeedPost) in
  // sync per the Post-mapper Consistency Rule.
  game_id?: string | null;
  event_id?: string | null;
  // Collage support (optional)
  type?: string | null;
  collage?: CollageData | null;
  preview_url?: string | null;
};

type CommentItem = {
  id: string;
  content: string;
  author?: { username?: string | null } | null;
  created_at?: string | null;
  optimistic?: boolean;
};

export const mapHighlightToFeedPost = (item: any): FeedPost | null => {
  const idValue = item?.id ?? item?.post_id ?? item?.highlight_id;
  if (!idValue) return null;
  const id = String(idValue);
  const mediaUrl = typeof item?.media_url === 'string' ? item.media_url : null;
  if (!mediaUrl) return null;
  const mediaType = (resolveMediaType(item?.media_url, item?.media_type) ?? 'image') as
    | 'video'
    | 'image';
  return {
    id,
    media_url: mediaUrl,
    media_type: mediaType,
    preview_url: typeof item?.preview_url === 'string' ? item.preview_url : null,
    caption: item?.caption ?? item?.content ?? sanitizeTitle(item?.title) ?? null,
    upvotes_count: typeof item?.upvotes_count === 'number' ? item.upvotes_count : 0,
    comments_count:
      typeof item?._count?.comments === 'number'
        ? item._count.comments
        : typeof item?.comments_count === 'number'
          ? item.comments_count
          : 0,
    bookmarks_count: typeof item?.bookmarks_count === 'number' ? item.bookmarks_count : 0,
    created_at: item?.created_at ?? null,
    author: item?.author
      ? {
          id: String(item.author.id ?? item.author.user_id ?? id),
          username: item.author.username ?? null,
          avatar_url: item.author.avatar_url ?? item.author.avatarUrl ?? null,
        }
      : null,
    has_upvoted: Boolean(item?.has_upvoted),
    has_bookmarked: Boolean(item?.has_bookmarked),
    is_following_author: Boolean(item?.is_following_author),
    game_id: item?.game_id ?? item?.game?.id ?? null,
    event_id: item?.event_id ?? item?.event?.id ?? null,
  };
};

type GameSummary = {
  id: string;
  title: string;
  date?: string | null;
};
type GameVerticalFeedScreenProps = {
  onClose?: () => void;
  gameId?: string | null;
  showHeader?: boolean;
  countryCode?: string | null;
  // When provided, the screen acts as a generic vertical viewer for these posts and will not fetch by game.
  initialPosts?: FeedPost[];
  startIndex?: number;
  // Exclude any posts whose media_url matches one of these URLs (case-insensitive, query/hash ignored)
  excludeMediaUrls?: string[];
  title?: string;
};

const fetchCommentsPage = async (postId: string, cursor?: string | null) => {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return httpGet(`/posts/${encodeURIComponent(postId)}/comments${qs}`);
};

const FeedCard = memo(
  ({
    post,
    isActive,
    onToggleUpvote,
    onToggleBookmark,
    onOpenComments,
    onSharePost,
    onToggleFollow: _onToggleFollow,
    onOpenAuthorProfile,
    onOpenLinkedContext,
    onDoubleTap,
    onDeletePost,
    onEditPost,
    onCopyLink,
    onReportPost,
    insets,
    size,
    colorScheme,
    meInfo,
  }: {
    post: FeedPost;
    isActive: boolean;
    onToggleUpvote: () => void;
    onToggleBookmark: () => void;
    onOpenComments: () => void;
    onSharePost: () => void;
    onToggleFollow: () => void;
    onOpenAuthorProfile: () => void;
    onOpenLinkedContext: () => void;
    onDoubleTap: () => void;
    onDeletePost?: () => void;
    onEditPost?: (caption: string) => void;
    onCopyLink: () => void;
    onReportPost: () => void;
    insets: { top: number; bottom: number };
    size: { width: number; height: number };
    colorScheme: 'light' | 'dark';
    meInfo?: { id?: string; display_name?: string | null; username?: string | null } | null;
  }) => {
    const lastTapRef = useRef(0);
    const collageRef = useRef<View | null>(null);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [showEditModal, setShowEditModal] = useState(false);
    const [showOptionsMenu, setShowOptionsMenu] = useState(false);
    const [editCaption, setEditCaption] = useState('');
    const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Only feed the video player a source for actual videos. Passing the
    // media_url unconditionally handed every IMAGE post's URL to an AVPlayer
    // too — one live player per mounted card downloading and trying to decode
    // a JPEG. Combined with the FlatList window that was enough memory
    // pressure to blank expo-image bitmaps app-wide (white grids/avatars).
    const videoSource = useMemo(
      () =>
        post.media_type === 'video' && post.media_url
          ? { uri: optimizeVideoUrl(post.media_url) || post.media_url }
          : null,
      [post.media_type, post.media_url]
    );
    const imageSource = useMemo(
      () =>
        post.media_url
          ? {
              uri:
                optimizeImageUrl(post.media_url, Math.max(900, Math.round(windowWidth * 1.5))) ||
                post.media_url,
            }
          : null,
      [post.media_url]
    );
    const authorAvatarSource = useMemo(
      () =>
        post.author?.avatar_url
          ? {
              uri: optimizeImageUrl(post.author.avatar_url, 120) || post.author.avatar_url,
            }
          : null,
      [post.author?.avatar_url]
    );
    // Every video post the API serves carries a preview_url, but the viewer
    // mapped it and then never drew it — a loading video was a black box with a
    // spinner. Showing the poster underneath means the first frame is on screen
    // immediately while the file is still opening, which is most of what "plays
    // right away" actually means to the eye.
    const posterSource = useMemo(
      () =>
        post.media_type === 'video' && post.preview_url
          ? {
              uri:
                optimizeImageUrl(post.preview_url, Math.max(900, Math.round(windowWidth * 1.5))) ||
                post.preview_url,
            }
          : null,
      [post.media_type, post.preview_url]
    );

    useEffect(() => {
      const deleteTimer = deleteTimerRef.current;
      return () => {
        if (deleteTimer) clearTimeout(deleteTimer);
      };
    }, []);

    // Check if current user is the author of the post
    const isAuthor = Boolean(meInfo?.id && post.author?.id && meInfo.id === post.author.id);

    const handleDeletePost = () => {
      setShowDeleteConfirm(true);
    };

    const confirmDelete = async () => {
      try {
        await Post.delete(post.id);
        setShowDeleteConfirm(false);
        onDeletePost?.();
      } catch (error: any) {
        setShowDeleteConfirm(false);
        Alert.alert('Error', toUserMessage(error, 'Failed to delete post. Please try again.'));
      }
    };

    const handleEditPost = () => {
      setEditCaption(post.caption || '');
      setShowEditModal(true);
    };

    const confirmEdit = async () => {
      try {
        await Post.update(post.id, { content: editCaption });
        setShowEditModal(false);
        onEditPost?.(editCaption);
      } catch (error: any) {
        Alert.alert('Error', toUserMessage(error, 'Failed to update post. Please try again.'));
      }
    };

    const {
      player,
      isLoading: isVideoLoading,
      errorMessage: videoError,
      retry: handleRetryVideo,
    } = usePlaybackLifecycle(videoSource?.uri, { autoPlay: true, paused: !isActive, loop: true });

    const handleTap = () => {
      const now = Date.now();
      if (now - lastTapRef.current < 300) {
        onDoubleTap();
      }
      lastTapRef.current = now;
    };

    const authorLabel = post.author?.username ? `@${post.author.username}` : 'Anonymous';

    const onLongPressExport = useCallback(async () => {
      if (!post?.collage) return;
      try {
        const perm = await MediaLibrary.requestPermissionsAsync();
        if (perm.status !== 'granted') {
          Alert.alert('Permission Required', 'Please grant photo library access to save images.', [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Open Settings', onPress: () => Linking.openSettings() },
          ]);
          return;
        }
        const uri = await captureRef(collageRef, { format: 'jpg', quality: 0.92 } as any);
        await MediaLibrary.saveToLibraryAsync(uri as any);
      } catch (error: any) {
        if (__DEV__) {
          if (__DEV__)
            console.warn('[GameVerticalFeed] Failed to save collage:', error?.message || error);
        }
        // Non-critical - user can try again
      }
    }, [post?.collage]);

    return (
      <View style={[styles.card, { width: size.width, height: size.height }]}>
        <Pressable
          style={styles.mediaContainer}
          onPress={handleTap}
          onLongPress={onLongPressExport}
          delayLongPress={350}
        >
          {post?.collage ? (
            <View ref={collageRef as any} style={styles.media}>
              <CollageView collage={post.collage} style={{ width: '100%', height: '100%' }} />
            </View>
          ) : post.media_type === 'video' && post.media_url ? (
            <View style={styles.videoWrap}>
              {/* Poster sits UNDER the player while the file opens, and drops
                  once expo-video reports readyToPlay (which clears
                  isVideoLoading) — by then the first real frame is drawn. */}
              {posterSource && isVideoLoading ? (
                <FastImage
                  source={posterSource}
                  style={styles.videoPoster}
                  resizeMode={getVerticalPostContentFit()}
                />
              ) : null}
              <VideoView
                player={player}
                style={styles.media}
                contentFit={getVerticalPostContentFit()}
                nativeControls={false}
                allowsFullscreen={false}
              />
              {isVideoLoading && !videoError ? (
                <View style={styles.videoOverlay}>
                  <ActivityIndicator size="small" color="#fff" />
                </View>
              ) : null}
              {videoError ? (
                <Pressable
                  onPress={handleRetryVideo}
                  style={styles.videoOverlay}
                  accessibilityRole="button"
                  accessibilityLabel="Retry video playback"
                >
                  <Ionicons name="refresh" size={24} color="#fff" />
                  <Text style={styles.videoOverlayTitle}>Video unavailable</Text>
                  <Text style={styles.videoOverlayCaption}>Tap to retry</Text>
                </Pressable>
              ) : null}
            </View>
          ) : post.media_url ? (
            imageSource ? (
              <FastImage
                source={imageSource}
                style={styles.media}
                resizeMode={getVerticalPostContentFit()}
              />
            ) : null
          ) : (
            <View style={[styles.media, styles.textOnlyCard]}>
              <LinearGradient
                colors={['#1E1E1E', '#121212']}
                style={StyleSheet.absoluteFillObject as any}
              />
              <View style={styles.textOnlyContent}>
                <View style={styles.textOnlyHeader}>
                  {post.author?.avatar_url ? (
                    authorAvatarSource ? (
                      <FastImage source={authorAvatarSource} style={styles.textOnlyAvatar} />
                    ) : null
                  ) : (
                    <View style={[styles.textOnlyAvatar, styles.avatarFallback]}>
                      <Text style={styles.avatarFallbackText}>
                        {authorLabel.charAt(0).toUpperCase()}
                      </Text>
                    </View>
                  )}
                  <View style={styles.textOnlyAuthorInfo}>
                    <Text style={styles.textOnlyAuthorName}>{authorLabel}</Text>
                    <Text style={styles.textOnlyTimestamp}>
                      {post.created_at
                        ? new Date(post.created_at).toLocaleDateString('en-US', {
                            month: 'short',
                            day: 'numeric',
                          })
                        : ''}
                    </Text>
                  </View>
                </View>
                <ExpandableText
                  text={post.caption || 'No content'}
                  maxLines={4}
                  style={styles.textOnlyCaption}
                  expandStyle={styles.textOnlyCaptionToggle}
                />
              </View>
            </View>
          )}
        </Pressable>

        <View
          style={[
            styles.captionOverlay,
            { paddingBottom: Math.max(insets.bottom + 12, 36), pointerEvents: 'box-none' },
          ]}
        >
          <Pressable
            onPress={post.author?.id ? onOpenAuthorProfile : undefined}
            disabled={!post.author?.id}
            style={styles.authorNameButton}
          >
            <Text style={styles.authorNameBottom}>{authorLabel}</Text>
          </Pressable>
          <EventChip
            gameId={post.game_id}
            eventId={post.event_id}
            onPress={onOpenLinkedContext}
            style={styles.eventChipRow}
          />
          <ExpandableText
            text={post.caption}
            maxLines={1}
            style={styles.captionText}
            expandStyle={styles.captionToggle}
          />
        </View>

        {/* 2026-07-17: the rail avatar was removed at user request — the big
            buttons ate into the photo/video. The poster profile is still one
            tap away via the @username in the caption overlay (same
            onOpenAuthorProfile handler). Icons/labels were shrunk and the rail
            was dropped toward the bottom edge for the same reason. */}
        <View
          style={[
            styles.rail,
            { paddingBottom: Math.max(insets.bottom + 12, 36), pointerEvents: 'box-none' },
          ]}
        >
          <Pressable onPress={onToggleUpvote} style={styles.railBtn}>
            <Ionicons
              name={post.has_upvoted ? 'arrow-up' : 'arrow-up-outline'}
              size={28}
              color="#fff"
            />
            <Text style={styles.railLabel}>{post.upvotes_count}</Text>
          </Pressable>

          <Pressable onPress={onOpenComments} style={styles.railBtn}>
            <Ionicons name="chatbubble-ellipses-outline" size={28} color="#fff" />
            <Text style={styles.railLabel}>{post.comments_count}</Text>
          </Pressable>

          <Pressable onPress={onToggleBookmark} style={styles.railBtn}>
            <Ionicons
              name={post.has_bookmarked ? 'bookmark' : 'bookmark-outline'}
              size={26}
              color="#fff"
            />
            <Text style={styles.railLabel}>{post.bookmarks_count}</Text>
          </Pressable>

          <Pressable onPress={() => setShowOptionsMenu(true)} style={styles.railBtn}>
            <Ionicons name="ellipsis-horizontal" size={26} color="#fff" />
            <Text style={styles.railLabel}>Options</Text>
          </Pressable>
        </View>

        {/* Options Menu Modal */}
        <Modal visible={showOptionsMenu} transparent animationType="fade">
          <Pressable style={styles.modalOverlay} onPress={() => setShowOptionsMenu(false)}>
            <View style={styles.optionsMenu}>
              <Pressable
                onPress={() => {
                  setShowOptionsMenu(false);
                  onSharePost();
                }}
                style={styles.optionButton}
              >
                <Ionicons name="share-outline" size={20} color={Colors[colorScheme].text} />
                <Text style={[styles.optionText, { color: Colors[colorScheme].text }]}>
                  Share Post
                </Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  setShowOptionsMenu(false);
                  onCopyLink();
                }}
                style={styles.optionButton}
              >
                <Ionicons name="link-outline" size={20} color={Colors[colorScheme].text} />
                <Text style={[styles.optionText, { color: Colors[colorScheme].text }]}>
                  Copy Link
                </Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  setShowOptionsMenu(false);
                  onReportPost();
                }}
                style={styles.optionButton}
              >
                <Ionicons name="flag-outline" size={20} color={Colors[colorScheme].text} />
                <Text style={[styles.optionText, { color: Colors[colorScheme].text }]}>
                  Report Post
                </Text>
              </Pressable>
              {isAuthor && (
                <>
                  <Pressable
                    onPress={() => {
                      setShowOptionsMenu(false);
                      handleEditPost();
                    }}
                    style={styles.optionButton}
                  >
                    <Ionicons name="pencil-outline" size={20} color={Colors[colorScheme].text} />
                    <Text style={[styles.optionText, { color: Colors[colorScheme].text }]}>
                      Edit Post
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => {
                      setShowOptionsMenu(false);
                      handleDeletePost();
                    }}
                    style={styles.optionButton}
                  >
                    <Ionicons name="trash-outline" size={20} color="#dc2626" />
                    <Text style={[styles.optionText, { color: '#dc2626' }]}>Delete Post</Text>
                  </Pressable>
                </>
              )}
            </View>
          </Pressable>
        </Modal>

        {/* Delete Confirmation Modal */}
        <Modal visible={showDeleteConfirm} transparent animationType="fade">
          <View style={styles.modalOverlay}>
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>Delete Post?</Text>
              <Text style={styles.modalText}>
                Are you sure you want to delete this post? This action cannot be undone.
              </Text>
              <View style={styles.modalButtons}>
                <Pressable
                  onPress={() => setShowDeleteConfirm(false)}
                  style={styles.modalCancelBtn}
                >
                  <Text style={styles.modalCancelText}>Cancel</Text>
                </Pressable>
                <Pressable onPress={confirmDelete} style={styles.modalDeleteBtn}>
                  <Text style={styles.modalDeleteText}>Delete</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>

        {/* Edit Modal */}
        <Modal visible={showEditModal} transparent animationType="fade">
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            style={styles.modalOverlay}
            keyboardVerticalOffset={0}
          >
            <View style={styles.modalContent}>
              <Text style={styles.modalTitle}>Edit Post</Text>
              <TextInput
                style={styles.editInput}
                value={editCaption}
                onChangeText={setEditCaption}
                placeholder="Post caption..."
                multiline
                textAlignVertical="top"
              />
              <View style={styles.modalButtons}>
                <Pressable onPress={() => setShowEditModal(false)} style={styles.modalCancelBtn}>
                  <Text style={styles.modalCancelText}>Cancel</Text>
                </Pressable>
                <Pressable onPress={confirmEdit} style={styles.modalSaveBtn}>
                  <Text style={styles.modalSaveText}>Save</Text>
                </Pressable>
              </View>
            </View>
          </KeyboardAvoidingView>
        </Modal>
      </View>
    );
  }
);
FeedCard.displayName = 'FeedCard';

function GameVerticalFeedScreen({
  onClose,
  gameId: externalGameId,
  showHeader = true,
  countryCode,
  initialPosts,
  startIndex = 0,
  excludeMediaUrls = [],
  title,
}: GameVerticalFeedScreenProps = {}) {
  const { user, checkAuth } = useAuth();
  const { id: gameIdParam } = useLocalSearchParams<{ id?: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme() ?? 'light';
  // Cards and paging math must use the container this screen actually renders
  // in — not the window. Measured via onLayout on the root view; the module
  // Dimensions capture is only the pre-measurement guess.
  const [viewport, setViewport] = useState({ width: windowWidth, height: windowHeight });
  const onViewportLayout = useCallback((event: any) => {
    const { width, height } = event.nativeEvent.layout;
    if (!width || !height) return;
    setViewport(prev =>
      prev.width === width && prev.height === height ? prev : { width, height }
    );
  }, []);
  const gameId = externalGameId ? String(externalGameId) : gameIdParam ? String(gameIdParam) : null;
  const usingInitial = useMemo(
    () => Array.isArray(initialPosts) && initialPosts.length > 0,
    [initialPosts]
  );
  const normalizedCountry = useMemo(
    () => (countryCode ? String(countryCode).toUpperCase() : undefined),
    [countryCode]
  );
  const normalizeUrl = useCallback((u: any) => {
    if (!u || typeof u !== 'string') return null;
    try {
      // strip hash and query
      let s = u.trim();
      const hashIdx = s.indexOf('#');
      if (hashIdx >= 0) s = s.slice(0, hashIdx);
      const qIdx = s.indexOf('?');
      if (qIdx >= 0) s = s.slice(0, qIdx);
      s = s.replace(/^https?:\/\//i, '');
      s = s.replace(/\/+$/, '');
      return s.toLowerCase();
    } catch (error) {
      if (__DEV__) console.warn('[GameVerticalFeedScreen] URL normalization failed:', error);
      return null;
    }
  }, []);
  const excludeSet = useMemo(() => {
    const set = new Set<string>();
    (excludeMediaUrls || []).forEach(u => {
      const n = normalizeUrl(u);
      if (n) set.add(n);
    });
    return set;
  }, [excludeMediaUrls, normalizeUrl]);
  const handleBack = useCallback(() => {
    if (onClose) {
      onClose();
    } else {
      safeGoBack(router, '/(tabs)/highlights');
    }
  }, [onClose, router]);

  const navigateFromViewer = useCallback(
    (target: Href) => {
      const runNavigation = () => {
        void router.push(target);
      };

      if (onClose) {
        onClose();
        requestAnimationFrame(runNavigation);
        return;
      }

      runNavigation();
    },
    [onClose, router]
  );

  const [game, setGame] = useState<GameSummary | null>(null);
  const [posts, setPosts] = useState<FeedPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const [commentsVisible, setCommentsVisible] = useState(false);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [commentInput, setCommentInput] = useState('');
  const [commentSending, setCommentSending] = useState(false);
  const [comments, setComments] = useState<CommentItem[]>([]);
  const [commentsCursor, setCommentsCursor] = useState<string | null>(null);
  const [commentTarget, setCommentTarget] = useState<FeedPost | null>(null);
  const [meInfo, setMeInfo] = useState<{
    id?: string;
    display_name?: string | null;
    username?: string | null;
  } | null>(null);
  const resolveMeInfo = useCallback(async () => {
    const me: any = await getAuthSnapshot(checkAuth, user);
    return me
      ? {
          id: me?.id ? String(me.id) : undefined,
          display_name: me?.display_name ?? null,
          username: me?.username ?? null,
        }
      : null;
  }, [checkAuth, user]);
  const headerTitle = title || game?.title || 'Game';

  // Store VideoPlayer instances by post id
  const flatListRef = useRef<FlatList<FeedPost>>(null);

  const cursorRef = useRef<string | null>(null);
  const hasMoreRef = useRef(true);
  const _resetRunCount = useRef(0);
  const setArrayStateIfChanged = useCallback((setter: any, next: any[]) => {
    setter((prev: any[]) => {
      if (!Array.isArray(prev) || !Array.isArray(next)) return next;
      if (prev === next) return prev;
      if (prev.length !== next.length) return next;
      for (let i = 0; i < prev.length; i += 1) {
        const prevItem = prev[i];
        const nextItem = next[i];
        if (prevItem === nextItem) continue;
        if (
          prevItem &&
          nextItem &&
          typeof prevItem === 'object' &&
          typeof nextItem === 'object' &&
          'id' in prevItem &&
          'id' in nextItem &&
          (prevItem as { id?: unknown }).id === (nextItem as { id?: unknown }).id
        ) {
          continue;
        }
        return next;
      }
      return prev;
    });
  }, []);
  const _initialSeedSig = useRef<string | null>(null);

  useEffect(() => {
    // Reset array state only when its contents changed; primitives already bail out
    // on identical values without the cost of deep JSON serialization.
    _resetRunCount.current += 1;
    setArrayStateIfChanged(setPosts, []);
    cursorRef.current = null;
    hasMoreRef.current = true;
    setActiveIndex(0);
    setLoading(true);
    setRefreshing(false);
    setLoadingMore(false);
    setGame(null);
    setArrayStateIfChanged(setComments, []);
    setCommentsCursor(null);
    setCommentTarget(null);
    setCommentsError(null);
    setCommentInput('');
    setCommentSending(false);
    setCommentsVisible(false);
    setCommentsLoading(false);
  }, [gameId, usingInitial, setArrayStateIfChanged]);

  // If acting as a generic viewer with provided posts, seed posts and index.
  useEffect(() => {
    if (!usingInitial) return;
    const items = Array.isArray(initialPosts) ? initialPosts.filter(p => !!p && !!p.id) : [];
    // filter excluded
    const filtered = items.filter(p => {
      const n = normalizeUrl(p.media_url);
      return n ? !excludeSet.has(n) : true;
    });
    // Create a small signature to avoid reseeding the same content repeatedly
    const sig = filtered.map(p => p.id).join('|') + `::${startIndex || 0}`;
    if (_initialSeedSig.current === sig) {
      return;
    }
    _initialSeedSig.current = sig;
    setArrayStateIfChanged(setPosts, filtered);
    setActiveIndex(Math.min(Math.max(0, startIndex || 0), Math.max(0, items.length - 1)));
    cursorRef.current = null;
    hasMoreRef.current = false;
    setLoading(false);
  }, [usingInitial, initialPosts, startIndex, excludeSet, normalizeUrl, setArrayStateIfChanged]);

  useEffect(() => {
    if (usingInitial) return;
    if (!gameId) {
      setGame({ id: 'all-highlights', title: 'All Highlights', date: null });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const summary: any = await Game.summary(gameId).catch(() => null);
        if (!cancelled && summary) {
          setGame({ id: summary.id, title: summary.title || 'Game', date: summary.date ?? null });
        }
      } catch (error) {
        if (__DEV__) console.warn('[GameVerticalFeedScreen] Failed to load game summary:', error);
        if (!cancelled) setGame(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gameId, usingInitial]);

  const loadFeed = useCallback(
    async (reset = false) => {
      if (usingInitial) {
        // No-op: using provided posts
        setLoading(false);
        setRefreshing(false);
        setLoadingMore(false);
        return;
      }
      if (!gameId) {
        if (reset) {
          setRefreshing(true);
        }
        try {
          const response = await Highlights.fetch(
            normalizedCountry ? { country: normalizedCountry, limit: 40 } : { limit: 40 }
          );
          const pools: any[] = [];
          if (Array.isArray(response?.nationalTop)) pools.push(...response.nationalTop);
          if (Array.isArray(response?.ranked)) pools.push(...response.ranked);
          const seen = new Set<string>();
          const mapped: FeedPost[] = [];
          for (const item of pools) {
            const mappedItem = mapHighlightToFeedPost(item);
            if (!mappedItem || !mappedItem.id) continue;
            if (seen.has(mappedItem.id)) continue;
            if (!mappedItem.media_url) continue;
            const n = normalizeUrl(mappedItem.media_url);
            if (n && excludeSet.has(n)) continue;
            seen.add(mappedItem.id);
            mapped.push(mappedItem);
          }
          setPosts(mapped);
          cursorRef.current = null;
          hasMoreRef.current = false;
        } catch {
        } finally {
          setLoading(false);
          setRefreshing(false);
          setLoadingMore(false);
        }
        return;
      }

      if (reset) {
        setRefreshing(true);
      } else if (!hasMoreRef.current) {
        setLoadingMore(false);
        return;
      }

      const currentCursor = reset ? null : cursorRef.current;
      try {
        // "View All Posts" must return EVERY post type for this game (photos,
        // text, videos) — not just type:'highlight'. The server returns all
        // types for a game_id when `type` is omitted; the prior filter hid
        // every non-highlight post from this viewer.
        const page = await Post.filterPage({ game_id: gameId }, currentCursor, 6, 'trending');
        const items = Array.isArray(page?.items) ? page.items : [];
        const filtered = items.filter(p => {
          const n = normalizeUrl((p as any)?.media_url);
          return n ? !excludeSet.has(n) : true;
        });
        setPosts(prev => (reset ? filtered : [...prev, ...filtered]));
        const nextCursor = page?.nextCursor ?? null;
        cursorRef.current = nextCursor;
        const more = Boolean(page?.nextCursor);
        hasMoreRef.current = more;
      } catch (error) {
        if (__DEV__) console.error('[GameVerticalFeedScreen] Failed to load more posts:', error);
      } finally {
        setLoading(false);
        setRefreshing(false);
        setLoadingMore(false);
      }
    },
    [gameId, normalizedCountry, usingInitial, excludeSet, normalizeUrl]
  );

  // Load feed on mount and when gameId changes — avoid depending on loadFeed
  // to prevent re-fetch loops when the callback reference changes.
  const loadFeedRef = useRef(loadFeed);
  loadFeedRef.current = loadFeed;
  useEffect(() => {
    if (usingInitial) return;
    void loadFeedRef.current(true);
  }, [gameId, usingInitial]);

  // When using initial posts, jump to the provided startIndex only on first load
  const hasScrolledToInitial = useRef(false);
  useEffect(() => {
    if (!usingInitial) return;
    if (hasScrolledToInitial.current) return; // Don't re-scroll on pagination
    const target = Math.min(Math.max(0, startIndex || 0), Math.max(0, posts.length - 1));
    if (!posts.length) return;
    hasScrolledToInitial.current = true;
    try {
      // Give FlatList a tick to mount
      requestAnimationFrame(() => {
        flatListRef.current?.scrollToIndex({ index: target, animated: false });
        setActiveIndex(target);
      });
    } catch (error: any) {
      if (__DEV__) {
        if (__DEV__)
          console.warn('[GameVerticalFeed] Failed to load posts:', error?.message || error);
      }
      // Continue with existing posts
    }
  }, [gameId, posts.length, startIndex, usingInitial]);

  // Reset initial-scroll flag when the game changes
  useEffect(() => {
    hasScrolledToInitial.current = false;
  }, [gameId]);

  const onEndReached = useCallback(() => {
    if (!gameId) return;
    if (!loading && !loadingMore && hasMoreRef.current) {
      setLoadingMore(true);
      void loadFeed(false);
    }
  }, [gameId, loadFeed, loading, loadingMore]);

  const onRefresh = useCallback(() => {
    if (loading) return;
    cursorRef.current = null;
    hasMoreRef.current = true;
    void loadFeed(true);
  }, [loadFeed, loading]);

  const onViewableItemsChanged = useRef(({ viewableItems }: any) => {
    if (viewableItems?.length) {
      const first = viewableItems[0];
      const index = first?.index ?? 0;
      setActiveIndex(prev => {
        if (prev !== index) {
          // Close comment sheet and reset all comment state when swiping to a different post
          setCommentsVisible(false);
          setCommentInput('');
          setCommentTarget(null);
          setComments([]);
          setCommentsCursor(null);
          setCommentsError(null);
        }
        return index;
      });
    }
  }).current;

  const handleMomentumScrollEnd = useCallback(
    (event: any) => {
      const nextIndex = Math.max(
        0,
        Math.min(posts.length - 1, Math.round(event.nativeEvent.contentOffset.y / viewport.height))
      );
      setActiveIndex(nextIndex);
    },
    [posts.length, viewport.height]
  );

  const updatePost = useCallback((postId: string, updater: (post: FeedPost) => FeedPost) => {
    setPosts(prev => prev.map(post => (post.id === postId ? updater(post) : post)));
  }, []);

  const optimisticUpdateAllFromAuthor = useCallback(
    (authorId: string, updater: (post: FeedPost) => FeedPost) => {
      setPosts(prev => prev.map(post => (post.author?.id === authorId ? updater(post) : post)));
    },
    []
  );

  const handleToggleUpvote = useCallback(
    async (post: FeedPost) => {
      if (!user) {
        promptForSignIn(
          () => {
            navigateFromViewer('/sign-in');
          },
          {
            message: 'Sign in to upvote posts.',
          }
        );
        return;
      }
      const optimisticNext = !post.has_upvoted;
      updatePost(post.id, p => ({
        ...p,
        has_upvoted: optimisticNext,
        upvotes_count: Math.max(0, p.upvotes_count + (optimisticNext ? 1 : -1)),
      }));
      try {
        const res: any = await Post.toggleUpvote(post.id);
        const upvotedNow = Boolean(res?.has_upvoted ?? res?.upvoted);
        if (upvotedNow) {
          analytics.track(ANALYTICS_EVENTS.POST_UPVOTED, {
            post_id: post.id,
            source: 'game_vertical_feed',
          });
        }
        updatePost(post.id, p => ({
          ...p,
          has_upvoted: Boolean(res?.has_upvoted ?? res?.upvoted),
          upvotes_count:
            typeof res?.upvotes_count === 'number'
              ? res.upvotes_count
              : typeof res?.count === 'number'
                ? res.count
                : p.upvotes_count,
        }));
      } catch {
        updatePost(post.id, p => ({
          ...p,
          has_upvoted: post.has_upvoted,
          upvotes_count: p.upvotes_count + (post.has_upvoted ? 1 : -1),
        }));
      }
    },
    [navigateFromViewer, updatePost, user]
  );

  const handleToggleBookmark = useCallback(
    async (post: FeedPost) => {
      if (!user) {
        promptForSignIn(
          () => {
            navigateFromViewer('/sign-in');
          },
          {
            message: 'Sign in to save posts.',
          }
        );
        return;
      }
      const optimisticNext = !post.has_bookmarked;
      updatePost(post.id, p => ({
        ...p,
        has_bookmarked: optimisticNext,
        bookmarks_count: Math.max(0, p.bookmarks_count + (optimisticNext ? 1 : -1)),
      }));
      try {
        const res: any = await Post.toggleBookmark(post.id);
        updatePost(post.id, p => ({
          ...p,
          has_bookmarked: Boolean(res?.has_bookmarked ?? res?.bookmarked),
          bookmarks_count:
            typeof res?.bookmarks_count === 'number' ? res.bookmarks_count : p.bookmarks_count,
        }));
      } catch {
        updatePost(post.id, p => ({
          ...p,
          has_bookmarked: post.has_bookmarked,
          bookmarks_count: p.bookmarks_count + (post.has_bookmarked ? 1 : -1),
        }));
      }
    },
    [navigateFromViewer, updatePost, user]
  );

  const handleToggleFollow = useCallback(
    async (post: FeedPost) => {
      if (!user) {
        promptForSignIn(
          () => {
            navigateFromViewer('/sign-in');
          },
          {
            message: 'Sign in to follow creators.',
          }
        );
        return;
      }
      const authorId = post.author?.id;
      if (!authorId) return;
      const optimisticNext = !post.is_following_author;
      optimisticUpdateAllFromAuthor(authorId, p => ({ ...p, is_following_author: optimisticNext }));
      try {
        if (optimisticNext) {
          const res: any = await User.follow(authorId);
          const isFollowing = Boolean(res?.is_following_author ?? true);
          optimisticUpdateAllFromAuthor(authorId, p => ({
            ...p,
            is_following_author: isFollowing,
          }));
        } else {
          await User.unfollow(authorId);
          optimisticUpdateAllFromAuthor(authorId, p => ({ ...p, is_following_author: false }));
        }
      } catch {
        optimisticUpdateAllFromAuthor(authorId, p => ({
          ...p,
          is_following_author: post.is_following_author,
        }));
      }
    },
    [navigateFromViewer, optimisticUpdateAllFromAuthor, user]
  );

  const handleOpenAuthorProfile = useCallback(
    (post: FeedPost) => {
      const authorId = post.author?.id;
      if (!authorId) return;
      navigateFromViewer(`/user-profile?id=${encodeURIComponent(String(authorId))}`);
    },
    [navigateFromViewer]
  );

  const navigateToLinkedContext = useCallback(
    (post: FeedPost) => {
      if (post.game_id && String(post.game_id).trim()) {
        navigateFromViewer({ pathname: '/game/[id]', params: { id: String(post.game_id).trim() } });
        return;
      }
      if (post.event_id && String(post.event_id).trim()) {
        navigateFromViewer(buildEventDetailRoute(String(post.event_id).trim()));
      }
    },
    [navigateFromViewer]
  );

  const handleShare = useCallback(async (post: FeedPost) => {
    const shareLink = AppLinks.post(post.id, post.caption ?? undefined);

    if (post.media_type === 'video' && post.media_url) {
      try {
        const localUri = await getCachedShareableVideoUri(post);
        await Share.share({ url: localUri });
        void Post.share(post.id).catch(() => {});
        return;
      } catch (error) {
        if (__DEV__) {
          console.warn(
            '[GameVerticalFeed] Video file share failed, falling back to link share:',
            error
          );
        }
      }
    }

    try {
      const result = await Share.share(
        buildNativeSharePayload(shareLink.shareMessage, shareLink.webUrl)
      );
      if (result.action === Share.sharedAction) {
        void Post.share(post.id).catch(() => {});
      }
    } catch (error) {
      if (__DEV__) {
        console.warn('[GameVerticalFeed] Link share failed, copying link instead:', error);
      }
      try {
        const Clipboard = await import('expo-clipboard');
        await Clipboard.setStringAsync(shareLink.webUrl);
        Alert.alert('Share unavailable', 'Link copied to clipboard so you can paste it manually.');
      } catch {
        Alert.alert('Share unavailable', 'Unable to open the share sheet or copy the link.');
      }
    }
  }, []);

  const handleCopyLink = useCallback(async (post: FeedPost) => {
    try {
      const shareLink = AppLinks.post(post.id, post.caption ?? undefined);
      const Clipboard = await import('expo-clipboard');
      await Clipboard.setStringAsync(shareLink.webUrl);
      Alert.alert('Copied', 'Link copied to clipboard.');
    } catch {
      Alert.alert('Error', 'Failed to copy link.');
    }
  }, []);

  const submitReport = useCallback(async (post: FeedPost, reason: string) => {
    try {
      await Report.create({ target_type: 'post', target_id: String(post.id), reason });
      Alert.alert('Report Submitted', 'Thank you for helping keep our community safe.');
    } catch (error: any) {
      if (error?.status === 409) {
        Alert.alert('Already Reported', 'You have already reported this post.');
      } else {
        Alert.alert('Error', toUserMessage(error, 'Failed to submit report. Please try again.'));
      }
    }
  }, []);

  const handleReportPost = useCallback(
    (post: FeedPost) => {
      Alert.alert('Report Post', 'Select a reason:', [
        { text: 'Spam', onPress: () => submitReport(post, 'spam') },
        { text: 'Harassment', onPress: () => submitReport(post, 'harassment') },
        { text: 'Hate Speech', onPress: () => submitReport(post, 'hate_speech') },
        { text: 'Violence', onPress: () => submitReport(post, 'violence') },
        { text: 'False Information', onPress: () => submitReport(post, 'false_information') },
        { text: 'Cancel', style: 'cancel' },
      ]);
    },
    [submitReport]
  );

  const handleDeletePost = useCallback((post: FeedPost) => {
    // Remove the post from the current posts array
    setPosts(prevPosts => prevPosts.filter(p => p.id !== post.id));
  }, []);

  const handleEditPost = useCallback(
    (post: FeedPost, newCaption: string) => {
      // Update the post in the current posts array
      updatePost(post.id, p => ({
        ...p,
        caption: newCaption,
      }));
    },
    [updatePost]
  );

  const openComments = useCallback(
    async (post: FeedPost) => {
      setCommentTarget(post);
      setCommentsVisible(true);
      setComments([]);
      setCommentsCursor(null);
      setCommentsError(null);
      setCommentsLoading(true);
      try {
        // Load current user info (for display name) if missing
        if (!meInfo) {
          try {
            const me = await resolveMeInfo();
            setMeInfo(me ? { ...me } : null);
          } catch (error: any) {
            if (__DEV__) {
              if (__DEV__)
                console.warn('[GameVerticalFeed] Failed to load user:', error?.message || error);
            }
            // Continue without user info
          }
        }
        const res: any = await fetchCommentsPage(post.id);
        const items = Array.isArray(res?.items) ? res.items : Array.isArray(res) ? res : [];
        setComments(items);
        setCommentsCursor(res?.nextCursor ?? null);
      } catch (error: any) {
        setCommentsError(toUserMessage(error, 'Failed to load comments'));
      } finally {
        setCommentsLoading(false);
      }
    },
    [meInfo, resolveMeInfo]
  );

  const loadMoreComments = useCallback(async () => {
    if (!commentTarget || !commentsCursor || commentsLoading) return;
    setCommentsLoading(true);
    try {
      const res: any = await fetchCommentsPage(commentTarget.id, commentsCursor);
      const items = Array.isArray(res?.items) ? res.items : [];
      setComments(prev => [...prev, ...items]);
      setCommentsCursor(res?.nextCursor ?? null);
    } catch {
      setCommentsCursor(null);
    } finally {
      setCommentsLoading(false);
    }
  }, [commentTarget, commentsCursor, commentsLoading]);

  const handleSendComment = useCallback(async () => {
    if (!commentTarget || !commentInput.trim() || commentSending) return;
    if (!user) {
      promptForSignIn(
        () => {
          navigateFromViewer('/sign-in');
        },
        {
          message: 'Sign in to comment on posts.',
        }
      );
      return;
    }
    const optimistic: CommentItem = {
      id: `pending-${Date.now()}`,
      content: commentInput,
      optimistic: true,
      created_at: new Date().toISOString(),
      author: { username: (meInfo?.username || 'you') as any },
    };
    setComments(prev => [optimistic, ...prev]);
    setCommentInput('');
    setCommentSending(true);
    try {
      const res: any = await Post.addComment(commentTarget.id, optimistic.content);
      analytics.track(ANALYTICS_EVENTS.COMMENT_CREATED, {
        post_id: commentTarget.id,
        source: 'game_vertical_feed',
      });
      const withAuthor =
        res && typeof res === 'object'
          ? { ...res, author: { username: res?.author?.username ?? (meInfo?.username || 'you') } }
          : res;
      setComments(prev => [withAuthor, ...prev.filter(c => !c.optimistic)]);
      updatePost(commentTarget.id, p => ({ ...p, comments_count: p.comments_count + 1 }));
      // Notify profile interactions that a new comment was made
      events.emit('comment:created', { post_id: commentTarget.id });
    } catch {
      setComments(prev => prev.filter(c => !c.optimistic));
      setCommentsError('Unable to send comment right now.');
    } finally {
      setCommentSending(false);
    }
  }, [commentInput, commentSending, commentTarget, updatePost, meInfo, navigateFromViewer, user]);

  const handleDoubleTap = useCallback(
    (post: FeedPost) => {
      if (!post.has_upvoted) {
        void handleToggleUpvote(post);
      }
    },
    [handleToggleUpvote]
  );

  const renderItem = useCallback(
    ({ item, index }: { item: FeedPost; index: number }) => (
      <FeedCard
        key={item.id}
        post={item}
        isActive={index === activeIndex}
        onToggleUpvote={() => handleToggleUpvote(item)}
        onToggleBookmark={() => handleToggleBookmark(item)}
        onOpenComments={() => openComments(item)}
        onSharePost={() => handleShare(item)}
        onToggleFollow={() => handleToggleFollow(item)}
        onOpenAuthorProfile={() => handleOpenAuthorProfile(item)}
        onOpenLinkedContext={() => navigateToLinkedContext(item)}
        onDoubleTap={() => handleDoubleTap(item)}
        onDeletePost={() => handleDeletePost(item)}
        onEditPost={(newCaption: string) => handleEditPost(item, newCaption)}
        onCopyLink={() => void handleCopyLink(item)}
        onReportPost={() => handleReportPost(item)}
        insets={{ top: insets.top, bottom: insets.bottom }}
        size={viewport}
        colorScheme={colorScheme}
        meInfo={meInfo}
      />
    ),
    [
      activeIndex,
      viewport,
      handleCopyLink,
      handleDoubleTap,
      handleDeletePost,
      handleEditPost,
      handleOpenAuthorProfile,
      navigateToLinkedContext,
      handleReportPost,
      handleShare,
      handleToggleBookmark,
      handleToggleFollow,
      handleToggleUpvote,
      insets.bottom,
      insets.top,
      openComments,
      colorScheme,
      meInfo,
    ]
  );

  const keyExtractor = useCallback((item: FeedPost) => item.id, []);

  // Ensure we know who the current user is so we can correctly
  // hide the follow button on our own posts and space the rail.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const me = await resolveMeInfo();
        if (!cancelled && me) {
          setMeInfo(me);
        }
      } catch (error) {
        // User info load failed - non-critical for feed viewing
        if (__DEV__) console.warn('[GameVerticalFeed] Failed to load user info:', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resolveMeInfo]);

  // Note: We allow missing gameId - the component will load general highlights instead
  // The loadFeed function handles this case gracefully (lines 612-642)

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: Colors[colorScheme].background, pointerEvents: 'box-none' },
      ]}
      onLayout={onViewportLayout}
    >
      <LinearGradient
        colors={
          colorScheme === 'dark'
            ? ['#0b1120', '#020617']
            : [Colors[colorScheme].surface, Colors[colorScheme].background]
        }
        style={[styles.backdrop, { pointerEvents: 'none' }]}
      />
      <FlatList
        ref={flatListRef as any}
        data={posts}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        pagingEnabled
        snapToAlignment="start"
        decelerationRate="fast"
        showsVerticalScrollIndicator={false}
        // Full-screen media cards: the default window (21 viewport heights)
        // kept ~21 cards + their video players mounted, which caused iOS
        // memory warnings that purged expo-image caches (white images on the
        // screens underneath). Keep just the neighbors warm.
        windowSize={5}
        maxToRenderPerBatch={2}
        removeClippedSubviews
        onEndReached={onEndReached}
        onEndReachedThreshold={0.3}
        initialScrollIndex={
          usingInitial
            ? Math.min(Math.max(0, startIndex || 0), Math.max(0, posts.length - 1))
            : undefined
        }
        getItemLayout={(_, index) => ({
          length: viewport.height,
          offset: viewport.height * index,
          index,
        })}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={Colors[colorScheme].tint}
          />
        }
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={{ itemVisiblePercentThreshold: 80 }}
        onMomentumScrollEnd={handleMomentumScrollEnd}
        ListEmptyComponent={
          loading ? (
            <View style={styles.loadingState}>
              <ActivityIndicator color={Colors[colorScheme].tint} />
            </View>
          ) : (
            <View style={styles.emptyState}>
              <Text style={[styles.emptyStateTitle, { color: Colors[colorScheme].text }]}>
                {gameId ? 'No highlights yet' : 'No posts yet'}
              </Text>
              <Text
                style={[styles.emptyStateCaption, { color: Colors[colorScheme].tabIconDefault }]}
              >
                {gameId
                  ? 'Be the first to post about this game.'
                  : 'Be the first to create a post for this game.'}
              </Text>
            </View>
          )
        }
      />

      {showHeader && !usingInitial ? (
        <View
          style={[styles.titleOverlay, { paddingTop: insets.top + 12, pointerEvents: 'box-none' }]}
        >
          <Pressable style={styles.backBtn} onPress={handleBack}>
            <Ionicons name="chevron-back" size={24} color="#fff" />
          </Pressable>
          <View style={styles.titleTextWrap}>
            <Text style={styles.titleText}>{headerTitle}</Text>
            {game?.date ? (
              <Text style={styles.titleSubtitle}>{new Date(game.date).toLocaleDateString()}</Text>
            ) : null}
          </View>
        </View>
      ) : usingInitial ? (
        <View
          style={[styles.titleOverlay, { paddingTop: insets.top + 12, pointerEvents: 'box-none' }]}
        >
          <Pressable style={styles.backBtn} onPress={handleBack}>
            <Ionicons name="chevron-back" size={24} color="#fff" />
          </Pressable>
          <View style={styles.titleTextWrap}>
            <Text style={styles.titleText}>{headerTitle}</Text>
          </View>
        </View>
      ) : null}

      <Modal
        visible={commentsVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setCommentsVisible(false)}
      >
        <KeyboardAvoidingView
          style={styles.commentModalRoot}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          keyboardVerticalOffset={0}
        >
          <View
            style={[
              styles.commentSheet,
              {
                maxHeight: viewport.height * 0.75,
                backgroundColor: Colors[colorScheme].background,
                pointerEvents: 'box-none',
              },
            ]}
          >
            <View style={[styles.commentHeader, { backgroundColor: Colors[colorScheme].surface }]}>
              <Text style={[styles.commentTitle, { color: Colors[colorScheme].text }]}>
                Comments
              </Text>
              <Pressable onPress={() => setCommentsVisible(false)} style={styles.commentCloseBtn}>
                <Ionicons name="close" size={24} color={Colors[colorScheme].text} />
              </Pressable>
            </View>
            {commentsLoading && comments.length === 0 ? (
              <ActivityIndicator color={Colors[colorScheme].tint} style={{ marginVertical: 24 }} />
            ) : null}
            {commentsError ? (
              <Text style={[styles.commentError, { color: Colors[colorScheme].text }]}>
                {commentsError}
              </Text>
            ) : null}
            <FlatList
              data={comments}
              keyExtractor={item => String(item.id)}
              renderItem={({ item }) => (
                <View
                  style={[styles.commentRow, { borderBottomColor: Colors[colorScheme].border }]}
                >
                  <Text style={[styles.commentAuthor, { color: Colors[colorScheme].text }]}>
                    {item.author?.username
                      ? `@${item.author.username}`
                      : item.optimistic
                        ? meInfo?.username
                          ? `@${meInfo.username}`
                          : 'You'
                        : 'Anonymous'}
                  </Text>
                  <Text style={[styles.commentBody, { color: Colors[colorScheme].text }]}>
                    {item.content}
                  </Text>
                </View>
              )}
              onEndReached={loadMoreComments}
              onEndReachedThreshold={0.4}
              ListFooterComponent={
                commentsCursor ? (
                  <ActivityIndicator
                    color={Colors[colorScheme].tint}
                    style={{ marginVertical: 12 }}
                  />
                ) : null
              }
            />
            <View style={styles.commentComposer}>
              <TextInput
                style={[
                  styles.commentInput,
                  {
                    color: Colors[colorScheme].text,
                    backgroundColor: Colors[colorScheme].surface,
                    borderColor: Colors[colorScheme].border,
                  },
                ]}
                placeholder="Add a comment..."
                placeholderTextColor={Colors[colorScheme].tabIconDefault}
                value={commentInput}
                onChangeText={setCommentInput}
                editable={!commentSending}
              />
              <Pressable
                style={[
                  styles.commentSendBtn,
                  commentSending || !commentInput.trim() ? styles.commentSendDisabled : null,
                ]}
                onPress={handleSendComment}
                disabled={commentSending || !commentInput.trim()}
              >
                <Text style={[styles.commentSendText, { color: Colors[colorScheme].text }]}>
                  Send
                </Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  backdrop: { ...StyleSheet.absoluteFillObject },
  card: { backgroundColor: 'transparent' },
  mediaContainer: {
    flex: 1,
    backgroundColor: '#000', // Black background for images to show properly with contain mode
    justifyContent: 'center',
    alignItems: 'center',
  },
  media: {
    width: '100%',
    height: '100%',
    backgroundColor: 'transparent',
  },
  mediaFallback: { alignItems: 'center', justifyContent: 'center' },
  mediaFallbackText: { fontWeight: '700' },
  textOnlyCard: {
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  textOnlyContent: {
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 24,
    padding: 24,
    maxWidth: 600,
    alignSelf: 'center',
    width: '100%',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.1)',
  },
  textOnlyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 16,
  },
  textOnlyAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    marginRight: 12,
  },
  textOnlyAuthorInfo: {
    flex: 1,
  },
  textOnlyAuthorName: {
    fontSize: 17,
    fontWeight: '700',
    color: '#fff',
    marginBottom: 2,
  },
  textOnlyTimestamp: {
    fontSize: 14,
    color: '#94a3b8',
    fontWeight: '500',
  },
  textOnlyCaption: {
    fontSize: 19,
    fontWeight: '400',
    color: '#f1f5f9',
    lineHeight: 28,
    letterSpacing: -0.2,
  },
  textOnlyCaptionToggle: {
    color: '#cbd5e1',
  },
  headerOverlay: {
    position: 'absolute',
    left: 16,
    right: 16,
    top: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    pointerEvents: 'box-none',
  },
  headerAvatar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  avatar: { width: 32, height: 32, borderRadius: 16 },
  avatarFallback: { backgroundColor: '#374151', alignItems: 'center', justifyContent: 'center' },
  avatarFallbackText: { fontWeight: '700' },
  authorName: { color: '#fff', marginLeft: 8, fontWeight: '700' },
  captionOverlay: {
    position: 'absolute',
    left: 16,
    // Gutter reserved for the action rail; narrowed from 88 on 2026-07-17 when
    // the rail lost its 48px avatar and its icons shrank.
    right: 76,
    bottom: 12,
    zIndex: 20,
    elevation: 20,
    pointerEvents: 'box-none',
  },
  authorNameBottom: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 4,
    ...(Platform.OS === 'web'
      ? { textShadow: '0px 1px 3px rgba(0, 0, 0, 0.75)' }
      : {
          textShadowColor: 'rgba(0, 0, 0, 0.75)',
          textShadowOffset: { width: 0, height: 1 },
          textShadowRadius: 3,
        }),
  },
  authorNameButton: {
    alignSelf: 'flex-start',
  },
  eventChipRow: {
    marginTop: 6,
    marginBottom: 2,
  },
  captionText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '500',
    lineHeight: 20,
    ...(Platform.OS === 'web'
      ? { textShadow: '0px 1px 3px rgba(0, 0, 0, 0.75)' }
      : {
          textShadowColor: 'rgba(0, 0, 0, 0.75)',
          textShadowOffset: { width: 0, height: 1 },
          textShadowRadius: 3,
        }),
  },
  captionToggle: {
    color: '#e2e8f0',
    ...(Platform.OS === 'web'
      ? { textShadow: '0px 1px 3px rgba(0, 0, 0, 0.75)' }
      : {
          textShadowColor: 'rgba(0, 0, 0, 0.75)',
          textShadowOffset: { width: 0, height: 1 },
          textShadowRadius: 3,
        }),
  },
  videoWrap: {
    width: '100%',
    height: '100%',
  },
  // Absolute so it fills videoWrap *behind* the VideoView rather than stacking
  // above it in flow (styles.media is 100%-height, not absolute).
  videoPoster: {
    ...StyleSheet.absoluteFillObject,
  },
  videoOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(2, 6, 23, 0.38)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 24,
  },
  videoOverlayTitle: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },
  videoOverlayCaption: {
    color: '#e2e8f0',
    fontSize: 13,
    fontWeight: '600',
  },
  rail: {
    position: 'absolute',
    right: 16,
    bottom: 12,
    alignItems: 'center',
    zIndex: 20,
    elevation: 20,
    pointerEvents: 'box-none',
  },
  // v1.0.3: the follow-plus badge styles were removed along with the overlay
  // badge on the avatar. 2026-07-17: the rail avatar styles went the same way
  // when the avatar itself was removed from the rail. All are kept out of the
  // stylesheet so future greps don't trip over a dead style.
  // Icon is 26–28px but the padding keeps the touch target at ~44x44.
  railBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
    minWidth: 44,
    paddingHorizontal: 6,
    paddingVertical: 4,
  },
  railLabel: {
    color: '#fff',
    fontWeight: '800',
    marginTop: 2,
    fontSize: 12,
    ...(Platform.OS === 'web'
      ? { textShadow: '0px 1px 3px rgba(0, 0, 0, 0.75)' }
      : {
          textShadowColor: 'rgba(0, 0, 0, 0.75)',
          textShadowOffset: { width: 0, height: 1 },
          textShadowRadius: 3,
        }),
  },
  titleOverlay: {
    position: 'absolute',
    top: 0,
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    zIndex: 30,
    elevation: 30,
    pointerEvents: 'box-none',
  },
  backBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleTextWrap: {
    flex: 1,
    marginLeft: 12,
    backgroundColor: 'rgba(0,0,0,0.35)',
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  titleText: {
    fontWeight: '800',
    fontSize: 16,
    color: '#fff',
    ...(Platform.OS === 'web'
      ? { textShadow: '0px 1px 3px rgba(0, 0, 0, 0.75)' }
      : {
          textShadowColor: 'rgba(0, 0, 0, 0.75)',
          textShadowOffset: { width: 0, height: 1 },
          textShadowRadius: 3,
        }),
  },
  titleSubtitle: {
    color: '#e5e7eb',
    marginTop: 2,
    fontSize: 12,
    ...(Platform.OS === 'web'
      ? { textShadow: '0px 1px 3px rgba(0, 0, 0, 0.75)' }
      : {
          textShadowColor: 'rgba(0, 0, 0, 0.75)',
          textShadowOffset: { width: 0, height: 1 },
          textShadowRadius: 3,
        }),
  },
  emptyState: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  emptyStateTitle: { fontWeight: '800', fontSize: 18 },
  emptyStateCaption: { marginTop: 8, textAlign: 'center' },
  emptyStateBtn: {
    marginTop: 16,
    backgroundColor: '#2563EB',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 999,
  },
  emptyStateBtnText: { fontWeight: '700' },
  loadingState: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  commentModalRoot: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  commentSheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingBottom: 24,
    paddingTop: 16,
    paddingHorizontal: 16,
    minHeight: windowHeight * 0.4,
  },
  commentHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  commentTitle: { fontSize: 18, fontWeight: '700' },
  commentCloseBtn: { position: 'absolute', right: 0, padding: 6 },
  commentError: { marginVertical: 8, textAlign: 'center' },
  commentRow: { marginBottom: 14, borderBottomWidth: 1 },
  commentAuthor: { fontWeight: '700' },
  commentBody: { marginTop: 4 },
  commentTimestamp: { marginTop: 4, fontSize: 12 },
  commentComposer: { flexDirection: 'row', alignItems: 'center', marginTop: 12 },
  commentInput: {
    flex: 1,
    backgroundColor: '#1f2937',
    borderRadius: 12,
    color: '#fff',
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginRight: 12,
  },
  commentSendBtn: {
    backgroundColor: '#2563EB',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
  },
  commentSendDisabled: { backgroundColor: '#475569' },
  commentSendText: { fontWeight: '700' },

  // Modal styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  modalContent: {
    backgroundColor: '#1E1E1E',
    borderRadius: 16,
    padding: 24,
    width: '100%',
    maxWidth: 400,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#fff',
    marginBottom: 12,
    textAlign: 'center',
  },
  modalText: {
    fontSize: 16,
    color: '#cbd5e1',
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 22,
  },
  modalButtons: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  modalCancelBtn: {
    flex: 1,
    backgroundColor: '#475569',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  modalCancelText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  modalDeleteBtn: {
    flex: 1,
    backgroundColor: '#dc2626',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  modalDeleteText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  modalSaveBtn: {
    flex: 1,
    backgroundColor: '#2563EB',
    paddingVertical: 14,
    borderRadius: 12,
    alignItems: 'center',
  },
  modalSaveText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  editInput: {
    backgroundColor: '#3A3A3C',
    color: '#fff',
    borderRadius: 12,
    padding: 16,
    fontSize: 16,
    minHeight: 120,
    marginBottom: 24,
    textAlignVertical: 'top',
  },
  optionsMenu: {
    backgroundColor: '#1E1E1E',
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: 40,
  },
  optionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    gap: 12,
  },
  optionText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '500',
  },
});

export default GameVerticalFeedScreen;
