import EventChip from '@/components/EventChip';
import { Colors } from '@/constants/Colors';
import { useAuth } from '@/context/AuthProvider';
import { usePostCache } from '@/context/PostCacheContext';
import { useColorScheme } from '@/hooks/useColorScheme';
import { useDeviceLocation } from '@/hooks/useDeviceLocation';
import { sanitizeTitle } from '@/lib/sanitizeTitle';
import { getAuthSnapshot } from '@/utils/authState';
import AppLinks, { buildNativeSharePayload } from '@/utils/links';
import { promptForSignIn } from '@/utils/requireSignIn';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Image as ExpoImage } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Keyboard,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  Share,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
let VideoThumbnails: any = null;
try {
  VideoThumbnails = require('expo-video-thumbnails');
} catch {
  /* native module not available */
}
// @ts-ignore legacy export shape
import { Event, Highlights, Organization, Post, Search, Team, User } from '@/api/entities';
import { analytics, ANALYTICS_EVENTS } from '@/utils/analytics';
// Clipboard is dynamically imported only when needed to avoid crashes
// if the dev client wasn't built with the native module.
import { formatCount, getCountryFlag, timeAgo } from '@/utils/format';
import { buildEventDetailRoute } from '@/utils/eventRoutes';
import { optimizeImageUrl } from '@/utils/imageUrl';
import { getCloudinaryVideoPreviewUrl, resolveMediaType } from '@/utils/media';
import { calculateRanking, HighlightItem } from '../utils/rankingUtils';

type TabType = 'trending' | 'recent' | 'top';
const CARD_HEIGHT = 220;

const mapHighlightItem = (input: any): HighlightItem | null => {
  if (!input) return null;
  const idValue = input.id ?? input.post_id ?? input.highlight_id;
  if (!idValue) return null;
  const authorId = String(input.author_id ?? input.author?.id ?? '');
  return {
    id: String(idValue),
    title: input.title ?? input.caption ?? undefined,
    caption: input.caption ?? undefined,
    content: input.content ?? undefined,
    media_url: typeof input.media_url === 'string' ? input.media_url : undefined,
    preview_url: typeof input.preview_url === 'string' ? input.preview_url : undefined,
    upvotes_count: typeof input.upvotes_count === 'number' ? input.upvotes_count : undefined,
    created_at: typeof input.created_at === 'string' ? input.created_at : new Date().toISOString(),
    author_id: String(authorId),
    author: input.author
      ? {
          id: String(input.author.id || authorId),
          username: input.author.username || undefined,
          display_name: String(input.author.display_name || 'Anonymous'),
          avatar_url: input.author.avatar_url || undefined,
        }
      : undefined,
    _count: input._count
      ? {
          comments: typeof input._count.comments === 'number' ? input._count.comments : 0,
        }
      : undefined,
    // Carry through per-user interaction state so a refetch keeps the filled
    // upvote arrow / saved state instead of reverting to false.
    has_upvoted: typeof input.has_upvoted === 'boolean' ? input.has_upvoted : false,
    has_bookmarked: typeof input.has_bookmarked === 'boolean' ? input.has_bookmarked : false,
    bookmarks_count: typeof input.bookmarks_count === 'number' ? input.bookmarks_count : undefined,
    lat: typeof input.lat === 'number' ? input.lat : undefined,
    lng: typeof input.lng === 'number' ? input.lng : undefined,
    country_code: typeof input.country_code === 'string' ? input.country_code : undefined,
    sport: typeof input.sport === 'string' ? input.sport : undefined,
    game_id: input.game_id ?? input.game?.id ?? null,
    event_id: input.event_id ?? input.event?.id ?? null,
    _score: typeof input._score === 'number' ? input._score : undefined,
  };
};

const getSportCategory = (sport?: string, title?: string | null, content?: string | null) => {
  // First, check if sport is explicitly provided from backend
  if (sport) {
    const sportLower = sport.toLowerCase();
    if (sportLower.includes('football')) return { name: 'Football', icon: '🏈', color: '#8B5A2B' };
    if (sportLower.includes('basketball'))
      return { name: 'Basketball', icon: '🏀', color: '#FF6B35' };
    if (sportLower.includes('baseball')) return { name: 'Baseball', icon: '⚾', color: '#2E8B57' };
    if (sportLower.includes('soccer')) return { name: 'Soccer', icon: '⚽', color: '#4169E1' };
    if (sportLower.includes('hockey')) return { name: 'Hockey', icon: '🏒', color: '#1C1C1C' };
    if (sportLower.includes('tennis')) return { name: 'Tennis', icon: '🎾', color: '#228B22' };
    if (sportLower.includes('volleyball'))
      return { name: 'Volleyball', icon: '🏐', color: '#FF1744' };
    if (sportLower.includes('wrestling'))
      return { name: 'Combat Sports', icon: '🤼', color: '#7B1FA2' };
    if (sportLower.includes('track'))
      return { name: 'Track & Field', icon: '🏃', color: '#FF9800' };
    if (sportLower.includes('swimming')) return { name: 'Swimming', icon: '🏊', color: '#0288D1' };
    if (sportLower.includes('golf')) return { name: 'Golf', icon: '⛳', color: '#558B2F' };
    if (sportLower.includes('lacrosse')) return { name: 'Lacrosse', icon: '🥍', color: '#D32F2F' };
    // Return the sport name as-is if it doesn't match known patterns
    return { name: sport, icon: '🏆', color: '#FF6B35' };
  }

  // Fallback: Parse from title/content
  const text = ((title || '') + ' ' + (content || '')).toLowerCase();
  if (text.includes('football') || text.includes('nfl'))
    return { name: 'Football', icon: '🏈', color: '#8B5A2B' };
  if (text.includes('basketball') || text.includes('nba'))
    return { name: 'Basketball', icon: '🏀', color: '#FF6B35' };
  if (text.includes('baseball') || text.includes('mlb'))
    return { name: 'Baseball', icon: '⚾', color: '#2E8B57' };
  if (text.includes('soccer') || text.includes('fifa'))
    return { name: 'Soccer', icon: '⚽', color: '#4169E1' };
  if (text.includes('hockey') || text.includes('nhl'))
    return { name: 'Hockey', icon: '🏒', color: '#1C1C1C' };
  if (text.includes('tennis')) return { name: 'Tennis', icon: '🎾', color: '#228B22' };
  if (text.includes('volleyball')) return { name: 'Volleyball', icon: '🏐', color: '#FF1744' };
  if (text.includes('wrestling')) return { name: 'Combat Sports', icon: '🤼', color: '#7B1FA2' };
  if (text.includes('track')) return { name: 'Track & Field', icon: '🏃', color: '#FF9800' };
  if (text.includes('swimming')) return { name: 'Swimming', icon: '🏊', color: '#0288D1' };
  if (text.includes('golf')) return { name: 'Golf', icon: '⛳', color: '#558B2F' };
  if (text.includes('lacrosse')) return { name: 'Lacrosse', icon: '🥍', color: '#D32F2F' };

  return { name: 'Sports', icon: '🏆', color: '#FF6B35' };
};

// Component that generates a thumbnail from a video URL when preview_url is missing
const VideoThumbnailImage = ({ videoUrl, style }: { videoUrl: string; style: any }) => {
  const [thumbUri, setThumbUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (VideoThumbnails && videoUrl && !failed) {
      VideoThumbnails.getThumbnailAsync(videoUrl, { time: 1000 })
        .then((result: any) => {
          if (!cancelled && result?.uri) setThumbUri(result.uri);
          else if (!cancelled) setFailed(true);
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [videoUrl, failed]);

  if (thumbUri) {
    return <ExpoImage source={{ uri: thumbUri }} style={style} contentFit="cover" />;
  }
  // Fallback: dark gradient with prominent play icon — never a blank card
  return (
    <LinearGradient
      colors={['#1E1E1E', '#121212']}
      style={[style, { alignItems: 'center', justifyContent: 'center' }]}
    >
      <View
        style={{
          width: 52,
          height: 52,
          borderRadius: 26,
          backgroundColor: 'rgba(255,255,255,0.15)',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Ionicons name="play" size={28} color="#fff" style={{ marginLeft: 3 }} />
      </View>
      <Text style={{ color: '#94a3b8', fontSize: 11, marginTop: 6, fontWeight: '600' }}>Video</Text>
    </LinearGradient>
  );
};

const HighlightCard = ({
  item,
  index = 0,
  currentTab = 'trending',
  nationalTop = [],
  ranked = [],
  userLocation,
  onPress,
  onAuthorPress,
  colorScheme,
  onUpvote,
  trendingRanked = false,
}: {
  item: HighlightItem;
  index?: number;
  currentTab?: string;
  nationalTop?: HighlightItem[];
  ranked?: HighlightItem[];
  userLocation?: { lat: number; lng: number };
  onPress: (item: HighlightItem) => void;
  onAuthorPress?: (authorId: string) => void;
  colorScheme: 'light' | 'dark';
  onUpvote?: (item: HighlightItem) => void;
  // True only when the Trending list is led by a post that actually carries
  // engagement — i.e. the score-based ranking is meaningful. Gates the medal
  // badges so #1 always genuinely means "top-ranked", never just "first of a
  // pile of zero-engagement posts".
  trendingRanked?: boolean;
}) => {
  const isVideo = resolveMediaType(item.media_url, item.media_type) === 'video';
  const category = getSportCategory(item.sport, item.title, item.content);
  const hasMedia = !!item.media_url;
  const previewUrl =
    item.preview_url || getCloudinaryVideoPreviewUrl(item.media_url || null) || undefined;

  // Calculate ranking for this item
  const _ranking = calculateRanking(item, index, currentTab, nationalTop, ranked, userLocation);

  // Show numbered ranking for Trending (top 3) and Top (1-10). The server now
  // orders Trending by an app-wide engagement score, so positions 0-2 are the
  // top-ranked. Medals render only when that ranking is meaningful
  // (`trendingRanked`) — a list led by a zero-engagement post gets none, so #1
  // never falsely implies popularity.
  const showNumberedRank =
    (currentTab === 'trending' && trendingRanked && index < 3) ||
    (currentTab === 'top' && index < 10);
  const rankNumber = index + 1;

  return (
    <Pressable
      style={[
        styles.card,
        { backgroundColor: Colors[colorScheme].card, borderColor: Colors[colorScheme].border },
      ]}
      onPress={() => onPress(item)}
    >
      <View style={styles.cardContainer}>
        {/* Media Section */}
        <View style={styles.mediaSection}>
          {/* Numbered Ranking Badge for Top 3 (Trending) or Top 10 - positioned relative to media */}
          {showNumberedRank && (
            <View
              style={[
                styles.numberBadge,
                {
                  backgroundColor:
                    index === 0
                      ? '#FFD700'
                      : index === 1
                        ? '#C0C0C0'
                        : index === 2
                          ? '#CD7F32'
                          : '#2563EB',
                },
              ]}
            >
              <Text style={styles.numberBadgeText}>#{rankNumber}</Text>
            </View>
          )}
          {hasMedia ? (
            <View style={styles.mediaContainer}>
              {isVideo ? (
                previewUrl ? (
                  <ExpoImage
                    source={{ uri: optimizeImageUrl(previewUrl, 800) || previewUrl }}
                    style={styles.mediaImage}
                    contentFit="cover"
                    cachePolicy="memory-disk"
                  />
                ) : (
                  <VideoThumbnailImage videoUrl={item.media_url!} style={styles.mediaImage} />
                )
              ) : (
                <ExpoImage
                  source={{ uri: optimizeImageUrl(item.media_url, 800) || item.media_url }}
                  style={styles.mediaImage}
                  contentFit="cover"
                  cachePolicy="memory-disk"
                />
              )}
              {isVideo && (
                <View style={styles.videoOverlay}>
                  <View style={styles.playButton}>
                    <Ionicons name="play" size={24} color="#fff" />
                  </View>
                </View>
              )}
              {/* "NEW" badge for very recent posts (< 10 minutes) — rank badge takes priority */}
              {!showNumberedRank &&
                item.created_at &&
                new Date(item.created_at).getTime() > Date.now() - 600000 && (
                  <View style={[styles.liveBadge, { backgroundColor: '#3b82f6' }]}>
                    <Text style={styles.liveText}>NEW</Text>
                  </View>
                )}
            </View>
          ) : (
            <LinearGradient
              colors={[category.color + '80', category.color + '40']}
              style={styles.mediaContainer}
            >
              <View style={styles.noMediaContent}>
                <Text style={styles.categoryIcon}>{category.icon}</Text>
                <Text style={styles.noMediaText}>Text Post</Text>
              </View>
            </LinearGradient>
          )}
        </View>

        {/* Content Section */}
        <View style={styles.contentSection}>
          {/* Header */}
          <View style={styles.cardHeader}>
            <View style={[styles.categoryBadge, { backgroundColor: category.color }]}>
              <Text style={styles.categoryText}>{category.name}</Text>
            </View>
            <Text style={styles.countryFlag}>{getCountryFlag(item.country_code)}</Text>
          </View>

          {/* Title */}
          <Text style={[styles.cardTitle, { color: Colors[colorScheme].text }]} numberOfLines={2}>
            {sanitizeTitle(item.title) || item.caption || ''}
          </Text>

          {/* Author & Time */}
          <Pressable
            style={styles.authorRow}
            onPress={e => {
              e.stopPropagation();
              if (item.author_id && onAuthorPress) {
                onAuthorPress(item.author_id);
              }
            }}
          >
            <View style={styles.authorInfo}>
              {item.author?.avatar_url ? (
                <ExpoImage
                  source={{
                    uri: optimizeImageUrl(item.author.avatar_url, 80) || item.author.avatar_url,
                  }}
                  style={styles.authorAvatar}
                  contentFit="cover"
                  cachePolicy="memory-disk"
                />
              ) : (
                <View style={[styles.authorAvatar, styles.defaultAvatar]}>
                  <Ionicons name="person" size={12} color="#fff" />
                </View>
              )}
              <Text
                style={[styles.authorName, { color: Colors[colorScheme].text }]}
                numberOfLines={1}
              >
                {item.author?.username
                  ? `@${item.author.username}`
                  : item.author?.display_name || 'Anonymous'}
              </Text>
              <Ionicons
                name="chevron-forward"
                size={14}
                color={Colors[colorScheme].tabIconDefault}
              />
            </View>
            <Text style={[styles.timeText, { color: Colors[colorScheme].mutedText }]}>
              {timeAgo(item.created_at)}
            </Text>
          </Pressable>

          <EventChip
            gameId={item.game_id}
            eventId={item.event_id}
            variant="card"
            style={{ marginBottom: 8 }}
          />

          {/* Stats Row */}
          <View style={styles.statsRow}>
            <Pressable
              style={[
                styles.actionButton,
                item.has_upvoted && { backgroundColor: 'rgba(37, 99, 235, 0.2)' },
              ]}
              onPress={e => {
                e.stopPropagation();
                onUpvote?.(item);
              }}
            >
              <Ionicons
                name={item.has_upvoted ? 'arrow-up' : 'arrow-up-outline'}
                size={18}
                color="#2563EB"
              />
              <Text style={[styles.statText, { color: '#2563EB', fontWeight: '700' }]}>
                {formatCount(item.upvotes_count || 0)}
              </Text>
            </Pressable>

            <Pressable
              style={styles.actionButton}
              onPress={e => {
                e.stopPropagation();
                onPress(item); // Navigate to post detail to see comments
              }}
            >
              <Ionicons name="chatbubble" size={16} color={Colors[colorScheme].mutedText} />
              <Text
                style={[
                  styles.statText,
                  { color: Colors[colorScheme].mutedText, fontWeight: '600' },
                ]}
              >
                {formatCount(item._count?.comments || 0)}
              </Text>
            </Pressable>

            <Pressable
              style={styles.actionButton}
              onPress={async e => {
                e.stopPropagation();
                try {
                  const link = AppLinks.post(
                    String(item.id),
                    item.caption || (sanitizeTitle(item.title) ?? undefined)
                  );
                  await Share.share(buildNativeSharePayload(link.shareMessage, link.webUrl));
                  void Post.share(String(item.id)).catch(() => {});
                } catch {
                  try {
                    const mod = await import('expo-clipboard').catch(() => null);
                    const setStringAsync =
                      mod?.setStringAsync || (mod && (mod as any).default?.setStringAsync);
                    if (typeof setStringAsync === 'function') {
                      const fallback = AppLinks.post(String(item.id), item.caption).webUrl;
                      await setStringAsync(fallback);
                      Alert.alert('Link Copied', 'Share link copied to clipboard!');
                    } else {
                      Alert.alert('Share Failed', 'Clipboard unavailable in this build.');
                    }
                  } catch (error) {
                    // Silently fail - instrumentation is optional
                    if (__DEV__) console.warn('[highlights] Instrumentation error:', error);
                  }
                }
              }}
            >
              <Ionicons name="share-outline" size={16} color="#10B981" />
              <Text
                style={[
                  styles.statText,
                  { color: Colors[colorScheme].mutedText, fontWeight: '600' },
                ]}
              >
                Share
              </Text>
            </Pressable>

            {item._score && (
              <View style={[styles.actionButton, { opacity: 0.7 }]}>
                <Ionicons name="trending-up" size={16} color="#10B981" />
                <Text style={[styles.statText, { color: Colors[colorScheme].mutedText }]}>
                  {Math.round(item._score)}
                </Text>
              </View>
            )}
          </View>
        </View>
      </View>
    </Pressable>
  );
};

const TabButton = ({
  title,
  active,
  onPress,
  colorScheme,
}: {
  title: string;
  active: boolean;
  onPress: () => void;
  colorScheme: 'light' | 'dark';
}) => (
  <Pressable
    style={[
      styles.tabButton,
      active && [styles.activeTab, { backgroundColor: Colors[colorScheme].tint }],
      !active && { backgroundColor: Colors[colorScheme].surface },
    ]}
    onPress={onPress}
  >
    <Text
      style={[
        styles.tabText,
        active && [styles.activeTabText, { color: Colors[colorScheme].background }],
        !active && { color: Colors[colorScheme].text, opacity: 0.7 },
      ]}
    >
      {title}
    </Text>
  </Pressable>
);

function HighlightsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme() ?? 'light';
  const { user, checkAuth } = useAuth();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<TabType>('trending');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<{
    teams: any[];
    events: any[];
    users: any[];
    organizations: any[];
    posts: HighlightItem[];
  }>({ teams: [], events: [], users: [], organizations: [], posts: [] });
  const [searching, setSearching] = useState(false);
  const postCache = usePostCache();

  // Trending is "posts nearby them" (owner rule) and the server selects by
  // proximity — but only if we actually send coords. The reused
  // `useDeviceLocation` hook resolves them out-of-band: it never prompts on
  // mount (it only *checks* an already-granted permission) and prefers a
  // last-known fix, so it can't spam or stall this tab. The query below fires
  // immediately without coords and re-runs once they land — degraded-but-full
  // (server zip → newest-first fallback) beats an empty tab while we wait.
  const { location: deviceLocation } = useDeviceLocation();
  // Rounded to ~1km so small movements don't churn the query key/cache —
  // same precision feed.tsx uses for its game-proximity coords.
  const viewerCoords = useMemo(() => {
    if (typeof deviceLocation?.latitude !== 'number') return null;
    if (typeof deviceLocation?.longitude !== 'number') return null;
    const lat = Math.round(deviceLocation.latitude * 100) / 100;
    const lng = Math.round(deviceLocation.longitude * 100) / 100;
    // 0,0 is Null Island — a sentinel, never a real viewer.
    if (lat === 0 && lng === 0) return null;
    return { lat, lng };
  }, [deviceLocation?.latitude, deviceLocation?.longitude]);

  const {
    data: highlightsPayload,
    isPending: loading,
    isError,
    refetch,
  } = useQuery({
    queryKey: [
      'highlights',
      activeTab,
      user?.id ?? 'guest',
      viewerCoords ? `${viewerCoords.lat},${viewerCoords.lng}` : 'no-coords',
    ],
    // Keep the previous tab's list on screen while the new tab loads —
    // prevents a full-screen spinner flash on every tab switch.
    placeholderData: (prev: any) => prev,
    queryFn: async () => {
      const me: any = await getAuthSnapshot(checkAuth, user).catch((error: any) => {
        if (__DEV__) console.warn('[Highlights] Failed to load user:', error?.message || error);
        return null;
      });

      const country = (me?.preferences?.country_code || 'US').toUpperCase();

      // Real device coords only. `me.preferences.lat` / `me.lat` used to be
      // read here and both were dead: `User` has no top-level lat/lng column
      // and nothing in the app ever writes `preferences.lat`, so this always
      // sent no coords and silently degraded Trending to newest-first.
      const lat = viewerCoords?.lat;
      const lng = viewerCoords?.lng;

      const payload = await Highlights.fetch({
        country,
        limit: activeTab === 'top' ? 10 : 50,
        lat,
        lng,
        sort: activeTab,
      });

      // New servers return { sort, items }; old servers return the legacy
      // { nationalTop, ranked } buckets — keep both shapes working.
      const rawItems = Array.isArray(payload?.items) ? payload.items : null;
      const rawNationalTop = Array.isArray(payload?.nationalTop) ? payload.nationalTop : [];
      const rawRanked = Array.isArray(payload?.ranked) ? payload.ranked : [];

      // Cache all the raw posts for faster loading when navigating to post detail
      postCache.setBatch(rawItems ?? [...rawNationalTop, ...rawRanked]);

      return {
        tab: activeTab,
        rawItems,
        rawNationalTop,
        rawRanked,
        // Location for ranking calculations, only when both coordinates are valid
        userLocation:
          typeof lat === 'number' && typeof lng === 'number' && lat !== 0 && lng !== 0
            ? { lat, lng }
            : undefined,
      };
    },
  });

  const userLocation = highlightsPayload?.userLocation;
  // Tab the currently-rendered payload belongs to — lags activeTab while a
  // tab switch is in flight (placeholderData shows the old tab's list).
  const dataTab = highlightsPayload?.tab ?? activeTab;
  const nationalTop = useMemo(
    () =>
      (highlightsPayload?.rawNationalTop ?? [])
        .map(mapHighlightItem)
        .filter(Boolean) as HighlightItem[],
    [highlightsPayload]
  );
  const ranked = useMemo(
    () =>
      (highlightsPayload?.rawRanked ?? []).map(mapHighlightItem).filter(Boolean) as HighlightItem[],
    [highlightsPayload]
  );
  // Server-sorted items when available; legacy bucket merge otherwise.
  const serverSorted = highlightsPayload?.rawItems != null;
  const highlights = useMemo(() => {
    const source = highlightsPayload?.rawItems ?? [
      ...(highlightsPayload?.rawNationalTop ?? []),
      ...(highlightsPayload?.rawRanked ?? []),
    ];
    const mapped = source.map(mapHighlightItem).filter(Boolean) as HighlightItem[];
    return Array.from(new Map(mapped.map(item => [item.id, item])).values());
  }, [highlightsPayload]);

  // Error card only when highlights never loaded — a failed background
  // refetch keeps the cached list visible instead of blanking the screen.
  const error = isError && highlightsPayload === undefined ? 'Unable to load highlights.' : null;

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refetch();
    } finally {
      setRefreshing(false);
    }
  }, [refetch]);

  // Global search function for teams, events, users, and posts
  const performGlobalSearch = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSearchResults({ teams: [], events: [], users: [], organizations: [], posts: [] });
      setSearching(false);
      return;
    }

    setSearching(true);
    try {
      const [teamsRes, eventsRes, usersRes, orgsRes, unifiedRes] = await Promise.all([
        Team.list(query, false, { limit: 5 }).catch((error: any) => {
          if (__DEV__) console.warn('[Highlights] Team search failed:', error?.message || error);
          return [];
        }),
        Event.filter({ q: query, approval_status: 'approved' }, 'date', 5).catch((error: any) => {
          if (__DEV__) console.warn('[Highlights] Event search failed:', error?.message || error);
          return [];
        }),
        User.listAll(query, 5).catch((error: any) => {
          if (__DEV__) console.warn('[Highlights] User search failed:', error?.message || error);
          return [];
        }),
        Organization.list(query, 5).catch((error: any) => {
          if (__DEV__)
            console.warn('[Highlights] Organization search failed:', error?.message || error);
          return [];
        }),
        // Posts search must go through the server — the local `highlights`
        // array is only the current tab's already-loaded top 10-50 items
        // (itself country/media/date filtered), so a real post that isn't
        // in that small window was unfindable no matter how good the query.
        Search.unified(query, 10).catch((error: any) => {
          if (__DEV__) console.warn('[Highlights] Post search failed:', error?.message || error);
          return null;
        }),
      ]);

      const teams = Array.isArray(teamsRes) ? teamsRes.slice(0, 5) : [];
      const events = Array.isArray(eventsRes) ? eventsRes.slice(0, 5) : [];
      const users = Array.isArray(usersRes) ? usersRes.slice(0, 5) : [];
      const organizations = Array.isArray(orgsRes) ? orgsRes.slice(0, 5) : [];
      const rawPosts = Array.isArray(unifiedRes?.posts) ? unifiedRes.posts : [];
      const posts = rawPosts.map(mapHighlightItem).filter(Boolean) as HighlightItem[];

      setSearchResults({ teams, events, users, organizations, posts });
    } catch (err: any) {
      if (__DEV__) {
        if (__DEV__) console.error('[Highlights] Search failed:', err?.message || err);
      }
      setSearchResults({ teams: [], events: [], users: [], organizations: [], posts: [] });
    } finally {
      setSearching(false);
    }
  }, []);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      void performGlobalSearch(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery, performGlobalSearch]);

  const getFilteredHighlights = useCallback(() => {
    // New servers return each tab pre-sorted — render their order verbatim.
    // Defensive cap: a stale 50-item list must never render under a
    // Top-labeled payload.
    if (serverSorted) return dataTab === 'top' ? highlights.slice(0, 10) : highlights;

    // Legacy-server fallback: one consistent engagement metric for every
    // post (the old code compared server _score against raw engagement,
    // which are incompatible scales).
    const engagement = (p: HighlightItem) => (p.upvotes_count || 0) + (p._count?.comments || 0) * 2;
    const list = [...highlights];
    switch (dataTab) {
      case 'trending':
        // Product rule: Trending never shows posts older than 14 days.
        return list
          .filter(p => Date.now() - new Date(p.created_at || 0).getTime() <= 14 * 86400000)
          .sort((a, b) => engagement(b) - engagement(a));
      case 'recent':
        return list.sort(
          (a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
        );
      case 'top':
        // Product rule: top 10 by engagement over the last month.
        return list
          .filter(p => Date.now() - new Date(p.created_at || 0).getTime() <= 30 * 86400000)
          .sort((a, b) => engagement(b) - engagement(a))
          .slice(0, 10);
    }
  }, [highlights, dataTab, serverSorted]);

  const handleHighlightPress = useCallback(
    (item: HighlightItem, index?: number, filtered?: HighlightItem[]) => {
      const ids = filtered?.map(h => h.id).filter(Boolean) ?? [item.id];
      const postIds = ids.join(',');
      if (postIds && ids.length > 1) {
        router.push(
          `/post-detail?id=${item.id}&postIds=${encodeURIComponent(postIds)}&index=${index ?? 0}&from=highlights`
        );
      } else {
        router.push(`/post-detail?id=${item.id}&from=highlights`);
      }
    },
    [router]
  );

  const handleAuthorPress = useCallback(
    (authorId: string) => {
      // Navigate to user profile
      router.push(`/user-profile?id=${authorId}`);
    },
    [router]
  );

  const handleEventPress = useCallback(
    (event: any) => {
      Keyboard.dismiss();
      const eventId = event?.id || event?.event_id;
      if (eventId) {
        void router.push(buildEventDetailRoute(eventId, event?.game_id ?? event?.gameId));
        return;
      }

      const gameId = event?.game_id || event?.gameId;
      if (gameId) {
        void router.push({ pathname: '/game/[id]', params: { id: String(gameId) } });
        return;
      }

      Alert.alert('Event unavailable', 'This event is missing an identifier and cannot be opened.');
    },
    [router]
  );

  // Patch one post's vote fields inside every cached tab payload (items +
  // legacy buckets); the mapped highlights memo re-derives per tab.
  const patchHighlight = useCallback(
    (postId: string, patch: (h: any) => any) => {
      queryClient.setQueriesData({ queryKey: ['highlights'] }, (old: any) => {
        if (!old) return old;
        const apply = (arr: any[] | null | undefined) =>
          Array.isArray(arr)
            ? arr.map(h =>
                String(h?.id ?? h?.post_id ?? h?.highlight_id) === postId ? patch(h) : h
              )
            : arr;
        return {
          ...old,
          rawItems: apply(old.rawItems),
          rawNationalTop: apply(old.rawNationalTop),
          rawRanked: apply(old.rawRanked),
        };
      });
    },
    [queryClient]
  );

  const handleUpvote = useCallback(
    async (item: HighlightItem) => {
      if (!user) {
        promptForSignIn(() => router.push('/sign-in'), { message: 'Sign in to upvote.' });
        return;
      }
      // Optimistic update: toggle immediately for responsiveness
      const optimisticNext = !item.has_upvoted;
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      patchHighlight(item.id, h => ({
        ...h,
        has_upvoted: optimisticNext,
        upvotes_count: Math.max(0, (h.upvotes_count || 0) + (optimisticNext ? 1 : -1)),
      }));
      try {
        const r: any = await Post.toggleUpvote(item.id);
        const upvotedNow =
          typeof r?.has_upvoted === 'boolean' ? r.has_upvoted : Boolean(r?.upvoted);
        if (upvotedNow) {
          analytics.track(ANALYTICS_EVENTS.POST_UPVOTED, {
            post_id: item.id,
            source: 'highlights',
          });
        }
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        // Reconcile with server values
        patchHighlight(item.id, h => ({
          ...h,
          has_upvoted: typeof r?.has_upvoted === 'boolean' ? r.has_upvoted : Boolean(r?.upvoted),
          upvotes_count:
            typeof r?.count === 'number'
              ? r.count
              : typeof r?.upvotes_count === 'number'
                ? r.upvotes_count
                : h.upvotes_count,
        }));
      } catch (error) {
        // Revert optimistic update on failure
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        patchHighlight(item.id, h => ({
          ...h,
          has_upvoted: item.has_upvoted,
          upvotes_count: Math.max(0, (h.upvotes_count || 0) + (optimisticNext ? -1 : 1)),
        }));
        if (__DEV__) console.warn('[Highlights] Failed to toggle upvote:', error);
      }
    },
    [patchHighlight, user, router]
  );

  // The Trending medals are meaningful only when the score-ranked list is
  // actually led by an engaged post. If the top item has zero engagement,
  // nothing is genuinely trending (order is just recency), so we suppress the
  // medals rather than crown a #1 that earned nothing.
  const trendingRanked = useMemo(() => {
    if (dataTab !== 'trending') return false;
    const top = getFilteredHighlights()[0];
    if (!top) return false;
    return (top.upvotes_count || 0) + (top._count?.comments || 0) > 0;
  }, [dataTab, getFilteredHighlights]);

  const renderHighlight = ({ item, index }: { item: HighlightItem; index: number }) => (
    <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
      <HighlightCard
        item={item}
        index={index}
        currentTab={dataTab}
        nationalTop={nationalTop}
        ranked={ranked}
        userLocation={userLocation}
        onPress={() => handleHighlightPress(item, index, getFilteredHighlights())}
        onAuthorPress={handleAuthorPress}
        colorScheme={colorScheme}
        onUpvote={handleUpvote}
        trendingRanked={trendingRanked}
      />
    </View>
  );

  if (loading) {
    return (
      <SafeAreaView style={[styles.screen, { backgroundColor: Colors[colorScheme].background }]}>
        <StatusBar
          barStyle={colorScheme === 'dark' ? 'light-content' : 'dark-content'}
          backgroundColor={Colors[colorScheme].background}
        />
        <Stack.Screen options={{ title: 'Highlights', headerShown: false }} />
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#2563EB" />
          <Text style={styles.loadingText}>Loading sports highlights...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView style={[styles.screen, { backgroundColor: Colors[colorScheme].background }]}>
        <StatusBar
          barStyle={colorScheme === 'dark' ? 'light-content' : 'dark-content'}
          backgroundColor={Colors[colorScheme].background}
        />
        <Stack.Screen options={{ title: 'Highlights', headerShown: false }} />
        <View style={styles.errorContainer}>
          <Ionicons name="alert-circle" size={48} color="#DC2626" />
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={styles.retryButton} onPress={() => void refetch()}>
            <Text style={styles.retryButtonText}>Try Again</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const filteredHighlights = getFilteredHighlights();

  return (
    <SafeAreaView
      style={[styles.screen, { backgroundColor: Colors[colorScheme].background }]}
      edges={['left', 'right']}
    >
      <StatusBar
        barStyle={colorScheme === 'dark' ? 'light-content' : 'dark-content'}
        backgroundColor={Colors[colorScheme].background}
      />
      <Stack.Screen options={{ title: 'Highlights', headerShown: false }} />

      {/* Custom Header */}
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top,
            backgroundColor: Colors[colorScheme].card,
            borderBottomColor: Colors[colorScheme].border,
          },
        ]}
      >
        {/* Back button and title */}
        <View style={styles.headerRow}>
          <View style={styles.headerSpacer} />
          <Text
            style={[styles.headerTitleText, { color: Colors[colorScheme].text }]}
            numberOfLines={1}
          >
            Highlights
          </Text>
          <Pressable style={styles.headerSpacer} onPress={onRefresh} hitSlop={8}>
            <Ionicons
              name="refresh"
              size={22}
              color={refreshing ? Colors[colorScheme].tint : Colors[colorScheme].text}
              style={{ opacity: refreshing ? 0.5 : 1 }}
            />
          </Pressable>
        </View>
        {/* Search Bar */}
        <View style={{ zIndex: 10 }}>
          <View
            style={[
              styles.searchContainer,
              {
                backgroundColor: Colors[colorScheme].background,
                borderColor: Colors[colorScheme].border,
              },
            ]}
          >
            <Ionicons name="search" size={20} color={Colors[colorScheme].tabIconDefault} />
            <TextInput
              style={[styles.searchInput, { color: Colors[colorScheme].text }]}
              placeholder="Search users, teams, or organizations by name or username..."
              placeholderTextColor={Colors[colorScheme].tabIconDefault}
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoCorrect={false}
              autoCapitalize="none"
            />
            {searchQuery.length > 0 && (
              <Pressable onPress={() => setSearchQuery('')}>
                <Ionicons
                  name="close-circle"
                  size={20}
                  color={Colors[colorScheme].tabIconDefault}
                />
              </Pressable>
            )}
          </View>
          {/* Dropdown recommendations */}
          {searchQuery.length > 0 && !searching && (
            <View
              style={{
                position: 'absolute',
                top: 48,
                left: 0,
                right: 0,
                backgroundColor: Colors[colorScheme].background,
                borderColor: Colors[colorScheme].border,
                borderWidth: 1,
                borderTopWidth: 0,
                borderRadius: 8,
                shadowColor: '#000',
                shadowOpacity: 0.08,
                shadowRadius: 8,
                elevation: 2,
                zIndex: 20,
                maxHeight: 180,
              }}
            >
              {/* Users */}
              {searchResults.users.slice(0, 2).map(user => (
                <Pressable
                  key={user.id}
                  style={{
                    padding: 12,
                    borderBottomWidth: 1,
                    borderBottomColor: Colors[colorScheme].border,
                  }}
                  onPress={() => setSearchQuery(user.username || '')}
                >
                  <Text style={{ color: Colors[colorScheme].text }}>
                    👤 @{user.username || 'user'}
                  </Text>
                </Pressable>
              ))}
              {/* Teams */}
              {searchResults.teams.slice(0, 2).map(team => (
                <Pressable
                  key={team.id}
                  style={{
                    padding: 12,
                    borderBottomWidth: 1,
                    borderBottomColor: Colors[colorScheme].border,
                  }}
                  onPress={() => setSearchQuery(team.name)}
                >
                  <Text style={{ color: Colors[colorScheme].text }}>🏫 {team.name}</Text>
                </Pressable>
              ))}
              {/* Organizations */}
              {searchResults.organizations.slice(0, 2).map(org => (
                <Pressable
                  key={org.id}
                  style={{
                    padding: 12,
                    borderBottomWidth: 1,
                    borderBottomColor: Colors[colorScheme].border,
                  }}
                  onPress={() => setSearchQuery(org.name)}
                >
                  <Text style={{ color: Colors[colorScheme].text }}>🏆 {org.name}</Text>
                </Pressable>
              ))}
              {/* No recommendations — only when EVERY category (incl. events
                  and posts, shown in the full results list below) is empty, so
                  the dropdown never claims "nothing" while events render below. */}
              {searchResults.users.length === 0 &&
                searchResults.teams.length === 0 &&
                searchResults.organizations.length === 0 &&
                searchResults.events.length === 0 &&
                searchResults.posts.length === 0 && (
                  <View style={{ padding: 12 }}>
                    <Text style={{ color: Colors[colorScheme].tabIconDefault }}>
                      No recommendations
                    </Text>
                  </View>
                )}
            </View>
          )}
        </View>

        {/* Tabs */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tabsContainer}
          contentContainerStyle={styles.tabsContent}
        >
          <TabButton
            title="🔥 Trending"
            active={activeTab === 'trending'}
            onPress={() => setActiveTab('trending')}
            colorScheme={colorScheme}
          />
          <TabButton
            title="🕐 Recent"
            active={activeTab === 'recent'}
            onPress={() => setActiveTab('recent')}
            colorScheme={colorScheme}
          />
          <TabButton
            title="👑 Top"
            active={activeTab === 'top'}
            onPress={() => setActiveTab('top')}
            colorScheme={colorScheme}
          />
        </ScrollView>
      </View>

      {/* Show search results when searching */}
      {searchQuery.trim() ? (
        searching ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#2563EB" />
            <Text style={[styles.loadingText, { color: Colors[colorScheme].text }]}>
              Searching...
            </Text>
          </View>
        ) : (
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={styles.searchResultsContainer}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
          >
            {/* Teams */}
            {searchResults.teams.length > 0 && (
              <View style={styles.searchSection}>
                <Text style={[styles.searchSectionTitle, { color: Colors[colorScheme].text }]}>
                  🏫 Teams
                </Text>
                {searchResults.teams.map((team: any) => (
                  <Pressable
                    key={team.id}
                    style={[
                      styles.searchResultItem,
                      {
                        backgroundColor: Colors[colorScheme].card,
                        borderColor: Colors[colorScheme].border,
                      },
                    ]}
                    onPress={() => {
                      void router.push(`/team-page?id=${team.id}`);
                    }}
                  >
                    <Text style={[styles.searchResultTitle, { color: Colors[colorScheme].text }]}>
                      {team.name}
                    </Text>
                    <Text
                      style={[
                        styles.searchResultSubtitle,
                        { color: Colors[colorScheme].tabIconDefault },
                      ]}
                    >
                      {team.school_name || team.city || 'Team'}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}

            {/* Events */}
            {searchResults.events.length > 0 && (
              <View style={styles.searchSection}>
                <Text style={[styles.searchSectionTitle, { color: Colors[colorScheme].text }]}>
                  📅 Events
                </Text>
                {searchResults.events.map((event: any) => (
                  <Pressable
                    key={event.id}
                    style={[
                      styles.searchResultItem,
                      {
                        backgroundColor: Colors[colorScheme].card,
                        borderColor: Colors[colorScheme].border,
                      },
                    ]}
                    onPress={() => handleEventPress(event)}
                  >
                    <Text style={[styles.searchResultTitle, { color: Colors[colorScheme].text }]}>
                      {event.title}
                    </Text>
                    <Text
                      style={[
                        styles.searchResultSubtitle,
                        { color: Colors[colorScheme].tabIconDefault },
                      ]}
                    >
                      {event.description || 'Event'}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}

            {/* Users */}
            {searchResults.users.length > 0 && (
              <View style={styles.searchSection}>
                <Text style={[styles.searchSectionTitle, { color: Colors[colorScheme].text }]}>
                  👤 Users
                </Text>
                {searchResults.users.map((user: any) => (
                  <Pressable
                    key={user.id}
                    style={[
                      styles.searchResultItem,
                      {
                        backgroundColor: Colors[colorScheme].card,
                        borderColor: Colors[colorScheme].border,
                      },
                    ]}
                    onPress={() => {
                      void router.push(`/user-profile?id=${user.id}`);
                    }}
                  >
                    <Text style={[styles.searchResultTitle, { color: Colors[colorScheme].text }]}>
                      @{user.username || 'user'}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}

            {/* Organizations */}
            {searchResults.organizations.length > 0 && (
              <View style={styles.searchSection}>
                <Text style={[styles.searchSectionTitle, { color: Colors[colorScheme].text }]}>
                  🏆 Organizations
                </Text>
                {searchResults.organizations.map((org: any) => (
                  <Pressable
                    key={org.id}
                    style={[
                      styles.searchResultItem,
                      {
                        backgroundColor: Colors[colorScheme].card,
                        borderColor: Colors[colorScheme].border,
                      },
                    ]}
                    onPress={() => {
                      void router.push(`/organization?id=${org.id}` as any);
                    }}
                  >
                    <Text style={[styles.searchResultTitle, { color: Colors[colorScheme].text }]}>
                      {org.name}
                    </Text>
                    <Text
                      style={[
                        styles.searchResultSubtitle,
                        { color: Colors[colorScheme].tabIconDefault },
                      ]}
                    >
                      {org.sport || 'Organization'} {org.description ? `• ${org.description}` : ''}
                    </Text>
                  </Pressable>
                ))}
              </View>
            )}

            {/* Posts */}
            {searchResults.posts.length > 0 && (
              <View style={styles.searchSection}>
                <Text style={[styles.searchSectionTitle, { color: Colors[colorScheme].text }]}>
                  📝 Posts
                </Text>
                {searchResults.posts.map((post, idx) => (
                  <HighlightCard
                    key={post.id}
                    item={post}
                    index={idx}
                    currentTab={dataTab}
                    nationalTop={nationalTop}
                    ranked={ranked}
                    userLocation={userLocation}
                    onPress={it => handleHighlightPress(it, idx, searchResults.posts)}
                    onAuthorPress={handleAuthorPress}
                    colorScheme={colorScheme}
                    onUpvote={handleUpvote}
                  />
                ))}
              </View>
            )}

            {/* No results */}
            {searchResults.teams.length === 0 &&
              searchResults.events.length === 0 &&
              searchResults.users.length === 0 &&
              searchResults.organizations.length === 0 &&
              searchResults.posts.length === 0 && (
                <View style={styles.emptyContainer}>
                  <Ionicons
                    name="search-outline"
                    size={64}
                    color={Colors[colorScheme].tabIconDefault}
                  />
                  <Text style={[styles.emptyText, { color: Colors[colorScheme].text }]}>
                    No results found
                  </Text>
                  <Text
                    style={[styles.emptySubtext, { color: Colors[colorScheme].tabIconDefault }]}
                  >
                    Try a different search term
                  </Text>
                </View>
              )}
          </ScrollView>
        )
      ) : filteredHighlights.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Ionicons name="trophy-outline" size={64} color={Colors[colorScheme].tabIconDefault} />
          <Text style={[styles.emptyText, { color: Colors[colorScheme].text }]}>
            No highlights available
          </Text>
          <Text style={[styles.emptySubtext, { color: Colors[colorScheme].tabIconDefault }]}>
            Check back later for amazing sports moments
          </Text>
        </View>
      ) : (
        <FlatList
          data={filteredHighlights}
          renderItem={renderHighlight}
          keyExtractor={item => item.id}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingVertical: 8 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={Colors[colorScheme].tint}
            />
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
  },
  loadingText: {
    fontSize: 16,
    fontWeight: '500',
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
    gap: 16,
  },
  errorText: {
    fontSize: 16,
    color: '#DC2626',
    textAlign: 'center',
    fontWeight: '500',
  },
  retryButton: {
    backgroundColor: '#2563EB',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  retryButtonText: {
    color: '#fff',
    fontWeight: '600',
  },
  header: {
    borderBottomWidth: 1,
    paddingBottom: 8,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 56,
    paddingHorizontal: 16,
  },
  backButton: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: -12,
  },
  headerTitleText: {
    flex: 1,
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
    marginHorizontal: 16,
  },
  headerSpacer: {
    width: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerContent: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '800',
  },
  headerStats: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#FEF3C7',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  headerStatsText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#92400E',
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginBottom: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    padding: 0,
  },
  calendarContainer: {
    marginHorizontal: 16,
    marginBottom: 12,
  },
  dateButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    gap: 8,
  },
  dateButtonText: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
  },
  calendarHint: {
    fontSize: 12,
    marginTop: 6,
    fontStyle: 'italic',
  },
  tabsContainer: {
    paddingHorizontal: 16,
  },
  tabsContent: {
    gap: 8,
    paddingVertical: 4,
  },
  tabButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
  },
  activeTab: {},
  tabText: {
    fontSize: 14,
    fontWeight: '600',
  },
  activeTabText: {},
  pageIndicator: {
    alignItems: 'center',
    paddingVertical: 4,
  },
  pageIndicatorText: {
    fontSize: 12,
    fontWeight: '600',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32,
    gap: 12,
  },
  emptyText: {
    fontSize: 18,
    fontWeight: '600',
    textAlign: 'center',
  },
  emptySubtext: {
    fontSize: 14,
    textAlign: 'center',
  },
  list: {
    padding: 16,
    paddingBottom: 32,
  },
  card: {
    borderRadius: 16,
    marginBottom: 16,
    overflow: 'hidden',
    ...Platform.select({
      ios: {
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 8,
      },
      android: {
        elevation: 4,
      },
    }),
  },
  cardContainer: {
    flexDirection: 'row',
    height: CARD_HEIGHT,
  },
  mediaSection: {
    width: '40%',
    position: 'relative',
  },
  mediaContainer: {
    width: '100%',
    height: '100%',
    position: 'relative',
    backgroundColor: 'transparent',
    justifyContent: 'center',
    alignItems: 'center',
  },
  mediaImage: {
    width: '100%',
    height: '100%',
    backgroundColor: 'transparent',
  },
  noMediaContent: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  categoryIcon: {
    fontSize: 32,
  },
  noMediaText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#fff',
  },
  videoOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.3)',
  },
  playButton: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(0, 0, 0, 0.8)',
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 2, // Slight offset for visual centering
  },
  liveBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    backgroundColor: '#DC2626',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  liveText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '800',
  },
  contentSection: {
    flex: 1,
    // Web flexbox: without minWidth 0 the stats row's min-content width forces
    // this column wider than the card, horizontally overflowing the viewport.
    minWidth: 0,
    padding: 16,
    justifyContent: 'space-between',
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  categoryBadge: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 12,
  },
  categoryText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  countryFlag: {
    fontSize: 16,
  },
  cardTitle: {
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 20,
    marginBottom: 8,
  },
  authorRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  authorInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flex: 1,
  },
  authorAvatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
  },
  defaultAvatar: {
    backgroundColor: '#9CA3AF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  authorName: {
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
  },
  timeText: {
    fontSize: 11,
    // color: Uses dynamic color in JSX
    fontWeight: '500',
  },
  statsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    alignItems: 'center',
  },
  stat: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: 'rgba(37, 99, 235, 0.1)',
    ...Platform.select({
      ios: {
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.1,
        shadowRadius: 2,
      },
      android: {
        elevation: 2,
      },
    }),
  },
  statText: {
    fontSize: 12,
    fontWeight: '600',
    // color: Uses dynamic color in JSX
  },
  numberBadge: {
    position: 'absolute',
    top: 12,
    left: 12,
    zIndex: 10,
    width: 36,
    height: 36,
    borderRadius: 18,
    justifyContent: 'center',
    alignItems: 'center',
    ...Platform.select({
      ios: {
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.3,
        shadowRadius: 4,
      },
      android: {
        elevation: 6,
      },
    }),
  },
  numberBadgeText: {
    fontSize: 16,
    fontWeight: '800',
    color: '#fff',
  },
  searchResultsContainer: {
    padding: 16,
  },
  searchSection: {
    marginBottom: 24,
  },
  searchSectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 12,
  },
  searchResultItem: {
    padding: 16,
    borderRadius: 12,
    marginBottom: 8,
    borderWidth: 1,
  },
  searchResultTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  searchResultSubtitle: {
    fontSize: 14,
  },
});

export default HighlightsScreen;
