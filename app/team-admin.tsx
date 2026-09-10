import { Team, TeamMemberships } from '@/api/entities';
import type { TeamAdminSummaryResponse, TeamResponse } from '@/api/schemas/team';
import CoachAccessRedirecting from '@/components/CoachAccessRedirecting';
import { Colors } from '@/constants/Colors';
import { useColorScheme } from '@/hooks/useColorScheme';
import { useRequireTeamManagement } from '@/hooks/useRequireTeamManagement';
import { gameRowTitle } from '@/utils/eventTitle';
import { toUserMessage } from '@/utils/toUserMessage';
import { safeGoBack } from '@/utils/navigation';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useQuery } from '@tanstack/react-query';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

type TeamAdminTab = 'overview' | 'roster' | 'schedule' | 'staff';

type TeamMember = {
  id: string;
  role: string;
  status: string;
  position?: string | null;
  user?: {
    id?: string;
    display_name?: string | null;
    username?: string | null;
    avatar_url?: string | null;
  };
};

type UserSearchResult = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
};

type TeamGame = {
  id: string;
  title?: string | null;
  date?: string;
  location?: string | null;
  home_team?: string | null;
  away_team?: string | null;
  event_type?: string | null;
};

type TeamInvite = {
  id: string;
  email: string;
  role: string;
  status: string;
  created_at?: string;
};

type TeamAdminSummary = TeamAdminSummaryResponse;

const TABS: Array<{ key: TeamAdminTab; label: string }> = [
  { key: 'overview', label: 'Overview' },
  { key: 'roster', label: 'Staff' },
  { key: 'schedule', label: 'Schedule' },
  { key: 'staff', label: 'Invites/Staff' },
];

function isTeamAdminTab(value: string | string[] | undefined): value is TeamAdminTab {
  return value === 'overview' || value === 'roster' || value === 'schedule' || value === 'staff';
}

function formatDate(value?: string): string {
  if (!value) return 'TBD';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'TBD';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function roleLabel(role?: string | null): string {
  const normalized = String(role || '')
    .replace(/_/g, ' ')
    .trim();
  if (!normalized) return 'Member';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

export default function TeamAdminScreen() {
  const { canManage, loading: coachLoading } = useRequireTeamManagement();
  const router = useRouter();
  const params = useLocalSearchParams<{
    teamId?: string;
    id?: string;
    tab?: string;
    orgId?: string;
    orgTab?: string;
  }>();
  const colorScheme = useColorScheme() ?? 'light';
  const theme = Colors[colorScheme];

  const routeTeamId =
    typeof params.teamId === 'string' && params.teamId.trim().length > 0
      ? params.teamId.trim()
      : typeof params.id === 'string' && params.id.trim().length > 0
        ? params.id.trim()
        : null;
  const fallbackRoute = params.orgId
    ? `/organization?id=${encodeURIComponent(params.orgId)}&tab=${encodeURIComponent(params.orgTab || 'teams')}`
    : '/organization?tab=teams';

  const [activeTab, setActiveTab] = useState<TeamAdminTab>(
    isTeamAdminTab(params.tab) ? params.tab : 'overview'
  );
  const [refreshing, setRefreshing] = useState(false);
  const [actingInviteId, setActingInviteId] = useState<string | null>(null);
  const [actingMemberId, setActingMemberId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<UserSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isTeamAdminTab(params.tab)) {
      setActiveTab(params.tab);
    }
  }, [params.tab]);

  type TeamAdminQueryData = {
    selectedTeamId: string;
    team: TeamResponse | null;
    canAdminister: boolean;
    members: TeamMember[];
    pendingInvites: TeamInvite[];
    games: TeamGame[];
  };

  const {
    data,
    isPending: loading,
    isError,
    error: queryError,
    refetch,
    isRefetching,
  } = useQuery({
    queryKey: ['team-admin', routeTeamId],
    queryFn: async (): Promise<TeamAdminQueryData> => {
      let nextTeamId = routeTeamId;
      if (!nextTeamId) {
        const managed = await Team.managed();
        if (Array.isArray(managed) && managed[0]?.id) {
          nextTeamId = String(managed[0].id);
        }
      }

      if (!nextTeamId) {
        throw new Error('No managed team found');
      }

      const summary = (await Team.adminSummary(nextTeamId)) as TeamAdminSummary;

      return {
        selectedTeamId: nextTeamId,
        team: summary?.team ?? null,
        // Full-administration tier (owner/head coach/org owner). Add-player,
        // archive/restore member, and cancel-invite all require it server-side;
        // the staff tier (managers/assistant_coaches) that this screen admits
        // must NOT see those actions or they 403.
        canAdminister: (summary as any)?.permissions?.can_administer === true,
        members: Array.isArray(summary?.members) ? (summary.members as TeamMember[]) : [],
        pendingInvites: Array.isArray((summary as any)?.pending_invites)
          ? ((summary as any).pending_invites as TeamInvite[])
          : [],
        games: Array.isArray(summary?.upcoming_games) ? (summary.upcoming_games as TeamGame[]) : [],
      };
    },
  });

  const team = data?.team ?? null;
  const canAdminister = data?.canAdminister ?? false;
  const members = useMemo(() => data?.members ?? [], [data?.members]);
  const pendingInvites = data?.pendingInvites ?? [];
  const games = data?.games ?? [];
  const selectedTeamId = data?.selectedTeamId ?? routeTeamId;
  const error = isError ? toUserMessage(queryError, 'Failed to load team admin') : null;

  // Background-only refetch on focus (e.g. after editing the roster on
  // another screen) — only once data has loaded once, so it never re-shows
  // the blocking spinner. Mirrors manage-teams.tsx's hasLoadedTeamsRef guard.
  const hasLoadedTeamRef = useRef(false);
  hasLoadedTeamRef.current = hasLoadedTeamRef.current || !loading;
  useFocusEffect(
    useCallback(() => {
      if (!hasLoadedTeamRef.current) return undefined;
      void refetch().catch(e => {
        if (__DEV__) console.warn('[TeamAdmin] focus reload error:', e);
      });
      return undefined;
    }, [refetch])
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refetch();
    setRefreshing(false);
  }, [refetch]);

  const staffMembers = useMemo(
    () =>
      members.filter(member =>
        ['owner', 'manager', 'coach', 'assistant_coach'].includes(String(member.role || ''))
      ),
    [members]
  );

  const handleCancelInvite = useCallback(
    async (invite: TeamInvite) => {
      if (!selectedTeamId || actingInviteId) return;

      Alert.alert('Cancel invite', `Cancel the pending invite for ${invite.email}?`, [
        { text: 'Keep', style: 'cancel' },
        {
          text: 'Cancel Invite',
          style: 'destructive',
          onPress: async () => {
            setActingInviteId(invite.id);
            try {
              await Team.cancelInvite(selectedTeamId, invite.id);
              await refetch();
            } catch (err: unknown) {
              const message = toUserMessage(err, 'Failed to cancel invite');
              Alert.alert('Unable to cancel invite', message);
            } finally {
              setActingInviteId(null);
            }
          },
        },
      ]);
    },
    [actingInviteId, refetch, selectedTeamId]
  );

  const handleToggleMemberStatus = useCallback(
    async (member: TeamMember) => {
      if (!member.user?.id || actingMemberId) return;
      const isActive = member.status === 'active';
      const nextStatus = isActive ? 'archived' : 'active';
      const label = isActive ? 'Archive' : 'Restore';
      const name = member.user.display_name || member.user.username || 'this member';

      Alert.alert(
        `${label} member`,
        isActive
          ? `Archive ${name}? They will be hidden from the active roster but can be restored later.`
          : `Restore ${name} to the active roster?`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: label,
            style: isActive ? 'destructive' : 'default',
            onPress: async () => {
              setActingMemberId(member.id);
              try {
                await TeamMemberships.update(member.id, { status: nextStatus });
                await refetch();
              } catch (err: unknown) {
                const message = toUserMessage(err, `Failed to ${label.toLowerCase()} member`);
                Alert.alert(`Unable to ${label.toLowerCase()} member`, message);
              } finally {
                setActingMemberId(null);
              }
            },
          },
        ]
      );
    },
    [actingMemberId, refetch]
  );

  const handleSearchUsers = useCallback(
    (q: string) => {
      setSearchQuery(q);
      if (searchTimeoutRef.current) clearTimeout(searchTimeoutRef.current);
      if (!q || q.length < 2 || !selectedTeamId) {
        setSearchResults([]);
        return;
      }
      searchTimeoutRef.current = setTimeout(async () => {
        setSearching(true);
        try {
          const results = await TeamMemberships.searchUsers(selectedTeamId, q);
          setSearchResults(Array.isArray(results) ? (results as UserSearchResult[]) : []);
        } catch {
          setSearchResults([]);
        } finally {
          setSearching(false);
        }
      }, 400);
    },
    [selectedTeamId]
  );

  const handleAddUser = useCallback(
    async (user: UserSearchResult) => {
      if (!selectedTeamId) return;
      Alert.alert(
        'Add to staff',
        `Add ${user.display_name || user.username || 'this user'} as an assistant coach? You can change their role afterwards from My Team.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Add',
            onPress: async () => {
              try {
                await TeamMemberships.create({
                  team_id: selectedTeamId,
                  user_id: user.id,
                  role: 'assistant_coach',
                });
                setSearchQuery('');
                setSearchResults([]);
                await refetch();
              } catch (err: unknown) {
                const message = toUserMessage(err, 'Failed to add staff member');
                Alert.alert('Unable to add staff member', message);
              }
            },
          },
        ]
      );
    },
    [selectedTeamId, refetch]
  );

  if (coachLoading) {
    return (
      <SafeAreaView
        style={[styles.container, { backgroundColor: theme.background }]}
        edges={['top']}
      >
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={theme.tint} />
        </View>
      </SafeAreaView>
    );
  }

  if (!canManage) {
    return (
      <CoachAccessRedirecting
        backgroundColor={theme.background}
        spinnerColor={theme.tint}
        textColor={theme.mutedText}
      />
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top']}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl refreshing={refreshing || isRefetching} onRefresh={onRefresh} />
        }
      >
        <View style={styles.headerRow}>
          <Pressable onPress={() => safeGoBack(router, fallbackRoute)} hitSlop={12}>
            <MaterialIcons name="chevron-left" size={28} color={theme.tint} />
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text style={[styles.headerTitle, { color: theme.text }]} numberOfLines={1}>
              {team?.name || 'Team Admin'}
            </Text>
          </View>
          {selectedTeamId ? (
            <Pressable
              onPress={() =>
                router.push({
                  pathname: '/my-team',
                  params: {
                    teamId: selectedTeamId,
                    orgId: params.orgId,
                    orgTab: params.orgTab || 'teams',
                  },
                })
              }
              hitSlop={12}
            >
              <MaterialIcons name="edit" size={22} color={theme.text} />
            </Pressable>
          ) : (
            <View style={{ width: 22 }} />
          )}
        </View>

        {loading ? (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color={theme.tint} />
          </View>
        ) : error ? (
          <View style={styles.centered}>
            <Text style={[styles.emptyTitle, { color: theme.text }]}>{error}</Text>
          </View>
        ) : (
          <>
            <View
              style={[styles.heroCard, { backgroundColor: theme.card, borderColor: theme.border }]}
            >
              <Text style={[styles.teamName, { color: theme.text }]}>{team?.name || 'Team'}</Text>
              <Text style={[styles.metaText, { color: theme.mutedText }]}>
                {[team?.sport, team?.season, team?.organization?.name]
                  .filter(Boolean)
                  .join('  |  ')}
              </Text>
              {team?.description ? (
                <Text style={[styles.metaBody, { color: theme.text }]}>{team.description}</Text>
              ) : null}
              <View style={styles.heroActions}>
                {selectedTeamId ? (
                  <>
                    <Pressable
                      onPress={() =>
                        router.push({
                          pathname: '/team-page',
                          params: { id: selectedTeamId },
                        })
                      }
                      style={[styles.secondaryButton, { borderColor: theme.border }]}
                    >
                      <Text style={[styles.secondaryButtonText, { color: theme.text }]}>
                        Public Page
                      </Text>
                    </Pressable>
                    <Pressable
                      onPress={() =>
                        router.push({
                          pathname: '/my-team',
                          params: {
                            teamId: selectedTeamId,
                            orgId: params.orgId,
                            orgTab: params.orgTab || 'teams',
                          },
                        })
                      }
                      style={[styles.primaryButton, { backgroundColor: theme.tint }]}
                    >
                      <Text style={styles.primaryButtonText}>Manage Staff</Text>
                    </Pressable>
                  </>
                ) : null}
              </View>
            </View>

            <View style={styles.tabsRow}>
              {TABS.map(tab => {
                const selected = tab.key === activeTab;
                const badge =
                  tab.key === 'roster'
                    ? members.length
                    : tab.key === 'schedule'
                      ? games.length
                      : tab.key === 'staff'
                        ? staffMembers.length + pendingInvites.length
                        : 0;
                return (
                  <Pressable
                    key={tab.key}
                    onPress={() => setActiveTab(tab.key)}
                    style={[
                      styles.tabButton,
                      {
                        backgroundColor: selected ? theme.tint : theme.card,
                        borderColor: selected ? theme.tint : theme.border,
                      },
                    ]}
                  >
                    <Text style={[styles.tabLabel, { color: selected ? '#fff' : theme.text }]}>
                      {tab.label}
                    </Text>
                    {badge > 0 ? (
                      <Text
                        style={[styles.tabCount, { color: selected ? '#fff' : theme.mutedText }]}
                      >
                        {badge}
                      </Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>

            {activeTab === 'overview' ? (
              <View
                style={[
                  styles.sectionCard,
                  { backgroundColor: theme.card, borderColor: theme.border },
                ]}
              >
                <Text style={[styles.sectionTitle, { color: theme.text }]}>Team Overview</Text>
                <Text style={[styles.metaText, { color: theme.mutedText }]}>
                  {members.length} roster members | {staffMembers.length} staff | {games.length}{' '}
                  scheduled games
                </Text>
                {team?.organization?.name ? (
                  <Text style={[styles.metaBody, { color: theme.text }]}>
                    This team belongs to {team.organization.name}. Back navigation from here returns
                    to the organization Teams tab.
                  </Text>
                ) : null}
              </View>
            ) : null}

            {activeTab === 'roster' ? (
              <View
                style={[
                  styles.sectionCard,
                  { backgroundColor: theme.card, borderColor: theme.border },
                ]}
              >
                <Text style={[styles.sectionTitle, { color: theme.text }]}>Staff</Text>

                {/* Add staff by search — full-administration only (server 403s the staff tier) */}
                {canAdminister && (
                  <>
                    <TextInput
                      style={[
                        styles.searchInput,
                        {
                          backgroundColor: theme.background,
                          borderColor: theme.border,
                          color: theme.text,
                        },
                      ]}
                      placeholder="Search users to add…"
                      placeholderTextColor={theme.mutedText}
                      value={searchQuery}
                      onChangeText={handleSearchUsers}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                    {searching ? (
                      <ActivityIndicator
                        size="small"
                        color={theme.tint}
                        style={{ marginVertical: 6 }}
                      />
                    ) : null}
                    {searchResults.length > 0 ? (
                      <View style={[styles.searchResultsContainer, { borderColor: theme.border }]}>
                        {searchResults.map(user => (
                          <Pressable
                            key={user.id}
                            style={[styles.searchResultRow, { borderColor: theme.border }]}
                            onPress={() => void handleAddUser(user)}
                          >
                            <Text style={[styles.rowTitle, { color: theme.text }]}>
                              {user.username ? `@${user.username}` : 'Member'}
                            </Text>
                            {user.username ? (
                              <Text style={[styles.metaText, { color: theme.mutedText }]}>
                                @{user.username}
                              </Text>
                            ) : null}
                          </Pressable>
                        ))}
                      </View>
                    ) : null}
                  </>
                )}

                {members.length === 0 ? (
                  <Text style={[styles.metaText, { color: theme.mutedText }]}>
                    No roster members yet.
                  </Text>
                ) : (
                  members.map(member => (
                    <View key={member.id} style={[styles.row, { borderColor: theme.border }]}>
                      <View style={{ flex: 1 }}>
                        <Text
                          style={[
                            styles.rowTitle,
                            { color: member.status === 'archived' ? theme.mutedText : theme.text },
                          ]}
                        >
                          {member.user?.username ? `@${member.user.username}` : 'Member'}
                          {member.status === 'archived' ? ' (archived)' : ''}
                        </Text>
                        <Text style={[styles.metaText, { color: theme.mutedText }]}>
                          {roleLabel(member.role)}
                          {member.position ? `  |  ${member.position}` : ''}
                        </Text>
                      </View>
                      {canAdminister && (
                        <Pressable
                          onPress={() => void handleToggleMemberStatus(member)}
                          disabled={actingMemberId === member.id}
                          style={[
                            styles.actionButton,
                            member.status === 'archived'
                              ? styles.restoreButton
                              : styles.archiveButton,
                          ]}
                        >
                          <Text
                            style={[
                              styles.actionButtonText,
                              { color: Colors[colorScheme].mutedText },
                            ]}
                          >
                            {actingMemberId === member.id
                              ? '…'
                              : member.status === 'archived'
                                ? 'Restore'
                                : 'Archive'}
                          </Text>
                        </Pressable>
                      )}
                    </View>
                  ))
                )}
              </View>
            ) : null}

            {activeTab === 'schedule' ? (
              <View
                style={[
                  styles.sectionCard,
                  { backgroundColor: theme.card, borderColor: theme.border },
                ]}
              >
                <Text style={[styles.sectionTitle, { color: theme.text }]}>Schedule</Text>
                {games.length === 0 ? (
                  <Text style={[styles.metaText, { color: theme.mutedText }]}>
                    No scheduled games found for this team.
                  </Text>
                ) : (
                  games.map(game => (
                    <Pressable
                      key={game.id}
                      onPress={() =>
                        router.push({ pathname: '/game/[id]', params: { id: game.id } })
                      }
                      style={[styles.row, { borderColor: theme.border }]}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.rowTitle, { color: theme.text }]}>
                          {gameRowTitle({
                            event_type: game.event_type,
                            title: game.title,
                            opponent: game.away_team,
                            away_team: game.away_team,
                          })}
                        </Text>
                        <Text style={[styles.metaText, { color: theme.mutedText }]}>
                          {formatDate(game.date)}
                          {game.location ? `  |  ${game.location}` : ''}
                        </Text>
                      </View>
                      <MaterialIcons name="chevron-right" size={20} color={theme.mutedText} />
                    </Pressable>
                  ))
                )}
              </View>
            ) : null}

            {activeTab === 'staff' ? (
              <View
                style={[
                  styles.sectionCard,
                  { backgroundColor: theme.card, borderColor: theme.border },
                ]}
              >
                <Text style={[styles.sectionTitle, { color: theme.text }]}>Invites and Staff</Text>
                <Text style={[styles.metaText, { color: theme.mutedText }]}>
                  Staff management is shared between pending invites and active staff members.
                </Text>
                <Pressable
                  onPress={() =>
                    router.push({
                      pathname: '/my-team',
                      params: {
                        teamId: selectedTeamId || '',
                        orgId: params.orgId,
                        orgTab: params.orgTab || 'teams',
                      },
                    })
                  }
                  style={[
                    styles.primaryButton,
                    { backgroundColor: theme.tint, alignSelf: 'flex-start' },
                  ]}
                >
                  <Text style={styles.primaryButtonText}>Open Staff Manager</Text>
                </Pressable>
                <View style={styles.subsection}>
                  <Text style={[styles.subsectionTitle, { color: theme.text }]}>
                    Pending Invites
                  </Text>
                  {pendingInvites.length === 0 ? (
                    <Text style={[styles.metaText, { color: theme.mutedText }]}>
                      No pending staff invites.
                    </Text>
                  ) : (
                    pendingInvites.map(invite => (
                      <View key={invite.id} style={[styles.row, { borderColor: theme.border }]}>
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.rowTitle, { color: theme.text }]}>
                            {invite.email}
                          </Text>
                          <Text style={[styles.metaText, { color: theme.mutedText }]}>
                            {roleLabel(invite.role)}
                            {invite.created_at ? `  |  ${formatDate(invite.created_at)}` : ''}
                          </Text>
                        </View>
                        {canAdminister && (
                          <Pressable
                            testID={`team-admin-cancel-invite-${invite.id}`}
                            disabled={actingInviteId === invite.id}
                            onPress={() => void handleCancelInvite(invite)}
                            style={[
                              styles.secondaryButton,
                              styles.destructiveButton,
                              { borderColor: theme.destructive },
                            ]}
                          >
                            <Text
                              style={[styles.secondaryButtonText, { color: theme.destructive }]}
                            >
                              {actingInviteId === invite.id ? '...' : 'Cancel'}
                            </Text>
                          </Pressable>
                        )}
                      </View>
                    ))
                  )}
                </View>
                <View style={styles.subsection}>
                  <Text style={[styles.subsectionTitle, { color: theme.text }]}>Active Staff</Text>
                  {staffMembers.length === 0 ? (
                    <Text style={[styles.metaText, { color: theme.mutedText }]}>
                      No staff members found.
                    </Text>
                  ) : (
                    staffMembers.map(member => (
                      <View key={member.id} style={[styles.row, { borderColor: theme.border }]}>
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.rowTitle, { color: theme.text }]}>
                            {member.user?.username ? `@${member.user.username}` : 'Staff member'}
                          </Text>
                          <Text style={[styles.metaText, { color: theme.mutedText }]}>
                            {roleLabel(member.role)}
                          </Text>
                        </View>
                      </View>
                    ))
                  )}
                </View>
              </View>
            ) : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  scrollContent: {
    padding: 16,
    gap: 16,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
  },
  heroCard: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 16,
    gap: 10,
  },
  teamName: {
    fontSize: 24,
    fontWeight: '700',
  },
  heroActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 6,
  },
  primaryButton: {
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  secondaryButton: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  destructiveButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  tabsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  tabButton: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
  },
  tabLabel: {
    fontSize: 13,
    fontWeight: '700',
  },
  tabCount: {
    fontSize: 12,
    fontWeight: '700',
  },
  sectionCard: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
    gap: 12,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '700',
  },
  subsection: {
    gap: 8,
  },
  subsectionTitle: {
    fontSize: 14,
    fontWeight: '700',
  },
  row: {
    borderTopWidth: 1,
    paddingTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  rowTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  metaText: {
    fontSize: 13,
    lineHeight: 18,
  },
  metaBody: {
    fontSize: 14,
    lineHeight: 20,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  searchInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  searchResultsContainer: {
    borderWidth: 1,
    borderRadius: 8,
    overflow: 'hidden',
  },
  searchResultRow: {
    borderBottomWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  actionButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  archiveButton: {
    backgroundColor: '#f3f4f6',
  },
  restoreButton: {
    backgroundColor: '#dcfce7',
  },
  actionButtonText: {
    fontSize: 13,
    fontWeight: '600',
  },
});
