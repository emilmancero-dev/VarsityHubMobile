/**
 * LEGACY REDIRECTOR — this route used to render a bare RSVP stub, which
 * duplicated the real event experience and confused users (product decision
 * 2026-07-05: retired). It remains ONLY because shipped deep links,
 * notifications, and web hrefs (varsityhub://event/:id, /event-detail?id=)
 * land here. It resolves the event and forwards to the canonical rich event
 * page via `buildEventDetailRoute` (/game/[id]) for both game-linked and
 * standalone events (owner: "this is not an event page", 2026-07-14).
 * It renders only a spinner and an error state — never event UI.
 */
import { Colors } from '@/constants/Colors';
import { useColorScheme } from '@/hooks/useColorScheme';
import { replaceAsRedirect, safeGoBack } from '@/utils/navigation';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
// @ts-ignore legacy export shape
import { Event } from '../../api/entities';
import { buildEventDetailRoute } from '@/utils/eventRoutes';

export default function EventDetailScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const router = useRouter();
  const colorScheme = useColorScheme() ?? 'light';
  const theme = Colors[colorScheme];
  const [error, setError] = useState<string | null>(null);

  const resolveAndForward = useCallback(async () => {
    if (!id) {
      setError('This event link is missing an identifier.');
      return;
    }
    setError(null);
    try {
      const raw: any = await Event.get(String(id));
      // Guard against 304 Not-Modified stubs returned by the HTTP client
      if (!raw || raw._isNotModified || typeof raw.id === 'undefined') {
        throw new Error('Event not found');
      }
      const linkedGameId = raw.game_id ?? raw.gameId;
      replaceAsRedirect(router, buildEventDetailRoute(String(raw.id), linkedGameId)); // nav-safe: canonical rich event/game page
    } catch (e: any) {
      setError(e?.status === 404 ? 'Event not found.' : 'Unable to load event. Please try again.');
    }
  }, [id, router]);

  useEffect(() => {
    void resolveAndForward();
  }, [resolveAndForward]);

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: theme.background }]}>
      <Stack.Screen options={{ headerShown: false }} />
      {error ? (
        <View style={styles.center}>
          <Ionicons name="alert-circle-outline" size={44} color={theme.mutedText} />
          <Text style={[styles.errorText, { color: theme.text }]}>{error}</Text>
          <Pressable
            style={[styles.button, { backgroundColor: theme.tint }]}
            onPress={() => void resolveAndForward()}
          >
            <Text style={[styles.buttonText, { color: theme.background }]}>Try Again</Text>
          </Pressable>
          <Pressable style={styles.linkButton} onPress={() => safeGoBack(router, '/(tabs)/feed')}>
            <Text style={[styles.linkText, { color: theme.tint }]}>Go Back</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.tint} />
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, padding: 32 },
  errorText: { fontSize: 16, fontWeight: '600', textAlign: 'center' },
  button: { paddingHorizontal: 24, paddingVertical: 12, borderRadius: 10 },
  buttonText: { fontWeight: '700' },
  linkButton: { padding: 8 },
  linkText: { fontWeight: '600' },
});
