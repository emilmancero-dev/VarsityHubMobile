import { toUserMessage } from '@/utils/toUserMessage';
import { Colors } from '@/constants/Colors';
import { useAuth } from '@/context/AuthProvider';
import { useColorScheme } from '@/hooks/useColorScheme';
import { useDeviceLocation } from '@/hooks/useDeviceLocation';
import { promptForSignIn } from '@/utils/requireSignIn';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Calendar, DateData } from 'react-native-calendars';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  InteractionManager,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
// @ts-ignore JS exports
import { Event, Game, Organization, Post, Search, Team, User } from '@/api/entities';
import { httpGet } from '@/api/http';
import { validateEventCards } from '@/api/schemas/eventCard';
import { buildDiscoverMarkedDates, splitCalendarCards } from '@/utils/discoverCalendar';
import { buildMapDiscoveryPath, toMapEvents } from '@/utils/mapDiscovery';
import EventMap, { EventMapData } from '@/components/EventMap';
import PostCard from '@/components/PostCard';
import QuickAddGameModal, { QuickGameData } from '@/components/QuickAddGameModal';
import SwipeBackContainer from '@/components/SwipeBackContainer';
import { analytics, ANALYTICS_EVENTS } from '@/utils/analytics';
import { getAuthSnapshot, getCanonicalOrganizationId } from '@/utils/authState';
import { handleCoachAccessError } from '@/utils/coachAccess';
import { buildEventDetailRoute } from '@/utils/eventRoutes';
import { optimizeImageUrl } from '@/utils/imageUrl';
import { resolveMediaType } from '@/utils/media';
import { getCoachAccessState, getCoachFinishSetupRoute } from '@/utils/roleChecks';
import { captureBreadcrumb, captureException } from '@/utils/sentry';
import GameVerticalFeedScreen, { type FeedPost } from '../../game-details/GameVerticalFeedScreen';
import { styles } from '@/styles/tabs/discover/mobile-community.styles';

// Guard against internal IDs (cuid / UUID) being leaked as display text
const isInternalId = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) || // UUID
  /^c[0-9a-z]{20,}$/.test(s) || // CUID v1
  (/^[0-9a-z]{8,}$/.test(s) && !/[aeiou]{2,}/i.test(s)); // Random ID (no vowel pairs = not a real name)

const safeDisplayName = (user: any): string => {
  // Owner rule (note 5): a user is recognized ONLY by their username — never a
  // real name / display_name / email. No display_name fallback.
  const uname = user?.username;
  if (uname && !isInternalId(uname)) return uname;
  return 'User';
};

const safeUsername = (user: any): string | null => {
  // Show @username as subtitle only when display_name (not username) is the primary text
  const uname = user?.username;
  const hasRealUsername = uname && !isInternalId(uname);
  // Username is already shown as the main display name — no need to repeat it
  if (hasRealUsername) return null;
  // display_name is shown as main, but no real username to show as subtitle
  return null;
};

type GameItem = {
  id: string;
  title?: string;
  date?: string;
  location?: string;
  latitude?: number | null;
  longitude?: number | null;
  cover_image_url?: string;
  banner_url?: string | null;
  event_id?: string | null;
  game_id?: string | null;
  source_type?: 'game' | 'event';
  pro_league?: string | null;
};

type ZipDirectoryEntry = { zip: string; count: number };

const ZIP_REGEX = /\b\d{5}\b/g;
const DISCOVER_NCAA_LEAGUES = ['ncaaf', 'ncaamb', 'ncaawb', 'ncaabaseball', 'ncaamhockey'] as const;
const DISCOVER_EVENT_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const DISCOVER_EVENT_LOOKAHEAD_MS = 14 * 24 * 60 * 60 * 1000;
const USA_WIDE_REGION = {
  latitude: 39.8,
  longitude: -98.5,
  latitudeDelta: 50,
  longitudeDelta: 50,
};

const normalizeMapEvent = (event: any): GameItem | null => {
  if (!event || typeof event.id !== 'string') return null;
  return {
    id: String(event.game_id || event.id),
    title: event.title || event.game?.title || 'Game',
    date: event.date || event.game?.date || undefined,
    location: event.location || event.game?.location || undefined,
    latitude:
      typeof event.latitude === 'number'
        ? event.latitude
        : typeof event.game?.latitude === 'number'
          ? event.game.latitude
          : null,
    longitude:
      typeof event.longitude === 'number'
        ? event.longitude
        : typeof event.game?.longitude === 'number'
          ? event.game.longitude
          : null,
    cover_image_url: event.game?.cover_image_url || event.cover_image_url || undefined,
    banner_url: event.banner_url || null,
    event_id: event.id,
    game_id: event.game_id || null,
    source_type: event.game_id ? 'game' : 'event',
    pro_league: event.pro_league || null,
  };
};

const mergeDiscoverEvents = (...groups: GameItem[][]): GameItem[] => {
  const seen = new Set<string>();
  const merged: GameItem[] = [];
  for (const group of groups) {
    for (const item of group) {
      const key = item.event_id ? `event:${item.event_id}` : `game:${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }
  return merged.sort((a, b) => {
    const at = a.date ? new Date(a.date).getTime() : NaN;
    const bt = b.date ? new Date(b.date).getTime() : NaN;
    if (!Number.isFinite(at)) return 1;
    if (!Number.isFinite(bt)) return -1;
    return at - bt;
  });
};

const buildZipDirectory = (items: GameItem[]): ZipDirectoryEntry[] => {
  const counts = new Map<string, number>();
  items.forEach(game => {
    if (!game) return;
    const bucket: string[] = [];
    const maybeLocation = (game as any)?.location;
    if (typeof maybeLocation === 'string') bucket.push(maybeLocation);
    const maybeAddress = (game as any)?.address;
    if (typeof maybeAddress === 'string') bucket.push(maybeAddress);
    const maybeCity = (game as any)?.city;
    if (typeof maybeCity === 'string') bucket.push(maybeCity);
    const explicit = (game as any)?.zip || (game as any)?.postal_code;
    if (explicit) bucket.push(String(explicit));
    bucket.forEach(entry => {
      if (typeof entry !== 'string') return;
      const matches = entry.match(ZIP_REGEX);
      if (!matches) return;
      matches.forEach(zip => {
        const normalized = zip.slice(0, 5);
        if (!normalized) return;
        counts.set(normalized, (counts.get(normalized) || 0) + 1);
      });
    });
  });
  return Array.from(counts.entries())
    .map(([zip, count]) => ({ zip, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.zip.localeCompare(b.zip);
    });
};

// Real matchup labels, or null when the game has no linked teams and the title
// isn't a "X vs Y" matchup. Returning null lets the card skip the team pills
// instead of showing a meaningless "Team A vs Team B" placeholder — pro-sports
// events (titled "Away at Home", no linked Team rows) are the common case, and
// the owner's rule is no team pills tied to those yet. The card title still
// carries the matchup.
const deriveTeamLabels = (game: GameItem): { teamA: string; teamB: string } | null => {
  const g: any = game as any;
  if (Array.isArray(g.teams) && g.teams.length >= 2 && g.teams[0]?.name && g.teams[1]?.name) {
    return { teamA: String(g.teams[0].name), teamB: String(g.teams[1].name) };
  }
  const a = g.team_a?.name || g.teamA?.name || g.team_a_name || g.teamAName;
  const b = g.team_b?.name || g.teamB?.name || g.team_b_name || g.teamBName;
  if (a && b) return { teamA: String(a), teamB: String(b) };
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
  return null;
};

function CommunityDiscoverScreen() {
  const { user, checkAuth } = useAuth();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const colorScheme = useColorScheme() ?? 'light';
  const {
    location: _location,
    loading: _locLoading,
    error: _locError,
    permissionGranted,
    requestPermission,
    needsPreciseAccuracy,
    openSettings,
  } = useDeviceLocation();
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [me, setMe] = useState<any>(null);
  const [zipSuggestionsOpen, setZipSuggestionsOpen] = useState(false);
  const [tab, setTab] = useState<'discover' | 'following'>('discover');
  const [suggestedFollowLoading, setSuggestedFollowLoading] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'list' | 'map'>('list');
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [createEventModalOpen, setCreateEventModalOpen] = useState(false);
  const [isCreatingGame, setIsCreatingGame] = useState(false);
  // Which async coach quick action is currently resolving its target, so the
  // card can show a spinner and re-taps are ignored (no double navigation).
  const [quickActionBusy, setQuickActionBusy] = useState<null | 'org' | 'schedule'>(null);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);

  const reportDiscoverFailure = useCallback((task: string, error: unknown) => {
    if (__DEV__) console.warn(`[discover] ${task} failed:`, error);
    captureBreadcrumb('Discover deferred task failed', 'discover.community', { task }, 'warning');
    captureException(error instanceof Error ? error : new Error(String(error)), {
      tags: { context: 'discover-mobile-community', task },
    });
  }, []);

  // Load recent searches from AsyncStorage on mount
  useEffect(() => {
    AsyncStorage.getItem('vh_recent_searches')
      .then(val => {
        if (val)
          try {
            setRecentSearches(JSON.parse(val));
          } catch (error) {
            reportDiscoverFailure('parse_recent_searches', error);
          }
      })
      .catch(error => {
        reportDiscoverFailure('load_recent_searches', error);
      });
  }, [reportDiscoverFailure]);

  const saveRecentSearch = useCallback(
    (term: string) => {
      const trimmed = term.trim();
      if (!trimmed || trimmed.length < 2) return;
      setRecentSearches(prev => {
        const updated = [
          trimmed,
          ...prev.filter(s => s.toLowerCase() !== trimmed.toLowerCase()),
        ].slice(0, 5);
        void AsyncStorage.setItem('vh_recent_searches', JSON.stringify(updated)).catch(error => {
          reportDiscoverFailure('save_recent_searches', error);
        });
        return updated;
      });
    },
    [reportDiscoverFailure]
  );
  // Vertical viewer state
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerIndex, setViewerIndex] = useState(0);
  const [viewerPosts, setViewerPosts] = useState<FeedPost[]>([]);
  const [precisionBannerDismissed, setPrecisionBannerDismissed] = useState(false);
  // Derive the quick-actions branch from the LIVE auth user (reactive, and
  // already populated before this screen's own load() runs), falling back to the
  // loaded snapshot. This avoids the cold-start flip (coach briefly seeing the
  // fan actions) and keeps the branch fresh when auth state changes, without
  // refetching on every focus.
  const coachAccess = useMemo(() => getCoachAccessState((user ?? me) as any), [user, me]);
  const viewerId = typeof (user ?? me)?.id === 'string' ? String((user ?? me).id) : null;
  const isSignedIn = !!viewerId;
  // Role-barrier model: non-coach "authorized users" (team manager /
  // assistant_coach memberships) get exactly one quick action — Approvals
  // (roster + event approve/deny). Probe managed teams only when the coach
  // branches don't apply; fail closed to the fan actions on error.
  const [hasStaffTeams, setHasStaffTeams] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (!isSignedIn || coachAccess.canAccessCoachTools || coachAccess.isApprovedCoach) {
      setHasStaffTeams(false);
      return;
    }
    void (async () => {
      try {
        const teams = await Team.managed();
        const arr = Array.isArray(teams)
          ? teams
          : Array.isArray((teams as any)?.items)
            ? (teams as any).items
            : [];
        if (!cancelled) setHasStaffTeams(arr.length > 0);
      } catch {
        if (!cancelled) setHasStaffTeams(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isSignedIn, coachAccess.canAccessCoachTools, coachAccess.isApprovedCoach]);
  const showPrecisionBanner =
    Platform.OS === 'android' &&
    permissionGranted &&
    needsPreciseAccuracy &&
    !precisionBannerDismissed;
  // Unified search (users, teams, organizations, games, events)
  const [unifiedSearchResults, setUnifiedSearchResults] = useState<{
    users: any[];
    teams: any[];
    organizations: any[];
    games: any[];
    events: any[];
  } | null>(null);
  const [unifiedSearchLoading, setUnifiedSearchLoading] = useState(false);

  const toFeedPost = useCallback((p: any): FeedPost => {
    const mediaUrl: string | null =
      typeof p?.media_url === 'string'
        ? p.media_url
        : typeof p?.media?.url === 'string'
          ? p.media.url
          : null;
    const isVideo = resolveMediaType(mediaUrl, p?.media_type) === 'video';
    const author = p?.author || null;
    const authorId = author?.id ?? author?.user_id ?? null;
    return {
      id: String(p?.id ?? p?.post_id ?? Date.now()),
      media_url: mediaUrl,
      media_type: isVideo ? 'video' : 'image',
      game_id: p?.game_id ?? p?.game?.id ?? null,
      event_id: p?.event_id ?? p?.event?.id ?? null,
      caption: p?.caption ?? p?.title ?? null,
      upvotes_count:
        typeof p?.upvotes_count === 'number'
          ? p.upvotes_count
          : typeof p?.likes === 'number'
            ? p.likes
            : 0,
      comments_count:
        typeof p?._count?.comments === 'number'
          ? p._count.comments
          : typeof p?.comments_count === 'number'
            ? p.comments_count
            : 0,
      bookmarks_count: typeof p?.bookmarks_count === 'number' ? p.bookmarks_count : 0,
      created_at: p?.created_at ?? p?.createdAt ?? null,
      author: author
        ? {
            id: String(authorId ?? ''),
            display_name: author?.display_name ?? author?.name ?? author?.username ?? null,
            avatar_url: author?.avatar_url ?? author?.avatarUrl ?? null,
          }
        : null,
      has_upvoted: Boolean(p?.has_upvoted ?? p?.liked),
      has_bookmarked: Boolean(p?.has_bookmarked ?? p?.bookmarked),
      is_following_author: Boolean(p?.is_following_author ?? p?.is_following),
      type: p?.type ?? null,
      collage: p?.collage ?? null,
      preview_url: p?.preview_url ?? null,
    };
  }, []);

  const _openVerticalViewer = useCallback(
    (selected: any, pool: any[]) => {
      const list = Array.isArray(pool)
        ? pool.map(toFeedPost).filter(f => !!f && (!!f.media_url || !!f.collage))
        : [];
      const idx = list.findIndex(it => String(it.id) === String(selected?.id));
      setViewerPosts(list);
      setViewerIndex(Math.max(0, idx));
      setViewerOpen(true);
    },
    [toFeedPost]
  );

  // `me` drives the coach quick-actions branch; resolve it once per auth
  // change, independent of the data queries below.
  useEffect(() => {
    let mounted = true;
    if (!user) {
      setMe(null);
      return () => {
        mounted = false;
      };
    }
    void (async () => {
      try {
        const snapshot = await getAuthSnapshot(checkAuth, user);
        if (mounted) setMe(snapshot ?? null);
      } catch (err) {
        // Don't swallow: a failed snapshot nulls `me`, which silently downgrades
        // a coach to the fan quick actions. Surface it so the flip is diagnosable.
        reportDiscoverFailure('load_user_snapshot', err);
        if (mounted) setMe(null);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [checkAuth, reportDiscoverFailure, user]);

  // Defer the initial fetches until the navigation transition settles so this
  // heavy screen (search + multi-section results) isn't parsing a response
  // while the slide-in animation is still running. Cached revisits are
  // unaffected: a disabled query still renders its cached data instantly.
  const [interactionsDone, setInteractionsDone] = useState(false);
  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => setInteractionsDone(true));
    return () => task.cancel();
  }, []);

  const queryClient = useQueryClient();

  const {
    data: gamesData,
    isPending: gamesPending,
    isError: gamesIsError,
    error: gamesError,
    refetch: refetchGames,
  } = useQuery({
    queryKey: ['discover-games', viewerId ?? 'guest'],
    enabled: interactionsDone,
    queryFn: async (): Promise<GameItem[]> => {
      const snapshot: any = user ? await getAuthSnapshot(checkAuth, user).catch(() => null) : null;
      const nowMs = Date.now();
      const dateFrom = new Date(nowMs - DISCOVER_EVENT_LOOKBACK_MS).toISOString();
      const dateTo = new Date(nowMs + DISCOVER_EVENT_LOOKAHEAD_MS).toISOString();
      const raw = await Game.list('date', { dateFrom, dateTo, limit: 100 });
      let normalizedGames = Array.isArray(raw) ? raw : raw?.games || raw?.items || [];

      const zip = snapshot?.preferences?.zip_code
        ? String(snapshot.preferences.zip_code).trim()
        : '';
      const prioritizeByZip = (items: GameItem[]) => {
        if (!zip) return items;
        // Normalize zip code (remove dashes, spaces)
        const normalizedZip = zip.replace(/[-\s]/g, '').toLowerCase();
        const withZip: GameItem[] = [];
        const withoutZip: GameItem[] = [];
        items.forEach((g: GameItem) => {
          const hay =
            `${(g as any)?.location || ''} ${(g as any)?.address || ''} ${(g as any)?.city || ''}`.toLowerCase();
          // Extract zip codes from location string and check if any match
          const zipMatches = hay.match(/\b\d{5}(?:-\d{4})?\b/g);
          const hasMatchingZip = zipMatches?.some(z =>
            z.replace(/[-\s]/g, '').startsWith(normalizedZip.slice(0, 5))
          );
          if (hasMatchingZip || hay.includes(normalizedZip)) {
            withZip.push(g);
          } else {
            withoutZip.push(g);
          }
        });
        return [...withZip, ...withoutZip];
      };
      normalizedGames = prioritizeByZip(normalizedGames);

      void Promise.all([
        Event.filter(
          {
            event_type: 'game',
            pro_only: true,
            event_only: true,
            from: dateFrom,
            to: dateTo,
          },
          'date',
          100
        ).catch(() => []),
        ...DISCOVER_NCAA_LEAGUES.map(league =>
          Event.filter(
            {
              event_type: 'game',
              pro_only: true,
              pro_league: league,
              event_only: true,
              from: dateFrom,
              to: dateTo,
            },
            'date',
            100
          ).catch(() => [])
        ),
      ]).then(([proEvents, ...ncaaEvents]) => {
        const eventRows = [proEvents, ...ncaaEvents]
          .flat()
          .map(normalizeMapEvent)
          .filter((event): event is GameItem => Boolean(event));
        if (eventRows.length === 0) return;
        queryClient.setQueryData(['discover-games', viewerId ?? 'guest'], (old: GameItem[] = []) =>
          prioritizeByZip(mergeDiscoverEvents(old, eventRows))
        );
      });
      return normalizedGames;
    },
  });
  const games = useMemo(() => gamesData ?? [], [gamesData]);
  const zipDirectory = useMemo(() => buildZipDirectory(games), [games]);

  const { data: mapEventsData, isPending: mapEventsPending } = useQuery({
    queryKey: ['discover-map-events', viewerId ?? 'guest'],
    enabled: interactionsDone && viewMode === 'map',
    queryFn: async (): Promise<EventMapData[]> => {
      const res: unknown = await httpGet(buildMapDiscoveryPath(300));
      const cards = validateEventCards('/event-discovery?surface=map', res);
      return toMapEvents(cards, new Date());
    },
  });
  const mapEvents = useMemo(() => mapEventsData ?? [], [mapEventsData]);

  // Error card only when the games list never loaded — a failed background
  // refetch keeps the cached list visible.
  const error = (() => {
    if (!gamesIsError || gamesData !== undefined) return null;
    const errorMsg = gamesError instanceof Error ? gamesError.message : 'Unknown error';
    if (__DEV__) console.error('Discover load: failed to fetch games', gamesError);
    return errorMsg.includes('network') || errorMsg.includes('fetch')
      ? 'Network error. Please check your connection and try again.'
      : 'Unable to load events right now. Pull to refresh to retry.';
  })();

  // Discover's calendar = the viewer's followed + managed teams, served as
  // canonical event cards by the single /event-discovery?scope=following
  // endpoint (future-only, unbounded window). Replaces the former three queries
  // (followed games, followed events, managed-team games/events).
  const {
    data: followingCalendarData,
    isPending: followingCalendarPending,
    isError: followingCalendarIsError,
    refetch: refetchFollowingCalendar,
  } = useQuery({
    queryKey: ['discover-following-calendar', viewerId ?? 'guest'],
    enabled: interactionsDone && isSignedIn,
    queryFn: async () => {
      const res: unknown = await httpGet('/event-discovery?scope=following');
      const cards = validateEventCards('/event-discovery?scope=following', res);
      return splitCalendarCards(cards);
    },
  });
  const calendarGames = useMemo(() => followingCalendarData?.games ?? [], [followingCalendarData]);
  const calendarEvents = useMemo(
    () => followingCalendarData?.events ?? [],
    [followingCalendarData]
  );

  const personalizationQueryKey = ['discover-personalization', viewerId ?? 'guest'];
  const {
    data: personalization,
    isPending: personalizationPending,
    isError: personalizationIsError,
    refetch: refetchPersonalization,
  } = useQuery({
    queryKey: personalizationQueryKey,
    enabled: interactionsDone,
    queryFn: async () => {
      // Post.trendingPage owns the one compatibility fallback for servers that
      // explicitly report the trending endpoint as unsupported. Every other
      // failure rejects so React Query can retain stale data and expose retry.
      const page = await Post.trendingPage(undefined, 20);
      const items = Array.isArray(page.items) ? page.items : [];

      // Split ONCE at fetch time (posts don't jump tabs when a follow toggles)
      const followingOnly = items.filter(
        (p: any) => p && (p.is_following_author || p.is_following)
      );
      const nonFollowing = items.filter(
        (p: any) => !(p && (p.is_following_author || p.is_following))
      );
      return {
        followingPosts: followingOnly.slice(0, 12),
        discoverPosts: (nonFollowing.length ? nonFollowing : items).slice(0, 12),
      };
    },
  });
  const followingPosts = personalization?.followingPosts ?? [];
  const discoverPosts = personalization?.discoverPosts ?? [];

  // Patch both cached post arrays (optimistic follow toggle, delete, edit);
  // the derived followingPosts/discoverPosts re-render from the cache.
  const patchDiscoverPosts = useCallback(
    (mapPosts: (posts: any[]) => any[]) => {
      queryClient.setQueryData(['discover-personalization', viewerId ?? 'guest'], (old: any) =>
        old
          ? {
              ...old,
              followingPosts: mapPosts(old.followingPosts ?? []),
              discoverPosts: mapPosts(old.discoverPosts ?? []),
            }
          : old
      );
    },
    [queryClient, viewerId]
  );

  // One viewer-scoped request feeds both people displays. The API remains the
  // source of privacy/block filtering; local derivation only limits counts.
  const suggestedQueryKey = useMemo(
    () => ['discover-suggested-people', viewerId ?? 'guest'],
    [viewerId]
  );
  const {
    data: suggestedData,
    isPending: suggestedPending,
    isError: suggestedIsError,
    refetch: refetchSuggested,
  } = useQuery({
    queryKey: suggestedQueryKey,
    enabled: interactionsDone && isSignedIn,
    queryFn: async () => {
      const res: any = await User.suggested(20);
      const items = Array.isArray(res) ? res : Array.isArray(res?.items) ? res.items : [];
      return items.filter((u: any) => {
        const name = u?.display_name || u?.username;
        return name && !isInternalId(name);
      });
    },
  });
  const nearbyPeople = useMemo(() => (suggestedData ?? []).slice(0, 20), [suggestedData]);
  const suggestedPeople = useMemo(() => (suggestedData ?? []).slice(0, 10), [suggestedData]);
  const patchSuggestedPeople = useCallback(
    (mapPeople: (people: any[]) => any[]) => {
      queryClient.setQueryData(suggestedQueryKey, (old: any) => (old ? mapPeople(old) : old));
    },
    [queryClient, suggestedQueryKey]
  );

  // Games are the primary list and render as soon as they are ready. Optional
  // requests expose their own progress below instead of blocking the list.
  const loading = gamesPending;

  const refreshAll = useCallback(async () => {
    // refetch() resolves (never throws); failed refreshes keep cached data.
    await Promise.all([
      refetchGames(),
      refetchPersonalization(),
      ...(isSignedIn ? [refetchSuggested()] : []),
      ...(isSignedIn ? [refetchFollowingCalendar()] : []),
    ]);
  }, [
    isSignedIn,
    refetchGames,
    refetchFollowingCalendar,
    refetchPersonalization,
    refetchSuggested,
  ]);

  // Debounced unified search (users, teams, organizations, games, events)
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed || trimmed.length < 2) {
      setUnifiedSearchResults(null);
      return;
    }
    let mounted = true;
    const t = setTimeout(async () => {
      setUnifiedSearchLoading(true);
      try {
        const res = await Search.unified(trimmed, 10);
        if (!mounted) return;
        const games = res?.games ?? [];
        const gameIds = new Set(games.map((g: any) => String(g?.id)));
        // A game-linked event duplicates its game's row — show the fixture once.
        const events = (res?.events ?? []).filter(
          (e: any) => !e?.game_id || !gameIds.has(String(e.game_id))
        );
        setUnifiedSearchResults({
          users: res?.users ?? [],
          teams: res?.teams ?? [],
          organizations: res?.organizations ?? [],
          games,
          events,
        });
        saveRecentSearch(trimmed);
        analytics.track(ANALYTICS_EVENTS.SEARCH_PERFORMED, { query: trimmed });
      } catch {
        if (!mounted) return;
        setUnifiedSearchResults({ users: [], teams: [], organizations: [], games: [], events: [] });
      } finally {
        if (mounted) setUnifiedSearchLoading(false);
      }
    }, 200);
    return () => {
      mounted = false;
      clearTimeout(t);
    };
  }, [query, saveRecentSearch]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshAll();
    } finally {
      setRefreshing(false);
    }
  }, [refreshAll]);

  const handleManageOrg = useCallback(async () => {
    if (quickActionBusy) return;
    setQuickActionBusy('org');
    analytics.track(ANALYTICS_EVENTS.COACH_QUICK_ACTION_TAPPED, { action: 'manage_org' });
    try {
      const summaries = await Organization.reviewSummaries();
      const list = Array.isArray(summaries) ? summaries : [];
      const firstOrgId = list[0]?.organization?.id;
      if (firstOrgId) {
        analytics.track(ANALYTICS_EVENTS.COACH_QUICK_ACTION_TAPPED, {
          action: 'manage_org',
          outcome: 'navigated',
        });
        router.push({
          pathname: '/organization',
          params: {
            id: firstOrgId,
            from: 'discover-quick-actions',
          },
        } as any);
      } else {
        // No owner/manager org from review summaries. The user may still be
        // linked to an org as a non-admin member (e.g. a coach whose org
        // membership role is `coach`/`member`). Send them to view their org
        // rather than falsely claiming they have none. Only alert when there
        // is genuinely no org link at all.
        const orgId = getCanonicalOrganizationId((me ?? user) as any);
        if (orgId) {
          analytics.track(ANALYTICS_EVENTS.COACH_QUICK_ACTION_TAPPED, {
            action: 'manage_org',
            outcome: 'navigated_fallback',
          });
          router.push({
            pathname: '/organization',
            params: {
              id: orgId,
              from: 'discover-quick-actions',
            },
          } as any);
        } else {
          analytics.track(ANALYTICS_EVENTS.COACH_QUICK_ACTION_TAPPED, {
            action: 'manage_org',
            outcome: 'no_org',
          });
          Alert.alert('No Organization', 'You are not linked to any organization yet.');
        }
      }
    } catch (err: any) {
      analytics.track(ANALYTICS_EVENTS.COACH_QUICK_ACTION_TAPPED, {
        action: 'manage_org',
        outcome: 'error',
      });
      captureException(err instanceof Error ? err : new Error(String(err?.message || err)), {
        tags: { context: 'discover_manage_org' },
      });
      Alert.alert('Error', 'Could not load your organization.');
    } finally {
      setQuickActionBusy(null);
    }
  }, [me, user, router, quickActionBusy]);

  const handleTeamSchedule = useCallback(async () => {
    if (quickActionBusy) return;
    setQuickActionBusy('schedule');
    analytics.track(ANALYTICS_EVENTS.COACH_QUICK_ACTION_TAPPED, { action: 'team_schedule' });
    try {
      const teams = await Team.managed();
      const arr = Array.isArray(teams)
        ? teams
        : Array.isArray((teams as any)?.items)
          ? (teams as any).items
          : [];
      if (arr.length === 1) {
        analytics.track(ANALYTICS_EVENTS.COACH_QUICK_ACTION_TAPPED, {
          action: 'team_schedule',
          outcome: 'navigated',
        });
        router.push({
          pathname: '/manage-season',
          params: {
            teamId: String(arr[0].id),
            from: 'discover-quick-actions',
          },
        } as any);
      } else if (arr.length > 1) {
        analytics.track(ANALYTICS_EVENTS.COACH_QUICK_ACTION_TAPPED, {
          action: 'team_schedule',
          outcome: 'navigated_picker',
        });
        router.push({
          pathname: '/manage-season',
          params: {
            from: 'discover-quick-actions',
          },
        } as any);
      } else {
        analytics.track(ANALYTICS_EVENTS.COACH_QUICK_ACTION_TAPPED, {
          action: 'team_schedule',
          outcome: 'no_teams',
        });
        Alert.alert('No Teams', 'Create a team first to manage your schedule.', [
          {
            text: 'Create Team',
            onPress: () =>
              router.push({
                pathname: '/create-team',
                params: {
                  fallback: '/(tabs)/discover',
                },
              } as any),
          },
          { text: 'Close', style: 'cancel' },
        ]);
      }
    } catch (err: any) {
      analytics.track(ANALYTICS_EVENTS.COACH_QUICK_ACTION_TAPPED, {
        action: 'team_schedule',
        outcome: 'error',
      });
      captureException(err instanceof Error ? err : new Error(String(err?.message || err)), {
        tags: { context: 'discover_team_schedule' },
      });
      Alert.alert('Error', 'Could not load teams. Please try again.');
    } finally {
      setQuickActionBusy(null);
    }
  }, [router, quickActionBusy]);

  const handleQuickGameSave = useCallback(
    async (data: QuickGameData) => {
      if (isCreatingGame) return; // Prevent duplicate submissions
      setIsCreatingGame(true);
      try {
        // Validate date format
        if (!data.date || !/^\d{4}-\d{2}-\d{2}$/.test(data.date)) {
          throw new Error('Invalid date format. Please use YYYY-MM-DD format.');
        }

        // Parse date and time
        const [year, month, day] = data.date.split('-').map(Number);

        // Validate date values
        if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
          throw new Error('Invalid date values.');
        }
        if (month < 1 || month > 12 || day < 1 || day > 31) {
          throw new Error('Invalid date values. Month must be 1-12, day must be 1-31.');
        }

        // Parse time with more flexible regex
        const timeParts = data.time.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
        if (!timeParts) {
          throw new Error('Invalid time format. Please use HH:MM AM/PM format.');
        }

        let hours = parseInt(timeParts[1], 10);
        const minutes = parseInt(timeParts[2], 10);
        const isPM = timeParts[3].toUpperCase() === 'PM';

        // Validate time values
        if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
          throw new Error('Invalid time values.');
        }
        if (hours < 1 || hours > 12 || minutes < 0 || minutes > 59) {
          throw new Error('Invalid time values. Hours must be 1-12, minutes must be 0-59.');
        }

        // Convert to 24-hour format
        if (isPM && hours !== 12) hours += 12;
        if (!isPM && hours === 12) hours = 0;

        const gameDateTime = new Date(Date.UTC(year, month - 1, day, hours, minutes));

        // Validate resulting date
        if (isNaN(gameDateTime.getTime())) {
          throw new Error('Invalid date. Please check the date and time values.');
        }

        // Check if date is in the past
        if (gameDateTime < new Date()) {
          throw new Error(
            'Cannot create events in the past. Please select a future date and time.'
          );
        }

        // Create game payload. For non-competitive events `data.currentTeam`
        // carries the user-entered event title (buildQuickGameData) — use it
        // verbatim; every event is one-of-one, never "<title> Event".
        const gamePayload: Record<string, any> = {
          title: data.isCompetitive ? `${data.currentTeam} vs ${data.opponent}` : data.currentTeam,
          date: gameDateTime.toISOString(),
          description:
            data.description ||
            (data.isCompetitive
              ? `${data.type === 'home' ? 'Home' : 'Away'} game: ${data.currentTeam} vs ${data.opponent}`
              : data.currentTeam),
        };

        // Only add team fields if this is a competitive game
        if (data.isCompetitive) {
          gamePayload.home_team = data.type === 'home' ? data.currentTeam : data.opponent;
          gamePayload.away_team = data.type === 'home' ? data.opponent : data.currentTeam;

          if (data.currentTeamId)
            gamePayload.home_team_id = data.type === 'home' ? data.currentTeamId : null;
          if (data.opponentTeamId) {
            gamePayload.away_team_id =
              data.type === 'home' ? data.opponentTeamId : data.currentTeamId;
          } else if (data.opponent) {
            gamePayload.away_team_name = data.opponent;
          }
        } else {
          // For non-competitive events, still send home_team_id for approval workflow
          if (data.currentTeamId) {
            gamePayload.home_team_id = data.currentTeamId;
          }
        }

        // Add expected attendance if provided
        if (data.expectedAttendance) {
          gamePayload.expected_attendance = data.expectedAttendance;
        }

        // Add event type
        if (data.eventType) {
          gamePayload.event_type = data.eventType;
        }

        // Add event type-specific fields
        if (data.donationGoal) {
          gamePayload.donation_goal = data.donationGoal;
        }
        if (data.watchLocation) {
          gamePayload.watch_location = data.watchLocation;
          if (data.watchLocationLat) gamePayload.watch_location_lat = data.watchLocationLat;
          if (data.watchLocationLng) gamePayload.watch_location_lng = data.watchLocationLng;
          if (data.watchLocationPlaceId)
            gamePayload.watch_location_place_id = data.watchLocationPlaceId;
        }
        if (data.destination) {
          gamePayload.destination = data.destination;
        }

        if (data.banner_url) {
          gamePayload.banner_url = data.banner_url;
          gamePayload.cover_image_url = data.banner_url;
        } else if (data.cover_image_url) {
          gamePayload.cover_image_url = data.cover_image_url;
        }

        if (data.appearance) {
          gamePayload.appearance = data.appearance;
        }

        // Validate required fields before API call
        if (!gamePayload.title || gamePayload.title.trim().length === 0) {
          throw new Error('Event title is required.');
        }
        if (!gamePayload.date) {
          throw new Error('Event date is required.');
        }

        // Create game using the API
        await Game.create(gamePayload);

        setCreateEventModalOpen(false);

        // Refresh the games list
        await refetchGames();

        // Show success message - use native alert
        if (typeof alert !== 'undefined') {
          alert(data.isCompetitive ? 'Game added successfully!' : 'Event added successfully!');
        }
      } catch (error: any) {
        if (__DEV__) console.error('Error adding quick game:', error);
        if (!handleCoachAccessError(router, error, 'creating games', user as any)) {
          captureException(
            error instanceof Error ? error : new Error(String(error?.message || error)),
            {
              tags: { context: 'quick_game_save' },
            }
          );
          const errorMessage = toUserMessage(error, 'Failed to add event.');
          Alert.alert('Error', errorMessage);
        }
      } finally {
        setIsCreatingGame(false);
      }
    },
    [refetchGames, isCreatingGame, router, user]
  );

  const filtered = useMemo(() => {
    if (!query) return games;

    // Sanitize and limit query length
    const q = query.trim().slice(0, 100).toLowerCase();
    if (q.length === 0) return games;

    // Check for zip code (5 digits, optionally with dash and 4 more digits)
    const zipMatch = q.match(/\b\d{5}(?:-\d{4})?\b/);
    if (zipMatch) {
      const zip = zipMatch[0].replace(/[-\s]/g, '').slice(0, 5);
      return games.filter(g => {
        const location =
          `${g.location || ''} ${(g as any)?.address || ''} ${(g as any)?.city || ''}`.toLowerCase();
        // Extract zip codes from location and check if any match
        const locationZips = location.match(/\b\d{5}(?:-\d{4})?\b/g);
        return (
          locationZips?.some(lz => lz.replace(/[-\s]/g, '').startsWith(zip)) ||
          location.includes(zip)
        );
      });
    }

    // Regular keyword search
    return games.filter(g => {
      const title = (g.title || '').toLowerCase();
      const location = (g.location || '').toLowerCase();
      return title.includes(q) || location.includes(q);
    });
  }, [games, query]);

  const zipSuggestions = useMemo(() => {
    if (!zipSuggestionsOpen) return [] as ZipDirectoryEntry[];
    const digits = query.replace(/[^0-9]/g, '');
    if (digits.length < 2) return [] as ZipDirectoryEntry[];
    return zipDirectory.filter(entry => entry.zip.startsWith(digits)).slice(0, 6);
  }, [zipSuggestionsOpen, query, zipDirectory]);

  const shouldShowZipSuggestions = zipSuggestionsOpen && zipSuggestions.length > 0;

  const handleToggleViewMode = useCallback(async () => {
    const newMode: typeof viewMode = viewMode === 'list' ? 'map' : 'list';
    if (newMode === 'map') {
      if (!permissionGranted) {
        const granted = await requestPermission();
        if (!granted) {
          Alert.alert(
            'Location Permission',
            'Enable location to view the map and see nearby events.',
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Open Settings', onPress: () => openSettings() },
            ]
          );
          return;
        }
      }
      if (Platform.OS === 'android' && needsPreciseAccuracy) {
        Alert.alert(
          'Enable Precise Location',
          'Map view needs precise location to show you accurate distances.',
          [
            { text: 'Not now', style: 'cancel', onPress: () => {} },
            {
              text: 'Open settings',
              onPress: () => {
                setPrecisionBannerDismissed(true);
                void openSettings();
              },
            },
          ]
        );
        return;
      }
    }
    setViewMode(newMode);
  }, [viewMode, permissionGranted, requestPermission, needsPreciseAccuracy, openSettings]);

  const markedCalendarDates = useMemo(
    () =>
      buildDiscoverMarkedDates(
        calendarGames,
        calendarEvents,
        selectedDate,
        Colors[colorScheme].tint
      ),
    [calendarEvents, calendarGames, colorScheme, selectedDate]
  );

  const onCalendarDayPress = useCallback((day: DateData) => {
    setSelectedDate(current => (current === day.dateString ? '' : day.dateString));
  }, []);

  const getSelectedDateGames = useCallback(() => {
    if (!selectedDate) return [];
    return calendarGames.filter(game => {
      if (!game.date) return false;
      const d = new Date(game.date);
      return !isNaN(d.getTime()) && d.toISOString().split('T')[0] === selectedDate;
    });
  }, [calendarGames, selectedDate]);

  const getSelectedDateEvents = useCallback(() => {
    if (!selectedDate) return [];
    return calendarEvents.filter(event => {
      if (!event.date) return false;
      const d = new Date(event.date);
      return !isNaN(d.getTime()) && d.toISOString().split('T')[0] === selectedDate;
    });
  }, [calendarEvents, selectedDate]);

  const renderCalendar = () => (
    <View
      style={[
        styles.calendarSection,
        {
          backgroundColor: colorScheme === 'light' ? '#FFFFFF' : Colors[colorScheme].background,
          borderColor: colorScheme === 'light' ? '#E5E7EB' : Colors[colorScheme].border,
        },
      ]}
    >
      <Calendar
        onDayPress={onCalendarDayPress}
        markedDates={markedCalendarDates}
        // enableSwipeMonths removed: its horizontal pan responder sits inside
        // the Discover screen's single scrollable FlatList (ListHeaderComponent)
        // and can end up holding the touch responder chain, leaving the outer
        // list unable to scroll back up until the user backs out of the screen.
        // Month navigation still works via the header arrows.
        theme={
          {
            backgroundColor: colorScheme === 'light' ? '#FFFFFF' : Colors[colorScheme].background,
            calendarBackground:
              colorScheme === 'light' ? '#FFFFFF' : Colors[colorScheme].background,
            textSectionTitleColor: Colors[colorScheme].mutedText,
            selectedDayBackgroundColor: Colors[colorScheme].tint,
            selectedDayTextColor: '#FFFFFF',
            todayTextColor: Colors[colorScheme].tint,
            dayTextColor: Colors[colorScheme].text,
            textDisabledColor: colorScheme === 'light' ? '#9CA3AF' : Colors[colorScheme].mutedText,
            monthTextColor: Colors[colorScheme].text,
            textMonthFontWeight: '700',
            arrowColor: Colors[colorScheme].text,
            textDayFontFamily: 'system',
            textMonthFontFamily: 'system',
            textDayHeaderFontFamily: 'system',
            textDayFontSize: 14,
            textMonthFontSize: 16,
            textDayHeaderFontSize: 13,
          } as any
        }
      />
    </View>
  );

  const ListHeader = (
    <View>
      {showPrecisionBanner ? (
        <View
          style={[
            styles.precisionBanner,
            {
              backgroundColor: colorScheme === 'dark' ? 'rgba(245,158,11,0.12)' : '#FEF9C3',
              borderColor: colorScheme === 'dark' ? 'rgba(245,158,11,0.35)' : '#FACC15',
            },
          ]}
        >
          <MaterialIcons name="near-me" size={18} color="#B45309" />
          <View style={{ flex: 1 }}>
            <Text
              style={[
                styles.precisionBannerText,
                { color: colorScheme === 'dark' ? '#FDE68A' : '#92400E' },
              ]}
            >
              Precise location is off. Nearby recommendations will be less accurate on Android.
            </Text>
            <View style={styles.precisionActions}>
              <Pressable
                onPress={() => setPrecisionBannerDismissed(true)}
                accessibilityRole="button"
                accessibilityLabel="Dismiss precision location banner"
              >
                <Text
                  style={[
                    styles.precisionActionLink,
                    { color: colorScheme === 'dark' ? '#FDE68A' : '#92400E' },
                  ]}
                >
                  Dismiss
                </Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  setPrecisionBannerDismissed(true);
                  void openSettings();
                }}
                accessibilityRole="button"
                accessibilityLabel="Open location settings"
              >
                <Text
                  style={[
                    styles.precisionActionLink,
                    { color: Colors[colorScheme].tint, fontWeight: '700' },
                  ]}
                >
                  Open settings
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}
      {/* Search Bar - At the very top */}
      <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
        <View
          style={[
            styles.searchBox,
            {
              flex: 1,
              backgroundColor: Colors[colorScheme].surface,
              borderColor: Colors[colorScheme].border,
            },
          ]}
        >
          <MaterialIcons name="search" size={20} color={Colors[colorScheme].mutedText} />
          <TextInput
            placeholder="Search people, teams, organizations, games, events, or zip..."
            placeholderTextColor={Colors[colorScheme].mutedText}
            value={query}
            onChangeText={v => {
              setQuery(v);
              const digits = v.replace(/[^0-9]/g, '');
              setZipSuggestionsOpen(digits.length >= 2);
            }}
            style={[styles.searchInput, { color: Colors[colorScheme].text }]}
            returnKeyType="search"
            onBlur={() => setZipSuggestionsOpen(false)}
            accessibilityLabel="Search people, teams, organizations, games, events, or zip code"
          />
        </View>

        {/* Map/List Toggle */}
        <Pressable
          onPress={() => {
            void handleToggleViewMode();
          }}
          style={[
            styles.viewToggle,
            {
              backgroundColor: Colors[colorScheme].surface,
              borderColor: Colors[colorScheme].border,
            },
          ]}
          accessibilityRole="button"
          accessibilityLabel={viewMode === 'list' ? 'Switch to map view' : 'Switch to list view'}
        >
          <MaterialIcons
            name={viewMode === 'list' ? 'map' : 'list'}
            size={24}
            color={Colors[colorScheme].tint}
          />
        </Pressable>
      </View>

      {shouldShowZipSuggestions ? (
        <View
          style={[
            styles.zipSuggestionList,
            { backgroundColor: Colors[colorScheme].card, borderColor: Colors[colorScheme].border },
          ]}
        >
          {zipSuggestions.map(entry => (
            <Pressable
              key={entry.zip}
              style={styles.zipSuggestionItem}
              onPress={() => {
                setQuery(entry.zip);
                setZipSuggestionsOpen(false);
              }}
              accessibilityRole="button"
              accessibilityLabel={`Search zip code ${entry.zip}, ${entry.count} ${entry.count === 1 ? 'game' : 'games'}`}
            >
              <Text style={[styles.zipSuggestionZip, { color: Colors[colorScheme].text }]}>
                {entry.zip}
              </Text>
              <Text style={[styles.zipSuggestionCount, { color: Colors[colorScheme].mutedText }]}>
                {entry.count === 1 ? '1 game' : `${entry.count} games`}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      {/* Recent searches - shown when query is empty */}
      {!query.trim() && recentSearches.length > 0 && !unifiedSearchResults && (
        <View
          style={[
            styles.unifiedSearchResults,
            { backgroundColor: Colors[colorScheme].card, borderColor: Colors[colorScheme].border },
          ]}
        >
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
              paddingHorizontal: 12,
              paddingTop: 8,
            }}
          >
            <Text style={[styles.searchSectionTitle, { color: Colors[colorScheme].mutedText }]}>
              Recent Searches
            </Text>
            <Pressable
              onPress={() => {
                setRecentSearches([]);
                void AsyncStorage.removeItem('vh_recent_searches').catch(error => {
                  reportDiscoverFailure('clear_recent_searches', error);
                });
              }}
            >
              <Text style={{ color: Colors[colorScheme].tint, fontSize: 13, fontWeight: '600' }}>
                Clear
              </Text>
            </Pressable>
          </View>
          {recentSearches.map((term, idx) => (
            <Pressable
              key={`${term}-${idx}`}
              style={[styles.searchResultRow, { borderBottomColor: Colors[colorScheme].border }]}
              onPress={() => setQuery(term)}
            >
              <MaterialIcons name="history" size={18} color={Colors[colorScheme].mutedText} />
              <Text
                style={[
                  styles.searchResultName,
                  { color: Colors[colorScheme].text, marginLeft: 8 },
                ]}
              >
                {term}
              </Text>
            </Pressable>
          ))}
        </View>
      )}

      {/* Unified search results - People, Teams, Organizations, Games, Events */}
      {unifiedSearchLoading ? (
        <View style={{ paddingVertical: 24, alignItems: 'center' }}>
          <ActivityIndicator size="small" color={Colors[colorScheme].tint} />
        </View>
      ) : unifiedSearchResults ? (
        <ScrollView
          style={[
            styles.unifiedSearchResults,
            { backgroundColor: Colors[colorScheme].card, borderColor: Colors[colorScheme].border },
          ]}
          nestedScrollEnabled
          keyboardShouldPersistTaps="handled"
        >
          {unifiedSearchResults.users.length > 0 ? (
            <View style={styles.searchSection}>
              <Text style={[styles.searchSectionTitle, { color: Colors[colorScheme].mutedText }]}>
                People
              </Text>
              {unifiedSearchResults.users.map(u => (
                <Pressable
                  key={u.id}
                  style={[
                    styles.searchResultRow,
                    { borderBottomColor: Colors[colorScheme].border },
                  ]}
                  onPress={() => {
                    setQuery('');
                    setUnifiedSearchResults(null);
                    void router.push(`/user-profile?id=${u.id}`);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`View profile of ${safeDisplayName(u)}`}
                >
                  <View style={styles.searchResultLeft}>
                    {u.avatar_url ? (
                      <Image
                        source={{ uri: optimizeImageUrl(u.avatar_url, 120) }}
                        style={styles.searchResultAvatar}
                        contentFit="cover"
                      />
                    ) : (
                      <LinearGradient
                        colors={['#1E1E1E', '#121212']}
                        style={styles.searchResultAvatar}
                      />
                    )}
                    <View>
                      <Text
                        style={[styles.searchResultName, { color: Colors[colorScheme].text }]}
                        numberOfLines={1}
                      >
                        {safeDisplayName(u)}
                      </Text>
                      {safeUsername(u) ? (
                        <Text
                          style={[styles.searchResultSub, { color: Colors[colorScheme].mutedText }]}
                          numberOfLines={1}
                        >
                          @{safeUsername(u)}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                  {me?.id !== u.id ? (
                    <Pressable
                      onPress={async e => {
                        e.stopPropagation();
                        if (!user) {
                          promptForSignIn(() => router.push('/sign-in'), {
                            message: 'Sign in to follow.',
                          });
                          return;
                        }
                        const next = !u.is_following;
                        setUnifiedSearchResults(prev =>
                          prev
                            ? {
                                ...prev,
                                users: prev.users.map(x =>
                                  x.id === u.id ? { ...x, is_following: next } : x
                                ),
                              }
                            : null
                        );
                        try {
                          if (next) await User.follow(u.id);
                          else await User.unfollow(u.id);
                        } catch {
                          setUnifiedSearchResults(prev =>
                            prev
                              ? {
                                  ...prev,
                                  users: prev.users.map(x =>
                                    x.id === u.id ? { ...x, is_following: !next } : x
                                  ),
                                }
                              : null
                          );
                        }
                      }}
                      style={[
                        styles.searchFollowBtn,
                        {
                          backgroundColor: u.is_following
                            ? Colors[colorScheme].border
                            : Colors[colorScheme].tint,
                        },
                      ]}
                      accessibilityRole="button"
                      accessibilityLabel={
                        u.is_following
                          ? `Unfollow ${safeDisplayName(u)}`
                          : `Follow ${safeDisplayName(u)}`
                      }
                    >
                      <Text
                        style={[
                          styles.searchFollowBtnText,
                          {
                            color: u.is_following
                              ? Colors[colorScheme].text
                              : Colors[colorScheme].background,
                          },
                        ]}
                      >
                        {u.is_following ? 'Following' : 'Follow'}
                      </Text>
                    </Pressable>
                  ) : null}
                </Pressable>
              ))}
            </View>
          ) : null}
          {unifiedSearchResults.teams.length > 0 ? (
            <View style={styles.searchSection}>
              <Text style={[styles.searchSectionTitle, { color: Colors[colorScheme].mutedText }]}>
                Teams
              </Text>
              {unifiedSearchResults.teams.map(t => (
                <Pressable
                  key={t.id}
                  style={[
                    styles.searchResultRow,
                    { borderBottomColor: Colors[colorScheme].border },
                  ]}
                  onPress={() => {
                    setQuery('');
                    setUnifiedSearchResults(null);
                    void router.push(`/team-page?id=${t.id}`);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`View team ${t.name}`}
                >
                  <View style={styles.searchResultLeft}>
                    {t.logo_url || t.avatar_url ? (
                      <Image
                        source={{ uri: optimizeImageUrl(t.logo_url || t.avatar_url, 120) }}
                        style={styles.searchResultAvatar}
                        contentFit="cover"
                      />
                    ) : (
                      <LinearGradient
                        colors={['#1E1E1E', '#121212']}
                        style={styles.searchResultAvatar}
                      />
                    )}
                    <View>
                      <Text
                        style={[styles.searchResultName, { color: Colors[colorScheme].text }]}
                        numberOfLines={1}
                      >
                        {t.name}
                      </Text>
                      <Text
                        style={[styles.searchResultSub, { color: Colors[colorScheme].mutedText }]}
                        numberOfLines={1}
                      >
                        {t.sport
                          ? `${t.sport} • ${t.members || 0} members`
                          : `${t.members || 0} members`}
                      </Text>
                    </View>
                  </View>
                  <Pressable
                    onPress={async e => {
                      e.stopPropagation();
                      if (!user) {
                        promptForSignIn(() => router.push('/sign-in'), {
                          message: 'Sign in to follow.',
                        });
                        return;
                      }
                      const next = !t.is_following;
                      setUnifiedSearchResults(prev =>
                        prev
                          ? {
                              ...prev,
                              teams: prev.teams.map(x =>
                                x.id === t.id ? { ...x, is_following: next } : x
                              ),
                            }
                          : null
                      );
                      try {
                        if (next) await Team.follow(t.id);
                        else await Team.unfollow(t.id);
                        void queryClient.invalidateQueries({
                          queryKey: ['discover-following-calendar', user?.id ?? 'guest'],
                        });
                        void queryClient.invalidateQueries({
                          queryKey: ['discover-games', user?.id ?? 'guest'],
                        });
                      } catch {
                        setUnifiedSearchResults(prev =>
                          prev
                            ? {
                                ...prev,
                                teams: prev.teams.map(x =>
                                  x.id === t.id ? { ...x, is_following: !next } : x
                                ),
                              }
                            : null
                        );
                      }
                    }}
                    style={[
                      styles.searchFollowBtn,
                      {
                        backgroundColor: t.is_following
                          ? Colors[colorScheme].border
                          : Colors[colorScheme].tint,
                      },
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={
                      t.is_following ? `Unfollow team ${t.name}` : `Follow team ${t.name}`
                    }
                  >
                    <Text
                      style={[
                        styles.searchFollowBtnText,
                        {
                          color: t.is_following
                            ? Colors[colorScheme].text
                            : Colors[colorScheme].background,
                        },
                      ]}
                    >
                      {t.is_following ? 'Following' : 'Follow'}
                    </Text>
                  </Pressable>
                </Pressable>
              ))}
            </View>
          ) : null}
          {unifiedSearchResults.organizations.length > 0 ? (
            <View style={styles.searchSection}>
              <Text style={[styles.searchSectionTitle, { color: Colors[colorScheme].mutedText }]}>
                Organizations
              </Text>
              {unifiedSearchResults.organizations.map(o => (
                <Pressable
                  key={o.id}
                  style={[
                    styles.searchResultRow,
                    { borderBottomColor: Colors[colorScheme].border },
                  ]}
                  onPress={() => {
                    setQuery('');
                    setUnifiedSearchResults(null);
                    // Route to the full organization screen (handles public
                    // viewers correctly), not the sparse /organizations/[id] stub.
                    void router.push({
                      pathname: '/organization',
                      params: { id: String(o.id) },
                    } as any);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`View organization ${o.name}`}
                >
                  <View style={styles.searchResultLeft}>
                    <LinearGradient
                      colors={['#1E1E1E', '#121212']}
                      style={[styles.searchResultAvatar, { borderRadius: 8 }]}
                    />
                    <View>
                      <Text
                        style={[styles.searchResultName, { color: Colors[colorScheme].text }]}
                        numberOfLines={1}
                      >
                        {o.name}
                      </Text>
                      <Text
                        style={[styles.searchResultSub, { color: Colors[colorScheme].mutedText }]}
                        numberOfLines={1}
                      >
                        {o.sport
                          ? `${o.sport} • ${o.members || 0} members`
                          : `${o.members || 0} members`}
                      </Text>
                    </View>
                  </View>
                  <Pressable
                    onPress={async e => {
                      e.stopPropagation();
                      if (!user) {
                        promptForSignIn(() => router.push('/sign-in'), {
                          message: 'Sign in to follow.',
                        });
                        return;
                      }
                      const next = !o.is_following;
                      setUnifiedSearchResults(prev =>
                        prev
                          ? {
                              ...prev,
                              organizations: prev.organizations.map(x =>
                                x.id === o.id ? { ...x, is_following: next } : x
                              ),
                            }
                          : null
                      );
                      try {
                        if (next) await Organization.follow(o.id);
                        else await Organization.unfollow(o.id);
                      } catch {
                        setUnifiedSearchResults(prev =>
                          prev
                            ? {
                                ...prev,
                                organizations: prev.organizations.map(x =>
                                  x.id === o.id ? { ...x, is_following: !next } : x
                                ),
                              }
                            : null
                        );
                      }
                    }}
                    style={[
                      styles.searchFollowBtn,
                      {
                        backgroundColor: o.is_following
                          ? Colors[colorScheme].border
                          : Colors[colorScheme].tint,
                      },
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel={
                      o.is_following
                        ? `Unfollow organization ${o.name}`
                        : `Follow organization ${o.name}`
                    }
                  >
                    <Text
                      style={[
                        styles.searchFollowBtnText,
                        {
                          color: o.is_following
                            ? Colors[colorScheme].text
                            : Colors[colorScheme].background,
                        },
                      ]}
                    >
                      {o.is_following ? 'Following' : 'Follow'}
                    </Text>
                  </Pressable>
                </Pressable>
              ))}
            </View>
          ) : null}
          {unifiedSearchResults.games.length > 0 ? (
            <View style={styles.searchSection}>
              <Text style={[styles.searchSectionTitle, { color: Colors[colorScheme].mutedText }]}>
                Games
              </Text>
              {unifiedSearchResults.games.map(game => (
                <Pressable
                  key={game.id}
                  style={[
                    styles.searchResultRow,
                    { borderBottomColor: Colors[colorScheme].border },
                  ]}
                  onPress={() => {
                    setQuery('');
                    setUnifiedSearchResults(null);
                    void router.push({ pathname: '/game/[id]', params: { id: String(game.id) } });
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`View game ${game.title}`}
                >
                  <View style={styles.searchResultLeft}>
                    {game.banner_url ? (
                      <Image
                        source={{ uri: optimizeImageUrl(game.banner_url, 120) }}
                        style={[styles.searchResultAvatar, { borderRadius: 8 }]}
                        contentFit="cover"
                      />
                    ) : (
                      <LinearGradient
                        colors={['#1E1E1E', '#121212']}
                        style={[styles.searchResultAvatar, { borderRadius: 8 }]}
                      />
                    )}
                    <View>
                      <Text
                        style={[styles.searchResultName, { color: Colors[colorScheme].text }]}
                        numberOfLines={1}
                      >
                        {game.title}
                      </Text>
                      <Text
                        style={[styles.searchResultSub, { color: Colors[colorScheme].mutedText }]}
                        numberOfLines={1}
                      >
                        {[
                          game.location,
                          game.date ? new Date(game.date).toLocaleDateString() : null,
                        ]
                          .filter(Boolean)
                          .join(' • ')}
                      </Text>
                    </View>
                  </View>
                </Pressable>
              ))}
            </View>
          ) : null}
          {unifiedSearchResults.events.length > 0 ? (
            <View style={styles.searchSection}>
              <Text style={[styles.searchSectionTitle, { color: Colors[colorScheme].mutedText }]}>
                Events
              </Text>
              {unifiedSearchResults.events.map(event => (
                <Pressable
                  key={event.id}
                  style={[
                    styles.searchResultRow,
                    { borderBottomColor: Colors[colorScheme].border },
                  ]}
                  onPress={() => {
                    setQuery('');
                    setUnifiedSearchResults(null);
                    void router.push(buildEventDetailRoute(event.id, event.game_id));
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`View event ${event.title}`}
                >
                  <View style={styles.searchResultLeft}>
                    {event.banner_url ? (
                      <Image
                        source={{ uri: optimizeImageUrl(event.banner_url, 120) }}
                        style={[styles.searchResultAvatar, { borderRadius: 8 }]}
                        contentFit="cover"
                      />
                    ) : (
                      <LinearGradient
                        colors={['#1E1E1E', '#121212']}
                        style={[styles.searchResultAvatar, { borderRadius: 8 }]}
                      />
                    )}
                    <View>
                      <Text
                        style={[styles.searchResultName, { color: Colors[colorScheme].text }]}
                        numberOfLines={1}
                      >
                        {event.title}
                      </Text>
                      <Text
                        style={[styles.searchResultSub, { color: Colors[colorScheme].mutedText }]}
                        numberOfLines={1}
                      >
                        {[
                          event.location,
                          event.date ? new Date(event.date).toLocaleDateString() : null,
                        ]
                          .filter(Boolean)
                          .join(' • ')}
                      </Text>
                    </View>
                  </View>
                </Pressable>
              ))}
            </View>
          ) : null}
          {unifiedSearchResults.users.length === 0 &&
          unifiedSearchResults.teams.length === 0 &&
          unifiedSearchResults.organizations.length === 0 &&
          unifiedSearchResults.games.length === 0 &&
          unifiedSearchResults.events.length === 0 ? (
            <View style={{ alignItems: 'center', paddingVertical: 24 }}>
              <MaterialIcons name="search-off" size={40} color={Colors[colorScheme].mutedText} />
              <Text
                style={{
                  color: Colors[colorScheme].text,
                  fontSize: 16,
                  fontWeight: '600',
                  marginTop: 10,
                }}
              >
                No results found
              </Text>
              <Text
                style={{
                  color: Colors[colorScheme].mutedText,
                  fontSize: 14,
                  marginTop: 4,
                  textAlign: 'center',
                }}
              >
                No matches for "{query.trim()}". Try a different search.
              </Text>
            </View>
          ) : null}
        </ScrollView>
      ) : null}

      {/* Calendar - Right below search */}
      {renderCalendar()}

      {isSignedIn && followingCalendarPending && followingCalendarData === undefined ? (
        <Text style={[styles.helper, { color: Colors[colorScheme].mutedText }]}>
          Loading calendar…
        </Text>
      ) : null}

      {isSignedIn && followingCalendarIsError ? (
        <View style={styles.optionalStatusRow}>
          <Text style={[styles.helper, { color: Colors[colorScheme].mutedText, flex: 1 }]}>
            {followingCalendarData === undefined
              ? 'Your followed calendar is temporarily unavailable.'
              : 'Could not refresh your calendar. Showing saved events.'}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry followed calendar"
            onPress={() => void refetchFollowingCalendar()}
            style={styles.inlineRetryButton}
          >
            <Text style={styles.inlineRetryText}>Retry</Text>
          </Pressable>
        </View>
      ) : null}

      {calendarGames.length === 0 &&
      calendarEvents.length === 0 &&
      (!isSignedIn || (!followingCalendarPending && !followingCalendarIsError)) ? (
        <Text style={[styles.helper, { color: Colors[colorScheme].mutedText }]}>
          You&apos;re not following any teams yet — search above to find and follow teams, and their
          games and events show up here.
        </Text>
      ) : null}

      {/* Games on Selected Date */}
      {selectedDate &&
        (() => {
          const gamesOnDate = getSelectedDateGames();
          const eventsOnDate = getSelectedDateEvents();

          if (gamesOnDate.length === 0 && eventsOnDate.length === 0) return null;

          return (
            <View
              style={[
                styles.selectedDateSection,
                {
                  backgroundColor: Colors[colorScheme].surface,
                  borderColor: Colors[colorScheme].border,
                },
              ]}
            >
              <Text style={[styles.selectedDateTitle, { color: Colors[colorScheme].text }]}>
                Events on{' '}
                {new Date(selectedDate).toLocaleDateString('en-US', {
                  month: 'long',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </Text>
              {gamesOnDate.map(game => {
                const time = game.date
                  ? new Date(game.date).toLocaleTimeString('en-US', {
                      hour: 'numeric',
                      minute: '2-digit',
                    })
                  : 'TBD';
                return (
                  <Pressable
                    key={game.id}
                    style={[
                      styles.dateGameCard,
                      {
                        backgroundColor: Colors[colorScheme].background,
                        borderColor: Colors[colorScheme].border,
                      },
                    ]}
                    onPress={() =>
                      void router.push(
                        game.source_type === 'event'
                          ? buildEventDetailRoute(game.event_id || game.id, game.game_id)
                          : { pathname: '/game/[id]', params: { id: String(game.id) } }
                      )
                    }
                    accessibilityRole="button"
                    accessibilityLabel={`${game.title} at ${time}`}
                  >
                    <View style={styles.dateGameTime}>
                      <MaterialIcons
                        name="access-time"
                        size={16}
                        color={Colors[colorScheme].tint}
                      />
                      <Text style={[styles.dateGameTimeText, { color: Colors[colorScheme].tint }]}>
                        {time}
                      </Text>
                    </View>
                    <Text
                      style={[styles.dateGameTitle, { color: Colors[colorScheme].text }]}
                      numberOfLines={1}
                    >
                      {game.title}
                    </Text>
                    {game.location && (
                      <View style={styles.dateGameLocation}>
                        <MaterialIcons
                          name="location-on"
                          size={14}
                          color={Colors[colorScheme].mutedText}
                        />
                        <Text
                          style={[
                            styles.dateGameLocationText,
                            { color: Colors[colorScheme].mutedText },
                          ]}
                          numberOfLines={1}
                        >
                          {game.location}
                        </Text>
                      </View>
                    )}
                  </Pressable>
                );
              })}
              {eventsOnDate.map(event => {
                const time = event.date
                  ? new Date(event.date).toLocaleTimeString('en-US', {
                      hour: 'numeric',
                      minute: '2-digit',
                    })
                  : 'TBD';
                const eventTitle = event.title || 'Event';
                return (
                  <Pressable
                    key={`event-${event.id}`}
                    style={[
                      styles.dateGameCard,
                      {
                        backgroundColor: Colors[colorScheme].background,
                        borderColor: Colors[colorScheme].border,
                      },
                    ]}
                    onPress={() => void router.push(buildEventDetailRoute(event.id, event.game_id))}
                    accessibilityRole="button"
                    accessibilityLabel={`${eventTitle} at ${time}`}
                  >
                    <View style={styles.dateGameTime}>
                      <MaterialIcons name="event" size={16} color={Colors[colorScheme].tint} />
                      <Text style={[styles.dateGameTimeText, { color: Colors[colorScheme].tint }]}>
                        {time}
                      </Text>
                    </View>
                    <Text
                      style={[styles.dateGameTitle, { color: Colors[colorScheme].text }]}
                      numberOfLines={1}
                    >
                      {eventTitle}
                    </Text>
                    {event.location && (
                      <View style={styles.dateGameLocation}>
                        <MaterialIcons
                          name="location-on"
                          size={14}
                          color={Colors[colorScheme].mutedText}
                        />
                        <Text
                          style={[
                            styles.dateGameLocationText,
                            { color: Colors[colorScheme].mutedText },
                          ]}
                          numberOfLines={1}
                        >
                          {event.location}
                        </Text>
                      </View>
                    )}
                  </Pressable>
                );
              })}
            </View>
          );
        })()}

      <Text style={[styles.title, { color: Colors[colorScheme].text }]}>Discover</Text>

      {/* Quick Actions Dashboard */}
      <View
        style={[
          styles.coachDashboard,
          { backgroundColor: Colors[colorScheme].surface, borderColor: Colors[colorScheme].border },
        ]}
      >
        <Text style={[styles.coachTitle, { color: Colors[colorScheme].text }]}>Quick Actions</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 12 }}>
          {/* Role-based actions */}
          {coachAccess.canAccessCoachTools ? (
            <>
              <Pressable
                style={[
                  styles.coachActionCard,
                  {
                    backgroundColor: Colors[colorScheme].tint + '10',
                    borderColor: Colors[colorScheme].tint + '30',
                  },
                ]}
                onPress={() => {
                  analytics.track(ANALYTICS_EVENTS.COACH_QUICK_ACTION_TAPPED, {
                    action: 'manage_teams',
                  });
                  void router.push({
                    pathname: '/manage-teams',
                    params: {
                      from: 'discover-quick-actions',
                      fallback: '/(tabs)/discover',
                    },
                  } as any);
                }}
                accessibilityRole="button"
                accessibilityLabel="Manage Teams"
              >
                <MaterialIcons name="group" size={24} color={Colors[colorScheme].tint} />
                <Text style={[styles.coachActionTitle, { color: Colors[colorScheme].tint }]}>
                  Manage Teams
                </Text>
                <Text style={[styles.coachActionDesc, { color: Colors[colorScheme].mutedText }]}>
                  Your programs & teams
                </Text>
              </Pressable>
              <Pressable
                style={[
                  styles.coachActionCard,
                  {
                    backgroundColor: Colors[colorScheme].tint + '10',
                    borderColor: Colors[colorScheme].tint + '30',
                    marginLeft: 12,
                    opacity: quickActionBusy && quickActionBusy !== 'schedule' ? 0.5 : 1,
                  },
                ]}
                onPress={() => void handleTeamSchedule()}
                disabled={quickActionBusy !== null}
                accessibilityRole="button"
                accessibilityLabel="Team Schedule"
              >
                {quickActionBusy === 'schedule' ? (
                  <ActivityIndicator size="small" color={Colors[colorScheme].tint} />
                ) : (
                  <MaterialIcons name="event" size={24} color={Colors[colorScheme].tint} />
                )}
                <Text style={[styles.coachActionTitle, { color: Colors[colorScheme].tint }]}>
                  Team Schedule
                </Text>
                <Text style={[styles.coachActionDesc, { color: Colors[colorScheme].mutedText }]}>
                  Manage games and season
                </Text>
              </Pressable>
              <Pressable
                style={[
                  styles.coachActionCard,
                  {
                    backgroundColor: Colors[colorScheme].tint + '10',
                    borderColor: Colors[colorScheme].tint + '30',
                    marginLeft: 12,
                  },
                ]}
                onPress={() => {
                  analytics.track(ANALYTICS_EVENTS.COACH_QUICK_ACTION_TAPPED, {
                    action: 'approvals',
                  });
                  void router.push({
                    pathname: '/event-approvals',
                    params: {
                      from: 'discover-quick-actions',
                      fallback: '/(tabs)/discover',
                    },
                  } as any);
                }}
                accessibilityRole="button"
                accessibilityLabel="Review pending event approvals"
              >
                <MaterialIcons name="done-all" size={24} color={Colors[colorScheme].tint} />
                <Text style={[styles.coachActionTitle, { color: Colors[colorScheme].tint }]}>
                  Approvals
                </Text>
                <Text style={[styles.coachActionDesc, { color: Colors[colorScheme].mutedText }]}>
                  Review pending events
                </Text>
              </Pressable>
              <Pressable
                style={[
                  styles.coachActionCard,
                  {
                    backgroundColor: '#1E3A5F15',
                    borderColor: '#1E3A5F30',
                    marginLeft: 12,
                    opacity: quickActionBusy && quickActionBusy !== 'org' ? 0.5 : 1,
                  },
                ]}
                onPress={() => void handleManageOrg()}
                disabled={quickActionBusy !== null}
                accessibilityRole="button"
                accessibilityLabel="Manage your organization"
              >
                {quickActionBusy === 'org' ? (
                  <ActivityIndicator size="small" color={Colors[colorScheme].tint} />
                ) : (
                  <MaterialIcons name="business" size={24} color={Colors[colorScheme].tint} />
                )}
                <Text style={[styles.coachActionTitle, { color: Colors[colorScheme].tint }]}>
                  Manage Org
                </Text>
                <Text style={[styles.coachActionDesc, { color: Colors[colorScheme].mutedText }]}>
                  Your organization
                </Text>
              </Pressable>
            </>
          ) : coachAccess.isApprovedCoach ? (
            <Pressable
              style={[
                styles.coachActionCard,
                {
                  backgroundColor: Colors[colorScheme].tint + '18',
                  borderColor: Colors[colorScheme].tint + '50',
                  borderWidth: 1.5,
                },
              ]}
              onPress={() => {
                // Never a no-op: getCoachFinishSetupRoute applies the same
                // fallback as the canonical guard useRequireCoach when
                // getCoachRecoveryRoute returns null for an approved coach.
                router.push(getCoachFinishSetupRoute(me as any) as any);
              }}
              accessibilityRole="button"
              accessibilityLabel="Complete coach setup"
            >
              <MaterialIcons name="check-circle" size={24} color={Colors[colorScheme].tint} />
              <Text style={[styles.coachActionTitle, { color: Colors[colorScheme].tint }]}>
                Finish Setup
              </Text>
              <Text style={[styles.coachActionDesc, { color: Colors[colorScheme].mutedText }]}>
                Complete setup to unlock coach tools
              </Text>
            </Pressable>
          ) : hasStaffTeams ? (
            /* Role-barrier model: non-coach authorized users (team manager /
               assistant_coach) get ONLY Approvals — roster + event
               approve/deny is their entire admin surface. No Manage Teams,
               Team Schedule, or Manage Org. */
            <Pressable
              style={[
                styles.coachActionCard,
                {
                  backgroundColor: Colors[colorScheme].tint + '10',
                  borderColor: Colors[colorScheme].tint + '30',
                },
              ]}
              onPress={() => {
                analytics.track(ANALYTICS_EVENTS.COACH_QUICK_ACTION_TAPPED, {
                  action: 'approvals',
                  actor: 'authorized_user',
                });
                void router.push({
                  pathname: '/event-approvals',
                  params: {
                    from: 'discover-quick-actions',
                    fallback: '/(tabs)/discover',
                  },
                } as any);
              }}
              accessibilityRole="button"
              accessibilityLabel="Review pending approvals"
            >
              <MaterialIcons name="done-all" size={24} color={Colors[colorScheme].tint} />
              <Text style={[styles.coachActionTitle, { color: Colors[colorScheme].tint }]}>
                Approvals
              </Text>
              <Text style={[styles.coachActionDesc, { color: Colors[colorScheme].mutedText }]}>
                Review roster and event requests
              </Text>
            </Pressable>
          ) : (
            <>
              {/* Fan actions. Note: the canonical user role is only ever 'fan'
                  or 'coach' (UserRole enum) — there is no 'organizer' role, so
                  org management for non-coach members is surfaced via the team
                  and organization screens, not here. */}
              <Pressable
                style={[
                  styles.coachActionCard,
                  {
                    backgroundColor: Colors[colorScheme].tint + '10',
                    borderColor: Colors[colorScheme].tint + '30',
                    marginLeft: 0,
                  },
                ]}
                onPress={() => void router.push('/create-fan-event')}
                accessibilityRole="button"
                accessibilityLabel="Create a fan event"
              >
                <MaterialIcons name="group" size={24} color={Colors[colorScheme].tint} />
                <Text style={[styles.coachActionTitle, { color: Colors[colorScheme].tint }]}>
                  Fan Event
                </Text>
                <Text style={[styles.coachActionDesc, { color: Colors[colorScheme].mutedText }]}>
                  Watch parties & meetups
                </Text>
              </Pressable>
              <Pressable
                style={[
                  styles.coachActionCard,
                  {
                    backgroundColor: Colors[colorScheme].tint + '10',
                    borderColor: Colors[colorScheme].tint + '30',
                    marginLeft: 12,
                  },
                ]}
                onPress={() => void router.push('/create')}
                accessibilityRole="button"
                accessibilityLabel="Share a moment"
              >
                <MaterialIcons name="camera-alt" size={24} color={Colors[colorScheme].tint} />
                <Text style={[styles.coachActionTitle, { color: Colors[colorScheme].tint }]}>
                  Share Moment
                </Text>
                <Text style={[styles.coachActionDesc, { color: Colors[colorScheme].mutedText }]}>
                  Post photos and videos
                </Text>
              </Pressable>
              <Pressable
                style={[
                  styles.coachActionCard,
                  {
                    backgroundColor: Colors[colorScheme].tint + '10',
                    borderColor: Colors[colorScheme].tint + '30',
                    marginLeft: 12,
                  },
                ]}
                onPress={() => void router.push('/favorites')}
                accessibilityRole="button"
                accessibilityLabel="View saved posts"
              >
                <MaterialIcons name="bookmark" size={24} color={Colors[colorScheme].tint} />
                <Text style={[styles.coachActionTitle, { color: Colors[colorScheme].tint }]}>
                  Saved Post
                </Text>
                <Text style={[styles.coachActionDesc, { color: Colors[colorScheme].mutedText }]}>
                  Saved posts
                </Text>
              </Pressable>
            </>
          )}
        </ScrollView>
      </View>

      {me && me._count?.following ? (
        <View
          style={[styles.followingCard, { backgroundColor: '#1e3a8a22', borderColor: '#1e3a8a55' }]}
        >
          <MaterialIcons name="group" size={18} color="#2563EB" />
          <Text
            style={[styles.followingText, { color: Colors[colorScheme].text }]}
          >{`Following ${me._count.following} people`}</Text>
          <View style={{ flex: 1 }} />
          <Pressable
            onPress={() =>
              void router.push(
                `/following?id=${me.id}&username=${me.display_name || me.username || 'You'}`
              )
            }
            style={styles.followingBtn}
            accessibilityRole="button"
            accessibilityLabel="Manage who you follow"
          >
            <Text style={styles.followingBtnText}>Manage</Text>
          </Pressable>
        </View>
      ) : (
        <View
          style={[
            styles.followingCardMuted,
            {
              backgroundColor: Colors[colorScheme].surface,
              borderColor: Colors[colorScheme].border,
            },
          ]}
        >
          <MaterialIcons name="group" size={18} color={Colors[colorScheme].mutedText} />
          <Text style={[styles.followingMutedText, { color: Colors[colorScheme].mutedText }]}>
            Follow people to see their posts here.
          </Text>
        </View>
      )}

      {/* Segmented tabs for posts */}
      <View style={[styles.tabsWrap, { backgroundColor: Colors[colorScheme].border }]}>
        <Pressable
          onPress={() => setTab('discover')}
          style={[
            styles.tab,
            tab === 'discover' && [styles.tabOn, { backgroundColor: Colors[colorScheme].card }],
          ]}
          accessibilityRole="tab"
          accessibilityLabel="Discover posts"
        >
          <Text
            style={[
              styles.tabLabel,
              tab === 'discover' && styles.tabLabelOn,
              { color: Colors[colorScheme].text },
            ]}
          >
            Discover
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setTab('following')}
          style={[
            styles.tab,
            tab === 'following' && [styles.tabOn, { backgroundColor: Colors[colorScheme].card }],
          ]}
          accessibilityRole="tab"
          accessibilityLabel="Posts from people you follow"
        >
          <Text
            style={[
              styles.tabLabel,
              tab === 'following' && styles.tabLabelOn,
              { color: Colors[colorScheme].text },
            ]}
          >
            Following
          </Text>
        </Pressable>
      </View>

      {personalizationIsError && personalization !== undefined ? (
        <View style={styles.optionalStatusRow}>
          <Text style={[styles.noticeText, { color: Colors[colorScheme].mutedText, flex: 1 }]}>
            Could not refresh posts. Showing saved results.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry posts"
            onPress={() => void refetchPersonalization()}
            style={styles.inlineRetryButton}
          >
            <Text style={styles.inlineRetryText}>Retry</Text>
          </Pressable>
        </View>
      ) : null}

      <Text style={[styles.sectionTitle, { color: Colors[colorScheme].text }]}>
        {tab === 'following' ? 'From people you follow' : 'Discover new posts'}
      </Text>
      {personalizationPending && personalization === undefined ? (
        <Text style={[styles.mutedSmall, { color: Colors[colorScheme].mutedText }]}>
          Loading posts…
        </Text>
      ) : personalizationIsError && personalization === undefined ? (
        <View style={styles.optionalStatusRow}>
          <Text style={[styles.mutedSmall, { color: Colors[colorScheme].mutedText, flex: 1 }]}>
            Posts are temporarily unavailable.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry posts"
            onPress={() => void refetchPersonalization()}
            style={styles.inlineRetryButton}
          >
            <Text style={styles.inlineRetryText}>Retry</Text>
          </Pressable>
        </View>
      ) : (tab === 'following' ? followingPosts : discoverPosts).length === 0 ? (
        <Text style={[styles.mutedSmall, { color: Colors[colorScheme].mutedText }]}>
          {tab === 'following'
            ? 'Follow people to see their posts here.'
            : 'New posts will appear here soon.'}
        </Text>
      ) : (
        <View style={{ marginBottom: 12, gap: 10 }}>
          {(tab === 'following' ? followingPosts : discoverPosts).map((p, _i, _arr) => {
            return (
              <View key={String(p.id)}>
                {/* Owner note 5c: the redundant "User … Follow" header that sat
                    above every Discover post is removed. PostCard already renders
                    the author (as @username, not the "User" fallback) and its
                    EventChip "View Game" link, so this row only duplicated identity
                    and pushed a follow CTA the owner didn't want on Discover. */}
                <PostCard
                  post={p}
                  onPress={() => {
                    const posts = tab === 'following' ? followingPosts : discoverPosts;
                    const postIds = posts.map((post: any) => String(post.id)).join(',');
                    const index = posts.findIndex((post: any) => String(post.id) === String(p.id));
                    void router.push(
                      `/post-detail?id=${p.id}&postIds=${encodeURIComponent(postIds)}&index=${Math.max(0, index)}`
                    );
                  }}
                  showAuthorHeader={true}
                  onDeleted={postId => {
                    // Remove deleted post from both cached arrays
                    patchDiscoverPosts(posts => posts.filter(post => String(post.id) !== postId));
                  }}
                  onUpdated={updatedPost => {
                    // Update post in both cached arrays if it exists
                    patchDiscoverPosts(posts =>
                      posts.map(post =>
                        String(post.id) === String(updatedPost.id)
                          ? { ...post, ...updatedPost }
                          : post
                      )
                    );
                  }}
                />
              </View>
            );
          })}
        </View>
      )}

      <Pressable
        style={[
          styles.browseOrgsRow,
          { backgroundColor: Colors[colorScheme].surface, borderColor: Colors[colorScheme].border },
        ]}
        onPress={() => void router.push('/organizations')}
        accessibilityRole="button"
        accessibilityLabel="Browse organizations"
      >
        <MaterialIcons name="account-balance" size={20} color={Colors[colorScheme].tint} />
        <Text style={[styles.browseOrgsText, { color: Colors[colorScheme].text }]}>
          Browse organizations
        </Text>
        <MaterialIcons name="chevron-right" size={20} color={Colors[colorScheme].mutedText} />
      </Pressable>

      {isSignedIn && suggestedPending && suggestedData === undefined ? (
        <Text style={[styles.mutedSmall, { color: Colors[colorScheme].mutedText }]}>
          Loading people suggestions…
        </Text>
      ) : null}

      {isSignedIn && suggestedIsError ? (
        <View style={styles.optionalStatusRow}>
          <Text style={[styles.mutedSmall, { color: Colors[colorScheme].mutedText, flex: 1 }]}>
            {suggestedData === undefined
              ? 'People suggestions are temporarily unavailable.'
              : 'Could not refresh people suggestions. Showing saved results.'}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry people suggestions"
            onPress={() => void refetchSuggested()}
            style={styles.inlineRetryButton}
          >
            <Text style={styles.inlineRetryText}>Retry</Text>
          </Pressable>
        </View>
      ) : null}

      {isSignedIn &&
      !suggestedPending &&
      !suggestedIsError &&
      suggestedData !== undefined &&
      suggestedData.length === 0 ? (
        <Text style={[styles.mutedSmall, { color: Colors[colorScheme].mutedText }]}>
          No people suggestions right now.
        </Text>
      ) : null}

      {nearbyPeople.length > 0 ? (
        <View style={{ marginBottom: 16 }}>
          <Text style={[styles.sectionTitle, { color: Colors[colorScheme].text }]}>
            Nearby people
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ marginTop: 8 }}
            contentContainerStyle={{ paddingRight: 8 }}
          >
            {nearbyPeople.map((u: any) => (
              <Pressable
                key={String(u.id)}
                style={styles.personTile}
                onPress={() => void router.push(`/user-profile?id=${u.id}`)}
                accessibilityRole="button"
                accessibilityLabel={`View profile of ${safeDisplayName(u)}`}
              >
                <View style={styles.personAvatar}>
                  {u.avatar_url ? (
                    <Image
                      source={{ uri: optimizeImageUrl(String(u.avatar_url), 100) }}
                      style={styles.personAvatar}
                      contentFit="cover"
                    />
                  ) : (
                    <LinearGradient
                      colors={['#1E1E1E', '#121212']}
                      style={styles.personAvatar}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 1 }}
                    />
                  )}
                </View>
                <Text
                  numberOfLines={1}
                  style={[styles.personName, { color: Colors[colorScheme].text }]}
                >
                  {safeDisplayName(u)}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}

      {suggestedPeople.length > 0 ? (
        <View style={{ marginBottom: 20 }}>
          <Text style={[styles.sectionTitle, { color: Colors[colorScheme].text }]}>
            People You May Know
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ marginTop: 10 }}
            contentContainerStyle={{ gap: 12, paddingRight: 16 }}
          >
            {suggestedPeople.map((u: any) => (
              <View key={String(u.id)} style={styles.suggestedCard}>
                <Pressable onPress={() => void router.push(`/user-profile?id=${u.id}`)}>
                  <View style={styles.suggestedAvatar}>
                    {u.avatar_url ? (
                      <Image
                        source={{ uri: optimizeImageUrl(String(u.avatar_url), 80) }}
                        style={styles.suggestedAvatar}
                        contentFit="cover"
                      />
                    ) : (
                      <LinearGradient
                        colors={['#1e3a5f', '#121212']}
                        style={styles.suggestedAvatar}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 1 }}
                      />
                    )}
                  </View>
                  <Text
                    numberOfLines={1}
                    style={[styles.suggestedName, { color: Colors[colorScheme].text }]}
                  >
                    {safeDisplayName(u)}
                  </Text>
                  {u.followers_count > 0 ? (
                    <Text
                      numberOfLines={1}
                      style={[styles.suggestedMeta, { color: Colors[colorScheme].mutedText }]}
                    >
                      {u.mutual_count > 0
                        ? `${u.mutual_count} mutual`
                        : `${u.followers_count} follower${u.followers_count !== 1 ? 's' : ''}`}
                    </Text>
                  ) : null}
                </Pressable>
                <Pressable
                  style={[
                    styles.suggestedFollowBtn,
                    u.is_following && styles.suggestedFollowingBtn,
                  ]}
                  onPress={async () => {
                    if (!user) {
                      promptForSignIn(() => router.push('/sign-in'), {
                        message: 'Sign in to follow.',
                      });
                      return;
                    }
                    if (suggestedFollowLoading === u.id) return;
                    setSuggestedFollowLoading(u.id);
                    try {
                      if (u.is_following) {
                        await User.unfollow(u.id);
                      } else {
                        await User.follow(u.id);
                      }
                      patchSuggestedPeople(people =>
                        people.map(p =>
                          p.id === u.id ? { ...p, is_following: !p.is_following } : p
                        )
                      );
                    } catch (followError) {
                      reportDiscoverFailure('update_suggested_follow', followError);
                      Alert.alert(
                        u.is_following ? 'Unable to unfollow' : 'Unable to follow',
                        'Please try again. Your follow was not changed.'
                      );
                    } finally {
                      setSuggestedFollowLoading(null);
                    }
                  }}
                >
                  <Text
                    style={[
                      styles.suggestedFollowText,
                      u.is_following && { color: colorScheme === 'dark' ? '#9CA3AF' : '#555' },
                    ]}
                  >
                    {suggestedFollowLoading === u.id
                      ? '...'
                      : u.is_following
                        ? 'Following'
                        : 'Follow'}
                  </Text>
                </Pressable>
              </View>
            ))}
          </ScrollView>
        </View>
      ) : null}

      <Text style={[styles.helper, { color: Colors[colorScheme].mutedText }]}>
        Upcoming and recent games near you
      </Text>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={Colors[colorScheme].tint} />
        </View>
      ) : error ? (
        <View style={{ alignItems: 'center', paddingVertical: 24 }}>
          <MaterialIcons name="wifi-off" size={40} color={Colors[colorScheme].mutedText} />
          <Text
            style={{
              color: Colors[colorScheme].destructive || '#EF4444',
              fontSize: 15,
              fontWeight: '600',
              marginTop: 8,
            }}
          >
            {error}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry games"
            onPress={() => void refetchGames()}
            style={{
              marginTop: 12,
              paddingHorizontal: 20,
              paddingVertical: 8,
              borderRadius: 8,
              backgroundColor: Colors[colorScheme].tint,
            }}
          >
            <Text style={{ color: '#FFFFFF', fontWeight: '700' }}>Retry</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );

  return (
    <SwipeBackContainer>
      <View
        style={[
          styles.container,
          { paddingTop: 12 + insets.top, backgroundColor: Colors[colorScheme].background },
        ]}
      >
        <Stack.Screen options={{ title: 'Discover', headerShown: false }} />
        <View style={{ alignItems: 'center', paddingHorizontal: 12, paddingBottom: 4 }}>
          <Text
            style={{
              fontSize: 20,
              fontWeight: '800',
              color: Colors[colorScheme].text,
              textAlign: 'center',
            }}
          >
            Discover
          </Text>
        </View>

        {viewMode === 'map' ? (
          /* Map View - Simplified without ListHeader */
          <View style={{ flex: 1 }}>
            {/* Just the search and toggle button */}
            <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
              <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
                <View
                  style={[
                    styles.searchBox,
                    {
                      flex: 1,
                      backgroundColor: Colors[colorScheme].surface,
                      borderColor: Colors[colorScheme].border,
                    },
                  ]}
                >
                  <MaterialIcons name="search" size={20} color={Colors[colorScheme].mutedText} />
                  <TextInput
                    placeholder="Search by Zip Code..."
                    placeholderTextColor={Colors[colorScheme].mutedText}
                    value={query}
                    onChangeText={v => {
                      setQuery(v);
                      const digits = v.replace(/[^0-9]/g, '');
                      setZipSuggestionsOpen(digits.length >= 2);
                    }}
                    style={[styles.searchInput, { color: Colors[colorScheme].text }]}
                    returnKeyType="search"
                    onBlur={() => setZipSuggestionsOpen(false)}
                    accessibilityLabel="Search by zip code"
                  />
                </View>

                {/* Map/List Toggle */}
                <Pressable
                  onPress={() => {
                    // In map view branch, viewMode is 'map'; toggling goes to 'list'
                    const newMode: 'list' | 'map' = 'list';
                    setViewMode(newMode);
                  }}
                  style={[
                    styles.viewToggle,
                    {
                      backgroundColor: Colors[colorScheme].surface,
                      borderColor: Colors[colorScheme].border,
                    },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Switch to list view"
                >
                  <MaterialIcons name={'list'} size={24} color={Colors[colorScheme].tint} />
                </Pressable>
              </View>
            </View>

            {/* Full Map View */}
            {(() => {
              return (
                <EventMap
                  events={mapEvents}
                  onEventPress={(eventId, eventType) => {
                    if (eventType === 'event') {
                      router.push(buildEventDetailRoute(eventId));
                      return;
                    }
                    router.push({ pathname: '/game/[id]', params: { id: eventId } });
                  }}
                  initialRegion={USA_WIDE_REGION}
                  showUserLocation={true}
                  preventAutoCenterOnUser
                  dataLoaded={!mapEventsPending}
                  autoFitPins={false}
                />
              );
            })()}
          </View>
        ) : (
          /* List View */
          <FlatList
            style={{ flex: 1 }}
            data={filtered}
            keyExtractor={item => String(item.id)}
            ListHeaderComponent={ListHeader}
            renderItem={({ item }) => (
              <Pressable
                style={[
                  styles.card,
                  {
                    backgroundColor: Colors[colorScheme].card,
                    borderColor: Colors[colorScheme].border,
                  },
                ]}
                onPress={() =>
                  void router.push(
                    item.source_type === 'event' || item.event_id
                      ? buildEventDetailRoute(item.event_id || item.id, item.game_id)
                      : { pathname: '/game/[id]', params: { id: String(item.id) } }
                  )
                }
                accessibilityRole="button"
                accessibilityLabel={`View game: ${item.title ? String(item.title) : 'Game'}${item.location ? `, ${String(item.location)}` : ''}`}
              >
                <View style={[styles.hero, { backgroundColor: Colors[colorScheme].surface }]}>
                  {(() => {
                    const banner = item.cover_image_url || (item as any).banner_url || null;
                    return banner ? (
                      <Image source={{ uri: banner }} style={styles.heroImage} contentFit="cover" />
                    ) : (
                      <LinearGradient
                        colors={['#1E1E1E', '#121212']}
                        style={styles.heroImage}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 1 }}
                      />
                    );
                  })()}
                </View>
                <View style={styles.cardContent}>
                  <Text style={[styles.cardTitle, { color: Colors[colorScheme].text }]}>
                    {item.title ? String(item.title) : 'Game'}
                  </Text>
                  <Text style={[styles.cardMeta, { color: Colors[colorScheme].mutedText }]}>
                    {item.location ? String(item.location) : 'TBD'}
                  </Text>
                  {(() => {
                    const labels = deriveTeamLabels(item);
                    if (!labels) return null;
                    return (
                      <View style={styles.teamRow}>
                        <View
                          style={[
                            styles.teamPill,
                            {
                              backgroundColor:
                                colorScheme === 'dark' ? 'rgba(99,102,241,0.15)' : '#EEF2FF',
                              borderColor:
                                colorScheme === 'dark' ? 'rgba(99,102,241,0.3)' : '#C7D2FE',
                            },
                          ]}
                        >
                          <Text
                            style={[
                              styles.teamPillText,
                              { color: colorScheme === 'dark' ? '#A5B4FC' : '#1E3A8A' },
                            ]}
                          >
                            {labels.teamA}
                          </Text>
                        </View>
                        <Text style={[styles.vsText, { color: Colors[colorScheme].mutedText }]}>
                          vs
                        </Text>
                        <View
                          style={[
                            styles.teamPillAlt,
                            {
                              backgroundColor:
                                colorScheme === 'dark' ? 'rgba(239,68,68,0.15)' : undefined,
                              borderColor:
                                colorScheme === 'dark' ? 'rgba(239,68,68,0.3)' : undefined,
                            },
                          ]}
                        >
                          <Text
                            style={[
                              styles.teamPillAltText,
                              { color: colorScheme === 'dark' ? '#FCA5A5' : undefined },
                            ]}
                          >
                            {labels.teamB}
                          </Text>
                        </View>
                      </View>
                    );
                  })()}
                </View>
              </Pressable>
            )}
            ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
            contentContainerStyle={{ paddingVertical: 8, paddingBottom: 24 }}
            refreshing={refreshing}
            onRefresh={onRefresh}
            keyboardShouldPersistTaps="handled"
          />
        )}

        {viewerOpen ? (
          <Modal visible animationType="slide" onRequestClose={() => setViewerOpen(false)}>
            <GameVerticalFeedScreen
              onClose={() => setViewerOpen(false)}
              initialPosts={viewerPosts}
              startIndex={viewerIndex}
              title={tab === 'following' ? 'Following' : 'Discover'}
              showHeader
            />
          </Modal>
        ) : null}

        <QuickAddGameModal
          visible={createEventModalOpen}
          onClose={() => setCreateEventModalOpen(false)}
          onSave={handleQuickGameSave}
          currentTeamName={me?.team?.name}
          currentTeamId={me?.team?.id}
          userRole={coachAccess.canAccessCoachTools || me?.is_admin === true ? 'coach' : 'fan'}
        />
      </View>
    </SwipeBackContainer>
  );
}

export default CommunityDiscoverScreen;
