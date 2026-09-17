import { useBottomTabBarHeight } from '@react-navigation/bottom-tabs';
import { useFocusEffect } from '@react-navigation/native';
import { Stack, useRouter } from 'expo-router';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  type AppStateStatus,
  FlatList,
  Image as RNImage,
  InteractionManager,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
// @ts-ignore JS exports
import {
  Advertisement,
  Event,
  Feed,
  Game,
  Message,
  Notification as NotificationApi,
} from '@/api/entities';
import { BannerAd } from '@/components/BannerAd';
import { Colors } from '@/constants/Colors';
import SportFilterBar from '@/components/SportFilterBar';
import { useAuth } from '@/context/AuthProvider';
import { useColorScheme } from '@/hooks/useColorScheme';
import { getAuthSnapshot } from '@/utils/authState';
import { toUserMessage } from '@/utils/toUserMessage';
import { Ionicons } from '@expo/vector-icons';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import * as Linking from 'expo-linking';
import * as Location from 'expo-location';

import PostCard from '@/components/PostCard';
import { PostCardSkeleton } from '@/components/ui/SkeletonCard';
import { queryClient } from '@/lib/queryClient';
import {
  buildFeedGameQueries,
  mergeFeedGames,
  type FeedGameQueryPlan,
} from '@/utils/feedGameQueries';
import {
  dedupeFeedEntities,
  filterProEventsAlreadyRepresentedByGames,
  getFeedItemSport,
  normalizeFeedEvents,
  normalizeGamesPage,
  type FeedBundleParams,
  type GameItem,
} from '@/utils/feedNormalization';
import { buildEventDetailRoute } from '@/utils/eventRoutes';
import { getLiveBounds, isGameLive, isGameOver, shouldPinToFeed } from '@/utils/liveWindow';
import { optimizeImageUrl } from '@/utils/imageUrl';
import { EventFeedCard } from '@/components/ui/EventFeedCard';
import { prefetchGameSummary } from '@/utils/prefetch';
import {
  getNotificationHrefForUser,
  getNotificationSubtitle,
  getNotificationTitle,
  isSystemNotification,
} from '@/utils/notificationPresentation';
import GameVerticalFeedScreen from './game-details/GameVerticalFeedScreen';

const VARSITYHUB_LOGO = require('../assets/images/logo.png');

function FullBleedCardImage({ uri }: { uri: string }) {
  if (Platform.OS === 'web') {
    return <RNImage source={{ uri }} style={StyleSheet.absoluteFillObject} resizeMode="cover" />;
  }

  return <Image source={{ uri }} style={StyleSheet.absoluteFillObject} contentFit="cover" />;
}

type FeedItem =
  | { _t: 'email_reminder' }
  | { _t: 'location_prompt' }
  | { _t: 'seed_banner' }
  | { _t: 'game'; data: GameItem; idx: number }
  | { _t: 'pinned_game'; data: GameItem; idx: number }
  | { _t: 'ad'; ad: any | null; idx: number }
  | { _t: 'section_header'; title: string; key: string }
  | { _t: 'followed_post'; data: any; idx: number }
  | { _t: 'followed_empty'; section: 'people' | 'teams' }
  | { _t: 'followed_load_more'; section: 'people' | 'teams' }
  | { _t: 'followed_teams_post'; data: any; idx: number }
  | { _t: 'past_game'; data: GameItem; idx: number }
  | { _t: 'footer' };

const SOCIAL_POSTS_PAGE_SIZE = 20;

// Feed fetch plan: upcoming (live + future, ascending) and the recent-past
// recap are SEPARATE queries with separate page budgets. A single ascending
// query starting 3 days back breaks once the recent past holds more than a
// page of games (seeded pro slates guarantee it): page one never reaches
// today, so upcoming games exist on the map but never in the feed.
// See utils/feedGameQueries.ts.

// RSVP Badge Component
const RSVPBadge = ({
  gameItem,
  initialRsvp,
  onRSVPChange,
  isLive = false,
}: {
  gameItem: any;
  initialRsvp?: { going: boolean; count: number };
  onRSVPChange?: () => void;
  isLive?: boolean;
}) => {
  const colorScheme = useColorScheme();
  const router = useRouter();
  const { user } = useAuth();
  const [isRsvped, setIsRsvped] = useState(false);
  const [rsvpCount, setRsvpCount] = useState((gameItem as any).rsvpCount || 0);
  const [isLoading, setIsLoading] = useState(false);
  const isEventPast = useMemo(() => {
    const iso = gameItem?.date;
    if (!iso) return false;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return false;
    return date.getTime() < Date.now();
  }, [gameItem?.date]);

  // Status comes from the parent's batched /events/rsvp-summary fetch — one
  // request for the whole list instead of one per badge.
  useEffect(() => {
    if (initialRsvp) {
      setIsRsvped(initialRsvp.going);
      setRsvpCount(initialRsvp.count);
    }
  }, [initialRsvp]);

  const handleRSVP = async () => {
    if (isLoading || !gameItem.event_id) return;
    if (!user) {
      void router.push('/sign-in');
      return;
    }
    if (isEventPast) {
      Alert.alert('Watching closed', 'You cannot mark events as watching once they have occurred.');
      return;
    }

    setIsLoading(true);
    try {
      const newRsvpState = !isRsvped;
      const response: any = await Event.rsvp(gameItem.event_id, newRsvpState);
      const entityLabel = gameItem.source_type === 'event' ? 'event' : 'game';

      setIsRsvped(response.going || response.attending || false);
      setRsvpCount(response.count || 0);

      Alert.alert(
        newRsvpState ? "You're Watching" : 'Removed',
        newRsvpState
          ? `You're now marked as watching this ${entityLabel}!`
          : `You're no longer marked as watching this ${entityLabel}.`
      );

      onRSVPChange?.();
    } catch (error: any) {
      const status = error?.status;
      const message = String(error?.message || error?.data?.error || '');
      if (status === 400 && /event has passed/i.test(message)) {
        Alert.alert(
          'Watching closed',
          'You cannot mark events as watching once they have occurred.'
        );
      } else {
        if (__DEV__) console.error('Watching toggle error:', error);
        Alert.alert('Error', 'Failed to update watching status. Please try again.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  // Watching is a pre-event action. Live and past cards intentionally have no
  // bottom-right count/control (owner note, September 15, 2026).
  if (isLive || isEventPast) return null;

  const badgeText = isRsvped || rsvpCount > 0 ? `📺 ${rsvpCount}` : '📺';
  const badgeA11yLabel = isRsvped
    ? `${rsvpCount} watching - Tap to undo`
    : rsvpCount > 0
      ? `${rsvpCount} watching - Tap to mark as watching`
      : 'Tap to mark as watching';

  return (
    <Pressable
      testID="feed-rsvp-button"
      onPress={handleRSVP}
      disabled={isLoading}
      style={{
        position: 'absolute',
        right: 14,
        bottom: 14,
        backgroundColor: isRsvped
          ? 'rgba(34, 197, 94, 0.9)'
          : colorScheme === 'dark'
            ? 'rgba(30,41,59,0.85)'
            : 'rgba(0,0,0,0.75)',
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderRadius: 20,
        zIndex: 1000,
        opacity: isLoading ? 0.6 : 1,
      }}
      accessibilityRole={Platform.OS === 'web' ? undefined : 'button'}
      accessibilityLabel={badgeA11yLabel}
    >
      <Text style={{ color: 'white', fontSize: 12, fontWeight: '600' }}>{badgeText}</Text>
    </Pressable>
  );
};

const deriveTeamLabels = (game: GameItem): { teamA: string; teamB: string } => {
  const title = typeof game.title === 'string' ? game.title : '';
  if (title) {
    const parts = title
      .split(/\s+vs\.?\s+/i)
      .map(part => part.trim())
      .filter(Boolean);
    if (parts.length >= 2) {
      return { teamA: parts[0], teamB: parts[1] };
    }
  }
  return { teamA: 'Team A', teamB: 'Team B' };
};

type VotePreviewEntry = {
  teamA: number;
  teamB: number;
  total: number;
  pctA: number;
  pctB: number;
  teamALabel: string;
  teamBLabel: string;
  teamALabelShort: string;
  teamBLabelShort: string;
};

const shortenLabel = (label: string) => {
  if (!label) return '';
  const firstWord = label.split(/\s+/)[0] || label;
  const trimmed = firstWord.trim();
  if (trimmed.length <= 10) return trimmed;
  return `${trimmed.slice(0, 9)}...`;
};

const buildVotePreviewEntry = (
  payload: any,
  labels: { teamA: string; teamB: string }
): VotePreviewEntry => {
  const toNumber = (value: any) => (typeof value === 'number' ? value : 0);
  const teamA = Math.max(0, toNumber(payload?.teamA ?? payload?.team_a));
  const teamB = Math.max(0, toNumber(payload?.teamB ?? payload?.team_b));
  const total = teamA + teamB;
  const pctA = total ? Math.round((teamA / total) * 100) : 0;
  const pctB = total ? 100 - pctA : 0;
  const fullLabelA = payload?.teamALabel ?? payload?.team_a_label ?? labels.teamA;
  const fullLabelB = payload?.teamBLabel ?? payload?.team_b_label ?? labels.teamB;
  return {
    teamA,
    teamB,
    total,
    pctA,
    pctB,
    teamALabel: fullLabelA,
    teamBLabel: fullLabelB,
    teamALabelShort: shortenLabel(fullLabelA),
    teamBLabelShort: shortenLabel(fullLabelB),
  };
};

type FeedGameCardProps = {
  gameItem: GameItem;
  isLive: boolean;
  // Owner ask (Sept 2026): a live card's border goes red -> gold once someone
  // has posted about it. Undefined/false renders the original red.
  hasPosts?: boolean;
  testIDPrefix: string;
  voteSummary: VotePreviewEntry | null;
  rsvp: { going: boolean; count: number } | undefined;
  colorScheme: 'light' | 'dark';
  onPress: (item: GameItem) => void;
  onRSVPChange: () => void;
};

// Memoized so a card only re-renders when ITS OWN data changes. Previously the
// card was inline JSX that read the whole voteSummaries/rsvpSummaries maps, so
// any single game's summary loading (or any of the screen's ~34 state updates)
// re-rendered every visible card. The maps are built with {...prev}, so an
// unchanged game keeps the same voteSummary/rsvp reference and memo skips it.
const FeedGameCard = memo(function FeedGameCard({
  gameItem,
  isLive,
  hasPosts,
  testIDPrefix,
  voteSummary,
  rsvp,
  colorScheme,
  onPress,
  onRSVPChange,
}: FeedGameCardProps) {
  const isEventOnly = gameItem.source_type === 'event';
  const voteText = voteSummary
    ? `${voteSummary.teamALabelShort} ${voteSummary.pctA}% | ${voteSummary.teamBLabelShort} ${voteSummary.pctB}%`
    : null;

  return (
    <EventFeedCard
      item={gameItem as any}
      colorScheme={colorScheme}
      isLive={isLive}
      hasPosts={hasPosts}
      voteText={voteText}
      testID={`${testIDPrefix}-game-card-${gameItem.id}`}
      onPressIn={() => {
        if (!isEventOnly) prefetchGameSummary(String(gameItem.id));
      }}
      onPress={() => onPress(gameItem)}
      badge={
        <RSVPBadge
          gameItem={gameItem}
          initialRsvp={rsvp}
          onRSVPChange={onRSVPChange}
          isLive={isLive}
        />
      }
    />
  );
});

export default function FeedScreen() {
  const router = useRouter();
  const { user, checkAuth } = useAuth();
  const insets = useSafeAreaInsets();
  const tabBarHeight = useBottomTabBarHeight();
  const colorScheme = useColorScheme() ?? 'light';
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [webHydrated, setWebHydrated] = useState(Platform.OS !== 'web');
  const [games, setGames] = useState<GameItem[]>([]);
  const [gamesCursor, setGamesCursor] = useState<string | null>(null);
  const [hasMoreGames, setHasMoreGames] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedFeedSport, setSelectedFeedSport] = useState<string | null>(null);
  const [query] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [me, setMe] = useState<any>(null);
  const emailVerified = !!me?.email_verified;

  const [verticalFeedModalVisible, setVerticalFeedModalVisible] = useState(false);
  const [activeVerticalFeedGameId, setActiveVerticalFeedGameId] = useState<string | null>(null);

  const [highlightPreview, setHighlightPreview] = useState<any | null>(null);
  const [sponsoredAds, setSponsoredAds] = useState<any[]>([]);
  const [hasDeviceLocation, setHasDeviceLocation] = useState(false);
  // Unrounded last-known position, kept only to decide whether the viewer is
  // physically at a live event's venue (see the pinned-event rule below). The
  // copy sent to the server stays rounded for cache-key stability.
  const [viewerPosition, setViewerPosition] = useState<{
    latitude: number;
    longitude: number;
  } | null>(null);
  const [locationPromptDismissed, setLocationPromptDismissed] = useState(false);
  const [followedPosts, setFollowedPosts] = useState<any[]>([]);
  const [followedPostsCursor, setFollowedPostsCursor] = useState<string | null>(null);
  const [loadingMoreFollowedPosts, setLoadingMoreFollowedPosts] = useState(false);
  const [followedFeedMeta, setFollowedFeedMeta] = useState<{ following_count: number } | undefined>(
    undefined
  );
  const [followedTeamsPosts, setFollowedTeamsPosts] = useState<any[]>([]);
  const [followedTeamsPostsCursor, setFollowedTeamsPostsCursor] = useState<string | null>(null);
  const [loadingMoreFollowedTeamsPosts, setLoadingMoreFollowedTeamsPosts] = useState(false);
  const [followedTeamsFeedMeta, setFollowedTeamsFeedMeta] = useState<
    { followed_teams_count: number } | undefined
  >(undefined);
  const [socialFeedWarning, setSocialFeedWarning] = useState<string | null>(null);
  const voteSummariesRef = useRef<Record<string, VotePreviewEntry>>({});
  const [voteSummaries, setVoteSummaries] = useState<Record<string, VotePreviewEntry>>({});
  // Owner ask (Sept 2026): a live game that gets a post should move to the top
  // of its section and its border should go from red to gold. Keyed by game id.
  // Post counts per live/recent event id, keyed by game/event id. The count
  // drives both the gold-border promotion (count > 0) and the post-counter pill
  // that replaces "Watching closed".
  const postsActivityRef = useRef<Record<string, number>>({});
  const [postsActivity, setPostsActivity] = useState<Record<string, number>>({});
  const postsActivityGamesRef = useRef<GameItem[]>([]);
  const postsActivityFocusedRef = useRef(false);
  const postsActivityAppStateRef = useRef<AppStateStatus>(AppState.currentState ?? 'inactive');
  const postsActivityOwnershipRef = useRef(0);
  const postsActivityInFlightRef = useRef(false);
  const postsActivityReturnRefreshPendingRef = useRef(false);
  const postsActivityRefreshRef = useRef<(() => void) | null>(null);
  const hasFocusedActivityOnceRef = useRef(false);
  const postsActivityIdentity = user?.id == null ? 'guest' : String(user.id);
  const postsActivityIdentityRef = useRef(postsActivityIdentity);
  postsActivityGamesRef.current = games;
  postsActivityIdentityRef.current = postsActivityIdentity;
  const rsvpSummariesRef = useRef<Record<string, { going: boolean; count: number }>>({});
  const [rsvpSummaries, setRsvpSummaries] = useState<
    Record<string, { going: boolean; count: number }>
  >({});
  const [showSeedBanner, setShowSeedBanner] = useState(false);
  const [unreadNotifCount, setUnreadNotifCount] = useState(0);
  const [unreadMessagesCount, setUnreadMessagesCount] = useState(0);
  const [notificationsMenuOpen, setNotificationsMenuOpen] = useState(false);

  // State for notifications in modal
  const [notificationsList, setNotificationsList] = useState<any[]>([]);
  const [loadingNotifications, setLoadingNotifications] = useState(false);
  const [notificationsError, setNotificationsError] = useState(false);
  const [notificationsReloadKey, setNotificationsReloadKey] = useState(0);

  // Ad rotation timer state - based on slide requirements
  const [currentAdIndex, setCurrentAdIndex] = useState(0);
  const [isShowingPromoCard, setIsShowingPromoCard] = useState(false);
  const adCycleStartTimeRef = useRef(Date.now());

  // Performance: cooldown to prevent re-fetching within 30s of the last successful load
  const lastLoadTimestampRef = useRef(0);
  const loadInFlightRef = useRef(false);
  const loadRequestIdRef = useRef(0);
  // The query plan of the latest load. _loadMore must reuse the SAME dateFrom
  // anchor the cursor was minted against — recomputing it mid-pagination
  // shifts the where-clause under the cursor.
  const feedQueryPlanRef = useRef<FeedGameQueryPlan | null>(null);
  const feedBundleParamsRef = useRef<FeedBundleParams | null>(null);
  const hasFocusedOnceRef = useRef(false);
  const LOAD_COOLDOWN_MS = 30_000;

  useEffect(() => {
    return () => {
      loadRequestIdRef.current += 1;
      loadInFlightRef.current = false;
    };
  }, []);

  useEffect(() => {
    postsActivityOwnershipRef.current += 1;
  }, [postsActivityIdentity]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    setWebHydrated(true);
  }, []);

  const preloadVoteSummaries = useCallback(async (gameList: GameItem[]) => {
    const candidates = gameList
      .filter(game => game.source_type !== 'event')
      .map(game => ({ id: String(game.id), labels: deriveTeamLabels(game) }))
      .filter(entry => entry.id && !voteSummariesRef.current[entry.id]);
    if (!candidates.length) return;
    const limited = candidates.slice(0, 12);
    const ids = limited.map(e => e.id);
    try {
      const batch = await Game.votesSummaryBatch(ids);
      const next = { ...voteSummariesRef.current };
      limited.forEach(entry => {
        const value = (batch as Record<string, any>)?.[entry.id];
        if (value) {
          try {
            next[entry.id] = buildVotePreviewEntry(value, entry.labels);
          } catch (err) {
            if (__DEV__) console.warn('Vote summary parse failed', err);
          }
        }
      });
      if (Object.keys(next).length !== Object.keys(voteSummariesRef.current).length) {
        setVoteSummaries(next);
        voteSummariesRef.current = next;
      }
    } catch (err) {
      if (__DEV__) console.warn('Vote summary batch failed', err);
    }
  }, []);

  // Live AND past events need post counts: live cards get the gold-border/
  // top-of-feed promotion (count > 0), and every live-or-past card shows the
  // post-counter pill in place of "Watching closed" (owner ask, Sept 2026).
  // Future cards keep the watch toggle, so they're skipped here. Event-only
  // pages (source_type === 'event') are included too — /games/posts-summary
  // falls back to a standalone-event lookup for any id that isn't a Game, so
  // they can go gold on the feed the same way they already can on the map
  // (owner "commandments" parity rule, 2026-09-14).
  const preloadPostsActivity = useCallback(async (gameList: GameItem[]) => {
    if (
      !postsActivityFocusedRef.current ||
      postsActivityAppStateRef.current !== 'active' ||
      postsActivityInFlightRef.current
    ) {
      return;
    }
    const now = Date.now();
    const ids = gameList
      .filter(game => isGameLive(game, now) || isGameOver(game, now))
      .map(game => String(game.id))
      .filter(id => id)
      .slice(0, 50);
    if (!ids.length) return;
    const ownership = postsActivityOwnershipRef.current;
    const identity = postsActivityIdentityRef.current;
    postsActivityInFlightRef.current = true;
    try {
      const batch = await Game.postsSummaryBatch(ids);
      if (
        !postsActivityFocusedRef.current ||
        postsActivityAppStateRef.current !== 'active' ||
        postsActivityOwnershipRef.current !== ownership ||
        postsActivityIdentityRef.current !== identity
      ) {
        return;
      }
      const responseNow = Date.now();
      const currentIds = new Set(
        postsActivityGamesRef.current
          .filter(game => isGameLive(game, responseNow) || isGameOver(game, responseNow))
          .map(game => String(game.id))
          .filter(id => id)
          .slice(0, 50)
      );
      const next = { ...postsActivityRef.current };
      let changed = false;
      ids.forEach(id => {
        if (!currentIds.has(id)) return;
        const value = Number((batch as Record<string, number>)?.[id] ?? 0);
        if (next[id] !== value) {
          next[id] = value;
          changed = true;
        }
      });
      if (changed) {
        setPostsActivity(next);
        postsActivityRef.current = next;
      }
    } catch (err) {
      if (__DEV__) console.warn('Posts activity batch failed', err);
    } finally {
      postsActivityInFlightRef.current = false;
      if (
        postsActivityReturnRefreshPendingRef.current &&
        postsActivityFocusedRef.current &&
        postsActivityAppStateRef.current === 'active'
      ) {
        postsActivityReturnRefreshPendingRef.current = false;
        postsActivityRefreshRef.current?.();
      }
    }
  }, []);

  const refreshPostsActivity = useCallback(
    (queueIfBusy = false) => {
      if (postsActivityInFlightRef.current) {
        if (queueIfBusy) postsActivityReturnRefreshPendingRef.current = true;
        return;
      }
      void preloadPostsActivity(postsActivityGamesRef.current);
    },
    [preloadPostsActivity]
  );
  postsActivityRefreshRef.current = refreshPostsActivity;

  const preloadRsvpSummaries = useCallback(async (gameList: GameItem[]) => {
    const now = Date.now();
    const ids = gameList
      .map(game => String((game as any).event_id || ''))
      .filter(id => id && !rsvpSummariesRef.current[id])
      .filter((id, i, arr) => arr.indexOf(id) === i)
      .slice(0, 50);
    // Past events never show a live badge state, so don't fetch for them
    const upcoming = gameList.filter(g => {
      const id = String((g as any).event_id || '');
      if (!ids.includes(id)) return false;
      const d = new Date((g as any).date || 0).getTime();
      return !Number.isFinite(d) || d >= now;
    });
    const wanted = upcoming.map(g => String((g as any).event_id));
    if (!wanted.length) return;
    try {
      const batch = await Event.rsvpSummaryBatch(wanted);
      const next = { ...rsvpSummariesRef.current, ...(batch || {}) };
      rsvpSummariesRef.current = next;
      setRsvpSummaries(next);
    } catch (err) {
      if (__DEV__) console.warn('[feed] RSVP summary batch failed:', err);
    }
  }, []);

  const submitAdReport = useCallback(async (adId: string, reason: string) => {
    try {
      await Advertisement.report(adId, reason);
      Alert.alert('Report Sent', 'Thanks. Our team will review this ad.');
    } catch (err: any) {
      if (err?.status === 409) {
        Alert.alert('Already Reported', 'You already reported this ad recently.');
        return;
      }
      if (err?.status === 401) {
        Alert.alert('Sign In Required', 'You need to be signed in to report an ad.');
        return;
      }
      Alert.alert('Unable to Report', toUserMessage(err, 'Please try again later.'));
    }
  }, []);

  const showAdReportOptions = useCallback(
    (ad: any) => {
      Alert.alert('Report Ad', `Report "${ad?.business_name || 'this ad'}" for:`, [
        { text: 'Spam', onPress: () => void submitAdReport(String(ad.id), 'spam') },
        {
          text: 'False Info',
          onPress: () => void submitAdReport(String(ad.id), 'false_information'),
        },
        { text: 'Other', onPress: () => void submitAdReport(String(ad.id), 'other') },
      ]);
    },
    [submitAdReport]
  );

  const load = useCallback(
    async ({ silent = false, force = false }: { silent?: boolean; force?: boolean } = {}) => {
      // Performance: skip silent reloads if data is fresh (< 30s old).
      // force=true (explicit pull-to-refresh) always refetches — a user pull
      // must never be a no-op.
      if (silent && !force && Date.now() - lastLoadTimestampRef.current < LOAD_COOLDOWN_MS) return;
      // Deduplicate concurrent load calls
      if (loadInFlightRef.current && silent) return;
      loadInFlightRef.current = true;
      const requestId = ++loadRequestIdRef.current;
      const isCurrentRequest = () => loadRequestIdRef.current === requestId;
      if (!silent) setLoading(true);
      setError(null);
      try {
        const userPromise = getAuthSnapshot(checkAuth, user)
          .then(user => {
            if (isCurrentRequest()) setMe(user);
            return user;
          })
          .catch(err => {
            if (__DEV__) console.warn('Feed load: unable to fetch user', err);
            return null;
          });

        // Resolve viewer coords BEFORE the games queries so the server can
        // select nearest-first games ("always show games closest to them").
        // Last-known position only — never getCurrentPositionAsync here, it
        // can block the feed for seconds. No coords is fine: the server falls
        // back to the signed-in viewer's zip preference. Coords are rounded
        // to 2 decimals (~1km) so cache keys stay stable across small moves.
        let viewerCoords: { lat: number; lng: number } | null = null;
        try {
          const { status } = await Location.getForegroundPermissionsAsync();
          if (status === 'granted') {
            const loc = await Location.getLastKnownPositionAsync().catch(() => null);
            if (loc) {
              viewerCoords = {
                lat: Math.round(loc.coords.latitude * 100) / 100,
                lng: Math.round(loc.coords.longitude * 100) / 100,
              };
              // Unrounded — the at-venue check runs against a 3km radius, which
              // the ~1km rounding above would blur.
              setViewerPosition({
                latitude: loc.coords.latitude,
                longitude: loc.coords.longitude,
              });
            }
          }
        } catch (e) {
          if (__DEV__) console.warn('Feed: location for game proximity failed', e);
        }

        // Load games with better error handling. Route through the shared
        // react-query cache so the games list is deduped across screens and a
        // cold remount of the feed renders instantly from cache (the 30s
        // staleTime mirrors this screen's own LOAD_COOLDOWN_MS).
        // Upcoming and the past recap are separate queries with separate page
        // budgets (see utils/feedGameQueries.ts); the upcoming query is the
        // primary one — it owns the pagination cursor and the error state.
        const queryPlan = buildFeedGameQueries(Date.now());
        const proLookaheadTo = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000).toISOString();
        feedQueryPlanRef.current = queryPlan;
        // First paint waits only for the core game pages. Pro/NCAA/event-only
        // rows are useful enrichment, but they should not hold the feed spinner.
        const upcomingPromise = queryClient
          .fetchQuery({
            queryKey: [
              'feed-games-upcoming',
              queryPlan.upcoming.options.dateFrom,
              viewerCoords?.lat ?? null,
              viewerCoords?.lng ?? null,
            ],
            queryFn: () => Game.list(queryPlan.upcoming.sort, queryPlan.upcoming.options),
          })
          .catch((err: any) => {
            if (__DEV__) console.error('[Feed] Failed to load games:', err);
            // If it's a network error, show a more helpful message
            if (err?.isNetworkError || err?.status === 0) {
              setError('Unable to connect to server. Please check your internet connection.');
            } else if (err?.status === 401 || err?.status === 403) {
              setError('Unable to load games right now.');
            } else {
              setError('Unable to load games. Please try again.');
            }
            return null;
          });
        const pastGamesPromise = queryClient
          .fetchQuery({
            queryKey: [
              'feed-games-past',
              queryPlan.past.options.dateFrom,
              viewerCoords?.lat ?? null,
              viewerCoords?.lng ?? null,
            ],
            queryFn: () => Game.list(queryPlan.past.sort, queryPlan.past.options),
          })
          .catch((err: any) => {
            if (__DEV__) console.warn('[Feed] Failed to load past games:', err);
            return null;
          });
        const marqueeGamesPromise = queryClient
          .fetchQuery({
            queryKey: [
              'feed-games-marquee',
              queryPlan.marquee.options.dateFrom,
              viewerCoords?.lat ?? null,
              viewerCoords?.lng ?? null,
            ],
            queryFn: () => Game.list(queryPlan.marquee.sort, queryPlan.marquee.options),
          })
          .catch((err: any) => {
            if (__DEV__) console.warn('[Feed] Failed to load marquee games:', err);
            return null;
          });

        // Upcoming games are the first useful screen. Do not make them wait
        // for recap/marquee requests—the slower secondary pages merge in just
        // below after the spinner has already cleared.
        const upcomingData = await upcomingPromise;

        const upcomingPage = normalizeGamesPage(upcomingData);
        let cursor = upcomingPage.cursor;
        let normalizedGames = dedupeFeedEntities(mergeFeedGames(upcomingPage.games));

        // If no games exist, seed sample games as real DB records (stories/polls work)
        if ((!normalizedGames || normalizedGames.length === 0) && upcomingData !== null) {
          try {
            const { httpPost } = await import('@/api/http');
            await httpPost('/games/seed-samples', {});
            // Re-fetch games now that seeds exist
            const seeded = await Game.list(
              queryPlan.upcoming.sort,
              queryPlan.upcoming.options
            ).catch(() => ({ games: [] }));
            const seededPage = normalizeGamesPage(seeded);
            if (seededPage.games.length > 0) {
              normalizedGames = seededPage.games;
              cursor = seededPage.cursor;
              if (isCurrentRequest()) setShowSeedBanner(true);
            }
          } catch (seedErr: any) {
            if (__DEV__) console.warn('[feed] seed-samples failed:', seedErr?.message);
          }
        }

        if (isCurrentRequest()) {
          setGames(normalizedGames);
          setGamesCursor(cursor);
          setHasMoreGames(!!cursor);
          if (!silent) setLoading(false);
        }

        void Promise.all([pastGamesPromise, marqueeGamesPromise]).then(
          ([pastGamesData, marqueeGamesData]) => {
            if (!isCurrentRequest()) return;
            setGames(previous =>
              dedupeFeedEntities(
                mergeFeedGames([
                  ...previous,
                  ...normalizeGamesPage(pastGamesData).games,
                  ...upcomingPage.games,
                  ...normalizeGamesPage(marqueeGamesData).games,
                ])
              )
            );
          }
        );

        void (async () => {
          try {
            const [
              proUpcomingData,
              proPastData,
              varsityhubUpcomingEventsData,
              varsityhubPastEventsData,
            ] = await Promise.all([
              queryClient
                .fetchQuery({
                  queryKey: ['feed-pro-events-upcoming', queryPlan.upcoming.options.dateFrom],
                  queryFn: () =>
                    Event.filter(
                      {
                        event_type: 'game',
                        pro_only: true,
                        event_only: true,
                        from: queryPlan.upcoming.options.dateFrom,
                        to: proLookaheadTo,
                      },
                      'date',
                      300
                    ),
                })
                .catch((err: any) => {
                  if (__DEV__) console.warn('[Feed] Failed to load pro upcoming events:', err);
                  return null;
                }),
              queryClient
                .fetchQuery({
                  queryKey: [
                    'feed-pro-events-past',
                    queryPlan.past.options.dateFrom,
                    queryPlan.past.options.dateTo ?? null,
                  ],
                  queryFn: () =>
                    Event.filter(
                      {
                        event_type: 'game',
                        pro_only: true,
                        event_only: true,
                        from: queryPlan.past.options.dateFrom,
                        to: queryPlan.past.options.dateTo,
                      },
                      '-date',
                      30
                    ),
                })
                .catch((err: any) => {
                  if (__DEV__) console.warn('[Feed] Failed to load pro past events:', err);
                  return null;
                }),
              queryClient
                .fetchQuery({
                  queryKey: [
                    'feed-varsityhub-events-upcoming',
                    queryPlan.upcoming.options.dateFrom,
                    queryPlan.upcoming.options.dateTo ?? null,
                  ],
                  queryFn: () =>
                    Event.filter(
                      {
                        event_only: true,
                        from: queryPlan.upcoming.options.dateFrom,
                        to: queryPlan.upcoming.options.dateTo,
                      },
                      'date',
                      100
                    ),
                })
                .catch((err: any) => {
                  if (__DEV__)
                    console.warn('[Feed] Failed to load VarsityHub upcoming events:', err);
                  return null;
                }),
              queryClient
                .fetchQuery({
                  queryKey: [
                    'feed-varsityhub-events-past',
                    queryPlan.past.options.dateFrom,
                    queryPlan.past.options.dateTo ?? null,
                  ],
                  queryFn: () =>
                    Event.filter(
                      {
                        event_only: true,
                        from: queryPlan.past.options.dateFrom,
                        to: queryPlan.past.options.dateTo,
                      },
                      '-date',
                      100
                    ),
                })
                .catch((err: any) => {
                  if (__DEV__) console.warn('[Feed] Failed to load VarsityHub past events:', err);
                  return null;
                }),
            ]);

            if (!isCurrentRequest()) return;
            const proPastRows = filterProEventsAlreadyRepresentedByGames(
              upcomingPage.games,
              normalizeFeedEvents(proPastData)
            );
            const proUpcomingRows = filterProEventsAlreadyRepresentedByGames(
              upcomingPage.games,
              normalizeFeedEvents(proUpcomingData)
            );
            const varsityhubEventRows = filterProEventsAlreadyRepresentedByGames(
              upcomingPage.games,
              normalizeFeedEvents(varsityhubUpcomingEventsData)
            );
            const varsityhubPastEventRows = filterProEventsAlreadyRepresentedByGames(
              upcomingPage.games,
              normalizeFeedEvents(varsityhubPastEventsData)
            );
            const enrichmentRows = [
              proPastRows,
              proUpcomingRows,
              varsityhubEventRows,
              varsityhubPastEventRows,
            ];
            if (!enrichmentRows.some(rows => rows.length > 0)) return;
            setGames(prev => dedupeFeedEntities(mergeFeedGames(prev, ...enrichmentRows)));
          } catch (enrichmentErr) {
            if (__DEV__) console.warn('[Feed] Event enrichment failed:', enrichmentErr);
          }
        })();

        void (async () => {
          try {
            const user = await userPromise;
            if (!isCurrentRequest()) return;

            const countryCode =
              typeof user?.preferences?.country_code === 'string'
                ? String(user.preferences.country_code).toUpperCase()
                : undefined;
            // LOCAL calendar date (not UTC). Ad reservations are stored as
            // calendar-day labels; sending the UTC date made a paid ad vanish
            // on the evening of its last booked day once UTC rolled over
            // (owner-reported "when I check it it's no longer there").
            const _now = new Date();
            const todayISO = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, '0')}-${String(_now.getDate()).padStart(2, '0')}`;
            const userZip =
              typeof user?.preferences?.zip_code === 'string'
                ? user.preferences.zip_code
                : undefined;

            let deviceLat: number | undefined;
            let deviceLng: number | undefined;
            if (userZip) {
              if (isCurrentRequest()) setHasDeviceLocation(true);
            } else {
              try {
                const { status } = await Location.getForegroundPermissionsAsync();
                if (status === 'granted') {
                  const loc =
                    (await Location.getLastKnownPositionAsync().catch(() => null)) ||
                    (await Location.getCurrentPositionAsync({}).catch(() => null));
                  if (loc) {
                    deviceLat = loc.coords.latitude;
                    deviceLng = loc.coords.longitude;
                  }
                }
              } catch (e) {
                if (__DEV__) console.warn('Feed: location for ads failed', e);
              }

              if (isCurrentRequest()) setHasDeviceLocation(!!deviceLat);
            }

            const emptyPage = {
              items: [],
              nextCursor: null,
              followed_feed_meta: undefined,
              followed_teams_feed_meta: undefined,
            };
            const bundleParams: FeedBundleParams = {
              country: countryCode,
              date: todayISO,
              zip: userZip,
              lat: deviceLat,
              lng: deviceLng,
              posts_limit: SOCIAL_POSTS_PAGE_SIZE,
              highlights_limit: 20,
              ads_limit: 2,
            };

            const bundle = user
              ? await Feed.bundle(bundleParams).catch(err => {
                  if (__DEV__) console.warn('[feed] Bundle load failed:', err);
                  return null;
                })
              : null;

            if (!isCurrentRequest()) return;
            feedBundleParamsRef.current = user ? bundleParams : null;
            const bundleErrors = Array.isArray((bundle as any)?.errors)
              ? ((bundle as any).errors as any[])
              : [];
            setSocialFeedWarning(
              user && !bundle
                ? 'Some feed sections could not load. Pull to refresh or try again.'
                : bundleErrors.length
                  ? 'Some feed sections could not load. Pull to refresh or try again.'
                  : null
            );

            const followedPage = bundle?.posts ?? emptyPage;
            const followedTeamsPage = bundle?.posts_followed_teams ?? emptyPage;
            const highlightsData = bundle?.highlights ?? null;
            // Guests (incl. logged-out web visitors) still see active local
            // ads — /ads/for-feed is public. The authenticated feed bundle
            // isn't loaded for guests, so fetch ads directly when we have a
            // location to target them with.
            let forFeedAds: any = bundle?.ads ?? null;
            if (!user && (userZip || (deviceLat != null && deviceLng != null))) {
              forFeedAds = await Advertisement.forFeed(
                todayISO,
                userZip,
                2,
                deviceLat,
                deviceLng
              ).catch(err => {
                if (__DEV__) console.warn('[feed] Guest ads load failed:', err);
                return null;
              });
            }

            setFollowedPosts(Array.isArray(followedPage?.items) ? followedPage.items : []);
            setFollowedPostsCursor(followedPage?.nextCursor ?? null);
            setFollowedFeedMeta(followedPage?.followed_feed_meta);
            setFollowedTeamsPosts(
              Array.isArray(followedTeamsPage?.items) ? followedTeamsPage.items : []
            );
            setFollowedTeamsPostsCursor(followedTeamsPage?.nextCursor ?? null);
            setFollowedTeamsFeedMeta(followedTeamsPage?.followed_teams_feed_meta);
            setUnreadNotifCount(
              typeof bundle?.unread_notifications === 'number' ? bundle.unread_notifications : 0
            );
            setUnreadMessagesCount(
              typeof bundle?.unread_messages === 'number' ? bundle.unread_messages : 0
            );

            if (highlightsData) {
              const merged: any[] = [];
              if (Array.isArray(highlightsData.nationalTop))
                merged.push(...highlightsData.nationalTop);
              if (Array.isArray(highlightsData.ranked)) merged.push(...highlightsData.ranked);
              const firstWithMedia = merged.find(
                item => typeof item?.media_url === 'string' && item.media_url
              );
              setHighlightPreview(firstWithMedia || null);
            } else {
              setHighlightPreview(null);
            }

            if (forFeedAds && Array.isArray((forFeedAds as any).ads)) {
              const list = ((forFeedAds as any).ads as any[]).filter(a => !!a);
              for (let i = list.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [list[i], list[j]] = [list[j], list[i]];
              }
              setSponsoredAds(list);
            } else {
              setSponsoredAds([]);
            }
          } catch (backgroundErr) {
            if (__DEV__) console.warn('[Feed] Background hydration failed:', backgroundErr);
          }
        })();
      } catch (e: any) {
        if (__DEV__) console.error('[Feed] Failed to load feed:', e);
        if (e?.isNetworkError || e?.status === 0) {
          setError('Unable to connect to server. Please check your internet connection.');
        } else if (e?.status === 401 || e?.status === 403) {
          setError('Unable to load feed right now.');
        } else {
          setError('Unable to load feed. Please try again.');
        }
        setGames([]);
        setHighlightPreview(null);
        setSponsoredAds([]);
        setFollowedPosts([]);
        setFollowedPostsCursor(null);
        setFollowedFeedMeta(undefined);
        setFollowedTeamsPosts([]);
        setFollowedTeamsPostsCursor(null);
        setFollowedTeamsFeedMeta(undefined);
        setSocialFeedWarning(null);
      } finally {
        if (!silent && isCurrentRequest()) setLoading(false);
        if (isCurrentRequest()) {
          loadInFlightRef.current = false;
          lastLoadTimestampRef.current = Date.now();
        }
      }
    },
    [checkAuth, user]
  );

  const _loadMore = useCallback(async () => {
    if (loadingMore || !hasMoreGames || !gamesCursor) return;

    setLoadingMore(true);
    try {
      // Continue the upcoming query the cursor belongs to (fall back to a
      // fresh plan if a hot reload cleared the ref).
      const plan = feedQueryPlanRef.current ?? buildFeedGameQueries(Date.now());
      const nextData = await Game.list(plan.upcoming.sort, {
        ...plan.upcoming.options,
        cursor: gamesCursor,
      });

      // Handle cursor-based response or legacy array
      let normalizedGames: any[] = [];
      let cursor: string | null = null;
      if (nextData && typeof nextData === 'object' && !Array.isArray(nextData)) {
        const list = nextData.games || nextData.items || [];
        normalizedGames = Array.isArray(list) ? list : [];
        cursor = nextData.nextCursor || null;
      } else {
        normalizedGames = Array.isArray(nextData) ? nextData : [];
      }

      setGames(prev => [...prev, ...normalizedGames]);
      setGamesCursor(cursor);
      setHasMoreGames(!!cursor);
    } catch (e: any) {
      if (__DEV__) console.error('Failed to load more games', e);
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMoreGames, gamesCursor]);

  const loadMoreSocialPosts = useCallback(
    async (section: 'people' | 'teams') => {
      const isPeople = section === 'people';
      const cursor = isPeople ? followedPostsCursor : followedTeamsPostsCursor;
      const isLoading = isPeople ? loadingMoreFollowedPosts : loadingMoreFollowedTeamsPosts;
      if (!me || !cursor || isLoading) return;

      if (isPeople) setLoadingMoreFollowedPosts(true);
      else setLoadingMoreFollowedTeamsPosts(true);

      try {
        const params: FeedBundleParams = {
          ...(feedBundleParamsRef.current ?? {}),
          posts_limit: SOCIAL_POSTS_PAGE_SIZE,
          highlights_limit: 1,
          ads_limit: 1,
          ...(isPeople ? { posts_cursor: cursor } : { posts_followed_teams_cursor: cursor }),
        };
        const bundle = await Feed.bundle(params);
        const bundleErrors = Array.isArray((bundle as any)?.errors)
          ? ((bundle as any).errors as any[])
          : [];
        setSocialFeedWarning(
          bundleErrors.length
            ? 'Some feed sections could not load. Pull to refresh or try again.'
            : null
        );

        if (isPeople) {
          const page = bundle?.posts;
          const nextItems = Array.isArray(page?.items) ? page.items : [];
          setFollowedPosts(prev => {
            const seen = new Set(prev.map((post: any) => String(post.id)));
            return [...prev, ...nextItems.filter((post: any) => !seen.has(String(post.id)))];
          });
          setFollowedPostsCursor(page?.nextCursor ?? null);
          if (page?.followed_feed_meta) setFollowedFeedMeta(page.followed_feed_meta);
        } else {
          const page = bundle?.posts_followed_teams;
          const nextItems = Array.isArray(page?.items) ? page.items : [];
          setFollowedTeamsPosts(prev => {
            const seen = new Set(prev.map((post: any) => String(post.id)));
            return [...prev, ...nextItems.filter((post: any) => !seen.has(String(post.id)))];
          });
          setFollowedTeamsPostsCursor(page?.nextCursor ?? null);
          if (page?.followed_teams_feed_meta)
            setFollowedTeamsFeedMeta(page.followed_teams_feed_meta);
        }
      } catch (err) {
        if (__DEV__) console.warn('[feed] Failed to load more social posts:', err);
        setSocialFeedWarning('Unable to load more posts right now.');
      } finally {
        if (isPeople) setLoadingMoreFollowedPosts(false);
        else setLoadingMoreFollowedTeamsPosts(false);
      }
    },
    [
      me,
      followedPostsCursor,
      followedTeamsPostsCursor,
      loadingMoreFollowedPosts,
      loadingMoreFollowedTeamsPosts,
    ]
  );

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  useEffect(() => {
    if (!games.length) return;
    // Defer the vote/RSVP badge preloads until after the navigation transition
    // and first paint settle. These are non-critical badge counts (poll totals,
    // RSVP state), so running them off the critical path stops them from
    // contending with the /feed/bundle content fetch for bandwidth on entry —
    // the "too many calls at once" the user reported. Same deferral pattern as
    // GameDetailsScreen/profile.
    const handle = InteractionManager.runAfterInteractions(() => {
      void preloadVoteSummaries(games.slice(0, 12));
      void preloadRsvpSummaries(games);
      void preloadPostsActivity(games);
    });
    return () => handle.cancel();
  }, [games, preloadVoteSummaries, preloadRsvpSummaries, preloadPostsActivity]);

  // A live game can get its first post at any moment, and that's exactly what
  // should promote it. The polling owner is the focused, foreground feed only:
  // blur/background invalidates late responses and stops the timer. The first
  // focus relies on the deferred badge preload above, so it does not duplicate
  // the entry-time request; later focus/foreground returns refresh once.
  useFocusEffect(
    useCallback(() => {
      let interval: ReturnType<typeof setInterval> | null = null;
      postsActivityFocusedRef.current = true;
      postsActivityAppStateRef.current = AppState.currentState ?? 'inactive';
      postsActivityOwnershipRef.current += 1;

      const stopPolling = () => {
        if (interval !== null) {
          clearInterval(interval);
          interval = null;
        }
      };
      const startPolling = () => {
        if (interval !== null || postsActivityAppStateRef.current !== 'active') return;
        interval = setInterval(() => refreshPostsActivity(false), 30000);
      };

      const isReturnFocus = hasFocusedActivityOnceRef.current;
      hasFocusedActivityOnceRef.current = true;
      if (postsActivityAppStateRef.current === 'active') {
        if (isReturnFocus) refreshPostsActivity(true);
        startPolling();
      }

      const subscription = AppState.addEventListener('change', nextState => {
        const wasActive = postsActivityAppStateRef.current === 'active';
        postsActivityAppStateRef.current = nextState;
        if (nextState === 'active') {
          if (!wasActive) {
            postsActivityOwnershipRef.current += 1;
            refreshPostsActivity(true);
          }
          startPolling();
        } else {
          stopPolling();
          postsActivityOwnershipRef.current += 1;
        }
      });

      return () => {
        postsActivityFocusedRef.current = false;
        postsActivityReturnRefreshPendingRef.current = false;
        postsActivityOwnershipRef.current += 1;
        stopPolling();
        subscription.remove();
      };
    }, [refreshPostsActivity])
  );

  // Refresh feed data + unread counts on focus, then poll every 60s while visible.
  // Single hook replaces two separate useFocusEffects that both fetched unread counts.
  useFocusEffect(
    useCallback(() => {
      let mounted = true;
      if (hasFocusedOnceRef.current) {
        void load({ silent: true });
      } else {
        hasFocusedOnceRef.current = true;
      }

      const tick = async () => {
        try {
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Notification poll timeout')), 10000)
          );
          const [notifCountRes, unreadRes] = await Promise.all([
            Promise.race([
              NotificationApi.unreadCount().catch(() => 0),
              timeoutPromise,
            ]) as Promise<any>,
            Message.unreadCount().catch(() => ({ count: 0 })),
          ]);
          if (!mounted) return;
          const nc =
            typeof notifCountRes === 'number' ? notifCountRes : (notifCountRes?.count ?? 0);
          setUnreadNotifCount(nc);
          setUnreadMessagesCount(typeof unreadRes?.count === 'number' ? unreadRes.count : 0);
        } catch (err: any) {
          if (__DEV__ && err?.message !== 'Notification poll timeout') {
            if (__DEV__) console.warn('[Feed] Notification poll error:', err?.message);
          }
        }
      };

      // `load()` above now refreshes unread counts via /feed/bundle on focus.
      // Keep the interval as a lightweight fallback while the screen stays visible.
      const id = setInterval(tick, 120000);
      return () => {
        mounted = false;
        clearInterval(id);
      };
    }, [load])
  );

  // Load notifications when modal opens
  useEffect(() => {
    if (!notificationsMenuOpen) return;

    // Opening the panel means the user has seen their notifications. Clear the
    // badge immediately (owner ask 2026-08-06 — the count lingered even after
    // viewing) and persist the read state server-side so the next feed-bundle
    // refresh returns 0 instead of re-showing the old count. Best-effort: if the
    // server call fails, the 60s bundle poll reconciles.
    setUnreadNotifCount(0);
    void NotificationApi.markAllRead().catch(() => {});

    let mounted = true;
    const loadModalData = async () => {
      setLoadingNotifications(true);
      setNotificationsError(false);
      try {
        // Guard against the http layer's intentional never-resolving promise on
        // session-expiry (api/http.ts): without this the spinner would hang
        // forever. The race guarantees the loader always settles.
        const page = await Promise.race([
          NotificationApi.listPage(null, 20, false),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('notifications_timeout')), 20000)
          ),
        ]);
        if (!mounted) return;
        setNotificationsList(Array.isArray(page.items) ? page.items : []);
      } catch (e) {
        if (__DEV__) console.error('[FeedScreen] Failed to load notifications', e);
        if (mounted) setNotificationsError(true);
      } finally {
        if (mounted) setLoadingNotifications(false);
      }
    };

    void loadModalData();
    return () => {
      mounted = false;
    };
  }, [notificationsMenuOpen, notificationsReloadKey]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      // force: an explicit pull-to-refresh must always hit the server, even
      // inside the 30s silent-reload cooldown window.
      await load({ silent: true, force: true });
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  // Stable handler so memoized FeedGameCard props don't change every render.
  const handleGamePress = useCallback(
    (item: GameItem) => {
      if (item.source_type === 'event') {
        const eventId = item.event_id || item.id;
        if (!eventId) return;
        void router.push(buildEventDetailRoute(eventId));
        return;
      }
      void router.push({ pathname: '/game/[id]', params: { id: item.id } });
    },
    [router]
  );

  const filtered = useMemo(() => {
    const sportFiltered = selectedFeedSport
      ? games.filter(game => getFeedItemSport(game) === selectedFeedSport)
      : games;
    if (!query) return sportFiltered;
    const q = query.toLowerCase().trim();
    const zip = q.match(/\b\d{5}\b/);
    if (zip) {
      return sportFiltered.filter(g => (g.location || '').toLowerCase().includes(zip[0]));
    }
    return sportFiltered.filter(
      g => (g.title || '').toLowerCase().includes(q) || (g.location || '').toLowerCase().includes(q)
    );
  }, [games, query, selectedFeedSport]);

  const feedSports = useMemo(() => {
    const seen = new Set<string>();
    for (const game of games) {
      const sport = getFeedItemSport(game);
      if (sport) seen.add(sport);
    }
    return Array.from(seen);
  }, [games]);

  // Separate upcoming/live and past events
  // Events within the 2-hour live window stay in "upcoming" so they appear prominently
  const { pinnedEvents, spotlightProEvents, upcomingEvents, pastEvents } = useMemo(() => {
    const now = Date.now();

    const upcoming: GameItem[] = [];
    const past: GameItem[] = [];

    filtered.forEach(game => {
      // A game stays "upcoming" until its live window actually closes, which is
      // a server rule shipped on the payload (starts_at/live_from/live_until).
      // The old check compared the game's own date against a fixed 2h window,
      // so an all-day event dropped into `past` two hours in — vanishing from
      // the feed while fans were still posting.
      // Defensive: an unparseable date yields null bounds; bucket those into
      // upcoming, where dateless games already go, rather than silently past.
      const bounds = getLiveBounds(game);
      if (!bounds) {
        upcoming.push(game);
        return;
      }
      if (isGameOver(game, now)) past.push(game);
      else upcoming.push(game);
    });

    // Sort: currently-live events first, then future events by ascending start time
    upcoming.sort((a, b) => {
      const aB = getLiveBounds(a);
      const bB = getLiveBounds(b);
      if (!aB) return 1;
      if (!bB) return -1;
      const aLive = isGameLive(a, now);
      const bLive = isGameLive(b, now);
      if (aLive && !bLive) return -1;
      if (!aLive && bLive) return 1;
      // Owner ask: a live event that gets a post moves to the top of the live
      // group, so fans see where the action already is.
      if (aLive && bLive) {
        const aPosted = Boolean(postsActivity[String(a.id)]);
        const bPosted = Boolean(postsActivity[String(b.id)]);
        if (aPosted && !bPosted) return -1;
        if (!aPosted && bPosted) return 1;
      }
      return aB.startsAt - bB.startsAt;
    });

    // Past Events: most recent first going down
    past.sort((a, b) => {
      if (!a.date) return 1;
      if (!b.date) return -1;
      return new Date(b.date).getTime() - new Date(a.date).getTime();
    });

    // Owner rule (2026-07-16): "If an event is live and the user is at the
    // location it should basically be pinned on the feed page." Lift those out
    // of the normal upcoming flow so they render first, above the ad slot —
    // a fan standing at the venue should never have to scroll to find the
    // event they are currently attending.
    const pinned: GameItem[] = [];
    const unpinned: GameItem[] = [];
    upcoming.forEach(game => {
      if (shouldPinToFeed(game, viewerPosition, now)) pinned.push(game);
      else unpinned.push(game);
    });

    return {
      pinnedEvents: pinned,
      spotlightProEvents: [],
      upcomingEvents: unpinned,
      pastEvents: past,
    };
  }, [filtered, viewerPosition, postsActivity]);

  // Ad rotation timer logic (max 2 advertisers):
  // 1 ad: Show ad for 5 minutes, then placeholder for 15 seconds, repeat
  // 2 ads: Alternate at 2.5 minutes each, no placeholder, repeat
  useEffect(() => {
    const activeAdsCount = Math.min(sponsoredAds?.length || 0, 2);

    if (activeAdsCount === 0) {
      // No ads, always show promo card
      setIsShowingPromoCard(true);
      return;
    }

    // Reset cycle start time when ads change
    adCycleStartTimeRef.current = Date.now();
    setCurrentAdIndex(0);
    setIsShowingPromoCard(false);

    const TOTAL_AD_TIME_MS = 5 * 60 * 1000; // 5 minutes total for ads
    const AD_DURATION_MS = activeAdsCount === 1 ? TOTAL_AD_TIME_MS : 2.5 * 60 * 1000; // 5 min or 2.5 min each
    const PROMO_DURATION_MS = activeAdsCount === 1 ? 15 * 1000 : 0; // 15s placeholder only for single ad
    const CYCLE_DURATION_MS = TOTAL_AD_TIME_MS + PROMO_DURATION_MS;

    // Update every 30 seconds (ads rotate every 2.5-5 min, no need for 1s polling).
    // Local mountedFlag closed over by the tick callback: clearInterval (below) is
    // the primary stop, but if the effect re-runs (sponsoredAds.length changed)
    // and the OLD tick is mid-flight or queued, the flag prevents stale state
    // updates from leaking into the new effect's render cycle.
    let isCancelled = false;
    const interval = setInterval(() => {
      if (isCancelled) return;
      const now = Date.now();
      const elapsed = now - adCycleStartTimeRef.current;
      const cyclePosition = elapsed % CYCLE_DURATION_MS;

      // Check if we're in promo card phase (only applies when 1 ad)
      if (PROMO_DURATION_MS > 0 && cyclePosition >= TOTAL_AD_TIME_MS) {
        setIsShowingPromoCard(true);
      } else {
        // Show ad - calculate which ad to show
        setIsShowingPromoCard(false);
        const adSlot = Math.floor(cyclePosition / AD_DURATION_MS);
        const newIndex = Math.min(adSlot % activeAdsCount, activeAdsCount - 1);
        setCurrentAdIndex(prev => (prev !== newIndex ? newIndex : prev));
      }
    }, 30000);

    return () => {
      isCancelled = true;
      clearInterval(interval);
    };
  }, [sponsoredAds?.length]);

  // Insert sponsored ads into upcoming events feed (Instagram-style)
  // First event always shows the current ad (or promo card) based on rotation timer
  const upcomingWithAds = useMemo(() => {
    const result: Array<GameItem | { type: 'ad'; ad: any | null }> = [];
    const activeAdsCount = sponsoredAds?.length || 0;

    // If no events exist, show ad/promo card alone
    if (upcomingEvents.length === 0) {
      if (isShowingPromoCard || activeAdsCount === 0) {
        result.push({ type: 'ad', ad: null }); // Promo card
      } else if (activeAdsCount > 0 && sponsoredAds[currentAdIndex]) {
        result.push({ type: 'ad', ad: sponsoredAds[currentAdIndex] });
      }
      return result;
    }

    // Normally insert after the third event (index 2), but if there are fewer
    // upcoming events, clamp to the last one so the ad/promo card still
    // appears instead of silently disappearing.
    const adInsertIndex = Math.min(2, upcomingEvents.length - 1);

    upcomingEvents.forEach((event, index) => {
      result.push(event);

      // Insert ad/promo card after the chosen anchor event.
      if (index === adInsertIndex) {
        if (isShowingPromoCard || activeAdsCount === 0) {
          // Show promo card during promo phase or if no ads
          result.push({ type: 'ad', ad: null });
        } else if (activeAdsCount > 0 && sponsoredAds[currentAdIndex]) {
          // Show current ad from rotation
          result.push({ type: 'ad', ad: sponsoredAds[currentAdIndex] });
        }
      }
    });

    return result;
  }, [upcomingEvents, sponsoredAds, currentAdIndex, isShowingPromoCard]);

  // Build flat feed items array for FlatList
  const feedItems = useMemo(() => {
    const items: FeedItem[] = [];

    // An event the viewer is physically at, right now, outranks everything —
    // including the verify-email nudge. This is the "you're here, post to it"
    // surface (owner rule, 2026-07-16).
    pinnedEvents.forEach((game, idx) => {
      items.push({ _t: 'pinned_game', data: game, idx });
    });

    spotlightProEvents.forEach((game, idx) => {
      items.push({ _t: 'game', data: game, idx });
    });

    // Add email reminder if needed
    if (me && !emailVerified) {
      items.push({ _t: 'email_reminder' });
    }

    // Add location prompt if needed
    if (me && !locationPromptDismissed && !hasDeviceLocation && sponsoredAds.length === 0) {
      items.push({ _t: 'location_prompt' });
    }

    // Add seed banner if showing
    if (showSeedBanner) {
      items.push({ _t: 'seed_banner' });
    }

    // Add upcoming games and ads. Every game renders as a full-width hero
    // card, one per row — never a 2-up grid (product decision 2026-07-14:
    // "Feed page should always look like this", single-column hero layout).
    if (upcomingWithAds.length > 0) {
      upcomingWithAds.forEach((item, idx) => {
        if ('type' in item && item.type === 'ad') {
          items.push({ _t: 'ad', ad: item.ad, idx });
        } else {
          items.push({ _t: 'game', data: item as GameItem, idx });
        }
      });
    }

    // Add followed posts section
    if (me) {
      items.push({
        _t: 'section_header',
        title: 'From people you follow',
        key: 'followed_posts_header',
      });
      if (followedPosts.length > 0) {
        followedPosts.forEach((post: any, idx: number) => {
          items.push({ _t: 'followed_post', data: post, idx });
        });
        if (followedPostsCursor) {
          items.push({ _t: 'followed_load_more', section: 'people' });
        }
      } else {
        items.push({ _t: 'followed_empty', section: 'people' });
      }
    }

    // Add followed teams posts section
    if (me) {
      items.push({
        _t: 'section_header',
        title: 'From teams you follow',
        key: 'followed_teams_header',
      });
      if (followedTeamsPosts.length > 0) {
        followedTeamsPosts.forEach((post: any, idx: number) => {
          items.push({ _t: 'followed_teams_post', data: post, idx });
        });
        if (followedTeamsPostsCursor) {
          items.push({ _t: 'followed_load_more', section: 'teams' });
        }
      } else {
        items.push({ _t: 'followed_empty', section: 'teams' });
      }
    }

    // Add past events section
    if (pastEvents.length > 0) {
      items.push({ _t: 'section_header', title: 'Past Events', key: 'past_events_header' });
      pastEvents.forEach((game: GameItem, idx: number) => {
        items.push({ _t: 'past_game', data: game, idx });
      });
    }

    // Add footer
    items.push({ _t: 'footer' });

    return items;
  }, [
    me,
    emailVerified,
    locationPromptDismissed,
    hasDeviceLocation,
    sponsoredAds.length,
    showSeedBanner,
    pinnedEvents,
    spotlightProEvents,
    upcomingWithAds,
    followedPosts,
    followedPostsCursor,
    followedTeamsPosts,
    followedTeamsPostsCursor,
    pastEvents,
  ]);

  const verticalFeedTitle = 'All Highlights';
  const verticalFeedPreviewImage =
    typeof highlightPreview?.media_url === 'string' ? highlightPreview.media_url : null;
  const verticalFeedSubtitleText = highlightPreview?.title
    ? `Featured: ${highlightPreview.title}`
    : 'Tap to watch top plays from every game.';
  const verticalFeedAuthorText = highlightPreview?.author?.username
    ? `By @${highlightPreview.author.username}`
    : null;

  const openInstagram = useCallback(async () => {
    const instagramUrl = 'https://instagram.com/varsityhub_';
    try {
      const canOpen = await Linking.canOpenURL(instagramUrl);
      if (canOpen) {
        await Linking.openURL(instagramUrl);
      } else {
        Alert.alert('Error', 'Unable to open Instagram. Please try again.');
      }
    } catch (error) {
      if (__DEV__) console.error('Error opening Instagram:', error);
      Alert.alert('Error', 'Failed to open Instagram link.');
    }
  }, []);

  const userCountryCode =
    typeof me?.preferences?.country_code === 'string'
      ? String(me.preferences.country_code).toUpperCase()
      : undefined;

  const openVerticalFeed = useCallback(() => {
    setActiveVerticalFeedGameId(null);
    setVerticalFeedModalVisible(true);
  }, []);

  const closeVerticalFeed = useCallback(() => {
    setVerticalFeedModalVisible(false);
    setActiveVerticalFeedGameId(null);
  }, []);

  const renderEmailReminder = useCallback(() => {
    if (!me || emailVerified) return null;
    return (
      <Pressable
        testID="feed-verify-email-button"
        onPress={() => void router.push('/verify')}
        style={{
          padding: 10,
          borderRadius: 10,
          backgroundColor: colorScheme === 'dark' ? Colors[colorScheme].surface : '#FEF9C3',
          borderWidth: 1,
          borderColor: colorScheme === 'dark' ? Colors[colorScheme].border : '#FDE68A',
          marginBottom: 12,
        }}
        accessibilityRole="button"
        accessibilityLabel="Verify your email to unlock posting and ads"
      >
        <Text
          style={{
            color: colorScheme === 'dark' ? Colors[colorScheme].text : '#92400E',
            fontWeight: '700',
          }}
        >
          Verify your email to unlock posting and ads. Tap to verify.
        </Text>
      </Pressable>
    );
  }, [emailVerified, me, router, colorScheme]);

  const renderLocationPrompt = useCallback(() => {
    if (!me || locationPromptDismissed || hasDeviceLocation || sponsoredAds.length > 0) return null;
    return (
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          padding: 12,
          borderRadius: 10,
          backgroundColor: colorScheme === 'dark' ? '#1E1E1E' : '#EFF6FF',
          borderWidth: 1,
          borderColor: colorScheme === 'dark' ? '#3A3A3C' : '#BFDBFE',
          marginBottom: 12,
        }}
      >
        <MaterialIcons
          name="location-off"
          size={20}
          color={colorScheme === 'dark' ? '#93C5FD' : '#3B82F6'}
          style={{ marginRight: 8 }}
        />
        <View style={{ flex: 1 }}>
          <Text
            style={{
              color: colorScheme === 'dark' ? '#E2E8F0' : '#1E3A5F',
              fontSize: 13,
              lineHeight: 18,
            }}
          >
            Enable location or add your zip code in Settings to see local content and ads.
          </Text>
          <Pressable
            testID="feed-zip-code-settings-button"
            onPress={() => void router.push('/settings/zip-code')}
            style={{
              alignSelf: 'flex-start',
              marginTop: 8,
              paddingVertical: 6,
              paddingHorizontal: 14,
              borderRadius: 6,
              backgroundColor: colorScheme === 'dark' ? '#3B82F6' : '#2563EB',
            }}
            accessibilityRole="button"
            accessibilityLabel="Go to Settings to add your zip code"
          >
            <Text style={{ color: '#FFFFFF', fontWeight: '600', fontSize: 13 }}>
              Go to Settings
            </Text>
          </Pressable>
        </View>
        <Pressable
          testID="feed-dismiss-location-button"
          onPress={() => setLocationPromptDismissed(true)}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Dismiss location prompt"
          style={{ padding: 4 }}
        >
          <MaterialIcons
            name="close"
            size={18}
            color={colorScheme === 'dark' ? '#94A3B8' : '#64748B'}
          />
        </Pressable>
      </View>
    );
  }, [me, locationPromptDismissed, hasDeviceLocation, sponsoredAds.length, colorScheme, router]);

  const keyExtractor = useCallback((item: FeedItem) => {
    switch (item._t) {
      case 'email_reminder':
        return 'email_reminder';
      case 'location_prompt':
        return 'location_prompt';
      case 'seed_banner':
        return 'seed_banner';
      case 'game':
        return `game-${item.data.id}`;
      case 'pinned_game':
        return `pinned_game-${item.data.id}`;
      case 'ad':
        return `ad-${item.idx}`;
      case 'section_header':
        return `section-${item.key}`;
      case 'followed_post':
        return `followed_post-${item.data.id}`;
      case 'followed_empty':
        return `followed_empty-${item.section}`;
      case 'followed_teams_post':
        return `followed_teams_post-${item.data.id}`;
      case 'past_game':
        return `past_game-${item.data.id}`;
      case 'footer':
        return 'footer';
      default:
        return 'unknown';
    }
  }, []);

  // Helper function to render a game/past game card (shared between upcoming and past games)
  const renderGameCard = useCallback(
    (gameItem: GameItem, isLive: boolean, testIDPrefix: string) => {
      if (!gameItem.id) return null;
      return (
        <FeedGameCard
          gameItem={gameItem}
          isLive={isLive}
          hasPosts={(postsActivity[String(gameItem.id)] || 0) > 0}
          testIDPrefix={testIDPrefix}
          voteSummary={voteSummaries[String(gameItem.id)] || null}
          rsvp={rsvpSummaries[String((gameItem as any).event_id || '')]}
          colorScheme={colorScheme}
          onPress={handleGamePress}
          onRSVPChange={onRefresh}
        />
      );
    },
    [colorScheme, voteSummaries, rsvpSummaries, postsActivity, handleGamePress, onRefresh]
  );

  const renderFeedItem = useCallback(
    ({ item }: { item: FeedItem }) => {
      switch (item._t) {
        case 'email_reminder':
          return renderEmailReminder();

        case 'location_prompt':
          return renderLocationPrompt();

        case 'seed_banner':
          return (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                backgroundColor: colorScheme === 'dark' ? '#1e3a5f' : '#EFF6FF',
                borderWidth: 1,
                borderColor: colorScheme === 'dark' ? '#3B82F6' : '#BFDBFE',
                borderRadius: 8,
                padding: 10,
                marginHorizontal: 16,
                marginBottom: 12,
                gap: 8,
              }}
            >
              <MaterialIcons
                name="info-outline"
                size={18}
                color={colorScheme === 'dark' ? '#93C5FD' : '#2563EB'}
              />
              <Text
                style={{
                  flex: 1,
                  fontSize: 12,
                  color: colorScheme === 'dark' ? '#BFDBFE' : '#1E40AF',
                  lineHeight: 17,
                }}
              >
                These are example games to help you explore VarsityHub. Real games will appear once
                coaches in your area sign up.
              </Text>
              <Pressable
                testID="feed-dismiss-seed-banner"
                onPress={() => setShowSeedBanner(false)}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="Dismiss sample content notice"
              >
                <MaterialIcons
                  name="close"
                  size={16}
                  color={colorScheme === 'dark' ? '#93C5FD' : '#2563EB'}
                />
              </Pressable>
            </View>
          );

        case 'game': {
          return (
            <View style={{ paddingHorizontal: 16, marginBottom: 20 }}>
              {renderGameCard(item.data, isGameLive(item.data), 'feed')}
            </View>
          );
        }

        case 'pinned_game': {
          // Always live by construction (shouldPinToFeed gates on it), so the
          // card renders with the LIVE treatment and carries a header telling
          // the viewer why it is at the top.
          return (
            <View style={{ paddingHorizontal: 16, marginBottom: 20 }}>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  marginBottom: 8,
                }}
              >
                <MaterialIcons
                  name="location-on"
                  size={16}
                  color={Colors[colorScheme].tint}
                  accessibilityElementsHidden
                />
                <Text
                  style={{
                    color: Colors[colorScheme].tint,
                    fontSize: 13,
                    fontWeight: '700',
                    letterSpacing: 0.3,
                  }}
                >
                  You&apos;re here — post to this event
                </Text>
              </View>
              {renderGameCard(item.data, true, 'feed-pinned')}
            </View>
          );
        }

        case 'ad': {
          const adData = item.ad;
          if (!adData) {
            // Promo card
            return (
              <View
                style={[
                  styles.sponsoredFeedCard,
                  {
                    backgroundColor: Colors[colorScheme].card,
                    borderColor: Colors[colorScheme].border,
                  },
                ]}
              >
                <Text style={[styles.sponsoredLabel, { color: Colors[colorScheme].mutedText }]}>
                  AD SPACE AVAILABLE
                </Text>
                <Pressable
                  style={[
                    styles.promoPlaceholder,
                    {
                      backgroundColor: colorScheme === 'dark' ? '#111827' : '#F5F9FF',
                      borderColor: colorScheme === 'dark' ? '#1F2937' : '#C7DBFF',
                    },
                  ]}
                  onPress={() => void router.push('/submit-ad')}
                  accessibilityRole="button"
                  accessibilityLabel="Reserve your ad space"
                >
                  <View
                    style={[
                      styles.promoIcon,
                      {
                        borderColor: colorScheme === 'dark' ? '#60A5FA' : '#2563EB',
                        justifyContent: 'center',
                        alignItems: 'center',
                      },
                    ]}
                  >
                    <MaterialIcons
                      name="campaign"
                      size={24}
                      color={colorScheme === 'dark' ? '#60A5FA' : '#2563EB'}
                    />
                  </View>
                  <View style={{ flex: 1, paddingRight: 12 }}>
                    <Text
                      style={[
                        styles.promoTitle,
                        { color: colorScheme === 'dark' ? '#BFDBFE' : '#1E3A8A' },
                      ]}
                    >
                      Reserve Your Ad Space Now
                    </Text>
                    <Text
                      style={[
                        styles.promoSubtitle,
                        { color: colorScheme === 'dark' ? '#94A3B8' : '#64748B' },
                      ]}
                    >
                      Promote your program, fundraiser, or business to local fans.
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.promoteCtaBanner,
                      { backgroundColor: colorScheme === 'dark' ? '#2563EB' : '#2563EB' },
                    ]}
                  >
                    <View
                      style={[
                        styles.promoteCtaIcon,
                        {
                          borderColor: '#FFFFFF',
                          justifyContent: 'center',
                          alignItems: 'center',
                        },
                      ]}
                    >
                      <MaterialIcons name="arrow-forward" size={12} color="#FFFFFF" />
                    </View>
                    <Text style={styles.promoteCtaText}>Click Here</Text>
                  </View>
                </Pressable>
              </View>
            );
          }
          // Actual ad
          return (
            <View
              style={[
                styles.sponsoredFeedCard,
                {
                  backgroundColor: Colors[colorScheme].card,
                  borderColor: Colors[colorScheme].border,
                },
              ]}
            >
              <View style={styles.sponsoredHeader}>
                <Text style={[styles.sponsoredLabel, { color: Colors[colorScheme].mutedText }]}>
                  SPONSORED
                </Text>
                {!!adData?.id && (
                  <Pressable
                    style={[
                      styles.adReportButton,
                      {
                        borderColor: Colors[colorScheme].border,
                        backgroundColor: Colors[colorScheme].background,
                      },
                    ]}
                    onPress={() => showAdReportOptions(adData)}
                    accessibilityRole="button"
                    accessibilityLabel="Report sponsored ad"
                  >
                    <Ionicons name="flag-outline" size={14} color={Colors[colorScheme].mutedText} />
                    <Text
                      style={[styles.adReportButtonText, { color: Colors[colorScheme].mutedText }]}
                    >
                      Report
                    </Text>
                  </Pressable>
                )}
              </View>
              {adData.banner_url ? (
                <BannerAd
                  adId={adData.id}
                  bannerUrl={adData.banner_url}
                  fitMode={adData.banner_fit_mode || 'contain'}
                  targetUrl={adData.target_url}
                  ctaText={adData.cta_text}
                  businessName={adData.business_name}
                  description={adData.description}
                  // Pre-load placeholder ratio only — a 'contain' ad snaps to
                  // its image's true ratio on load (no letterbox bars). A wide
                  // 3.5:1 box here just wasted vertical space around the image.
                  aspectRatio={16 / 9}
                />
              ) : (
                <View
                  style={[
                    styles.adPlaceholder,
                    { backgroundColor: colorScheme === 'dark' ? '#1E1E1E' : '#F3F4F6' },
                  ]}
                >
                  <MaterialIcons
                    name="campaign"
                    size={48}
                    color={colorScheme === 'dark' ? '#64748B' : '#9CA3AF'}
                  />
                </View>
              )}
            </View>
          );
        }

        case 'section_header':
          return (
            <Text style={[styles.sectionHeader, { color: Colors[colorScheme].mutedText }]}>
              {item.title}
            </Text>
          );

        case 'followed_post': {
          const post = item.data;
          return (
            <View style={{ paddingHorizontal: 16, marginBottom: 12 }}>
              <PostCard
                post={post}
                showAuthorHeader
                onPress={() =>
                  void router.push(
                    `/post-detail?id=${encodeURIComponent(String(post.id))}&postIds=${followedPosts.map((p: any) => String(p.id)).join(',')}&index=${item.idx}`
                  )
                }
                onDeleted={postId =>
                  setFollowedPosts(prev => prev.filter(p => String(p.id) !== postId))
                }
                onUpdated={updated =>
                  setFollowedPosts(prev =>
                    prev.map(p => (String(p.id) === String(updated.id) ? { ...p, ...updated } : p))
                  )
                }
              />
            </View>
          );
        }

        case 'followed_empty': {
          const isPeople = item.section === 'people';
          return (
            <View
              style={[
                styles.socialFeedEmpty,
                {
                  backgroundColor: Colors[colorScheme].card,
                  borderColor: Colors[colorScheme].border,
                },
              ]}
            >
              {isPeople ? (
                <MaterialIcons name="group" size={48} color={Colors[colorScheme].mutedText} />
              ) : (
                <Ionicons
                  name="american-football-outline"
                  size={48}
                  color={Colors[colorScheme].mutedText}
                />
              )}
              <Text style={[styles.socialFeedEmptyTitle, { color: Colors[colorScheme].text }]}>
                {isPeople
                  ? followedFeedMeta?.following_count === 0
                    ? 'Follow users or teams to see their posts here'
                    : 'No posts from people you follow yet'
                  : followedTeamsFeedMeta?.followed_teams_count === 0
                    ? 'Follow teams to see their posts here'
                    : 'No posts from teams you follow yet'}
              </Text>
              <Text
                style={[styles.socialFeedEmptySubtitle, { color: Colors[colorScheme].mutedText }]}
              >
                {isPeople
                  ? followedFeedMeta?.following_count === 0
                    ? 'Discover and follow athletes, coaches, and teams to build your feed.'
                    : 'Check back soon — when they post, it will show up here.'
                  : followedTeamsFeedMeta?.followed_teams_count === 0
                    ? 'Discover and follow teams to see their updates and game content.'
                    : 'Check back soon — when they post, it will show up here.'}
              </Text>
              <Pressable
                testID={isPeople ? 'feed-discover-users-button' : 'feed-discover-teams-button'}
                style={[
                  styles.socialFeedEmptyButton,
                  { backgroundColor: Colors[colorScheme].tint },
                ]}
                onPress={() => void router.push('/(tabs)/discover')}
                accessibilityLabel={
                  isPeople
                    ? followedFeedMeta?.following_count === 0
                      ? 'Find people to follow'
                      : 'Discover more'
                    : followedTeamsFeedMeta?.followed_teams_count === 0
                      ? 'Find teams to follow'
                      : 'Discover more'
                }
                accessibilityRole="button"
              >
                <Text style={styles.socialFeedEmptyButtonText}>
                  {isPeople
                    ? followedFeedMeta?.following_count === 0
                      ? 'Find people to follow'
                      : 'Discover more'
                    : followedTeamsFeedMeta?.followed_teams_count === 0
                      ? 'Find teams to follow'
                      : 'Discover more'}
                </Text>
              </Pressable>
            </View>
          );
        }

        case 'followed_load_more': {
          const isPeople = item.section === 'people';
          const isLoading = isPeople ? loadingMoreFollowedPosts : loadingMoreFollowedTeamsPosts;
          return (
            <View style={styles.socialLoadMoreWrap}>
              <Pressable
                testID={isPeople ? 'feed-load-more-followed-posts' : 'feed-load-more-team-posts'}
                onPress={() => void loadMoreSocialPosts(item.section)}
                disabled={isLoading}
                style={[
                  styles.socialLoadMoreButton,
                  {
                    borderColor: Colors[colorScheme].border,
                    backgroundColor: Colors[colorScheme].card,
                    opacity: isLoading ? 0.65 : 1,
                  },
                ]}
                accessibilityRole="button"
                accessibilityLabel={
                  isPeople ? 'Load more posts from people you follow' : 'Load more team posts'
                }
              >
                {isLoading ? (
                  <ActivityIndicator size="small" color={Colors[colorScheme].tint} />
                ) : (
                  <>
                    <MaterialIcons name="expand-more" size={20} color={Colors[colorScheme].tint} />
                    <Text style={[styles.socialLoadMoreText, { color: Colors[colorScheme].tint }]}>
                      Load more
                    </Text>
                  </>
                )}
              </Pressable>
            </View>
          );
        }

        case 'followed_teams_post': {
          const post = item.data;
          const team = post.team || {};
          const teamName = team.name || 'Team';
          const teamLogo = team.logo_url || null;
          const mediaUrl = post.media_url || post.mediaUrl || null;
          const caption = post.caption || post.content || '';
          const gradient: [string, string] =
            item.idx % 2 === 0 ? ['#1E1E1E', '#121212'] : ['#121212', '#1E1E1E'];
          return (
            <View style={{ paddingHorizontal: 16, marginBottom: 20 }}>
              <Pressable
                testID={`feed-team-post-card-${post.id}`}
                style={styles.singleEventCard}
                onPress={() =>
                  void router.push(
                    `/post-detail?id=${encodeURIComponent(String(post.id))}&postIds=${followedTeamsPosts.map((p: any) => String(p.id)).join(',')}&index=${item.idx}`
                  )
                }
                accessibilityRole="button"
                accessibilityLabel={`View post from ${teamName}`}
              >
                <LinearGradient
                  colors={gradient}
                  style={StyleSheet.absoluteFillObject}
                  start={{ x: 0, y: 0 }}
                  end={{ x: 1, y: 1 }}
                />
                {mediaUrl && (
                  <FullBleedCardImage uri={optimizeImageUrl(mediaUrl, 400) || mediaUrl} />
                )}
                <LinearGradient
                  colors={['rgba(15,23,42,0.1)', 'rgba(15,23,42,0.9)']}
                  style={[styles.gridShade, { pointerEvents: 'none' }]}
                />
                <View style={styles.gridContent}>
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 8,
                      marginBottom: 4,
                    }}
                  >
                    {teamLogo ? (
                      <Image
                        source={{ uri: teamLogo }}
                        style={{ width: 28, height: 28, borderRadius: 14 }}
                        contentFit="cover"
                      />
                    ) : (
                      <View
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: 14,
                          backgroundColor: '#374151',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <Text style={{ color: '#fff', fontWeight: '700', fontSize: 12 }}>
                          {(teamName || 'T').charAt(0).toUpperCase()}
                        </Text>
                      </View>
                    )}
                    <Text style={[styles.gridTitle, { marginBottom: 0 }]} numberOfLines={1}>
                      {teamName}
                    </Text>
                  </View>
                  {caption ? (
                    <Text
                      style={[styles.gridMeta, { color: '#F9FAFB', marginBottom: 6 }]}
                      numberOfLines={2}
                    >
                      {caption}
                    </Text>
                  ) : null}
                  <View style={styles.gridStatsRow}>
                    <View style={styles.gridStat}>
                      <MaterialIcons name="arrow-upward" size={12} color="#F9FAFB" />
                      <Text style={styles.gridStatText}>{post.upvotes_count ?? 0}</Text>
                    </View>
                    <View style={styles.gridStat}>
                      <MaterialIcons name="chat-bubble-outline" size={12} color="#F9FAFB" />
                      <Text style={styles.gridStatText}>{post.comments_count ?? 0}</Text>
                    </View>
                  </View>
                </View>
              </Pressable>
            </View>
          );
        }

        case 'past_game': {
          return (
            <View style={{ paddingHorizontal: 16, marginBottom: 20 }}>
              {renderGameCard(item.data, false, 'feed-nearby')}
            </View>
          );
        }

        case 'footer':
          return (
            <View style={styles.gridFooter}>
              <View style={styles.verticalFeedSection}>
                <Text style={styles.sectionTitle}>{verticalFeedTitle}</Text>
                <Pressable
                  testID="feed-vertical-feed-button"
                  onPress={openVerticalFeed}
                  style={styles.verticalFeedCard}
                  accessibilityRole="button"
                  accessibilityLabel="Open highlights reel"
                >
                  {verticalFeedPreviewImage ? (
                    Platform.OS === 'web' ? (
                      <View style={styles.verticalFeedImage}>
                        <RNImage
                          source={{
                            uri:
                              optimizeImageUrl(verticalFeedPreviewImage, 800) ||
                              verticalFeedPreviewImage,
                          }}
                          style={StyleSheet.absoluteFillObject}
                          resizeMode="cover"
                        />
                      </View>
                    ) : (
                      <Image
                        source={{ uri: optimizeImageUrl(verticalFeedPreviewImage, 800) }}
                        style={styles.verticalFeedImage}
                        contentFit="cover"
                      />
                    )
                  ) : (
                    <LinearGradient
                      colors={['#1E1E1E', '#121212']}
                      style={styles.verticalFeedImage}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 1 }}
                    />
                  )}
                  <LinearGradient
                    colors={
                      colorScheme === 'dark'
                        ? ['rgba(15,23,42,0.2)', 'rgba(15,23,42,0.9)']
                        : ['rgba(15,23,42,0.1)', 'rgba(15,23,42,0.85)']
                    }
                    style={styles.verticalFeedShade}
                  />
                  <View style={styles.verticalFeedContent}>
                    <View style={styles.verticalFeedBadge}>
                      <MaterialIcons name="play-arrow" size={18} color="#fff" />
                    </View>
                    <Text style={styles.verticalFeedTitleText}>Watch Highlights</Text>
                    {verticalFeedAuthorText ? (
                      <Text style={styles.verticalFeedCaption} numberOfLines={1}>
                        {verticalFeedAuthorText}
                      </Text>
                    ) : null}
                    <Text style={styles.verticalFeedSubtitle} numberOfLines={2}>
                      {verticalFeedSubtitleText}
                    </Text>
                  </View>
                </Pressable>
              </View>

              {loadingMore ? (
                <View style={styles.loadingMore}>
                  <ActivityIndicator size="small" color={Colors[colorScheme].tint} />
                </View>
              ) : null}
            </View>
          );

        default:
          return null;
      }
    },
    [
      colorScheme,
      router,
      followedPosts,
      followedTeamsPosts,
      renderGameCard,
      renderEmailReminder,
      showAdReportOptions,
      renderLocationPrompt,
      verticalFeedTitle,
      verticalFeedPreviewImage,
      verticalFeedSubtitleText,
      verticalFeedAuthorText,
      openVerticalFeed,
      loadingMore,
      followedFeedMeta,
      followedTeamsFeedMeta,
      setFollowedPosts,
      loadingMoreFollowedPosts,
      loadingMoreFollowedTeamsPosts,
      loadMoreSocialPosts,
    ]
  );

  if (Platform.OS === 'web' && !webHydrated) {
    return null;
  }

  const showEmptyState =
    !loading && upcomingEvents.length === 0 && pastEvents.length === 0 && !error;
  const listHeader = (
    <>
      {error && (
        <View style={{ marginVertical: 24, paddingHorizontal: 24, alignItems: 'center' }}>
          <MaterialIcons
            name="cloud-off"
            size={48}
            color={Colors[colorScheme].mutedText}
            style={{ marginBottom: 12 }}
          />
          <Text
            style={{
              color: Colors[colorScheme].text,
              fontSize: 16,
              fontWeight: '600',
              textAlign: 'center',
              marginBottom: 6,
            }}
          >
            {error}
          </Text>
          <Pressable
            testID="feed-retry-button"
            onPress={() => void load()}
            style={{
              marginTop: 12,
              paddingVertical: 10,
              paddingHorizontal: 24,
              borderRadius: 8,
              backgroundColor: Colors[colorScheme].tint,
            }}
            accessibilityLabel="Retry loading feed"
            accessibilityRole="button"
          >
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>Retry</Text>
          </Pressable>
          {(error.includes('sign in') || error.includes('Sign in')) && (
            <Pressable
              testID="feed-signin-button"
              onPress={() => void router.replace('/sign-in')}
              style={{ marginTop: 10, paddingVertical: 8 }}
              accessibilityLabel="Sign in"
              accessibilityRole="button"
            >
              <Text style={{ color: Colors[colorScheme].tint, fontWeight: '600' }}>Sign In</Text>
            </Pressable>
          )}
        </View>
      )}

      {!error && socialFeedWarning ? (
        <View
          testID="feed-bundle-warning"
          style={[
            styles.feedWarning,
            {
              backgroundColor: colorScheme === 'dark' ? '#422006' : '#FFFBEB',
              borderColor: colorScheme === 'dark' ? '#92400E' : '#F59E0B',
            },
          ]}
        >
          <MaterialIcons
            name="error-outline"
            size={18}
            color={colorScheme === 'dark' ? '#FBBF24' : '#B45309'}
          />
          <Text
            style={[
              styles.feedWarningText,
              { color: colorScheme === 'dark' ? '#FDE68A' : '#92400E' },
            ]}
          >
            {socialFeedWarning}
          </Text>
        </View>
      ) : null}

      <View
        style={[styles.mapsButton, { backgroundColor: '#0A84FF' }]}
        onStartShouldSetResponder={() => true}
        onResponderRelease={() => {
          // game-map ignores lat/lng params now (it shows ALL public events via
          // /event-discovery?surface=map, no location gating), so the old GPS
          // permission + getCurrentPositionAsync round-trip was pure dead weight
          // that slowed opening the most important page. Navigate directly.
          router.push('/game-map');
        }}
        accessibilityRole="button"
        accessibilityLabel="View games nearby"
        accessibilityHint="Double tap to open map"
        accessible
      >
        <MaterialIcons name="map" size={24} color="#FFFFFF" />
        <Text style={styles.mapsButtonText}>View Games Nearby</Text>
        <MaterialIcons name="chevron-right" size={20} color="#FFFFFF" />
      </View>

      {feedSports.length > 1 ? (
        <View style={styles.feedSportFilter}>
          <SportFilterBar
            sports={feedSports}
            selected={selectedFeedSport}
            onSelect={setSelectedFeedSport}
          />
        </View>
      ) : null}

      <Text style={[styles.helper, { color: Colors[colorScheme].mutedText }]}>
        Showing upcoming and recent games in your area.
      </Text>

      {loading && (
        <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
          <PostCardSkeleton />
          <PostCardSkeleton />
          <PostCardSkeleton />
        </View>
      )}
      {showEmptyState && (
        <View style={{ alignItems: 'center', paddingVertical: 40, paddingHorizontal: 24 }}>
          <MaterialIcons name="dynamic-feed" size={56} color={Colors[colorScheme].mutedText} />
          <Text
            style={{
              color: Colors[colorScheme].text,
              fontSize: 18,
              fontWeight: '700',
              marginTop: 14,
              marginBottom: 6,
            }}
          >
            No posts yet
          </Text>
          <Text
            style={[
              styles.muted,
              {
                color: Colors[colorScheme].mutedText,
                textAlign: 'center',
                lineHeight: 20,
                marginBottom: 20,
              },
            ]}
          >
            Follow teams and coaches to see their content here.
          </Text>
          <Pressable
            testID="feed-discover-games-button"
            onPress={() => router.push('/(tabs)/discover')}
            style={{
              backgroundColor: Colors[colorScheme].tint,
              paddingHorizontal: 24,
              paddingVertical: 12,
              borderRadius: 10,
              marginBottom: 10,
              width: '100%',
              alignItems: 'center',
            }}
            accessibilityRole="button"
            accessibilityLabel="Discover nearby games"
          >
            <Text style={{ color: '#FFFFFF', fontSize: 15, fontWeight: '600' }}>
              Discover Nearby Games
            </Text>
          </Pressable>
          <Pressable
            testID="feed-browse-teams-button"
            onPress={() => router.push('/(tabs)/discover')}
            style={{
              backgroundColor: 'transparent',
              paddingHorizontal: 24,
              paddingVertical: 12,
              borderRadius: 10,
              borderWidth: 1,
              borderColor: Colors[colorScheme].border,
              width: '100%',
              alignItems: 'center',
            }}
            accessibilityRole="button"
            accessibilityLabel="Browse teams to follow"
          >
            <Text style={{ color: Colors[colorScheme].text, fontSize: 15, fontWeight: '600' }}>
              Browse Teams
            </Text>
          </Pressable>
        </View>
      )}
    </>
  );

  return (
    <View style={[styles.container, { backgroundColor: Colors[colorScheme].background }]}>
      {/* Navbar title intentionally swapped to show Feed in the stack and VarsityHub in the UI header */}
      <Stack.Screen options={{ title: 'Feed' }} />

      {/* Enhanced header with gradient background and safe area */}
      <LinearGradient
        colors={colorScheme === 'dark' ? ['#1E1E1E', '#121212'] : ['#ffffff', '#f8fafc']}
        style={[styles.headerGradient, { paddingTop: insets.top + 4 }]}
      >
        <View style={styles.headerRow}>
          {/* Notifications on LEFT */}
          <View style={styles.headerActions}>
            <Pressable
              testID="feed-notifications-button"
              onPress={() => setNotificationsMenuOpen(true)}
              style={styles.iconButton}
              accessibilityRole="button"
              accessibilityLabel="Open notifications"
            >
              <View>
                <MaterialIcons
                  name="notifications-none"
                  size={24}
                  color={Colors[colorScheme].text}
                />
                {unreadNotifCount > 0 ? (
                  <View
                    style={[
                      styles.unreadBadge,
                      { position: 'absolute', right: -6, top: -4, backgroundColor: '#EF4444' },
                    ]}
                  >
                    <Text style={styles.unreadBadgeText}>
                      {unreadNotifCount > 99 ? '99+' : String(unreadNotifCount)}
                    </Text>
                  </View>
                ) : null}
              </View>
            </Pressable>
          </View>
          <View style={{ flex: 1 }} />
          <Pressable
            testID="feed-brand-button"
            style={styles.brandRow}
            onPress={openInstagram}
            accessibilityRole="button"
            accessibilityLabel="Open VarsityHub Instagram"
          >
            <Image source={require('../assets/images/logo.svg')} style={styles.logoImage} />
            <Text
              style={[styles.brand, { color: Colors[colorScheme].text }]}
              numberOfLines={1}
              allowFontScaling={false}
            >
              Varsity Hub
            </Text>
          </Pressable>
          <View style={{ flex: 1 }} />
          {/* Messages on RIGHT */}
          <View style={styles.headerActions}>
            <Pressable
              testID="feed-messages-button"
              onPress={() => void router.push('/messages' as any)}
              style={styles.iconButton}
              accessibilityRole="button"
              accessibilityLabel={
                unreadMessagesCount > 0
                  ? `Open messages (${unreadMessagesCount} unread)`
                  : 'Open messages'
              }
            >
              <View>
                <MaterialIcons
                  name="chat-bubble-outline"
                  size={24}
                  color={Colors[colorScheme].text}
                />
                {unreadMessagesCount > 0 ? (
                  <View style={[styles.unreadBadge, { position: 'absolute', right: -6, top: -4 }]}>
                    <Text style={styles.unreadBadgeText}>
                      {unreadMessagesCount > 99 ? '99+' : String(unreadMessagesCount)}
                    </Text>
                  </View>
                ) : null}
              </View>
            </Pressable>
          </View>
        </View>
      </LinearGradient>

      <View style={styles.contentContainer}>
        <FlatList
          data={feedItems}
          renderItem={renderFeedItem}
          keyExtractor={keyExtractor}
          style={styles.feedList}
          ListHeaderComponent={listHeader}
          contentContainerStyle={{
            paddingVertical: 12,
            paddingBottom: Math.max(tabBarHeight + 16, insets.bottom + 80),
          }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={Colors[colorScheme].tint}
            />
          }
          showsVerticalScrollIndicator={false}
          onEndReached={_loadMore}
          onEndReachedThreshold={0.3}
          initialNumToRender={8}
          maxToRenderPerBatch={6}
          windowSize={7}
          removeClippedSubviews={Platform.OS !== 'web'}
        />
      </View>

      {/* Notifications & Messages Menu Modal */}
      <Modal
        visible={notificationsMenuOpen}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setNotificationsMenuOpen(false)}
      >
        <View
          style={[
            styles.menuModal,
            { backgroundColor: Colors[colorScheme].background, paddingTop: insets.top },
          ]}
        >
          {/* Header */}
          <View style={[styles.menuHeader, { borderBottomColor: Colors[colorScheme].border }]}>
            <Text style={[styles.menuTitle, { color: Colors[colorScheme].text }]}>Updates</Text>
            <Pressable
              testID="feed-close-notifications-button"
              onPress={() => setNotificationsMenuOpen(false)}
              style={styles.closeButton}
              accessibilityLabel="Close notifications"
              accessibilityRole="button"
            >
              <MaterialIcons name="close" size={28} color={Colors[colorScheme].text} />
            </Pressable>
          </View>

          {/* No tabs needed - only showing notifications */}

          {/* Content */}
          <View style={{ flex: 1 }}>
            {loadingNotifications ? (
              <View style={styles.center}>
                <ActivityIndicator color={Colors[colorScheme].tint} />
              </View>
            ) : notificationsError ? (
              <View style={{ padding: 24, alignItems: 'center' }}>
                <MaterialIcons
                  name="error-outline"
                  size={48}
                  color={Colors[colorScheme].mutedText}
                />
                <Text style={[styles.emptyText, { color: Colors[colorScheme].mutedText }]}>
                  Couldn&apos;t load updates
                </Text>
                <Pressable
                  onPress={() => setNotificationsReloadKey(k => k + 1)}
                  style={{
                    marginTop: 12,
                    paddingHorizontal: 16,
                    paddingVertical: 8,
                    borderRadius: 8,
                    backgroundColor: Colors[colorScheme].tint,
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Retry loading updates"
                >
                  <Text style={{ color: '#FFFFFF', fontWeight: '600' }}>Retry</Text>
                </Pressable>
              </View>
            ) : notificationsList.length === 0 ? (
              <View style={{ padding: 24, alignItems: 'center' }}>
                <MaterialIcons
                  name="notifications-off"
                  size={48}
                  color={Colors[colorScheme].mutedText}
                />
                <Text style={[styles.emptyText, { color: Colors[colorScheme].mutedText }]}>
                  No notifications
                </Text>
              </View>
            ) : (
              <FlatList
                data={notificationsList}
                keyExtractor={item => item.id}
                maxToRenderPerBatch={10}
                windowSize={10}
                removeClippedSubviews={true}
                renderItem={({ item }) => {
                  const title = getNotificationTitle(item);
                  const subtitle = getNotificationSubtitle(item);

                  return (
                    <Pressable
                      style={[
                        styles.listRow,
                        !item.read_at && styles.listRowUnread,
                        { borderBottomColor: Colors[colorScheme].border },
                      ]}
                      accessibilityLabel={title}
                      accessibilityRole="button"
                      onPress={async () => {
                        // Mark notification as read
                        if (!item.read_at) {
                          try {
                            await NotificationApi.markRead(item.id);
                            // Update local state to remove unread indicator immediately
                            setNotificationsList(prev =>
                              prev.map(n =>
                                n.id === item.id ? { ...n, read_at: new Date().toISOString() } : n
                              )
                            );
                            // Refresh unread count
                            const countRes = await NotificationApi.unreadCount().catch(() => 0);
                            const nc =
                              typeof countRes === 'number' ? countRes : (countRes?.count ?? 0);
                            setUnreadNotifCount(nc);
                          } catch (e) {
                            if (__DEV__) console.error('Failed to mark notification as read', e);
                          }
                        }

                        setNotificationsMenuOpen(false);
                        const href = getNotificationHrefForUser(item, user);
                        if (href) {
                          router.push(href as any);
                        }
                      }}
                    >
                      <View style={styles.listAvatarWrap}>
                        {/* Always render fallback as base layer */}
                        <View
                          style={[
                            styles.listAvatar,
                            { backgroundColor: Colors[colorScheme].border },
                          ]}
                        >
                          <MaterialIcons
                            name="person"
                            size={22}
                            color={Colors[colorScheme].mutedText}
                          />
                        </View>
                        {/* Overlay actual image — if it fails, fallback stays visible */}
                        {isSystemNotification(item) || !item.actor ? (
                          <Image
                            source={VARSITYHUB_LOGO}
                            style={[styles.listAvatar, { position: 'absolute', top: 0, left: 0 }]}
                            contentFit="cover"
                            accessibilityLabel="VarsityHub"
                          />
                        ) : item.actor?.avatar_url ? (
                          <Image
                            source={{ uri: item.actor.avatar_url }}
                            style={[styles.listAvatar, { position: 'absolute', top: 0, left: 0 }]}
                            contentFit="cover"
                          />
                        ) : null}
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.listTitle, { color: Colors[colorScheme].text }]}>
                          {title}
                        </Text>
                        {subtitle && (
                          <Text
                            numberOfLines={1}
                            style={[styles.listSubtitle, { color: Colors[colorScheme].mutedText }]}
                          >
                            {subtitle}
                          </Text>
                        )}
                      </View>
                      {!item.read_at && <View style={styles.unreadDot} />}
                    </Pressable>
                  );
                }}
              />
            )}
          </View>
        </View>
      </Modal>

      {verticalFeedModalVisible ? (
        <Modal
          visible
          animationType="slide"
          presentationStyle="fullScreen"
          onRequestClose={closeVerticalFeed}
        >
          <View
            style={[styles.verticalFeedModal, { backgroundColor: Colors[colorScheme].background }]}
          >
            <GameVerticalFeedScreen
              key={activeVerticalFeedGameId || 'all-highlights'}
              gameId={activeVerticalFeedGameId}
              onClose={closeVerticalFeed}
              countryCode={userCountryCode}
            />
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, minHeight: 0 },
  headerGradient: {
    paddingHorizontal: 16,
    paddingBottom: 2,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.05)',
    overflow: 'hidden',
  },
  contentContainer: { flex: 1, minHeight: 0, paddingHorizontal: 16, paddingTop: 0 },
  feedList: {
    flex: 1,
    minHeight: 0,
  },
  logoImage: { width: 36, height: 36, borderRadius: 8 },
  headerActions: {
    flex: 1,
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
  },
  iconButton: {
    width: 44,
    height: 44,
    flexShrink: 0,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: { paddingVertical: 24, alignItems: 'center' },
  error: { color: '#b91c1c', marginBottom: 8 },
  muted: { fontSize: 14 },
  helper: { fontSize: 14, marginBottom: 6 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  brand: { fontSize: 26, fontWeight: '800', letterSpacing: -0.5, flexShrink: 1 },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 48,
    borderRadius: 12,
    paddingHorizontal: 12,
    marginBottom: 8,
    borderWidth: 1,
  },
  searchInput: { flex: 1, height: 44 },
  mapsButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    height: 56,
    borderRadius: 12,
    paddingHorizontal: 20,
    marginBottom: 12,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 2px 4px rgba(0, 0, 0, 0.1)' }
      : {
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.1,
          shadowRadius: 4,
        }),
    elevation: 3,
  },
  mapsButtonText: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '700',
    flex: 1,
  },
  feedSportFilter: {
    alignItems: 'flex-start',
    marginBottom: 10,
  },
  gridRow: { gap: 6, paddingHorizontal: 4, marginBottom: 6 },
  masonryContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 4,
    paddingBottom: 12,
  },
  masonryItem: {
    width: '49%',
    margin: '0.5%',
    borderRadius: 18,
    overflow: 'hidden',
    position: 'relative',
    backgroundColor: '#121212',
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 4px 8px rgba(15, 23, 42, 0.12)' }
      : {
          shadowColor: '#0f172a',
          shadowOpacity: 0.12,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 4 },
        }),
    elevation: 3,
  },
  singleEventCard: {
    width: '100%',
    // Matches the event detail page's fixed banner height (GameDetailsScreen
    // bannerHeight) so the same photo isn't cropped differently here vs there.
    height: 240,
    borderRadius: 18,
    overflow: 'hidden',
    position: 'relative',
    backgroundColor: '#121212',
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 4px 8px rgba(15, 23, 42, 0.12)' }
      : {
          shadowColor: '#0f172a',
          shadowOpacity: 0.12,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 4 },
        }),
    elevation: 3,
  },
  singleEventImage: { width: '100%', height: '100%' },
  sectionHeader: {
    fontSize: 18,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  socialFeedEmpty: {
    marginTop: 8,
    padding: 24,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
  },
  socialFeedEmptyTitle: {
    fontSize: 17,
    fontWeight: '700',
    marginTop: 16,
    textAlign: 'center',
  },
  socialFeedEmptySubtitle: {
    fontSize: 14,
    marginTop: 8,
    textAlign: 'center',
    lineHeight: 20,
  },
  socialFeedEmptyButton: {
    marginTop: 20,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 12,
  },
  socialFeedEmptyButtonText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  // Sponsored ad styles for feed
  sponsoredFeedCard: {
    width: '100%',
    borderRadius: 18,
    overflow: 'hidden',
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 4px 8px rgba(15, 23, 42, 0.08)' }
      : {
          shadowColor: '#0f172a',
          shadowOpacity: 0.08,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 4 },
        }),
    elevation: 3,
  },
  sponsoredHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingRight: 12,
  },
  sponsoredLabel: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  adReportButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  adReportButtonText: {
    fontSize: 11,
    fontWeight: '600',
  },
  adPlaceholder: {
    width: '100%',
    aspectRatio: 3.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  promoPlaceholder: {
    width: '100%',
    minHeight: 120,
    alignItems: 'center',
    justifyContent: 'space-between',
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 16,
    borderWidth: 1,
    borderStyle: 'solid',
  },
  promoIcon: {
    width: 40,
    height: 40,
    borderWidth: 2,
    borderRadius: 10,
    flexShrink: 0,
  },
  promoTitle: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: '700',
    marginBottom: 2,
  },
  promoSubtitle: {
    fontSize: 12,
    lineHeight: 16,
  },
  promoteCtaBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    minWidth: 100,
    flexShrink: 0,
  },
  promoteCtaIcon: {
    width: 16,
    height: 16,
    borderWidth: 1.5,
    borderRadius: 3,
  },
  adInfo: {
    padding: 16,
    gap: 6,
  },
  adBusinessName: {
    fontSize: 16,
    fontWeight: '700',
  },
  adDescription: {
    fontSize: 14,
    lineHeight: 20,
  },
  promoteCta: {
    marginTop: 12,
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: '#2563EB',
  },
  promoteCtaText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 13,
  },
  gridItem: {
    flex: 1,
    aspectRatio: 1,
    borderRadius: 18,
    overflow: 'hidden',
    position: 'relative',
    backgroundColor: '#121212',
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 4px 8px rgba(15, 23, 42, 0.12)' }
      : {
          shadowColor: '#0f172a',
          shadowOpacity: 0.12,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 4 },
        }),
    elevation: 3,
  },
  gridImage: { width: '100%', height: '100%' },
  gridShade: { ...StyleSheet.absoluteFillObject },
  venueCredit: {
    position: 'absolute',
    left: 8,
    bottom: 6,
    fontSize: 8,
    color: 'rgba(255,255,255,0.7)',
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  gridContent: { position: 'absolute', left: 12, right: 12, bottom: 12, gap: 6 },
  gridDateChip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(15,23,42,0.65)',
  },
  gridDateText: { color: '#F9FAFB', fontWeight: '700', fontSize: 12 },
  gridTitle: { color: '#FFFFFF', fontWeight: '800', fontSize: 14, lineHeight: 18 },
  gridMeta: { color: '#D1D5DB', fontSize: 12 },
  gridStatsRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  gridStat: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  gridStatText: { color: '#F9FAFB', fontSize: 11, fontWeight: '600' },
  gridVoteText: { color: '#E0F2FE', fontSize: 11, fontWeight: '600' },
  gridCredit: { color: '#F9FAFB', fontSize: 10, opacity: 0.9 },
  gridFooter: { width: '100%', marginTop: 12, gap: 24, paddingHorizontal: 8, overflow: 'hidden' },
  sponsoredGridCard: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 20,
    gap: 12,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 4px 12px rgba(15, 23, 42, 0.08)' }
      : {
          shadowColor: '#0f172a',
          shadowOpacity: 0.08,
          shadowOffset: { width: 0, height: 4 },
          shadowRadius: 12,
        }),
    elevation: 3,
  },
  sponsoredGridLabel: {
    color: Colors.light.mutedText,
    fontWeight: '800',
    fontSize: 11,
    letterSpacing: 1.2,
  },
  sponsoredGridImageWrapper: { height: 140, borderRadius: 14, overflow: 'hidden' },
  sponsoredGridImage: { width: '100%', height: '100%' },
  sponsoredGridTitle: { fontWeight: '800', fontSize: 16 },
  sponsoredGridDescription: { fontSize: 13, lineHeight: 18 },
  sponsoredGridCta: {
    marginTop: 4,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: '#2563EB',
  },
  sponsoredGridCtaText: { color: '#FFFFFF', fontWeight: '700', fontSize: 13 },
  adInviteCard: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 18,
    gap: 6,
  },
  adInviteTitle: {
    fontWeight: '800',
    fontSize: 18,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  adInviteSubtitle: { fontSize: 13, lineHeight: 18 },
  loadingMore: { paddingVertical: 16, alignItems: 'center' },
  socialLoadMoreWrap: {
    paddingHorizontal: 16,
    paddingBottom: 18,
    alignItems: 'center',
  },
  socialLoadMoreButton: {
    minHeight: 42,
    minWidth: 148,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  socialLoadMoreText: { fontSize: 14, fontWeight: '700' },
  feedWarning: {
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 4,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  feedWarningText: { flex: 1, fontSize: 13, fontWeight: '600', lineHeight: 18 },
  sectionTitle: { fontWeight: '800', marginBottom: 8 },
  zipSuggestionList: {
    marginTop: 6,
    marginBottom: 8,
    borderRadius: 12,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E2E8F0',
    overflow: 'hidden',
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 4px 12px rgba(15, 23, 42, 0.08)' }
      : {
          shadowColor: '#0f172a',
          shadowOpacity: 0.08,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 4 },
        }),
    elevation: 3,
  },
  zipSuggestionItem: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  zipSuggestionZip: { fontWeight: '700', fontSize: 15 },
  zipSuggestionCount: { color: Colors.light.mutedText, fontSize: 12 },
  verticalFeedSection: { marginTop: 32, marginBottom: 24 },
  verticalFeedCard: {
    marginTop: 12,
    borderRadius: 20,
    overflow: 'hidden',
    backgroundColor: '#121212',
    minHeight: 220,
    aspectRatio: 1,
    justifyContent: 'flex-end',
  },
  verticalFeedImage: { ...StyleSheet.absoluteFillObject },
  verticalFeedShade: { ...StyleSheet.absoluteFillObject },
  verticalFeedContent: { position: 'absolute', left: 20, right: 20, bottom: 20, gap: 8 },
  verticalFeedBadge: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(37,99,235,0.95)',
    overflow: 'hidden',
  },
  verticalFeedTitleText: { color: '#ffffff', fontWeight: '800', fontSize: 20 },
  verticalFeedCaption: { color: '#bfdbfe', fontWeight: '600', fontSize: 12 },
  verticalFeedSubtitle: { color: '#cbd5f5', fontWeight: '600', fontSize: 13 },
  verticalFeedModal: { flex: 1, backgroundColor: '#020617' },
  alertDot: {
    position: 'absolute',
    right: -1,
    top: -1,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#EF4444',
  },
  // Menu Modal Styles
  menuModal: {
    flex: 1,
  },
  menuHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
  },
  menuTitle: {
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  closeButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
  },
  menuTabs: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    borderBottomWidth: 1,
  },
  menuTab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 16,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  menuTabActive: {
    borderBottomColor: '#2563EB',
  },
  menuTabText: {
    fontSize: 15,
    fontWeight: '600',
  },
  menuTabBadge: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#EF4444',
    marginLeft: 4,
  },
  menuContent: {
    flex: 1,
    padding: 20,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingVertical: 16,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: 'rgba(37, 99, 235, 0.05)',
    borderWidth: 1,
  },
  menuItemTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  menuItemSubtitle: {
    fontSize: 13,
    marginTop: 2,
  },
  // List items for notifications and messages
  emptyText: {
    marginTop: 12,
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  listRowUnread: {
    backgroundColor: 'rgba(37, 99, 235, 0.03)',
  },
  listAvatarWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    overflow: 'hidden',
  },
  listAvatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listTitle: {
    fontSize: 15,
    fontWeight: '700',
  },
  listSubtitle: {
    fontSize: 13,
    marginTop: 2,
  },
  unreadDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#2563EB',
  },
  unreadBadge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#2563EB',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  unreadBadgeText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
  },
});
