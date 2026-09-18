import { Organization, Team, User } from '@/api/entities';
import { Button } from '@/components/ui/button';
import { EventFeedCard } from '@/components/ui/EventFeedCard';
import { Colors } from '@/constants/Colors';
import { buildEventDetailRoute } from '@/utils/eventRoutes';
import { useAuth } from '@/context/AuthProvider';
import { useCustomColorScheme } from '@/hooks/useCustomColorScheme';
import { calculateContrastRatio } from '@/utils/accessibility';
import { toUserMessage } from '@/utils/toUserMessage';
import { getAuthSnapshot } from '@/utils/authState';
import events from '@/utils/events';
import { resolveMediaType, resolvePostMedia } from '@/utils/media';
import { optimizeImageUrl } from '@/utils/imageUrl';
import { safeGoBack } from '@/utils/navigation';
import { isGameLive } from '@/utils/liveWindow';
import { buildPostGridViewerState, unwrapPostGridItem } from '@/utils/postGridViewer';
import { getCoachAccessState } from '@/utils/roleChecks';
import { getGradientForColor } from '@/utils/theme';
import { queryClient } from '@/lib/queryClient';
import { sanitizeTitle } from '@/lib/sanitizeTitle';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  InteractionManager,
  Modal,
  Pressable,
  RefreshControl,
  Text,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import GameVerticalFeedScreen, { FeedPost } from './game-details/GameVerticalFeedScreen';
import { styles } from './profile.styles';

type ProfilePreferences = {
  role?: string | null;
  plan?: string | null;
  position?: string | null;
  jersey_number?: string | number | null;
  grade_level?: string | null;
  graduation_year?: string | number | null;
  accolades?: string | null;
  primary_sport?: string | null;
  sport?: string | null;
  header_image_url?: string | null;
  header_image_focus_y?: number | null;
  location?: string | null;
};

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const SKELETON_8 = Array.from({ length: 8 });
const HEADER_IMAGE_DRAG_LIMIT = 120;
const clampValue = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * Get sport emoji based on sport type
 */
const _getSportEmoji = (sport: string): string => {
  const emojiMap: Record<string, string> = {
    basketball: '🏀',
    football: '🏈',
    baseball: '⚾',
    soccer: '⚽',
    volleyball: '🏐',
    other: '🏆',
  };
  return emojiMap[sport.toLowerCase()] || '🏆';
};

const toFeedPost = (item: any): FeedPost | null => {
  const id = item?.id ? String(item.id) : null;
  if (!id) return null;
  const media = typeof item?.media_url === 'string' ? item.media_url : null;
  const media_type = (resolveMediaType(item?.media_url, item?.media_type) ?? 'image') as
    | 'video'
    | 'image';
  return {
    id,
    media_url: media,
    media_type,
    preview_url: typeof item?.preview_url === 'string' ? item.preview_url : null,
    caption: item?.caption ?? item?.content ?? sanitizeTitle(item?.title) ?? null,
    upvotes_count: item?.upvotes_count ?? 0,
    comments_count: item?.comments_count ?? item?._count?.comments ?? 0,
    bookmarks_count: item?.bookmarks_count ?? 0,
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
    // Keep in sync with mapHighlightToFeedPost (Post-mapper Consistency Rule):
    // carry the denormalized event/game link so tap-through and the context
    // card resolve from either page.
    game_id: item?.game_id ?? item?.game?.id ?? null,
    event_id: item?.event_id ?? item?.event?.id ?? null,
  };
};

function mergeProfileSnapshot(
  nextProfile: CurrentUser | null,
  previousProfile: CurrentUser | null
) {
  if (!nextProfile) return nextProfile;
  if (!previousProfile || String(previousProfile.id || '') !== String(nextProfile.id || '')) {
    return nextProfile;
  }

  return {
    ...previousProfile,
    ...nextProfile,
    avatar_url: nextProfile.avatar_url ?? previousProfile.avatar_url,
    bio: nextProfile.bio ?? previousProfile.bio,
    created_at: nextProfile.created_at ?? previousProfile.created_at,
    _count: nextProfile._count ?? previousProfile._count,
    preferences: {
      ...(previousProfile.preferences || {}),
      ...(nextProfile.preferences || {}),
    },
  };
}

type CurrentUser = {
  id?: string | number;
  username?: string; // Only username (with @) - no display_name
  email?: string;
  avatar_url?: string;
  bio?: string;
  preferences?: {
    role?: 'fan' | 'coach' | string | null;
    plan?: string | null;
    [key: string]: any;
  } | null;
  _count?: {
    posts?: number;
    followers?: number;
    following?: number;
  };
  [key: string]: any;
};

export default function ProfileScreen() {
  const colorScheme = useCustomColorScheme();
  const theme = Colors[colorScheme];
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user: userFromAuth, checkAuth } = useAuth();
  const [loading, setLoading] = useState(false); // Start as false - only show loading when actually loading
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<CurrentUser | null>(null);
  const hasLoadedOnce = useRef(false);
  const isInitialMount = useRef(true);
  const lastUsernameRef = useRef<string | null>(null);
  const meRef = useRef<CurrentUser | null>(null);
  const lastResolvedProfileKeyRef = useRef<string | null>(null);
  const profileLoadIdRef = useRef(0);
  const [activeTab, setActiveTab] = useState<'posts' | 'replies' | 'upvotes' | 'events'>(() => {
    try {
      return (globalThis?.localStorage?.getItem('profile.activeTab') as any) || 'posts';
    } catch (error) {
      console.warn('[profile] Failed to read activeTab from localStorage:', error);
      return 'posts';
    }
  });
  const [sort, _setSort] = useState<'newest' | 'most_upvoted' | 'most_commented'>('newest');
  const _rememberingTab = useRef(false);
  const [_organizations, setOrganizations] = useState<any[]>([]);
  const [userThemeColor, setUserThemeColor] = useState<string>('#3B82F6'); // Default color
  const profileRequestInFlight = useRef(false);
  const params = useLocalSearchParams<{ id?: string }>();
  const viewingUserId = params.id;
  const viewedProfileFallback = viewingUserId ? '/(tabs)/discover' : undefined;
  const [isFollowing, setIsFollowing] = useState(false);
  const [followLoading, setFollowLoading] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [userTeams] = useState<
    Array<{
      id: string;
      name: string;
      logo_url?: string | null;
      avatar_url?: string | null;
      role?: string;
      position?: string | null;
      jersey_number?: string | number | null;
    }>
  >([]);
  const [avatarViewerVisible, setAvatarViewerVisible] = useState(false);

  const handleFollowToggle = useCallback(async () => {
    if (!viewingUserId || followLoading) return;

    setFollowLoading(true);
    const previousState = isFollowing;
    setIsFollowing(!isFollowing); // Optimistic update

    try {
      if (isFollowing) {
        await User.unfollow(viewingUserId);
        // Update follower count
        setMe(prev =>
          prev
            ? {
                ...prev,
                _count: {
                  ...prev._count,
                  followers: Math.max(0, (prev._count?.followers || 0) - 1),
                },
              }
            : null
        );
      } else {
        await User.follow(viewingUserId);
        // Update follower count
        setMe(prev =>
          prev
            ? {
                ...prev,
                _count: {
                  ...prev._count,
                  followers: (prev._count?.followers || 0) + 1,
                },
              }
            : null
        );
      }
      // Refresh from server to get accurate follower count
      try {
        const refreshed = await User.getPublic(viewingUserId);
        if (refreshed) {
          // Keep the cached profile in sync so a later revisit shows the
          // updated follower count without a refetch.
          queryClient.setQueryData(['public-user', viewingUserId], refreshed);
          setMe(prev =>
            prev
              ? {
                  ...prev,
                  _count: refreshed._count ?? prev._count,
                }
              : null
          );
          setIsFollowing(refreshed.is_following ?? !previousState);
        }
      } catch {
        // Non-critical — optimistic state is already set
      }
    } catch (error) {
      console.error('[profile] Follow toggle failed:', error);
      setIsFollowing(previousState); // Revert on error
      Alert.alert('Error', 'Failed to update follow status. Please try again.');
    } finally {
      setFollowLoading(false);
      // Fresh server counts (avoid stale _count after follow/unfollow)
      if (viewingUserId) {
        void (async () => {
          try {
            const u = await User.getPublic(viewingUserId);
            if (u) {
              queryClient.setQueryData(['public-user', viewingUserId], u);
              setMe(u);
              setIsFollowing(!!u.is_following);
            }
          } catch {
            /* ignore */
          }
        })();
      }
    }
  }, [viewingUserId, isFollowing, followLoading]);

  // The three tab lists are cursor-paginated infinite queries, keyed per
  // profile user + sort. Only the ACTIVE tab is enabled (lazy, like the old
  // per-tab refresh), and a previously-visited tab renders instantly from
  // cache when switched back to.
  const isViewingOtherProfile = !!viewingUserId && viewingUserId !== currentUserId;
  const isRestrictedProfile =
    isViewingOtherProfile &&
    ((me as any)?.profile_restricted === true ||
      ((me as any)?.profile_private === true &&
        !(me as any)?._count &&
        (me as any)?.posts_count == null));
  const profileUserId =
    !isRestrictedProfile && me?.id && String(me.id) !== 'undefined' && String(me.id) !== 'null'
      ? String(me.id)
      : null;

  // Event pages this user was geofence-verified at. The server reads its
  // durable presence ledger and enforces profile/team privacy before this list
  // reaches the client.
  const eventPagesQuery = useQuery({
    queryKey: ['profile-event-pages', profileUserId],
    enabled: !!profileUserId,
    queryFn: () => User.eventPagesForProfile(profileUserId as string),
  });
  const eventPages: any[] = eventPagesQuery.data?.items ?? [];
  const hasEventPages = eventPages.length > 0;
  // A previously-persisted 'events' selection must not strand the user on a
  // hidden tab if this profile turns out to have no event-page posts.
  const resolvedActiveTab = activeTab === 'events' && !hasEventPages ? 'posts' : activeTab;

  const postsQuery = useInfiniteQuery({
    queryKey: ['profile-posts', profileUserId, sort],
    enabled: !!profileUserId && resolvedActiveTab === 'posts',
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      User.postsForProfile(profileUserId as string, {
        limit: 10,
        sort,
        cursor: pageParam || undefined,
      }),
    getNextPageParam: (last: any) => last?.nextCursor || undefined,
  });
  const repliesQuery = useInfiniteQuery({
    queryKey: ['profile-replies', profileUserId, sort],
    enabled: !!profileUserId && resolvedActiveTab === 'replies',
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      User.interactionsForProfile(profileUserId as string, {
        limit: 10,
        type: 'comment',
        sort,
        cursor: pageParam || undefined,
      }),
    getNextPageParam: (last: any) => last?.nextCursor || undefined,
  });
  const upvotesQuery = useInfiniteQuery({
    queryKey: ['profile-upvotes', profileUserId, sort],
    enabled: !!profileUserId && resolvedActiveTab === 'upvotes',
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      User.interactionsForProfile(profileUserId as string, {
        limit: 10,
        type: 'like',
        sort,
        cursor: pageParam || undefined,
      }),
    getNextPageParam: (last: any) => last?.nextCursor || undefined,
  });

  const posts = useMemo(
    () => postsQuery.data?.pages.flatMap((p: any) => p?.items || []) ?? [],
    [postsQuery.data]
  );
  const replies = useMemo(
    () => repliesQuery.data?.pages.flatMap((p: any) => p?.items || []) ?? [],
    [repliesQuery.data]
  );
  const upvotes = useMemo(
    () => upvotesQuery.data?.pages.flatMap((p: any) => p?.items || []) ?? [],
    [upvotesQuery.data]
  );

  // Footer spinners: first page (isPending) or an in-flight next page.
  const postsLoading = postsQuery.isPending || postsQuery.isFetchingNextPage;
  const repliesLoading = repliesQuery.isPending || repliesQuery.isFetchingNextPage;
  const upvotesLoading = upvotesQuery.isPending || upvotesQuery.isFetchingNextPage;

  // Vertical viewer state
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerIndex, setViewerIndex] = useState(0);
  const [viewerItems, setViewerItems] = useState<FeedPost[]>([]);
  const _profileResetCount = useRef(0);

  const loadProfile = useCallback(
    async (options?: { silent?: boolean }) => {
      const loadId = profileLoadIdRef.current + 1;
      profileLoadIdRef.current = loadId;
      if (profileRequestInFlight.current) return;
      profileRequestInFlight.current = true;

      // Only show loading skeleton on very first load (initial mount with no data)
      const isInitialLoad = isInitialMount.current && !hasLoadedOnce.current && !meRef.current;
      if (!options?.silent && isInitialLoad) {
        setLoading(true);
      }
      // If silent refresh or already loaded, ensure loading is false
      if (options?.silent || hasLoadedOnce.current) {
        setLoading(false);
      }
      setError(null);

      try {
        const currentUser: any = await getAuthSnapshot(checkAuth, userFromAuth);
        setCurrentUserId(currentUser?.id || null);

        let u: any;
        const requestedProfileKey =
          viewingUserId && viewingUserId !== currentUser?.id
            ? `user:${viewingUserId}`
            : `me:${currentUser?.id || 'self'}`;
        // If viewing another user's profile
        if (viewingUserId && viewingUserId !== currentUser?.id) {
          // Route through the react-query cache so revisiting a recently-viewed
          // profile resolves instantly (no wheel) instead of re-fetching. The
          // 30s staleTime default still revalidates after the window.
          const raw = await queryClient.fetchQuery({
            queryKey: ['public-user', viewingUserId],
            queryFn: () => User.getPublic(viewingUserId),
          });
          // Normalize flat followers_count / following_count → _count shape
          if (raw && !raw._count && (raw.followers_count != null || raw.following_count != null)) {
            raw._count = {
              followers: raw.followers_count ?? 0,
              following: raw.following_count ?? 0,
              posts: raw.posts_count ?? 0,
            };
          }
          u = raw;
          if (u) {
            setIsFollowing(u.is_following || false);
          }
        } else {
          // Viewing own profile
          u = mergeProfileSnapshot(currentUser, meRef.current);
        }

        if (loadId !== profileLoadIdRef.current) {
          return;
        }

        if (u) {
          lastResolvedProfileKeyRef.current = requestedProfileKey;
          meRef.current = u ?? null;
          setMe(u ?? null);
        }
        if (!u?.id) {
          setError(viewingUserId ? 'User not found.' : 'You need to sign in to view your profile.');
          setLoading(false);
          return;
        }

        // Mark as loaded and not initial mount anymore
        hasLoadedOnce.current = true;
        isInitialMount.current = false;

        // Extract theme color from preferences - only for coach/organization accounts
        const userRole = (u?.preferences?.role || u?.role || '').toLowerCase();
        const isCoachOrOrg =
          userRole === 'coach' || userRole === 'admin' || userRole === 'organization';
        const themeColor = isCoachOrOrg ? u?.preferences?.theme_color || '#3B82F6' : '#6B7280'; // Default gray for fans
        setUserThemeColor(themeColor);

        // Tab lists load via their own queries once `me` resolves (see the
        // useInfiniteQuery block above) — nothing to await here.
      } catch (e: any) {
        if (loadId !== profileLoadIdRef.current) {
          return;
        }
        if (e?.status !== 404) {
          console.error('[Profile] Failed to load profile:', e);
        }
        // A silent refresh that fails while data is already on screen stays
        // silent — the user keeps the stale profile rather than losing it. But
        // a silent load that fails with NOTHING on screen must surface, or the
        // screen is stuck on the bare "Unable to load profile" fallback with no
        // message, no distinction between timed-out and not-found, and no way
        // back except Retry.
        if (!options?.silent || !meRef.current) {
          if (e && e.status === 401) {
            setError('You need to sign in to view your profile.');
          } else if (e?.status === 404 && viewingUserId) {
            setError('This user was not found or may have been deleted.');
          } else if (e?.isNetworkError || e?.status === 0) {
            setError('Unable to connect to server. Please check your internet connection.');
          } else {
            setError(toUserMessage(e, 'Unable to load profile. Please try again.'));
          }
          // Clear me on error to prevent stale data
          setMe(null);
        }
      } finally {
        profileRequestInFlight.current = false;
        setLoading(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [checkAuth, userFromAuth, viewingUserId]
  );

  // Initial load on mount - only once. Deferred until the push animation
  // finishes so the transition isn't competing with network parsing.
  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => {
      if (isInitialMount.current) {
        void loadProfile();
      }
    });
    return () => task.cancel();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Empty deps - only run once on mount

  useEffect(() => {
    if (isInitialMount.current) return;
    setViewerOpen(false);
    setError(null);
    void loadProfile({ silent: true });
  }, [loadProfile, viewingUserId]);

  // Sync with user data from hooks/AuthProvider when username changes
  useEffect(() => {
    const currentUsername = userFromAuth?.username;
    const previousUsername = lastUsernameRef.current;

    // On mount, only record the username — the mount effect above owns the
    // initial load. Without this guard this effect fired first (lastUsernameRef
    // starts null, so any signed-in username "changed"), and its silent load
    // both forced `loading` false and claimed the in-flight guard, so the real
    // load never ran and the screen rendered the bare `!me` "Unable to load
    // profile" state for the whole request instead of the skeleton.
    if (isInitialMount.current) {
      if (currentUsername) lastUsernameRef.current = currentUsername;
      return;
    }

    // Only refresh if the username actually changed from what we last saw
    if (currentUsername && currentUsername !== previousUsername) {
      lastUsernameRef.current = currentUsername;
      void loadProfile({ silent: true });
    } else if (currentUsername) {
      lastUsernameRef.current = currentUsername;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userFromAuth?.username]);

  // Silent refresh on focus - NEVER show skeleton after first load.
  // Deferred so the return transition isn't competing with the refetch.
  const activeTabQuery =
    resolvedActiveTab === 'posts'
      ? postsQuery
      : resolvedActiveTab === 'replies'
        ? repliesQuery
        : resolvedActiveTab === 'events'
          ? eventPagesQuery
          : upvotesQuery;
  const refetchActiveTab = activeTabQuery.refetch;
  const activeTabHasData = activeTabQuery.data !== undefined;

  // Pull-to-refresh: re-fetch the profile itself plus whichever tab list is
  // currently active. The other two tabs are lazy (`enabled` gated) and pick
  // up fresh data next time they're switched to.
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([loadProfile({ silent: true }), refetchActiveTab()]);
    } finally {
      setRefreshing(false);
    }
  }, [loadProfile, refetchActiveTab]);

  useFocusEffect(
    useCallback(() => {
      const task = InteractionManager.runAfterInteractions(() => {
        if (hasLoadedOnce.current) {
          void loadProfile({ silent: true });
          // Background-refresh the active tab list too — the old loadProfile
          // refreshed it on focus, and react-query has no window-focus concept
          // on native. Gated on the tab already having data (background-only:
          // refetch() doesn't flip isPending once data exists) so a fresh
          // post/reply shows up when returning to the profile.
          if (profileUserId && activeTabHasData) {
            void refetchActiveTab();
          }
        } else if (isInitialMount.current && !profileRequestInFlight.current) {
          void loadProfile();
        }
      });
      return () => task.cancel();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loadProfile, profileUserId, activeTabHasData, refetchActiveTab])
  );

  // Load organizations separately to avoid blocking profile render
  useEffect(() => {
    if (!me?.id || isViewingOtherProfile) {
      setOrganizations([]);
      return;
    }

    const loadOrganizations = async () => {
      try {
        const myTeams = await Team.list('', true); // mine=true

        if (Array.isArray(myTeams) && myTeams.length > 0) {
          // Extract unique organization IDs from teams
          const orgIds = new Set<string>();
          const orgNames = new Set<string>();

          myTeams.forEach((team: any) => {
            if (team.organization_id) {
              orgIds.add(team.organization_id);
            }
            // Also try to extract organization from team name (e.g., "SHS Men's Soccer" -> "SHS")
            if (team.name) {
              const nameParts = String(team.name).split(/\s+/);
              if (nameParts.length > 0) {
                orgNames.add(nameParts[0]);
              }
            }
          });

          // Try to fetch by ID first
          if (orgIds.size > 0) {
            const orgPromises = Array.from(orgIds).map(id =>
              Organization.get(id).catch((_err: any) => null)
            );

            const orgsData = await Promise.all(orgPromises);
            const validOrgs = orgsData.filter(org => org !== null);

            if (validOrgs.length > 0) {
              setOrganizations(validOrgs);
            }
          }

          // If no orgs found by ID, try searching by name
          if (orgIds.size === 0 && orgNames.size > 0) {
            const searchPromises = Array.from(orgNames).map(name =>
              Organization.list(name, 5).catch((_err: any) => [])
            );

            const searchResults = await Promise.all(searchPromises);
            const flatResults = searchResults.flat();

            // Deduplicate by ID
            const uniqueOrgs = flatResults.filter(
              (org: any, index: number, self: any[]) =>
                org && org.id && self.findIndex((o: any) => o?.id === org.id) === index
            );

            setOrganizations(uniqueOrgs);
          }
        }
      } catch (err) {
        console.error('Failed to load organizations', err);
      }
    };

    void loadOrganizations();
  }, [isViewingOtherProfile, me?.id]);

  // Clear any stale profile error when switching tabs (the tab queries
  // themselves fetch lazily via their `enabled` gates; sort changes refetch
  // automatically because sort is part of each query key)
  useEffect(() => {
    setError(null);
  }, [activeTab]);

  // Refresh replies when a new comment is created from the viewer
  useEffect(() => {
    if (!profileUserId) return;
    const off = events.on('comment:created', () => {
      if (activeTab === 'replies') {
        void repliesQuery.refetch();
      }
    });
    return () => {
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, profileUserId]);

  const preferences = me?.preferences ? (me.preferences as ProfilePreferences) : null;
  const rawRole = preferences?.role ?? (me as any)?.role ?? '';
  const roleRaw = typeof rawRole === 'string' ? rawRole.toLowerCase() : '';
  const coachAccess = getCoachAccessState(me as any);
  const approvedCoach = coachAccess.isApprovedCoach;
  // v1.0.2 audit fix: do NOT surface "Pending Coach" to the user.
  // Pre-approval, display "Fan" so profile looks normal; internal approval_status stays intact.
  // No "Coach / Organizer" badge — removed per device-testing feedback. The
  // Player badge (roster members) is unaffected.
  const roleLabel = roleRaw === 'player' ? 'Player' : null;
  // Guard against internal IDs (cuid / UUID) being leaked as username
  const isInternalId = (s: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) || // UUID
    /^c[0-9a-z]{20,}$/.test(s); // CUID
  const displayUsername = me?.username && !isInternalId(me.username) ? `@${me.username}` : 'User';
  const headerBackgroundImage = preferences?.header_image_url || null;
  const headerImageFocusY = clampValue(
    typeof preferences?.header_image_focus_y === 'number' ? preferences.header_image_focus_y : 0,
    -1,
    1
  );
  const heroGradientColors: [string, string, ...string[]] = headerBackgroundImage
    ? ['rgba(4,7,20,0.85)', 'rgba(15,23,42,0.45)']
    : (getGradientForColor(userThemeColor) as [string, string, ...string[]]);

  // Helper function to determine text color based on background contrast
  // White is default, but switches to #000000 if white has insufficient contrast
  const getTextColorForBackground = (bgColor: string): string => {
    // Convert rgba to hex if needed
    let hexColor = bgColor;
    if (bgColor.startsWith('rgba')) {
      const match = bgColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (match) {
        const r = parseInt(match[1], 10);
        const g = parseInt(match[2], 10);
        const b = parseInt(match[3], 10);
        // Defensive: parseInt of a non-numeric capture returns NaN, which
        // .toString(16) renders as "NaN" — produces an invalid hex color
        // that breaks the contrast calculation. Fall back to #000000 on any
        // bad parse rather than rendering broken text on top of unknown bg.
        if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
          return '#000000'; // audit: intentional — contrast fallback, not a themed text color
        }
        hexColor = `#${[r, g, b]
          .map(x => {
            const hex = x.toString(16);
            return hex.length === 1 ? '0' + hex : hex;
          })
          .join('')}`;
      }
    }

    // Calculate contrast ratio for white text (default)
    const whiteContrast = calculateContrastRatio('#FFFFFF', hexColor);

    // If white has sufficient contrast (>= 3.0 for large text), use white
    // Otherwise, use #000000
    if (whiteContrast && whiteContrast >= 3.0) {
      return '#FFFFFF';
    }
    return '#000000'; // audit: intentional — computed contrast color against dynamic background
  };

  // Get the first gradient color to determine text color
  const firstGradientColor = heroGradientColors[0] || userThemeColor;
  const _userNameTextColor = getTextColorForBackground(firstGradientColor);

  const _stats = [
    { label: 'posts', value: me?._count?.posts ?? 0 },
    { label: 'followers', value: me?._count?.followers ?? 0 },
    { label: 'following', value: me?._count?.following ?? 0 },
  ];

  const renderHeader = () => (
    <>
      {/* Banner Header - Exact Match to Reference */}
      <View style={[styles.headerContainer, { backgroundColor: theme.background }]}>
        {/* Background Image / Gradient */}
        <Pressable
          testID="profile-background-image"
          onPress={undefined}
          style={styles.headerBackgroundPressable}
          disabled
          accessibilityRole="button"
          accessibilityLabel="Profile background image"
        >
          {headerBackgroundImage ? (
            <Image
              source={{ uri: headerBackgroundImage }}
              style={[
                styles.headerBackgroundImage,
                { transform: [{ translateY: headerImageFocusY * HEADER_IMAGE_DRAG_LIMIT }] },
              ]}
              contentFit="cover"
              cachePolicy="memory-disk"
              recyclingKey={headerBackgroundImage}
              transition={120}
            />
          ) : (
            <View style={styles.headerBackgroundImage} />
          )}
        </Pressable>
        {!headerBackgroundImage && (
          <LinearGradient
            colors={heroGradientColors}
            style={styles.headerGradient}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
          />
        )}
        {/* Dark scrim at the bottom of the header for text readability */}
        <LinearGradient
          colors={['transparent', 'rgba(0,0,0,0.55)']}
          style={[styles.headerGradient, { pointerEvents: 'none' }]}
          start={{ x: 0, y: 0.3 }}
          end={{ x: 0, y: 1 }}
        />

        {/* Settings Button & Follow Button - Top Right Corner */}
        <View style={[styles.headerControls, { top: 12 }]}>
          {viewingUserId && viewingUserId !== currentUserId ? (
            <View style={styles.headerActionRow}>
              <Pressable
                testID="profile-message-button"
                style={[styles.headerActionButton, styles.headerActionButtonGhost]}
                onPress={() =>
                  void router.push({
                    pathname: '/message-thread',
                    params: {
                      with: viewingUserId,
                      fallback: `/user-profile?id=${encodeURIComponent(viewingUserId)}`,
                    },
                  } as any)
                }
                accessibilityRole="button"
                accessibilityLabel="Send message"
              >
                <Ionicons name="chatbubble-outline" size={15} color="#FFFFFF" />
                <Text style={styles.headerActionButtonText}>Message</Text>
              </Pressable>
              <Pressable
                testID="profile-follow-button"
                style={[
                  styles.headerActionButton,
                  isFollowing ? styles.headerActionButtonActive : styles.headerActionButtonGhost,
                  followLoading && { opacity: 0.5 },
                ]}
                onPress={handleFollowToggle}
                disabled={followLoading}
                accessibilityRole="button"
                accessibilityLabel={isFollowing ? 'Unfollow' : 'Follow'}
              >
                {isFollowing ? (
                  <>
                    <Ionicons name="checkmark-circle" size={16} color="#FFB800" />
                    <Text style={[styles.headerActionButtonText, { color: '#FFB800' }]}>
                      Following
                    </Text>
                  </>
                ) : (
                  <>
                    <Ionicons name="person-add-outline" size={15} color="#FFFFFF" />
                    <Text style={styles.headerActionButtonText}>Follow</Text>
                  </>
                )}
              </Pressable>
            </View>
          ) : null}
          {/* Block & Report menu for other users */}
          {viewingUserId && viewingUserId !== currentUserId ? (
            <Pressable
              testID="profile-options-button"
              onPress={() => {
                Alert.alert('Options', undefined, [
                  {
                    text: 'Report User',
                    onPress: () =>
                      router.push(
                        `/report-abuse?target_type=user&target_id=${encodeURIComponent(viewingUserId)}` as any
                      ),
                  },
                  {
                    text: 'Block User',
                    style: 'destructive',
                    onPress: async () => {
                      try {
                        await User.block(viewingUserId);
                        queryClient.removeQueries({ queryKey: ['public-user', viewingUserId] });
                        queryClient.removeQueries({ queryKey: ['profile-posts', viewingUserId] });
                        queryClient.removeQueries({ queryKey: ['profile-replies', viewingUserId] });
                        queryClient.removeQueries({ queryKey: ['profile-upvotes', viewingUserId] });
                        void queryClient.invalidateQueries({ queryKey: ['feed'] });
                        void queryClient.invalidateQueries({
                          queryKey: ['discover-personalization'],
                        });
                        void queryClient.invalidateQueries({
                          queryKey: ['discover-suggested-people'],
                        });
                        setViewerOpen(false);
                        setMe(null);
                        setIsFollowing(false);
                        Alert.alert('Blocked', 'This user has been blocked.', [
                          { text: 'OK', onPress: () => safeGoBack(router, '/(tabs)/discover') },
                        ]);
                      } catch (e: any) {
                        Alert.alert('Error', toUserMessage(e, 'Failed to block user'));
                      }
                    },
                  },
                  { text: 'Cancel', style: 'cancel' },
                ]);
              }}
              hitSlop={12}
              style={[styles.controlButton, { backgroundColor: 'rgba(0,0,0,0.5)', marginLeft: 6 }]}
            >
              <Ionicons name="ellipsis-horizontal" size={18} color="#FFFFFF" />
            </Pressable>
          ) : null}

          {/* Settings Button - Only when viewing own profile */}
          {!viewingUserId || viewingUserId === currentUserId ? (
            <Pressable
              testID="profile-settings-button"
              onPress={() => router.push('/settings')}
              hitSlop={12}
              style={[
                styles.controlButton,
                {
                  backgroundColor:
                    colorScheme === 'dark' ? 'rgba(0, 0, 0, 0.7)' : 'rgba(255, 255, 255, 0.9)',
                },
              ]}
              accessibilityRole="button"
              accessibilityLabel="Settings"
            >
              <Ionicons name="settings-outline" size={18} color={theme.text} />
            </Pressable>
          ) : null}
        </View>

        {/* Profile Content - Avatar on Bottom-Left of Banner */}
        <View style={styles.profileContent}>
          {/* Large Avatar - Overlapping Banner */}
          <Pressable
            testID="profile-avatar"
            onPress={me?.avatar_url ? () => setAvatarViewerVisible(true) : undefined}
            style={styles.avatarSection}
            accessibilityRole="button"
            accessibilityLabel={me?.avatar_url ? 'View profile picture' : 'Profile picture'}
          >
            <View style={styles.avatarContainer}>
              {me?.avatar_url ? (
                <Image
                  source={{ uri: String(me?.avatar_url) }}
                  style={styles.avatarImage}
                  contentFit="cover"
                  cachePolicy="memory-disk"
                  recyclingKey={String(me?.avatar_url)}
                  transition={120}
                />
              ) : (
                <View
                  style={[
                    styles.avatarPlaceholder,
                    {
                      backgroundColor: colorScheme === 'dark' ? theme.surface : '#E5E7EB',
                    },
                  ]}
                >
                  <Ionicons name="person" size={48} color={theme.mutedText} />
                </View>
              )}
            </View>
          </Pressable>

          {/* Edit button for own profile */}
          <View
            style={{
              flex: 1,
              alignItems: 'flex-end',
              justifyContent: 'flex-end',
              paddingRight: 12,
              paddingBottom: 8,
            }}
          >
            {(!viewingUserId || viewingUserId === currentUserId) && (
              <Pressable
                testID="profile-edit-button"
                style={[
                  styles.editButtonBelowBanner,
                  { backgroundColor: theme.surface || theme.background, borderColor: theme.border },
                ]}
                onPress={() => void router.push('/edit-profile')}
                accessibilityRole="button"
                accessibilityLabel="Edit profile"
              >
                <Text style={[styles.editButtonBelowBannerText, { color: theme.text }]}>
                  Edit profile
                </Text>
              </Pressable>
            )}
          </View>
        </View>
      </View>

      {/* Content Below Banner */}
      <View style={[styles.profileDetailsContainer, { backgroundColor: theme.background }]}>
        {/* User Info — name + role badge */}
        <View style={styles.userInfoBelowBanner}>
          <View style={styles.nameRow}>
            <Text style={[styles.userName, { color: theme.text }]}>{displayUsername}</Text>
            {roleLabel && (
              <View
                style={[
                  styles.roleBadge,
                  approvedCoach && styles.coachBadge,
                  roleRaw === 'player' && styles.playerBadge,
                ]}
              >
                <Text style={styles.roleText}>{roleLabel.toUpperCase()}</Text>
              </View>
            )}
          </View>
        </View>

        {/* User Details - Left aligned with avatar */}
        <View style={styles.userDetails}>
          {me?.bio && <Text style={[styles.userBio, { color: theme.text }]}>{me.bio}</Text>}

          {/* Joined Date */}
          {me?.created_at && (
            <View style={styles.metaItem}>
              <Ionicons
                name="calendar-outline"
                size={14}
                color={colorScheme === 'dark' ? theme.mutedText : '#4B5563'}
              />
              <Text
                style={[
                  styles.metaText,
                  { color: colorScheme === 'dark' ? theme.mutedText : '#4B5563' },
                ]}
              >
                Joined{' '}
                {new Date(me.created_at).toLocaleDateString('en-US', {
                  month: 'long',
                  year: 'numeric',
                })}
              </Text>
            </View>
          )}

          {/* Following/Followers - Separate with Bold Numbers, tight spacing */}
          <View style={styles.statsRow}>
            <Pressable
              style={styles.statTappable}
              onPress={() => {
                const uid = viewingUserId || me?.id;
                if (uid)
                  router.push(
                    `/following?id=${uid}&username=${encodeURIComponent(me?.username || '')}`
                  );
              }}
            >
              <Text style={[styles.statNumber, { color: theme.text }]}>
                {me?._count?.following ?? 0}
              </Text>
              <Text
                style={[
                  styles.statLabel,
                  { color: colorScheme === 'dark' ? theme.mutedText : '#4B5563' },
                ]}
              >
                {' '}
                Following{' '}
              </Text>
            </Pressable>
            <Pressable
              style={styles.statTappable}
              onPress={() => {
                const uid = viewingUserId || me?.id;
                if (uid)
                  router.push(
                    `/followers?id=${uid}&username=${encodeURIComponent(me?.username || '')}`
                  );
              }}
            >
              <Text style={[styles.statNumber, { color: theme.text }]}>
                {me?._count?.followers ?? 0}
              </Text>
              <Text
                style={[
                  styles.statLabel,
                  { color: colorScheme === 'dark' ? theme.mutedText : '#4B5563' },
                ]}
              >
                {' '}
                Followers
              </Text>
            </Pressable>
          </View>

          {/* Teams - Athlete profile section */}
          {userTeams.length > 0 && (
            <View
              style={[
                styles.teamsSection,
                { borderColor: theme.border, backgroundColor: theme.surface || theme.background },
              ]}
            >
              <Text style={[styles.teamsSectionTitle, { color: theme.text }]}>Teams</Text>
              <View style={styles.teamsList}>
                {userTeams.map(t => (
                  <Pressable
                    key={t.id}
                    style={({ pressed }) => [
                      styles.teamChip,
                      {
                        borderColor: theme.border,
                        backgroundColor: pressed ? theme.background : theme.card,
                      },
                    ]}
                    onPress={() =>
                      void router.push({
                        pathname: '/team-page',
                        params: { id: t.id, name: t.name },
                      } as any)
                    }
                  >
                    {t.logo_url || t.avatar_url ? (
                      <Image
                        source={{ uri: t.logo_url || t.avatar_url || '' }}
                        style={styles.teamChipAvatar}
                        contentFit="cover"
                      />
                    ) : (
                      <View
                        style={[styles.teamChipPlaceholder, { backgroundColor: theme.tint + '30' }]}
                      >
                        <Ionicons name="people" size={14} color={theme.tint} />
                      </View>
                    )}
                    <Text style={[styles.teamChipName, { color: theme.text }]} numberOfLines={1}>
                      {t.name}
                    </Text>
                    {t.role && (
                      <Text style={[styles.teamChipRole, { color: theme.mutedText }]}>
                        {String(t.role).replace(/_/g, ' ')}
                      </Text>
                    )}
                    <Ionicons name="chevron-forward" size={12} color={theme.mutedText} />
                  </Pressable>
                ))}
              </View>
            </View>
          )}
        </View>
      </View>

      {/* Tabs */}
      <View style={[styles.tabsContainer, { borderBottomColor: theme.border }]}>
        <Pressable
          testID="profile-posts-tab"
          onPress={() => {
            setActiveTab('posts');
            try {
              globalThis?.localStorage?.setItem('profile.activeTab', 'posts');
            } catch (error) {
              if (__DEV__) console.warn('[profile] localStorage error:', error);
            }
          }}
          style={[
            styles.tab,
            activeTab === 'posts' && { borderBottomWidth: 2, borderBottomColor: theme.tint },
          ]}
          accessibilityRole="tab"
          accessibilityLabel="Posts"
          accessibilityState={{ selected: activeTab === 'posts' }}
        >
          <Text
            style={[
              styles.tabText,
              { color: activeTab === 'posts' ? theme.tint : theme.mutedText },
            ]}
          >
            Posts
          </Text>
        </Pressable>
        <Pressable
          testID="profile-replies-tab"
          onPress={() => {
            setActiveTab('replies');
            try {
              globalThis?.localStorage?.setItem('profile.activeTab', 'replies');
            } catch (error) {
              if (__DEV__) console.warn('[profile] localStorage error:', error);
            }
          }}
          style={[
            styles.tab,
            activeTab === 'replies' && { borderBottomWidth: 2, borderBottomColor: theme.tint },
          ]}
          accessibilityRole="tab"
          accessibilityLabel="Replies"
          accessibilityState={{ selected: activeTab === 'replies' }}
        >
          <Text
            style={[
              styles.tabText,
              { color: activeTab === 'replies' ? theme.tint : theme.mutedText },
            ]}
          >
            Replies
          </Text>
        </Pressable>
        <Pressable
          testID="profile-upvotes-tab"
          onPress={() => {
            setActiveTab('upvotes');
            try {
              globalThis?.localStorage?.setItem('profile.activeTab', 'upvotes');
            } catch (error) {
              if (__DEV__) console.warn('[profile] localStorage error:', error);
            }
          }}
          style={[
            styles.tab,
            activeTab === 'upvotes' && { borderBottomWidth: 2, borderBottomColor: theme.tint },
          ]}
          accessibilityRole="tab"
          accessibilityLabel="Upvotes"
          accessibilityState={{ selected: activeTab === 'upvotes' }}
        >
          <Text
            style={[
              styles.tabText,
              { color: activeTab === 'upvotes' ? theme.tint : theme.mutedText },
            ]}
          >
            Upvotes
          </Text>
        </Pressable>
        {hasEventPages && (
          <Pressable
            testID="profile-events-tab"
            onPress={() => {
              setActiveTab('events');
              try {
                globalThis?.localStorage?.setItem('profile.activeTab', 'events');
              } catch (error) {
                if (__DEV__) console.warn('[profile] localStorage error:', error);
              }
            }}
            style={[
              styles.tab,
              resolvedActiveTab === 'events' && {
                borderBottomWidth: 2,
                borderBottomColor: theme.tint,
              },
            ]}
            accessibilityRole="tab"
            accessibilityLabel="Events"
            accessibilityState={{ selected: resolvedActiveTab === 'events' }}
          >
            <Text
              style={[
                styles.tabText,
                { color: resolvedActiveTab === 'events' ? theme.tint : theme.mutedText },
              ]}
            >
              Events
            </Text>
          </Pressable>
        )}
      </View>
    </>
  );

  const renderEmptyPosts = () => (
    <View style={styles.emptyContainer}>
      <Text style={[styles.emptyTitle, { color: theme.text }]}>
        {isRestrictedProfile ? 'Private profile' : 'No posts yet'}
      </Text>
      <Text
        style={[
          styles.emptySubtitle,
          {
            color: colorScheme === 'dark' ? theme.mutedText : '#4B5563', // Darker grey for better contrast in light mode
          },
        ]}
      >
        {isRestrictedProfile
          ? 'Follow request approval is required to view this profile.'
          : isViewingOtherProfile
            ? 'This profile has not shared any posts yet.'
            : 'Share your first moment with the community!'}
      </Text>
      {!isViewingOtherProfile && !isRestrictedProfile ? (
        <Pressable
          onPress={() => void router.push('/create')}
          style={({ pressed }) => [
            styles.createPostButton,
            {
              backgroundColor: theme.tint,
              borderColor: theme.tint,
              opacity: pressed ? 0.9 : 1,
            },
          ]}
        >
          <Text style={[styles.createPostButtonText, { color: '#FFFFFF', fontWeight: '700' }]}>
            Create Your First Post
          </Text>
        </Pressable>
      ) : null}
    </View>
  );

  const renderEmptyReplies = () => (
    <View style={styles.emptyContainer}>
      <Text style={[styles.emptyTitle, { color: theme.text }]}>
        {isRestrictedProfile ? 'Private profile' : 'No replies yet'}
      </Text>
    </View>
  );

  const renderEmptyUpvotes = () => (
    <View style={styles.emptyContainer}>
      <Text style={[styles.emptyTitle, { color: theme.text }]}>
        {isRestrictedProfile ? 'Private profile' : 'No upvotes yet'}
      </Text>
    </View>
  );

  // Events tab: event/game pages this user attended, using the same
  // feed-style card as the main feed (these are pages, not individual posts).
  const renderEventPagesList = () => (
    <FlatList
      key="events"
      data={eventPages}
      keyExtractor={item => String(item.id)}
      contentContainerStyle={
        eventPages.length === 0 ? { flexGrow: 1, justifyContent: 'center' } : { padding: 12 }
      }
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.tint} />
      }
      ListEmptyComponent={
        eventPagesQuery.isLoading ? null : (
          <View style={styles.emptyContainer}>
            <Text style={[styles.emptyTitle, { color: theme.text }]}>
              No events you&apos;ve been to yet
            </Text>
          </View>
        )
      }
      renderItem={({ item }) => {
        const now = Date.now();
        const isLive = isGameLive(item, now);
        return (
          <View style={{ marginBottom: 12 }}>
            <EventFeedCard
              item={item}
              colorScheme={colorScheme}
              isLive={isLive}
              testID={`profile-event-card-${item.id}`}
              onPress={() =>
                router.push(buildEventDetailRoute(item.event_id || item.id, item.game_id))
              }
            />
          </View>
        );
      }}
    />
  );

  // fetchNextPage has a built-in in-flight guard; hasNextPage replaces the
  // old cursor/hasMore bookkeeping.
  const onEndReachedPosts = useCallback(() => {
    if (postsQuery.hasNextPage && !postsQuery.isFetchingNextPage) void postsQuery.fetchNextPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postsQuery.hasNextPage, postsQuery.isFetchingNextPage, postsQuery.fetchNextPage]);
  const onEndReachedReplies = useCallback(() => {
    if (repliesQuery.hasNextPage && !repliesQuery.isFetchingNextPage)
      void repliesQuery.fetchNextPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repliesQuery.hasNextPage, repliesQuery.isFetchingNextPage, repliesQuery.fetchNextPage]);
  const onEndReachedUpvotes = useCallback(() => {
    if (upvotesQuery.hasNextPage && !upvotesQuery.isFetchingNextPage)
      void upvotesQuery.fetchNextPage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [upvotesQuery.hasNextPage, upvotesQuery.isFetchingNextPage, upvotesQuery.fetchNextPage]);

  const openPostGridViewer = useCallback(
    (sourceItems: any[], index: number, unwrapSource: boolean) => {
      const state = buildPostGridViewerState(sourceItems, index, unwrapSource, toFeedPost);
      setViewerItems(state.items);
      setViewerIndex(state.index);
      setViewerOpen(true);
    },
    []
  );

  const renderPostGridTile = useCallback(
    ({
      item,
      index,
      sourceItems,
      unwrapSource,
    }: {
      item: any;
      index: number;
      sourceItems: any[];
      unwrapSource: boolean;
    }) => {
      const postItem = unwrapSource ? unwrapPostGridItem(item) : item;
      const media = resolvePostMedia(postItem);
      const likes = postItem?.upvotes_count ?? 0;
      const comments = postItem?.comments_count ?? postItem?._count?.comments ?? 0;
      const caption = String(postItem?.caption || postItem?.content || '').trim();
      const author = postItem?.author;
      const isTextOnly = !media.hasMedia;

      return (
        <Pressable
          style={
            isTextOnly
              ? [styles.gridItem, styles.gridItemTextCard, { backgroundColor: theme.card }]
              : [styles.gridItem, { backgroundColor: theme.card }]
          }
          onPress={() => openPostGridViewer(sourceItems, index, unwrapSource)}
        >
          {media.hasMedia ? (
            <>
              <View style={styles.gridImageContainer}>
                {media.isVideo && !media.displayImageUrl ? (
                  <View
                    style={[
                      styles.gridImage,
                      {
                        backgroundColor: '#000',
                        justifyContent: 'center',
                        alignItems: 'center',
                      },
                    ]}
                  >
                    <Ionicons name="play-circle" size={32} color="#fff" />
                  </View>
                ) : (
                  <Image
                    source={{
                      uri:
                        optimizeImageUrl(media.previewUrl || media.displayImageUrl!, 500) ||
                        media.displayImageUrl!,
                    }}
                    style={styles.gridImage}
                    contentFit="cover"
                    cachePolicy="memory-disk"
                    recyclingKey={postItem?.id ?? item?.id ?? String(index)}
                    transition={120}
                  />
                )}
                <View style={styles.gridImageOverlay} />
              </View>
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
                <Ionicons
                  name={media.isVideo ? 'play-circle-outline' : 'camera-outline'}
                  size={14}
                  color="#fff"
                />
              </View>
            </>
          ) : (
            <View style={styles.textCardInner}>
              {author?.username ? (
                <Text numberOfLines={1} style={[styles.textCardAuthor, { color: theme.mutedText }]}>
                  @{author.username}
                </Text>
              ) : null}
              <Text numberOfLines={5} style={[styles.textCardCaption, { color: theme.text }]}>
                {caption || 'Post'}
              </Text>
              <View style={styles.textCardFooter}>
                <View style={styles.textCardStat}>
                  <Ionicons name="arrow-up" size={13} color={theme.mutedText} />
                  <Text style={[styles.textCardStatText, { color: theme.mutedText }]}>{likes}</Text>
                </View>
                <View style={styles.textCardStat}>
                  <Ionicons name="chatbubble-ellipses" size={13} color={theme.mutedText} />
                  <Text style={[styles.textCardStatText, { color: theme.mutedText }]}>
                    {comments}
                  </Text>
                </View>
              </View>
            </View>
          )}
        </Pressable>
      );
    },
    [openPostGridViewer, theme.card, theme.mutedText, theme.text]
  );

  const renderPostGridList = ({
    data,
    keyPrefix,
    keyExtractor,
    emptyComponent,
    onEndReached,
    loading,
    unwrapItems = false,
  }: {
    data: any[];
    keyPrefix: string;
    keyExtractor: (item: any, index: number) => string;
    emptyComponent: React.ComponentType<any> | React.ReactElement | null;
    onEndReached: () => void;
    loading: boolean;
    unwrapItems?: boolean;
  }) => (
    <FlatList
      data={data}
      key={`${keyPrefix}-grid-2cols`}
      numColumns={2}
      columnWrapperStyle={styles.gridRow}
      keyExtractor={keyExtractor}
      ListHeaderComponent={renderHeader}
      ListEmptyComponent={emptyComponent}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.tint} />
      }
      contentContainerStyle={{ paddingBottom: Math.max(32, insets.bottom + 16) }}
      onEndReachedThreshold={0.5}
      onEndReached={onEndReached}
      renderItem={({ item, index }) =>
        renderPostGridTile({ item, index, sourceItems: data, unwrapSource: unwrapItems })
      }
      ListFooterComponent={loading ? <ActivityIndicator style={{ marginVertical: 16 }} /> : null}
    />
  );

  const SkeletonList = useCallback(
    ({ count = 8 }: { count?: number }) => (
      <View style={{ paddingHorizontal: 16, paddingTop: 12 }}>
        {SKELETON_8.slice(0, count).map((_, i) => (
          <View
            key={i}
            style={{
              height: 100,
              backgroundColor: theme.surface || '#F3F4F6',
              borderRadius: 12,
              marginBottom: 12,
            }}
          />
        ))}
      </View>
    ),
    [theme.surface]
  );

  // Guest mode: not logged in and viewing own profile tab — show sign-in prompt
  if (!userFromAuth && !viewingUserId) {
    return (
      <SafeAreaView
        style={[styles.container, { backgroundColor: theme.background }]}
        edges={['top']}
      >
        <Stack.Screen options={{ title: 'Profile' }} />
        <View
          style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 16 }}
        >
          <View
            style={{
              width: 80,
              height: 80,
              borderRadius: 40,
              backgroundColor: theme.surface,
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 8,
            }}
          >
            <Ionicons name="person-outline" size={40} color={theme.mutedText} />
          </View>
          <Text style={{ fontSize: 22, fontWeight: '800', color: theme.text, textAlign: 'center' }}>
            Your Profile
          </Text>
          <Text
            style={{ fontSize: 15, color: theme.mutedText, textAlign: 'center', lineHeight: 22 }}
          >
            Sign in to create your profile, post highlights, and connect with your community.
          </Text>
          <Pressable
            onPress={() => router.push('/sign-in')}
            style={{
              width: '100%',
              marginTop: 8,
              backgroundColor: theme.tint,
              paddingVertical: 14,
              borderRadius: 12,
              alignItems: 'center',
              justifyContent: 'center',
            }}
            accessibilityRole="button"
            accessibilityLabel="Sign In"
          >
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 16 }}>Sign In</Text>
          </Pressable>
          <Pressable
            onPress={() => router.push('/sign-up')}
            style={{ paddingVertical: 12, width: '100%', alignItems: 'center' }}
            accessibilityRole="button"
          >
            <Text style={{ color: theme.tint, fontWeight: '600', fontSize: 15 }}>
              Create Account
            </Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  // Only show loading skeleton on initial load when we have no data
  if (loading && !me && !hasLoadedOnce.current) {
    return (
      <SafeAreaView
        style={[styles.container, { backgroundColor: theme.background }]}
        edges={['top']}
      >
        <Stack.Screen options={{ title: 'Profile' }} />
        <SkeletonList count={8} />
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView
        style={[styles.container, { backgroundColor: theme.background }]}
        edges={['top']}
      >
        <Stack.Screen options={{ title: 'Profile' }} />
        <View style={[styles.center, { flex: 1, justifyContent: 'center', padding: 24 }]}>
          <Ionicons
            name="alert-circle-outline"
            size={48}
            color={theme.mutedText}
            style={{ marginBottom: 16 }}
          />
          <Text style={[styles.error, { color: theme.text, textAlign: 'center', marginBottom: 8 }]}>
            {error}
          </Text>
          <View style={{ height: 16 }} />
          {error.includes('sign in') ? (
            <Button onPress={() => void router.push('/sign-in')}>
              <Text style={{ color: '#fff' }}>Sign In</Text>
            </Button>
          ) : (
            <Button onPress={() => void loadProfile()}>
              <Text style={{ color: '#fff' }}>Retry</Text>
            </Button>
          )}
        </View>
      </SafeAreaView>
    );
  }

  if (!me) {
    // Show error state instead of blank screen
    return (
      <SafeAreaView
        style={[styles.container, { backgroundColor: theme.background }]}
        edges={['top']}
      >
        <Stack.Screen options={{ title: 'Profile' }} />
        <View style={[styles.center, { flex: 1, justifyContent: 'center', padding: 24 }]}>
          <Ionicons
            name="person-outline"
            size={48}
            color={theme.mutedText}
            style={{ marginBottom: 16 }}
          />
          <Text style={[styles.error, { color: theme.text, textAlign: 'center', marginBottom: 8 }]}>
            Unable to load profile
          </Text>
          <View style={{ height: 16 }} />
          <Button onPress={() => void loadProfile()}>
            <Text style={{ color: '#fff' }}>Retry</Text>
          </Button>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top']}>
      <Stack.Screen options={{ title: 'Profile' }} />
      {viewingUserId ? (
        <Pressable
          testID="profile-back-button"
          onPress={() => safeGoBack(router, viewedProfileFallback)}
          hitSlop={12}
          style={[
            styles.controlButton,
            styles.persistentBackButton,
            {
              backgroundColor:
                colorScheme === 'dark' ? 'rgba(0, 0, 0, 0.78)' : 'rgba(255, 255, 255, 0.94)',
            },
          ]}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={18} color={theme.text} />
        </Pressable>
      ) : null}
      {resolvedActiveTab === 'posts'
        ? renderPostGridList({
            data: posts,
            keyPrefix: resolvedActiveTab,
            keyExtractor: item => item.id,
            emptyComponent: renderEmptyPosts,
            onEndReached: onEndReachedPosts,
            loading: postsLoading,
          })
        : resolvedActiveTab === 'replies'
          ? renderPostGridList({
              data: replies,
              keyPrefix: resolvedActiveTab,
              keyExtractor: (item, index) => {
                const postItem = unwrapPostGridItem(item);
                return postItem?.id ?? item?.id ?? `reply-${index}`;
              },
              emptyComponent: renderEmptyReplies,
              onEndReached: onEndReachedReplies,
              loading: repliesLoading,
              unwrapItems: true,
            })
          : resolvedActiveTab === 'events'
            ? renderEventPagesList()
            : renderPostGridList({
                data: upvotes,
                keyPrefix: resolvedActiveTab,
                keyExtractor: (item, index) => {
                  const postItem = unwrapPostGridItem(item);
                  return postItem?.id ?? item?.id ?? `upvote-${index}`;
                },
                emptyComponent: renderEmptyUpvotes,
                onEndReached: onEndReachedUpvotes,
                loading: upvotesLoading,
                unwrapItems: true,
              })}

      {/* Avatar Viewer — full-screen enlarged profile picture */}
      <Modal
        visible={avatarViewerVisible}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setAvatarViewerVisible(false)}
      >
        <Pressable
          style={{
            flex: 1,
            backgroundColor: 'rgba(0,0,0,0.95)',
            alignItems: 'center',
            justifyContent: 'center',
          }}
          onPress={() => setAvatarViewerVisible(false)}
        >
          {me?.avatar_url && (
            <Image
              source={{ uri: String(me.avatar_url) }}
              style={{
                width: SCREEN_WIDTH - 32,
                height: SCREEN_WIDTH - 32,
                borderRadius: (SCREEN_WIDTH - 32) / 2,
              }}
              contentFit="cover"
            />
          )}
          <Pressable
            onPress={() => setAvatarViewerVisible(false)}
            style={{
              position: 'absolute',
              top: insets.top + 12,
              right: 16,
              padding: 8,
              backgroundColor: 'rgba(255,255,255,0.15)',
              borderRadius: 20,
            }}
          >
            <Ionicons name="close" size={24} color="white" />
          </Pressable>
        </Pressable>
      </Modal>

      {viewerOpen ? (
        <Modal
          visible
          animationType="slide"
          presentationStyle="fullScreen"
          onRequestClose={() => setViewerOpen(false)}
        >
          <View style={[styles.verticalFeedModal, { backgroundColor: theme.background }]}>
            <GameVerticalFeedScreen
              onClose={() => setViewerOpen(false)}
              showHeader
              initialPosts={viewerItems}
              startIndex={viewerIndex}
              title={`${isViewingOtherProfile ? displayUsername : 'Your'} ${
                activeTab === 'posts' ? 'posts' : activeTab === 'replies' ? 'replies' : 'upvotes'
              }`}
            />
          </View>
        </Modal>
      ) : null}
    </SafeAreaView>
  );
}
