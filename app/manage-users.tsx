import { toUserMessage } from '@/utils/toUserMessage';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import CoachAccessRedirecting from '@/components/CoachAccessRedirecting';
import { Colors } from '@/constants/Colors';
import { useAuth } from '@/context/AuthProvider';
import { useColorScheme } from '@/hooks/useColorScheme';
import { useRequireTeamManagement } from '@/hooks/useRequireTeamManagement';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Stack, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { formatUserLabel } from '@/utils/userDisplay';
import { safeGoBack } from '@/utils/navigation';
// @ts-ignore
import { Organization, Team as TeamApi } from '@/api/entities';

type ManageUserRow = {
  id: string;
  role?: string | null;
  status?: string | null;
  scopeType?: 'org' | 'team';
  scopeId?: string;
  membershipId?: string | null;
  user?: {
    id?: string | null;
    display_name?: string | null;
    email?: string | null;
    username?: string | null;
  } | null;
  team?: {
    id?: string | null;
    name?: string | null;
  } | null;
};

function mapScopeMembers(
  members: any[],
  scope: { id: string; name: string },
  fallbackKeyPrefix: string,
  scopeType: 'org' | 'team'
): ManageUserRow[] {
  return members.map((member: any) => ({
    id: String(
      member.id ||
        `${member.user?.id || member.user?.email || member.user?.username || fallbackKeyPrefix}:${
          member.role || 'member'
        }`
    ),
    role: member.role || 'member',
    status: member.status || 'active',
    scopeType,
    scopeId: scope.id,
    membershipId: member.id ? String(member.id) : null,
    user: member.user || null,
    team: scope,
  }));
}

function mapScopeInvites(
  invites: any[],
  scope: { id: string; name: string },
  scopeType: 'org' | 'team'
): ManageUserRow[] {
  return invites.map((invite: any) => ({
    id: String(invite.id || invite.email),
    role: invite.role || 'member',
    status: invite.status || 'pending',
    scopeType,
    scopeId: scope.id,
    membershipId: null,
    user: {
      email: invite.email || null,
      display_name: invite.email || null,
      username: null,
    },
    team: scope,
  }));
}

function dedupeRows(rows: ManageUserRow[]): ManageUserRow[] {
  const seen = new Set<string>();
  return rows.filter(row => {
    const key = [
      row.user?.id || row.user?.email || row.id,
      row.team?.id || row.team?.name || 'no-team',
      row.role || 'member',
      row.status || 'active',
    ].join('::');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// TODO v1.1: Wire up navigation from admin-dashboard
function ManageUsersScreen() {
  const { canManage, loading: coachLoading } = useRequireTeamManagement();
  const { user } = useAuth();
  const colorScheme = useColorScheme() ?? 'light';
  const router = useRouter();
  const [q, setQ] = useState('');

  const {
    data,
    isPending: loading,
    isError,
  } = useQuery({
    queryKey: ['manage-users', user?.id],
    enabled: canManage && !coachLoading,
    queryFn: async (): Promise<ManageUserRow[]> => {
      const scopedRows: ManageUserRow[] = [];

      const orgSummaries: any = await Organization.reviewSummaries().catch(() => []);
      const managedOrgSummaries = await Promise.all(
        (Array.isArray(orgSummaries) ? orgSummaries : []).map((entry: any) =>
          Organization.adminSummary(String(entry?.organization?.id)).catch(() => null)
        )
      );

      for (const summary of managedOrgSummaries) {
        if (!summary?.organization?.id) continue;
        const members = Array.isArray(summary.members) ? summary.members : [];
        const invites = Array.isArray(summary?.requests?.authorized_invites)
          ? summary.requests.authorized_invites
          : [];
        const scope = {
          id: String(summary.organization.id),
          name: summary.organization.name || 'Organization',
        };
        scopedRows.push(
          ...mapScopeMembers(members, scope, scope.id, 'org'),
          ...mapScopeInvites(invites, scope, 'org')
        );
      }

      const managedTeams: any[] = await TeamApi.managed().catch(() => []);
      const teamSummaries = await Promise.all(
        (Array.isArray(managedTeams) ? managedTeams : []).map((team: any) =>
          TeamApi.adminSummary(String(team.id)).catch(() => null)
        )
      );

      for (const summary of teamSummaries) {
        if (!summary?.team?.id) continue;
        const members = Array.isArray(summary.members) ? summary.members : [];
        const invites = Array.isArray(summary.pending_invites) ? summary.pending_invites : [];
        const scope = {
          id: String(summary.team.id),
          name: summary.team.name || 'Team',
        };
        scopedRows.push(
          ...mapScopeMembers(members, scope, scope.id, 'team'),
          ...mapScopeInvites(invites, scope, 'team')
        );
      }

      return dedupeRows(scopedRows);
    },
  });

  const queryClient = useQueryClient();
  const [removingId, setRemovingId] = useState<string | null>(null);

  const handleRemoveOrgMember = (row: ManageUserRow) => {
    if (!row.scopeId || !row.membershipId) return;
    Alert.alert(
      'Remove member',
      `Remove ${formatUserLabel(row.user)} from ${row.team?.name || 'this organization'}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              setRemovingId(row.id);
              await Organization.removeMember(row.scopeId!, row.membershipId!);
              await queryClient.invalidateQueries({ queryKey: ['manage-users'] });
            } catch (e: any) {
              Alert.alert('Could not remove member', toUserMessage(e, 'Please try again.'));
            } finally {
              setRemovingId(null);
            }
          },
        },
      ]
    );
  };

  const rows = useMemo(() => data ?? [], [data]);
  const error = isError ? 'Failed to load users' : null;

  const filtered = useMemo(() => {
    const s = q.toLowerCase();
    return rows.filter(
      (u: any) =>
        (u.user?.display_name || '').toLowerCase().includes(s) ||
        (u.user?.email || '').toLowerCase().includes(s) ||
        (u.team?.name || '').toLowerCase().includes(s)
    );
  }, [q, rows]);

  if (coachLoading) {
    return (
      <SafeAreaView
        style={[styles.container, { backgroundColor: Colors[colorScheme].background }]}
        edges={['top', 'bottom']}
      >
        <ActivityIndicator style={{ marginTop: 40 }} color={Colors[colorScheme].tint} />
      </SafeAreaView>
    );
  }

  if (!canManage) {
    return (
      <CoachAccessRedirecting
        backgroundColor={Colors[colorScheme].background}
        spinnerColor={Colors[colorScheme].tint}
        textColor={Colors[colorScheme].mutedText}
      />
    );
  }

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: Colors[colorScheme].background }]}
      edges={['top', 'bottom']}
    >
      <Stack.Screen
        options={{
          title: 'Manage Users',
          headerLeft: () => (
            <Pressable
              onPress={() => {
                safeGoBack(router);
              }}
              style={{ paddingLeft: 8 }}
            >
              <MaterialIcons name="chevron-left" size={24} color={Colors[colorScheme].tint} />
            </Pressable>
          ),
        }}
      />
      <Text style={[styles.title, { color: Colors[colorScheme].text }]}>Users</Text>
      <Input
        placeholder="Search name, email, or team"
        value={q}
        onChangeText={setQ}
        style={{ marginBottom: 10 }}
      />
      {loading && (
        <View style={{ paddingVertical: 16 }}>
          <ActivityIndicator color={Colors[colorScheme].tint} />
        </View>
      )}
      {error && !loading && (
        <Text style={{ color: colorScheme === 'dark' ? '#FCA5A5' : '#B91C1C' }}>{error}</Text>
      )}
      {!error && !loading && filtered.length === 0 && (
        <Text style={{ color: Colors[colorScheme].mutedText }}>
          No members or pending invites found.
        </Text>
      )}
      <FlatList
        data={filtered}
        keyExtractor={u => String(u.id)}
        renderItem={({ item }) => (
          <View
            style={[
              styles.row,
              {
                backgroundColor: Colors[colorScheme].card,
                borderColor: Colors[colorScheme].border,
              },
            ]}
          >
            <View style={{ flex: 1 }}>
              <Text style={[styles.name, { color: Colors[colorScheme].text }]}>
                {formatUserLabel(item.user)}
              </Text>
              <Text style={[styles.muted, { color: Colors[colorScheme].mutedText }]}>
                {item.user?.email || ''}
              </Text>
            </View>
            <Badge>{item.role}</Badge>
            <Text style={[styles.team, { color: Colors[colorScheme].text }]}>
              {item.team?.name || ''}
            </Text>
            <Text
              style={[
                styles.status,
                (item.status || 'active') === 'active' ? styles.ok : styles.invited,
              ]}
            >
              {item.status}
            </Text>
            {item.scopeType === 'org' &&
            item.membershipId &&
            item.role !== 'owner' &&
            item.user?.id !== user?.id ? (
              <Pressable
                accessibilityLabel="Remove member"
                hitSlop={8}
                disabled={removingId === item.id}
                onPress={() => handleRemoveOrgMember(item)}
                style={{ paddingLeft: 4 }}
              >
                {removingId === item.id ? (
                  <ActivityIndicator size="small" color={Colors[colorScheme].tint} />
                ) : (
                  <MaterialIcons name="person-remove" size={20} color="#dc2626" />
                )}
              </Pressable>
            ) : null}
          </View>
        )}
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        contentContainerStyle={{ paddingBottom: 24 }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  title: { fontSize: 20, fontWeight: '800', marginBottom: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  name: { fontWeight: '700' },
  muted: {},
  team: { minWidth: 120, textAlign: 'right', fontWeight: '600' },
  status: { minWidth: 64, textAlign: 'right', textTransform: 'capitalize', fontWeight: '700' },
  ok: { color: '#16a34a' },
  invited: { color: '#9CA3AF' },
});

export default ManageUsersScreen;
