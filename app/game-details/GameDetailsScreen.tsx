import { Colors } from '@/constants/Colors';
import ExpandableText from '@/components/ExpandableText';
import {
  isNativeVideoTrimSupported,
  MAX_PICKED_VIDEO_SIZE_BYTES,
  STORY_MAX_DURATION_S,
  VIDEO_CAPTURE_PRESET,
} from '@/constants/video';
import { queryClient } from '@/lib/queryClient';
import {
  getVideoFileSize,
  prepareVideoForUpload,
  uploadTimeoutMsForSize,
} from '@/utils/compressVideo';
import { useColorScheme } from '@/hooks/useColorScheme';
import { useDeviceLocation } from '@/hooks/useDeviceLocation';
import { useShareLink } from '@/hooks/useShareLink';
import { useThemeColor } from '@/hooks/useThemeColor';
import {
  canShowGamePoll,
  getEventPresentationPhase,
  isEventPastEndOfDay,
} from '@/utils/eventPresentation';
import { hasLocalEventPostingUnlock, recordEventPostingUnlock } from '@/utils/eventPostingUnlock';
import { buildEventScrapbookPlan, eventScrapbookSeed } from '@/utils/eventPostGrid';
import { optimizeImageUrl } from '@/utils/imageUrl';
import { isPostingWindowOpen, type LiveWindowFields } from '@/utils/liveWindow';
import { materializeICloudAssetIfNeeded } from '@/utils/materializeICloudAsset';
import { replaceAsRedirect, safeGoBack } from '@/utils/navigation';
import { pickerAllMediaTypesProp } from '@/utils/picker';
import { toUserMessage } from '@/utils/toUserMessage';
import { promptForSignIn } from '@/utils/requireSignIn';
import { retryWithBackoff } from '@/utils/retryWithBackoff';
import { showUploadErrorAlert } from '@/utils/uploadErrorAlert';
import { getVenuePhotoFallback } from '@/utils/venuePhotoFallback';
import { Ionicons } from '@expo/vector-icons';
import { format } from 'date-fns';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  InteractionManager,
  Linking,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { getApiBaseUrl } from '../../api/http';
import MatchBanner from '../components/MatchBanner';

// @ts-ignore JS exports
import { Event, Game, Post, Team } from '@/api/entities';
import { uploadFile } from '@/api/upload';
import FullscreenImageViewer from '@/components/FullscreenImageViewer';
import VideoFirstFrame from '@/components/VideoFirstFrame';
import VideoPlayer from '@/components/VideoPlayer';
import VideoThumbnail from '@/components/VideoThumbnail';
import VideoTrimmer from '@/components/VideoTrimmer';
import { useAuth } from '@/context/AuthProvider';
import { analytics, ANALYTICS_EVENTS } from '@/utils/analytics';
import {
  applyClearVote,
  applyVoteSelection,
  buildVoteSummary,
  parseVoteSummary,
  type VoteOption,
  type VoteSummary,
} from '@/utils/voteSummary';
import GameVerticalFeedScreen, { mapHighlightToFeedPost } from './GameVerticalFeedScreen';
import StoriesViewer, { VIDEO_EXT, type MediaItem } from './StoriesViewer';

import type { ColorValue } from 'react-native';
const PLACEHOLDER_GRADIENT: readonly [ColorValue, ColorValue, ...ColorValue[]] = [
  '#1e293b',
  '#1d4ed8',
  '#38bdf8',
];

type TeamInfo = { id: string; name: string; avatarUrl?: string | null };

type GameVM = {
  id: string;
  gameId: string | null;
  eventId: string | null;
  title: string;
  date: string;
  location: string | null;
  description?: string | null;
  bannerUrl?: string | null;
  venuePhotoUrl?: string | null;
  venuePhotoCredit?: string | null;
  homeTeam?: string | null;
  awayTeam?: string | null;
  appearance?: string | null;
  coverImageUrl?: string | null;
  capacity?: number | null;
  rsvpCount?: number | null;
  userRsvped?: boolean;
  teams: TeamInfo[];
  posts: any[];
  media: MediaItem[];
  reviewsCount?: number | null;
  isPast: boolean;
  eventType?: string | null;
  home_score?: number | null;
  away_score?: number | null;
  winner?: string | null;
  can_edit_result?: boolean;
  venueLat?: number | null;
  venueLng?: number | null;
  // Server-computed posting-window bounds (GET /games/:id[/summary]); used to
  // gate story posting on the real per-event window instead of a 3h fallback.
  starts_at?: string | null;
  live_from?: string | null;
  live_until?: string | null;
};

const ensureIso = (value: any) => {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  return null;
};

const getVenuePhoto = (value: unknown): { url: string | null; credit: string | null } => {
  if (!value || typeof value !== 'object') {
    return { url: null, credit: null };
  }
  const record = value as { url?: unknown; credit?: unknown };
  return {
    url: typeof record.url === 'string' ? record.url : null,
    credit: typeof record.credit === 'string' ? record.credit : null,
  };
};

const formatDateLabel = (iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return format(d, 'EEE, MMM d, yyyy');
};

const formatTimeLabel = (iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return format(d, 'h:mm a');
};

const computeIsPast = (iso?: string | null) => {
  return isEventPastEndOfDay(iso);
};

// Kept in sync with server/scripts/seed-demo-matchups.ts DEMO_TAG and the
// carve-out in server/src/routes/gameStories.ts — changing this string
// silently breaks the client gate for seeded promo matchups.
const DEMO_MATCHUP_TAG = '[DEMO_MATCHUP]';

const canAddStory = (
  eventIso?: string | null,
  gameId?: string | null,
  description?: string | null,
  liveWindow?: LiveWindowFields | null
) => {
  // Seeded demo matchups (Duke v UNC, Cavs v Warriors) bypass the day-of gate
  // to match the server-side [DEMO_MATCHUP] carve-out in gameStories.ts.
  if (typeof description === 'string' && description.includes(DEMO_MATCHUP_TAG)) return true;

  // Without an event date, allow uploading — no window to enforce client-side
  if (!eventIso) return true;

  // Mirrors the server's `isStoryPostingWindowOpen` (geofencing.ts): stories
  // are LIVE-ONLY (owner rule, 2026-07-16 — "USERS CANT UPLOAD TO STORIES
  // AFTER THEY HAVE LEFT THE GAME", "do not get the same 7 days after the
  // fact"). This used to run from the event's UTC midnight through +48h.
  // Prefer the server-computed bounds when the payload carries them so the
  // per-event override (fest days run 18h) is honored; otherwise fall back to
  // the server's default window off the event date.
  return isPostingWindowOpen({ ...(liveWindow ?? {}), date: eventIso });
};

const capCount = (count?: number | null, capacity?: number | null) => {
  if (typeof count !== 'number') return null;
  if (typeof capacity === 'number' && capacity >= 0) return Math.min(count, capacity);
  return count;
};

const openMaps = (location: string) => {
  const query = encodeURIComponent(location);
  const url = `https://www.google.com/maps/search/?api=1&query=${query}`;
  Linking.openURL(url).catch(error => {
    if (__DEV__) console.warn('[GameDetails] Failed to open maps URL:', error);
  });
};

// No special-case banner — kept generic for any matchup
const finalsBannerForTeams = (
  _home?: string | null,
  _away?: string | null,
  _title?: string | null
) => {
  return null;
};

const pickBannerFromArrays = (vm: Partial<GameVM>) => {
  const finalsBanner = finalsBannerForTeams(vm.homeTeam, vm.awayTeam, vm.title as any);
  const result = vm.bannerUrl || vm.coverImageUrl || finalsBanner || null;
  return result;
};

const GameDetailsScreen = () => {
  // Define isTestEnv at the top so all hooks can use it
  const isTestEnv =
    typeof process !== 'undefined' && process.env && process.env.NODE_ENV === 'test';
  const { id, eventId } = useLocalSearchParams<{ id: string; teamId?: string; eventId?: string }>();
  const router = useRouter();
  const { user: authUser, isAdmin: isAdminUser } = useAuth();
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme() ?? 'light';
  const {
    location,
    loading: _locLoading,
    error: _locError,
    permissionGranted,
    requestPermission,
    needsPreciseAccuracy,
    openSettings,
    refresh,
  } = useDeviceLocation();
  const scrollRef = useRef<any>(null);
  const sectionOffsets = useRef<{ media: number; posts: number }>({ media: 0, posts: 0 });

  const [vm, setVm] = useState<GameVM | null>(null);
  const [bannerPreviewOpen, setBannerPreviewOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [teams, setTeams] = useState<TeamInfo[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [rsvpBusy, setRsvpBusy] = useState(false);
  const [viewer, setViewer] = useState<{
    visible: boolean;
    url: string | null;
    kind: 'photo' | 'video';
  } | null>(null);
  const [storyBusy, setStoryBusy] = useState(false);
  const [storyPreview, setStoryPreview] = useState<{
    uri: string;
    mimeType: string;
    fileName: string;
    type: 'photo' | 'video';
    /** Picked-asset duration in seconds (ImagePicker reports ms) — drives the story cap. */
    durationS?: number;
  } | null>(null);
  const [storyTrimmedUri, setStoryTrimmedUri] = useState<string | null>(null);
  const canTrimStoryVideo = isNativeVideoTrimSupported(Platform.OS);
  const [verticalFeedOpen, setVerticalFeedOpen] = useState(false);
  const [storiesViewer, setStoriesViewer] = useState<{
    visible: boolean;
    items: MediaItem[];
    index: number;
  } | null>(null);
  const viewerOpenRef = useRef(false);
  const [seenStories, setSeenStories] = useState<Record<string, true>>({});
  const [nowTs, setNowTs] = useState(() => Date.now());
  const livePulse = useRef(new Animated.Value(0)).current;

  const [_voteSummary, setVoteSummary] = useState<VoteSummary | null>(null);
  const [voteBusy, setVoteBusy] = useState(false);
  const voteAnimated = useRef({ A: new Animated.Value(50), B: new Animated.Value(50) }).current;
  // micro-animation values for VS modal cards
  const vsScaleA = useRef(new Animated.Value(1)).current;
  const vsScaleB = useRef(new Animated.Value(1)).current;
  const pctAnimA = useRef(new Animated.Value(0)).current;
  const pctAnimB = useRef(new Animated.Value(0)).current;
  // animated numeric counters
  const numAnimA = useRef(new Animated.Value(0)).current;
  const numAnimB = useRef(new Animated.Value(0)).current;
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [displayPctA, setDisplayPctA] = useState(0);
  const [displayPctB, setDisplayPctB] = useState(0);
  // theme colors for VS modal
  const themeBgA = useThemeColor({ light: '#f8fafc', dark: '#0b1220' }, 'background');
  const themeBgOn = useThemeColor({ light: '#2563EB', dark: '#1f6feb' }, 'tint');
  const themeTextColor = useThemeColor({ light: '#0f172a', dark: '#e6eefc' }, 'text');
  const feedY = useRef(new Animated.Value(0)).current;
  const [headerH, setHeaderH] = useState(0);
  const THRESHOLD = useMemo(() => Math.max(24, headerH * 0.6), [headerH]);
  const [showTopFab, setShowTopFab] = useState(false);
  const [vsModalOpen, setVsModalOpen] = useState(false);
  const [loginPromptOpen, setLoginPromptOpen] = useState(false);
  const [editResultModalOpen, setEditResultModalOpen] = useState(false);
  const [editResultHomeScore, setEditResultHomeScore] = useState('');
  const [editResultAwayScore, setEditResultAwayScore] = useState('');
  const [editResultBusy, setEditResultBusy] = useState(false);
  const [preciseBannerDismissed, setPreciseBannerDismissed] = useState(false);
  const showTopFabRef = useRef(false);
  const currentUserIdRef = useRef<string | null>(null);
  const headerTranslateY = useMemo(
    () =>
      feedY.interpolate({
        inputRange: [0, headerH || 1],
        outputRange: [0, -(headerH || 1)],
        extrapolate: 'clamp',
      }),
    [feedY, headerH]
  );
  const headerOpacity = useMemo(
    () =>
      feedY.interpolate({
        inputRange: [0, (headerH || 1) * 0.7],
        outputRange: [1, 0],
        extrapolate: 'clamp',
      }),
    [feedY, headerH]
  );

  // Dynamic styles based on color scheme
  const styles = useMemo(() => createStyles(colorScheme), [colorScheme]);

  // Banner for precise location on Android
  const showPreciseBanner =
    Platform.OS === 'android' &&
    permissionGranted &&
    needsPreciseAccuracy &&
    !preciseBannerDismissed;

  useEffect(() => {
    showTopFabRef.current = false;
    setShowTopFab(false);
  }, [headerH]);

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled()
      .then(v => setPrefersReducedMotion(!!v))
      .catch(error => {
        if (__DEV__) console.warn('[GameDetails] Failed to read reduce-motion setting:', error);
      });
    const ev = AccessibilityInfo.addEventListener?.('reduceMotionChanged', (v: boolean) =>
      setPrefersReducedMotion(!!v)
    );
    return () => {
      try {
        ev?.remove?.();
      } catch (error) {
        if (__DEV__) console.warn('[GameDetails] Accessibility listener cleanup error:', error);
      }
    };
  }, []);

  // update display percentages from animated numeric values
  useEffect(() => {
    const idA = numAnimA.addListener(({ value }) => setDisplayPctA(Math.round(value)));
    const idB = numAnimB.addListener(({ value }) => setDisplayPctB(Math.round(value)));
    // initialize
    numAnimA.setValue(displayPctA);
    numAnimB.setValue(displayPctB);
    return () => {
      try {
        numAnimA.removeListener(idA);
      } catch (error) {
        if (__DEV__) console.warn('[GameDetails] Animation listener cleanup error:', error);
      }
      try {
        numAnimB.removeListener(idB);
      } catch (error) {
        if (__DEV__) console.warn('[GameDetails] Animation listener cleanup error:', error);
      }
    };
  }, [displayPctA, displayPctB, numAnimA, numAnimB]);

  // Track if the stories viewer is open to avoid unnecessary re-renders that can cause flicker on some devices
  useEffect(() => {
    viewerOpenRef.current = !!storiesViewer?.visible;
  }, [storiesViewer?.visible]);

  // Sync current user ID from auth context (no extra network call)
  useEffect(() => {
    currentUserIdRef.current = authUser?.id ?? null;
  }, [authUser?.id]);

  // Tick to update countdown/live status (paused while stories viewer is open or app backgrounded)
  useEffect(() => {
    if (isTestEnv) return;
    let intervalId: ReturnType<typeof setInterval> | null = null;
    const startTicking = () => {
      if (intervalId) return;
      intervalId = setInterval(() => {
        if (!viewerOpenRef.current) {
          setNowTs(Date.now());
        }
      }, 5000);
    };
    const stopTicking = () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };
    startTicking();
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') {
        setNowTs(Date.now());
        startTicking();
      } else stopTicking();
    });
    return () => {
      stopTicking();
      sub.remove();
    };
  }, [isTestEnv]);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const y = event.nativeEvent.contentOffset.y;
      if (THRESHOLD <= 0) return;
      if (!showTopFabRef.current && y >= THRESHOLD) {
        showTopFabRef.current = true;
        setShowTopFab(true);
      } else if (showTopFabRef.current && y < THRESHOLD) {
        showTopFabRef.current = false;
        setShowTopFab(false);
      }
    },
    [THRESHOLD]
  );

  const displayDate = formatDateLabel(vm?.date);
  const displayTime = formatTimeLabel(vm?.date);
  const goingCount = capCount(vm?.rsvpCount, vm?.capacity);
  // Force the Finals artwork whenever this matchup is detected, even if API banner/cover is missing
  const finalsBannerUrl = useMemo(() => {
    const title = (vm?.title || '').replace(/\s+/g, ' ').trim();
    let home = vm?.homeTeam || null;
    let away = vm?.awayTeam || null;

    if ((!home || !away) && title) {
      const parts = title
        .split(/\s+vs\.?\s+/i)
        .map(part => part.trim())
        .filter(Boolean);
      if (!home && parts[0]) home = parts[0];
      if (!away && parts[1]) away = parts[1];
    }

    return finalsBannerForTeams(home, away, title);
  }, [vm?.homeTeam, vm?.awayTeam, vm?.title]);

  const bannerUrl = useMemo(() => {
    if (finalsBannerUrl) return finalsBannerUrl;
    return pickBannerFromArrays(vm ?? {});
  }, [vm, finalsBannerUrl]);

  // Load teams data
  const loadTeams = async () => {
    try {
      const teamsData = await Team.list(undefined, undefined, { limit: 50 });
      const teamInfo: TeamInfo[] = teamsData.map((team: any) => ({
        id: team.id,
        name: team.name,
        avatarUrl: team.logo_url || team.avatar_url,
      }));
      setTeams(teamInfo);
    } catch (error) {
      if (__DEV__) console.error('Failed to load teams:', error);
    }
  };

  // Get team logo by name
  const { findBestMatch } = require('../../utils/teamMatch');
  const getTeamLogo = (teamName: string) => {
    if (!teamName) return null;
    // Prefer vm.teams (from backend payload) for accurate avatars
    const fromVm = vm?.teams?.find(
      t => String(t.name || '').toLowerCase() === String(teamName || '').toLowerCase()
    );
    if (fromVm && fromVm.avatarUrl) return fromVm.avatarUrl;
    // try exact case-insensitive match first
    const exact = (teams || []).find(
      (t: any) => String(t.name || '').toLowerCase() === String(teamName || '').toLowerCase()
    );
    if (exact && exact.avatarUrl) return exact.avatarUrl;
    const matched = findBestMatch(teamName, teams as any);
    return matched?.avatarUrl || null;
  };

  // Derive game phase from date and now
  const { phase: gamePhase, diffMs: startsInMs } = useMemo(() => {
    const iso = vm?.date;
    if (!iso) return { phase: 'final' as 'upcoming' | 'live' | 'active' | 'final', diffMs: 0 };
    const startMs = new Date(iso).getTime();
    if (!Number.isFinite(startMs)) return { phase: 'final' as const, diffMs: 0 };
    const diff = startMs - nowTs;
    return {
      phase: getEventPresentationPhase(iso, nowTs),
      diffMs: diff > 0 ? diff : 0,
    };
  }, [vm?.date, nowTs]);

  const canShowVoteSection = useMemo(
    () => canShowGamePoll({ gameId: vm?.gameId, eventType: vm?.eventType }),
    [vm?.eventType, vm?.gameId]
  );

  // Keep event-page interactions active through the end of the event day.
  const isVoteOpen = useMemo(() => {
    return !isEventPastEndOfDay(vm?.date, nowTs);
  }, [vm?.date, nowTs]);

  // RSVP only shown before the game starts
  const hasEvent = !!vm?.eventId;
  const canRsvpNow = hasEvent && gamePhase === 'upcoming';
  // Smart RSVP bottom sheet state
  const [rsvpSheetOpen, setRsvpSheetOpen] = useState(false);

  const rsvpChipLabel = useMemo(() => {
    if (!hasEvent) return null;
    const n = goingCount != null ? goingCount : 0;
    if (gamePhase === 'upcoming') return vm?.userRsvped ? `Going • ${n}` : `RSVP • ${n}`;
    if (gamePhase === 'live') return `${n} going`;
    return `${n} went`;
  }, [hasEvent, goingCount, gamePhase, vm?.userRsvped]);

  const openRsvpSheet = useCallback(() => {
    if (!hasEvent) return;
    setRsvpSheetOpen(true);
  }, [hasEvent]);

  const closeRsvpSheet = useCallback(() => setRsvpSheetOpen(false), []);

  // Start/stop pulse when LIVE
  useEffect(() => {
    if (gamePhase !== 'live') {
      livePulse.stopAnimation();
      livePulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(livePulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(livePulse, { toValue: 0, duration: 700, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => {
      loop.stop();
    };
  }, [gamePhase, livePulse]);

  const formatCountdown = useCallback((ms: number) => {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const two = (n: number) => n.toString().padStart(2, '0');
    if (days >= 1) {
      return `${days}d ${two(hours)}:${two(minutes)}:${two(seconds)}`;
    }
    return `${two(hours)}:${two(minutes)}:${two(seconds)}`;
  }, []);

  const postsCount = Array.isArray(vm?.posts) ? vm.posts.length : 0;
  const postsSubtitle = postsCount
    ? `${postsCount} highlight${postsCount === 1 ? '' : 's'}`
    : 'No highlights yet';

  // Scrapbook preview: a stable-shuffled mix of 2-across and 3-across rows,
  // capped at 12 (the rest are behind "View All Posts"). The seed is per
  // event+day, so the arrangement is fresh on a new day but never reshuffles
  // under the user's thumb — scrolling, refetching, or returning from
  // post-detail all rebuild the identical plan. See utils/eventPostGrid.ts.
  const scrapbookSeed = useMemo(() => eventScrapbookSeed(vm?.gameId), [vm?.gameId]);
  const scrapbookPlan = useMemo(
    () => buildEventScrapbookPlan(Array.isArray(vm?.posts) ? vm.posts : [], scrapbookSeed),
    [vm?.posts, scrapbookSeed]
  );

  const { teamALabel, teamBLabel } = useMemo(() => {
    const home = vm?.homeTeam?.trim();
    const away = vm?.awayTeam?.trim();
    if (home && away) return { teamALabel: home, teamBLabel: away };
    const title = (vm?.title || '').replace(/\s+/g, ' ').trim();
    if (title) {
      const parts = title
        .split(/\s+vs\.?\s+/i)
        .map(part => part.trim())
        .filter(Boolean);
      if (parts.length >= 2) {
        return { teamALabel: parts[0], teamBLabel: parts[1] };
      }
    }
    return { teamALabel: 'Team A', teamBLabel: 'Team B' };
  }, [vm?.homeTeam, vm?.awayTeam, vm?.title]);

  const replaceToCanonicalGame = useCallback(
    (gameIdValue: string) => {
      // nav-safe: canonical-page bounce — a push here leaves a dead virtual
      // frame (vm never set) in the stack; on web, backing into it re-runs
      // load() and pushes forward again, trapping the back button.
      replaceAsRedirect(router, { pathname: '/game/[id]', params: { id: gameIdValue } });
    },
    [router]
  );

  const mapTeams = (input: any): TeamInfo[] => {
    if (!Array.isArray(input)) return [];
    return input
      .map((team: any) => ({
        id: String(team.id ?? team.team_id ?? ''),
        name: String(team.name ?? team.team_name ?? 'Team'),
        avatarUrl: team.avatarUrl ?? team.avatar_url ?? null,
      }))
      .filter(team => team.id);
  };

  const loadGameById = useCallback(async (gameIdValue: string) => {
    // NOTE (2026-07-09): this used to short-circuit `sample-` ids into a fully
    // FABRICATED game — "Team A vs Team B" + hardcoded Unsplash stock photos as
    // fake stories, with NO __DEV__ gate, so a crafted deep link rendered fake
    // content in production. The sample-content system is retired: nothing
    // in-app emits sample- ids (the DB-backed [DEMO_MATCHUP] system replaced
    // it), so a stray sample- id now falls through to the normal fetch and
    // lands on the standard "unavailable" state. Do not reintroduce fabricated
    // content here.
    try {
      // eslint-disable-next-line no-console
      if (__DEV__) console.log('[GameDetails] loadGameById() — fetching summary for', gameIdValue);
      const summary: any = await retryWithBackoff(
        () =>
          // Route the primary summary fetch through react-query so a game
          // prefetched on press-in (or revisited within staleTime) resolves
          // from a warm cache instantly. retry:0 keeps the original
          // single-attempt intent — the .catch below still falls back to
          // Game.get on recoverable failures.
          queryClient.fetchQuery({
            queryKey: ['game-summary', gameIdValue],
            queryFn: () => Game.summary(gameIdValue),
            retry: 0,
          }),
        {
          maxRetries: 0,
          initialDelayMs: 800,
          maxDelayMs: 4000,
        }
      ).catch((err: any) => {
        // eslint-disable-next-line no-console
        if (__DEV__)
          console.warn('[GameDetails] summary fetch failed:', {
            status: err?.status,
            message: err?.message,
          });
        if (err && err.status === 404) return null;
        // Treat transport / infra failures as recoverable and fall back to Game.get.
        if (err?.status === 0 || err?.status === 408 || err?.isNetworkError || err?.status >= 500) {
          // eslint-disable-next-line no-console
          if (__DEV__)
            console.warn(
              '[game-details] summary unavailable, falling back to game record:',
              err?.message
            );
          return null;
        }
        throw err;
      });
      // eslint-disable-next-line no-console
      if (__DEV__) console.log('[GameDetails] summary result:', summary ? 'ok' : 'null');

      let gameRecord: any = null;
      if (!summary) {
        // eslint-disable-next-line no-console
        if (__DEV__) console.log('[GameDetails] no summary — trying Game.get() fallback');
        // Only attempt record fetch if summary missing; suppress 404 noise
        gameRecord = await retryWithBackoff(() => Game.get(gameIdValue), {
          maxRetries: 0,
          initialDelayMs: 800,
          maxDelayMs: 4000,
        }).catch((err: any) => {
          // eslint-disable-next-line no-console
          if (__DEV__)
            console.warn('[GameDetails] Game.get() fallback failed:', {
              status: err?.status,
              message: err?.message,
            });
          if (err && err.status === 404) return null;
          // eslint-disable-next-line no-console
          if (__DEV__) console.warn('Game record fetch failed:', err?.message || err);
          return null;
        });
        // eslint-disable-next-line no-console
        if (__DEV__) console.log('[GameDetails] Game.get() result:', gameRecord ? 'ok' : 'null');
      }
      // If neither summary nor record exists, bail out to show error UI
      if (!summary && !gameRecord) {
        if (__DEV__)
          console.warn(
            '[GameDetails] Both summary and gameRecord are null — throwing "Game not found"'
          );
        throw new Error('Game not found');
      }

      const postsData: any[] = Array.isArray(summary?.posts) ? summary.posts : [];
      const mediaData: any[] = Array.isArray(summary?.media) ? summary.media : [];

      let eventIdValue: string | null = null;
      let location: string | null = null;
      let description: string | null = null;
      let bannerCandidate: string | null = null;
      let venuePhotoUrl: string | null = null;
      let venuePhotoCredit: string | null = null;
      let cover: string | null = null;
      let capacity: number | null = null;
      let rsvpCount: number | null = null;
      let userRsvped = false;
      let reviewsCount: number | null = null;
      let isPast = false;
      let teams: TeamInfo[] = [];
      let dateIso: string | null = null;
      let title = '';
      let homeTeam: string | null = null;
      let awayTeam: string | null = null;
      let appearance: string | null = null;
      let eventType: string | null = null;

      if (summary) {
        eventIdValue = summary.eventId ?? summary.event_id ?? summary.event?.id ?? null;
        location = summary.location ?? summary.event?.location ?? null;
        description = summary.description ?? null;
        bannerCandidate = summary.bannerUrl ?? null;
        const summaryVenuePhoto =
          (summary as any)?.venue_photo ?? (summary as any)?.event?.venue_photo;
        if (summaryVenuePhoto && typeof summaryVenuePhoto === 'object') {
          venuePhotoUrl =
            typeof summaryVenuePhoto.url === 'string' ? summaryVenuePhoto.url : venuePhotoUrl;
          venuePhotoCredit =
            typeof summaryVenuePhoto.credit === 'string'
              ? summaryVenuePhoto.credit
              : venuePhotoCredit;
        }
        cover = summary.coverImageUrl ?? null;
        capacity =
          typeof summary.capacity === 'number'
            ? summary.capacity
            : (summary.event?.capacity ?? null);
        rsvpCount = typeof summary.rsvpCount === 'number' ? summary.rsvpCount : null;
        userRsvped = Boolean(summary.userRsvped);
        reviewsCount = typeof summary.reviewsCount === 'number' ? summary.reviewsCount : null;
        isPast = Boolean(summary.isPast);
        teams = mapTeams(summary.teams);
        dateIso = ensureIso(summary.date);
        title = summary.title ?? '';
        // Extract team names - handle both string and object formats
        const summaryHome = summary.homeTeam ?? summary.home_team ?? null;
        const summaryAway = summary.awayTeam ?? summary.away_team ?? null;
        homeTeam =
          typeof summaryHome === 'string' ? summaryHome : (summaryHome as any)?.name || null;
        awayTeam =
          typeof summaryAway === 'string' ? summaryAway : (summaryAway as any)?.name || null;
        // Appearance field surfaced from backend
        appearance = (summary as any)?.appearance ?? (summary.event as any)?.appearance ?? null;
        eventType = (summary as any)?.event_type ?? (summary.event as any)?.event_type ?? null;
      }

      let homeScore: number | null = null;
      let awayScore: number | null = null;
      let canEditResult = false;
      if (summary) {
        homeScore =
          typeof (summary as any).home_score === 'number' ? (summary as any).home_score : null;
        awayScore =
          typeof (summary as any).away_score === 'number' ? (summary as any).away_score : null;
        canEditResult = Boolean((summary as any).can_edit_result);
      }

      if (!summary && gameRecord) {
        eventIdValue = (gameRecord as any).event_id ?? null;
        location = gameRecord.location || null;
        description = gameRecord.description || null;
        bannerCandidate = gameRecord.banner_url || null; // Check game banner_url first
        const recordVenuePhoto = (gameRecord as any)?.venue_photo;
        if (recordVenuePhoto && typeof recordVenuePhoto === 'object') {
          venuePhotoUrl = typeof recordVenuePhoto.url === 'string' ? recordVenuePhoto.url : null;
          venuePhotoCredit =
            typeof recordVenuePhoto.credit === 'string' ? recordVenuePhoto.credit : null;
        }
        cover = gameRecord.cover_image_url || null;
        dateIso = ensureIso(gameRecord.date) ?? null;
        title = gameRecord.title || '';
        isPast = computeIsPast(dateIso);
        // Extract team names - handle both string and object formats
        homeTeam =
          typeof gameRecord.home_team === 'string'
            ? gameRecord.home_team
            : (gameRecord.home_team as any)?.name || null;
        awayTeam =
          typeof gameRecord.away_team === 'string'
            ? gameRecord.away_team
            : (gameRecord.away_team as any)?.name || null;

        // Build teams array from homeTeam and awayTeam relations
        const teamsArray: TeamInfo[] = [];
        if (gameRecord.homeTeam && typeof gameRecord.homeTeam === 'object') {
          teamsArray.push({
            id: gameRecord.homeTeam.id,
            name: gameRecord.homeTeam.name,
            avatarUrl: (gameRecord.homeTeam as any).avatar_url || null,
          });
        }
        if (gameRecord.awayTeam && typeof gameRecord.awayTeam === 'object') {
          teamsArray.push({
            id: gameRecord.awayTeam.id,
            name: gameRecord.awayTeam.name,
            avatarUrl: (gameRecord.awayTeam as any).avatar_url || null,
          });
        }
        teams = teamsArray;
        // Appearance from game record if present
        appearance = (gameRecord as any)?.appearance ?? null;
        eventType = (gameRecord as any)?.event_type ?? eventType;
        homeScore =
          typeof (gameRecord as any).home_score === 'number'
            ? (gameRecord as any).home_score
            : null;
        awayScore =
          typeof (gameRecord as any).away_score === 'number'
            ? (gameRecord as any).away_score
            : null;
        canEditResult = Boolean((gameRecord as any).can_edit_result);
      }

      if (!title) title = 'Game';
      if (!dateIso && gameRecord?.date) dateIso = ensureIso(gameRecord.date);
      if (!isPast) isPast = computeIsPast(dateIso);
      if (!bannerCandidate && summary?.event?.banner_url)
        bannerCandidate = summary.event.banner_url;
      if (!bannerCandidate && gameRecord?.banner_url) bannerCandidate = gameRecord.banner_url; // Fallback to game banner
      if (!bannerCandidate && venuePhotoUrl) bannerCandidate = venuePhotoUrl;

      let deferredEventPromise: Promise<any> | null = null;
      let deferredRsvpPromise: Promise<any> | null = null;
      let deferredPostsPromise: Promise<any> | null = null;
      let deferredMediaPromise: Promise<any> | null = null;
      if (eventIdValue) {
        // Do not block first render on event-detail hydration.
        deferredEventPromise = retryWithBackoff(() => Event.get(eventIdValue), {
          maxRetries: 0,
          initialDelayMs: 800,
          maxDelayMs: 4000,
        }).catch(() => null);

        // Do not block first render on RSVP status; hydrate it asynchronously.
        deferredRsvpPromise = retryWithBackoff(() => Event.rsvpStatus(eventIdValue), {
          maxRetries: 0,
          initialDelayMs: 800,
          maxDelayMs: 4000,
        }).catch(() => null);
      }
      // Do not block first render on posts/media. Retry transient failures —
      // a swallowed network blip used to leave past-event pages stuck on
      // "No highlights yet" even when the game had posts.
      deferredPostsPromise = retryWithBackoff(
        () => Post.feedForGame(gameIdValue, { limit: 20, sort: 'newest' }),
        {
          maxRetries: 2,
          initialDelayMs: 800,
          maxDelayMs: 4000,
        }
      ).catch(err => {
        if (__DEV__)
          console.warn('[GameDetails] deferred posts fetch failed:', err?.message || err);
        return null;
      });
      deferredMediaPromise = retryWithBackoff(() => Game.media(gameIdValue), {
        maxRetries: 2,
        initialDelayMs: 800,
        maxDelayMs: 4000,
      }).catch(err => {
        if (__DEV__)
          console.warn('[GameDetails] deferred media fetch failed:', err?.message || err);
        return null;
      });

      // Extract venue coordinates for proactive geofencing
      const rawLat =
        (summary as any)?.latitude ??
        (summary as any)?.event?.latitude ??
        (gameRecord as any)?.latitude ??
        null;
      const rawLng =
        (summary as any)?.longitude ??
        (summary as any)?.event?.longitude ??
        (gameRecord as any)?.longitude ??
        null;

      const vmPayload: GameVM = {
        id: gameIdValue,
        gameId: gameIdValue,
        eventId: eventIdValue,
        title,
        date: dateIso ?? new Date().toISOString(),
        location,
        description,
        bannerUrl: bannerCandidate,
        venuePhotoUrl,
        venuePhotoCredit,
        appearance,
        coverImageUrl: cover,
        homeTeam,
        awayTeam,
        capacity: capacity ?? null,
        rsvpCount: rsvpCount ?? null,
        userRsvped,
        teams,
        posts: postsData,
        media: mediaData,
        reviewsCount,
        isPast,
        eventType,
        home_score: homeScore,
        away_score: awayScore,
        can_edit_result: canEditResult,
        venueLat: typeof rawLat === 'number' ? rawLat : null,
        venueLng: typeof rawLng === 'number' ? rawLng : null,
        starts_at: (summary as any)?.starts_at ?? (gameRecord as any)?.starts_at ?? null,
        live_from: (summary as any)?.live_from ?? (gameRecord as any)?.live_from ?? null,
        live_until: (summary as any)?.live_until ?? (gameRecord as any)?.live_until ?? null,
      };

      setVm(vmPayload);

      if (eventIdValue && deferredEventPromise) {
        void deferredEventPromise.then((eventDetails: any) => {
          if (!eventDetails) return;
          setVm(prev => {
            if (!prev || prev.gameId !== gameIdValue) return prev;
            const eventVenuePhoto = getVenuePhoto(eventDetails.venue_photo);
            return {
              ...prev,
              location: prev.location || eventDetails.location || null,
              bannerUrl:
                prev.bannerUrl ||
                eventDetails.banner_url ||
                eventDetails.cover_image_url ||
                eventVenuePhoto.url ||
                null,
              venuePhotoUrl: prev.venuePhotoUrl || eventVenuePhoto.url,
              venuePhotoCredit: prev.venuePhotoCredit || eventVenuePhoto.credit,
              appearance: prev.appearance || (eventDetails as any)?.appearance || null,
              capacity:
                typeof prev.capacity === 'number'
                  ? prev.capacity
                  : typeof eventDetails.capacity === 'number'
                    ? eventDetails.capacity
                    : prev.capacity,
              rsvpCount:
                typeof prev.rsvpCount === 'number'
                  ? prev.rsvpCount
                  : typeof eventDetails.attendees_count === 'number'
                    ? eventDetails.attendees_count
                    : prev.rsvpCount,
            };
          });
        });
      }

      if (eventIdValue && deferredRsvpPromise) {
        void deferredRsvpPromise.then((rsvp: any) => {
          if (!rsvp) return;
          setVm(prev => {
            if (!prev || prev.gameId !== gameIdValue) return prev;
            return {
              ...prev,
              rsvpCount: typeof rsvp.count === 'number' ? rsvp.count : prev.rsvpCount,
              capacity: typeof rsvp.capacity === 'number' ? rsvp.capacity : prev.capacity,
              userRsvped: 'going' in rsvp ? Boolean(rsvp.going) : Boolean((rsvp as any).attending),
            };
          });
        });
      }
      if (deferredPostsPromise) {
        void deferredPostsPromise.then((postsResult: any) => {
          if (!postsResult) return;
          const nextPosts = Array.isArray(postsResult) ? postsResult : postsResult?.items;
          if (!Array.isArray(nextPosts)) return;
          setVm(prev => {
            if (!prev || prev.gameId !== gameIdValue) return prev;
            return { ...prev, posts: nextPosts };
          });
        });
      }
      if (deferredMediaPromise) {
        void deferredMediaPromise.then((mediaResult: any) => {
          if (!mediaResult) return;
          const nextMedia = Array.isArray(mediaResult) ? mediaResult : mediaResult?.items;
          if (!Array.isArray(nextMedia)) return;
          setVm(prev => {
            if (!prev || prev.gameId !== gameIdValue) return prev;
            return { ...prev, media: nextMedia };
          });
        });
      }
    } catch (error: any) {
      if (__DEV__)
        console.error('[GameDetails] loadGameById() inner catch:', {
          message: error?.message,
          status: error?.status,
          data: error?.data,
          name: error?.name,
        });
      throw error; // Re-throw to be caught by outer try-catch
    }
  }, []);

  const loadVirtualFromEvent = useCallback(
    async (eventIdValue: string) => {
      const event = await Event.get(eventIdValue);
      if (event?.game_id) {
        replaceToCanonicalGame(String(event.game_id));
        return;
      }
      const eventVenuePhoto = getVenuePhoto((event as any)?.venue_photo);
      const dateIso = ensureIso(event?.date) ?? new Date().toISOString();
      const vmPayload: GameVM = {
        id: `event-${eventIdValue}`,
        gameId: null,
        eventId: eventIdValue,
        title: event?.title || 'Event',
        date: dateIso,
        location: event?.location || null,
        description: event?.description || null,
        bannerUrl: event?.banner_url || event?.cover_image_url || eventVenuePhoto.url || null,
        venuePhotoUrl: eventVenuePhoto.url,
        venuePhotoCredit: eventVenuePhoto.credit,
        coverImageUrl: event?.cover_image_url || null,
        homeTeam: null,
        awayTeam: null,
        capacity: event?.capacity ?? null,
        rsvpCount: event?.attendees_count ?? null,
        userRsvped: false,
        teams: [],
        posts: [],
        media: [],
        reviewsCount: null,
        isPast: computeIsPast(dateIso),
        eventType: event?.event_type ?? null,
      };
      setVm(vmPayload);

      // Hydrate RSVP in the background so event details can render immediately.
      void retryWithBackoff(() => Event.rsvpStatus(eventIdValue), {
        maxRetries: 0,
        initialDelayMs: 800,
        maxDelayMs: 4000,
      })
        .then((rsvp: any) => {
          if (!rsvp) return;
          setVm(prev => {
            if (!prev || prev.eventId !== eventIdValue || prev.gameId) return prev;
            return {
              ...prev,
              rsvpCount: typeof rsvp.count === 'number' ? rsvp.count : prev.rsvpCount,
              capacity: typeof rsvp.capacity === 'number' ? rsvp.capacity : prev.capacity,
              userRsvped: Boolean(rsvp.going ?? rsvp.attending),
            };
          });
        })
        .catch(error => {
          if (__DEV__) console.warn('[GameDetails] RSVP hydration failed:', error);
        });

      // H1 fix (2026-07-14): the rich page must actually fetch a standalone
      // event's posts/media. Previously loadVirtualFromEvent left posts:[]/
      // media:[] so a fan's posts to an event were invisible here (while the
      // deprecated bare page did fetch them). Mirror the game path: hydrate
      // posts via Post.getByEvent and derive the media grid from them.
      void retryWithBackoff(() => Post.getByEvent(eventIdValue), {
        maxRetries: 2,
        initialDelayMs: 800,
        maxDelayMs: 4000,
      })
        .then((postsResult: any) => {
          const items = Array.isArray(postsResult)
            ? postsResult
            : Array.isArray(postsResult?.items)
              ? postsResult.items
              : [];
          if (!items.length) return;
          const media: MediaItem[] = items
            .filter((p: any) => p?.media_url)
            .map((p: any) => {
              const url = String(p.media_url);
              const isVideo = VIDEO_EXT.test(url.toLowerCase());
              return {
                id: String(p.id),
                url,
                thumbnail_url: p.preview_url || undefined,
                kind: isVideo ? 'video' : 'photo',
                created_at: p.created_at,
                caption: p.caption ?? p.content ?? null,
                user_id: p.author?.id ?? p.author_id ?? null,
              } as MediaItem;
            });
          setVm(prev => {
            if (!prev || prev.eventId !== eventIdValue || prev.gameId) return prev;
            return { ...prev, posts: items, media };
          });
        })
        .catch(error => {
          if (__DEV__) console.warn('[GameDetails] event posts hydration failed:', error);
        });
    },
    [replaceToCanonicalGame]
  );

  const handleAddStory = useCallback(async () => {
    if (!vm?.gameId || storyBusy) return;

    // Signed-out fans must sign in first. Without this guard the upload runs
    // and 401s at the requireAuth-gated Cloudinary signature endpoint, which
    // surfaces a misleading "Upload Failed — we couldn't authorize this upload"
    // alert (reads like the app is broken). Mirror the Posts "+" / RSVP gates.
    if (!authUser) {
      promptForSignIn(() => router.push('/sign-in'), {
        message: 'Sign in to post a story to this event.',
      });
      return;
    }

    if (permissionGranted) {
      await refresh();
    }

    // Proactive distance check — warn user before they capture media.
    // Seeded [DEMO_MATCHUP] games (Duke v UNC, Cavs v Warriors) bypass the
    // 3km check here because the server's story carve-out already accepts
    // them regardless of distance.
    const vmDescription = typeof vm.description === 'string' ? vm.description : '';
    const isDemoMatchup = vmDescription.includes(DEMO_MATCHUP_TAG);
    // First-post-unlocks-7-days (owner rule 2026-07-15): a user who already
    // posted/storied to this event page may keep uploading without re-passing
    // the geofence — skip the client preflight blocks and let the server
    // (which holds the authoritative unlock ledger) decide.
    const hasPostingUnlock = await hasLocalEventPostingUnlock([vm.gameId, vm.eventId]);
    if (
      !isDemoMatchup &&
      !isAdminUser &&
      !hasPostingUnlock &&
      location?.latitude &&
      location?.longitude
    ) {
      const venueLat = vm.venueLat;
      const venueLng = vm.venueLng;
      if (typeof venueLat === 'number' && typeof venueLng === 'number') {
        const toRad = (d: number) => (d * Math.PI) / 180;
        const dLat = toRad(venueLat - location.latitude);
        const dLon = toRad(venueLng - location.longitude);
        const a =
          Math.sin(dLat / 2) ** 2 +
          Math.cos(toRad(location.latitude)) * Math.cos(toRad(venueLat)) * Math.sin(dLon / 2) ** 2;
        const distKm = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        if (distKm > 3) {
          const distMi = (distKm * 0.621371).toFixed(1);
          Alert.alert(
            'Too Far From Venue',
            `You're ${distMi} mi away. Stories require you to be within 3 km of the venue.`,
            [{ text: 'OK' }]
          );
          return;
        }
      }
    }

    // Request permissions first
    const { status: cameraStatus } = await ImagePicker.requestCameraPermissionsAsync();
    const { status: mediaStatus } = await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (cameraStatus !== 'granted' || mediaStatus !== 'granted') {
      Alert.alert(
        'Permission Required',
        'You need to grant camera and photo library permissions to add a story.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: () => Linking.openSettings() },
        ]
      );
      return;
    }

    // Request location permission for story tagging
    if (!permissionGranted || (Platform.OS === 'android' && needsPreciseAccuracy)) {
      const granted = await requestPermission();
      if (!granted) {
        // If the game has a linked event and it's not a demo, location is REQUIRED
        // by the server for a FIRST story. Block early to avoid wasting a
        // Cloudinary upload — unless the user already holds a posting unlock,
        // in which case the server accepts stories without location.
        if (hasEvent && !isDemoMatchup && !isAdminUser && !hasPostingUnlock) {
          Alert.alert(
            'Location Required',
            'Location access is required to post stories at live events. Enable it in Settings to continue.',
            [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Open Settings', onPress: () => Linking.openSettings() },
            ]
          );
          return;
        }
        Alert.alert(
          'Location Permission',
          'Stories can still post without location, but pins and discovery will be less accurate until you enable it.',
          [
            { text: 'Cancel', style: 'cancel' },
            { text: 'Open Settings', onPress: () => Linking.openSettings() },
          ]
        );
      }
      if (Platform.OS === 'android' && needsPreciseAccuracy) {
        Alert.alert(
          'Enable Precise Location',
          'To tag stories to this game automatically, allow precise location in Android settings.',
          [
            { text: 'Skip', style: 'cancel', onPress: () => {} },
            {
              text: 'Open settings',
              onPress: () => {
                setPreciseBannerDismissed(true);
                void openSettings();
              },
            },
          ]
        );
      }
    }

    try {
      setStoryBusy(true);
      const pickerOptions: ImagePicker.ImagePickerOptions = {
        ...pickerAllMediaTypesProp(),
        quality: 0.8,
        videoExportPreset: VIDEO_CAPTURE_PRESET,
        // Stops camera recording at the story cap; library picks are enforced
        // via the trimmer + confirmStoryUpload gate below.
        videoMaxDuration: STORY_MAX_DURATION_S,
      };
      // Demo matchups (Duke v UNC, Cavs v Warriors) let fans upload from the
      // camera roll as well — they're not physically at Chase Center or Cameron
      // Indoor, so the camera-only rule for geofenced events doesn't apply.
      let result: ImagePicker.ImagePickerResult;
      if (isDemoMatchup) {
        const source = await new Promise<'camera' | 'library' | null>(resolve => {
          Alert.alert(
            'Add to Story',
            'Choose a source for your story.',
            [
              { text: 'Camera', onPress: () => resolve('camera') },
              { text: 'Photo Library', onPress: () => resolve('library') },
              { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
            ],
            { cancelable: true, onDismiss: () => resolve(null) }
          );
        });
        if (!source) {
          setStoryBusy(false);
          return;
        }
        result =
          source === 'library'
            ? await ImagePicker.launchImageLibraryAsync(pickerOptions)
            : await ImagePicker.launchCameraAsync(pickerOptions);
      } else {
        result = await ImagePicker.launchCameraAsync(pickerOptions);
      }
      if (!result || result.canceled || !result.assets || !result.assets.length) return;

      const asset = result.assets[0];
      const materializedUri = await materializeICloudAssetIfNeeded(asset.uri);
      const mimeType = asset.mimeType || (asset.type === 'video' ? 'video/mp4' : 'image/jpeg');
      const fileName =
        asset.fileName ||
        asset.uri.split('/').pop() ||
        (mimeType.startsWith('video') ? 'story.mp4' : 'story.jpg');

      // For videos, show trim preview before uploading
      if (asset.type === 'video') {
        // Pick-time SANITY ceiling, not the 150MB upload cap: this is the
        // pre-compression file, and prepareVideoForUpload re-checks the real
        // MAX_VIDEO_SIZE_BYTES cap on the bytes we actually send. See the
        // MAX_PICKED_VIDEO_SIZE_BYTES rationale in constants/video.ts.
        const pickedSize = asset.fileSize || (await getVideoFileSize(materializedUri));
        if (pickedSize > MAX_PICKED_VIDEO_SIZE_BYTES) {
          Alert.alert(
            'File Too Large',
            `This video is ${Math.round(pickedSize / (1024 * 1024))}MB, which is too big to process on your phone. Record a shorter clip and try again.`
          );
          return;
        }
        setStoryPreview({
          uri: materializedUri,
          mimeType,
          fileName,
          type: 'video',
          durationS: typeof asset.duration === 'number' ? asset.duration / 1000 : undefined,
        });
        setStoryTrimmedUri(null);
        return; // Upload will happen via confirmStoryUpload
      }

      const base = getApiBaseUrl();
      let uri = materializedUri;
      const ensured = await (
        await import('../../utils/ensureUploadableUri')
      ).ensureUploadableUri(uri, mimeType);
      uri = ensured.uri;

      const uploaded = await uploadFile(base, uri, fileName, ensured.mimeType || mimeType);
      const mediaUrl = uploaded?.path || uploaded?.url;
      if (!mediaUrl) {
        throw new Error('Upload failed');
      }
      {
        const gameId = vm.gameId;
        if (!gameId) throw new Error('Could not resolve the game for this story');
        const storyPayload: any = { media_url: mediaUrl };
        if (location?.latitude && location?.longitude) {
          storyPayload.location = {
            lat: location.latitude,
            lng: location.longitude,
            source: 'device',
          };
        }
        await Game.addStory(gameId, storyPayload);
        // Mirror the server's posting unlock locally so preflight prompts
        // don't re-block this user on their next upload to this event page.
        void recordEventPostingUnlock([gameId, vm.eventId]);
        analytics.track(ANALYTICS_EVENTS.STORY_ADDED, { game_id: gameId });
        try {
          await loadGameById(gameId);
          Alert.alert('Added', 'Story added to this game.');
        } catch (reloadErr: any) {
          if (__DEV__)
            console.warn('[story] Camera - reload failed but story was uploaded:', reloadErr);
          Alert.alert('Added', 'Story added to this game. Refresh to see it.');
        }
      }
    } catch (err: any) {
      const status = err?.status;
      const code = err?.data?.error || '';
      const serverMsg = err?.data?.message || '';
      const message = String(err?.message || code || '');
      if (status === 401 || /unauthorized/i.test(message)) {
        showUploadErrorAlert(err, {
          fallbackTitle: 'Unable to add story',
          fallbackMessage: 'Please sign in again to upload stories.',
          logTag: 'story.upload.photo',
        });
      } else if (code === 'POSTING_WINDOW_CLOSED') {
        Alert.alert('Not Yet', serverMsg || 'The story posting window is not open for this event.');
      } else if (code === 'TOO_FAR_FROM_VENUE') {
        const dist = err?.data?.distance;
        Alert.alert(
          'Too Far',
          serverMsg ||
            `You need to be within 3 km of the venue.${dist ? ` You're ${dist.toFixed(1)} km away.` : ''}`
        );
      } else if (code === 'LOCATION_REQUIRED') {
        Alert.alert('Location Required', 'Enable location access to post stories at this event.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: () => Linking.openSettings() },
        ]);
      } else if (code === 'NO_EVENT_LOCATION') {
        Alert.alert(
          'Cannot Verify Location',
          'This game has no event location set yet, so story uploads are disabled until the venue is configured.'
        );
      } else {
        if (__DEV__) console.error('Story upload error:', err);
        Alert.alert('Unable to add story', toUserMessage(err, 'Please try again.'));
      }
    } finally {
      setStoryBusy(false);
    }
  }, [
    authUser,
    router,
    hasEvent,
    isAdminUser,
    loadGameById,
    storyBusy,
    vm?.description,
    vm?.gameId,
    vm?.eventId,
    vm?.venueLat,
    vm?.venueLng,
    location?.latitude,
    location?.longitude,
    permissionGranted,
    requestPermission,
    needsPreciseAccuracy,
    openSettings,
  ]);

  const confirmStoryUpload = useCallback(async () => {
    if (!storyPreview || !vm?.gameId) return;
    // Story cap: an over-limit pick must be trimmed (the trimmer clamps its
    // window to the cap) before it can upload. Keeps the preview modal open.
    if (
      !storyTrimmedUri &&
      typeof storyPreview.durationS === 'number' &&
      storyPreview.durationS > STORY_MAX_DURATION_S + 0.25
    ) {
      Alert.alert(
        'Story Too Long',
        `Stories are limited to ${STORY_MAX_DURATION_S} seconds. Use the trimmer to pick your best ${STORY_MAX_DURATION_S} seconds.`
      );
      return;
    }
    setStoryBusy(true);
    try {
      const base = getApiBaseUrl();
      // This callback only handles videos (images upload inline in the picker
      // handler). Prepare the final asset once, right before upload.
      const rawUri = storyTrimmedUri || storyPreview.uri;
      const prepared = await prepareVideoForUpload(rawUri);
      const uploadUri = prepared.uri;
      const ensured = await (
        await import('../../utils/ensureUploadableUri')
      ).ensureUploadableUri(uploadUri, storyPreview.mimeType);
      const uploaded = await uploadFile(
        base,
        ensured.uri,
        storyPreview.fileName,
        ensured.mimeType || storyPreview.mimeType,
        { timeoutMs: uploadTimeoutMsForSize(prepared.finalSizeBytes) }
      );
      const mediaUrl = uploaded?.path || uploaded?.url;
      if (!mediaUrl) throw new Error('Upload failed');

      // R2 stores bytes verbatim, so the server can't derive a preview from the
      // video URL the way it can for Cloudinary. Generate a first-frame poster
      // on-device and upload it alongside the video, same as the post create
      // path — otherwise the story tile renders black until the lazy
      // server-side backfill lands on a later fetch. Best-effort: a story
      // without a poster still uploads fine.
      let posterUrl = '';
      if ((uploaded as any)?.provider === 'r2') {
        try {
          // Dynamic require, same OTA-safety pattern as create-post.tsx — never
          // crash a binary built before the module existed.
          let VideoThumbnails: any = null;
          try {
            VideoThumbnails = require('expo-video-thumbnails');
          } catch {
            /* module unavailable in this binary */
          }
          if (VideoThumbnails?.getThumbnailAsync) {
            const thumb = await VideoThumbnails.getThumbnailAsync(uploadUri, {
              time: 0,
              quality: 0.7,
            });
            if (thumb?.uri) {
              const posterRes = await uploadFile(base, thumb.uri, 'poster.jpg', 'image/jpeg');
              posterUrl = posterRes?.url || '';
            }
          }
        } catch (posterErr: any) {
          if (__DEV__) console.warn('[story] Poster generation failed:', posterErr?.message);
        }
      }

      {
        const gameId = vm.gameId;
        if (!gameId) throw new Error('Could not resolve the game for this story');
        const storyPayload: any = { media_url: mediaUrl };
        if (posterUrl) storyPayload.poster_url = posterUrl;
        if (location?.latitude && location?.longitude) {
          storyPayload.location = {
            lat: location.latitude,
            lng: location.longitude,
            source: 'device',
          };
        }
        await Game.addStory(gameId, storyPayload);
        // Mirror the server's posting unlock locally (see handleAddStory).
        void recordEventPostingUnlock([gameId, vm.eventId]);
        analytics.track(ANALYTICS_EVENTS.STORY_ADDED, { game_id: gameId });
        try {
          await loadGameById(gameId);
          Alert.alert('Added', 'Story added to this game.');
        } catch {
          Alert.alert('Added', 'Story added to this game. Refresh to see it.');
        }
      }
    } catch (err: any) {
      const status = err?.status;
      const code = err?.data?.error || '';
      const serverMsg = err?.data?.message || '';
      const message = String(err?.message || code || '');
      if (status === 401 || /unauthorized/i.test(message)) {
        showUploadErrorAlert(err, {
          fallbackTitle: 'Unable to add story',
          fallbackMessage: 'Please sign in again to upload stories.',
          logTag: 'story.upload.video',
        });
      } else if (code === 'POSTING_WINDOW_CLOSED') {
        Alert.alert('Not Yet', serverMsg || 'The story posting window is not open for this event.');
      } else if (code === 'TOO_FAR_FROM_VENUE') {
        const dist = err?.data?.distance;
        Alert.alert(
          'Too Far',
          serverMsg ||
            `You need to be within 3 km of the venue.${dist ? ` You're ${dist.toFixed(1)} km away.` : ''}`
        );
      } else if (code === 'LOCATION_REQUIRED') {
        Alert.alert('Location Required', 'Enable location access to post stories at this event.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: () => Linking.openSettings() },
        ]);
      } else if (code === 'NO_EVENT_LOCATION') {
        Alert.alert(
          'Cannot Verify Location',
          'This game has no event location set yet, so story uploads are disabled until the venue is configured.'
        );
      } else if (status === 429) {
        Alert.alert(
          'Too Many Uploads',
          'You have hit the hourly upload limit. Wait a few minutes and try again.'
        );
      } else {
        Alert.alert('Unable to add story', toUserMessage(err, 'Please try again.'));
      }
    } finally {
      setStoryBusy(false);
      setStoryPreview(null);
      setStoryTrimmedUri(null);
    }
  }, [
    storyPreview,
    storyTrimmedUri,
    vm?.gameId,
    vm?.eventId,
    location?.latitude,
    location?.longitude,
    loadGameById,
  ]);

  const _refreshVotes = useCallback(async () => {
    if (!canShowVoteSection || !vm?.gameId) {
      setVoteSummary(null);
      return;
    }
    try {
      const res: any = await retryWithBackoff(() => Game.votesSummary(vm.gameId!), {
        maxRetries: 2,
        initialDelayMs: 800,
        maxDelayMs: 4000,
      });
      setVoteSummary(parseVoteSummary(res));
    } catch (err) {
      if (__DEV__) console.warn('Failed to load game votes', err);
    }
  }, [canShowVoteSection, vm?.gameId]);

  const load = useCallback(
    async (isRefresh = false) => {
      const gameIdValue = id ? String(id) : null;
      const eventIdValue = eventId ? String(eventId) : null;
      if (__DEV__)
        console.warn('[GameDetails] load() called', { gameIdValue, eventIdValue, isRefresh });
      if (!gameIdValue && !eventIdValue) {
        if (__DEV__) console.warn('[GameDetails] load() — no id or eventId, aborting');
        setError('Missing game or event id.');
        setVm(null);
        setLoading(false);
        setRefreshing(false);
        return;
      }
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);

      // Load team directory in background; it should not block event/game rendering.
      void loadTeams();

      try {
        // buildEventDetailRoute sends a standalone event as id === eventId so it
        // renders on this rich screen (not the bare public-event page). In that
        // case load it as an event; a real game passes only `id` (or id != eventId
        // when a game also carries a linked eventId), which still hits loadGameById.
        if (gameIdValue && gameIdValue !== eventIdValue) {
          await loadGameById(gameIdValue);
        } else if (eventIdValue) {
          await loadVirtualFromEvent(eventIdValue);
        } else if (gameIdValue) {
          await loadGameById(gameIdValue);
        }
        // eslint-disable-next-line no-console
        if (__DEV__) console.log('[GameDetails] load() — done, vm should be set');
      } catch (err: any) {
        // eslint-disable-next-line no-console
        if (__DEV__) console.error('[GameDetails] load() error:', err?.message);
        const message = String(err?.message || '');
        if (message.toLowerCase().includes('timed out')) {
          setError('Loading is taking too long. Pull to refresh and try again.');
        } else {
          setError(`Unable to load. ${message || 'Please try again.'}`);
        }
        setVm(null);
      } finally {
        // eslint-disable-next-line no-console
        if (__DEV__) console.log('[GameDetails] load() — finally: clearing loading state');
        if (isRefresh) setRefreshing(false);
        else setLoading(false);
      }
    },
    [eventId, id, loadGameById, loadVirtualFromEvent]
  );

  useEffect(() => {
    // Defer the initial fetch until the push animation finishes so the
    // transition isn't competing with network parsing and state updates.
    const task = InteractionManager.runAfterInteractions(() => {
      void load();
    });
    analytics.track(ANALYTICS_EVENTS.EVENT_PAGE_VIEWED, { gameId: id, eventId });
    return () => task.cancel();
  }, [eventId, id, load]);

  // Reset per-event UI state immediately when navigating to a different event
  useEffect(() => {
    setVoteSummary(null); // Clear previous event's vote data right away
    setSeenStories({}); // Reset seen-story badges for fresh event
  }, [id, eventId]);

  // Fetch vote summary for this event once vm.gameId is available
  useEffect(() => {
    if (vm?.gameId) {
      void _refreshVotes();
    }
  }, [vm?.gameId, _refreshVotes]);

  useEffect(() => {
    const total = _voteSummary?.total ?? 0;
    const hasVotes = total > 0;
    // Allow true 0%/100% edges so a single vote can fully own the bar or split evenly for large volumes
    const targetA = hasVotes ? Math.max(0, Math.min(100, _voteSummary?.pctA ?? 0)) : 50;
    const targetB = hasVotes ? Math.max(0, Math.min(100, _voteSummary?.pctB ?? 0)) : 50;
    const dur = prefersReducedMotion ? 0 : 400;
    Animated.parallel([
      Animated.timing(voteAnimated.A, {
        toValue: targetA,
        duration: prefersReducedMotion ? 0 : 200,
        useNativeDriver: false,
      }),
      Animated.timing(voteAnimated.B, {
        toValue: targetB,
        duration: prefersReducedMotion ? 0 : 200,
        useNativeDriver: false,
      }),
      Animated.timing(pctAnimA, { toValue: targetA, duration: dur, useNativeDriver: false }),
      Animated.timing(pctAnimB, { toValue: targetB, duration: dur, useNativeDriver: false }),
      Animated.timing(numAnimA, { toValue: targetA, duration: dur, useNativeDriver: false }),
      Animated.timing(numAnimB, { toValue: targetB, duration: dur, useNativeDriver: false }),
    ]).start();
  }, [
    numAnimA,
    numAnimB,
    pctAnimA,
    pctAnimB,
    prefersReducedMotion,
    voteAnimated.A,
    voteAnimated.B,
    _voteSummary?.pctA,
    _voteSummary?.pctB,
    _voteSummary?.total,
  ]);

  const onRefresh = useCallback(() => {
    void load(true);
  }, [load]);

  const onToggleRsvp = useCallback(async () => {
    if (!vm?.eventId || rsvpBusy) return;
    if (!authUser) {
      promptForSignIn(() => router.push('/sign-in'), { message: 'Sign in to RSVP.' });
      return;
    }
    if (!canRsvpNow) {
      Alert.alert('RSVP closed', 'You can only RSVP before kickoff.');
      return;
    }
    // snapshot current vm for potential rollback
    const snapshot = vm;
    const nextDesired = !vm.userRsvped;

    // optimistic local update so UI feels instant
    setVm(prev => {
      if (!prev) return prev;
      const prevCount = typeof prev.rsvpCount === 'number' ? prev.rsvpCount : 0;
      const newCount = nextDesired ? prevCount + 1 : Math.max(0, prevCount - 1);
      return {
        ...prev,
        userRsvped: nextDesired,
        rsvpCount: typeof prev.rsvpCount === 'number' ? newCount : prev.rsvpCount,
      };
    });

    setRsvpBusy(true);
    try {
      const res: any = await retryWithBackoff(() => Event.rsvp(vm.eventId!, nextDesired), {
        maxRetries: 0,
        initialDelayMs: 800,
        maxDelayMs: 4000,
      });
      // reconcile with authoritative server response
      setVm(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          userRsvped: typeof res?.going === 'boolean' ? res.going : nextDesired,
          rsvpCount: typeof res?.count === 'number' ? res.count : prev.rsvpCount,
          capacity: typeof res?.capacity === 'number' ? res.capacity : prev.capacity,
        };
      });
      // notify user of success
      Alert.alert(
        'RSVP updated',
        nextDesired ? 'You are marked as going.' : 'You are no longer marked as going.'
      );
    } catch (err: any) {
      // rollback optimistic update
      setVm(snapshot);
      const status = err?.status;
      const message = String(err?.message || err?.data?.error || '');
      if (status === 400 && /event has passed/i.test(message)) {
        Alert.alert('RSVP closed', 'This event has already started or ended.');
        return;
      }
      if (__DEV__) console.error('Failed to toggle RSVP', err);
      Alert.alert('RSVP', 'Unable to update RSVP right now. Please try again.');
    } finally {
      setRsvpBusy(false);
    }
  }, [canRsvpNow, vm, rsvpBusy, authUser, router]);

  const shareContextLines = useMemo(() => {
    if (!vm) return [];
    const lines: string[] = [];
    if (vm.homeTeam && vm.awayTeam) {
      lines.push(`${vm.homeTeam} vs ${vm.awayTeam}`);
    }
    if (displayDate) {
      lines.push(`When: ${displayDate}`);
    }
    if (vm.location) {
      lines.push(`Location: ${vm.location}`);
    }
    return lines;
  }, [displayDate, vm]);

  const { share: shareGameLink } = useShareLink({
    kind: vm?.gameId ? 'game' : 'event',
    id: vm?.gameId ?? vm?.eventId,
    title:
      vm?.title ||
      (vm?.homeTeam && vm?.awayTeam ? `${vm.homeTeam} vs ${vm.awayTeam}` : 'VarsityHub Game'),
    contextLines: shareContextLines,
  });

  const onShare = useCallback(() => {
    void shareGameLink();
  }, [shareGameLink]);

  const onPressLocation = useCallback(() => {
    if (vm?.location) openMaps(vm.location);
  }, [vm?.location]);

  const handleVote = useCallback(
    async (team: VoteOption) => {
      if (!isVoteOpen) return;
      if (!authUser) {
        setLoginPromptOpen(true);
        return;
      }
      let rollback: VoteSummary | null = null;
      setVoteSummary(prev => {
        rollback = prev ? { ...prev } : null;
        return applyVoteSelection(prev, team);
      });

      // Use gameId if available, otherwise fall back to eventId for event-only pages
      const voteId = vm?.gameId || vm?.eventId;
      if (!voteId) return; // Safety check

      setVoteBusy(true);
      try {
        const res: any = await retryWithBackoff(() => Game.castVote(voteId, team), {
          maxRetries: 2,
          initialDelayMs: 800,
          maxDelayMs: 4000,
        });
        // The response from the server is the latest truth
        setVoteSummary(parseVoteSummary(res));
        // We can also refresh votes as a secondary measure if needed
        // _refreshVotes();
      } catch (err: any) {
        if (rollback) setVoteSummary(rollback);
        else setVoteSummary(null);
        if (err?.status === 401) {
          setLoginPromptOpen(true);
        } else {
          if (__DEV__) console.error('Failed to submit vote', err);
          Alert.alert('Vote', 'Unable to update your vote right now. Please try again.');
        }
      } finally {
        setVoteBusy(false);
      }
    },
    [isVoteOpen, authUser, vm?.eventId, vm?.gameId]
  );

  const handleClearVote = useCallback(async () => {
    if (!isVoteOpen) return;
    // Event-only pages (no gameId) only update local state
    const isEventOnly = !vm?.gameId && vm?.eventId;

    let rollback: VoteSummary | null = null;
    let hasVoteToClear = false;
    setVoteSummary(prev => {
      // Early return if there's no vote to clear
      if (!prev?.userVote) {
        return prev;
      }
      hasVoteToClear = true;
      rollback = { ...prev };
      return applyClearVote(prev);
    });

    // Early return if there's no vote to clear - prevents unnecessary API calls
    if (!hasVoteToClear) return;

    // For event-only pages, just update local state and don't call API
    if (isEventOnly) {
      setVoteBusy(false);
      return;
    }

    if (!vm?.gameId) return; // Safety check

    setVoteBusy(true);
    try {
      const res: any = await retryWithBackoff(() => Game.clearVote(vm.gameId!), {
        maxRetries: 2,
        initialDelayMs: 800,
        maxDelayMs: 4000,
      });
      setVoteSummary(parseVoteSummary(res));
    } catch (err: any) {
      if (rollback) setVoteSummary(rollback);
      if (err?.status === 401) {
        setLoginPromptOpen(true);
      } else {
        if (__DEV__) console.error('Failed to clear vote', err);
        Alert.alert('Vote', 'Unable to update your vote right now. Please try again.');
      }
    } finally {
      setVoteBusy(false);
    }
  }, [isVoteOpen, vm?.eventId, vm?.gameId]);

  const renderStoriesCarousel = () => {
    const mediaItems = (vm?.media ?? []).map(m => ({
      id: m.id,
      url: m.url,
      thumbnail_url: m.thumbnail_url ?? (m as any).preview_url ?? undefined,
      kind: m.kind,
      user_id: m.user_id,
      created_at: m.created_at,
      caption: m.caption,
      expires_at: (m as any).expires_at ?? null,
    }));
    if (!mediaItems.length) return null;
    return (
      <View style={styles.storiesWrap}>
        <Animated.ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.storiesRow}
          decelerationRate="fast"
          snapToInterval={132} // Snap to each card (120px width + 12px gap)
          snapToAlignment="center"
        >
          {mediaItems.map((it, idx) => {
            const isVideo =
              it.kind === 'video' || (typeof it.url === 'string' && VIDEO_EXT.test(it.url));
            const wasSeen = !!seenStories[it.id];
            // Stories persist forever — no expiry overlay. The 24h window only
            // controls when stories can be CREATED, not their visibility.
            return (
              <Pressable
                key={`${it.id}-${idx}`}
                style={[
                  styles.storyItem,
                  styles.storyItemGap,
                  wasSeen ? styles.storyItemSeen : null,
                ]}
                onPress={() =>
                  setStoriesViewer({ visible: true, items: mediaItems as any, index: idx })
                }
              >
                <View style={styles.storyTile}>
                  {isVideo ? (
                    <View style={[styles.storyThumb, styles.storyThumbVideo]}>
                      {it.thumbnail_url ? (
                        <Image
                          source={{ uri: optimizeImageUrl(it.thumbnail_url, 500) }}
                          // absoluteFill, not flex: 1 — the poster must fill this
                          // tile behind the play icon. A plain flex child collapsed
                          // to width 0 here (the parent used to center it), which
                          // is what rendered video stories as black tiles.
                          style={StyleSheet.absoluteFill}
                          contentFit="cover"
                          transition={200}
                        />
                      ) : (
                        // R2-hosted story videos have no server poster URL
                        // (getVideoPreviewUrl is Cloudinary-only) — render the
                        // video's own first frame instead of a blank black box.
                        <VideoFirstFrame uri={it.url} style={StyleSheet.absoluteFill} />
                      )}
                      <View
                        style={[
                          StyleSheet.absoluteFill,
                          { alignItems: 'center', justifyContent: 'center' },
                        ]}
                      >
                        <Ionicons name="play" size={32} color="#fff" />
                      </View>
                    </View>
                  ) : (
                    <Image
                      source={{ uri: optimizeImageUrl(it.url, 500) }}
                      style={styles.storyThumb}
                      contentFit="cover"
                      transition={200}
                      cachePolicy="memory-disk"
                      recyclingKey={it.url}
                    />
                  )}
                  {wasSeen ? <View style={styles.storySeenOverlay} /> : null}
                </View>
              </Pressable>
            );
          })}
        </Animated.ScrollView>
      </View>
    );
  };

  // inline StoriesViewer removed; using top-level component below

  const renderVoteSection = () => {
    if (!canShowVoteSection) return null;
    const summary = _voteSummary ?? buildVoteSummary(0, 0, null);
    const total = summary.total ?? 0;
    const hasVotes = total > 0;
    const pctA = hasVotes ? Math.max(0, Math.min(100, summary.pctA ?? 0)) : 50;
    const pctB = hasVotes ? Math.max(0, Math.min(100, summary.pctB ?? 0)) : 50;
    const pressDisabled = !isVoteOpen || voteBusy;
    const selectedTeam = summary.userVote ?? null;
    const votesWord = total === 1 ? 'vote' : 'votes';
    const pickLabel = selectedTeam === 'A' ? teamALabel : selectedTeam === 'B' ? teamBLabel : null;
    const caption = _voteSummary
      ? `${total} ${votesWord} ${pickLabel ? `• Your pick: ${pickLabel}` : "• You haven't voted"}`
      : 'Loading votes...';

    return (
      <View style={styles.voteWrapper}>
        <View style={[styles.voteBar, pressDisabled ? styles.voteBarDisabled : null]}>
          <Animated.View style={[styles.voteFill, styles.voteFillA, { width: `${pctA}%` }]}>
            <LinearGradient
              colors={['rgba(255,255,255,0.32)', 'rgba(255,255,255,0)']}
              start={{ x: 0, y: 0 }}
              end={{ x: 0, y: 1 }}
              style={styles.voteFillHighlight}
            />
            {pctA > 15 && (
              <Text style={styles.voteTextInside}>
                {teamALabel} {Math.round(pctA)}%
              </Text>
            )}
          </Animated.View>
          <Animated.View style={[styles.voteFill, styles.voteFillB, { width: `${pctB}%` }]}>
            <LinearGradient
              colors={['rgba(255,255,255,0.28)', 'rgba(255,255,255,0)']}
              start={{ x: 0, y: 0 }}
              end={{ x: 0, y: 1 }}
              style={styles.voteFillHighlight}
            />
            {pctB > 15 && (
              <Text style={styles.voteTextInside}>
                {teamBLabel} {Math.round(pctB)}%
              </Text>
            )}
          </Animated.View>

          <View style={styles.voteTouchLayer} pointerEvents={pressDisabled ? 'none' : 'auto'}>
            <Pressable
              style={styles.voteTouchHalf}
              disabled={pressDisabled}
              accessibilityRole="button"
              accessibilityLabel={`Vote for ${teamALabel}`}
              onPress={() => handleVote('A')}
              onLongPress={selectedTeam === 'A' ? handleClearVote : undefined}
              delayLongPress={300}
            />
            <Pressable
              style={styles.voteTouchHalf}
              disabled={pressDisabled}
              accessibilityRole="button"
              accessibilityLabel={`Vote for ${teamBLabel}`}
              onPress={() => handleVote('B')}
              onLongPress={selectedTeam === 'B' ? handleClearVote : undefined}
              delayLongPress={300}
            />
          </View>
        </View>
        <Text style={styles.voteCaptionBelow}>{caption}</Text>
      </View>
    );
  };

  // Navigate to team profile: use team ID if available, else search by name (for sample games or when teams array is empty)
  const handleTeamPress = useCallback(
    async (teamObj: { id: string } | undefined, teamName: string | null) => {
      if (teamObj?.id) {
        void router.push(`/team-page?id=${teamObj.id}`);
        return;
      }
      if (!teamName?.trim()) return;
      try {
        const raw = await Team.list(teamName.trim(), false, { limit: 15 });
        const list: any[] = Array.isArray(raw) ? raw : [];
        const lower = teamName.trim().toLowerCase();
        const match = list.find(
          (t: any) =>
            (t?.name || '').toLowerCase() === lower || (t?.name || '').toLowerCase().includes(lower)
        );
        if (match?.id) void router.push(`/team-page?id=${match.id}`);
      } catch {
        // Team search failed; no navigation
      }
    },
    [router]
  );

  // attempt to pull team color accents from vm.teams if present
  const homeTeamObj = vm?.teams?.find((t: any) => t.name === vm?.homeTeam);
  const awayTeamObj = vm?.teams?.find((t: any) => t.name === vm?.awayTeam);

  const onLeftTeamPress = useCallback(
    () => void handleTeamPress(homeTeamObj, vm?.homeTeam ?? null),
    [handleTeamPress, homeTeamObj, vm?.homeTeam]
  );
  const onRightTeamPress = useCallback(
    () => void handleTeamPress(awayTeamObj, vm?.awayTeam ?? null),
    [handleTeamPress, awayTeamObj, vm?.awayTeam]
  );
  const venuePhotoFallback = useMemo(() => getVenuePhotoFallback(vm?.location), [vm?.location]);
  const resolvedVenuePhotoUrl = vm?.venuePhotoUrl || venuePhotoFallback?.url || null;
  const resolvedVenuePhotoCredit = vm?.venuePhotoCredit || venuePhotoFallback?.credit || null;
  const shouldShowVenuePhotoCredit =
    Boolean(
      (finalsBannerUrl || bannerUrl || resolvedVenuePhotoUrl) &&
      resolvedVenuePhotoUrl &&
      (finalsBannerUrl || bannerUrl || resolvedVenuePhotoUrl) === resolvedVenuePhotoUrl &&
      resolvedVenuePhotoCredit
    ) || false;

  const renderBanner = () => {
    // Prefer a full MatchBanner hero if both teams have logos available
    const leftLogo = vm?.homeTeam ? getTeamLogo(vm.homeTeam) : null;
    const rightLogo = vm?.awayTeam ? getTeamLogo(vm.awayTeam) : null;
    const finalsBanner = finalsBannerUrl;
    const bannerImageUrl = finalsBanner || bannerUrl || resolvedVenuePhotoUrl;
    const bannerImageKey = bannerImageUrl
      ? `${bannerImageUrl}-${vm?.gameId || vm?.id || vm?.title || ''}`
      : 'banner-fallback';
    // A real banner/cover image from the DB takes precedence over the MatchBanner
    // team-logo hero. Demo matchups set banner_url to a specific Cloudinary
    // asset that should render as the event page background.
    const isHero = Boolean(leftLogo && rightLogo) && !finalsBanner && !bannerUrl;
    // Same fixed landscape height for every non-hero banner — a real photo,
    // the auto-generated matchup graphic, and the placeholder gradient all
    // render at the same size, matching the Add-Event modal preview (which
    // uses the same value) so the crop the user sees while creating the
    // event matches what ships to the detail page.
    const bannerHeight = isHero ? 320 : 240;

    const heroBanner =
      bannerImageUrl && !isHero ? (
        // Tap a real photo banner to open it fullscreen with pinch-to-zoom.
        <Pressable
          onPress={() => setBannerPreviewOpen(true)}
          accessibilityRole="imagebutton"
          accessibilityLabel="View banner image fullscreen"
          style={styles.bannerImage}
        >
          <Image
            key={bannerImageKey}
            source={{ uri: optimizeImageUrl(bannerImageUrl, 1200) }}
            style={styles.bannerImage}
            contentFit="cover"
            cachePolicy="memory-disk"
          />
        </Pressable>
      ) : leftLogo && rightLogo ? (
        <MatchBanner
          leftImage={leftLogo}
          rightImage={rightLogo}
          leftName={vm?.homeTeam ?? ''}
          rightName={vm?.awayTeam ?? ''}
          leftScore={vm?.home_score ?? null}
          rightScore={vm?.away_score ?? null}
          height={bannerHeight}
          variant="full"
          hero={true}
          appearance={(vm as any)?.appearance || 'classic'}
          headerFade={headerOpacity}
          onVsPress={() => setVsModalOpen(true)}
          onLeftPress={onLeftTeamPress}
          onRightPress={onRightTeamPress}
          leftColor={(homeTeamObj as any)?.color}
          rightColor={(awayTeamObj as any)?.color}
          goingCount={goingCount}
          onGoingPress={canRsvpNow ? onToggleRsvp : openRsvpSheet}
        />
      ) : (
        <LinearGradient
          colors={PLACEHOLDER_GRADIENT}
          style={styles.bannerImage}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
        />
      );

    return (
      <View style={[styles.bannerWrapper, { height: bannerHeight }]}>
        {heroBanner}
        <FullscreenImageViewer
          visible={bannerPreviewOpen}
          uri={bannerImageUrl}
          onClose={() => setBannerPreviewOpen(false)}
        />
        {/* Shade the banner less when this is a hero image so logos are visible */}
        <LinearGradient
          pointerEvents="none"
          colors={
            isHero
              ? ['rgba(0,0,0,0.02)', 'rgba(0,0,0,0.35)']
              : ['rgba(0,0,0,0.05)', 'rgba(0,0,0,0.75)']
          }
          style={styles.bannerShade}
        />

        <View style={[styles.bannerTopRow, { paddingTop: insets.top + 8 }]}>
          <Pressable
            onPress={() => {
              safeGoBack(router);
            }}
            accessibilityRole="button"
            style={styles.circleButton}
          >
            <Ionicons name="chevron-back" size={20} color={Colors[colorScheme].text} />
          </Pressable>
          <View style={styles.bannerTopRightRow}>
            {hasEvent ? (
              <Pressable
                onPress={openRsvpSheet}
                style={[styles.circleButton, gamePhase !== 'upcoming' ? styles.rsvpDisabled : null]}
                accessibilityRole="button"
                accessibilityLabel="Event RSVP"
                accessibilityHint={rsvpChipLabel ?? undefined}
              >
                <Ionicons
                  name={
                    gamePhase === 'upcoming'
                      ? vm?.userRsvped
                        ? 'checkmark-circle'
                        : 'add-circle-outline'
                      : 'lock-closed'
                  }
                  size={18}
                  color={
                    gamePhase === 'upcoming'
                      ? vm?.userRsvped
                        ? Colors[colorScheme].text
                        : Colors[colorScheme].tint
                      : Colors[colorScheme].mutedText
                  }
                />
              </Pressable>
            ) : null}
            <Pressable onPress={onShare} accessibilityRole="button" style={styles.circleButton}>
              <Ionicons name="share-outline" size={18} color={Colors[colorScheme].text} />
            </Pressable>
          </View>
        </View>
        <View style={styles.bannerBottomRow}>
          <View style={styles.bannerBottomLeft}>
            <View style={styles.dateChip}>
              <Ionicons name="calendar" size={14} color={Colors[colorScheme].tint} />
              <Text style={styles.dateChipText}>{displayDate || 'Upcoming Game'}</Text>
              {displayTime ? <Text style={styles.dateChipTime}>{displayTime}</Text> : null}
            </View>
            {gamePhase === 'upcoming' ? (
              <View style={[styles.statusChip, styles.statusUpcoming]}>
                <Text style={styles.statusText}>Starts in {formatCountdown(startsInMs)}</Text>
              </View>
            ) : gamePhase === 'live' ? (
              <View style={[styles.statusChip, styles.statusLive]}>
                <Animated.View
                  style={[
                    styles.liveDot,
                    {
                      transform: [
                        {
                          scale: livePulse.interpolate({
                            inputRange: [0, 1],
                            outputRange: [0.9, 1.25],
                          }),
                        },
                      ],
                      opacity: livePulse.interpolate({ inputRange: [0, 1], outputRange: [0.8, 1] }),
                    },
                  ]}
                />
                <Text style={styles.statusText}>LIVE</Text>
              </View>
            ) : gamePhase === 'active' ? (
              <View style={[styles.statusChip, styles.statusUpcoming]}>
                <Text style={styles.statusText}>TODAY</Text>
              </View>
            ) : (
              <View style={[styles.statusChip, styles.statusFinal]}>
                <Text style={styles.statusText}>FINAL</Text>
              </View>
            )}
          </View>
          {/* RSVP moved to top bar */}
        </View>
      </View>
    );
  };

  const handleEditResult = useCallback(async () => {
    const gameId = vm?.gameId;
    if (!gameId || editResultBusy) return;
    const home = parseInt(editResultHomeScore, 10);
    const away = parseInt(editResultAwayScore, 10);
    if (Number.isNaN(home) || Number.isNaN(away) || home < 0 || away < 0) {
      Alert.alert('Invalid scores', 'Please enter valid non-negative numbers for both teams.');
      return;
    }
    setEditResultBusy(true);
    try {
      let winner: 'home' | 'away' | 'tie' | null = null;
      if (home > away) winner = 'home';
      else if (away > home) winner = 'away';
      else winner = 'tie';
      await Game.setResult(gameId, { home_score: home, away_score: away, winner });
      setVm(prev => (prev ? { ...prev, home_score: home, away_score: away, winner } : null));
      setEditResultModalOpen(false);
      setEditResultHomeScore('');
      setEditResultAwayScore('');
    } catch (err: any) {
      if (__DEV__) console.error('Edit result failed:', err);
      Alert.alert('Error', toUserMessage(err, 'Failed to update score. Please try again.'));
    } finally {
      setEditResultBusy(false);
    }
  }, [vm?.gameId, editResultHomeScore, editResultAwayScore, editResultBusy]);

  const openEditResultModal = useCallback(() => {
    setEditResultHomeScore(vm?.home_score != null ? String(vm.home_score) : '');
    setEditResultAwayScore(vm?.away_score != null ? String(vm.away_score) : '');
    setEditResultModalOpen(true);
  }, [vm?.home_score, vm?.away_score]);

  const _renderStats = () => {
    const stats = [
      { key: 'going', label: 'Going', value: goingCount != null ? String(goingCount) : '\u2014' },
      {
        key: 'reviews',
        label: 'Reviews',
        value: vm?.reviewsCount != null ? String(vm.reviewsCount) : '\u2014',
      },
      { key: 'media', label: 'Stories', value: vm?.media?.length ? String(vm.media.length) : '0' },
    ];
    return (
      <View>
        <View style={styles.statRow}>
          {stats.map(stat => (
            <View key={stat.key} style={styles.statCard}>
              <Text style={styles.statValue}>{stat.value}</Text>
              <Text style={styles.statLabel}>{stat.label}</Text>
            </View>
          ))}
        </View>
        {vm?.can_edit_result && vm?.gameId ? (
          <Pressable
            onPress={openEditResultModal}
            style={({ pressed }) => [
              styles.editResultButton,
              {
                backgroundColor: pressed ? Colors[colorScheme].surface : Colors[colorScheme].tint,
                opacity: pressed ? 0.9 : 1,
              },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Edit game result"
          >
            <Ionicons name="trophy-outline" size={16} color="#FFFFFF" />
            <Text style={styles.editResultButtonText}>
              {vm?.home_score != null && vm?.away_score != null ? 'Edit Result' : 'Add Result'}
            </Text>
          </Pressable>
        ) : null}
      </View>
    );
  };

  const renderTeams = () => {
    // Extract organization name from team name (e.g., "SHS Men's Soccer" -> "SHS")
    const _getOrganizationFromTeamName = (teamName: string) => {
      const parts = teamName.split(/\s+/);
      if (parts.length > 1) {
        // Check if first part looks like an abbreviation (SHS, NHS, etc.)
        const firstPart = parts[0];
        if (firstPart.length <= 5 && firstPart === firstPart.toUpperCase()) {
          return firstPart;
        }
        // Otherwise use first word
        return parts[0];
      }
      return teamName;
    };

    // If we have teams array with IDs, use that
    if (vm?.teams?.length) {
      return (
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-around',
            gap: 10,
            marginVertical: 12,
          }}
        >
          {vm.teams.slice(0, 2).map(team => (
            <Pressable
              key={team.id}
              style={({ pressed }) => [
                styles.teamLinkButton,
                {
                  backgroundColor: pressed
                    ? Colors[colorScheme].surface
                    : Colors[colorScheme].background,
                  borderColor: Colors[colorScheme].border,
                },
              ]}
              onPress={() =>
                void router.push({
                  pathname: '/team-page',
                  params: { id: team.id, name: team.name, from: 'game-details', gameId: id },
                } as any)
              }
            >
              {team.avatarUrl ? (
                <Image
                  source={{ uri: optimizeImageUrl(team.avatarUrl, 160) }}
                  style={styles.teamLinkAvatar}
                  contentFit="cover"
                />
              ) : (
                <Ionicons name="people-outline" size={20} color={Colors[colorScheme].text} />
              )}
              <Text style={styles.teamLinkName} numberOfLines={1}>
                {team.name}
              </Text>
              <Ionicons name="chevron-forward" size={16} color={Colors[colorScheme].mutedText} />
            </Pressable>
          ))}
        </View>
      );
    }

    // Otherwise use homeTeam and awayTeam strings if available
    const homeTeam = vm?.homeTeam?.trim();
    const awayTeam = vm?.awayTeam?.trim();

    if (!homeTeam && !awayTeam) {
      return (
        <View style={{ paddingVertical: 12 }}>
          <Text style={{ color: Colors[colorScheme].mutedText, textAlign: 'center' }}>
            No teams linked to this game yet.
          </Text>
          <Text
            style={{
              color: Colors[colorScheme].mutedText,
              textAlign: 'center',
              fontSize: 12,
              marginTop: 4,
            }}
          >
            Teams can be added when editing the game.
          </Text>
        </View>
      );
    }

    const teams = [homeTeam, awayTeam].filter(Boolean);

    return (
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-around',
          gap: 12,
          marginVertical: 16,
          paddingHorizontal: 12,
        }}
      >
        {teams.map((teamName, index) => {
          const teamLogo = getTeamLogo(teamName!);

          return (
            <Pressable
              key={index}
              style={({ pressed }) => [
                {
                  flex: 1,
                  alignItems: 'center',
                  justifyContent: 'center',
                  paddingVertical: 16,
                  paddingHorizontal: 12,
                  borderRadius: 12,
                  backgroundColor: Colors[colorScheme].surface,
                  borderWidth: 1,
                  borderColor: Colors[colorScheme].border,
                  minHeight: 160,
                  opacity: pressed ? 0.7 : 1,
                  transform: pressed ? [{ scale: 0.95 }] : [{ scale: 1 }],
                },
              ]}
              onPress={() =>
                void router.push({
                  pathname: '/team-page',
                  params: { name: teamName, from: 'game-details', gameId: id },
                } as any)
              }
              accessibilityRole="button"
              accessibilityLabel={`View ${teamName} team`}
            >
              <View
                style={{
                  width: 72,
                  height: 72,
                  borderRadius: 36,
                  backgroundColor: Colors[colorScheme].background,
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: 8,
                  borderWidth: 2,
                  borderColor: Colors[colorScheme].tint,
                }}
              >
                {teamLogo ? (
                  <Image
                    source={{ uri: optimizeImageUrl(teamLogo, 160) }}
                    style={{ width: 68, height: 68, borderRadius: 34 }}
                    contentFit="cover"
                  />
                ) : (
                  <View
                    style={{
                      width: 68,
                      height: 68,
                      borderRadius: 34,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: Colors[colorScheme].tint + '20',
                    }}
                  >
                    <Ionicons name="shield" size={32} color={Colors[colorScheme].tint} />
                  </View>
                )}
              </View>
              <Text
                style={{
                  fontWeight: '700',
                  fontSize: 16,
                  textAlign: 'center',
                  color: Colors[colorScheme].text,
                  marginHorizontal: 4,
                }}
                numberOfLines={2}
              >
                {teamName}
              </Text>
              <Ionicons
                name="chevron-forward"
                size={18}
                color={Colors[colorScheme].tint}
                style={{ marginTop: 8 }}
              />
            </Pressable>
          );
        })}
      </View>
    );
  };

  // Sanitize generic placeholder descriptions and strip internal seed text.
  // For [DEMO_MATCHUP]-tagged games the whole description is seed/promo filler
  // ("Tobacco Road rivalry. Demo event for promo content.") and must not
  // render to users — return null so the description block is hidden entirely.
  const displayDescription = useMemo(() => {
    const raw = vm?.description || '';
    if (raw.includes(DEMO_MATCHUP_TAG)) return null;
    const s = raw.replace(/\s+/g, ' ').trim();
    if (!s) return null;
    if (/^friendly match$/i.test(s)) return null;
    return s;
  }, [vm?.description]);

  const _renderMediaGrid = () => {
    if (!vm?.media?.length) {
      return <Text style={styles.muted}>Add photos & videos to showcase this game.</Text>;
    }
    return (
      <View style={styles.mediaGrid}>
        {vm.media.map(item => {
          const isVideo = item.kind === 'video' || VIDEO_EXT.test(item.url);
          return (
            <Pressable
              key={item.id}
              style={styles.mediaThumb}
              onPress={() =>
                setViewer({ visible: true, url: item.url, kind: isVideo ? 'video' : 'photo' })
              }
            >
              {isVideo ? (
                <VideoThumbnail
                  videoUrl={item.url}
                  posterUrl={item.thumbnail_url}
                  style={styles.mediaThumbContent}
                  playIconSize={24}
                />
              ) : (
                <Image
                  source={{ uri: optimizeImageUrl(item.url, 500) }}
                  style={styles.mediaThumbContent}
                  contentFit="cover"
                />
              )}
            </Pressable>
          );
        })}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.screen} edges={['bottom']}>
      <Stack.Screen options={{ headerShown: false }} />

      <Animated.View
        pointerEvents="box-none"
        style={[
          styles.headerWrap,
          {
            top: insets.top,
            transform: [{ translateY: headerTranslateY }],
            opacity: headerOpacity,
          },
        ]}
        onLayout={e => {
          const h = e.nativeEvent.layout.height;
          if (h && Math.abs(h - headerH) > 1) setHeaderH(h);
        }}
      >
        {vm ? <>{renderBanner()}</> : null}
      </Animated.View>

      <Animated.ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={{ paddingBottom: 48 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={Colors[colorScheme].tint}
          />
        }
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: feedY } } }], {
          useNativeDriver: true,
          listener: handleScroll,
        })}
        scrollEventThrottle={16}
      >
        <View style={{ height: headerH + 32 }} />
        <View style={styles.content}>
          {loading && !refreshing ? (
            <View style={styles.loadingBox}>
              <ActivityIndicator size="small" color={Colors[colorScheme].tint} />
            </View>
          ) : null}
          {error && !loading ? (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
              <Pressable style={styles.retryBtn} onPress={() => load()}>
                <Text style={styles.retryText}>Retry</Text>
              </Pressable>
            </View>
          ) : null}
          {vm && !loading ? (
            <>
              {/* Tabs removed - keeping Overview only as default view */}
              <Text style={styles.title}>{vm.title}</Text>
              {vm.location ? (
                <Pressable style={styles.locationRow} onPress={onPressLocation}>
                  <Ionicons name="location" size={16} color={Colors[colorScheme].tint} />
                  <Text style={styles.locationText}>{vm.location}</Text>
                </Pressable>
              ) : null}

              {/* Add Story Section */}
              <View style={styles.secondaryActionsRow}>
                <Pressable
                  style={[
                    styles.actionBtn,
                    !vm?.gameId ||
                    storyBusy ||
                    !canAddStory(vm?.date, vm?.gameId, vm?.description, vm)
                      ? styles.actionBtnDisabled
                      : null,
                  ]}
                  onPress={handleAddStory}
                  disabled={
                    !vm?.gameId ||
                    storyBusy ||
                    !canAddStory(vm?.date, vm?.gameId, vm?.description, vm)
                  }
                >
                  <Ionicons
                    name={storyBusy ? 'checkmark-circle-outline' : 'add-circle-outline'}
                    size={16}
                    color={Colors[colorScheme].tint}
                  />
                  <Text style={styles.actionText}>{'Add Story'}</Text>
                </Pressable>
              </View>
              {showPreciseBanner ? (
                <View
                  style={[
                    styles.preciseBanner,
                    {
                      backgroundColor: colorScheme === 'dark' ? 'rgba(245,158,11,0.12)' : '#FEF9C3',
                      borderColor: colorScheme === 'dark' ? 'rgba(245,158,11,0.35)' : '#FACC15',
                    },
                  ]}
                >
                  <Ionicons name="navigate" size={16} color="#B45309" />
                  <View style={{ flex: 1 }}>
                    <Text
                      style={[
                        styles.preciseBannerTitle,
                        { color: colorScheme === 'dark' ? '#FDE68A' : '#92400E' },
                      ]}
                    >
                      Precise location is off
                    </Text>
                    <Text
                      style={[
                        styles.preciseBannerText,
                        { color: colorScheme === 'dark' ? '#FDE68A' : '#92400E' },
                      ]}
                    >
                      Android is sharing an approximate location, so story pins may be less
                      accurate.
                    </Text>
                    <View style={styles.preciseBannerActions}>
                      <Pressable onPress={() => setPreciseBannerDismissed(true)}>
                        <Text
                          style={[
                            styles.preciseBannerLink,
                            { color: colorScheme === 'dark' ? '#FDE68A' : '#92400E' },
                          ]}
                        >
                          Dismiss
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={() => {
                          setPreciseBannerDismissed(true);
                          void openSettings();
                        }}
                      >
                        <Text
                          style={[
                            styles.preciseBannerLink,
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
              {/* Stories carousel (only stories section). Also anchor the Stories tab to this position */}
              <View
                onLayout={e => {
                  sectionOffsets.current.media = e.nativeEvent.layout.y;
                }}
              >
                {renderStoriesCarousel()}
              </View>

              {renderVoteSection()}

              <View style={styles.section}>
                {displayDescription ? (
                  // Long (often seeded) descriptions used to render unclamped
                  // and push the whole page down — keep it small and simple.
                  <ExpandableText
                    text={displayDescription}
                    maxLines={3}
                    style={styles.bodyText}
                    expandStyle={{ color: Colors[colorScheme].tint }}
                  />
                ) : (
                  <Text style={styles.muted}>No description yet.</Text>
                )}
              </View>

              {/* Posts Section */}
              <View
                style={styles.section}
                onLayout={e => {
                  sectionOffsets.current.posts = e.nativeEvent.layout.y;
                }}
              >
                <View style={styles.sectionHeader}>
                  <View>
                    <Text style={styles.sectionTitle}>Posts</Text>
                    <Text style={styles.sectionSubtitle}>{postsSubtitle}</Text>
                  </View>
                  <Pressable
                    style={styles.addPostButton}
                    onPress={() => {
                      const targetGameId = vm?.gameId || vm?.eventId;
                      if (!targetGameId) {
                        Alert.alert('Create Post', 'Reload this event before creating a post.');
                        return;
                      }
                      if (!authUser) {
                        promptForSignIn(
                          () => {
                            void router.push('/sign-in');
                          },
                          {
                            message: 'Sign in to post to this event.',
                          }
                        );
                        return;
                      }
                      // Game detail highlights must create highlight posts so they
                      // show up in the game highlight surfaces and filters.
                      void router.push({
                        pathname: '/create-post',
                        params: { gameId: String(targetGameId), type: 'highlight' },
                      } as any);
                    }}
                  >
                    <Ionicons name="add-circle" size={28} color={Colors[colorScheme].tint} />
                  </Pressable>
                </View>
                {postsCount > 0 ? (
                  <View style={styles.postsGridContainer}>
                    {scrapbookPlan.rows.map((row, rowIndex) => (
                      <View key={`row-${rowIndex}`} style={styles.scrapbookRow}>
                        {row.cells.map(({ post, widthRatio }) => {
                          const mediaUrl = post.media_url || post.mediaUrl || null;
                          const previewUrl =
                            post.preview_url || post.thumbnail_url || post.previewUrl || null;
                          const mediaType =
                            typeof post.media_type === 'string'
                              ? post.media_type.toLowerCase()
                              : null;
                          const isVideo =
                            mediaType === 'video' || (!!mediaUrl && VIDEO_EXT.test(mediaUrl));
                          const thumb = previewUrl || (!isVideo ? mediaUrl : null);
                          const likes = post.upvotes_count ?? 0;
                          const comments = post.comments_count ?? post._count?.comments ?? 0;
                          return (
                            <Pressable
                              key={post.id}
                              style={[
                                styles.masonryItem,
                                // widthRatio is the cell's share of the row: an
                                // even split unless a landscape post is claiming
                                // the wider half. flexGrow can't express that.
                                // flexShrink absorbs the row gap (RN defaults it
                                // to 0, so bases summing to 100% would overflow).
                                {
                                  height: row.height,
                                  flexBasis: `${widthRatio * 100}%`,
                                  flexShrink: 1,
                                },
                              ]}
                              onPress={() => {
                                const allPosts = vm?.posts || [];
                                const postIds = allPosts.map((p: any) => String(p.id)).join(',');
                                const idx = allPosts.findIndex(
                                  (p: any) => String(p.id) === String(post.id)
                                );
                                void router.push(
                                  `/post-detail?id=${post.id}&postIds=${encodeURIComponent(postIds)}&index=${Math.max(0, idx)}`
                                );
                              }}
                            >
                              {thumb ? (
                                <View style={styles.gridImageContainer}>
                                  <Image
                                    source={{ uri: optimizeImageUrl(thumb, 500) }}
                                    style={styles.gridImage}
                                    contentFit="cover"
                                  />
                                  <View style={styles.gridImageOverlay} />
                                </View>
                              ) : isVideo && mediaUrl ? (
                                <View
                                  style={[
                                    styles.gridImageContainer,
                                    {
                                      backgroundColor: '#0f172a',
                                      alignItems: 'center',
                                      justifyContent: 'center',
                                    },
                                  ]}
                                >
                                  <Ionicons name="play-circle" size={48} color="#94a3b8" />
                                </View>
                              ) : (
                                <View style={[styles.gridImage, styles.gridImageFallback]}>
                                  <LinearGradient
                                    colors={['#667eea', '#764ba2', '#f093fb']}
                                    style={StyleSheet.absoluteFillObject as any}
                                    start={{ x: 0, y: 0 }}
                                    end={{ x: 1, y: 1 }}
                                  />
                                  <View style={styles.textPostOverlay}>
                                    <Text numberOfLines={6} style={styles.gridTextOnly}>
                                      {String(post.caption || post.content || '').trim() || 'Post'}
                                    </Text>
                                  </View>
                                </View>
                              )}
                              <View style={styles.gridCounts}>
                                <View style={styles.gridCountItem}>
                                  <Ionicons name="arrow-up" size={12} color="#fff" />
                                  <Text style={styles.gridCountText}>{likes}</Text>
                                </View>
                                <View style={styles.gridCountItem}>
                                  <Ionicons name="chatbubble-ellipses" size={12} color="#fff" />
                                  <Text style={styles.gridCountText}>{comments}</Text>
                                </View>
                              </View>
                              <View style={styles.gridIconBadge}>
                                {isVideo ? (
                                  <Ionicons name="videocam-outline" size={16} color="#fff" />
                                ) : (
                                  <Ionicons name="camera-outline" size={16} color="#fff" />
                                )}
                              </View>
                            </Pressable>
                          );
                        })}
                      </View>
                    ))}
                  </View>
                ) : (
                  <View>
                    <Text style={[styles.muted, styles.sectionHelper]}>
                      Be the first to share a highlight for this game.
                    </Text>
                    <View style={styles.postsMasonryGrid}>
                      <View style={styles.masonryColumn}>
                        <View style={[styles.masonryItem, styles.gridItemEmpty, { height: 240 }]}>
                          <Ionicons
                            name="image-outline"
                            size={32}
                            color={Colors[colorScheme].border}
                          />
                        </View>
                        <View style={[styles.masonryItem, styles.gridItemEmpty, { height: 200 }]}>
                          <Ionicons
                            name="image-outline"
                            size={32}
                            color={Colors[colorScheme].border}
                          />
                        </View>
                      </View>
                      <View style={styles.masonryColumn}>
                        <View style={[styles.masonryItem, styles.gridItemEmpty, { height: 180 }]}>
                          <Ionicons
                            name="image-outline"
                            size={32}
                            color={Colors[colorScheme].border}
                          />
                        </View>
                        <View style={[styles.masonryItem, styles.gridItemEmpty, { height: 220 }]}>
                          <Ionicons
                            name="image-outline"
                            size={32}
                            color={Colors[colorScheme].border}
                          />
                        </View>
                      </View>
                    </View>
                  </View>
                )}
                {postsCount > 0 && (
                  <Pressable style={styles.viewAllButton} onPress={() => setVerticalFeedOpen(true)}>
                    <Text style={styles.viewAllButtonText}>View All Posts</Text>
                    <Ionicons name="arrow-forward" size={14} color={Colors[colorScheme].text} />
                  </Pressable>
                )}
              </View>

              {/* Teams Section (moved after Posts) */}
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Teams</Text>
                {renderTeams()}
              </View>
              {shouldShowVenuePhotoCredit ? (
                <View style={styles.venueCreditFooter}>
                  <Text style={styles.venueCreditFooterText}>{resolvedVenuePhotoCredit}</Text>
                </View>
              ) : null}
            </>
          ) : null}
        </View>
      </Animated.ScrollView>

      <Modal
        visible={!!viewer?.visible}
        transparent
        animationType="fade"
        onRequestClose={() => setViewer(null)}
      >
        <Pressable style={styles.viewerBackDrop} onPress={() => setViewer(null)}>
          <View style={styles.viewerContent}>
            {viewer?.url ? (
              viewer.kind === 'video' ? (
                // Media lightbox — the viewer opened this to watch it.
                <VideoPlayer uri={viewer.url} style={styles.viewerMedia} autoPlay />
              ) : (
                <Image
                  source={{ uri: optimizeImageUrl(viewer.url, 1200) }}
                  style={styles.viewerMedia}
                  contentFit="contain"
                />
              )
            ) : null}
          </View>
        </Pressable>
      </Modal>

      {/* Story Video Trim Preview */}
      <Modal
        visible={!!storyPreview}
        transparent
        animationType="slide"
        onRequestClose={() => {
          setStoryPreview(null);
          setStoryTrimmedUri(null);
          setStoryBusy(false);
        }}
      >
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.9)', justifyContent: 'center' }}>
          {storyPreview && (
            <View style={{ padding: 16 }}>
              {/* Story trim preview: authoring surface, not a consumption one. */}
              <VideoPlayer
                uri={storyTrimmedUri ?? storyPreview.uri}
                style={{
                  width: '100%',
                  aspectRatio: 9 / 16,
                  borderRadius: 12,
                  alignSelf: 'center',
                  maxHeight: 400,
                }}
                autoPlay={false}
              />
              {canTrimStoryVideo ? (
                <VideoTrimmer
                  uri={storyPreview.uri}
                  maxDurationS={STORY_MAX_DURATION_S}
                  onTrimComplete={u => setStoryTrimmedUri(u)}
                  onTrimReset={() => setStoryTrimmedUri(null)}
                />
              ) : (
                <Text
                  style={{
                    color: '#E5E7EB',
                    textAlign: 'center',
                    marginTop: 12,
                    marginHorizontal: 8,
                  }}
                >
                  Web uploads the selected video as-is. Trimming is available in the iOS and Android
                  app.
                </Text>
              )}
              <View
                style={{ flexDirection: 'row', justifyContent: 'center', gap: 16, marginTop: 12 }}
              >
                <Pressable
                  onPress={() => {
                    setStoryPreview(null);
                    setStoryTrimmedUri(null);
                    setStoryBusy(false);
                  }}
                  style={{
                    backgroundColor: '#333',
                    paddingHorizontal: 24,
                    paddingVertical: 12,
                    borderRadius: 8,
                  }}
                >
                  <Text style={{ color: '#fff', fontWeight: '600' }}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={confirmStoryUpload}
                  disabled={storyBusy}
                  style={{
                    backgroundColor: '#4A90D9',
                    paddingHorizontal: 24,
                    paddingVertical: 12,
                    borderRadius: 8,
                    opacity: storyBusy ? 0.6 : 1,
                  }}
                >
                  {storyBusy ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <Text style={{ color: '#fff', fontWeight: '600' }}>Upload Story</Text>
                  )}
                </Pressable>
              </View>
            </View>
          )}
        </View>
      </Modal>

      <Modal
        visible={verticalFeedOpen}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setVerticalFeedOpen(false)}
      >
        <View style={styles.verticalFeedModal}>
          <GameVerticalFeedScreen
            onClose={() => setVerticalFeedOpen(false)}
            gameId={vm?.gameId || null}
            initialPosts={
              !vm?.gameId && Array.isArray(vm?.posts)
                ? (vm.posts.map(mapHighlightToFeedPost).filter(Boolean) as any[])
                : undefined
            }
            excludeMediaUrls={(vm?.media || []).map(m => m.url).filter(Boolean) as string[]}
          />
        </View>
      </Modal>

      {/* VS quick modal - interactive quick poll */}
      <Modal
        visible={vsModalOpen}
        animationType="fade"
        transparent
        onRequestClose={() => setVsModalOpen(false)}
      >
        <Pressable style={styles.vsModalBackdrop} onPress={() => setVsModalOpen(false)}>
          <Pressable style={styles.vsModalCard} onPress={() => {}}>
            <Text style={styles.vsModalTitle}>
              {vm?.homeTeam && vm?.awayTeam ? `${vm.homeTeam} vs ${vm.awayTeam}` : 'Matchup'}
            </Text>

            {/* Poll row */}
            <View style={styles.vsPollRow}>
              {(() => {
                const summary = _voteSummary ?? buildVoteSummary(0, 0, null);
                const _pctA = summary.total ? Math.round(summary.pctA) : 50;
                const _pctB = summary.total ? Math.round(summary.pctB) : 50;
                const selected = summary.userVote;
                const disabled = !isVoteOpen || voteBusy;
                const bgA = themeBgA;
                const bgOn = themeBgOn;
                const textColor = themeTextColor;
                return (
                  <>
                    <Animated.View style={{ flex: 1, transform: [{ scale: vsScaleA }] }}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${teamALabel} vote`}
                        accessibilityHint={
                          selected === 'A' ? 'Tap to clear your vote' : 'Tap to vote for this team'
                        }
                        style={[
                          styles.vsTeamCard,
                          { backgroundColor: selected === 'A' ? bgOn : bgA } as any,
                        ]}
                        onPress={() => {
                          if (selected === 'A') {
                            void handleClearVote();
                            if (!prefersReducedMotion)
                              Animated.spring(vsScaleA, {
                                toValue: 1,
                                useNativeDriver: true,
                              }).start();
                          } else {
                            void handleVote('A');
                            if (!prefersReducedMotion)
                              Animated.sequence([
                                Animated.spring(vsScaleA, { toValue: 1.06, useNativeDriver: true }),
                                Animated.spring(vsScaleA, { toValue: 1, useNativeDriver: true }),
                              ]).start();
                          }
                        }}
                        disabled={disabled}
                      >
                        <Text
                          style={[
                            styles.vsTeamName,
                            {
                              color:
                                selected === 'A'
                                  ? colorScheme === 'dark'
                                    ? Colors.dark.text
                                    : '#fff'
                                  : textColor,
                            },
                          ]}
                        >
                          {teamALabel}
                        </Text>
                        <Text
                          style={[
                            styles.vsTeamPct,
                            {
                              color:
                                selected === 'A'
                                  ? colorScheme === 'dark'
                                    ? Colors.dark.text
                                    : '#fff'
                                  : textColor,
                            },
                          ]}
                        >
                          {displayPctA}%
                        </Text>
                        <Text
                          style={[
                            styles.vsTeamVotes,
                            {
                              color:
                                selected === 'A'
                                  ? colorScheme === 'dark'
                                    ? 'rgba(241,245,249,0.9)'
                                    : 'rgba(255,255,255,0.9)'
                                  : Colors[colorScheme].mutedText,
                            },
                          ]}
                        >
                          {String(summary.teamA)} votes
                        </Text>

                        <View style={styles.vsPctBarWrap} accessibilityElementsHidden>
                          <Animated.View
                            style={[
                              styles.vsPctBarFill,
                              {
                                width: pctAnimA.interpolate({
                                  inputRange: [0, 100],
                                  outputRange: ['0%', '100%'],
                                }) as any,
                                backgroundColor: selected === 'A' ? bgOn : undefined,
                              },
                            ]}
                          />
                        </View>
                      </Pressable>
                    </Animated.View>

                    <View style={styles.vsDivider} />

                    <Animated.View style={{ flex: 1, transform: [{ scale: vsScaleB }] }}>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${teamBLabel} vote`}
                        accessibilityHint={
                          selected === 'B' ? 'Tap to clear your vote' : 'Tap to vote for this team'
                        }
                        style={[
                          styles.vsTeamCard,
                          { backgroundColor: selected === 'B' ? bgOn : bgA } as any,
                        ]}
                        onPress={() => {
                          if (selected === 'B') {
                            void handleClearVote();
                            if (!prefersReducedMotion)
                              Animated.spring(vsScaleB, {
                                toValue: 1,
                                useNativeDriver: true,
                              }).start();
                          } else {
                            void handleVote('B');
                            if (!prefersReducedMotion)
                              Animated.sequence([
                                Animated.spring(vsScaleB, { toValue: 1.06, useNativeDriver: true }),
                                Animated.spring(vsScaleB, { toValue: 1, useNativeDriver: true }),
                              ]).start();
                          }
                        }}
                        disabled={disabled}
                      >
                        <Text
                          style={[
                            styles.vsTeamName,
                            {
                              color:
                                selected === 'B'
                                  ? colorScheme === 'dark'
                                    ? Colors.dark.text
                                    : '#fff'
                                  : textColor,
                            },
                          ]}
                        >
                          {teamBLabel}
                        </Text>
                        <Text
                          style={[
                            styles.vsTeamPct,
                            {
                              color:
                                selected === 'B'
                                  ? colorScheme === 'dark'
                                    ? Colors.dark.text
                                    : '#fff'
                                  : textColor,
                            },
                          ]}
                        >
                          {displayPctB}%
                        </Text>
                        <Text
                          style={[
                            styles.vsTeamVotes,
                            {
                              color:
                                selected === 'B'
                                  ? colorScheme === 'dark'
                                    ? 'rgba(241,245,249,0.9)'
                                    : 'rgba(255,255,255,0.9)'
                                  : Colors[colorScheme].mutedText,
                            },
                          ]}
                        >
                          {String(summary.teamB)} votes
                        </Text>

                        <View style={styles.vsPctBarWrap} accessibilityElementsHidden>
                          <Animated.View
                            style={[
                              styles.vsPctBarFill,
                              {
                                width: pctAnimB.interpolate({
                                  inputRange: [0, 100],
                                  outputRange: ['0%', '100%'],
                                }) as any,
                                backgroundColor: selected === 'B' ? bgOn : undefined,
                              },
                            ]}
                          />
                        </View>
                      </Pressable>
                    </Animated.View>
                  </>
                );
              })()}
            </View>

            <Text style={styles.vsModalBody}>
              {!isVoteOpen
                ? 'Voting closed for this game.'
                : 'Tap a side to vote or tap again to clear your vote.'}
            </Text>

            <Pressable style={styles.vsModalClose} onPress={() => setVsModalOpen(false)}>
              <Text style={{ color: '#fff', fontWeight: '700' }}>Close</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {storiesViewer?.visible ? (
        <StoriesViewer
          visible={storiesViewer.visible}
          items={storiesViewer.items}
          index={storiesViewer.index}
          onClose={() => setStoriesViewer(null)}
          onSeen={id => setSeenStories(prev => (prev[id] ? prev : { ...prev, [id]: true }))}
          onDelete={id => {
            // Remove deleted item from the viewer's items array
            setStoriesViewer(prev => {
              if (!prev) return null;
              const updatedItems = prev.items.filter(item => item.id !== id);
              if (updatedItems.length === 0) return null;
              return { ...prev, items: updatedItems };
            });
            // Also update the main vm.media array
            setVm(prev => {
              if (!prev) return prev;
              return { ...prev, media: prev.media.filter(item => item.id !== id) };
            });
          }}
          gameId={vm?.gameId}
          currentUserId={authUser?.id ?? null}
        />
      ) : null}
      {/* RSVP Bottom Sheet */}
      <Modal
        visible={rsvpSheetOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setRsvpSheetOpen(false)}
      >
        <Pressable style={styles.sheetBackdrop} onPress={closeRsvpSheet}>
          <View />
        </Pressable>
        <View style={styles.sheetContainer}>
          <View style={styles.sheetHandleBar} />
          <View style={styles.sheetHeaderRow}>
            <Ionicons name="people" size={18} color={Colors[colorScheme].tint} />
            <Text style={styles.sheetTitle}>{rsvpChipLabel || 'Event RSVP'}</Text>
          </View>

          {gamePhase === 'upcoming' ? (
            <>
              <Pressable
                onPress={async () => {
                  await onToggleRsvp();
                  setRsvpSheetOpen(false);
                }}
                disabled={rsvpBusy || !canRsvpNow}
                style={[
                  styles.sheetPrimaryBtn,
                  vm?.userRsvped ? styles.sheetBtnOn : null,
                  rsvpBusy || !canRsvpNow ? styles.rsvpDisabled : null,
                ]}
                accessibilityRole="button"
                accessibilityLabel={vm?.userRsvped ? 'Mark not going' : 'RSVP going'}
              >
                <Ionicons
                  name={vm?.userRsvped ? 'close-circle' : 'checkmark-circle'}
                  size={18}
                  color="#fff"
                />
                <Text style={styles.sheetPrimaryBtnText}>
                  {vm?.userRsvped ? 'Mark not going' : 'I am going'}
                </Text>
              </Pressable>
              <Text style={styles.sheetNote}>You can change this anytime before kickoff.</Text>
            </>
          ) : (
            <Text style={styles.sheetNote}>RSVP is closed for this event.</Text>
          )}

          <View style={styles.sheetStatsRow}>
            <View style={styles.sheetStatCard}>
              <Text style={styles.sheetStatValue}>
                {goingCount != null ? String(goingCount) : '0'}
              </Text>
              <Text style={styles.sheetStatLabel}>{gamePhase === 'final' ? 'Went' : 'Going'}</Text>
            </View>
            {vm?.capacity ? (
              <View style={styles.sheetStatCard}>
                <Text style={styles.sheetStatValue}>{String(vm.capacity)}</Text>
                <Text style={styles.sheetStatLabel}>Capacity</Text>
              </View>
            ) : null}
          </View>
        </View>
      </Modal>

      {/* Edit Result Modal - coaches/owners only */}
      <Modal
        visible={editResultModalOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setEditResultModalOpen(false)}
      >
        <Pressable style={styles.editResultBackdrop} onPress={() => setEditResultModalOpen(false)}>
          <Pressable
            style={[styles.editResultModal, { backgroundColor: Colors[colorScheme].background }]}
            onPress={() => {}}
          >
            <Text style={[styles.editResultTitle, { color: Colors[colorScheme].text }]}>
              Edit Game Result
            </Text>
            <View style={styles.editResultRow}>
              <Text style={[styles.editResultLabel, { color: Colors[colorScheme].text }]}>
                {vm?.homeTeam ?? 'Home'}
              </Text>
              <TextInput
                style={[
                  styles.editResultInput,
                  { color: Colors[colorScheme].text, borderColor: Colors[colorScheme].border },
                ]}
                value={editResultHomeScore}
                onChangeText={setEditResultHomeScore}
                placeholder="0"
                placeholderTextColor={Colors[colorScheme].mutedText}
                keyboardType="number-pad"
              />
            </View>
            <Text style={[styles.editResultVs, { color: Colors[colorScheme].mutedText }]}>vs</Text>
            <View style={styles.editResultRow}>
              <Text style={[styles.editResultLabel, { color: Colors[colorScheme].text }]}>
                {vm?.awayTeam ?? 'Away'}
              </Text>
              <TextInput
                style={[
                  styles.editResultInput,
                  { color: Colors[colorScheme].text, borderColor: Colors[colorScheme].border },
                ]}
                value={editResultAwayScore}
                onChangeText={setEditResultAwayScore}
                placeholder="0"
                placeholderTextColor={Colors[colorScheme].mutedText}
                keyboardType="number-pad"
              />
            </View>
            <View style={styles.editResultActions}>
              <Pressable
                onPress={() => setEditResultModalOpen(false)}
                style={[styles.editResultCancelBtn, { borderColor: Colors[colorScheme].border }]}
              >
                <Text style={[styles.editResultCancelText, { color: Colors[colorScheme].text }]}>
                  Cancel
                </Text>
              </Pressable>
              <Pressable
                onPress={handleEditResult}
                disabled={editResultBusy}
                style={[
                  styles.editResultSubmitBtn,
                  { backgroundColor: Colors[colorScheme].tint, opacity: editResultBusy ? 0.6 : 1 },
                ]}
              >
                <Text style={styles.editResultSubmitText}>Save</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
      {showTopFab ? (
        <Pressable
          style={styles.fab}
          onPress={() => {
            const node = scrollRef.current as any;
            if (node?.scrollTo) {
              node.scrollTo({ y: 0, animated: true });
            } else if (node?.getNode) {
              node.getNode().scrollTo({ y: 0, animated: true });
            }
          }}
          accessibilityLabel="Back to top"
        >
          <Ionicons name="arrow-up" size={20} color="#fff" />
          <Text style={styles.fabText}>Top</Text>
        </Pressable>
      ) : null}
      <Modal
        visible={loginPromptOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setLoginPromptOpen(false)}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}
          onPress={() => setLoginPromptOpen(false)}
        >
          <Pressable onPress={e => e.stopPropagation()}>
            <View
              style={[styles.loginPromptSheet, { backgroundColor: Colors[colorScheme].background }]}
            >
              <Text style={[styles.loginPromptTitle, { color: Colors[colorScheme].text }]}>
                Login Required
              </Text>
              <Text style={[styles.loginPromptBody, { color: Colors[colorScheme].mutedText }]}>
                Sign in to vote and interact with games.
              </Text>
              <Pressable
                style={[styles.loginPromptBtn, { backgroundColor: Colors[colorScheme].tint }]}
                onPress={() => {
                  setLoginPromptOpen(false);
                  void router.push('/sign-in');
                }}
                accessibilityRole="button"
                accessibilityLabel="Log in"
              >
                <Text style={styles.loginPromptBtnText}>Login</Text>
              </Pressable>
              <Pressable
                style={[
                  styles.loginPromptCancel,
                  {
                    borderColor: Colors[colorScheme].border,
                    backgroundColor: Colors[colorScheme].surface,
                  },
                ]}
                onPress={() => setLoginPromptOpen(false)}
                accessibilityRole="button"
                accessibilityLabel="Cancel"
              >
                <Text style={[styles.loginPromptCancelText, { color: Colors[colorScheme].text }]}>
                  Cancel
                </Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
};

export default GameDetailsScreen;

const createStyles = (colorScheme: 'light' | 'dark') =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: Colors[colorScheme].background },
    bannerWrapper: {
      position: 'relative',
      height: 260,
      backgroundColor: colorScheme === 'dark' ? '#1e293b' : '#eff6ff',
    },
    bannerImage: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
    venueCreditFooter: {
      marginTop: 14,
      marginBottom: 4,
      paddingTop: 12,
      paddingHorizontal: 2,
      borderTopWidth: 1,
      borderTopColor: Colors[colorScheme].border,
    },
    venueCreditFooterText: {
      color: Colors[colorScheme].mutedText,
      fontSize: 11,
      lineHeight: 15,
      textAlign: 'center',
    },
    bannerShade: { position: 'absolute', left: 0, right: 0, bottom: 0, top: 0 },
    headerWrap: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      zIndex: 30,
      backgroundColor: 'transparent',
      paddingBottom: 8,
      marginBottom: 12,
    },
    fab: {
      position: 'absolute',
      right: 16,
      bottom: 24,
      backgroundColor: 'rgba(17,24,39,0.92)',
      borderRadius: 24,
      paddingHorizontal: 14,
      paddingVertical: 10,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      zIndex: 40,
    },
    fabText: { color: '#fff', fontWeight: '700' },

    voteWrapper: {
      marginTop: -16,
      paddingHorizontal: 16,
      paddingTop: 2,
      paddingBottom: 0,
      marginBottom: 24,
    },
    voteBar: {
      position: 'relative',
      height: 38,
      borderRadius: 12,
      backgroundColor: Colors[colorScheme].border,
      overflow: 'hidden',
      flexDirection: 'row',
      ...(Platform.OS === 'web'
        ? { boxShadow: '0px 3px 6px rgba(0, 0, 0, 0.15)' }
        : {
            shadowColor: '#000',
            shadowOpacity: 0.15,
            shadowRadius: 6,
            shadowOffset: { width: 0, height: 3 },
          }),
      elevation: 3,
      marginBottom: 8,
    },
    voteBarDisabled: { opacity: 0.65 },
    // RSVP sheet styles
    sheetBackdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.4)' },
    sheetContainer: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: Colors[colorScheme].card,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      paddingHorizontal: 16,
      paddingTop: 10,
      paddingBottom: 24,
    },
    sheetHandleBar: {
      alignSelf: 'center',
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: Colors[colorScheme].border,
      marginBottom: 10,
    },
    sheetHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 },
    sheetTitle: { fontSize: 16, fontWeight: '700', color: Colors[colorScheme].text },
    sheetPrimaryBtn: {
      marginTop: 4,
      backgroundColor: Colors[colorScheme].tint,
      borderRadius: 12,
      paddingVertical: 12,
      paddingHorizontal: 14,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
    },
    sheetBtnOn: { backgroundColor: '#ef4444' },
    sheetPrimaryBtnText: { color: '#fff', fontWeight: '700' },
    sheetNote: { marginTop: 10, color: Colors[colorScheme].mutedText },
    sheetStatsRow: { marginTop: 16, flexDirection: 'row', gap: 10 },
    sheetStatCard: {
      flex: 1,
      backgroundColor: Colors[colorScheme].surface,
      borderRadius: 12,
      paddingVertical: 12,
      paddingHorizontal: 12,
      alignItems: 'center',
      borderWidth: 1,
      borderColor: Colors[colorScheme].border,
    },
    sheetStatValue: { fontSize: 18, fontWeight: '800', color: Colors[colorScheme].text },
    sheetStatLabel: {
      marginTop: 2,
      fontSize: 12,
      color: Colors[colorScheme].mutedText,
      fontWeight: '600',
    },
    voteFill: {
      height: '100%',
      overflow: 'hidden',
      position: 'relative',
      alignItems: 'center',
      justifyContent: 'center',
    },
    voteFillA: {
      backgroundColor: '#2563EB',
      borderTopLeftRadius: 12,
      borderBottomLeftRadius: 12,
    },
    voteFillB: {
      backgroundColor: '#10B981',
      borderTopRightRadius: 12,
      borderBottomRightRadius: 12,
    },
    voteFillHighlight: { ...StyleSheet.absoluteFillObject, pointerEvents: 'none' },
    voteLabelLayer: {
      ...StyleSheet.absoluteFillObject,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 8,
    },
    voteLabelCell: { flex: 1, justifyContent: 'center', alignItems: 'center' },
    voteLabelCellLeft: { alignItems: 'center', marginRight: 16 },
    voteLabelCellRight: { alignItems: 'center', marginLeft: 16 },
    voteLabelCenter: {
      position: 'absolute',
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
      justifyContent: 'center',
      alignItems: 'center',
    },
    voteLabelText: { color: '#FFFFFF', fontWeight: '700', fontSize: 12 },
    voteLabelTextDim: { opacity: 0.7 },
    voteTextInside: {
      color: '#FFFFFF',
      fontWeight: '700',
      fontSize: 14,
      textAlign: 'center',
    },
    voteLabelsAbove: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginBottom: 8,
      paddingHorizontal: 8,
      minHeight: 32,
    },
    voteLabelAboveLeft: {
      flex: 1,
      alignItems: 'flex-start',
      marginRight: 16,
    },
    voteLabelAboveRight: {
      flex: 1,
      alignItems: 'flex-end',
      marginLeft: 16,
    },
    voteLabelWinning: {
      borderWidth: 2,
      borderColor: Colors[colorScheme].tint,
      borderRadius: 8,
      paddingHorizontal: 6,
      paddingVertical: 2,
      backgroundColor: `${Colors[colorScheme].tint}10`,
    },
    voteLabelAboveText: {
      color: Colors[colorScheme].mutedText,
      fontWeight: '600',
      fontSize: 12,
    },
    voteLabelWinningText: {
      color: Colors[colorScheme].tint,
      fontWeight: '700',
    },
    voteCaptionInline: {
      color: 'rgba(255,255,255,0.85)',
      fontWeight: '700',
      fontSize: 12,
      textAlign: 'center',
    },
    voteCaptionBelow: {
      marginTop: 0,
      marginBottom: 16,
      textAlign: 'center',
      color: Colors[colorScheme].mutedText,
      fontWeight: '600',
      fontSize: 13,
      paddingHorizontal: 12,
    },
    voteTouchLayer: { ...StyleSheet.absoluteFillObject, flexDirection: 'row' },
    voteTouchHalf: { flex: 1 },
    voteFloatPill: {
      position: 'absolute',
      top: -18,
      backgroundColor: Colors[colorScheme].card,
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: 999,
      alignItems: 'center',
      justifyContent: 'center',
      ...(Platform.OS === 'web'
        ? { boxShadow: '0px 2px 6px rgba(15, 23, 42, 0.12)' }
        : {
            shadowColor: '#0f172a',
            shadowOpacity: 0.12,
            shadowRadius: 6,
            shadowOffset: { width: 0, height: 2 },
          }),
      elevation: 2,
    },
    voteFloatLeft: { left: 28 },
    voteFloatRight: { right: 28 },
    voteFloatText: {
      color: Colors[colorScheme].text,
      fontWeight: '700',
      fontSize: 12,
      textAlign: 'center',
    },

    teamLinkButton: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: Colors[colorScheme].surface,
      padding: 8,
      borderRadius: 8,
      marginVertical: 4,
    },
    teamLinkAvatar: {
      width: 32,
      height: 32,
      borderRadius: 16,
      marginRight: 8,
    },
    teamLinkName: {
      flex: 1,
      fontWeight: '600',
    },

    // Enhanced team card styles for bottom section (now using inline styles)
    teamLinkButtonEnhanced: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 16,
      paddingHorizontal: 12,
      borderRadius: 12,
      borderWidth: 1,
      minHeight: 160,
    },
    teamAvatarContainer: {
      width: 72,
      height: 72,
      borderRadius: 36,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 8,
      borderWidth: 2,
    },
    teamLinkAvatarLarge: {
      width: 68,
      height: 68,
      borderRadius: 34,
    },
    teamIconPlaceholder: {
      width: 68,
      height: 68,
      borderRadius: 34,
      alignItems: 'center',
      justifyContent: 'center',
    },
    teamNameLarge: {
      fontWeight: '700',
      fontSize: 16,
      textAlign: 'center',
      marginHorizontal: 4,
    },
    viewAllButton: {
      backgroundColor: Colors[colorScheme].surface,
      padding: 12,
      borderRadius: 8,
      alignItems: 'center',
      marginTop: 16,
    },
    viewAllButtonText: {
      fontWeight: '600',
    },

    bannerTopRow: {
      position: 'absolute',
      left: 16,
      right: 16,
      top: 0,
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
    },
    bannerTopRightRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    bannerBottomRow: {
      position: 'absolute',
      left: 16,
      right: 16,
      bottom: 18,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    bannerBottomLeft: { flexDirection: 'column', gap: 8, maxWidth: '70%' },
    dateChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: colorScheme === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.9)',
      borderRadius: 999,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    dateChipText: { fontWeight: '700', color: Colors[colorScheme].text, fontSize: 13 },
    dateChipTime: { fontWeight: '600', color: Colors[colorScheme].tint, fontSize: 13 },
    statusChip: {
      alignSelf: 'flex-start',
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      borderRadius: 999,
      paddingHorizontal: 12,
      paddingVertical: 6,
      backgroundColor: colorScheme === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.92)',
    },
    statusUpcoming: {
      backgroundColor: colorScheme === 'dark' ? 'rgba(59,130,246,0.3)' : 'rgba(219,234,254,0.95)',
      borderWidth: 1,
      borderColor: colorScheme === 'dark' ? 'rgba(59,130,246,0.5)' : '#bfdbfe',
    },
    statusLive: {
      backgroundColor: colorScheme === 'dark' ? 'rgba(239,68,68,0.3)' : 'rgba(254,226,226,0.95)',
      borderWidth: 1,
      borderColor: colorScheme === 'dark' ? 'rgba(239,68,68,0.5)' : '#fecaca',
    },
    statusFinal: {
      backgroundColor: colorScheme === 'dark' ? 'rgba(107,114,128,0.3)' : 'rgba(229,231,235,0.95)',
      borderWidth: 1,
      borderColor: colorScheme === 'dark' ? 'rgba(107,114,128,0.5)' : '#d1d5db',
    },
    statusText: { fontWeight: '800', color: Colors[colorScheme].text },
    liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#EF4444' },
    rsvpChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      borderRadius: 999,
      paddingHorizontal: 14,
      paddingVertical: 8,
      backgroundColor: 'rgba(255,255,255,0.9)',
      borderWidth: 1,
      borderColor: '#BFDBFE',
    },
    rsvpOn: { backgroundColor: '#c7d2fe', borderColor: '#818cf8' },
    rsvpDisabled: { opacity: 0.6 },
    rsvpText: { fontWeight: '700', color: Colors[colorScheme].tint },
    rsvpTextOn: { color: Colors[colorScheme].text },
    rsvpTopInline: { paddingHorizontal: 10, paddingVertical: 6 },
    rsvpTextInline: { fontSize: 13 },
    finalChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: 'rgba(254,226,226,0.9)',
      borderRadius: 999,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    finalText: { color: '#991b1b', fontWeight: '700' },
    circleButton: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: colorScheme === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.92)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    scroll: { flex: 1 },
    content: { paddingHorizontal: 16, paddingTop: 24 },
    loadingBox: { paddingVertical: 24, alignItems: 'center' },
    errorBox: {
      padding: 16,
      borderRadius: 12,
      backgroundColor: colorScheme === 'dark' ? 'rgba(239,68,68,0.2)' : '#fee2e2',
      borderWidth: 1,
      borderColor: colorScheme === 'dark' ? 'rgba(239,68,68,0.4)' : '#fecaca',
      marginBottom: 16,
    },
    errorText: {
      color: colorScheme === 'dark' ? '#fca5a5' : '#991b1b',
      fontWeight: '600',
      marginBottom: 8,
    },
    retryBtn: {
      alignSelf: 'flex-start',
      backgroundColor: '#DC2626',
      paddingHorizontal: 14,
      paddingVertical: 8,
      borderRadius: 8,
    },
    retryText: { color: 'white', fontWeight: '700' },
    title: {
      fontSize: 28,
      fontWeight: '900',
      color: Colors[colorScheme].text,
      marginTop: 8,
      marginBottom: 6,
    },
    locationRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 8,
      marginBottom: 12,
      width: '100%',
      paddingRight: 6,
    },
    locationText: {
      color: Colors[colorScheme].text,
      fontWeight: '600',
      textDecorationLine: 'underline',
      flex: 1,
      flexShrink: 1,
      lineHeight: 20,
    },
    actionsRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 16 },
    secondaryActionsRow: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginBottom: 16,
      alignItems: 'center',
      flexWrap: 'wrap',
    },
    storyHelpText: {
      fontSize: 12,
      color: Colors[colorScheme].mutedText,
      fontWeight: '600',
      marginTop: 4,
      width: '100%',
      textAlign: 'center',
    },
    preciseBanner: {
      flexDirection: 'row',
      gap: 12,
      borderRadius: 12,
      borderWidth: 1,
      padding: 12,
      marginBottom: 16,
      alignItems: 'flex-start',
    },
    preciseBannerTitle: { fontWeight: '700', fontSize: 14, color: '#92400E' },
    preciseBannerText: { fontSize: 13, color: '#92400E', marginTop: 2, marginBottom: 8 },
    preciseBannerActions: { flexDirection: 'row', alignItems: 'center', gap: 16 },
    preciseBannerLink: { fontSize: 13, color: '#92400E' },
    actionBtn: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      borderRadius: 12,
      backgroundColor: Colors[colorScheme].surface,
      paddingVertical: 12,
      marginHorizontal: 4,
      borderWidth: 1,
      borderColor: Colors[colorScheme].border,
    },
    actionBtnDisabled: { opacity: 0.6 },
    actionText: { fontWeight: '700', color: Colors[colorScheme].text },
    storyCountdown: { fontSize: 12, textAlign: 'center', marginTop: -8, marginBottom: 12 },
    tabRow: {
      flexDirection: 'row',
      gap: 8,
      marginBottom: 16,
      backgroundColor: colorScheme === 'dark' ? Colors[colorScheme].surface : '#eef2ff',
      borderRadius: 999,
      padding: 4,
    },
    tabRowWrap: { marginBottom: 12, paddingHorizontal: 8 },
    tabRowCapsule: {
      flexDirection: 'row',
      backgroundColor: colorScheme === 'dark' ? Colors[colorScheme].surface : '#eef2ff',
      borderRadius: 999,
      padding: 6,
      alignItems: 'center',
      justifyContent: 'center',
    },
    tabBtnCapsule: {
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 999,
      marginHorizontal: 4,
    },
    tabBtnCapsuleOn: {
      backgroundColor: Colors[colorScheme].card,
      borderWidth: 1,
      borderColor: Colors[colorScheme].tint,
    },
    tabBtn: { flex: 1, borderRadius: 999, alignItems: 'center', paddingVertical: 8 },
    tabBtnOn: {
      backgroundColor: Colors[colorScheme].card,
      borderWidth: 1,
      borderColor: Colors[colorScheme].tint,
    },
    tabText: { fontWeight: '600', color: Colors[colorScheme].mutedText },
    tabTextOn: { color: Colors[colorScheme].tint },
    section: { marginBottom: 24 },
    sectionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 12,
    },
    addPostButton: {
      padding: 8,
      borderRadius: 20,
      backgroundColor: Colors[colorScheme].surface,
      ...(Platform.OS === 'web'
        ? { boxShadow: '0px 2px 4px rgba(0, 0, 0, 0.1)' }
        : {
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 2 },
            shadowOpacity: 0.1,
            shadowRadius: 4,
          }),
      elevation: 2,
    },
    sectionTitle: {
      fontSize: 20,
      fontWeight: '800',
      color: Colors[colorScheme].text,
      marginBottom: 8,
    },
    sectionSubtitle: { color: Colors[colorScheme].mutedText, fontWeight: '600' },
    sectionHelper: { marginBottom: 12 },
    bodyText: { color: Colors[colorScheme].text, fontSize: 16, lineHeight: 24 },
    muted: { color: Colors[colorScheme].mutedText, fontStyle: 'italic' },
    statRow: { flexDirection: 'row', gap: 12, marginTop: 16, marginBottom: 20 },
    statCard: {
      flex: 1,
      backgroundColor: Colors[colorScheme].surface,
      borderRadius: 16,
      paddingVertical: 16,
      alignItems: 'center',
      gap: 6,
    },
    statValue: { fontSize: 20, fontWeight: '800', color: Colors[colorScheme].text },
    statLabel: { color: Colors[colorScheme].mutedText, fontWeight: '600' },
    editResultButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      paddingVertical: 12,
      paddingHorizontal: 20,
      borderRadius: 12,
      marginTop: 12,
      marginBottom: 20,
    },
    editResultButtonText: { color: '#FFFFFF', fontWeight: '700', fontSize: 14 },
    editResultBackdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'center',
      alignItems: 'center',
      padding: 24,
    },
    editResultModal: {
      width: '100%',
      maxWidth: 340,
      borderRadius: 20,
      padding: 24,
    },
    editResultTitle: { fontSize: 18, fontWeight: '800', marginBottom: 20, textAlign: 'center' },
    editResultRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 6 },
    editResultLabel: { flex: 1, fontWeight: '600', fontSize: 14 },
    editResultInput: {
      width: 64,
      borderWidth: 2,
      borderRadius: 12,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 18,
      fontWeight: '700',
      textAlign: 'center',
    },
    editResultVs: { textAlign: 'center', marginVertical: 8, fontWeight: '600' },
    editResultActions: { flexDirection: 'row', gap: 12, marginTop: 24 },
    editResultCancelBtn: {
      flex: 1,
      paddingVertical: 12,
      borderRadius: 12,
      borderWidth: 2,
      alignItems: 'center',
    },
    editResultCancelText: { fontWeight: '600' },
    editResultSubmitBtn: { flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center' },
    editResultSubmitText: { color: '#FFFFFF', fontWeight: '700' },
    teamList: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    teamPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: '#e0f2fe',
      borderRadius: 999,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    teamPillText: { fontWeight: '700', color: '#0c4a6e' },
    mediaGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    mediaThumb: {
      width: '31%',
      aspectRatio: 1,
      borderRadius: 12,
      overflow: 'hidden',
      backgroundColor: '#e2e8f0',
    },
    mediaThumbContent: { flex: 1 },
    mediaVideo: {
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(0, 0, 0, 0.4)',
    },
    storiesWrap: { marginTop: 16, marginBottom: 8 },
    storiesRow: { paddingHorizontal: 16, paddingVertical: 12, gap: 12 },
    storyItem: {
      width: 120,
      height: 200,
      borderRadius: 16,
      overflow: 'hidden',
      ...(Platform.OS === 'web'
        ? { boxShadow: '0px 4px 8px rgba(0, 0, 0, 0.25)' }
        : {
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 4 },
            shadowOpacity: 0.25,
            shadowRadius: 8,
          }),
      elevation: 6,
    },
    storyItemGap: { marginLeft: 0 },
    storyTile: {
      flex: 1,
      borderRadius: 16,
      overflow: 'hidden',
      backgroundColor: '#0f172a',
      borderWidth: 0,
    },
    storyItemSeen: { opacity: 0.5, transform: [{ scale: 0.95 }] },
    storyTileCountdown: {
      alignItems: 'center',
      justifyContent: 'center',
      padding: 8,
      backgroundColor: '#0f172a',
    },
    storyTileLabel: { color: '#cbd5e1', fontWeight: '700', fontSize: 12, marginBottom: 6 },
    storyTileTime: { color: '#ffffff', fontWeight: '900', fontSize: 16 },
    storyLiveRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    storyLiveText: { color: '#ffffff', fontWeight: '900' },
    storyFinalText: { color: '#e5e7eb', fontWeight: '800' },
    storyThumb: { flex: 1 },
    storyThumbVideo: {
      // NO alignItems/justifyContent here. They centered the poster instead of
      // letting it fill: `alignItems: 'center'` stops the child stretching on
      // the cross axis, so the <Image> (which only carries flex: 1) resolved to
      // width 0 and was invisible — leaving this dark background + the play icon
      // showing through. That is the "video stories are black tiles" bug, and it
      // hit the VideoFirstFrame fallback identically, so neither path could ever
      // draw. They were vestigial anyway: the play icon centers itself inside
      // its own absoluteFill wrapper.
      backgroundColor: 'rgba(2,6,23,0.85)',
    },
    storySeenOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(2,6,23,0.25)' },
    storyItemExpired: { opacity: 0.6 },
    storyExpiredOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.6)',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
    },
    storyExpiredLabel: { color: '#fff', fontWeight: '800', fontSize: 12 },
    storyExpiredHint: { color: 'rgba(255,255,255,0.8)', fontSize: 10 },
    storyCountdownBadge: {
      position: 'absolute',
      bottom: 6,
      left: 6,
      right: 6,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
      backgroundColor: 'rgba(0,0,0,0.6)',
      paddingVertical: 4,
      paddingHorizontal: 6,
      borderRadius: 8,
    },
    storyCountdownText: { color: '#fff', fontSize: 10, fontWeight: '700' },
    verticalFeedPreview: {
      marginTop: 16,
      borderRadius: 20,
      overflow: 'hidden',
      minHeight: 220,
      backgroundColor: '#0f172a',
    },
    verticalFeedImage: { ...StyleSheet.absoluteFillObject },
    verticalFeedShade: { ...StyleSheet.absoluteFillObject },
    verticalFeedContent: {
      position: 'absolute',
      left: 24,
      right: 24,
      bottom: 24,
      gap: 6,
      maxWidth: 260,
    },
    verticalFeedBadge: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(37,99,235,0.9)',
      marginBottom: 12,
      ...(Platform.OS === 'web'
        ? { boxShadow: '0px 6px 16px rgba(15, 23, 42, 0.25)' }
        : {
            shadowColor: '#0f172a',
            shadowOpacity: 0.25,
            shadowOffset: { width: 0, height: 6 },
            shadowRadius: 16,
          }),
      elevation: 4,
    },
    verticalFeedTitle: { color: '#ffffff', fontWeight: '800', fontSize: 20, marginBottom: 6 },
    verticalFeedSubtitle: { color: '#cbd5f5', fontWeight: '600', fontSize: 13, marginTop: 2 },
    verticalFeedActions: { marginTop: 12, flexDirection: 'row', justifyContent: 'flex-end' },
    postCtaBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: '#2563EB',
      borderRadius: 999,
      paddingHorizontal: 18,
      paddingVertical: 10,
      ...(Platform.OS === 'web'
        ? { boxShadow: '0px 4px 12px rgba(30, 58, 138, 0.25)' }
        : {
            shadowColor: '#1e3a8a',
            shadowOpacity: 0.25,
            shadowRadius: 12,
            shadowOffset: { width: 0, height: 4 },
          }),
      elevation: 4,
    },
    postCtaBtnDisabled: { opacity: 0.6 },
    postCtaText: { color: '#ffffff', fontWeight: '700' },
    verticalFeedModal: { flex: 1, backgroundColor: '#020617' },
    viewerBackDrop: {
      flex: 1,
      backgroundColor: 'rgba(15,23,42,0.9)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    viewerContent: { width: '90%', aspectRatio: 3 / 4, maxHeight: '80%' },
    viewerMedia: { width: '100%', height: '100%', borderRadius: 16 },
    // Team logos banner overlay styles
    teamLogosOverlay: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 120,
      alignItems: 'center',
      paddingHorizontal: 20,
    },
    teamMatchup: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: 'rgba(0,0,0,0.7)',
      borderRadius: 16,
      paddingVertical: 12,
      paddingHorizontal: 16,
      gap: 12,
    },
    teamSideInBanner: {
      alignItems: 'center',
      gap: 4,
      minWidth: 80,
    },
    teamLogoInBanner: {
      width: 60,
      height: 60,
      borderRadius: 30,
      backgroundColor: 'rgba(255,255,255,0.2)',
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 2,
      borderColor: 'rgba(255,255,255,0.4)',
      overflow: 'hidden',
    },
    teamLogoImage: {
      width: '100%',
      height: '100%',
      borderRadius: 30,
    },
    teamLogoEmojiInBanner: {
      fontSize: 28,
    },
    teamNameInBanner: {
      color: '#ffffff',
      fontSize: 14,
      fontWeight: '700',
      textAlign: 'center',
    },
    teamLabelInBanner: {
      color: 'rgba(255,255,255,0.8)',
      fontSize: 10,
      fontWeight: '800',
      textTransform: 'uppercase',
      letterSpacing: 1,
    },
    vsDividerInBanner: {
      alignItems: 'center',
      gap: 4,
      minWidth: 60,
    },
    vsCircleInBanner: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: 'rgba(37,99,235,0.9)',
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 2,
      borderColor: 'rgba(255,255,255,0.3)',
    },
    vsTextInBanner: {
      color: '#ffffff',
      fontSize: 12,
      fontWeight: '800',
    },
    // VS quick-modal styles
    vsModalBackdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.4)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    vsModalCard: {
      width: '86%',
      backgroundColor: Colors[colorScheme].card,
      borderRadius: 12,
      padding: 16,
      alignItems: 'center',
      ...(Platform.OS === 'web'
        ? { boxShadow: '0px 4px 10px rgba(0, 0, 0, 0.12)' }
        : {
            shadowColor: '#000',
            shadowOpacity: 0.12,
            shadowRadius: 10,
            shadowOffset: { width: 0, height: 4 },
          }),
      elevation: 6,
    },
    vsModalTitle: {
      fontSize: 18,
      fontWeight: '800',
      color: Colors[colorScheme].text,
      marginBottom: 8,
      textAlign: 'center',
    },
    vsModalBody: { color: Colors[colorScheme].mutedText, textAlign: 'center', marginBottom: 12 },
    vsModalClose: {
      backgroundColor: Colors[colorScheme].tint,
      paddingVertical: 10,
      paddingHorizontal: 16,
      borderRadius: 10,
    },
    vsPollRow: { flexDirection: 'row', width: '100%', gap: 8, marginVertical: 8 },
    vsTeamCard: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: 12,
      paddingHorizontal: 8,
      borderRadius: 10,
      backgroundColor: Colors[colorScheme].surface,
      borderWidth: 1,
      borderColor: Colors[colorScheme].border,
    },
    vsTeamCardOn: {
      backgroundColor: Colors[colorScheme].tint,
      borderColor: Colors[colorScheme].tint,
    },
    vsTeamName: {
      fontWeight: '800',
      color: Colors[colorScheme].text,
      marginBottom: 4,
      textAlign: 'center',
    },
    vsTeamPct: { fontSize: 18, fontWeight: '900', color: Colors[colorScheme].text },
    vsTeamVotes: { fontSize: 12, color: Colors[colorScheme].mutedText, marginTop: 4 },
    vsDivider: { width: 12 },
    vsPctBarWrap: {
      width: '100%',
      height: 8,
      backgroundColor: colorScheme === 'dark' ? 'rgba(255,255,255,0.15)' : 'rgba(37,99,235,0.15)',
      borderRadius: 6,
      overflow: 'hidden',
      marginTop: 8,
    },
    vsPctBarFill: {
      height: '100%',
      backgroundColor: colorScheme === 'dark' ? '#60a5fa' : '#2563eb',
      width: '0%',
    },
    // Posts Grid Styles
    postsGridContainer: {
      marginTop: 12,
    },
    postsMasonryGrid: {
      flexDirection: 'row',
      gap: 8,
    },
    // One scrapbook row: 2 or 3 cells whose widths come from the row plan.
    scrapbookRow: {
      flexDirection: 'row',
      gap: 8,
      marginBottom: 8,
    },
    masonryColumn: {
      flex: 1,
      gap: 8,
    },
    masonryItem: {
      borderRadius: 12,
      overflow: 'hidden',
      backgroundColor: Colors[colorScheme].surface,
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
    postsGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      marginHorizontal: -1.5,
    },
    gridItem: {
      width: '32%',
      aspectRatio: 1,
      borderRadius: 12,
      overflow: 'hidden',
      backgroundColor: Colors[colorScheme].surface,
      marginBottom: '2%',
    },
    gridItemEmpty: {
      backgroundColor: Colors[colorScheme].surface,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: Colors[colorScheme].border,
    },
    gridImageContainer: {
      width: '100%',
      height: '100%',
    },
    gridImage: { width: '100%', height: '100%' },
    gridImageOverlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.05)',
    },
    gridImageFallback: {
      alignItems: 'center',
      justifyContent: 'center',
      padding: 12,
      position: 'relative',
    },
    textPostOverlay: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      padding: 12,
      backgroundColor: 'rgba(255,255,255,0.15)',
      borderRadius: 8,
      margin: 8,
    },
    gridTextOnly: {
      textAlign: 'center',
      color: '#ffffff',
      fontWeight: '700',
      fontSize: 12,
      lineHeight: 16,
      ...(Platform.OS === 'web'
        ? { textShadow: '0px 1px 2px rgba(0, 0, 0, 0.3)' }
        : {
            textShadowColor: 'rgba(0,0,0,0.3)',
            textShadowOffset: { width: 0, height: 1 },
            textShadowRadius: 2,
          }),
    },
    gridIconBadge: {
      position: 'absolute',
      bottom: 8,
      right: 8,
      backgroundColor: 'rgba(0,0,0,0.6)',
      borderRadius: 14,
      width: 28,
      height: 28,
      alignItems: 'center',
      justifyContent: 'center',
      ...(Platform.OS === 'web'
        ? { boxShadow: '0px 1px 2px rgba(0, 0, 0, 0.3)' }
        : {
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 0.3,
            shadowRadius: 2,
          }),
    },
    gridCounts: {
      position: 'absolute',
      left: 8,
      bottom: 8,
      backgroundColor: 'rgba(0,0,0,0.6)',
      borderRadius: 14,
      paddingHorizontal: 8,
      paddingVertical: 4,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      ...(Platform.OS === 'web'
        ? { boxShadow: '0px 1px 2px rgba(0, 0, 0, 0.3)' }
        : {
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 0.3,
            shadowRadius: 2,
          }),
    },
    gridCountItem: { flexDirection: 'row', alignItems: 'center', gap: 3 },
    gridCountText: { color: '#fff', fontSize: 10, fontWeight: '700' },
    viewAllPostsBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: Colors[colorScheme].surface,
      borderRadius: 12,
      paddingVertical: 12,
      paddingHorizontal: 16,
      marginTop: 16,
    },
    viewAllPostsText: {
      fontSize: 15,
      fontWeight: '600',
      color: Colors[colorScheme].text,
      marginRight: 8,
    },
    loginPromptSheet: {
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      padding: 24,
      paddingBottom: 40,
      gap: 12,
    },
    loginPromptTitle: {
      fontSize: 20,
      fontWeight: '800',
      textAlign: 'center',
      marginBottom: 4,
    },
    loginPromptBody: {
      fontSize: 15,
      textAlign: 'center',
      marginBottom: 8,
    },
    loginPromptBtn: {
      height: 50,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    loginPromptBtnText: {
      color: '#fff',
      fontSize: 16,
      fontWeight: '700',
    },
    loginPromptCancel: {
      height: 50,
      borderRadius: 12,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
    },
    loginPromptCancelText: {
      fontSize: 16,
      fontWeight: '600',
    },
  });
