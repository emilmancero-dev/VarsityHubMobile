import { User } from '@/api/entities';
import {
  AdminGuardState,
  AdminScreenShell,
  adminScreenSharedStyles as sharedStyles,
} from '@/components/AdminScreenShared';
import { Colors } from '@/constants/Colors';
import { useColorScheme } from '@/hooks/useColorScheme';
import { useRequireAdmin } from '@/hooks/useRequireAdmin';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { safeGoBack } from '@/utils/navigation';
import { isSessionExpiryError } from '@/utils/sessionExpiryError';
import { toUserMessage } from '@/utils/toUserMessage';

function AdminUsersScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const router = useRouter();
  const { isAdmin, loading: adminLoading } = useRequireAdmin();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const [showBanned, setShowBanned] = useState(false);

  const load = useCallback(async () => {
    if (!isAdmin) return;

    setLoading(true);
    setError(null);
    try {
      const list = await User.listAllAdmin(q, 200, showBanned);
      setItems(Array.isArray(list) ? list : []);
    } catch (e: any) {
      setError(
        isSessionExpiryError(e)
          ? 'Your admin session expired. Please sign in again.'
          : e?.status === 403
            ? 'Access denied (admin only).'
            : toUserMessage(e, 'Failed to load users')
      );
    } finally {
      setLoading(false);
    }
  }, [isAdmin, q, showBanned]);

  useEffect(() => {
    void load();
  }, [load]);

  const toggleBan = (id: string, banned: boolean) => {
    const action = banned ? 'unban' : 'ban';
    Alert.alert(
      `${banned ? 'Unban' : 'Ban'} User`,
      `Are you sure you want to ${action} this user?${!banned ? ' They will lose access to the app immediately.' : ''}`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: banned ? 'Unban' : 'Ban',
          style: banned ? 'default' : 'destructive',
          onPress: async () => {
            try {
              if (banned) {
                await User.unban(id);
              } else {
                await User.ban(id);
              }
              await load();
            } catch (e: any) {
              if (isSessionExpiryError(e)) return;
              Alert.alert('Error', toUserMessage(e, `Failed to ${action} user`));
            }
          },
        },
      ]
    );
  };

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

  return (
    <AdminScreenShell
      title="Admin · Users"
      backgroundColor={Colors[colorScheme].background}
      onBack={() => {
        safeGoBack(router);
      }}
    >
      <View style={styles.bar}>
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Search by name or email"
          placeholderTextColor={Colors[colorScheme].mutedText}
          style={[
            styles.search,
            {
              backgroundColor: Colors[colorScheme].card,
              borderColor: Colors[colorScheme].border,
              color: Colors[colorScheme].text,
            },
          ]}
        />
        <Pressable
          style={[
            styles.toggle,
            { borderColor: Colors[colorScheme].border },
            showBanned && { backgroundColor: Colors[colorScheme].tint },
          ]}
          onPress={() => setShowBanned(x => !x)}
        >
          <Text
            style={[styles.toggleText, { color: showBanned ? '#fff' : Colors[colorScheme].text }]}
          >
            Banned
          </Text>
        </Pressable>
      </View>
      {loading ? (
        <View style={sharedStyles.listLoading}>
          <ActivityIndicator />
        </View>
      ) : null}
      {error ? <Text style={[sharedStyles.error, { color: '#b91c1c' }]}>{error}</Text> : null}
      {!loading && !error ? (
        <FlatList
          data={items}
          keyExtractor={u => String(u.id)}
          renderItem={({ item }) => (
            <View
              style={[
                styles.row,
                {
                  backgroundColor: Colors[colorScheme].surface,
                  borderColor: Colors[colorScheme].border,
                },
              ]}
            >
              <Text style={[styles.title, { color: Colors[colorScheme].text }]}>
                {item.display_name || '(no display)'}
              </Text>
              <Text style={[styles.meta, { color: Colors[colorScheme].mutedText }]}>
                {item.email}
              </Text>
              <View style={styles.badgesRow}>
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>
                    {item.email_verified ? 'VERIFIED' : 'UNVERIFIED'}
                  </Text>
                </View>
                {item.banned ? (
                  <View
                    style={[styles.badge, { backgroundColor: '#FEE2E2', borderColor: '#FCA5A5' }]}
                  >
                    <Text style={[styles.badgeText, { color: '#991B1B' }]}>BANNED</Text>
                  </View>
                ) : null}
              </View>
              <View style={styles.actionsRow}>
                <Pressable
                  style={styles.btn}
                  onPress={() => toggleBan(String(item.id), !!item.banned)}
                >
                  <Text style={styles.btnText}>{item.banned ? 'Unban' : 'Ban'}</Text>
                </Pressable>
                <Pressable
                  style={[styles.btn, { backgroundColor: '#374151' }]}
                  onPress={() =>
                    void router.push(`/admin-user-detail?id=${encodeURIComponent(String(item.id))}`)
                  }
                >
                  <Text style={styles.btnText}>View</Text>
                </Pressable>
              </View>
            </View>
          )}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          contentContainerStyle={sharedStyles.listContent}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <MaterialIcons name="person-search" size={48} color={Colors[colorScheme].mutedText} />
              <Text style={[styles.emptyTitle, { color: Colors[colorScheme].text }]}>
                No users match this filter
              </Text>
              <Text style={[styles.emptyBody, { color: Colors[colorScheme].mutedText }]}>
                Try adjusting your search or filter criteria.
              </Text>
            </View>
          }
        />
      ) : null}
    </AdminScreenShell>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', gap: 8, padding: 12 },
  search: {
    flex: 1,
    height: 44,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
  },
  toggle: {
    paddingHorizontal: 10,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toggleText: { fontWeight: '700' },
  row: { padding: 12, borderRadius: 12, borderWidth: 1 },
  title: { fontWeight: '800', fontSize: 16 },
  meta: {},
  badgesRow: { flexDirection: 'row', gap: 6, marginTop: 6 },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#D1D5DB',
    backgroundColor: '#D1D5DB',
  },
  badgeText: { fontWeight: '800', fontSize: 10 },
  actionsRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
  btn: { backgroundColor: '#111827', borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
  btnText: { color: 'white', fontWeight: '800' },
  emptyState: { alignItems: 'center', paddingVertical: 40 },
  emptyTitle: { fontSize: 16, fontWeight: '600', marginTop: 12 },
  emptyBody: { fontSize: 14, marginTop: 4 },
});

export default AdminUsersScreen;
