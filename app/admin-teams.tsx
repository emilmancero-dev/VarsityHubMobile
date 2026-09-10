import { Colors } from '@/constants/Colors';
import { useColorScheme } from '@/hooks/useColorScheme';
import { useRequireAdmin } from '@/hooks/useRequireAdmin';
import {
  AdminGuardState,
  AdminScreenShell,
  adminScreenSharedStyles as sharedStyles,
} from '@/components/AdminScreenShared';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
// @ts-ignore
import { Team as TeamApi } from '@/api/entities';
import { safeGoBack } from '@/utils/navigation';
import { isSessionExpiryError } from '@/utils/sessionExpiryError';
import { toUserMessage } from '@/utils/toUserMessage';

function AdminTeamsScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const { isAdmin, loading: adminLoading } = useRequireAdmin();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [teams, setTeams] = useState<any[]>([]);
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedTeams, setSelectedTeams] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    setError(null);
    try {
      const list = await TeamApi.listAllAdmin('', 100);
      setTeams(Array.isArray(list) ? list : []);
    } catch (e: any) {
      setError(
        isSessionExpiryError(e)
          ? 'Your admin session expired. Please sign in again.'
          : e?.status === 403
            ? 'Access denied (admin only).'
            : toUserMessage(e, 'Failed to load teams')
      );
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleTeamSelection = (teamId: string) => {
    const newSet = new Set(selectedTeams);
    if (newSet.has(teamId)) {
      newSet.delete(teamId);
    } else {
      newSet.add(teamId);
    }
    setSelectedTeams(newSet);
  };

  const selectAll = () => {
    if (selectedTeams.size === teams.length) {
      setSelectedTeams(new Set());
    } else {
      setSelectedTeams(new Set(teams.map(t => String(t.id))));
    }
  };

  const bulkDelete = async () => {
    if (selectedTeams.size === 0) return;

    Alert.alert(
      'Delete Teams',
      `Delete ${selectedTeams.size} team${selectedTeams.size > 1 ? 's' : ''}? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeleting(true);
            try {
              const teamIds = Array.from(selectedTeams);
              const results = await Promise.allSettled(
                teamIds.map(teamId => TeamApi.delete(teamId))
              );
              const sessionExpiry = results.find(
                result => result.status === 'rejected' && isSessionExpiryError(result.reason)
              );
              if (sessionExpiry) {
                return;
              }
              const failed = results.filter(result => result.status === 'rejected').length;
              if (failed > 0) {
                Alert.alert(
                  'Partial Success',
                  `Deleted ${teamIds.length - failed} team(s), ${failed} failed`
                );
              } else {
                Alert.alert(
                  'Success',
                  `Deleted ${teamIds.length} team${teamIds.length > 1 ? 's' : ''}`
                );
              }
              setSelectedTeams(new Set());
              setBulkMode(false);
              await load();
            } catch (e: any) {
              if (isSessionExpiryError(e)) {
                return;
              }
              Alert.alert('Error', toUserMessage(e, 'Failed to delete teams'));
            } finally {
              setDeleting(false);
            }
          },
        },
      ]
    );
  };

  const theme = Colors[colorScheme];

  if (adminLoading) {
    return (
      <AdminGuardState
        backgroundColor={Colors[colorScheme].background}
        textColor={Colors[colorScheme].text}
        loading
      />
    );
  }

  if (!isAdmin) {
    return (
      <AdminGuardState
        backgroundColor={Colors[colorScheme].background}
        textColor={Colors[colorScheme].text}
      />
    );
  }

  const renderHeaderRight = () => (
    <View style={{ flexDirection: 'row', gap: 12, marginRight: 8 }}>
      {bulkMode && (
        <>
          <Pressable onPress={selectAll} style={{ padding: 8 }}>
            <Text style={{ color: theme.tint, fontWeight: '600' }}>
              {selectedTeams.size === teams.length ? 'Deselect All' : 'Select All'}
            </Text>
          </Pressable>
          <Pressable
            onPress={bulkDelete}
            disabled={selectedTeams.size === 0 || deleting}
            style={{ padding: 8 }}
          >
            <Text
              style={{
                color:
                  selectedTeams.size > 0
                    ? Colors[colorScheme].destructive
                    : Colors[colorScheme].mutedText,
                fontWeight: '600',
              }}
            >
              Delete ({selectedTeams.size})
            </Text>
          </Pressable>
        </>
      )}
      <Pressable onPress={() => setBulkMode(!bulkMode)} style={{ padding: 8 }}>
        <Ionicons
          name={bulkMode ? 'close' : 'checkmark-circle-outline'}
          size={24}
          color={bulkMode ? '#dc2626' : theme.tint}
        />
      </Pressable>
    </View>
  );

  return (
    <AdminScreenShell
      title="Admin · All Teams"
      backgroundColor={theme.background}
      onBack={() => {
        safeGoBack(router);
      }}
      headerRight={renderHeaderRight}
    >
      {loading ? (
        <View style={{ padding: 24, alignItems: 'center' }}>
          <ActivityIndicator color={theme.tint} />
        </View>
      ) : null}

      {error ? (
        <Text style={[sharedStyles.centeredError, { color: Colors[colorScheme].destructive }]}>
          {error}
        </Text>
      ) : null}

      {!loading && !error && (
        <FlatList
          data={teams}
          keyExtractor={t => String(t.id)}
          renderItem={({ item }) => (
            <Pressable
              style={[
                styles.row,
                {
                  backgroundColor: theme.card,
                  borderColor: theme.border,
                },
                bulkMode &&
                  selectedTeams.has(String(item.id)) && {
                    borderColor: theme.tint,
                    borderWidth: 2,
                  },
              ]}
              onPress={() => {
                if (bulkMode) {
                  toggleTeamSelection(String(item.id));
                } else {
                  router.push({
                    pathname: '/team-page',
                    params: { id: item.id, from: 'program' },
                  } as any);
                }
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                {bulkMode && (
                  <View
                    style={{
                      width: 24,
                      height: 24,
                      borderRadius: 12,
                      borderWidth: 2,
                      borderColor: selectedTeams.has(String(item.id)) ? theme.tint : '#d1d5db',
                      backgroundColor: selectedTeams.has(String(item.id))
                        ? theme.tint
                        : 'transparent',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {selectedTeams.has(String(item.id)) && (
                      <Ionicons name="checkmark" size={16} color="#ffffff" />
                    )}
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={[styles.title, { color: theme.text }]}>{item.name}</Text>
                  {item.description ? (
                    <Text style={[styles.meta, { color: theme.mutedText }]} numberOfLines={2}>
                      {item.description}
                    </Text>
                  ) : null}
                  <View style={{ flexDirection: 'row', gap: 12, marginTop: 4 }}>
                    <Text style={[styles.meta, { color: theme.mutedText }]}>
                      <Ionicons name="people" size={12} /> {item.members || 0} members
                    </Text>
                    {item.sport && (
                      <Text style={[styles.meta, { color: theme.mutedText }]}>
                        <Ionicons name="american-football" size={12} /> {item.sport}
                      </Text>
                    )}
                  </View>
                </View>
                {!bulkMode && (
                  <Pressable
                    onPress={() =>
                      void router.push({ pathname: '/edit-team', params: { id: item.id } } as any)
                    }
                    style={{ padding: 8 }}
                  >
                    <Ionicons name="pencil" size={20} color={theme.tint} />
                  </Pressable>
                )}
              </View>
            </Pressable>
          )}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          contentContainerStyle={{ padding: 16, paddingBottom: 24 }}
          ListEmptyComponent={
            <View style={{ padding: 32, alignItems: 'center' }}>
              <Ionicons name="people-outline" size={64} color={theme.mutedText} />
              <Text style={{ color: theme.mutedText, fontSize: 16, marginTop: 16 }}>
                No teams found
              </Text>
            </View>
          }
        />
      )}
    </AdminScreenShell>
  );
}

const styles = StyleSheet.create({
  row: sharedStyles.elevatedListCard,
  title: sharedStyles.listTitle,
  meta: sharedStyles.listMeta,
});

export default AdminTeamsScreen;
