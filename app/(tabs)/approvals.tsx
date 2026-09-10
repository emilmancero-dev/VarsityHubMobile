import { toUserMessage } from '@/utils/toUserMessage';
import { Organization } from '@/api/entities';
import type { OrganizationReviewSummaryArrayResponse } from '@/api/schemas/organization';
import { Colors } from '@/constants/Colors';
import { useAuth } from '@/context/AuthProvider';
import { useCustomColorScheme } from '@/hooks/useCustomColorScheme';
import { replaceAsRedirect, safeGoBack } from '@/utils/navigation';
import { MaterialIcons } from '@expo/vector-icons';
import { Stack, useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

type OrgApprovalEntry = {
  id: string;
  name: string;
  pendingCoachRequests: number;
  pendingGameReviews: number;
  pendingEventReviews: number;
};

function buildOrganizationRequestsRoute(id: string): Href {
  return `/organization?id=${encodeURIComponent(id)}&tab=requests` as Href;
}

export default function ApprovalsScreen() {
  const { loading: authLoading } = useAuth();
  const router = useRouter();
  const colorScheme = useCustomColorScheme();
  const theme = Colors[colorScheme];
  const hasAutoForwardedRef = useRef(false);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [entries, setEntries] = useState<OrgApprovalEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setError(null);
    try {
      const summaries =
        (await Organization.reviewSummaries()) as OrganizationReviewSummaryArrayResponse;
      setEntries(
        (Array.isArray(summaries) ? summaries : []).map(summary => ({
          id: String(summary.organization?.id || ''),
          name: String(summary.organization?.name || 'Organization'),
          pendingCoachRequests: Number(summary.counts?.pending_coach_requests || 0),
          pendingGameReviews: Number(summary.counts?.pending_game_reviews || 0),
          pendingEventReviews: Number(summary.counts?.pending_event_reviews || 0),
        }))
      );
    } catch (err: unknown) {
      setError(toUserMessage(err, 'Failed to load organization approvals'));
      setEntries([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (authLoading) return;
    void loadData();
  }, [authLoading, loadData]);

  useEffect(() => {
    if (loading || refreshing || error || entries.length !== 1 || hasAutoForwardedRef.current) {
      return;
    }

    hasAutoForwardedRef.current = true;
    // nav-safe: single-org pickers skip straight to that org's request tools;
    // marked as a redirect so returning "back" here can't create a bounce loop.
    replaceAsRedirect(router, buildOrganizationRequestsRoute(entries[0].id));
  }, [entries, error, loading, refreshing, router]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void loadData();
  }, [loadData]);

  if (authLoading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={theme.tint} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        <View style={styles.header}>
          <Pressable onPress={() => safeGoBack(router, '/organization?tab=requests')} hitSlop={12}>
            <MaterialIcons name="arrow-back" size={24} color={theme.text} />
          </Pressable>
          <Text style={[styles.headerTitle, { color: theme.text }]}>Approvals</Text>
          <View style={{ width: 24 }} />
        </View>

        <View style={[styles.heroCard, { backgroundColor: theme.card, borderColor: theme.border }]}>
          <Text style={[styles.heroTitle, { color: theme.text }]}>Organization Requests</Text>
          <Text style={[styles.heroBody, { color: theme.mutedText }]}>
            Coach approvals and org moderation now live inside Organization Tools. This screen is
            just the org picker.
          </Text>
        </View>

        {loading ? (
          <View style={styles.centered}>
            <ActivityIndicator size="large" color={theme.tint} />
          </View>
        ) : error ? (
          <View style={styles.centered}>
            <Text style={[styles.errorText, { color: theme.text }]}>{error}</Text>
          </View>
        ) : entries.length === 0 ? (
          <View style={styles.centered}>
            <Text style={[styles.emptyTitle, { color: theme.text }]}>
              No organization admin access
            </Text>
            <Text style={[styles.heroBody, { color: theme.mutedText }]}>
              You do not currently own or manage any organization with review tools.
            </Text>
          </View>
        ) : (
          entries.map(entry => {
            const total =
              entry.pendingCoachRequests + entry.pendingGameReviews + entry.pendingEventReviews;
            return (
              <Pressable
                key={entry.id}
                onPress={() => router.push(buildOrganizationRequestsRoute(entry.id))}
                style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}
              >
                <View style={{ flex: 1, gap: 6 }}>
                  <Text style={[styles.cardTitle, { color: theme.text }]}>{entry.name}</Text>
                  <Text style={[styles.cardMeta, { color: theme.mutedText }]}>
                    {entry.pendingCoachRequests} coach requests | {entry.pendingGameReviews} game
                    reviews | {entry.pendingEventReviews} event reviews
                  </Text>
                </View>
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{total}</Text>
                </View>
              </Pressable>
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 16, gap: 16 },
  centered: { alignItems: 'center', justifyContent: 'center', paddingVertical: 48, gap: 10 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  headerTitle: { fontSize: 20, fontWeight: '700' },
  heroCard: { borderWidth: 1, borderRadius: 8, padding: 16, gap: 8 },
  heroTitle: { fontSize: 18, fontWeight: '700' },
  heroBody: { fontSize: 14, lineHeight: 20 },
  card: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  cardTitle: { fontSize: 16, fontWeight: '700' },
  cardMeta: { fontSize: 13, lineHeight: 18 },
  badge: {
    minWidth: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#2563EB',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  badgeText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  emptyTitle: { fontSize: 18, fontWeight: '700' },
  errorText: { fontSize: 16, fontWeight: '600', textAlign: 'center' },
});
