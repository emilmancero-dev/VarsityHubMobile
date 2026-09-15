import { Colors } from '@/constants/Colors';
import { useColorScheme } from '@/hooks/useColorScheme';
import { useRequireAdmin } from '@/hooks/useRequireAdmin';
import { Ionicons } from '@expo/vector-icons';
import { Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { safeGoBack } from '@/utils/navigation';
import { isSessionExpiryError } from '@/utils/sessionExpiryError';
import { toUserMessage } from '@/utils/toUserMessage';

interface AbuseReport {
  id: string;
  reporter_name: string;
  reporter_email: string;
  subject: string;
  message: string;
  status: 'pending' | 'reviewed' | 'resolved' | 'dismissed';
  created_at: string;
  reviewed_at?: string;
  resolution_note?: string;
  reporter: {
    id: string;
    display_name: string;
    email: string;
    avatar_url?: string;
    banned: boolean;
  };
}

function parseReportTarget(subject: string): {
  targetType: string | null;
  targetId: string | null;
} {
  const match = String(subject || '').match(/\[([a-z_]+):([^\]]+)\]/i);
  return {
    targetType: match?.[1] || null,
    targetId: match?.[2] || null,
  };
}

function getReportPreview(report: AbuseReport): string {
  try {
    const parsed = JSON.parse(report.message || '{}');
    if (parsed?.details) return String(parsed.details);
    if (parsed?.context?.business_name) {
      return `Business: ${parsed.context.business_name}`;
    }
    if (parsed?.reason) return String(parsed.reason).replace(/_/g, ' ');
  } catch {
    // fall back to raw message
  }
  return report.message;
}

interface ReportStats {
  pending: number;
  reviewed: number;
  resolved: number;
  dismissed: number;
  total: number;
}

function AdminReportsScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const { isAdmin, loading: adminLoading } = useRequireAdmin();
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reports, setReports] = useState<AbuseReport[]>([]);
  const [stats, setStats] = useState<ReportStats | null>(null);
  const [selectedReports, setSelectedReports] = useState<Set<string>>(new Set());
  const [filterStatus, setFilterStatus] = useState<string>('all');

  const loadReports = useCallback(
    async (showRefreshing = false) => {
      if (!isAdmin) return; // Don't load until admin status confirmed
      if (showRefreshing) setRefreshing(true);
      else setLoading(true);
      setError(null);

      try {
        // Use API client instead of direct fetch
        const { httpGet } = await import('@/api/http');
        const [reportsData, statsData] = await Promise.all([
          httpGet(`/admin/reports?status=${filterStatus}`),
          httpGet('/admin/reports/stats'),
        ]);

        setReports(reportsData.reports || []);
        setStats(statsData);
      } catch (e: any) {
        setError(
          isSessionExpiryError(e)
            ? 'Your admin session expired. Please sign in again.'
            : toUserMessage(e, 'Failed to load reports')
        );
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [filterStatus, isAdmin]
  );

  useEffect(() => {
    void loadReports();
  }, [loadReports]);

  const onRefresh = () => {
    void loadReports(true);
  };

  const toggleSelectReport = (id: string) => {
    const newSelected = new Set(selectedReports);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedReports(newSelected);
  };

  const selectAll = () => {
    setSelectedReports(new Set(reports.map(r => r.id)));
  };

  const deselectAll = () => {
    setSelectedReports(new Set());
  };

  const updateReportStatus = async (reportId: string, status: string, resolutionNote?: string) => {
    try {
      // Use API client instead of direct fetch
      const { httpPatch } = await import('@/api/http');
      await httpPatch(`/admin/reports/${reportId}`, { status, resolution_note: resolutionNote });

      await loadReports(true);
      Alert.alert('Success', 'Report updated successfully');
    } catch (e: any) {
      if (isSessionExpiryError(e)) {
        return;
      }
      Alert.alert('Error', toUserMessage(e, 'Failed to update report'));
    }
  };

  const takeDownAd = async (report: AbuseReport) => {
    try {
      const { httpPost } = await import('@/api/http');
      await httpPost(`/admin/reports/${report.id}/take-down-ad`, {});
      await loadReports(true);
      Alert.alert('Success', 'The ad was taken down and the advertiser was notified.');
    } catch (e: any) {
      if (isSessionExpiryError(e)) {
        return;
      }
      Alert.alert('Error', toUserMessage(e, 'Failed to take down ad'));
    }
  };

  const bulkUpdateStatus = async (status: string) => {
    if (selectedReports.size === 0) {
      Alert.alert('No Reports Selected', 'Please select at least one report');
      return;
    }

    try {
      // Use API client instead of direct fetch
      const { httpPost } = await import('@/api/http');
      const data = await httpPost('/admin/reports/bulk-update', {
        report_ids: Array.from(selectedReports),
        status,
      });
      setSelectedReports(new Set());
      await loadReports(true);
      Alert.alert('Success', `Updated ${data.updated} reports`);
    } catch (e: any) {
      if (isSessionExpiryError(e)) {
        return;
      }
      Alert.alert('Error', toUserMessage(e, 'Failed to update reports'));
    }
  };

  const bulkDelete = async () => {
    if (selectedReports.size === 0) {
      Alert.alert('No Reports Selected', 'Please select at least one report');
      return;
    }

    Alert.alert('Confirm Delete', `Delete ${selectedReports.size} selected report(s)?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          try {
            // Use API client instead of direct fetch
            const { httpPost } = await import('@/api/http');
            const data: any = await httpPost('/admin/reports/bulk-delete', {
              report_ids: Array.from(selectedReports),
            });
            setSelectedReports(new Set());
            await loadReports(true);
            Alert.alert('Success', `Deleted ${data?.deleted ?? selectedReports.size} reports`);
          } catch (e: any) {
            if (isSessionExpiryError(e)) {
              return;
            }
            Alert.alert('Error', toUserMessage(e, 'Failed to delete reports'));
          }
        },
      },
    ]);
  };

  const StatusBadge = ({ status }: { status: string }) => {
    const colors = {
      pending: '#F59E0B',
      reviewed: '#3B82F6',
      resolved: '#10B981',
      dismissed: '#6B7280',
    };

    return (
      <View
        style={[styles.badge, { backgroundColor: colors[status as keyof typeof colors] + '20' }]}
      >
        <Text style={[styles.badgeText, { color: colors[status as keyof typeof colors] }]}>
          {status.charAt(0).toUpperCase() + status.slice(1)}
        </Text>
      </View>
    );
  };

  const ReportCard = ({ report }: { report: AbuseReport }) => {
    const isSelected = selectedReports.has(report.id);
    const { targetType } = parseReportTarget(report.subject);
    const preview = getReportPreview(report);
    const isAdReport = targetType === 'ad';

    return (
      <Pressable
        style={[
          styles.reportCard,
          {
            backgroundColor: colorScheme === 'dark' ? '#1F2937' : 'white',
            borderColor: isSelected ? '#3B82F6' : Colors[colorScheme].border,
            borderWidth: isSelected ? 2 : 1,
          },
        ]}
        onPress={() => toggleSelectReport(report.id)}
      >
        <View style={styles.reportHeader}>
          <View style={styles.reportHeaderLeft}>
            <Ionicons
              name={isSelected ? 'checkbox' : 'square-outline'}
              size={24}
              color={isSelected ? '#3B82F6' : colorScheme === 'dark' ? '#9CA3AF' : '#6B7280'}
            />
            <View style={{ marginLeft: 12 }}>
              <Text style={[styles.reporterName, { color: Colors[colorScheme].text }]}>
                {report.reporter_name}
              </Text>
              <Text
                style={[
                  styles.reporterEmail,
                  { color: colorScheme === 'dark' ? '#9CA3AF' : '#6B7280' },
                ]}
              >
                {report.reporter_email}
              </Text>
            </View>
          </View>
          <StatusBadge status={report.status} />
        </View>

        <Text style={[styles.reportSubject, { color: Colors[colorScheme].text }]}>
          {report.subject}
        </Text>

        <Text
          style={[styles.reportMessage, { color: colorScheme === 'dark' ? '#9CA3AF' : '#6B7280' }]}
          numberOfLines={3}
        >
          {preview}
        </Text>

        <View style={styles.reportFooter}>
          <Text style={[styles.reportDate, { color: Colors[colorScheme].mutedText }]}>
            {new Date(report.created_at).toLocaleDateString()}{' '}
            {new Date(report.created_at).toLocaleTimeString()}
          </Text>
          <View style={styles.reportActions}>
            {isAdReport && report.status !== 'resolved' && report.status !== 'dismissed' && (
              <Pressable
                style={[styles.actionBtn, { backgroundColor: '#DC2626' + '20' }]}
                onPress={() => {
                  Alert.alert(
                    'Take Down Ad',
                    'Remove this ad from feed and notify the advertiser?',
                    [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Take Down',
                        style: 'destructive',
                        onPress: () => void takeDownAd(report),
                      },
                    ]
                  );
                }}
              >
                <Text style={[styles.actionBtnText, { color: '#DC2626' }]}>Take Down Ad</Text>
              </Pressable>
            )}
            <Pressable
              style={[styles.actionBtn, { backgroundColor: '#10B981' + '20' }]}
              onPress={() => updateReportStatus(report.id, 'resolved')}
            >
              <Text style={[styles.actionBtnText, { color: '#10B981' }]}>Resolve</Text>
            </Pressable>
            <Pressable
              style={[styles.actionBtn, { backgroundColor: Colors.light.mutedText + '20' }]}
              onPress={() => updateReportStatus(report.id, 'dismissed')}
            >
              <Text style={[styles.actionBtnText, { color: Colors.light.mutedText }]}>Dismiss</Text>
            </Pressable>
          </View>
        </View>
      </Pressable>
    );
  };

  if (adminLoading) {
    return (
      <SafeAreaView
        edges={['top']}
        style={{
          flex: 1,
          justifyContent: 'center',
          alignItems: 'center',
          backgroundColor: colorScheme === 'dark' ? '#121212' : '#F9FAFB',
        }}
      >
        <ActivityIndicator size="large" color="#3B82F6" />
      </SafeAreaView>
    );
  }

  if (!isAdmin) {
    return (
      <SafeAreaView
        edges={['top']}
        style={{
          flex: 1,
          justifyContent: 'center',
          alignItems: 'center',
          backgroundColor: colorScheme === 'dark' ? '#121212' : '#F9FAFB',
        }}
      >
        <Text
          style={{
            color: Colors[colorScheme].text,
            fontSize: 18,
            fontWeight: '600',
            paddingHorizontal: 24,
            textAlign: 'center',
          }}
        >
          Admin access required
        </Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      edges={['top']}
      style={{ flex: 1, backgroundColor: Colors[colorScheme].background }}
    >
      <Stack.Screen options={{ headerShown: false }} />

      <ScrollView
        style={styles.container}
        contentContainerStyle={styles.contentContainer}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {/* Header */}
        <View
          style={[
            styles.header,
            {
              backgroundColor: Colors[colorScheme].card,
              borderBottomColor: Colors[colorScheme].border,
            },
          ]}
        >
          <Pressable
            onPress={() => {
              safeGoBack(router);
            }}
            style={styles.backButton}
          >
            <Ionicons name="arrow-back" size={24} color={Colors[colorScheme].text} />
          </Pressable>
          <Text style={[styles.headerTitle, { color: Colors[colorScheme].text }]}>
            Abuse Reports
          </Text>
          <View style={styles.headerRight}>
            <Ionicons name="alert-circle-outline" size={24} color={Colors[colorScheme].mutedText} />
          </View>
        </View>

        {loading && !refreshing ? (
          <View style={styles.centerContainer}>
            <ActivityIndicator size="large" color={Colors[colorScheme].tint} />
          </View>
        ) : error ? (
          <View style={styles.centerContainer}>
            <Ionicons name="alert-circle" size={48} color={Colors.light.destructive} />
            <Text style={[styles.errorText, { color: Colors[colorScheme].destructive }]}>
              {error}
            </Text>
            <Pressable style={styles.retryButton} onPress={() => void loadReports()}>
              <Text style={styles.retryButtonText}>Try Again</Text>
            </Pressable>
          </View>
        ) : (
          <>
            {/* Stats */}
            {stats && (
              <View style={styles.statsContainer}>
                <View style={[styles.statBox, { backgroundColor: Colors[colorScheme].card }]}>
                  <Text style={[styles.statNumber, { color: '#F59E0B' }]}>{stats.pending}</Text>
                  <Text style={[styles.statLabel, { color: Colors[colorScheme].mutedText }]}>
                    Pending
                  </Text>
                </View>
                <View style={[styles.statBox, { backgroundColor: Colors[colorScheme].card }]}>
                  <Text style={[styles.statNumber, { color: '#10B981' }]}>{stats.resolved}</Text>
                  <Text style={[styles.statLabel, { color: Colors[colorScheme].mutedText }]}>
                    Resolved
                  </Text>
                </View>
                <View style={[styles.statBox, { backgroundColor: Colors[colorScheme].card }]}>
                  <Text style={[styles.statNumber, { color: Colors.light.mutedText }]}>
                    {stats.dismissed}
                  </Text>
                  <Text style={[styles.statLabel, { color: Colors[colorScheme].mutedText }]}>
                    Dismissed
                  </Text>
                </View>
                <View style={[styles.statBox, { backgroundColor: Colors[colorScheme].card }]}>
                  <Text style={[styles.statNumber, { color: Colors[colorScheme].tint }]}>
                    {stats.total}
                  </Text>
                  <Text style={[styles.statLabel, { color: Colors[colorScheme].mutedText }]}>
                    Total
                  </Text>
                </View>
              </View>
            )}

            {/* Filter Tabs */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.filterContainer}
            >
              {['all', 'pending', 'reviewed', 'resolved', 'dismissed'].map(status => (
                <Pressable
                  key={status}
                  style={[
                    styles.filterTab,
                    {
                      backgroundColor:
                        filterStatus === status
                          ? Colors[colorScheme].tint
                          : Colors[colorScheme].card,
                    },
                  ]}
                  onPress={() => setFilterStatus(status)}
                >
                  <Text
                    style={[
                      styles.filterTabText,
                      {
                        color:
                          filterStatus === status
                            ? Colors.dark.text
                            : Colors[colorScheme].mutedText,
                      },
                    ]}
                  >
                    {status.charAt(0).toUpperCase() + status.slice(1)}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>

            {/* Bulk Actions */}
            {selectedReports.size > 0 && (
              <View style={[styles.bulkActionsBar, { backgroundColor: Colors[colorScheme].card }]}>
                <Text style={[styles.bulkActionsText, { color: Colors[colorScheme].text }]}>
                  {selectedReports.size} selected
                </Text>
                <View style={styles.bulkActionsButtons}>
                  <Pressable style={styles.bulkActionBtn} onPress={selectAll}>
                    <Text style={styles.bulkActionBtnText}>All</Text>
                  </Pressable>
                  <Pressable style={styles.bulkActionBtn} onPress={deselectAll}>
                    <Text style={styles.bulkActionBtnText}>None</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.bulkActionBtn, { backgroundColor: '#10B981' }]}
                    onPress={() => bulkUpdateStatus('resolved')}
                  >
                    <Text style={[styles.bulkActionBtnText, { color: 'white' }]}>Resolve</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.bulkActionBtn, { backgroundColor: '#6B7280' }]}
                    onPress={() => bulkUpdateStatus('dismissed')}
                  >
                    <Text style={[styles.bulkActionBtnText, { color: 'white' }]}>Dismiss</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.bulkActionBtn, { backgroundColor: '#EF4444' }]}
                    onPress={bulkDelete}
                  >
                    <Text style={[styles.bulkActionBtnText, { color: 'white' }]}>Delete</Text>
                  </Pressable>
                </View>
              </View>
            )}

            {/* Reports List */}
            <View style={styles.reportsSection}>
              {reports.length === 0 ? (
                <View style={styles.emptyState}>
                  <Ionicons
                    name="document-text-outline"
                    size={64}
                    color={Colors[colorScheme].mutedText}
                  />
                  <Text style={[styles.emptyStateText, { color: Colors[colorScheme].mutedText }]}>
                    No reports found
                  </Text>
                </View>
              ) : (
                reports.map(report => <ReportCard key={report.id} report={report} />)
              )}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  contentContainer: {
    paddingBottom: 32,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#D1D5DB',
  },
  backButton: {
    width: 40,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '600',
  },
  headerRight: {
    width: 40,
    alignItems: 'flex-end',
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingTop: 100,
  },
  errorText: {
    fontSize: 16,
    marginTop: 16,
    marginBottom: 24,
    textAlign: 'center',
    paddingHorizontal: 20,
  },
  retryButton: {
    backgroundColor: '#3B82F6',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  retryButtonText: {
    color: 'white',
    fontSize: 16,
    fontWeight: '600',
  },
  statsContainer: {
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  statBox: {
    flex: 1,
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 1px 2px rgba(0, 0, 0, 0.05)' }
      : {
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 1 },
          shadowOpacity: 0.05,
          shadowRadius: 2,
        }),
    elevation: 2,
  },
  statNumber: {
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 4,
  },
  statLabel: {
    fontSize: 12,
    fontWeight: '500',
  },
  filterContainer: {
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  filterTab: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    marginRight: 8,
  },
  filterTabText: {
    fontSize: 14,
    fontWeight: '600',
  },
  bulkActionsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 12,
    marginHorizontal: 20,
    marginBottom: 12,
    borderRadius: 8,
  },
  bulkActionsText: {
    fontSize: 14,
    fontWeight: '600',
  },
  bulkActionsButtons: {
    flexDirection: 'row',
    gap: 8,
  },
  bulkActionBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: '#F3F4F6',
  },
  bulkActionBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.light.text,
  },
  reportsSection: {
    paddingHorizontal: 20,
  },
  reportCard: {
    padding: 16,
    borderRadius: 12,
    marginBottom: 12,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 1px 2px rgba(0, 0, 0, 0.05)' }
      : {
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 1 },
          shadowOpacity: 0.05,
          shadowRadius: 2,
        }),
    elevation: 2,
  },
  reportHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  reportHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  reporterName: {
    fontSize: 16,
    fontWeight: '600',
  },
  reporterEmail: {
    fontSize: 14,
    marginTop: 2,
  },
  badge: {
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderRadius: 12,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  reportSubject: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 8,
  },
  reportMessage: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 12,
  },
  reportFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  reportDate: {
    fontSize: 12,
  },
  reportActions: {
    flexDirection: 'row',
    gap: 8,
  },
  actionBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 6,
  },
  actionBtnText: {
    fontSize: 12,
    fontWeight: '600',
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 80,
  },
  emptyStateText: {
    fontSize: 16,
    marginTop: 16,
  },
});

export default AdminReportsScreen;
