import { toUserMessage } from '@/utils/toUserMessage';
import { User } from '@/api/entities';
import { Input } from '@/components/ui/input';
import { Colors } from '@/constants/Colors';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Stack, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { safeGoBack } from '@/utils/navigation';
import { formatUserLabel } from '@/utils/userDisplay';

interface BlockedUser {
  id: string;
  username?: string;
  display_name?: string;
}

function BlockedUsersScreen() {
  const router = useRouter();
  const colorScheme = useColorScheme() ?? 'light';
  const theme = Colors[colorScheme];
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState('');

  // react-query owns the list fetch (cached + revalidated on revisit). `busy`
  // covers the block/unblock mutations; `loading` preserves the prior shared-
  // spinner UX across both.
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['blocked-users'],
    queryFn: () => User.blockedUsers() as Promise<BlockedUser[]>,
  });
  const list = Array.isArray(data) ? data : [];
  const loading = isPending || busy;

  // Preserve the prior user-facing load-error alert.
  useEffect(() => {
    if (isError) Alert.alert('Error', 'Unable to load blocked users right now.');
  }, [isError]);

  const add = useCallback(async () => {
    const trimmed = username.trim().toLowerCase();
    if (!trimmed) {
      Alert.alert('Invalid username', 'Enter the username of the person you want to block.');
      return;
    }
    try {
      setBusy(true);
      const match = await User.lookupByUsername(trimmed);
      if (!match?.id) {
        Alert.alert('User not found', 'No account matches that username.');
        setBusy(false);
        return;
      }
      await User.block(match.id);
      setUsername('');
      await refetch();
      Alert.alert('Blocked', `@${match.username || trimmed} cannot message you.`);
    } catch (err: any) {
      const message = toUserMessage(err, 'Unable to block user.');
      Alert.alert('Error', message);
    } finally {
      setBusy(false);
    }
  }, [username, refetch]);

  const remove = useCallback(
    async (userId: string) => {
      try {
        setBusy(true);
        await User.unblock(userId);
        await refetch();
      } catch (err: any) {
        const message = toUserMessage(err, 'Unable to unblock user.');
        Alert.alert('Error', message);
      } finally {
        setBusy(false);
      }
    },
    [refetch]
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.card }]} edges={['bottom']}>
      <Stack.Screen
        options={{
          title: 'Blocked Users',
          headerBackTitle: 'Back',
          headerShown: true,
          headerLeft: () => (
            <Pressable
              onPress={() => {
                safeGoBack(router);
              }}
              style={{ paddingRight: 8 }}
            >
              <MaterialIcons name="chevron-left" size={28} color="#007AFF" />
            </Pressable>
          ),
        }}
      />
      <ScrollView style={styles.content} contentContainerStyle={styles.contentContainer}>
        <Text style={[styles.title, { color: theme.text }]}>Blocked Users</Text>
        <Text style={[styles.subtitle, { color: theme.mutedText }]}>
          People you won't receive messages from.
        </Text>

        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
          <Input
            placeholder="username"
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            style={{ flex: 1 }}
          />
          <Pressable
            onPress={add}
            disabled={loading || !username.trim()}
            style={[
              styles.blockBtn,
              { backgroundColor: theme.tint, opacity: loading || !username.trim() ? 0.6 : 1 },
            ]}
          >
            <Text style={styles.blockBtnText}>{loading ? '...' : 'Block'}</Text>
          </Pressable>
        </View>

        {loading ? (
          <Text style={[styles.muted, { color: theme.mutedText }]}>Loading…</Text>
        ) : list.length === 0 ? (
          <Text style={[styles.muted, { color: theme.mutedText }]}>No blocked users.</Text>
        ) : (
          <FlatList
            data={list}
            keyExtractor={user => user.id}
            scrollEnabled={false}
            renderItem={({ item }) => (
              <View
                style={[
                  styles.row,
                  {
                    backgroundColor: theme.surface,
                    borderColor: theme.border,
                  },
                ]}
              >
                <View>
                  <Text style={[styles.email, { color: theme.text }]}>{formatUserLabel(item)}</Text>
                  {item.username ? (
                    <Text style={[styles.muted, { fontSize: 12, color: theme.mutedText }]}>
                      @{item.username}
                    </Text>
                  ) : null}
                </View>
                <Pressable onPress={() => remove(item.id)} style={styles.removeBtn}>
                  <Text style={styles.removeText}>Unblock</Text>
                </Pressable>
              </View>
            )}
            ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
          />
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flex: 1 },
  contentContainer: { padding: 16, paddingTop: 24 },
  title: { fontSize: 24, fontWeight: '700', marginBottom: 4 },
  subtitle: { marginBottom: 8 },
  muted: {},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  email: { fontWeight: '600' },
  blockBtn: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  blockBtnText: { color: '#FFFFFF', fontWeight: '700', fontSize: 15 },
  removeBtn: {
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: '#DC2626',
  },
  removeText: { color: 'white', fontWeight: '700' },
});

export default BlockedUsersScreen;
