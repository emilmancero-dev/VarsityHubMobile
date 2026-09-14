/**
 * THE canonical standalone-event page (2026-07-05: the old event-detail RSVP
 * stub was retired; buildEventDetailRoute sends non-game events here and
 * game-linked events to /game/[id]). Also the stable anonymous web/deep-link
 * landing for shared event URLs (varsityhub.app/public-event?id=...). Pinned
 * as a guest-browseable public route by web-auth-gate, routingConvergence,
 * and guest-create-entry contract tests. Do not delete as "dead code".
 *
 * 2026-07-09: rebuilt into a real in-app event page. It used to render
 * web-share framing ("hosted on the VarsityHub event hub… share that link")
 * plus a raw "Event ID: <cuid>", which looked like a placeholder/broken screen
 * inside the native app. Now it shows the event's real title, date/time,
 * venue, description, and a working RSVP — consistent with the rest of the app.
 */
import MasonryGrid from '@/components/MasonryGrid';
import MasonryPostCard from '@/components/MasonryPostCard';
import { Colors } from '@/constants/Colors';
import { useColorScheme } from '@/hooks/useColorScheme';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
// @ts-ignore
import { Event, Post } from '@/api/entities';
import { useAuth } from '@/context/AuthProvider';
import { replaceAsRedirect, safeGoBack } from '@/utils/navigation';
import { promptForSignIn } from '@/utils/requireSignIn';
import { buildEventDetailRoute } from '@/utils/eventRoutes';
import { stripLinksFromDescription } from '@/utils/publicDescriptions';

function PublicEventScreen() {
  const params = useLocalSearchParams<{ id?: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const colorScheme = useColorScheme() ?? 'light';
  const [posts, setPosts] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [event, setEvent] = useState<any>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rsvpGoing, setRsvpGoing] = useState(false);
  const [rsvpCount, setRsvpCount] = useState(0);
  const [rsvpBusy, setRsvpBusy] = useState(false);

  // THERE IS NO BARE EVENT PAGE (owner, 2026-07-14: "there should never ever
  // be a bare event page"). This route survives ONLY as the web/deep-link
  // landing for shared event URLs; forward every visitor to the ONE canonical
  // rich page. GameDetailsScreen (via loadVirtualFromEvent) renders the event
  // fully and redirects on to the game page when it's game-linked. The
  // stripped content below is unreachable and kept only as a no-id fallback.
  const redirectId = params?.id ? String(params.id) : '';
  useEffect(() => {
    if (redirectId) {
      // nav-safe: pure forwarder to the canonical rich event page — replace so it never sits in the back stack
      replaceAsRedirect(router, buildEventDetailRoute(redirectId));
    }
  }, [redirectId, router]);
  const loadEventData = useCallback(async () => {
    if (!params.id) return;
    setLoading(true);
    try {
      const eventId = params.id;
      setLoadError(null);

      // Try posts by event_id first, then game_id as fallback
      let eventPosts: any[] | null = null;
      const eventPostsPage = await Post.getByEvent?.(eventId).catch(() => null);
      eventPosts = Array.isArray(eventPostsPage?.items) ? eventPostsPage.items : null;
      if (!eventPosts || eventPosts.length === 0) {
        // If no posts by event_id, try by game_id if event has one
        const eventData = await Event.get?.(eventId).catch(() => null);
        if (eventData?.game_id) {
          const gamePosts = await Post.feedForGame(eventData.game_id, {
            limit: 50,
            sort: 'trending',
          }).catch(() => null);
          if (gamePosts && Array.isArray(gamePosts.items)) {
            eventPosts = gamePosts.items;
          }
        }
      }

      const eventData = await Event.get?.(eventId).catch(() => null);
      setEvent(eventData);
      if (!eventData) {
        setPosts([]);
        setLoadError('This event is unavailable or has been removed.');
        return;
      }

      setPosts(eventPosts && eventPosts.length > 0 ? eventPosts : []);
    } catch (error) {
      if (__DEV__) console.error('Failed to load event', error);
      setEvent(null);
      setPosts([]);
      setLoadError('We could not load this event right now.');
    } finally {
      setLoading(false);
    }
  }, [params?.id]);

  // RSVP status is readable by guests (returns going:false); posting requires auth.
  const loadRsvp = useCallback(async () => {
    if (!params.id) return;
    try {
      const status: any = await Event.rsvpStatus(String(params.id)).catch(() => null);
      if (status) {
        setRsvpGoing(Boolean(status.going ?? status.attending));
        setRsvpCount(Number(status.count ?? 0));
      }
    } catch {
      // non-fatal — RSVP is a secondary affordance
    }
  }, [params?.id]);

  const toggleRsvp = useCallback(async () => {
    if (!params.id) return;
    if (!user) {
      promptForSignIn(
        () => {
          void router.push('/sign-in');
        },
        { message: 'Sign in to mark yourself as watching this event.' }
      );
      return;
    }
    const next = !rsvpGoing;
    setRsvpBusy(true);
    // Optimistic update, reverted on failure.
    setRsvpGoing(next);
    setRsvpCount(c => Math.max(0, c + (next ? 1 : -1)));
    try {
      const res: any = await Event.rsvp(String(params.id), next);
      if (res && typeof res.count === 'number') setRsvpCount(res.count);
      if (res && typeof (res.going ?? res.attending) === 'boolean')
        setRsvpGoing(Boolean(res.going ?? res.attending));
    } catch {
      setRsvpGoing(!next);
      setRsvpCount(c => Math.max(0, c + (next ? -1 : 1)));
      Alert.alert('Update failed', 'We could not update your watching status. Please try again.');
    } finally {
      setRsvpBusy(false);
    }
  }, [user, rsvpGoing, params?.id, router]);

  useEffect(() => {
    if (params?.id) {
      void loadEventData();
      void loadRsvp();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params?.id]);

  // Reload posts when screen comes back into focus (after creating a post)
  useFocusEffect(
    useCallback(() => {
      if (params?.id) {
        void loadEventData();
      }
    }, [params?.id, loadEventData])
  );

  // Hide raw promotional links ("Official fixture: https://…") from the
  // description shown on the event page (owner note, Sep 2026).
  const cleanedDescription = stripLinksFromDescription(event?.description);
  const eventDate = event?.date ? new Date(String(event.date)) : null;
  const validDate = eventDate && !isNaN(eventDate.getTime()) ? eventDate : null;
  const dateLabel = validDate
    ? validDate.toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      })
    : null;
  const timeLabel = validDate
    ? validDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : null;
  const rsvpLabelSuffix = `${rsvpCount > 0 ? ` · ${rsvpCount}` : ''}${
    event?.max_attendees ? ` / ${event.max_attendees}` : ''
  }`;

  // Redirecting to the rich page — never paint the bare content. (Only the
  // no-id case falls through to the fallback render below.)
  if (redirectId) {
    return (
      <SafeAreaView
        style={[
          styles.container,
          { backgroundColor: Colors[colorScheme].background, justifyContent: 'center' },
        ]}
        edges={['top', 'bottom']}
      >
        <Stack.Screen options={{ headerShown: false }} />
        <ActivityIndicator size="large" color={Colors[colorScheme].tint} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: Colors[colorScheme].background }]}
      edges={['top', 'bottom']}
    >
      <Stack.Screen
        options={{
          title: event?.title || 'Event',
          headerShown: true,
          headerLeft: () => (
            <Pressable
              onPress={() => {
                safeGoBack(router);
              }}
              style={{ paddingRight: 8 }}
            >
              <MaterialIcons name="chevron-left" size={28} color={Colors[colorScheme].tint} />
            </Pressable>
          ),
        }}
      />

      <ScrollView showsVerticalScrollIndicator={false}>
        <View style={styles.headerSection}>
          <Text style={[styles.title, { color: Colors[colorScheme].text }]}>
            {event?.title || 'Event'}
          </Text>

          {(dateLabel || timeLabel) && (
            <View style={styles.metaRow}>
              <MaterialIcons name="event" size={18} color={Colors[colorScheme].tint} />
              <Text style={[styles.metaText, { color: Colors[colorScheme].text }]}>
                {[dateLabel, timeLabel].filter(Boolean).join(' · ')}
              </Text>
            </View>
          )}

          {!!event?.location && (
            <View style={styles.metaRow}>
              <MaterialIcons name="place" size={18} color={Colors[colorScheme].tint} />
              <Text style={[styles.metaText, { color: Colors[colorScheme].text }]}>
                {event.location}
              </Text>
            </View>
          )}

          {!!cleanedDescription && (
            <Text style={[styles.description, { color: Colors[colorScheme].mutedText }]}>
              {cleanedDescription}
            </Text>
          )}

          {!!event && (
            <Pressable
              onPress={() => {
                void toggleRsvp();
              }}
              disabled={rsvpBusy}
              style={[
                styles.rsvpButton,
                {
                  backgroundColor: rsvpGoing ? Colors[colorScheme].tint : 'transparent',
                  borderColor: Colors[colorScheme].tint,
                  opacity: rsvpBusy ? 0.6 : 1,
                },
              ]}
            >
              <Text style={styles.rsvpEmoji}>📺</Text>
              <Text
                style={[
                  styles.rsvpButtonText,
                  { color: rsvpGoing ? '#FFFFFF' : Colors[colorScheme].tint },
                ]}
              >
                {(rsvpGoing ? "You're watching" : "I'm Watching") + rsvpLabelSuffix}
              </Text>
            </Pressable>
          )}
        </View>

        <View style={styles.postsSection}>
          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: Colors[colorScheme].text }]}>
              Event Feed
            </Text>
            <Pressable
              style={[styles.createPostButton, { backgroundColor: Colors[colorScheme].tint }]}
              onPress={() => {
                const targetGameId = event?.game_id ? String(event.game_id) : '';
                const targetEventId = params?.id ? String(params.id) : '';
                if (__DEV__)
                  console.warn(
                    '[PublicEvent] Navigating to create-post with ids:',
                    targetGameId,
                    '| params.id:',
                    params?.id,
                    '| event?.game_id:',
                    event?.game_id
                  );
                if (!user) {
                  promptForSignIn(
                    () => {
                      void router.push('/sign-in');
                    },
                    {
                      message: 'Sign in to post to this event.',
                    }
                  );
                  return;
                }
                router.push({
                  pathname: '/create-post',
                  params: targetGameId
                    ? { gameId: targetGameId, eventId: targetEventId }
                    : { eventId: targetEventId },
                });
              }}
            >
              <MaterialIcons name="add-circle" size={20} color="#FFFFFF" />
              <Text style={styles.createPostButtonText}>Create Post</Text>
            </Pressable>
          </View>

          {loading ? (
            <View style={styles.loadingContainer}>
              <ActivityIndicator color={Colors[colorScheme].tint} />
            </View>
          ) : loadError ? (
            <View style={styles.emptyState}>
              <Text style={[styles.emptyText, { color: Colors[colorScheme].text }]}>
                {loadError}
              </Text>
              <Pressable
                style={[styles.retryButton, { borderColor: Colors[colorScheme].border }]}
                onPress={() => {
                  void loadEventData();
                }}
              >
                <Text style={[styles.retryButtonText, { color: Colors[colorScheme].text }]}>
                  Retry
                </Text>
              </Pressable>
            </View>
          ) : posts.length > 0 ? (
            <MasonryGrid
              data={posts}
              numColumns={2}
              gap={12}
              renderItem={post => (
                <MasonryPostCard
                  post={post}
                  onPress={() => {
                    router.push({ pathname: '/post-detail', params: { id: post.id } } as any);
                  }}
                  onDeleted={postId => {
                    setPosts(prev => prev.filter(p => p.id !== postId));
                  }}
                  onUpdated={updatedPost => {
                    setPosts(prev => prev.map(p => (p.id === updatedPost.id ? updatedPost : p)));
                  }}
                />
              )}
            />
          ) : (
            <Text style={[styles.emptyText, { color: Colors[colorScheme].mutedText }]}>
              No posts yet for this event
            </Text>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  headerSection: {
    padding: 16,
    paddingBottom: 8,
    gap: 8,
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  metaText: {
    fontSize: 15,
    fontWeight: '500',
    flexShrink: 1,
  },
  description: {
    fontSize: 15,
    lineHeight: 21,
    marginTop: 2,
  },
  rsvpButton: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1.5,
    marginTop: 6,
  },
  rsvpButtonText: {
    fontSize: 15,
    fontWeight: '700',
  },
  rsvpEmoji: {
    fontSize: 16,
    lineHeight: 19,
  },
  postsSection: {
    marginTop: 8,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: '800',
  },
  createPostButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  createPostButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  loadingContainer: {
    paddingVertical: 24,
    alignItems: 'center',
  },
  emptyState: {
    paddingVertical: 32,
    alignItems: 'center',
    gap: 12,
  },
  emptyText: {
    textAlign: 'center',
    fontSize: 14,
    paddingHorizontal: 24,
  },
  retryButton: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  retryButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
});

export default PublicEventScreen;
