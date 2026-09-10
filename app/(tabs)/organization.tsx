import { Game, Organization, Team } from '@/api/entities';
import { Colors } from '@/constants/Colors';
import {
  formatProgramLabel,
  formatTeamFolderLabel,
  genderRank,
  groupTeamsByProgram,
  levelRank,
} from '@/constants/programs';
import { useAuth } from '@/context/AuthProvider';
import { useCustomColorScheme } from '@/hooks/useCustomColorScheme';
import { useOrgProgramsQuery } from '@/hooks/useOrgProgramsQuery';
import { getCanonicalOrganizationId } from '@/utils/authState';
import { countOrgSports } from '@/utils/countOrgSports';
import { gameRowTitle } from '@/utils/eventTitle';
import { optimizeImageUrl } from '@/utils/imageUrl';
import { safeGoBack } from '@/utils/navigation';
import { toUserMessage } from '@/utils/toUserMessage';
import { Ionicons, MaterialIcons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

type OrganizationData = {
  id: string;
  name?: string;
  display_name?: string;
  description?: string;
  bio?: string;
  background_url?: string;
  logo_url?: string;
  avatar_url?: string;
  created_at?: string;
  contact_info?: string;
  location?: string;
  formatted_address?: string;
  followers_count?: number;
  is_following?: boolean;
  viewer_role?: string | null;
  is_member?: boolean;
  is_owner?: boolean;
  can_edit?: boolean;
  can_manage?: boolean;
  can_review_coaches?: boolean;
};

type TeamItem = {
  id: string;
  name: string;
  sport?: string | null;
  season?: string | null;
  logo_url?: string | null;
  organization_id?: string;
  program_id: string | null;
  level: string | null;
  gender: string | null;
};

type GameItem = {
  id: string;
  date?: string | Date;
  scheduled_date?: string;
  home_team?: string;
  away_team?: string;
  opponent_name?: string;
  location?: string;
  game_type?: string;
  event_type?: string | null;
  title?: string | null;
};

type AuthorizedInvite = {
  id: string;
  email?: string | null;
  role?: string | null;
  status?: string | null;
};

function buildOrganizationJoinRequestsRoute(id: string, name?: string | null) {
  return {
    pathname: '/organization-join-requests' as const,
    params: {
      organization_id: id,
      organization_name: name || 'Organization',
    },
  };
}

export default function OrganizationScreen() {
  const { user } = useAuth();
  const colorScheme = useCustomColorScheme();
  const theme = Colors[colorScheme];
  const router = useRouter();
  const params = useLocalSearchParams<{
    id?: string;
    from?: string;
    tab?: string;
    preview?: string;
  }>();
  // "Preview as public": the owner opens their own org page from Edit and we
  // render it exactly as a guest sees it (no management controls). Purely a
  // client view toggle — the server payload is unchanged.
  const previewAsPublic = params.preview === '1' || params.preview === 'true';
  const backFallback = params.from === 'discover-quick-actions' ? '/(tabs)/discover' : undefined;
  const handleBack = useCallback(() => {
    safeGoBack(router, backFallback);
  }, [backFallback, router]);

  const [refreshing, setRefreshing] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const [inviteModalVisible, setInviteModalVisible] = useState(false);
  const [inviteIdentifier, setInviteIdentifier] = useState('');

  const queryClient = useQueryClient();
  const orgPageQueryKey = ['org-page', params.id?.trim() || 'mine', user?.id];
  const {
    data: orgPage,
    isPending: loading,
    isError,
    error: orgPageError,
    refetch,
  } = useQuery({
    queryKey: orgPageQueryKey,
    enabled: !!user,
    queryFn: async () => {
      let orgId = params.id?.trim();

      // Fallback: if no orgId in params, look up the user's org from the server
      if (
        !orgId ||
        orgId === 'undefined' ||
        orgId === 'null' ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(orgId)
      ) {
        try {
          const summaries = await Organization.reviewSummaries();
          const firstOrg = Array.isArray(summaries) ? summaries[0]?.organization : null;
          if (firstOrg?.id) {
            orgId = firstOrg.id;
          } else {
            // Coaches who joined via request have role='member' — mine() won't return their org.
            // Fall back to the org ID stored in their preferences during onboarding.
            orgId = getCanonicalOrganizationId(user as any) || undefined;
          }
        } catch {
          orgId = getCanonicalOrganizationId(user as any) || undefined;
        }
        if (!orgId) throw new Error('not_found');
      }

      let orgData: OrganizationData;
      try {
        orgData = await Organization.get(orgId as string);
      } catch (err: any) {
        if (__DEV__) console.error('[organization] Failed to load organization data:', err);
        const errMsg = err?.message || 'Failed to load organization';
        // Surface the error rather than showing a blank page
        throw new Error(errMsg.toLowerCase().includes('not found') ? 'not_found' : errMsg);
      }

      let allTeams: any[] = [];
      try {
        allTeams = await Team.list(undefined, undefined, {
          organization_id: orgId as string,
          limit: 100,
        });
      } catch (err: any) {
        if (__DEV__) console.error('[organization] Failed to load teams list:', err);
        allTeams = [];
      }

      const orgTeams: TeamItem[] = allTeams
        .map((t: any) => ({
          id: String(t.id),
          name: t.name || 'Team',
          sport: t.sport || null,
          season: t.season || null,
          logo_url: t.logo_url || t.avatar_url || null,
          organization_id: t.organization_id,
          program_id: t.program_id ?? null,
          level: t.level ?? null,
          gender: t.gender ?? null,
        }))
        .sort((a: TeamItem, b: TeamItem) => a.name.localeCompare(b.name));

      let orgGames: GameItem[] = [];
      try {
        // One org-scoped request replaces the old per-team fan-out. Large
        // schools were issuing one /games call for every team just to render
        // the first 10 upcoming rows on the org page.
        const gamesResponse = await Game.list('date', {
          organizationId: orgId as string,
          dateFrom: new Date().toISOString(),
          limit: 100,
          showAll: true,
        });
        const orgGameRows = Array.isArray(gamesResponse)
          ? gamesResponse
          : Array.isArray((gamesResponse as any)?.games)
            ? (gamesResponse as any).games
            : Array.isArray((gamesResponse as any)?.items)
              ? (gamesResponse as any).items
              : [];
        orgGames = orgGameRows
          .map((g: any) => ({
            id: String(g.id),
            date: g.date,
            scheduled_date: g.scheduled_date,
            home_team: g.home_team,
            away_team: g.away_team,
            opponent_name: g.opponent_name,
            location: g.location,
            game_type: g.game_type,
            event_type: g.event_type,
            title: g.title,
          }))
          .sort((a: GameItem, b: GameItem) => {
            const dateA = new Date((a.scheduled_date || a.date) as string).getTime();
            const dateB = new Date((b.scheduled_date || b.date) as string).getTime();
            return dateA - dateB;
          });
      } catch (err: any) {
        if (__DEV__) console.error('[organization] Failed to load games:', err);
        orgGames = [];
      }

      return {
        orgId: String(orgId),
        organization: orgData,
        isFollowing: !!(orgData as any).is_following,
        teams: orgTeams,
        games: orgGames,
      };
    },
  });

  const organization = orgPage?.organization ?? null;
  const teams = useMemo(() => orgPage?.teams ?? [], [orgPage?.teams]);
  const games = orgPage?.games ?? [];
  const isFollowing = orgPage?.isFollowing ?? false;

  // Sport-program grouping: one row per program instead of one per team,
  // matching the manage-teams / my-team picker precedent. Only kicks in once
  // any team carries a program_id — a fully ungrouped org (or a server that
  // predates the program layer) renders exactly today's flat team list. The
  // program-metadata query is gated on that same condition so the OTA-safe
  // path (nothing to group) never fires an extra network call.
  const anyTeamHasProgram = teams.some(t => !!t.program_id);
  const { data: orgPrograms = [] } = useOrgProgramsQuery({
    organizationId: orgPage?.orgId,
    enabled: !!orgPage?.orgId && anyTeamHasProgram,
  });
  const programsById = useMemo(() => new Map(orgPrograms.map(p => [p.id, p])), [orgPrograms]);
  const teamGroups = useMemo(() => groupTeamsByProgram(teams), [teams]);
  // The org's unit is the SPORT, not the roster: several level teams inside one
  // program are one sport. Mirrors server-side billable-program counting.
  const sportsCount = useMemo(() => countOrgSports(teams), [teams]);
  const hasProgramGroups = teamGroups.some(g => g.programId !== null);
  const ungroupedTeams = teamGroups.find(g => g.programId === null)?.teams ?? [];
  const programGroups = teamGroups.filter(g => g.programId !== null);

  const error = isError
    ? (orgPageError as any)?.message === 'not_found'
      ? 'not_found'
      : toUserMessage(orgPageError, 'Failed to load organization data')
    : null;

  // Access flags derive from the org payload (server-computed booleans).
  // In preview-as-public mode they are forced off so the owner sees the exact
  // guest view — the underlying server payload is untouched.
  const isOrgOwner =
    !previewAsPublic &&
    ((organization as any)?.can_edit === true || (organization as any)?.is_owner === true);
  const isOrgAdmin = !previewAsPublic && ((organization as any)?.can_manage === true || isOrgOwner);
  const canReviewCoachRequests =
    !previewAsPublic &&
    ((organization as any)?.can_review_coaches === true ||
      (organization as any)?.is_owner === true);

  // Pending coach/invite counts load in a dependent query so the org page
  // paints without waiting on the admin summary (matches the old
  // fire-and-forget .then()). Non-admins never fetch it.
  const {
    data: adminSummary,
    isError: adminSummaryIsError,
    refetch: refetchAdminSummary,
  } = useQuery({
    queryKey: ['org-admin-summary', orgPage?.orgId ?? null],
    enabled: !!orgPage?.orgId && isOrgAdmin,
    queryFn: () => Organization.adminSummary(orgPage?.orgId as string),
  });
  const pendingCoachError = isOrgAdmin && adminSummaryIsError;
  const pendingCoachCount =
    isOrgAdmin && !adminSummaryIsError
      ? Number((adminSummary as any)?.counts?.pending_coach_requests || 0)
      : 0;
  const pendingAuthorizedInviteCount =
    isOrgAdmin && !adminSummaryIsError
      ? Number((adminSummary as any)?.counts?.pending_authorized_invites || 0)
      : 0;
  const pendingAuthorizedInvites: AuthorizedInvite[] =
    isOrgAdmin && !adminSummaryIsError
      ? Array.isArray((adminSummary as any)?.requests?.authorized_invites)
        ? ((adminSummary as any).requests.authorized_invites as AuthorizedInvite[])
        : []
      : [];

  const refreshAll = useCallback(async () => {
    await Promise.all([refetch(), isOrgAdmin ? refetchAdminSummary() : Promise.resolve(null)]);
  }, [refetch, refetchAdminSummary, isOrgAdmin]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshAll();
    } finally {
      setRefreshing(false);
    }
  }, [refreshAll]);

  // Optimistic follow-state patch: write through to the cached payload so the
  // toggle and follower count survive re-renders and background refetches.
  const patchFollowState = useCallback(
    (following: boolean, delta: number) => {
      queryClient.setQueryData(orgPageQueryKey, (old: any) =>
        old
          ? {
              ...old,
              isFollowing: following,
              organization: {
                ...old.organization,
                followers_count: Math.max(0, (old.organization?.followers_count ?? 0) + delta),
              },
            }
          : old
      );
    },
    // orgPageQueryKey is derived from these two inputs
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryClient, params.id, user?.id]
  );

  const handleTeamPress = (team: TeamItem) => {
    // ONE page per sport (owner July-28): team-page is canonical. If the team
    // belongs to a program, its Events tab renders the sub-team picker — no
    // redirect, no separate program page. from=program is retained as a
    // deliberate-open marker (team-page no longer reverse-redirects).
    router.push({
      pathname: '/team-page',
      params: { id: team.id, name: team.name, ...(team.program_id ? { from: 'program' } : {}) },
    });
  };

  const handleGamePress = (game: GameItem) => {
    router.push({ pathname: '/game/[id]', params: { id: game.id } });
  };

  const formatEventDate = (dateValue?: string | Date | null): string => {
    if (!dateValue) return 'TBD';
    try {
      const date = new Date(dateValue as string);
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const eventDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      const daysDiff = Math.floor((eventDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
      if (daysDiff === 0) return 'Today';
      if (daysDiff === 1) return 'Tomorrow';
      return date.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
      });
    } catch {
      return String(dateValue);
    }
  };

  if (loading && !refreshing) {
    return (
      <SafeAreaView
        style={[styles.container, { backgroundColor: theme.background }]}
        edges={['top']}
      >
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={theme.tint} />
        </View>
      </SafeAreaView>
    );
  }

  if (error === 'not_found') {
    return (
      <SafeAreaView
        style={[styles.container, { backgroundColor: theme.background }]}
        edges={['top']}
      >
        <View style={styles.errorContainer}>
          <Ionicons
            name="business"
            size={48}
            color={theme.mutedText}
            style={{ marginBottom: 12 }}
          />
          <Text style={[styles.errorText, { color: theme.text, fontSize: 18, fontWeight: '600' }]}>
            Not Found
          </Text>
          <Text
            style={{ color: theme.mutedText, textAlign: 'center', marginTop: 4, marginBottom: 16 }}
          >
            This organization doesn't exist or the link is invalid.
          </Text>
          <Pressable
            onPress={handleBack}
            style={[styles.retryButton, { backgroundColor: theme.tint }]}
          >
            <Text style={styles.retryText}>Go Back</Text>
          </Pressable>
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
        <View style={styles.errorContainer}>
          <Text style={[styles.errorText, { color: theme.text }]}>{error}</Text>
          <Pressable
            onPress={() => void refetch()}
            style={[styles.retryButton, { backgroundColor: theme.tint }]}
          >
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  const orgName = organization?.display_name || organization?.name || 'Organization';
  const handle = orgName.replace(/\s+/g, '').toLowerCase();
  const orgBio = organization?.bio || organization?.description || null;
  const contactText = organization?.contact_info?.trim() || null;
  const locationText = organization?.formatted_address || organization?.location || null;

  const handleLocationPress = () => {
    if (!locationText) return;
    const query = encodeURIComponent(locationText);
    const url = Platform.select({
      ios: `maps:0,0?q=${query}`,
      default: `https://maps.google.com/?q=${query}`,
    });
    void Linking.openURL(url).catch(() => {
      void Linking.openURL(`https://maps.google.com/?q=${query}`);
    });
  };
  const upcomingGames = games
    .filter(g => {
      const d = g.scheduled_date || g.date;
      return d && new Date(d as string) >= new Date();
    })
    .slice(0, 10);

  const renderTeamRow = (team: TeamItem) => {
    const subline = [team.sport, team.season].filter(Boolean).join(' • ');
    return (
      <Pressable
        key={team.id}
        style={[styles.rowItem, { borderColor: theme.border }]}
        onPress={() => handleTeamPress(team)}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[styles.rowTitle, { color: theme.text }]} numberOfLines={1}>
            {team.name}
          </Text>
          {subline.length > 0 && (
            <Text style={[styles.rowSubtitle, { color: theme.mutedText }]} numberOfLines={1}>
              {subline}
            </Text>
          )}
        </View>
        <Ionicons name="chevron-forward" size={18} color={theme.mutedText} />
      </Pressable>
    );
  };

  const renderProgramRow = (group: (typeof programGroups)[number]) => {
    const program = group.programId ? programsById.get(group.programId) : undefined;
    const title = program ? formatProgramLabel(program) : group.teams[0]?.sport || 'Teams';
    // Folder labels ordered by (level rank, gender) — "Boys Varsity, Girls JV" —
    // rather than the team-name sort the list arrives in. Deduped and capped so
    // a large program's subtitle can't overflow the row.
    const folderLabels = Array.from(
      new Set(
        [...group.teams]
          .sort((a, b) => {
            const byLevel = levelRank(a.level) - levelRank(b.level);
            if (byLevel !== 0) return byLevel;
            return genderRank(a.gender) - genderRank(b.gender);
          })
          .map(t => formatTeamFolderLabel({ gender: t.gender, level: t.level }))
      )
    );
    const shownLabels = folderLabels.slice(0, 3);
    const extraCount = folderLabels.length - shownLabels.length;
    const labelText = shownLabels.join(', ') + (extraCount > 0 ? ` +${extraCount} more` : '');
    const count = group.teams.length;
    const subtitle = `${count} team${count !== 1 ? 's' : ''}${
      folderLabels.length ? ` · ${labelText}` : ''
    }`;
    return (
      <Pressable
        key={group.programId}
        style={[styles.rowItem, { borderColor: theme.border }]}
        onPress={() => {
          // ONE page per sport (owner July-28): open the sport's team-page. Its
          // Events tab renders the sub-team picker (Boys Varsity, Girls JV, …)
          // when the program has >1 sub-team; a single-team sport just shows
          // that team. We open the level/gender-first sub-team (Boys Varsity
          // first) so the landing sub-team is deterministic. from=program marks
          // a deliberate open (team-page no longer reverse-redirects).
          const ordered = [...group.teams].sort((a, b) => {
            const byLevel = levelRank(a.level) - levelRank(b.level);
            if (byLevel !== 0) return byLevel;
            return genderRank(a.gender) - genderRank(b.gender);
          });
          const repr = ordered[0] ?? group.teams[0];
          if (!repr) return;
          router.push({
            pathname: '/team-page',
            params: { id: String(repr.id), name: repr.name ?? '', from: 'program' },
          });
        }}
      >
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={[styles.rowTitle, { color: theme.text }]} numberOfLines={1}>
            {title}
          </Text>
          <Text style={[styles.rowSubtitle, { color: theme.mutedText }]} numberOfLines={1}>
            {subtitle}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={theme.mutedText} />
      </Pressable>
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top']}>
      <Stack.Screen options={{ title: orgName, headerShown: false }} />

      {previewAsPublic && (
        <View style={[styles.previewBanner, { backgroundColor: theme.tint }]}>
          <Ionicons name="eye-outline" size={16} color="#FFFFFF" />
          {/* audit: fixed white on the fixed theme.tint banner */}
          <Text style={styles.previewBannerText}>Preview — how the public sees your page</Text>
          <Pressable
            onPress={handleBack}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Exit preview"
          >
            <Text style={styles.previewBannerExit}>Exit</Text>
          </Pressable>
        </View>
      )}

      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={theme.tint}
            colors={[theme.tint]}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        {/* Back Button */}
        <Pressable onPress={handleBack} style={[styles.backButton, { borderColor: theme.border }]}>
          <Ionicons name="arrow-back" size={22} color={theme.text} />
        </Pressable>

        {/* Admin: View Join Requests */}
        {/* Coach Requests: any reviewer. Invite Coach: OWNER ONLY — org invite
            creation is owner-only server-side (organizations.ts:1267); showing it
            to an org manager just 403s. */}
        {organization?.id && (canReviewCoachRequests || isOrgOwner) && (
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
            {canReviewCoachRequests ? (
              <Pressable
                onPress={() =>
                  router.push({
                    pathname: '/organization-join-requests',
                    params: {
                      organization_id: organization.id,
                      organization_name: organization.name || orgName,
                    },
                  })
                }
                style={[styles.adminButton, { backgroundColor: theme.tint, flex: 1 }]}
              >
                <Ionicons name="people" size={20} color="#fff" />
                <Text style={styles.adminButtonText}>Coach Requests</Text>
              </Pressable>
            ) : null}
            {isOrgOwner ? (
              <Pressable
                onPress={() => {
                  setInviteIdentifier('');
                  setInviteModalVisible(true);
                }}
                style={[
                  styles.adminButton,
                  {
                    backgroundColor: theme.card,
                    borderWidth: 1,
                    borderColor: theme.border,
                    flex: canReviewCoachRequests ? 1 : undefined,
                  },
                ]}
              >
                <Ionicons name="person-add-outline" size={20} color={theme.text} />
                <Text style={[styles.adminButtonText, { color: theme.text }]}>Invite Coach</Text>
              </Pressable>
            ) : null}
          </View>
        )}

        {/* Cover Image */}
        <View
          style={[
            styles.card,
            styles.coverCard,
            { backgroundColor: theme.card, borderColor: theme.border },
          ]}
        >
          {organization?.background_url ? (
            <Image
              source={{ uri: optimizeImageUrl(organization.background_url, 1200) }}
              style={styles.coverImage}
              contentFit="cover"
            />
          ) : (
            <View style={[styles.coverPlaceholder, { borderColor: theme.border }]}>
              <Ionicons name="business-outline" size={28} color={theme.mutedText} />
              <Text style={[styles.placeholderText, { color: theme.mutedText }]}>
                No cover image
              </Text>
            </View>
          )}
        </View>

        {/* Profile Card */}
        <View
          style={[
            styles.card,
            styles.profileCard,
            { backgroundColor: theme.card, borderColor: theme.border },
          ]}
        >
          <View style={[styles.avatarShell, { borderColor: theme.border }]}>
            {organization?.avatar_url || organization?.logo_url ? (
              <Image
                source={{
                  uri: optimizeImageUrl(
                    String(organization.avatar_url || organization.logo_url),
                    160
                  ),
                }}
                style={styles.avatarImage}
                contentFit="cover"
              />
            ) : (
              <View style={[styles.avatarFallback, { backgroundColor: theme.surface }]}>
                <Ionicons name="business" size={28} color={theme.mutedText} />
              </View>
            )}
          </View>
          <View style={styles.profileText}>
            <Text style={[styles.profileName, { color: theme.text }]}>{orgName}</Text>
            <Text style={[styles.profileHandle, { color: theme.mutedText }]}>@{handle}</Text>
            <View style={styles.statsRow}>
              <Text style={[styles.statNumber, { color: theme.text }]}>{sportsCount}</Text>
              <Text style={[styles.statLabel, { color: theme.mutedText }]}> Sports </Text>
              <Text style={[styles.statNumber, { color: theme.text }]}>
                {organization?.followers_count ?? 0}
              </Text>
              <Text style={[styles.statLabel, { color: theme.mutedText }]}> Followers</Text>
            </View>
          </View>
        </View>

        {/* Action Buttons */}
        <View style={styles.actionRow}>
          {isOrgOwner ? (
            <Pressable
              style={[
                styles.actionBtn,
                { flex: 1, backgroundColor: theme.card, borderColor: theme.border, borderWidth: 1 },
              ]}
              onPress={() =>
                router.push({
                  pathname: '/edit-organization',
                  params: {
                    id: organization?.id,
                    fallback: organization?.id
                      ? `/organization?id=${encodeURIComponent(organization.id)}&tab=overview`
                      : '/organization?tab=overview',
                  },
                })
              }
            >
              <Ionicons name="pencil-outline" size={16} color={theme.text} />
              <Text style={[styles.actionBtnText, { color: theme.text }]}>Edit Profile</Text>
            </Pressable>
          ) : (
            <>
              <Pressable
                style={[
                  styles.actionBtn,
                  {
                    flex: 1,
                    backgroundColor: isFollowing ? theme.tint : 'transparent',
                    borderColor: theme.tint,
                    borderWidth: 1,
                  },
                ]}
                disabled={followBusy}
                onPress={async () => {
                  if (!organization?.id || followBusy) return;
                  setFollowBusy(true);
                  try {
                    if (isFollowing) {
                      await Organization.unfollow(organization.id);
                      patchFollowState(false, -1);
                    } else {
                      await Organization.follow(organization.id);
                      patchFollowState(true, 1);
                    }
                  } catch (err) {
                    if (__DEV__) console.error('Organization follow/unfollow failed:', err);
                    Alert.alert('Error', 'Failed to update follow status. Please try again.');
                  } finally {
                    setFollowBusy(false);
                  }
                }}
              >
                <Ionicons
                  name={isFollowing ? 'checkmark' : 'add'}
                  size={16}
                  color={isFollowing ? '#fff' : theme.tint}
                />
                <Text style={[styles.actionBtnText, { color: isFollowing ? '#fff' : theme.tint }]}>
                  {isFollowing ? 'Following' : 'Follow'}
                </Text>
              </Pressable>
            </>
          )}
        </View>

        {/* Pending Coaches Quick Action */}
        {canReviewCoachRequests && pendingCoachError && organization?.id && (
          <Pressable
            style={[
              styles.card,
              styles.sectionCard,
              {
                backgroundColor: theme.card,
                borderColor: theme.border,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
              },
            ]}
            onPress={() =>
              router.push(
                buildOrganizationJoinRequestsRoute(organization.id, organization.name || orgName)
              )
            }
          >
            <MaterialIcons name="error-outline" size={24} color={theme.destructive} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14, color: theme.destructive, fontWeight: '600' }}>
                Could not load pending coaches
              </Text>
              <Text style={{ fontSize: 12, color: theme.mutedText, marginTop: 2 }}>
                Tap to open approvals
              </Text>
            </View>
          </Pressable>
        )}
        {canReviewCoachRequests && pendingCoachCount > 0 && organization?.id && (
          <Pressable
            style={[
              styles.card,
              styles.sectionCard,
              {
                backgroundColor: colorScheme === 'dark' ? 'rgba(245,158,11,0.12)' : '#FEF9C3',
                borderColor: colorScheme === 'dark' ? 'rgba(245,158,11,0.35)' : '#DAA520',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
              },
            ]}
            onPress={() =>
              router.push(
                buildOrganizationJoinRequestsRoute(organization.id, organization.name || orgName)
              )
            }
          >
            <MaterialIcons
              name="group-add"
              size={24}
              color={colorScheme === 'dark' ? '#FCD34D' : '#DAA520'}
            />
            <View style={{ flex: 1 }}>
              <Text
                style={{
                  fontSize: 15,
                  fontWeight: '700',
                  color: colorScheme === 'dark' ? '#FDE68A' : '#92400E',
                }}
              >
                {pendingCoachCount} coach{pendingCoachCount !== 1 ? 'es' : ''} pending approval
              </Text>
              <Text
                style={{
                  fontSize: 12,
                  color: colorScheme === 'dark' ? '#FCD34D' : '#A16207',
                  marginTop: 2,
                }}
              >
                Tap to review requests
              </Text>
            </View>
            <Ionicons
              name="chevron-forward"
              size={18}
              color={colorScheme === 'dark' ? '#FCD34D' : '#DAA520'}
            />
          </Pressable>
        )}

        {isOrgAdmin && (
          <View
            style={[
              styles.card,
              styles.sectionCard,
              { backgroundColor: theme.card, borderColor: theme.border },
            ]}
          >
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <Text style={[styles.sectionTitle, { color: theme.text }]}>Authorized Invites</Text>
              <Text style={[styles.metaText, { color: theme.mutedText }]}>
                {pendingAuthorizedInviteCount || pendingAuthorizedInvites.length} pending
              </Text>
            </View>
            {pendingAuthorizedInvites.length === 0 ? (
              <Text style={[styles.emptyText, { color: theme.mutedText }]}>
                No pending authorized invites.
              </Text>
            ) : (
              pendingAuthorizedInvites.map(invite => (
                <View
                  key={invite.id}
                  style={[
                    styles.rowItem,
                    { borderColor: theme.border, justifyContent: 'space-between' },
                  ]}
                >
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={[styles.rowTitle, { color: theme.text }]} numberOfLines={1}>
                      {invite.email || 'Pending invite'}
                    </Text>
                    <Text
                      style={[styles.rowSubtitle, { color: theme.mutedText }]}
                      numberOfLines={1}
                    >
                      {String(invite.role || 'member').replace(/_/g, ' ')}
                    </Text>
                  </View>
                  {/* Managers may VIEW pending invites (server allows) but only the
                      OWNER may revoke them (organizations.ts:1474) — hide Cancel for
                      non-owners so it doesn't 403. */}
                  {isOrgOwner ? (
                    <Pressable
                      onPress={async () => {
                        if (!organization?.id) return;
                        try {
                          await Organization.cancelInvite(organization.id, invite.id);
                          await refreshAll();
                        } catch (err: any) {
                          Alert.alert('Error', toUserMessage(err, 'Failed to cancel invite.'));
                        }
                      }}
                      style={[
                        styles.actionBtn,
                        {
                          backgroundColor: 'transparent',
                          borderColor: theme.border,
                          borderWidth: 1,
                          paddingHorizontal: 12,
                          paddingVertical: 8,
                          minHeight: 0,
                        },
                      ]}
                    >
                      <Text style={[styles.actionBtnText, { color: theme.text }]}>Cancel</Text>
                    </Pressable>
                  ) : null}
                </View>
              ))
            )}
          </View>
        )}

        {/* About */}
        <View
          style={[
            styles.card,
            styles.sectionCard,
            { backgroundColor: theme.card, borderColor: theme.border },
          ]}
        >
          <Text style={[styles.sectionTitle, { color: theme.text }]}>About</Text>
          {orgBio ? <Text style={[styles.bioText, { color: theme.text }]}>{orgBio}</Text> : null}
          {contactText && (
            <View style={[styles.contactRow, { borderColor: theme.border }]}>
              <Ionicons name="mail-outline" size={16} color={theme.mutedText} />
              <Text style={[styles.contactText, { color: theme.mutedText }]} selectable>
                {contactText}
              </Text>
            </View>
          )}
          {organization?.created_at && (
            <View style={styles.metaRow}>
              <Ionicons name="calendar-outline" size={14} color={theme.mutedText} />
              <Text style={[styles.metaText, { color: theme.mutedText }]}>
                Created{' '}
                {new Date(organization.created_at).toLocaleDateString('en-US', {
                  month: 'long',
                  year: 'numeric',
                })}
              </Text>
            </View>
          )}
        </View>

        {/* Location */}
        {locationText ? (
          <View
            style={[
              styles.card,
              styles.sectionCard,
              { backgroundColor: theme.card, borderColor: theme.border },
            ]}
          >
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Location</Text>
            <Pressable
              onPress={handleLocationPress}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
            >
              <Ionicons name="location-outline" size={16} color={theme.tint} />
              <Text style={{ color: theme.tint }}>{locationText}</Text>
            </Pressable>
          </View>
        ) : null}

        {/* Teams */}
        <View
          style={[
            styles.card,
            styles.sectionCard,
            { backgroundColor: theme.card, borderColor: theme.border },
          ]}
        >
          <Text style={[styles.sectionTitle, { color: theme.text }]}>Sports</Text>
          {teams.length === 0 ? (
            <Text style={[styles.emptyText, { color: theme.mutedText }]}>No sports yet.</Text>
          ) : hasProgramGroups ? (
            <>
              {programGroups.map(renderProgramRow)}
              {ungroupedTeams.map(renderTeamRow)}
            </>
          ) : (
            teams.map(renderTeamRow)
          )}
        </View>

        {/* Upcoming Events */}
        <View
          style={[
            styles.card,
            styles.sectionCard,
            { backgroundColor: theme.card, borderColor: theme.border },
          ]}
        >
          <Text style={[styles.sectionTitle, { color: theme.text }]}>Upcoming Events</Text>
          {upcomingGames.length === 0 ? (
            <Text style={[styles.emptyText, { color: theme.mutedText }]}>No upcoming events.</Text>
          ) : (
            upcomingGames.map(game => {
              const dateStr = formatEventDate(game.scheduled_date || game.date);
              const rowTitle = gameRowTitle({
                event_type: game.event_type,
                title: game.title,
                opponent: game.opponent_name || game.away_team,
              });
              return (
                <Pressable
                  key={game.id}
                  style={[styles.rowItem, { borderColor: theme.border }]}
                  onPress={() => handleGamePress(game)}
                >
                  <View style={[styles.eventIconContainer, { backgroundColor: theme.surface }]}>
                    <Ionicons name="football-outline" size={20} color={theme.tint} />
                  </View>
                  <View style={{ flex: 1, gap: 4 }}>
                    <Text style={[styles.rowTitle, { color: theme.text }]} numberOfLines={1}>
                      {rowTitle}
                    </Text>
                    <View style={styles.eventMetaRow}>
                      <Text style={[styles.rowSubtitle, { color: theme.mutedText }]}>
                        {dateStr}
                      </Text>
                      {game.location && (
                        <>
                          <Text style={[styles.rowSubtitle, { color: theme.mutedText }]}> • </Text>
                          <Text
                            style={[styles.rowSubtitle, { color: theme.mutedText }]}
                            numberOfLines={1}
                          >
                            {game.location}
                          </Text>
                        </>
                      )}
                    </View>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={theme.mutedText} />
                </Pressable>
              );
            })
          )}
        </View>
      </ScrollView>
      {/* Invite Coach Modal — replaces iOS-only Alert.prompt */}
      <Modal
        visible={inviteModalVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setInviteModalVisible(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setInviteModalVisible(false)}>
          <Pressable
            style={[styles.modalContent, { backgroundColor: theme.card }]}
            onPress={() => {}}
          >
            <Text style={[styles.modalTitle, { color: theme.text }]}>Invite Coach</Text>
            <Text style={[styles.modalSubtitle, { color: theme.mutedText }]}>
              Enter the coach's username or email address:
            </Text>
            <TextInput
              style={[
                styles.modalInput,
                { backgroundColor: theme.background, borderColor: theme.border, color: theme.text },
              ]}
              placeholder="@coachname or coach@example.com"
              placeholderTextColor={theme.mutedText}
              value={inviteIdentifier}
              onChangeText={setInviteIdentifier}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
            />
            <View style={styles.modalButtons}>
              <Pressable
                style={[styles.modalButton, { borderColor: theme.border }]}
                onPress={() => setInviteModalVisible(false)}
              >
                <Text style={[styles.modalButtonText, { color: theme.mutedText }]}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.modalButton, { backgroundColor: theme.tint }]}
                onPress={async () => {
                  if (!inviteIdentifier.trim() || !organization) return;
                  try {
                    await Organization.invite(organization.id, inviteIdentifier.trim(), 'member');
                    setInviteModalVisible(false);
                    await refreshAll();
                    Alert.alert('Invited', `Invitation sent to ${inviteIdentifier.trim()}`);
                  } catch (err: any) {
                    Alert.alert('Error', toUserMessage(err, 'Failed to send invite'));
                  }
                }}
              >
                <Text style={[styles.modalButtonText, { color: '#fff' }]}>Send Invite</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  previewBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  // audit: fixed white on the fixed theme.tint preview banner background
  previewBannerText: { flex: 1, color: '#FFFFFF', fontSize: 13, fontWeight: '600' },
  previewBannerExit: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
  },
  errorText: {
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 20,
  },
  retryButton: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  retryText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  content: {
    padding: 16,
    gap: 16,
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  adminButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    alignSelf: 'flex-start',
  },
  adminButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#fff',
  },
  card: {
    borderRadius: 16,
    borderWidth: 1,
  },
  coverCard: {
    height: 160,
    overflow: 'hidden',
    padding: 0,
  },
  coverImage: {
    width: '100%',
    height: '100%',
  },
  coverPlaceholder: {
    flex: 1,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  placeholderText: {
    fontSize: 13,
    fontWeight: '500',
  },
  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    padding: 16,
  },
  avatarShell: {
    width: 72,
    height: 72,
    borderRadius: 36,
    borderWidth: 1,
    overflow: 'hidden',
    flexShrink: 0,
  },
  avatarImage: {
    width: '100%',
    height: '100%',
  },
  avatarFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  profileText: {
    flex: 1,
    gap: 4,
  },
  profileName: {
    fontSize: 20,
    fontWeight: '700',
  },
  profileHandle: {
    fontSize: 14,
    fontWeight: '500',
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginTop: 4,
  },
  statNumber: {
    fontSize: 14,
    fontWeight: '700',
  },
  statLabel: {
    fontSize: 14,
    fontWeight: '400',
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 12,
    minHeight: 40,
  },
  actionBtnText: {
    fontSize: 14,
    fontWeight: '600',
  },
  sectionCard: {
    padding: 16,
    gap: 12,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  bioText: {
    fontSize: 14,
    lineHeight: 20,
  },
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingTop: 12,
    borderTopWidth: 1,
  },
  contactText: {
    fontSize: 14,
    flex: 1,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  },
  metaText: {
    fontSize: 13,
  },
  emptyText: {
    fontSize: 14,
  },
  rowItem: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  rowSubtitle: {
    fontSize: 12,
    fontWeight: '500',
  },
  eventIconContainer: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  eventMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  modalContent: {
    width: '100%',
    maxWidth: 400,
    borderRadius: 12,
    padding: 20,
  },
  modalTitle: { fontSize: 18, fontWeight: '700', marginBottom: 4 },
  modalSubtitle: { fontSize: 14, marginBottom: 12 },
  modalInput: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    marginBottom: 16,
  },
  modalButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  modalButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  modalButtonText: { fontSize: 16, fontWeight: '600' },
});
