import { toUserMessage } from '@/utils/toUserMessage';
import { Message as MsgApi } from '@/api/entities';
import {
  AdminGuardState,
  AdminScreenShell,
  adminScreenSharedStyles as sharedStyles,
} from '@/components/AdminScreenShared';
import { Colors } from '@/constants/Colors';
import { useColorScheme } from '@/hooks/useColorScheme';
import { useRequireAdmin } from '@/hooks/useRequireAdmin';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';
import { safeGoBack } from '@/utils/navigation';

function AdminMessagesScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const router = useRouter();
  const { isAdmin, loading: adminLoading } = useRequireAdmin();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<any[]>([]);

  const load = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    setError(null);
    try {
      const list = await MsgApi.listAll(200);
      setItems(Array.isArray(list) ? list : []);
    } catch (e: any) {
      setError(
        e?.status === 403
          ? 'Access denied (admin only).'
          : toUserMessage(e, 'Failed to load messages')
      );
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

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
      title="Admin · All Messages"
      backgroundColor={Colors[colorScheme].background}
      onBack={() => {
        safeGoBack(router);
      }}
    >
      {loading ? (
        <View style={sharedStyles.listLoading}>
          <ActivityIndicator />
        </View>
      ) : null}
      {error ? (
        <Text style={[sharedStyles.error, { color: Colors[colorScheme].mutedText }]}>{error}</Text>
      ) : null}
      {!loading && !error ? (
        <FlatList
          data={items}
          keyExtractor={m => String(m.id)}
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
              <Text style={[styles.msg, { color: Colors[colorScheme].text }]} numberOfLines={2}>
                {item.content || ''}
              </Text>
              <Text style={[styles.meta, { color: Colors[colorScheme].mutedText }]}>
                {(item.sender?.display_name ||
                  item.sender?.username ||
                  item.sender_email ||
                  'unknown') +
                  ' → ' +
                  (item.recipient?.display_name ||
                    item.recipient?.username ||
                    item.recipient_email ||
                    'unknown')}
              </Text>
              <Text style={[styles.meta, { color: Colors[colorScheme].mutedText }]}>
                {new Date(item.created_date || item.created_at || Date.now()).toLocaleString()}
              </Text>
            </View>
          )}
          ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          contentContainerStyle={sharedStyles.listContent}
        />
      ) : null}
    </AdminScreenShell>
  );
}

const styles = StyleSheet.create({
  row: { padding: 12, borderRadius: 12, borderWidth: 1 },
  msg: { fontWeight: '600' },
  meta: {},
});

export default AdminMessagesScreen;
