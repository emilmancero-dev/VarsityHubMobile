import { toUserMessage } from '@/utils/toUserMessage';
import { Game, Post, Program, Team } from '@/api/entities';
import { useAuth } from '@/context/AuthProvider';
import { Colors } from '@/constants/Colors';
import { styles } from '@/styles/team-page.styles';
import { useCustomColorScheme } from '@/hooks/useCustomColorScheme';
import { gameRowTitle } from '@/utils/eventTitle';
import { optimizeImageUrl } from '@/utils/imageUrl';
import { sanitizeTitle } from '@/lib/sanitizeTitle';
import { resolveMediaType, resolvePostMedia } from '@/utils/media';
import { buildEventDetailRoute } from '@/utils/eventRoutes';
import { safeGoBack } from '@/utils/navigation';
import { buildPostGridViewerState, unwrapPostGridItem } from '@/utils/postGridViewer';
import { useProgramScreenSummary } from '@/hooks/useProgramScreenSummary';
import { buildProgramSubTeams } from '@/constants/programs';
import { getGradientForColor } from '@/utils/theme';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import {
  ComponentType,
  ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import GameVerticalFeedScreen, { FeedPost } from './game-details/GameVerticalFeedScreen';

type LeagueTeam = {
  id: string;
  name: string;
  sport?: string;
  season?: string;
  logo_url?: string;
  description?: string;
  organization_id?: string;
  venue_address?: string | null;
  organization?: {
    id?: string;
    name?: string | null;
  } | null;
  program_id?: string | null;
  created_at?: string;
  _count?: {
    members?: number;
    games?: number;
    posts?: number;
    followers?: number;
    following?: number;
  };
};

type GameItem = {
  id: string;
  date?: string | Date;
  created_at?: string | Date;
  home_team?: string;
  homeTeam?: string;
  away_team?: string;
  awayTeam?: string;
};

type PostItem = {
  id: string;
  media_url?: string;
  caption?: string;
  content?: string;
  upvotes_count?: number;
  comments_count?: number;
  created_at?: string;
  created_date?: string;
  _count?: {
    comments?: number;
  };
};

type TeamMember = {
  id: string;
  user_id?: string;
  team_id?: string;
  role?: string;
  status?: string;
  jersey_number?: string | number;
  position?: string;
  user?: {
    id: string;
    display_name?: string;
    full_name?: string;
    username?: string;
    avatar_url?: string;
    is_parent?: boolean;
  };
};

const HEADER_IMAGE_DRAG_LIMIT = 120;
const _clampValue = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

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
    game_id: item?.game_id ?? item?.game?.id ?? null,
    event_id: item?.event_id ?? item?.event?.id ?? null,
    caption: item?.caption ?? item?.content ?? sanitizeTitle(item?.title) ?? null,
    upvotes_count: item?.upvotes_count ?? 0,
    comments_count: item?.comments_count ?? item?._count?.comments ?? 0,
    bookmarks_count: item?.bookmarks_count ?? 0,
    created_at: item?.created_at ?? null,
    author: item?.author
      ? {
          id: String(item.author.id ?? item.author.user_id ?? id),
          username: item.author.username ?? null,
          display_name: (item.author as any).display_name ?? null,
          avatar_url: item.author.avatar_url ?? item.author.avatarUrl ?? null,
        }
      : null,
    has_upvoted: Boolean(item?.has_upvoted),
    has_bookmarked: Boolean(item?.has_bookmarked),
    is_following_author: Boolean(item?.is_following_author),
  };
};

type TeamPageData = {
  team: LeagueTeam;
  members: TeamMember[];
  games: GameItem[];
  canManageTeam: boolean;
};

// Pure server fetch for the team page, driven by react-query so revisiting the
// screen serves the cached result instantly and revalidates in the background
// (instead of blocking on a fresh spinner every navigation). Throws on failure
// so react-query surfaces it as `isError`.
async function fetchTeamData(teamId?: string, teamName?: string): Promise<TeamPageData> {
  let teamData: LeagueTeam | null = null;
  let summaryMembers: TeamMember[] = [];
  let summaryGames: GameItem[] = [];
  let canManageTeam = false;

  try {
    // Prefer the scoped summary endpoint so team page navigation and access
    // stay aligned with the canonical team tools contracts.
    if (teamId) {
      try {
        const summary: any = await Team.screenSummary(teamId);
        if (summary?.team) {
          teamData = summary.team as LeagueTeam;
          summaryMembers = Array.isArray(summary.members) ? (summary.members as TeamMember[]) : [];
          // Prefer the merged schedule (games+events); fall back to games for an
          // older server response. The Events tab renders items by `kind`.
          summaryGames = Array.isArray(summary.schedule)
            ? (summary.schedule as GameItem[])
            : Array.isArray(summary.games)
              ? (summary.games as GameItem[])
              : [];
          canManageTeam =
            summary?.permissions?.can_manage === true || summary?.team?.can_manage_team === true;
        } else {
          const fullTeamData = await Team.get(teamId);
          if (fullTeamData) {
            teamData = fullTeamData as LeagueTeam;
            canManageTeam = (fullTeamData as any)?.can_manage_team === true;
          }
        }
      } catch (getErr: any) {
        if (__DEV__) console.warn('[team-page] Failed to get team by ID, trying list:', getErr);
      }
    }

    // Fallback to list if get() didn't work or we only have teamName
    if (!teamData) {
      const allTeams = await Team.list(undefined, undefined, { limit: 100 });
      const teamsList = Array.isArray(allTeams) ? allTeams : [];
      if (teamId) {
        teamData = teamsList.find((t: LeagueTeam) => t.id === teamId) || null;
      }
      if (!teamData && teamName) {
        teamData =
          teamsList.find((t: LeagueTeam) => t.name?.toLowerCase() === teamName.toLowerCase()) ||
          null;
      }
    }
  } catch (apiErr: any) {
    if (__DEV__) console.error('[team-page] Failed to fetch teams from API:', apiErr);
    // Continue to try fallback logic
  }

  if (!teamData && teamName) {
    teamData = { id: teamId || `temp-${teamName}`, name: teamName, logo_url: undefined };
  }
  if (!teamData) {
    throw new Error(`Could not load team (ID: ${teamId}, Name: ${teamName})`);
  }

  // Extract organization_id (could be direct or nested in organization object)
  const orgId = (teamData as any)?.organization_id || (teamData as any)?.organization?.id;
  if (orgId) {
    teamData = { ...teamData, organization_id: String(orgId) } as LeagueTeam;
  }

  let games: GameItem[];
  let members: TeamMember[];
  if (summaryGames.length || summaryMembers.length) {
    games = summaryGames;
    members = summaryMembers;
  } else {
    // Scope server-side by team ID (matches home_team_id OR away_team_id).
    // Replaces fragile client-side name-substring matching, which both
    // mismatched similarly-named teams and pulled the entire games table.
    games = await Game.list('-date', { teamId: teamData.id, limit: 100 })
      .then(allGamesData => {
        const allGames = Array.isArray(allGamesData)
          ? allGamesData
          : allGamesData?.games || allGamesData?.items || [];
        return allGames as GameItem[];
      })
      .catch((err: any) => {
        if (__DEV__) console.error('[team-page] Failed to load games:', err);
        return [] as GameItem[];
      });
    members = [];
  }

  return { team: teamData, members, games, canManageTeam };
}

function TeamScreen() {
  const { user: currentUser } = useAuth();
  const colorScheme = useCustomColorScheme();
  const theme = Colors[colorScheme];
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    id?: string;
    name?: string;
    from?: string;
    gameId?: string;
  }>();
  const { from, gameId } = params;

  const [team, setTeam] = useState<LeagueTeam | null>(null);
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [games, setGames] = useState<GameItem[]>([]);
  const [activeTab, setActiveTab] = useState<'posts' | 'replies' | 'upvotes' | 'events'>('events');
  const [isFollowing, setIsFollowing] = useState(false);
  const [followLoading, setFollowLoading] = useState(false);
  const [isTeamAdmin, setIsTeamAdmin] = useState(false);

  // Posts state - matching profile.tsx
  const [posts, setPosts] = useState<PostItem[]>([]);
  const [_postsCursor, _setPostsCursor] = useState<string | null>(null);
  const [postsHasMore, setPostsHasMore] = useState(true);
  const [postsLoading, setPostsLoading] = useState(false);
  const postsRequestInFlight = useRef(false);

  const [replies, setReplies] = useState<PostItem[]>([]);
  const [_repliesCursor, _setRepliesCursor] = useState<string | null>(null);
  const [repliesHasMore, setRepliesHasMore] = useState(true);
  const [repliesLoading, setRepliesLoading] = useState(false);
  const repliesRequestInFlight = useRef(false);

  const [upvotes, setUpvotes] = useState<PostItem[]>([]);
  const [_upvotesCursor, _setUpvotesCursor] = useState<string | null>(null);
  const [upvotesHasMore, setUpvotesHasMore] = useState(true);
  const [upvotesLoading, setUpvotesLoading] = useState(false);
  const upvotesRequestInFlight = useRef(false);

  const [_sort, _setSort] = useState<'newest' | 'most_upvoted' | 'most_commented'>('newest');
  const [teamThemeColor, setTeamThemeColor] = useState<string>('#3B82F6');

  // Vertical viewer state
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerIndex, setViewerIndex] = useState(0);
  const [viewerItems, setViewerItems] = useState<FeedPost[]>([]);

  const handleBack = useCallback(() => {
    if (from === 'game-details' && gameId) {
      safeGoBack(router, { pathname: '/game/[id]', params: { id: gameId } } as any);
    } else {
      safeGoBack(router);
    }
  }, [from, gameId, router]);

  // Mounted guard to prevent state updates after unmount
  const mounted = useRef(true);
  useEffect(() => {
    return () => {
      mounted.current = false;
    };
  }, []);

  const refreshPosts = useCallback(async (teamId: string, programId?: string | null) => {
    if (postsRequestInFlight.current || !mounted.current) return;
    postsRequestInFlight.current = true;
    if (mounted.current) setPostsLoading(true);
    try {
      // Single server-side query: posts attached to the team directly or to
      // any of its games (matched by team ID, not name substring). When this
      // team belongs to a multi-sub-team program, the Posts tab is SHARED across
      // the whole sport (owner July-28) — filter by program_id (the union of
      // every sub-team) instead of the single opened sub-team.
      const teamPosts = programId
        ? await Post.filter({ program_id: programId }, '-created_at', 20)
        : await Post.filter({ team_id: teamId }, '-created_at', 20);
      if (!mounted.current) return;
      setPosts(Array.isArray(teamPosts) ? teamPosts : []);
      setPostsHasMore(false); // Simplified pagination
    } catch (err) {
      if (__DEV__) console.warn('[team-page] Failed to load team posts:', err);
    } finally {
      postsRequestInFlight.current = false;
      if (mounted.current) setPostsLoading(false);
    }
  }, []);

  const refreshReplies = useCallback(async (_teamId: string) => {
    if (repliesRequestInFlight.current || !mounted.current) return;
    repliesRequestInFlight.current = true;
    if (mounted.current) setRepliesLoading(true);
    try {
      // For teams, replies would be comments on team posts
      // Simplified for now - empty
      if (mounted.current) {
        setReplies([]);
        setRepliesHasMore(false);
      }
    } finally {
      repliesRequestInFlight.current = false;
      if (mounted.current) setRepliesLoading(false);
    }
  }, []);

  const refreshUpvotes = useCallback(async (_teamId: string) => {
    if (upvotesRequestInFlight.current || !mounted.current) return;
    upvotesRequestInFlight.current = true;
    if (mounted.current) setUpvotesLoading(true);
    try {
      // For teams, upvotes would be upvoted posts
      // Simplified for now - empty
      if (mounted.current) {
        setUpvotes([]);
        setUpvotesHasMore(false);
      }
    } finally {
      upvotesRequestInFlight.current = false;
      if (mounted.current) setUpvotesLoading(false);
    }
  }, []);

  // Validate/sanitize route params before they drive the query key.
  const rawTeamId = params.id?.trim();
  const paramTeamName = params.name?.trim();
  // ID format: alphanumeric, dash, underscore only.
  const teamIdValid = !rawTeamId || /^[a-zA-Z0-9_-]+$/.test(rawTeamId);
  const teamId = teamIdValid ? rawTeamId : undefined;
  const hasIdentifier = !!(teamId || paramTeamName);

  // react-query owns the server fetch: revisiting the screen serves the cached
  // result instantly (no spinner) and revalidates in the background. The spinner
  // is gated on `isPending` (no cached data yet), never on background refetches.
  const teamQuery = useQuery({
    queryKey: ['team-page', teamId ?? paramTeamName ?? ''],
    queryFn: () => fetchTeamData(teamId, paramTeamName),
    enabled: hasIdentifier && teamIdValid,
  });

  // Mirror server data into local state so the existing render and the
  // optimistic follow handler (which mutates `team`/`isFollowing`) keep working.
  useEffect(() => {
    const data = teamQuery.data;
    if (!data) return;
    setTeam(data.team);
    setMembers(data.members);
    setGames(data.games);
    setIsTeamAdmin(data.canManageTeam);
    setIsFollowing(!!(data.team as any).is_following);
    setTeamThemeColor('#3B82F6');
  }, [teamQuery.data]);

  // team-page is the ONE canonical page for a sport (owner July-28). When this
  // team belongs to a program, the Events tab shows the whole sport's sub-team
  // picker — no redirect to a separate program page.
  const programQuery = useProgramScreenSummary(team?.program_id);
  const subTeams = useMemo(
    () => buildProgramSubTeams((programQuery.data?.levels ?? []) as any),
    [programQuery.data]
  );
  // A team is a "sport" surface when its program has >1 sub-team. A lone-team
  // program stays a plain team page (nothing to pick).
  const isProgramTeam = subTeams.length > 1;
  const [selectedSubTeamId, setSelectedSubTeamId] = useState<string | null>(null);
  const activeSubTeam =
    subTeams.find(s => s.teamId === selectedSubTeamId) ??
    subTeams.find(s => s.teamId === params.id) ??
    subTeams[0] ??
    null;
  // Events shown: the picked sub-team's games in program mode, else this team's.
  const eventsGames = isProgramTeam && activeSubTeam ? activeSubTeam.schedule : games;

  // Whole-sport Follow (owner July-28): on a program team, the Follow button
  // follows the SPORT — Program.follow writes the ProgramFollow ledger and fans
  // out a TeamFollow to every sub-team, so following the sport follows all its
  // sub-teams. State + count come from the program screen-summary (ProgramFollow-
  // based), not the single opened sub-team. A lone team keeps the team-follow path.
  const programId = team?.program_id ?? null;
  const [programIsFollowing, setProgramIsFollowing] = useState(false);
  useEffect(() => {
    if (isProgramTeam && programQuery.data?.program) {
      setProgramIsFollowing(!!(programQuery.data.program as any).is_following);
    }
  }, [isProgramTeam, programQuery.data]);
  const effectiveFollowing = isProgramTeam ? programIsFollowing : isFollowing;
  const effectiveFollowersCount = isProgramTeam
    ? ((programQuery.data?.program as any)?.followers_count ?? 0)
    : ((team as any)?.followers_count ?? 0);

  // Pick up server-side edits (e.g. renamed team) when the screen regains focus.
  // The callback must NOT depend on `teamQuery`: the query result object gets a
  // new identity on every state transition, so keying the focus effect on it
  // re-runs the effect (and refetch) after each transition — an infinite
  // refetch storm when the fetch fails (bogus team id → error → refetch →
  // pending → error → …). Route refetch through a ref so the effect only runs
  // on real focus changes.
  const hasLoadedOnce = useRef(false);
  const refetchTeam = useRef(teamQuery.refetch);
  refetchTeam.current = teamQuery.refetch;
  useFocusEffect(
    useCallback(() => {
      if (!hasLoadedOnce.current) {
        hasLoadedOnce.current = true;
        return;
      }
      if (hasIdentifier && teamIdValid) void refetchTeam.current();
    }, [hasIdentifier, teamIdValid])
  );

  const error = !teamIdValid
    ? 'Invalid team ID format'
    : !hasIdentifier
      ? 'No team ID or name provided'
      : teamQuery.isError
        ? toUserMessage(teamQuery.error, 'Failed to load team data')
        : null;
  // Spinner only while there's no data to show; the brief `data && !team` window
  // covers the one frame before the sync effect mirrors the cache into state.
  const loading =
    hasIdentifier && teamIdValid && (teamQuery.isPending || (!!teamQuery.data && !team));

  // Refresh when switching tabs
  useEffect(() => {
    if (!team?.id) return;
    if (activeTab === 'posts') {
      // Program team → whole-sport posts (shared across sub-teams); otherwise the
      // single team's posts.
      void refreshPosts(String(team.id), isProgramTeam ? team.program_id : undefined);
    } else if (activeTab === 'replies') {
      void refreshReplies(String(team.id));
    } else if (activeTab === 'upvotes') {
      void refreshUpvotes(String(team.id));
    }
  }, [
    activeTab,
    team?.id,
    team?.program_id,
    isProgramTeam,
    refreshPosts,
    refreshReplies,
    refreshUpvotes,
  ]);

  const loadMorePosts = useCallback(async () => {
    if (postsLoading || !postsHasMore || !team?.id || !mounted.current) return;
    if (mounted.current) setPostsLoading(true);
    try {
      // Simplified - in production you'd implement cursor-based pagination
      if (mounted.current) setPostsHasMore(false);
    } finally {
      if (mounted.current) setPostsLoading(false);
    }
  }, [postsHasMore, postsLoading, team?.id]);

  const loadMoreReplies = useCallback(async () => {
    if (repliesLoading || !repliesHasMore || !team?.id) return;
    setRepliesLoading(true);
    try {
      setRepliesHasMore(false);
    } finally {
      setRepliesLoading(false);
    }
  }, [repliesHasMore, repliesLoading, team?.id]);

  const loadMoreUpvotes = useCallback(async () => {
    if (upvotesLoading || !upvotesHasMore || !team?.id || !mounted.current) return;
    if (mounted.current) setUpvotesLoading(true);
    try {
      if (mounted.current) setUpvotesHasMore(false);
    } finally {
      if (mounted.current) setUpvotesLoading(false);
    }
  }, [upvotesHasMore, upvotesLoading, team?.id]);

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
      unwrapSource = false,
    }: {
      item: any;
      index: number;
      sourceItems: any[];
      unwrapSource?: boolean;
    }) => {
      const postItem = unwrapSource ? unwrapPostGridItem(item) : item;
      const media = resolvePostMedia(postItem);
      const likes = postItem?.upvotes_count ?? 0;
      const comments = postItem?.comments_count ?? postItem?._count?.comments ?? 0;

      return (
        <Pressable
          style={[styles.gridItem, { backgroundColor: theme.card }]}
          onPress={() => openPostGridViewer(sourceItems, index, unwrapSource)}
        >
          {media.hasMedia ? (
            <View style={styles.gridImageContainer}>
              {media.displayImageUrl ? (
                <Image
                  source={{ uri: optimizeImageUrl(media.displayImageUrl, 500) }}
                  style={styles.gridImage}
                  contentFit="cover"
                />
              ) : (
                <View style={[styles.gridImage, styles.gridImageFallback]}>
                  <LinearGradient
                    colors={['#121212', '#1E1E1E']}
                    style={StyleSheet.absoluteFillObject as any}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                  />
                  <Ionicons name="play-circle" size={34} color="#fff" />
                </View>
              )}
              <View style={styles.gridImageOverlay} />
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
                <Text numberOfLines={4} style={styles.gridTextOnly}>
                  {String(postItem?.caption || postItem?.content || '').trim() || 'Post'}
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
            <Ionicons
              name={
                media.hasMedia ? (media.isVideo ? 'play-circle-outline' : 'camera-outline') : 'text'
              }
              size={14}
              color="#fff"
            />
          </View>
        </Pressable>
      );
    },
    [openPostGridViewer, theme.card]
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
    emptyComponent: ComponentType<any> | ReactElement | null;
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
      contentContainerStyle={{ paddingBottom: Math.max(32, insets.bottom + 16) }}
      onEndReachedThreshold={0.5}
      onEndReached={onEndReached}
      renderItem={({ item, index }) =>
        renderPostGridTile({ item, index, sourceItems: data, unwrapSource: unwrapItems })
      }
      ListFooterComponent={
        loading ? <ActivityIndicator style={{ marginVertical: 16 }} color={theme.tint} /> : null
      }
    />
  );

  // Get header background (teams don't have preferences field yet, so no custom header image)
  const headerBackgroundImage = null; // Future: team?.header_image_url
  const headerImageFocusY = 0;
  const heroGradientColors: [string, string, ...string[]] = headerBackgroundImage
    ? ['rgba(4,7,20,0.85)', 'rgba(15,23,42,0.45)']
    : (getGradientForColor(teamThemeColor) as [string, string, ...string[]]);

  const teamName = team?.name || 'Team';
  const teamHandle = `@${(team?.name || 'team').toLowerCase().replace(/\s+/g, '')}`;
  const teamVenue = typeof team?.venue_address === 'string' ? team.venue_address.trim() : '';
  const teamOrganizationName =
    typeof team?.organization?.name === 'string' && team.organization.name.trim().length > 0
      ? team.organization.name.trim()
      : team?.organization_id
        ? 'League'
        : '';

  const renderHeader = () => (
    <>
      {/* Banner Header - Exact Match to Profile Design */}
      <View style={[styles.headerContainer, { backgroundColor: theme.background }]}>
        {/* Background Image / Gradient */}
        <View style={styles.headerBackgroundPressable}>
          {headerBackgroundImage ? (
            <Image
              source={{ uri: headerBackgroundImage }}
              style={[
                styles.headerBackgroundImage,
                { transform: [{ translateY: headerImageFocusY * HEADER_IMAGE_DRAG_LIMIT }] },
              ]}
              contentFit="cover"
            />
          ) : (
            <View style={styles.headerBackgroundImage} />
          )}
        </View>
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

        {/* Back Button - Top Left */}
        <View style={[styles.headerControls, { top: Math.max(12, insets.top), left: 16 }]}>
          <Pressable
            testID="team-page-back-button"
            onPress={handleBack}
            style={[
              styles.controlButton,
              {
                backgroundColor:
                  colorScheme === 'dark' ? 'rgba(0, 0, 0, 0.7)' : 'rgba(255, 255, 255, 0.9)',
              },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Ionicons name="arrow-back" size={18} color={theme.text} />
          </Pressable>
        </View>

        {/* Settings Button - Top Right */}
        {isTeamAdmin && (
          <View style={[styles.headerControls, { top: Math.max(12, insets.top) }]}>
            <Pressable
              testID="team-page-settings-button"
              onPress={() => {
                if (!team?.id) return;
                void router.push({
                  pathname: '/team-admin',
                  params: {
                    teamId: team.id,
                    orgId: team.organization_id,
                    orgTab: 'teams',
                  },
                } as any);
              }}
              style={[
                styles.controlButton,
                {
                  backgroundColor:
                    colorScheme === 'dark' ? 'rgba(0, 0, 0, 0.7)' : 'rgba(255, 255, 255, 0.9)',
                },
              ]}
              accessibilityRole="button"
              accessibilityLabel="Open team tools"
            >
              <Ionicons name="settings-outline" size={18} color={theme.text} />
            </Pressable>
          </View>
        )}

        {/* Profile Content - Avatar centered at banner bottom edge */}
        <View style={styles.profileContent}>
          <View style={styles.avatarSection}>
            <View style={styles.avatarContainer}>
              {team?.logo_url ? (
                <Image
                  source={{ uri: optimizeImageUrl(String(team.logo_url), 160) }}
                  style={styles.avatarImage}
                  contentFit="cover"
                />
              ) : (
                <View
                  style={[
                    styles.avatarPlaceholder,
                    { backgroundColor: theme.surface || theme.card },
                  ]}
                >
                  <Ionicons name="people" size={48} color={theme.mutedText} />
                </View>
              )}
            </View>
          </View>
        </View>
      </View>

      {/* Content Below Banner */}
      <View style={styles.profileDetailsContainer}>
        {/* Team Name + Badge - to the right of avatar overlap */}
        <View style={styles.teamHeaderRow}>
          <View style={styles.teamHeaderSpacer} />
          <View style={styles.teamHeaderInfo}>
            <View style={styles.nameRow}>
              <Text style={[styles.userName, { color: theme.text }]}>{teamName}</Text>
              <View style={[styles.roleBadge, styles.teamBadge]}>
                <Text style={styles.roleText}>TEAM</Text>
              </View>
            </View>
          </View>
        </View>

        {/* Handle and Action Buttons Row */}
        <View style={styles.usernameRow}>
          <Text style={[styles.userHandle, { color: theme.text }]}>{teamHandle}</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {isTeamAdmin && (
              <Pressable
                testID="team-page-edit-button"
                style={[
                  styles.editButtonBelowBanner,
                  { backgroundColor: theme.surface || theme.background, borderColor: theme.border },
                ]}
                onPress={() => void router.push(`/edit-team?id=${team?.id}` as any)}
                accessibilityRole="button"
                accessibilityLabel="Edit team profile"
              >
                <Text style={[styles.editButtonBelowBannerText, { color: theme.text }]}>
                  Edit profile
                </Text>
              </Pressable>
            )}
            {!isTeamAdmin && (
              <Pressable
                testID="team-page-follow-button"
                style={[
                  styles.followButtonBelowBanner,
                  {
                    backgroundColor: effectiveFollowing ? '#10B981' : '#FFD600',
                    borderWidth: 0,
                  },
                  followLoading && { opacity: 0.5 },
                ]}
                accessibilityRole="button"
                accessibilityLabel={
                  effectiveFollowing
                    ? isProgramTeam
                      ? 'Unfollow sport'
                      : 'Unfollow team'
                    : isProgramTeam
                      ? 'Follow sport'
                      : 'Follow team'
                }
                disabled={followLoading}
                onPress={async () => {
                  if (!team?.id || team.id.startsWith('temp-') || followLoading) {
                    return;
                  }
                  if (!currentUser) {
                    router.push('/sign-in' as any);
                    return;
                  }
                  // Program team → follow the whole SPORT. Program.follow fans out
                  // a TeamFollow to every sub-team server-side, so this follows all
                  // sub-teams at once; state + count come from the program summary.
                  if (isProgramTeam && programId) {
                    const next = !programIsFollowing;
                    setFollowLoading(true);
                    setProgramIsFollowing(next); // optimistic
                    try {
                      if (next) {
                        await Program.follow(programId);
                      } else {
                        await Program.unfollow(programId);
                      }
                      void programQuery.refetch();
                    } catch (err: any) {
                      setProgramIsFollowing(!next); // rollback
                      if (__DEV__)
                        console.error('[Follow] Program follow/unfollow failed:', err?.message);
                      Alert.alert(
                        'Follow Failed',
                        toUserMessage(err, 'Unable to follow this team. Please try again.')
                      );
                    } finally {
                      setFollowLoading(false);
                    }
                    return;
                  }
                  setFollowLoading(true);
                  try {
                    if (isFollowing) {
                      // eslint-disable-next-line no-console
                      if (__DEV__) console.log('[Follow] calling Team.unfollow(', team.id, ')');
                      await Team.unfollow(team.id);
                      // eslint-disable-next-line no-console
                      if (__DEV__) console.log('[Follow] unfollow success');
                      setIsFollowing(false);
                      setTeam(prev =>
                        prev
                          ? {
                              ...prev,
                              followers_count: Math.max(
                                0,
                                ((prev as any).followers_count ?? 0) - 1
                              ),
                            }
                          : null
                      );
                    } else {
                      // eslint-disable-next-line no-console
                      if (__DEV__) console.log('[Follow] calling Team.follow(', team.id, ')');
                      await Team.follow(team.id);
                      // eslint-disable-next-line no-console
                      if (__DEV__) console.log('[Follow] follow success');
                      setIsFollowing(true);
                      setTeam(prev =>
                        prev
                          ? { ...prev, followers_count: ((prev as any).followers_count ?? 0) + 1 }
                          : null
                      );
                    }
                  } catch (err: any) {
                    if (__DEV__)
                      console.error(
                        '[Follow] Team follow/unfollow failed — status:',
                        err?.status,
                        '| server:',
                        err?.message,
                        '| data:',
                        JSON.stringify(err?.data)
                      );
                    Alert.alert(
                      'Follow Failed',
                      toUserMessage(err, 'Unable to follow this team. Please try again.')
                    );
                  } finally {
                    setFollowLoading(false);
                  }
                }}
              >
                {effectiveFollowing ? (
                  // audit: fixed white on the fixed green button (theme-independent bg)
                  <Ionicons name="checkmark" size={18} color="#FFFFFF" />
                ) : (
                  // audit: fixed dark glyph on the fixed yellow button — theme.text was
                  // near-white in dark mode (~1.2:1 on #FFD600, near-invisible)
                  <Ionicons name="person-add" size={16} color="#1A1A1A" />
                )}
              </Pressable>
            )}
          </View>
        </View>

        {/* Team Details - Left aligned with avatar */}
        <View style={styles.userDetails}>
          {team?.description && (
            <Text style={[styles.userBio, { color: theme.text }]}>{team.description}</Text>
          )}

          {/* Created Date */}
          {team?.created_at && (
            <View style={styles.metaItem}>
              <Ionicons name="calendar-outline" size={14} color={theme.mutedText} />
              <Text style={[styles.metaText, { color: theme.mutedText }]}>
                Created{' '}
                {new Date(team.created_at).toLocaleDateString('en-US', {
                  month: 'long',
                  year: 'numeric',
                })}
              </Text>
            </View>
          )}

          {teamVenue ? (
            <View style={styles.metaItem}>
              <Ionicons name="location-outline" size={14} color={theme.mutedText} />
              <Text style={[styles.metaText, { color: theme.mutedText }]}>{teamVenue}</Text>
            </View>
          ) : null}

          {teamOrganizationName ? (
            <View style={styles.metaItem}>
              <Ionicons name="business-outline" size={14} color={theme.mutedText} />
              <Text style={[styles.metaText, { color: theme.mutedText }]}>
                {teamOrganizationName}
              </Text>
            </View>
          ) : null}

          {/* Stats - Members, Followers, Games */}
          <View style={styles.statsRow}>
            <Text style={[styles.statNumber, { color: theme.text }]}>{members.length}</Text>
            <Text style={[styles.statLabel, { color: theme.mutedText }]}> Members </Text>
            <Text style={[styles.statNumber, { color: theme.text }]}>
              {effectiveFollowersCount}
            </Text>
            <Text style={[styles.statLabel, { color: theme.mutedText }]}> Followers </Text>
            <Text style={[styles.statNumber, { color: theme.text }]}>{games.length}</Text>
            <Text style={[styles.statLabel, { color: theme.mutedText }]}> Games</Text>
          </View>

          {/* Organization Link Button */}
          <Pressable
            style={[styles.orgButton, { borderColor: theme.border, backgroundColor: theme.card }]}
            onPress={() => {
              const orgId = team?.organization_id;
              if (orgId) {
                router.push({
                  pathname: '/organization',
                  params: {
                    id: orgId,
                    tab: 'overview',
                  },
                } as any);
              }
            }}
            disabled={!team?.organization_id}
          >
            <Ionicons
              name="trophy-outline"
              size={16}
              color={team?.organization_id ? theme.text : theme.mutedText}
            />
            <Text
              style={[
                styles.orgButtonText,
                { color: team?.organization_id ? theme.text : theme.mutedText },
              ]}
            >
              {teamOrganizationName || 'No Organization'}
            </Text>
            {team?.organization_id && (
              <Ionicons name="chevron-forward" size={14} color={theme.text} />
            )}
          </Pressable>
        </View>
      </View>

      {/* Tabs */}
      <View style={[styles.tabsContainer, { borderBottomColor: theme.border }]}>
        <Pressable
          testID="team-page-events-tab"
          onPress={() => setActiveTab('events')}
          style={[
            styles.tab,
            activeTab === 'events' && { borderBottomWidth: 2, borderBottomColor: theme.tint },
          ]}
          accessibilityRole="tab"
          accessibilityLabel="Events"
          accessibilityState={{ selected: activeTab === 'events' }}
        >
          <Text
            style={[
              styles.tabText,
              { color: activeTab === 'events' ? theme.tint : theme.mutedText },
            ]}
          >
            Events
          </Text>
        </Pressable>
        <Pressable
          testID="team-page-posts-tab"
          onPress={() => setActiveTab('posts')}
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
          testID="team-page-replies-tab"
          onPress={() => setActiveTab('replies')}
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
          testID="team-page-upvotes-tab"
          onPress={() => setActiveTab('upvotes')}
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
      </View>
    </>
  );

  const renderEmptyPosts = () => (
    <View style={styles.emptyContainer}>
      <Text style={[styles.emptyTitle, { color: theme.text }]}>No posts yet</Text>
      <Text style={[styles.emptySubtitle, { color: theme.mutedText }]}>
        Posts from this team's games will appear here
      </Text>
    </View>
  );

  const renderEmptyReplies = () => (
    <View style={styles.emptyContainer}>
      <Text style={[styles.emptyTitle, { color: theme.text }]}>No replies yet</Text>
    </View>
  );

  const renderEmptyUpvotes = () => (
    <View style={styles.emptyContainer}>
      <Text style={[styles.emptyTitle, { color: theme.text }]}>No upvotes yet</Text>
    </View>
  );

  const renderEmptyEvents = () => (
    <View style={styles.emptyContainer}>
      <Text style={[styles.emptyTitle, { color: theme.text }]}>No events yet</Text>
      <Text style={[styles.emptySubtitle, { color: theme.mutedText }]}>
        This team's games and events will appear here
      </Text>
    </View>
  );

  // Sub-team picker for the Events tab: the whole sport lives on THIS one page —
  // tap a sub-team (Boys Varsity, Girls JV, …) to see just its games/events.
  const renderSubTeamPicker = () => (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.subTeamRow}
    >
      {subTeams.map(st => {
        const selected = st.teamId === activeSubTeam?.teamId;
        return (
          <Pressable
            key={st.teamId}
            testID={`team-subteam-${st.teamId}`}
            onPress={() => setSelectedSubTeamId(st.teamId)}
            accessibilityRole="button"
            accessibilityState={{ selected }}
            accessibilityLabel={`Show ${st.label} events`}
            style={[
              styles.subTeamChip,
              {
                borderColor: selected ? theme.tint : theme.border,
                backgroundColor: selected ? theme.tint : theme.card,
              },
            ]}
          >
            <Text
              style={[
                styles.subTeamChipText,
                // audit: fixed white on the selected theme.tint chip
                { color: selected ? '#FFFFFF' : theme.text },
              ]}
            >
              {st.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );

  const onEndReachedPosts = useCallback(() => {
    if (team?.id) void loadMorePosts();
  }, [team?.id, loadMorePosts]);
  const onEndReachedReplies = useCallback(() => {
    if (team?.id) void loadMoreReplies();
  }, [team?.id, loadMoreReplies]);
  const onEndReachedUpvotes = useCallback(() => {
    if (team?.id) void loadMoreUpvotes();
  }, [team?.id, loadMoreUpvotes]);

  if (loading) {
    return (
      <SafeAreaView
        style={[styles.container, { backgroundColor: theme.background }]}
        edges={['top']}
      >
        <Stack.Screen options={{ title: 'Team' }} />
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.tint} />
        </View>
      </SafeAreaView>
    );
  }

  if (error) {
    return (
      <SafeAreaView
        style={[styles.container, { backgroundColor: theme.background }]}
        edges={['top']}
      >
        <Stack.Screen options={{ title: 'Team' }} />
        <View style={styles.center}>
          <Text style={[styles.error, { color: theme.text }]}>{error}</Text>
          <Pressable onPress={() => void teamQuery.refetch()} style={styles.retryButton}>
            <Text style={styles.retryButtonText}>Retry</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (!team) {
    return (
      <SafeAreaView
        style={[styles.container, { backgroundColor: theme.background }]}
        edges={['top']}
      >
        <Stack.Screen options={{ title: 'Team' }} />
        <View style={styles.center}>
          <Text style={[styles.error, { color: theme.text }]}>Team not found</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top']}>
      <Stack.Screen options={{ title: team?.name || 'Team', headerShown: false }} />
      {activeTab === 'posts' ? (
        renderPostGridList({
          data: posts,
          keyPrefix: activeTab,
          keyExtractor: item => item.id,
          emptyComponent: renderEmptyPosts,
          onEndReached: onEndReachedPosts,
          loading: postsLoading,
        })
      ) : activeTab === 'replies' ? (
        renderPostGridList({
          data: replies,
          keyPrefix: activeTab,
          keyExtractor: (item, index) => {
            const postItem = unwrapPostGridItem(item);
            return postItem?.id ?? item?.id ?? `reply-${index}`;
          },
          emptyComponent: renderEmptyReplies,
          onEndReached: onEndReachedReplies,
          loading: repliesLoading,
          unwrapItems: true,
        })
      ) : activeTab === 'upvotes' ? (
        renderPostGridList({
          data: upvotes,
          keyPrefix: activeTab,
          keyExtractor: (item, index) => {
            const postItem = unwrapPostGridItem(item);
            return postItem?.id ?? item?.id ?? `upvote-${index}`;
          },
          emptyComponent: renderEmptyUpvotes,
          onEndReached: onEndReachedUpvotes,
          loading: upvotesLoading,
          unwrapItems: true,
        })
      ) : (
        <FlatList
          data={[...eventsGames].sort((a, b) => {
            // Always show every event (past + upcoming); dateless games sink to the bottom.
            const da = (a as any).scheduled_date || a.date;
            const db = (b as any).scheduled_date || b.date;
            const ta = da ? new Date(da as string).getTime() : -Infinity;
            const tb = db ? new Date(db as string).getTime() : -Infinity;
            return tb - ta; // most recent first
          })}
          key={`${activeTab}-list`}
          keyExtractor={item => item.id}
          ListHeaderComponent={
            <>
              {renderHeader()}
              {isProgramTeam ? renderSubTeamPicker() : null}
            </>
          }
          ListEmptyComponent={renderEmptyEvents}
          contentContainerStyle={{ paddingBottom: Math.max(32, insets.bottom + 16) }}
          renderItem={({ item }) => {
            const g = item as any;
            // Standalone event (practice, meeting, fundraiser, …): title + type,
            // no opponent/score, routes to the shared event/game detail screen.
            if (g.kind === 'event') {
              const eventRawDate = g.scheduled_date || g.date;
              const eventDateStr = eventRawDate
                ? new Date(eventRawDate).toLocaleDateString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                  })
                : 'TBD';
              const eventLabel = g.event_type
                ? String(g.event_type)
                    .replace(/_/g, ' ')
                    .replace(/\b\w/g, (c: string) => c.toUpperCase())
                : 'Event';
              return (
                <Pressable
                  onPress={() => router.push(buildEventDetailRoute(String(g.id)))}
                  accessibilityRole="button"
                  accessibilityLabel={`Open event ${g.title} on ${eventDateStr}`}
                  style={({ pressed }) => [
                    styles.eventRow,
                    { backgroundColor: theme.card, borderColor: theme.border },
                    pressed ? { opacity: 0.6 } : null,
                  ]}
                >
                  <View style={[styles.eventDateBadge, { backgroundColor: theme.tint + '22' }]}>
                    <Text style={[styles.eventDate, { color: theme.tint }]}>{eventDateStr}</Text>
                  </View>
                  <View style={{ flex: 1, marginLeft: 12 }}>
                    <Text style={[styles.eventTitle, { color: theme.text }]} numberOfLines={1}>
                      {g.title}
                    </Text>
                    <Text style={[styles.eventTypeText, { color: theme.mutedText }]}>
                      {eventLabel}
                    </Text>
                  </View>
                </Pressable>
              );
            }
            const rawDate = g.scheduled_date || g.date;
            const dateStr = rawDate
              ? new Date(rawDate).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })
              : 'TBD';
            // Resolve the opponent from whichever side this team is NOT on.
            // away_team_name is the display-only placeholder for opponents
            // not on VarsityHub (no fake team accounts).
            const viewedId = String(team?.id ?? teamId ?? '');
            const isAwaySide = g.away_team_id != null && String(g.away_team_id) === viewedId;
            const opponent = isAwaySide
              ? g.home_team || g.opponent_name || 'TBD'
              : g.opponent_name || g.away_team || g.awayTeam || g.away_team_name || 'TBD';
            const gameType = g.game_type || 'Game';
            const hasScore = g.home_score != null || g.away_score != null;
            const gameId = g.id ? String(g.id) : null;
            const rowTitle = gameRowTitle({ ...g, opponent });
            return (
              <Pressable
                disabled={!gameId}
                onPress={() =>
                  gameId && router.push({ pathname: '/game/[id]', params: { id: gameId } } as any)
                }
                accessibilityRole="button"
                accessibilityLabel={`Open event ${rowTitle} on ${dateStr}`}
                style={({ pressed }) => [
                  styles.eventRow,
                  { backgroundColor: theme.card, borderColor: theme.border },
                  pressed && gameId ? { opacity: 0.6 } : null,
                ]}
              >
                <View style={[styles.eventDateBadge, { backgroundColor: theme.tint + '22' }]}>
                  <Text style={[styles.eventDate, { color: theme.tint }]}>{dateStr}</Text>
                </View>
                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={[styles.eventTitle, { color: theme.text }]} numberOfLines={1}>
                    {rowTitle}
                  </Text>
                  <Text style={[styles.eventTypeText, { color: theme.mutedText }]}>{gameType}</Text>
                </View>
                {hasScore && (
                  <Text style={[styles.eventScore, { color: theme.text }]}>
                    {g.home_score ?? '-'} - {g.away_score ?? '-'}
                  </Text>
                )}
              </Pressable>
            );
          }}
        />
      )}

      {viewerOpen ? (
        <Modal visible animationType="slide" onRequestClose={() => setViewerOpen(false)}>
          <GameVerticalFeedScreen
            onClose={() => setViewerOpen(false)}
            showHeader
            initialPosts={viewerItems}
            startIndex={viewerIndex}
            title={
              activeTab === 'posts'
                ? 'Team posts'
                : activeTab === 'replies'
                  ? 'Team replies'
                  : activeTab === 'upvotes'
                    ? 'Team upvotes'
                    : 'Team events'
            }
          />
        </Modal>
      ) : null}
    </SafeAreaView>
  );
}

export default TeamScreen;
