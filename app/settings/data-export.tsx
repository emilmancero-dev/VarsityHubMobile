import { toUserMessage } from '@/utils/toUserMessage';
import { DataExport } from '@/api/entities';
import { Colors } from '@/constants/Colors';
import { captureBreadcrumb, captureException } from '@/utils/sentry';
import { useFocusEffect } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  useColorScheme,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

type ExportStatus = 'pending' | 'building' | 'ready' | 'expired' | 'failed';

type DataExportRow = {
  id: string;
  status: ExportStatus;
  requested_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  expires_at?: string | null;
  size_bytes?: number | null;
  error_category?: string | null;
  download_count?: number;
  last_downloaded_at?: string | null;
};

const POLL_INTERVAL_MS = 5000;
const POLL_MAX_DURATION_MS = 5 * 60 * 1000;

function formatDateTime(value?: string | null): string {
  if (!value) return 'Unknown';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return 'Unknown';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatBytes(value?: number | null): string {
  if (!value || value <= 0) return 'Pending size';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`;
}

function formatRetryWindow(seconds?: number): string | null {
  if (!seconds || seconds <= 0) return null;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.ceil((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function statusTone(status: ExportStatus, isDark: boolean, theme: (typeof Colors)['light']) {
  switch (status) {
    case 'ready':
      return {
        bg: isDark ? '#052E16' : '#DCFCE7',
        border: isDark ? '#166534' : '#86EFAC',
        text: isDark ? '#BBF7D0' : '#166534',
        label: 'Ready',
      };
    case 'building':
      return {
        bg: isDark ? '#1E3A8A' : '#DBEAFE',
        border: isDark ? '#2563EB' : '#93C5FD',
        text: isDark ? '#BFDBFE' : '#1D4ED8',
        label: 'Building',
      };
    case 'pending':
      return {
        bg: isDark ? '#3F2A0E' : '#FEF3C7',
        border: isDark ? '#B45309' : '#FCD34D',
        text: isDark ? '#FCD34D' : '#92400E',
        label: 'Queued',
      };
    case 'expired':
      return {
        bg: theme.surface,
        border: theme.border,
        text: theme.mutedText,
        label: 'Expired',
      };
    case 'failed':
      return {
        bg: isDark ? '#3F1D1D' : '#FEE2E2',
        border: isDark ? '#991B1B' : '#FCA5A5',
        text: isDark ? '#FCA5A5' : '#991B1B',
        label: 'Failed',
      };
  }
}

function StatusBadge({ status, isDark }: { status: ExportStatus; isDark: boolean }) {
  const colorScheme = useColorScheme() ?? 'light';
  const theme = Colors[colorScheme];
  const tone = statusTone(status, isDark, theme);
  return (
    <View style={[styles.badge, { backgroundColor: tone.bg, borderColor: tone.border }]}>
      <Text style={[styles.badgeText, { color: tone.text }]}>{tone.label}</Text>
    </View>
  );
}

export default function DataExportScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const palette = Colors[colorScheme];
  const isDark = colorScheme === 'dark';
  const [rows, setRows] = useState<DataExportRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Tracks whether the screen is currently focused so the polling effect
  // can stop when the user navigates away. Cleared in the focus-effect
  // cleanup below to avoid running queries against a backgrounded screen.
  const focusedRef = useRef(false);

  const load = useCallback(async (mode: 'initial' | 'refresh' | 'silent' = 'initial') => {
    if (mode === 'refresh') setRefreshing(true);
    if (mode === 'initial') setLoading(true);
    setError(null);
    try {
      const result = await DataExport.list();
      setRows(Array.isArray(result) ? result : []);
    } catch (e: any) {
      const message = toUserMessage(e, 'Failed to load exports.');
      setError(message);
      captureBreadcrumb('data export load failed', 'data-export', {
        action: 'load',
        status: e?.status,
      });
      captureException(e instanceof Error ? e : new Error(String(message)), {
        action: 'load',
        screen: 'settings-data-export',
        status: e?.status,
        server_error: e?.data?.error,
      });
    } finally {
      if (mode === 'initial') setLoading(false);
      if (mode === 'refresh') setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      void load('initial');
      return () => {
        focusedRef.current = false;
      };
    }, [load])
  );

  const latestReady = useMemo(() => rows.find(row => row.status === 'ready'), [rows]);
  const inFlight = useMemo(
    () => rows.find(row => row.status === 'pending' || row.status === 'building'),
    [rows]
  );

  // Poll in the background while an export is active. Bounded so a stuck
  // worker does not keep the client spinning forever.
  useEffect(() => {
    if (!inFlight) return undefined;
    const startedAt = Date.now();
    const interval = setInterval(() => {
      if (!focusedRef.current) return;
      if (Date.now() - startedAt > POLL_MAX_DURATION_MS) {
        clearInterval(interval);
        return;
      }
      void load('silent');
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [inFlight, load]);
  const rateLimitedForSeconds = useMemo(() => {
    if (!latestReady?.requested_at) return 0;
    const unlockAt = new Date(latestReady.requested_at).getTime() + 24 * 60 * 60 * 1000;
    return Math.max(0, Math.ceil((unlockAt - Date.now()) / 1000));
  }, [latestReady?.requested_at]);

  const requestDisabled = requesting || !!inFlight || rateLimitedForSeconds > 0;

  const requestExport = useCallback(async () => {
    setRequesting(true);
    try {
      const row = await DataExport.request();
      Alert.alert(
        'Export Requested',
        'Your archive is queued. This screen will refresh automatically while it builds.'
      );
      setRows(current => [row as DataExportRow, ...current]);
      void load('silent');
    } catch (e: any) {
      const serverError = e?.data?.error || e?.message || '';
      if (e?.status === 409 && serverError === 'EXPORT_IN_FLIGHT') {
        Alert.alert(
          'Export In Progress',
          'You already have an export being built. Wait for it to finish before requesting another.'
        );
      } else if (e?.status === 429) {
        const retry = formatRetryWindow(e?.data?.retry_after_seconds);
        Alert.alert(
          'Export Rate Limited',
          retry
            ? `You can request one export every 24 hours. Try again in about ${retry}.`
            : 'You can request one export every 24 hours.'
        );
      } else {
        Alert.alert('Unable to Request Export', toUserMessage(e, 'Please try again later.'));
        captureBreadcrumb('data export request failed', 'data-export', {
          action: 'request',
          status: e?.status,
        });
        captureException(
          e instanceof Error ? e : new Error(String(serverError || 'request_failed')),
          {
            action: 'request',
            screen: 'settings-data-export',
            status: e?.status,
            server_error: serverError || undefined,
          }
        );
      }
      void load('silent');
    } finally {
      setRequesting(false);
    }
  }, [load]);

  const downloadExport = useCallback(
    async (row: DataExportRow) => {
      setBusyId(row.id);
      try {
        const result: any = await DataExport.download(row.id);
        if (!result?.url) {
          throw new Error('Download URL missing');
        }
        await Linking.openURL(result.url);
        void load('silent');
      } catch (e: any) {
        if (e?.status === 409) {
          Alert.alert('Export Not Ready', 'This archive is still being built.');
        } else if (e?.status === 410) {
          Alert.alert('Export Expired', 'This archive has expired. Request a new export.');
        } else if (e?.status === 503) {
          Alert.alert('Export Failed', 'This export failed. Request a new one.');
        } else {
          Alert.alert('Download Failed', toUserMessage(e, 'Unable to open the archive.'));
          captureBreadcrumb('data export download failed', 'data-export', {
            action: 'download',
            export_id: row.id,
            status: e?.status,
          });
          captureException(e instanceof Error ? e : new Error('download_failed'), {
            action: 'download',
            screen: 'settings-data-export',
            export_id: row.id,
            status: e?.status,
            server_error: e?.data?.error,
            error_category: e?.data?.error_category,
          });
        }
        void load('silent');
      } finally {
        setBusyId(null);
      }
    },
    [load]
  );

  const deleteExport = useCallback(
    (row: DataExportRow) => {
      Alert.alert(
        row.status === 'ready' ? 'Delete Archive?' : 'Dismiss Export?',
        row.status === 'ready'
          ? 'This will expire the archive immediately and remove its download link.'
          : 'This will clear the current export attempt from your active list.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: row.status === 'ready' ? 'Delete' : 'Dismiss',
            style: 'destructive',
            onPress: async () => {
              setBusyId(row.id);
              try {
                await DataExport.delete(row.id);
                setRows(current =>
                  current.map(item =>
                    item.id === row.id
                      ? {
                          ...item,
                          status: 'expired',
                          expires_at: item.expires_at ?? new Date().toISOString(),
                        }
                      : item
                  )
                );
                void load('silent');
              } catch (e: any) {
                Alert.alert('Delete Failed', toUserMessage(e, 'Unable to update this export.'));
                captureBreadcrumb('data export delete failed', 'data-export', {
                  action: 'delete',
                  export_id: row.id,
                  status: e?.status,
                });
                captureException(
                  e instanceof Error ? e : new Error(String(e?.message || 'delete_failed')),
                  {
                    action: 'delete',
                    screen: 'settings-data-export',
                    export_id: row.id,
                    status: e?.status,
                    server_error: e?.data?.error,
                  }
                );
              } finally {
                setBusyId(null);
              }
            },
          },
        ]
      );
    },
    [load]
  );

  return (
    <>
      <Stack.Screen options={{ title: 'Data Export' }} />
      <SafeAreaView style={[styles.container, { backgroundColor: palette.background }]}>
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={palette.tint} />
          </View>
        ) : (
          <ScrollView
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={() => void load('refresh')}
                tintColor={palette.tint}
              />
            }
            contentContainerStyle={styles.content}
          >
            <View
              style={[styles.hero, { backgroundColor: palette.card, borderColor: palette.border }]}
            >
              <View style={styles.heroIconWrap}>
                <Ionicons name="download-outline" size={26} color={palette.tint} />
              </View>
              <Text style={[styles.heroTitle, { color: palette.text }]}>
                Export your VarsityHub data
              </Text>
              <Text style={[styles.heroBody, { color: palette.mutedText }]}>
                Build a ZIP archive of the profile, posts, follows, messages, events, ads, and other
                account data currently tied to you.
              </Text>
              <Text style={[styles.heroFootnote, { color: palette.mutedText }]}>
                Archives expire after 7 days. You can request one export every 24 hours.
              </Text>
              <Pressable
                onPress={() => void requestExport()}
                disabled={requestDisabled}
                style={[
                  styles.primaryButton,
                  { backgroundColor: requestDisabled ? palette.border : palette.tint },
                ]}
              >
                {requesting ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.primaryButtonText}>
                    {inFlight
                      ? 'Export In Progress'
                      : rateLimitedForSeconds > 0
                        ? `Available In ${formatRetryWindow(rateLimitedForSeconds)}`
                        : 'Request New Export'}
                  </Text>
                )}
              </Pressable>
            </View>

            {error ? (
              <View
                style={[
                  styles.errorCard,
                  {
                    backgroundColor: isDark ? '#3F1D1D' : '#FEF2F2',
                    borderColor: isDark ? '#7F1D1D' : '#FECACA',
                  },
                ]}
              >
                <Text style={[styles.errorText, { color: isDark ? '#FCA5A5' : '#B91C1C' }]}>
                  {error}
                </Text>
              </View>
            ) : null}

            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, { color: palette.text }]}>Recent Exports</Text>
              <Text style={[styles.sectionSubtitle, { color: palette.mutedText }]}>
                Active exports refresh automatically. Pull down any time to force a sync.
              </Text>
            </View>

            {rows.length === 0 ? (
              <View
                style={[
                  styles.emptyCard,
                  { backgroundColor: palette.card, borderColor: palette.border },
                ]}
              >
                <Ionicons name="archive-outline" size={36} color={palette.mutedText} />
                <Text style={[styles.emptyTitle, { color: palette.text }]}>No exports yet</Text>
                <Text style={[styles.emptyBody, { color: palette.mutedText }]}>
                  Request your first archive above. It will appear here once the build is queued.
                </Text>
              </View>
            ) : (
              rows.map(row => {
                const isBusy = busyId === row.id;
                return (
                  <View
                    key={row.id}
                    style={[
                      styles.rowCard,
                      { backgroundColor: palette.card, borderColor: palette.border },
                    ]}
                  >
                    <View style={styles.rowHeader}>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.rowTitle, { color: palette.text }]}>
                          Requested {formatDateTime(row.requested_at)}
                        </Text>
                        <Text style={[styles.rowMeta, { color: palette.mutedText }]}>
                          {formatBytes(row.size_bytes)}
                          {typeof row.download_count === 'number'
                            ? ` · ${row.download_count} download${row.download_count === 1 ? '' : 's'}`
                            : ''}
                        </Text>
                      </View>
                      <StatusBadge status={row.status} isDark={isDark} />
                    </View>

                    {row.status === 'ready' && row.expires_at ? (
                      <Text style={[styles.detailText, { color: palette.mutedText }]}>
                        Expires {formatDateTime(row.expires_at)}
                      </Text>
                    ) : null}
                    {row.status === 'failed' && row.error_category ? (
                      <Text style={[styles.detailText, { color: isDark ? '#FCA5A5' : '#B91C1C' }]}>
                        Failure reason: {row.error_category.replace(/_/g, ' ')}
                      </Text>
                    ) : null}
                    {row.last_downloaded_at ? (
                      <Text style={[styles.detailText, { color: palette.mutedText }]}>
                        Last downloaded {formatDateTime(row.last_downloaded_at)}
                      </Text>
                    ) : null}

                    <View style={styles.actionsRow}>
                      {row.status === 'ready' ? (
                        <Pressable
                          onPress={() => void downloadExport(row)}
                          disabled={isBusy}
                          style={[styles.actionButton, { backgroundColor: palette.tint }]}
                        >
                          {isBusy ? (
                            <ActivityIndicator color="#fff" />
                          ) : (
                            <Text style={styles.actionPrimaryText}>Download</Text>
                          )}
                        </Pressable>
                      ) : (
                        <Pressable
                          onPress={() => void load('refresh')}
                          disabled={isBusy}
                          style={[
                            styles.actionButton,
                            { backgroundColor: palette.surface || palette.border },
                          ]}
                        >
                          <Text style={[styles.actionSecondaryText, { color: palette.text }]}>
                            Refresh
                          </Text>
                        </Pressable>
                      )}

                      {row.status !== 'expired' ? (
                        <Pressable
                          onPress={() => deleteExport(row)}
                          disabled={isBusy}
                          style={[
                            styles.actionButton,
                            styles.secondaryAction,
                            { borderColor: palette.border },
                          ]}
                        >
                          <Text style={[styles.actionSecondaryText, { color: palette.text }]}>
                            {row.status === 'ready' ? 'Delete' : 'Dismiss'}
                          </Text>
                        </Pressable>
                      ) : null}
                    </View>
                  </View>
                );
              })
            )}
          </ScrollView>
        )}
      </SafeAreaView>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { padding: 16, gap: 14, paddingBottom: 32 },
  hero: {
    borderWidth: 1,
    borderRadius: 18,
    padding: 18,
    gap: 10,
  },
  heroIconWrap: {
    width: 44,
    height: 44,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(59,130,246,0.10)',
  },
  heroTitle: { fontSize: 20, fontWeight: '700' },
  heroBody: { fontSize: 14, lineHeight: 21 },
  heroFootnote: { fontSize: 12, lineHeight: 18 },
  primaryButton: {
    minHeight: 46,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    marginTop: 4,
  },
  primaryButtonText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  errorCard: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 12,
  },
  errorText: { fontSize: 13, lineHeight: 19 },
  sectionHeader: { gap: 2, marginTop: 4 },
  sectionTitle: { fontSize: 16, fontWeight: '700' },
  sectionSubtitle: { fontSize: 12 },
  emptyCard: {
    borderWidth: 1,
    borderRadius: 18,
    padding: 24,
    alignItems: 'center',
    gap: 8,
  },
  emptyTitle: { fontSize: 17, fontWeight: '700' },
  emptyBody: { fontSize: 13, lineHeight: 19, textAlign: 'center' },
  rowCard: {
    borderWidth: 1,
    borderRadius: 18,
    padding: 16,
    gap: 10,
  },
  rowHeader: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  rowTitle: { fontSize: 15, fontWeight: '700' },
  rowMeta: { fontSize: 12, marginTop: 3 },
  detailText: { fontSize: 12, lineHeight: 18 },
  badge: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  badgeText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.3 },
  actionsRow: { flexDirection: 'row', gap: 10, marginTop: 2 },
  actionButton: {
    minHeight: 42,
    borderRadius: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
  },
  secondaryAction: {
    backgroundColor: 'transparent',
    borderWidth: 1,
  },
  actionPrimaryText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  actionSecondaryText: { fontWeight: '600', fontSize: 14 },
});
