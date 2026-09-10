import { AdminAccessState } from '@/components/AdminAccessState';
import { Colors } from '@/constants/Colors';
import { useColorScheme } from '@/hooks/useColorScheme';
import { useRequireAdmin } from '@/hooks/useRequireAdmin';
import { safeGoBack } from '@/utils/navigation';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
// @ts-ignore
import { Organization } from '@/api/entities';
import { captureBreadcrumb } from '@/utils/sentry';
import { isSessionExpiryError } from '@/utils/sessionExpiryError';
import { toUserMessage } from '@/utils/toUserMessage';

interface PendingLeague {
  id: string;
  name: string;
  sport?: string | null;
  description?: string | null;
  created_at: string;
  logo_url?: string | null;
  supporting_document_url?: string | null;
  leagueOwner?: { id: string; display_name: string; email: string } | null;
  _count?: { teams: number; memberships: number };
}

interface PendingCoach {
  id: string;
  display_name?: string | null;
  email: string;
  username?: string | null;
  avatar_url?: string | null;
  created_at: string;
  preferences?: any;
  coach_application?: {
    id: string;
    status: string;
    organization_name?: string | null;
    org_type?: string | null;
    location?: string | null;
    zip_code?: string | null;
    supporting_document_url?: string | null;
    background_url?: string | null;
    payload?: Record<string, unknown> | null;
  } | null;
}

interface DashboardStats {
  totalUsers: number;
  verifiedUsers: number;
  bannedUsers: number;
  totalTeams: number;
  totalAds: number;
  pendingAds: number;
  pendingLeagues: PendingLeague[];
  pendingCoaches: PendingCoach[];
  totalPosts: number;
  totalMessages: number;
  recentActivity: Array<{
    id: string;
    action: string;
    description: string;
    timestamp: string;
  }>;
}

function AdminDashboardScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const theme = Colors[colorScheme];
  const router = useRouter();
  const params = useLocalSearchParams<{
    coach_id?: string;
    league_id?: string;
    action?: 'approve' | 'reject';
    review?: string;
  }>();
  const { isAdmin, loading: adminLoading } = useRequireAdmin();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [reportSpike, setReportSpike] = useState<{
    isSpike: boolean;
    pendingCount: number;
    recentCount: number;
  } | null>(null);
  const [leagueActionId, setLeagueActionId] = useState<string | null>(null);

  // Cross-platform modal for league approve/reject (Alert.prompt is iOS-only)
  const [leagueModal, setLeagueModal] = useState<{
    league: PendingLeague;
    action: 'approve' | 'reject';
  } | null>(null);
  const [leagueNote, setLeagueNote] = useState('');

  // Coach approval modal state
  const [coachModal, setCoachModal] = useState<{
    coach: PendingCoach;
    action: 'approve' | 'reject';
  } | null>(null);
  const [coachNote, setCoachNote] = useState('');
  const [coachActionId, setCoachActionId] = useState<string | null>(null);
  // Tracks which deep-link signature we've already handled. Using a
  // signature instead of a boolean lets a *second* approval email opened
  // in the same app session (different coach/league/action) re-fire the
  // modal — the previous boolean-only ref made every link after the first
  // a silent no-op.
  const lastHandledLinkRef = useRef<string | null>(null);

  // Detail view modals
  const [coachDetailModal, setCoachDetailModal] = useState<PendingCoach | null>(null);
  const [leagueDetailModal, setLeagueDetailModal] = useState<PendingLeague | null>(null);

  const formatAdminActionError = (err: any, fallback: string) => {
    return toUserMessage(err, fallback);
  };

  const handleApproveCoach = (coach: PendingCoach) => {
    setCoachNote('');
    setCoachModal({ coach, action: 'approve' });
  };

  const handleRejectCoach = (coach: PendingCoach) => {
    setCoachNote('');
    setCoachModal({ coach, action: 'reject' });
  };

  const confirmCoachAction = async () => {
    if (!coachModal) return;
    const { coach, action } = coachModal;
    setCoachModal(null);
    setCoachActionId(coach.id);
    captureBreadcrumb('Admin coach approval action started', 'admin.approval', {
      action,
      actor: 'admin_dashboard',
      coach_id: coach.id,
      has_note: coachNote.trim().length > 0,
    });
    try {
      const { httpPost } = await import('@/api/http');
      await httpPost(`/admin/coaches/${coach.id}/${action}`, {
        note: coachNote.trim() || undefined,
      });
      captureBreadcrumb('Admin coach approval action succeeded', 'admin.approval', {
        action,
        actor: 'admin_dashboard',
        coach_id: coach.id,
      });
      Alert.alert(
        'Success',
        `Coach "${coach.display_name || coach.username || coach.email}" has been ${action === 'approve' ? 'approved' : 'rejected'}.`
      );
      void loadStats(true);
    } catch (e: any) {
      if (isSessionExpiryError(e)) {
        return;
      }
      captureBreadcrumb(
        'Admin coach approval action failed',
        'admin.approval',
        {
          action,
          actor: 'admin_dashboard',
          coach_id: coach.id,
          error: e?.message || 'unknown_error',
        },
        'error'
      );
      const detail = formatAdminActionError(e, `Failed to ${action} coach`);
      Alert.alert('Error', detail);
    } finally {
      setCoachActionId(null);
    }
  };

  const handleApproveLeague = (league: PendingLeague) => {
    setLeagueNote('');
    setLeagueModal({ league, action: 'approve' });
  };

  const handleRejectLeague = (league: PendingLeague) => {
    setLeagueNote('');
    setLeagueModal({ league, action: 'reject' });
  };

  const confirmLeagueAction = async () => {
    if (!leagueModal) return;
    const { league, action } = leagueModal;
    setLeagueModal(null);
    setLeagueActionId(league.id);
    captureBreadcrumb('Admin league approval action started', 'admin.approval', {
      action,
      actor: 'admin_dashboard',
      league_id: league.id,
      has_note: leagueNote.trim().length > 0,
    });
    try {
      if (action === 'approve') {
        await Organization.approveLeague(league.id, leagueNote.trim() || undefined);
        Alert.alert('Success', `"${league.name}" has been approved.`);
      } else {
        await Organization.rejectLeague(league.id, leagueNote.trim() || undefined);
        Alert.alert('Success', `"${league.name}" has been rejected.`);
      }
      captureBreadcrumb('Admin league approval action succeeded', 'admin.approval', {
        action,
        actor: 'admin_dashboard',
        league_id: league.id,
      });
      void loadStats(true);
    } catch (e: any) {
      if (isSessionExpiryError(e)) {
        return;
      }
      captureBreadcrumb(
        'Admin league approval action failed',
        'admin.approval',
        {
          action,
          actor: 'admin_dashboard',
          league_id: league.id,
          error: e?.message || 'unknown_error',
        },
        'error'
      );
      const detail = formatAdminActionError(e, `Failed to ${action} league`);
      Alert.alert('Error', detail);
    } finally {
      setLeagueActionId(null);
    }
  };

  const loadStats = useCallback(
    async (showRefreshing = false) => {
      if (!isAdmin) return;
      if (showRefreshing) setRefreshing(true);
      else setLoading(true);
      setError(null);

      try {
        // Use API client instead of direct fetch
        const { httpGet } = await import('@/api/http');
        const [data, spike] = await Promise.all([
          httpGet('/admin/dashboard'),
          httpGet('/admin/report-spike').catch(() => null),
        ]);
        setStats(data);
        setReportSpike(spike);
      } catch (e: any) {
        setError(
          isSessionExpiryError(e)
            ? 'Your admin session expired. Please sign in again.'
            : toUserMessage(e, 'Failed to load dashboard')
        );
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [isAdmin]
  );

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  useEffect(() => {
    if (!stats) return;

    const action = params.action === 'approve' || params.action === 'reject' ? params.action : null;
    const reviewType = String(params.review || '').trim();
    const coachId = String(params.coach_id || '').trim();
    const leagueId = String(params.league_id || '').trim();
    if (reviewType !== 'coach_application' && reviewType !== 'league_approval') return;

    const signature = `${reviewType}|${coachId}|${leagueId}|${action ?? ''}`;
    if (lastHandledLinkRef.current === signature) return;
    lastHandledLinkRef.current = signature;

    if (reviewType === 'coach_application') {
      if (!coachId) return;
      const matchedCoach = stats.pendingCoaches.find(coach => coach.id === coachId);
      if (!matchedCoach) return;
      if (action) {
        setCoachNote('');
        setCoachModal({ coach: matchedCoach, action });
        return;
      }
      setCoachDetailModal(matchedCoach);
      return;
    }

    if (!leagueId) return;
    const matchedLeague = stats.pendingLeagues.find(league => league.id === leagueId);
    if (!matchedLeague) return;
    if (action) {
      setLeagueNote('');
      setLeagueModal({ league: matchedLeague, action });
      return;
    }
    setLeagueDetailModal(matchedLeague);
  }, [params.action, params.coach_id, params.league_id, params.review, stats]);

  const onRefresh = () => {
    void loadStats(true);
  };

  const StatCard = ({ title, value, subtitle, icon, color, onPress }: any) => (
    <Pressable
      style={[
        styles.statCard,
        {
          backgroundColor: theme.card,
          borderColor: theme.border,
        },
      ]}
      onPress={onPress}
      android_ripple={{ color: theme.border }}
    >
      <View style={[styles.statIcon, { backgroundColor: color + '20' }]}>
        <MaterialIcons name={icon} size={24} color={color} />
      </View>
      <View style={styles.statContent}>
        <Text style={[styles.statValue, { color: theme.text }]}>{value.toLocaleString()}</Text>
        <Text style={[styles.statTitle, { color: theme.mutedText }]}>{title}</Text>
        {subtitle && (
          <Text style={[styles.statSubtitle, { color: theme.mutedText }]}>{subtitle}</Text>
        )}
      </View>
      <MaterialIcons name="chevron-right" size={20} color={theme.mutedText} />
    </Pressable>
  );

  const ActivityItem = ({ item }: any) => (
    <View
      style={[
        styles.activityItem,
        {
          backgroundColor: theme.surface,
          borderColor: theme.border,
        },
      ]}
    >
      <View style={styles.activityDot} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.activityAction, { color: theme.text }]}>{item.action}</Text>
        <Text style={[styles.activityDesc, { color: theme.mutedText }]}>{item.description}</Text>
        <Text style={[styles.activityTime, { color: theme.mutedText }]}>
          {new Date(item.timestamp).toLocaleString()}
        </Text>
      </View>
    </View>
  );

  if (adminLoading) return <AdminAccessState colorScheme={colorScheme} state="loading" />;
  if (!isAdmin) return <AdminAccessState colorScheme={colorScheme} state="denied" />;

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: Colors[colorScheme].background }]}
      edges={['top']}
    >
      <Stack.Screen
        options={{
          title: 'Admin Dashboard',
          headerShown: true,
          headerStyle: { backgroundColor: theme.card },
          headerTintColor: theme.text,
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

      {loading && !refreshing ? (
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color={Colors[colorScheme].tint} />
        </View>
      ) : error ? (
        <View style={styles.centerContainer}>
          <MaterialIcons
            name="warning-amber"
            size={48}
            color={colorScheme === 'dark' ? '#FCA5A5' : '#DC2626'}
          />
          <Text
            style={[styles.errorText, { color: colorScheme === 'dark' ? '#FCA5A5' : '#DC2626' }]}
          >
            {error}
          </Text>
          <Pressable
            style={[styles.retryButton, { backgroundColor: Colors[colorScheme].tint }]}
            onPress={() => {
              void loadStats();
            }}
          >
            <Text style={styles.retryButtonText}>Retry</Text>
          </Pressable>
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={Colors[colorScheme].tint}
            />
          }
        >
          {/* Header */}
          <View style={styles.header}>
            <View>
              <Text style={[styles.headerTitle, { color: theme.text }]}>🛡️ Admin Dashboard</Text>
              <Text style={[styles.headerSubtitle, { color: theme.mutedText }]}>
                Platform overview and moderation tools
              </Text>
            </View>
            <MaterialIcons name="refresh" size={24} color={theme.mutedText} />
          </View>

          {/* Report Spike Alert */}
          {reportSpike?.isSpike && (
            <Pressable
              style={[
                styles.spikeAlert,
                {
                  backgroundColor: colorScheme === 'dark' ? '#3B0A0A' : '#FEE2E2',
                  borderColor: colorScheme === 'dark' ? '#7F1D1D' : '#FCA5A5',
                },
              ]}
              onPress={() => void router.push('/admin-reports')}
            >
              <MaterialIcons
                name="warning"
                size={24}
                color={colorScheme === 'dark' ? '#FCA5A5' : '#DC2626'}
              />
              <View style={{ flex: 1, marginLeft: 12 }}>
                <Text
                  style={{
                    fontWeight: '800',
                    color: colorScheme === 'dark' ? '#FECACA' : '#991B1B',
                    fontSize: 14,
                  }}
                >
                  Report Spike Detected
                </Text>
                <Text
                  style={{
                    color: colorScheme === 'dark' ? '#FCA5A5' : '#B91C1C',
                    fontSize: 12,
                    marginTop: 2,
                  }}
                >
                  {reportSpike.pendingCount} pending reports ({reportSpike.recentCount} recent). Tap
                  to review.
                </Text>
              </View>
              <MaterialIcons
                name="chevron-right"
                size={20}
                color={colorScheme === 'dark' ? '#FCA5A5' : '#DC2626'}
              />
            </Pressable>
          )}

          {/* Pending Leagues */}
          {stats?.pendingLeagues && stats.pendingLeagues.length > 0 && (
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text style={[styles.sectionTitle, { color: theme.text }]}>
                  Pending Leagues ({stats.pendingLeagues.length})
                </Text>
              </View>
              {stats.pendingLeagues.map(league => {
                const isActioning = leagueActionId === league.id;
                return (
                  <Pressable
                    key={league.id}
                    style={[
                      styles.statCard,
                      {
                        backgroundColor: theme.card,
                        borderColor: '#F59E0B',
                      },
                    ]}
                    onPress={() => setLeagueDetailModal(league)}
                  >
                    <View style={[styles.statIcon, { backgroundColor: '#F59E0B20' }]}>
                      <MaterialIcons name="business" size={24} color="#F59E0B" />
                    </View>
                    <View style={styles.statContent}>
                      <Text style={[styles.statValue, { fontSize: 16, color: theme.text }]}>
                        {league.name}
                      </Text>
                      {league.sport && (
                        <Text style={[styles.statTitle, { color: theme.mutedText }]}>
                          {league.sport}
                        </Text>
                      )}
                      <Text style={[styles.statSubtitle, { color: theme.mutedText }]}>
                        {league.leagueOwner?.display_name || 'Unknown'} ·{' '}
                        {league.leagueOwner?.email || ''}
                      </Text>
                      <Text style={[styles.statSubtitle, { color: theme.mutedText }]}>
                        {new Date(league.created_at).toLocaleDateString()}
                        {league._count
                          ? ` · ${league._count.teams} team${league._count.teams !== 1 ? 's' : ''}`
                          : ''}
                      </Text>
                      <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                        <Pressable
                          style={[
                            styles.leagueBtn,
                            { backgroundColor: '#16A34A', opacity: isActioning ? 0.6 : 1 },
                          ]}
                          onPress={e => {
                            e.stopPropagation?.();
                            handleApproveLeague(league);
                          }}
                          disabled={isActioning}
                        >
                          {isActioning ? (
                            <ActivityIndicator size="small" color="#fff" />
                          ) : (
                            <>
                              <MaterialIcons name="check" size={16} color="#fff" />
                              <Text style={styles.leagueBtnText}>Approve</Text>
                            </>
                          )}
                        </Pressable>
                        <Pressable
                          style={[
                            styles.leagueBtn,
                            { backgroundColor: '#DC2626', opacity: isActioning ? 0.6 : 1 },
                          ]}
                          onPress={e => {
                            e.stopPropagation?.();
                            handleRejectLeague(league);
                          }}
                          disabled={isActioning}
                        >
                          <MaterialIcons name="close" size={16} color="#fff" />
                          <Text style={styles.leagueBtnText}>Reject</Text>
                        </Pressable>
                      </View>
                      <Text style={{ color: theme.mutedText, fontSize: 11, marginTop: 6 }}>
                        Tap card to view details & document
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          )}

          {/* Pending Coaches */}
          {stats?.pendingCoaches && stats.pendingCoaches.length > 0 && (
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text style={[styles.sectionTitle, { color: theme.text }]}>
                  Pending Coaches ({stats.pendingCoaches.length})
                </Text>
              </View>
              {stats.pendingLeagues && stats.pendingLeagues.length > 0 && (
                <Text
                  style={{
                    color: theme.mutedText,
                    fontSize: 13,
                    paddingHorizontal: 16,
                    paddingBottom: 8,
                    fontStyle: 'italic',
                  }}
                >
                  Approve the coach's league first, then approve the coach.
                </Text>
              )}
              {stats.pendingCoaches.map(coach => {
                const isActioning = coachActionId === coach.id;
                return (
                  <Pressable
                    key={coach.id}
                    style={[
                      styles.statCard,
                      {
                        backgroundColor: theme.card,
                        borderColor: '#3B82F6',
                      },
                    ]}
                    onPress={() => setCoachDetailModal(coach)}
                  >
                    <View style={[styles.statIcon, { backgroundColor: '#3B82F620' }]}>
                      <MaterialIcons name="person" size={24} color="#3B82F6" />
                    </View>
                    <View style={styles.statContent}>
                      <Text style={[styles.statValue, { fontSize: 16, color: theme.text }]}>
                        {coach.display_name || coach.username || 'Unknown Coach'}
                      </Text>
                      <Text style={[styles.statTitle, { color: theme.mutedText }]}>
                        {coach.email}
                      </Text>
                      <Text style={[styles.statSubtitle, { color: theme.mutedText }]}>
                        Applied {new Date(coach.created_at).toLocaleDateString()}
                      </Text>
                      {coach.coach_application?.organization_name ? (
                        <Text style={[styles.statSubtitle, { color: theme.mutedText }]}>
                          Application: {coach.coach_application.organization_name}
                        </Text>
                      ) : null}
                      <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                        <Pressable
                          style={[
                            styles.leagueBtn,
                            { backgroundColor: '#16A34A', opacity: isActioning ? 0.6 : 1 },
                          ]}
                          onPress={e => {
                            e.stopPropagation?.();
                            handleApproveCoach(coach);
                          }}
                          disabled={isActioning}
                        >
                          {isActioning ? (
                            <ActivityIndicator size="small" color="#fff" />
                          ) : (
                            <>
                              <MaterialIcons name="check" size={16} color="#fff" />
                              <Text style={styles.leagueBtnText}>Approve</Text>
                            </>
                          )}
                        </Pressable>
                        <Pressable
                          style={[
                            styles.leagueBtn,
                            { backgroundColor: '#DC2626', opacity: isActioning ? 0.6 : 1 },
                          ]}
                          onPress={e => {
                            e.stopPropagation?.();
                            handleRejectCoach(coach);
                          }}
                          disabled={isActioning}
                        >
                          <MaterialIcons name="close" size={16} color="#fff" />
                          <Text style={styles.leagueBtnText}>Reject</Text>
                        </Pressable>
                      </View>
                      <Text style={{ color: theme.mutedText, fontSize: 11, marginTop: 6 }}>
                        Tap card to view full details
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          )}

          {/* Stats Grid */}
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Platform Statistics</Text>

            <StatCard
              title="Total Users"
              value={stats?.totalUsers || 0}
              subtitle={`${stats?.verifiedUsers || 0} verified • ${stats?.bannedUsers || 0} banned`}
              icon="people"
              color="#3B82F6"
              onPress={() => void router.push('/admin-users')}
            />

            <StatCard
              title="Teams"
              value={stats?.totalTeams || 0}
              subtitle="All teams across platform"
              icon="shield"
              color="#10B981"
              onPress={() => void router.push('/admin-teams')}
            />

            <StatCard
              title="Advertisements"
              value={stats?.totalAds || 0}
              subtitle={`${stats?.pendingAds || 0} pending review`}
              icon="megaphone"
              color="#F59E0B"
              onPress={() => void router.push('/admin-ads')}
            />

            <StatCard
              title="Posts"
              value={stats?.totalPosts || 0}
              subtitle="User-generated content"
              icon="document-text"
              color="#8B5CF6"
              onPress={() => void router.push('/admin-reports')}
            />

            <StatCard
              title="Messages"
              value={stats?.totalMessages || 0}
              subtitle="Platform-wide messages"
              icon="chatbubbles"
              color="#EC4899"
              onPress={() => void router.push('/admin-messages')}
            />
          </View>

          {/* Quick Actions */}
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>Quick Actions</Text>

            <View style={styles.actionsGrid}>
              <Pressable
                style={[
                  styles.actionButton,
                  {
                    backgroundColor: theme.card,
                    borderColor: theme.border,
                  },
                ]}
                onPress={() => void router.push('/admin-users')}
              >
                <MaterialIcons name="group" size={28} color="#3B82F6" />
                <Text style={[styles.actionText, { color: theme.text }]}>Manage Users</Text>
              </Pressable>

              <Pressable
                style={[
                  styles.actionButton,
                  {
                    backgroundColor: theme.card,
                    borderColor: theme.border,
                  },
                ]}
                onPress={() => void router.push('/admin-teams')}
              >
                <MaterialIcons name="shield" size={28} color="#10B981" />
                <Text style={[styles.actionText, { color: theme.text }]}>Manage Teams</Text>
              </Pressable>

              <Pressable
                style={[
                  styles.actionButton,
                  {
                    backgroundColor: theme.card,
                    borderColor: theme.border,
                  },
                ]}
                onPress={() => void router.push('/admin-ads')}
              >
                <MaterialIcons name="campaign" size={28} color="#F59E0B" />
                <Text style={[styles.actionText, { color: theme.text }]}>Review Ads</Text>
              </Pressable>

              <Pressable
                style={[
                  styles.actionButton,
                  {
                    backgroundColor: theme.card,
                    borderColor: theme.border,
                  },
                ]}
                onPress={() => void router.push('/admin-reports')}
              >
                <MaterialIcons name="error" size={28} color="#EF4444" />
                <Text style={[styles.actionText, { color: theme.text }]}>Abuse Reports</Text>
              </Pressable>

              <Pressable
                style={[
                  styles.actionButton,
                  {
                    backgroundColor: theme.card,
                    borderColor: theme.border,
                  },
                ]}
                onPress={() => void router.push('/admin-activity-log')}
              >
                <MaterialIcons name="list" size={28} color="#8B5CF6" />
                <Text style={[styles.actionText, { color: theme.text }]}>Activity Log</Text>
              </Pressable>

              <Pressable
                style={[
                  styles.actionButton,
                  {
                    backgroundColor: theme.card,
                    borderColor: theme.border,
                  },
                ]}
                onPress={() => void router.push('/admin-create-event')}
              >
                <MaterialIcons name="event" size={28} color="#06B6D4" />
                <Text style={[styles.actionText, { color: theme.text }]}>Events</Text>
              </Pressable>

              <Pressable
                style={[
                  styles.actionButton,
                  {
                    backgroundColor: theme.card,
                    borderColor: theme.border,
                  },
                ]}
                onPress={() => void router.push('/admin-transactions' as any)}
              >
                <MaterialIcons name="receipt-long" size={28} color="#059669" />
                <Text style={[styles.actionText, { color: theme.text }]}>Transactions</Text>
              </Pressable>

              <Pressable
                style={[
                  styles.actionButton,
                  {
                    backgroundColor: theme.card,
                    borderColor: theme.border,
                  },
                ]}
                onPress={() => void router.push('/admin-metrics' as any)}
              >
                <MaterialIcons name="trending-up" size={28} color="#7C3AED" />
                <Text style={[styles.actionText, { color: theme.text }]}>Metrics</Text>
              </Pressable>

              <Pressable
                style={[
                  styles.actionButton,
                  {
                    backgroundColor: theme.card,
                    borderColor: theme.border,
                  },
                ]}
                onPress={() => void router.push('/manage-users' as any)}
              >
                <MaterialIcons name="manage-accounts" size={28} color="#0EA5E9" />
                <Text style={[styles.actionText, { color: theme.text }]}>Manage Users</Text>
              </Pressable>
            </View>
          </View>

          {/* Recent Activity */}
          {stats?.recentActivity && stats.recentActivity.length > 0 && (
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text style={[styles.sectionTitle, { color: theme.text }]}>Recent Activity</Text>
                <Pressable onPress={() => void router.push('/admin-activity-log')}>
                  <Text style={[styles.viewAll, { color: Colors[colorScheme].tint }]}>
                    View All
                  </Text>
                </Pressable>
              </View>

              {stats.recentActivity.slice(0, 5).map(item => (
                <ActivityItem key={item.id} item={item} />
              ))}
            </View>
          )}
        </ScrollView>
      )}
      {/* League Approve/Reject Modal */}
      <Modal visible={!!leagueModal} transparent animationType="slide">
        <View
          style={{
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            backgroundColor: 'rgba(0,0,0,0.5)',
            padding: 24,
          }}
        >
          <View
            style={{
              backgroundColor: theme.card,
              borderRadius: 16,
              padding: 20,
              width: '100%',
              maxWidth: 400,
            }}
          >
            <Text style={{ fontSize: 18, fontWeight: '800', color: theme.text, marginBottom: 8 }}>
              {leagueModal?.action === 'approve' ? 'Approve League' : 'Reject League'}
            </Text>
            <Text style={{ color: theme.mutedText, marginBottom: 12 }}>
              {leagueModal?.action === 'approve'
                ? `Approve "${leagueModal?.league.name}"? Add an optional note:`
                : `Reject "${leagueModal?.league.name}"? Enter a reason (optional):`}
            </Text>
            <TextInput
              style={{
                borderWidth: 1,
                borderColor: theme.border,
                borderRadius: 8,
                padding: 10,
                color: theme.text,
                backgroundColor: theme.surface,
                minHeight: 60,
                textAlignVertical: 'top',
              }}
              value={leagueNote}
              onChangeText={setLeagueNote}
              placeholder={
                leagueModal?.action === 'approve' ? 'Note (optional)...' : 'Reason (optional)...'
              }
              placeholderTextColor={theme.mutedText}
              multiline
            />
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 16 }}>
              <Pressable
                style={{
                  flex: 1,
                  paddingVertical: 10,
                  borderRadius: 8,
                  backgroundColor: theme.border,
                  alignItems: 'center',
                }}
                onPress={() => setLeagueModal(null)}
              >
                <Text style={{ color: theme.text, fontWeight: '700' }}>Cancel</Text>
              </Pressable>
              <Pressable
                style={{
                  flex: 1,
                  paddingVertical: 10,
                  borderRadius: 8,
                  backgroundColor: leagueModal?.action === 'approve' ? '#22c55e' : '#dc2626',
                  alignItems: 'center',
                }}
                onPress={confirmLeagueAction}
              >
                <Text style={{ color: 'white', fontWeight: '700' }}>
                  {leagueModal?.action === 'approve' ? 'Approve' : 'Reject'}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
      {/* Coach Approve/Reject Modal */}
      <Modal visible={!!coachModal} transparent animationType="slide">
        <View
          style={{
            flex: 1,
            justifyContent: 'center',
            alignItems: 'center',
            backgroundColor: 'rgba(0,0,0,0.5)',
            padding: 24,
          }}
        >
          <View
            style={{
              backgroundColor: theme.card,
              borderRadius: 16,
              padding: 20,
              width: '100%',
              maxWidth: 400,
            }}
          >
            <Text style={{ fontSize: 18, fontWeight: '800', color: theme.text, marginBottom: 8 }}>
              {coachModal?.action === 'approve' ? 'Approve Coach' : 'Reject Coach'}
            </Text>
            <Text style={{ color: theme.mutedText, marginBottom: 12 }}>
              {coachModal?.action === 'approve'
                ? `Approve "${coachModal?.coach.display_name || coachModal?.coach.username || coachModal?.coach.email}"? Add an optional note:`
                : `Reject "${coachModal?.coach.display_name || coachModal?.coach.username || coachModal?.coach.email}"? A reason is required:`}
            </Text>
            <TextInput
              style={{
                borderWidth: 1,
                borderColor: theme.border,
                borderRadius: 8,
                padding: 10,
                color: theme.text,
                backgroundColor: theme.surface,
                minHeight: 60,
                textAlignVertical: 'top',
              }}
              value={coachNote}
              onChangeText={setCoachNote}
              placeholder={
                coachModal?.action === 'approve' ? 'Note (optional)...' : 'Reason (required)...'
              }
              placeholderTextColor={theme.mutedText}
              multiline
            />
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 16 }}>
              <Pressable
                style={{
                  flex: 1,
                  paddingVertical: 10,
                  borderRadius: 8,
                  backgroundColor: theme.border,
                  alignItems: 'center',
                }}
                onPress={() => setCoachModal(null)}
              >
                <Text style={{ color: theme.text, fontWeight: '700' }}>Cancel</Text>
              </Pressable>
              <Pressable
                style={{
                  flex: 1,
                  paddingVertical: 10,
                  borderRadius: 8,
                  backgroundColor:
                    coachModal?.action === 'approve'
                      ? '#22c55e'
                      : coachNote.trim()
                        ? '#dc2626'
                        : '#9CA3AF',
                  alignItems: 'center',
                }}
                disabled={coachModal?.action === 'reject' && !coachNote.trim()}
                onPress={confirmCoachAction}
              >
                <Text style={{ color: 'white', fontWeight: '700' }}>
                  {coachModal?.action === 'approve' ? 'Approve' : 'Reject'}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Coach Detail Modal */}
      <Modal visible={!!coachDetailModal} transparent animationType="slide">
        <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' }}>
          <View
            style={{
              backgroundColor: theme.card,
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              padding: 24,
              paddingBottom: 40,
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 16,
              }}
            >
              <Text style={{ fontSize: 20, fontWeight: '800', color: theme.text }}>
                Coach Application
              </Text>
              <Pressable onPress={() => setCoachDetailModal(null)}>
                <MaterialIcons name="close" size={24} color={theme.mutedText} />
              </Pressable>
            </View>
            {coachDetailModal && (
              <>
                <View style={{ gap: 10, marginBottom: 20 }}>
                  <View style={{ flexDirection: 'row', gap: 6 }}>
                    <Text style={{ fontWeight: '700', color: theme.mutedText, width: 80 }}>
                      Name:
                    </Text>
                    <Text style={{ color: theme.text, flex: 1 }}>
                      {coachDetailModal.display_name || coachDetailModal.username || '—'}
                    </Text>
                  </View>
                  <View style={{ flexDirection: 'row', gap: 6 }}>
                    <Text style={{ fontWeight: '700', color: theme.mutedText, width: 80 }}>
                      Email:
                    </Text>
                    <Text style={{ color: theme.text, flex: 1 }}>{coachDetailModal.email}</Text>
                  </View>
                  <View style={{ flexDirection: 'row', gap: 6 }}>
                    <Text style={{ fontWeight: '700', color: theme.mutedText, width: 80 }}>
                      Applied:
                    </Text>
                    <Text style={{ color: theme.text, flex: 1 }}>
                      {new Date(coachDetailModal.created_at).toLocaleString()}
                    </Text>
                  </View>
                  {coachDetailModal.coach_application?.organization_name && (
                    <View style={{ flexDirection: 'row', gap: 6 }}>
                      <Text style={{ fontWeight: '700', color: theme.mutedText, width: 80 }}>
                        Request:
                      </Text>
                      <Text style={{ color: theme.text, flex: 1 }}>
                        {coachDetailModal.coach_application.organization_name}
                      </Text>
                    </View>
                  )}
                  {coachDetailModal.coach_application?.org_type && (
                    <View style={{ flexDirection: 'row', gap: 6 }}>
                      <Text style={{ fontWeight: '700', color: theme.mutedText, width: 80 }}>
                        Type:
                      </Text>
                      <Text style={{ color: theme.text, flex: 1, textTransform: 'capitalize' }}>
                        {coachDetailModal.coach_application.org_type}
                      </Text>
                    </View>
                  )}
                  {coachDetailModal.coach_application?.location && (
                    <View style={{ flexDirection: 'row', gap: 6 }}>
                      <Text style={{ fontWeight: '700', color: theme.mutedText, width: 80 }}>
                        Location:
                      </Text>
                      <Text style={{ color: theme.text, flex: 1 }}>
                        {coachDetailModal.coach_application.location}
                      </Text>
                    </View>
                  )}
                  {coachDetailModal.preferences?.plan && (
                    <View style={{ flexDirection: 'row', gap: 6 }}>
                      <Text style={{ fontWeight: '700', color: theme.mutedText, width: 80 }}>
                        Plan:
                      </Text>
                      <Text style={{ color: theme.text, flex: 1, textTransform: 'capitalize' }}>
                        {coachDetailModal.preferences.plan}
                      </Text>
                    </View>
                  )}
                  {coachDetailModal.coach_application?.supporting_document_url && (
                    <Pressable
                      style={{
                        backgroundColor: colorScheme === 'dark' ? '#1B3A6B' : '#EFF6FF',
                        borderRadius: 8,
                        padding: 10,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 8,
                        marginTop: 4,
                      }}
                      onPress={() =>
                        Linking.openURL(
                          coachDetailModal.coach_application!.supporting_document_url!
                        ).catch(() => Alert.alert('Error', 'Could not open document.'))
                      }
                    >
                      <MaterialIcons
                        name="description"
                        size={20}
                        color={colorScheme === 'dark' ? '#60A5FA' : '#2563EB'}
                      />
                      <Text
                        style={{
                          color: colorScheme === 'dark' ? '#60A5FA' : '#2563EB',
                          fontWeight: '700',
                          flex: 1,
                        }}
                      >
                        View Supporting Document
                      </Text>
                      <MaterialIcons
                        name="open-in-new"
                        size={16}
                        color={colorScheme === 'dark' ? '#60A5FA' : '#2563EB'}
                      />
                    </Pressable>
                  )}
                  {coachDetailModal.coach_application?.background_url && (
                    <Pressable
                      style={{
                        backgroundColor: colorScheme === 'dark' ? '#1B3A6B' : '#EFF6FF',
                        borderRadius: 8,
                        padding: 10,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 8,
                      }}
                      onPress={() =>
                        Linking.openURL(coachDetailModal.coach_application!.background_url!).catch(
                          () => Alert.alert('Error', 'Could not open image.')
                        )
                      }
                    >
                      <MaterialIcons
                        name="image"
                        size={20}
                        color={colorScheme === 'dark' ? '#60A5FA' : '#2563EB'}
                      />
                      <Text
                        style={{
                          color: colorScheme === 'dark' ? '#60A5FA' : '#2563EB',
                          fontWeight: '700',
                          flex: 1,
                        }}
                      >
                        View Submitted Background
                      </Text>
                      <MaterialIcons
                        name="open-in-new"
                        size={16}
                        color={colorScheme === 'dark' ? '#60A5FA' : '#2563EB'}
                      />
                    </Pressable>
                  )}
                </View>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Pressable
                    style={{
                      flex: 1,
                      paddingVertical: 10,
                      borderRadius: 8,
                      backgroundColor: '#16A34A',
                      alignItems: 'center',
                    }}
                    onPress={() => {
                      setCoachDetailModal(null);
                      handleApproveCoach(coachDetailModal);
                    }}
                  >
                    <Text style={{ color: 'white', fontWeight: '700' }}>Approve</Text>
                  </Pressable>
                  <Pressable
                    style={{
                      flex: 1,
                      paddingVertical: 10,
                      borderRadius: 8,
                      backgroundColor: '#DC2626',
                      alignItems: 'center',
                    }}
                    onPress={() => {
                      setCoachDetailModal(null);
                      handleRejectCoach(coachDetailModal);
                    }}
                  >
                    <Text style={{ color: 'white', fontWeight: '700' }}>Reject</Text>
                  </Pressable>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* League Detail Modal */}
      <Modal visible={!!leagueDetailModal} transparent animationType="slide">
        <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.5)' }}>
          <View
            style={{
              backgroundColor: theme.card,
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              padding: 24,
              paddingBottom: 40,
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 16,
              }}
            >
              <Text style={{ fontSize: 20, fontWeight: '800', color: theme.text }}>
                League Application
              </Text>
              <Pressable onPress={() => setLeagueDetailModal(null)}>
                <MaterialIcons name="close" size={24} color={theme.mutedText} />
              </Pressable>
            </View>
            {leagueDetailModal && (
              <>
                <View style={{ gap: 10, marginBottom: 20 }}>
                  <View style={{ flexDirection: 'row', gap: 6 }}>
                    <Text style={{ fontWeight: '700', color: theme.mutedText, width: 80 }}>
                      Name:
                    </Text>
                    <Text style={{ color: theme.text, flex: 1 }}>{leagueDetailModal.name}</Text>
                  </View>
                  {leagueDetailModal.sport && (
                    <View style={{ flexDirection: 'row', gap: 6 }}>
                      <Text style={{ fontWeight: '700', color: theme.mutedText, width: 80 }}>
                        Sport:
                      </Text>
                      <Text style={{ color: theme.text, flex: 1 }}>{leagueDetailModal.sport}</Text>
                    </View>
                  )}
                  {leagueDetailModal.description && (
                    <View style={{ flexDirection: 'row', gap: 6 }}>
                      <Text style={{ fontWeight: '700', color: theme.mutedText, width: 80 }}>
                        Desc:
                      </Text>
                      <Text style={{ color: theme.text, flex: 1 }}>
                        {leagueDetailModal.description}
                      </Text>
                    </View>
                  )}
                  <View style={{ flexDirection: 'row', gap: 6 }}>
                    <Text style={{ fontWeight: '700', color: theme.mutedText, width: 80 }}>
                      Owner:
                    </Text>
                    <Text style={{ color: theme.text, flex: 1 }}>
                      {leagueDetailModal.leagueOwner?.display_name || 'Unknown'} ·{' '}
                      {leagueDetailModal.leagueOwner?.email || ''}
                    </Text>
                  </View>
                  <View style={{ flexDirection: 'row', gap: 6 }}>
                    <Text style={{ fontWeight: '700', color: theme.mutedText, width: 80 }}>
                      Applied:
                    </Text>
                    <Text style={{ color: theme.text, flex: 1 }}>
                      {new Date(leagueDetailModal.created_at).toLocaleString()}
                    </Text>
                  </View>
                  {leagueDetailModal.supporting_document_url && (
                    <Pressable
                      style={{
                        backgroundColor: colorScheme === 'dark' ? '#1B3A6B' : '#EFF6FF',
                        borderRadius: 8,
                        padding: 10,
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: 8,
                        marginTop: 4,
                      }}
                      onPress={() =>
                        Linking.openURL(leagueDetailModal.supporting_document_url!).catch(() =>
                          Alert.alert('Error', 'Could not open document.')
                        )
                      }
                    >
                      <MaterialIcons
                        name="description"
                        size={20}
                        color={colorScheme === 'dark' ? '#60A5FA' : '#2563EB'}
                      />
                      <Text
                        style={{
                          color: colorScheme === 'dark' ? '#60A5FA' : '#2563EB',
                          fontWeight: '700',
                          flex: 1,
                        }}
                      >
                        View Supporting Document
                      </Text>
                      <MaterialIcons
                        name="open-in-new"
                        size={16}
                        color={colorScheme === 'dark' ? '#60A5FA' : '#2563EB'}
                      />
                    </Pressable>
                  )}
                </View>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <Pressable
                    style={{
                      flex: 1,
                      paddingVertical: 10,
                      borderRadius: 8,
                      backgroundColor: '#16A34A',
                      alignItems: 'center',
                    }}
                    onPress={() => {
                      setLeagueDetailModal(null);
                      handleApproveLeague(leagueDetailModal);
                    }}
                  >
                    <Text style={{ color: 'white', fontWeight: '700' }}>Approve</Text>
                  </Pressable>
                  <Pressable
                    style={{
                      flex: 1,
                      paddingVertical: 10,
                      borderRadius: 8,
                      backgroundColor: '#DC2626',
                      alignItems: 'center',
                    }}
                    onPress={() => {
                      setLeagueDetailModal(null);
                      handleRejectLeague(leagueDetailModal);
                    }}
                  >
                    <Text style={{ color: 'white', fontWeight: '700' }}>Reject</Text>
                  </Pressable>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 32,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 24,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '800',
    marginBottom: 4,
  },
  headerSubtitle: {
    fontSize: 14,
  },
  section: {
    marginBottom: 24,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 12,
  },
  viewAll: {
    fontSize: 14,
    fontWeight: '600',
  },
  statCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 12,
  },
  statIcon: {
    width: 48,
    height: 48,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  statContent: {
    flex: 1,
  },
  statValue: {
    fontSize: 24,
    fontWeight: '800',
  },
  statTitle: {
    fontSize: 14,
    fontWeight: '600',
  },
  statSubtitle: {
    fontSize: 12,
    marginTop: 2,
  },
  actionsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  actionButton: {
    width: '48%',
    aspectRatio: 1,
    borderRadius: 12,
    borderWidth: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 16,
  },
  actionText: {
    fontSize: 14,
    fontWeight: '700',
    marginTop: 8,
    textAlign: 'center',
  },
  activityItem: {
    flexDirection: 'row',
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    marginBottom: 8,
  },
  activityDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#3B82F6',
    marginRight: 12,
    marginTop: 6,
  },
  activityAction: {
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 2,
  },
  activityDesc: {
    fontSize: 13,
    marginBottom: 4,
  },
  activityTime: {
    fontSize: 11,
  },
  spikeAlert: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 16,
  },
  errorText: {
    fontSize: 16,
    fontWeight: '600',
    marginTop: 12,
    textAlign: 'center',
  },
  retryButton: {
    marginTop: 16,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  retryButtonText: {
    color: 'white',
    fontWeight: '700',
    fontSize: 14,
  },
  leagueBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 8,
  },
  leagueBtnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 13,
  },
});

export default AdminDashboardScreen;
