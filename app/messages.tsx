import { AppLinks } from '@/utils/links';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  type AppStateStatus,
  FlatList,
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
// @ts-ignore JS exports
import { Message, User } from '@/api/entities';
import { Colors } from '@/constants/Colors';
import { useAuth } from '@/context/AuthProvider';
import { useColorScheme } from '@/hooks/useColorScheme';
import { getAuthSnapshot } from '@/utils/authState';
import { optimizeImageUrl } from '@/utils/imageUrl';
import { safeGoBack } from '@/utils/navigation';
import { formatUserLabel } from '@/utils/userDisplay';

type MiniUser = {
  id: string;
  email?: string;
  display_name?: string;
  username?: string;
  avatar_url?: string;
};

type UIMsg = {
  id: string;
  conversation_id?: string | null;
  sender_id: string;
  recipient_id: string;
  content?: string | null;
  created_at: string;
  sender?: MiniUser | null;
  recipient?: MiniUser | null;
  read?: boolean;
};

type Conversation = {
  id: string;
  other: MiniUser;
  lastMessage: UIMsg;
  unreadCount: number;
  messages: UIMsg[];
};

function MessagesScreen() {
  const router = useRouter();
  const isFocused = useIsFocused();
  const params = useLocalSearchParams<{ sharePost?: string }>();
  const sharePostId = params?.sharePost ? String(params.sharePost) : undefined;
  const colorScheme = useColorScheme();
  const insets = useSafeAreaInsets();
  const { user: authUser, checkAuth } = useAuth();
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const [me, setMe] = useState<MiniUser | null>(null);
  const [query, setQuery] = useState('');
  const [safetyOpen, setSafetyOpen] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [searchUserQuery, setSearchUserQuery] = useState('');
  const [prefillMessage, setPrefillMessage] = useState<string | null>(null);

  useEffect(() => {
    if (sharePostId) {
      const link = AppLinks.post(sharePostId);
      setPrefillMessage(`Check out this post: ${link}`);
      setComposeOpen(true);
      // Clear the query param so it doesn't retrigger on navigation flicker
      router.setParams({ sharePost: undefined });
    }
  }, [sharePostId, router]);
  const [searchResults, setSearchResults] = useState<MiniUser[]>([]);
  const [searchingUsers, setSearchingUsers] = useState(false);
  const [suggested, setSuggested] = useState<MiniUser[]>([]);
  const [suggestedLoaded, setSuggestedLoaded] = useState(false);
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  const hasLoadedOnceRef = useRef(false);

  // Load suggested users (people the user follows) when compose modal opens
  useEffect(() => {
    if (!composeOpen || suggestedLoaded || !me?.id) return;
    let mounted = true;
    void (async () => {
      try {
        const res = await User.following(String(me.id));
        if (!mounted) return;
        const items: MiniUser[] = (res?.items || [])
          .filter((u: any) => u?.id && u.id !== me.id)
          .map((u: any) => ({
            id: u.id,
            display_name: u.display_name || u.username || 'User',
            username: u.username,
            avatar_url: u.avatar_url ?? undefined,
            email: u.email,
          }));
        setSuggested(items.slice(0, 15));
        setSuggestedLoaded(true);
      } catch {
        // Non-critical: silently ignore
      }
    })();
    return () => {
      mounted = false;
    };
  }, [composeOpen, suggestedLoaded, me]);

  // `me` powers conversation grouping (mine vs theirs); resolve it once per
  // auth change, independent of the inbox fetch.
  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const u = await getAuthSnapshot(checkAuth, authUser);
        if (mounted) setMe(u ? ((u as MiniUser) ?? null) : null);
      } catch (error: any) {
        if (__DEV__) console.warn('[Messages] Failed to load user:', error?.message || error);
        // Continue without user data
      }
    })();
    return () => {
      mounted = false;
    };
  }, [authUser, checkAuth]);

  const inboxQueryKey = ['messages-inbox', authUser?.id];
  const {
    data: inboxData,
    isPending,
    isError,
    refetch,
  } = useQuery({
    queryKey: inboxQueryKey,
    enabled: !!authUser,
    // Poll only when focused and foregrounded to avoid background
    // battery/network drain (replaces the old setInterval effect).
    refetchInterval: isFocused && appState === 'active' ? 60_000 : false,
    queryFn: async (): Promise<UIMsg[]> => {
      const result: UIMsg[] | { _isNotModified: boolean } = await (Message.list
        ? Message.list('-created_at', 50)
        : Message.filter({}, '-created_at'));
      if (result && !('_isNotModified' in result)) {
        return Array.isArray(result) ? result : [];
      }
      // 304 Not Modified from the http client's ETag cache — keep whatever
      // the query cache already has instead of clobbering it.
      return queryClient.getQueryData<UIMsg[]>(inboxQueryKey) ?? [];
    },
  });
  const messages = useMemo(() => inboxData ?? [], [inboxData]);
  // Guests never fetch (query disabled), so don't let isPending hold the
  // guest guard behind a spinner. Once data exists, background refetch
  // failures keep showing the cached inbox — the error card is only for
  // "never loaded".
  const loading = !!authUser && isPending;
  const error = isError && inboxData === undefined ? 'Unable to load messages.' : null;

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      // refetch() resolves (never throws); a failed refresh keeps existing
      // data visible, matching the old silent pull-to-refresh behavior.
      await refetch();
    } finally {
      setRefreshing(false);
    }
  }, [refetch]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      setAppState(nextState);
    });
    return () => subscription.remove();
  }, []);

  // Reload when screen comes into focus (after returning from a thread).
  // Skip the very first focus — mount already triggers the initial fetch.
  // Background-only: refetch() doesn't flip isPending once data exists.
  hasLoadedOnceRef.current = hasLoadedOnceRef.current || inboxData !== undefined;
  useFocusEffect(
    useCallback(() => {
      if (!hasLoadedOnceRef.current) return undefined;
      void refetch().catch(e => {
        if (__DEV__) console.warn('[Messages] focus reload error:', e);
      });
      return undefined;
    }, [refetch])
  );

  // Group messages into conversations
  const conversations = useMemo((): Conversation[] => {
    if (!me) return [];

    const convMap = new Map<string, Conversation>();

    messages.forEach(msg => {
      const mine = msg.sender_id === me.id;
      const other = mine ? msg.recipient : msg.sender;

      if (!other || !other.id) return;

      // Use conversation_id or create key from other user's id
      const convKey = msg.conversation_id || `user-${other.id}`;

      if (!convMap.has(convKey)) {
        convMap.set(convKey, {
          id: convKey,
          other,
          lastMessage: msg,
          unreadCount: !mine && !msg.read ? 1 : 0,
          messages: [msg],
        });
      } else {
        const conv = convMap.get(convKey)!;
        conv.messages.push(msg);
        if (!mine && !msg.read) {
          conv.unreadCount++;
        }
        // Update last message if this one is newer
        if (new Date(msg.created_at) > new Date(conv.lastMessage.created_at)) {
          conv.lastMessage = msg;
        }
      }
    });

    // Sort by last message date
    return Array.from(convMap.values()).sort(
      (a, b) =>
        new Date(b.lastMessage.created_at).getTime() - new Date(a.lastMessage.created_at).getTime()
    );
  }, [messages, me]);

  // Filter conversations by search query
  const filtered = useMemo(() => {
    if (!query) return conversations;
    const q = query.toLowerCase();
    return conversations.filter(conv => {
      const text = (conv.lastMessage.content ?? '').toLowerCase();
      const name = (conv.other.display_name ?? '').toLowerCase();
      const email = (conv.other.email ?? '').toLowerCase();
      return text.includes(q) || name.includes(q) || email.includes(q);
    });
  }, [conversations, query]);

  // Search users for compose
  useEffect(() => {
    if (!searchUserQuery || searchUserQuery.length < 2) {
      setSearchResults([]);
      return;
    }

    let mounted = true;
    const search = async () => {
      setSearchingUsers(true);
      try {
        if (!me || !me.id) {
          Alert.alert('Login Required', 'Please log in to search for users.');
          setSearchResults([]);
          return;
        }
        const result = await User.searchForMentions(searchUserQuery, 20);
        if (mounted && Array.isArray(result)) {
          setSearchResults(result.filter((u: MiniUser) => u.id !== me?.id));
        }
      } catch (e: any) {
        if (e?.status === 401 || e?.message?.toLowerCase().includes('unauthorized')) {
          Alert.alert('Login Required', 'You must be logged in to search for users.');
          setSearchResults([]);
        } else {
          if (__DEV__) console.error('User search failed', e);
        }
      } finally {
        if (mounted) setSearchingUsers(false);
      }
    };

    const timer = setTimeout(search, 300);
    return () => {
      mounted = false;
      clearTimeout(timer);
    };
  }, [searchUserQuery, me]);

  const buildThreadPath = (base: string) => {
    if (!prefillMessage) return base;
    const delimiter = base.includes('?') ? '&' : '?';
    return `${base}${delimiter}prefill=${encodeURIComponent(prefillMessage)}`;
  };

  const openThread = (conv: Conversation) => {
    const base = conv.lastMessage.conversation_id
      ? `/message-thread?conversation_id=${encodeURIComponent(String(conv.lastMessage.conversation_id))}`
      : `/message-thread?with=${encodeURIComponent(conv.other.id)}`;
    router.push(buildThreadPath(base) as any);
    if (prefillMessage) setPrefillMessage(null);
  };

  const startConversation = (user: MiniUser & { account_type?: string }) => {
    // Prevent messaging organization accounts
    if (user.account_type === 'organization') {
      Alert.alert('Cannot Message', 'Organization accounts cannot receive direct messages.');
      return;
    }
    // When starting a conversation, immediately clear the sharePost param
    // so the compose modal doesn't re-open on its own.
    if (sharePostId) {
      router.setParams({ sharePost: '' });
    }
    setComposeOpen(false);
    setSearchUserQuery('');
    setSearchResults([]);
    const base = `/message-thread?with=${encodeURIComponent(user.id)}`;
    router.push(buildThreadPath(base) as any);
    if (prefillMessage) setPrefillMessage(null);
  };

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m`;
    if (hours < 24) return `${hours}h`;
    if (days < 7) return `${days}d`;
    return date.toLocaleDateString();
  };

  const renderConversation = ({ item }: { item: Conversation }) => {
    const name = formatUserLabel(item.other, 'Unknown User');
    const avatar = item.other.avatar_url;
    const hasUnread = item.unreadCount > 0;

    return (
      <Pressable
        style={[
          styles.conversationRow,
          hasUnread && styles.conversationUnread,
          { borderBottomColor: Colors[colorScheme].border },
        ]}
        onPress={() => openThread(item)}
      >
        <View style={styles.avatarContainer}>
          {/* Always render letter fallback as base layer */}
          <View style={[styles.avatarPlaceholder, { backgroundColor: Colors[colorScheme].tint }]}>
            <Text style={styles.avatarText}>{name.charAt(0).toUpperCase()}</Text>
          </View>
          {/* Overlay actual image — if it fails to load, letter fallback stays visible */}
          {avatar ? (
            <Image
              source={{ uri: optimizeImageUrl(avatar, 160) }}
              style={[styles.avatar, styles.avatarOverlay]}
              contentFit="cover"
            />
          ) : null}
          {hasUnread && <View style={styles.unreadDot} />}
        </View>

        <View style={styles.conversationContent}>
          <View style={styles.conversationHeader}>
            <Text
              style={[
                styles.conversationName,
                { color: Colors[colorScheme].text },
                hasUnread && styles.conversationNameBold,
              ]}
              numberOfLines={1}
            >
              {name}
            </Text>
            <Text style={[styles.conversationTime, { color: Colors[colorScheme].tabIconDefault }]}>
              {formatTime(item.lastMessage.created_at)}
            </Text>
          </View>

          <View style={styles.messagePreviewRow}>
            <Text
              style={[
                styles.messagePreview,
                { color: Colors[colorScheme].tabIconDefault },
                hasUnread && styles.messagePreviewBold,
              ]}
              numberOfLines={2}
            >
              {item.lastMessage.content || 'No message content'}
            </Text>
            {hasUnread && (
              <View style={styles.unreadBadge}>
                <Text style={styles.unreadBadgeText}>{item.unreadCount}</Text>
              </View>
            )}
          </View>
        </View>
      </Pressable>
    );
  };

  const renderUserSearchItem = ({ item }: { item: MiniUser }) => {
    const name = formatUserLabel(item, 'Unknown User');
    const avatar = item.avatar_url;

    return (
      <Pressable
        style={[styles.userSearchRow, { borderBottomColor: Colors[colorScheme].border }]}
        onPress={() => startConversation(item)}
      >
        <View style={styles.avatarContainer}>
          <View style={[styles.avatarPlaceholder, { backgroundColor: Colors[colorScheme].tint }]}>
            <Text style={styles.avatarText}>{name.charAt(0).toUpperCase()}</Text>
          </View>
          {avatar ? (
            <Image
              source={{ uri: optimizeImageUrl(avatar, 160) }}
              style={[styles.avatar, styles.avatarOverlay]}
              contentFit="cover"
            />
          ) : null}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.userSearchName, { color: Colors[colorScheme].text }]}>{name}</Text>
          {item.email && (
            <Text style={[styles.userSearchEmail, { color: Colors[colorScheme].tabIconDefault }]}>
              {item.email}
            </Text>
          )}
        </View>
        <MaterialIcons name="chevron-right" size={20} color={Colors[colorScheme].tabIconDefault} />
      </Pressable>
    );
  };

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: Colors[colorScheme].background }]}
      edges={['bottom']}
    >
      <Stack.Screen options={{ headerShown: false }} />

      {/* Guest guard — show sign-in CTA instead of messages */}
      {!loading && !authUser && (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
          <MaterialIcons name="lock-outline" size={56} color={Colors[colorScheme].tabIconDefault} />
          <Text
            style={{
              fontSize: 22,
              fontWeight: '800',
              color: Colors[colorScheme].text,
              marginTop: 16,
              textAlign: 'center',
            }}
          >
            Messages
          </Text>
          <Text
            style={{
              fontSize: 15,
              color: Colors[colorScheme].mutedText,
              marginTop: 8,
              textAlign: 'center',
              lineHeight: 22,
            }}
          >
            Sign in to send and receive messages.
          </Text>
          <Pressable
            style={{
              marginTop: 24,
              backgroundColor: Colors[colorScheme].tint,
              borderRadius: 12,
              height: 50,
              paddingHorizontal: 32,
              alignItems: 'center',
              justifyContent: 'center',
              width: '100%',
            }}
            onPress={() => router.push('/sign-in')}
            accessibilityRole="button"
            accessibilityLabel="Sign in to view messages"
          >
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>Sign In</Text>
          </Pressable>
          <Pressable
            style={{
              marginTop: 12,
              borderRadius: 12,
              height: 50,
              paddingHorizontal: 32,
              alignItems: 'center',
              justifyContent: 'center',
              width: '100%',
              borderWidth: 1,
              borderColor: Colors[colorScheme].border,
              backgroundColor: Colors[colorScheme].surface,
            }}
            onPress={() => router.push('/sign-up')}
            accessibilityRole="button"
            accessibilityLabel="Create an account"
          >
            <Text style={{ color: Colors[colorScheme].text, fontSize: 16, fontWeight: '600' }}>
              Create Account
            </Text>
          </Pressable>
        </View>
      )}

      {/* Authenticated messages UI */}
      {(loading || authUser) && (
        <>
          {/* Enhanced header with gradient and safe area */}
          <LinearGradient
            colors={colorScheme === 'dark' ? ['#1E1E1E', '#121212'] : ['#ffffff', '#f8fafc']}
            style={[styles.headerGradient, { paddingTop: insets.top + 12 }]}
          >
            <View style={styles.headerRow}>
              <Pressable
                onPress={() => {
                  safeGoBack(router);
                }}
                style={styles.backButton}
                accessibilityRole="button"
                accessibilityLabel="Go back"
              >
                <MaterialIcons name="chevron-left" size={24} color={Colors[colorScheme].text} />
              </Pressable>
              <Text style={[styles.title, { color: Colors[colorScheme].text }]}>Messages</Text>
              <Pressable
                onPress={() => setSafetyOpen(true)}
                style={styles.iconButton}
                accessibilityLabel="Safety"
              >
                <MaterialIcons name="verified-user" size={24} color={Colors[colorScheme].text} />
              </Pressable>
            </View>

            {/* Search bar */}
            <View
              style={[
                styles.searchContainer,
                {
                  backgroundColor:
                    colorScheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)',
                },
              ]}
            >
              <MaterialIcons name="search" size={20} color={Colors[colorScheme].tabIconDefault} />
              <TextInput
                placeholder="Search conversations..."
                placeholderTextColor={Colors[colorScheme].tabIconDefault}
                value={query}
                onChangeText={setQuery}
                style={[styles.searchInput, { color: Colors[colorScheme].text }]}
              />
              {query.length > 0 && (
                <Pressable onPress={() => setQuery('')}>
                  <MaterialIcons
                    name="cancel"
                    size={20}
                    color={Colors[colorScheme].tabIconDefault}
                  />
                </Pressable>
              )}
            </View>
          </LinearGradient>

          <View style={styles.contentContainer}>
            {loading && (
              <View style={styles.center}>
                <ActivityIndicator color={Colors[colorScheme].tint} />
              </View>
            )}
            {error && !loading && (
              <View style={styles.errorState}>
                <MaterialIcons name="error-outline" size={48} color="#DC2626" />
                <Text style={[styles.errorStateText, { color: Colors[colorScheme].text }]}>
                  {error}
                </Text>
                <Pressable
                  style={[styles.retryButton, { backgroundColor: Colors[colorScheme].tint }]}
                  onPress={() => void refetch()}
                >
                  <Text style={styles.retryButtonText}>Try Again</Text>
                </Pressable>
              </View>
            )}

            {!loading && filtered.length === 0 && !error && (
              <View style={styles.emptyState}>
                <MaterialIcons name="forum" size={64} color={Colors[colorScheme].tabIconDefault} />
                <Text style={[styles.emptyTitle, { color: Colors[colorScheme].text }]}>
                  {query ? 'No conversations found' : 'No conversations yet'}
                </Text>
                <Text style={[styles.emptySubtitle, { color: Colors[colorScheme].tabIconDefault }]}>
                  {query ? 'Try a different search term' : 'Start a conversation to get connected'}
                </Text>
                {!query && (
                  <Pressable
                    style={[styles.emptyButton, { backgroundColor: Colors[colorScheme].tint }]}
                    onPress={() => setComposeOpen(true)}
                  >
                    <Text style={styles.emptyButtonText}>Start Messaging</Text>
                  </Pressable>
                )}
              </View>
            )}

            {!loading && filtered.length > 0 && (
              <FlatList
                data={filtered}
                keyExtractor={item => item.id}
                renderItem={renderConversation}
                contentContainerStyle={{ paddingBottom: 80 }}
                refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
              />
            )}
          </View>

          {/* Floating compose button */}
          {!loading && (
            <Pressable
              style={[
                styles.fab,
                { backgroundColor: Colors[colorScheme].tint, bottom: insets.bottom + 16 },
              ]}
              onPress={() => setComposeOpen(true)}
            >
              <MaterialIcons name="edit" size={24} color="white" />
            </Pressable>
          )}

          {/* Compose Modal */}
          <Modal
            visible={composeOpen}
            transparent
            animationType="slide"
            onRequestClose={() => setComposeOpen(false)}
          >
            <View style={styles.modalBackdrop}>
              <View
                style={[
                  styles.composeModal,
                  { backgroundColor: Colors[colorScheme].background, paddingTop: insets.top + 16 },
                ]}
              >
                <View style={styles.composeHeader}>
                  <Pressable onPress={() => setComposeOpen(false)} style={styles.modalCloseButton}>
                    <MaterialIcons name="close" size={28} color={Colors[colorScheme].text} />
                  </Pressable>
                  <Text style={[styles.composeTitle, { color: Colors[colorScheme].text }]}>
                    New Message
                  </Text>
                  <View style={{ width: 28 }} />
                </View>

                <View
                  style={[
                    styles.searchContainer,
                    {
                      backgroundColor:
                        colorScheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)',
                      marginHorizontal: 16,
                      marginBottom: 8,
                    },
                  ]}
                >
                  <MaterialIcons
                    name="search"
                    size={20}
                    color={Colors[colorScheme].tabIconDefault}
                  />
                  <TextInput
                    placeholder="Search users by username..."
                    placeholderTextColor={Colors[colorScheme].tabIconDefault}
                    value={searchUserQuery}
                    onChangeText={setSearchUserQuery}
                    style={[styles.searchInput, { color: Colors[colorScheme].text }]}
                    autoFocus
                  />
                  {searchUserQuery.length > 0 && (
                    <Pressable onPress={() => setSearchUserQuery('')}>
                      <MaterialIcons
                        name="cancel"
                        size={20}
                        color={Colors[colorScheme].tabIconDefault}
                      />
                    </Pressable>
                  )}
                </View>

                {searchingUsers && (
                  <View style={styles.center}>
                    <ActivityIndicator color={Colors[colorScheme].tint} />
                  </View>
                )}

                {!searchingUsers && searchUserQuery.length >= 2 && searchResults.length === 0 && (
                  <View style={styles.emptyState}>
                    <MaterialIcons
                      name="group"
                      size={48}
                      color={Colors[colorScheme].tabIconDefault}
                    />
                    <Text
                      style={[styles.emptyTitle, { color: Colors[colorScheme].text, fontSize: 16 }]}
                    >
                      No users found
                    </Text>
                  </View>
                )}

                {!searchingUsers && searchResults.length > 0 && (
                  <FlatList
                    data={searchResults}
                    keyExtractor={item => item.id}
                    renderItem={renderUserSearchItem}
                  />
                )}

                {searchUserQuery.length < 2 && suggested.length > 0 && (
                  <FlatList
                    data={suggested}
                    keyExtractor={item => item.id}
                    renderItem={renderUserSearchItem}
                    ListHeaderComponent={
                      <Text
                        style={[styles.suggestedHeader, { color: Colors[colorScheme].mutedText }]}
                      >
                        Suggested
                      </Text>
                    }
                  />
                )}

                {searchUserQuery.length < 2 && suggested.length === 0 && (
                  <View style={styles.emptyState}>
                    <MaterialIcons
                      name="mail-outline"
                      size={48}
                      color={Colors[colorScheme].tabIconDefault}
                    />
                    <Text
                      style={[styles.emptyTitle, { color: Colors[colorScheme].text, fontSize: 16 }]}
                    >
                      Search for someone
                    </Text>
                    <Text
                      style={[styles.emptySubtitle, { color: Colors[colorScheme].tabIconDefault }]}
                    >
                      Type a username to find users
                    </Text>
                  </View>
                )}
              </View>
            </View>
          </Modal>

          {/* Safety sheet */}
          <Modal
            visible={safetyOpen}
            transparent
            animationType="fade"
            onRequestClose={() => setSafetyOpen(false)}
          >
            <Pressable style={styles.sheetBackdrop} onPress={() => setSafetyOpen(false)}>
              <Pressable
                style={[styles.sheet, { backgroundColor: Colors[colorScheme].background }]}
                onPress={() => {}}
              >
                <Text style={[styles.sheetTitle, { color: Colors[colorScheme].text }]}>Safety</Text>
                <Pressable
                  style={styles.sheetRow}
                  onPress={() => {
                    setSafetyOpen(false);
                    void router.push('/report-abuse');
                  }}
                >
                  <MaterialIcons name="flag" size={18} color={Colors[colorScheme].text} />
                  <Text style={[styles.sheetText, { color: Colors[colorScheme].text }]}>
                    Report a message
                  </Text>
                </Pressable>
                <Pressable
                  style={styles.sheetRow}
                  onPress={() => {
                    setSafetyOpen(false);
                    void router.push('/blocked-users');
                  }}
                >
                  <MaterialIcons name="person-remove" size={18} color={Colors[colorScheme].text} />
                  <Text style={[styles.sheetText, { color: Colors[colorScheme].text }]}>
                    Blocked users
                  </Text>
                </Pressable>
                <Pressable
                  style={styles.sheetRow}
                  onPress={() => {
                    setSafetyOpen(false);
                    void router.push('/dm-restrictions');
                  }}
                >
                  <MaterialIcons name="tune" size={18} color={Colors[colorScheme].text} />
                  <Text style={[styles.sheetText, { color: Colors[colorScheme].text }]}>
                    DM restrictions
                  </Text>
                </Pressable>
                <Pressable
                  style={styles.sheetRow}
                  onPress={() => {
                    setSafetyOpen(false);
                    void router.push('/settings');
                  }}
                >
                  <MaterialIcons name="settings" size={18} color={Colors[colorScheme].text} />
                  <Text style={[styles.sheetText, { color: Colors[colorScheme].text }]}>
                    Privacy & settings
                  </Text>
                </Pressable>
              </Pressable>
            </Pressable>
          </Modal>
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  headerGradient: {
    paddingHorizontal: 16,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.05)',
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 2px 8px rgba(0, 0, 0, 0.05)' }
      : {
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.05,
          shadowRadius: 8,
        }),
    elevation: 2,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  backButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
  },
  iconButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
  },
  contentContainer: { flex: 1 },
  title: { fontSize: 20, fontWeight: '800', flex: 1, textAlign: 'center' },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    gap: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
  },
  center: { paddingVertical: 32, alignItems: 'center' },
  error: { color: '#b91c1c', marginBottom: 8, paddingHorizontal: 16 },
  errorState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 48,
    paddingHorizontal: 32,
    gap: 12,
  },
  errorStateText: {
    fontSize: 16,
    fontWeight: '500',
    textAlign: 'center',
  },
  retryButton: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
    marginTop: 4,
  },
  retryButtonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 15,
  },
  conversationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    gap: 12,
    borderBottomWidth: 1,
  },
  conversationUnread: {
    backgroundColor: 'rgba(59, 130, 246, 0.05)',
  },
  avatarContainer: {
    position: 'relative',
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
  },
  avatarPlaceholder: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
  avatarText: {
    color: 'white',
    fontSize: 20,
    fontWeight: '700',
  },
  unreadDot: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#3b82f6',
    borderWidth: 2,
    borderColor: 'white',
  },
  conversationContent: {
    flex: 1,
  },
  conversationHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  conversationName: {
    fontSize: 16,
    fontWeight: '600',
    flex: 1,
  },
  conversationNameBold: {
    fontWeight: '700',
  },
  conversationTime: {
    fontSize: 13,
    marginLeft: 8,
  },
  messagePreviewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  messagePreview: {
    fontSize: 14,
    flex: 1,
  },
  messagePreviewBold: {
    fontWeight: '600',
  },
  unreadBadge: {
    backgroundColor: '#3b82f6',
    borderRadius: 12,
    minWidth: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  unreadBadgeText: {
    color: 'white',
    fontSize: 12,
    fontWeight: '700',
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '700',
    marginTop: 16,
    marginBottom: 8,
  },
  emptySubtitle: {
    fontSize: 15,
    textAlign: 'center',
    marginBottom: 24,
  },
  emptyButton: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 12,
  },
  emptyButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '700',
  },
  fab: {
    position: 'absolute',
    right: 16,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 4px 8px rgba(0, 0, 0, 0.3)' }
      : {
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.3,
          shadowRadius: 8,
        }),
    elevation: 8,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  composeModal: {
    flex: 1,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    marginTop: 50,
  },
  composeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    marginBottom: 16,
  },
  modalCloseButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  composeTitle: {
    fontSize: 20,
    fontWeight: '800',
  },
  userSearchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    gap: 12,
    borderBottomWidth: 1,
  },
  userSearchName: {
    fontSize: 16,
    fontWeight: '600',
  },
  userSearchEmail: {
    fontSize: 14,
    marginTop: 2,
  },
  suggestedHeader: {
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 8,
  },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  sheet: { width: '100%', borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, gap: 10 },
  sheetTitle: { fontSize: 16, fontWeight: '800', marginBottom: 6 },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  sheetText: { fontWeight: '700' },
});

export default MessagesScreen;
