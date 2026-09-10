import { Colors } from '@/constants/Colors';
import { useColorScheme } from '@/hooks/useColorScheme';
import { useRequireAdmin } from '@/hooks/useRequireAdmin';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { safeGoBack } from '@/utils/navigation';
import { getApiBaseUrl, httpGet, httpPost } from '../apiclient/http';
// @ts-ignore
import { User } from '@/api/entities';
import { isSessionExpiryError } from '@/utils/sessionExpiryError';
import { toUserMessage } from '@/utils/toUserMessage';

type Severity = 'warning' | 'strike' | 'final_warning';

function AdminUserDetailScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const router = useRouter();
  const { isAdmin, loading: adminLoading } = useRequireAdmin();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [moderation, setModeration] = useState<any>(null);
  const [modLoading, setModLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  // Modal state
  const [warnModalVisible, setWarnModalVisible] = useState(false);
  const [suspendModalVisible, setSuspendModalVisible] = useState(false);
  const [warnReason, setWarnReason] = useState('');
  const [warnSeverity, setWarnSeverity] = useState<Severity>('warning');
  const [suspendReason, setSuspendReason] = useState('');
  const [suspendDays, setSuspendDays] = useState('7');

  const load = useCallback(async () => {
    if (!isAdmin || !id) return;
    setLoading(true);
    setError(null);
    try {
      const d = await User.getFull(String(id));
      setDetail(d);
    } catch (e: any) {
      setError(
        isSessionExpiryError(e)
          ? 'Your admin session expired. Please sign in again.'
          : e?.status === 403
            ? 'Access denied (admin only).'
            : toUserMessage(e, 'Failed to load user')
      );
    } finally {
      setLoading(false);
    }
  }, [id, isAdmin]);

  const loadModeration = useCallback(async () => {
    if (!isAdmin || !id) return;
    setModLoading(true);
    try {
      const data = await httpGet(`/admin/users/${encodeURIComponent(String(id))}/moderation`);
      setModeration(data);
    } catch (e: any) {
      if (!isSessionExpiryError(e)) {
        /* moderation may not exist yet */
      }
    } finally {
      setModLoading(false);
    }
  }, [id, isAdmin]);

  useEffect(() => {
    void load();
    void loadModeration();
  }, [load, loadModeration]);

  const onDownload = async () => {
    if (!id) return;
    const url = getApiBaseUrl() + `/users/${encodeURIComponent(String(id))}/export`;
    try {
      await WebBrowser.openBrowserAsync(url);
    } catch {
      /* no-op */
    }
  };

  const onWarn = async () => {
    if (!id || !warnReason.trim()) return;
    setActionLoading(true);
    try {
      await httpPost(`/admin/users/${encodeURIComponent(String(id))}/warn`, {
        reason: warnReason.trim(),
        severity: warnSeverity,
      });
      Alert.alert('Warning Issued', `${warnSeverity} sent successfully.`);
      setWarnModalVisible(false);
      setWarnReason('');
      setWarnSeverity('warning');
      void loadModeration();
    } catch (e: any) {
      if (isSessionExpiryError(e)) {
        return;
      }
      Alert.alert('Error', toUserMessage(e, 'Failed to issue warning'));
    } finally {
      setActionLoading(false);
    }
  };

  const onSuspend = async () => {
    if (!id || !suspendReason.trim()) return;
    setActionLoading(true);
    try {
      const days = Math.max(1, Math.min(365, parseInt(suspendDays) || 7));
      await httpPost(`/admin/users/${encodeURIComponent(String(id))}/suspend`, {
        days,
        reason: suspendReason.trim(),
      });
      Alert.alert('User Suspended', `Suspended for ${days} day(s).`);
      setSuspendModalVisible(false);
      setSuspendReason('');
      setSuspendDays('7');
      void load();
      void loadModeration();
    } catch (e: any) {
      if (isSessionExpiryError(e)) {
        return;
      }
      Alert.alert('Error', toUserMessage(e, 'Failed to suspend user'));
    } finally {
      setActionLoading(false);
    }
  };

  const [banModalVisible, setBanModalVisible] = useState(false);
  const [banReason, setBanReason] = useState('');

  const onBan = () => {
    if (!id) return;
    setBanReason('');
    setBanModalVisible(true);
  };

  const confirmBan = async () => {
    try {
      setActionLoading(true);
      await User.ban(String(id), banReason.trim() || undefined);
      Alert.alert('User Banned');
      setBanModalVisible(false);
      setBanReason('');
      void load();
      void loadModeration();
    } catch (e: any) {
      if (isSessionExpiryError(e)) {
        return;
      }
      Alert.alert('Error', toUserMessage(e, 'Failed to ban user'));
    } finally {
      setActionLoading(false);
    }
  };

  const onUnban = async () => {
    if (!id) return;
    try {
      await User.unban(String(id));
      Alert.alert('User Unbanned');
      void load();
    } catch (e: any) {
      if (isSessionExpiryError(e)) {
        return;
      }
      Alert.alert('Error', toUserMessage(e, 'Failed to unban user'));
    }
  };

  const ads = detail?.ads || [];
  const datesByAd = detail?.datesByAd || {};
  const warnings = moderation?.warnings || [];
  const palette = Colors[colorScheme];
  const modalCardBackground = palette.card;
  const modalInputBackground = palette.surface;

  const severityColor = (s: string) => {
    if (s === 'strike') return '#F59E0B';
    if (s === 'final_warning') return '#EF4444';
    return '#3B82F6';
  };

  const renderActionModal = ({
    visible,
    title,
    subtitle,
    children,
  }: {
    visible: boolean;
    title: string;
    subtitle: string;
    children: ReactNode;
  }) => (
    <Modal visible={visible} transparent animationType="slide">
      <View style={styles.modalOverlay}>
        <View style={[styles.modalContent, { backgroundColor: modalCardBackground }]}>
          <Text style={[styles.modalTitle, { color: palette.text }]}>{title}</Text>
          <Text style={[styles.meta, { color: palette.mutedText, marginBottom: 12 }]}>
            {subtitle}
          </Text>
          {children}
        </View>
      </View>
    </Modal>
  );

  const renderReasonInput = ({
    value,
    onChangeText,
    placeholder,
  }: {
    value: string;
    onChangeText: (text: string) => void;
    placeholder: string;
  }) => (
    <TextInput
      style={[
        styles.textInput,
        {
          color: palette.text,
          borderColor: palette.border,
          backgroundColor: modalInputBackground,
        },
      ]}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={palette.mutedText}
      multiline
      numberOfLines={3}
    />
  );

  const renderModalActions = ({
    onCancel,
    onConfirm,
    disabled,
    confirmColor,
    confirmLabel,
  }: {
    onCancel: () => void;
    onConfirm: () => void;
    disabled: boolean;
    confirmColor: string;
    confirmLabel: string;
  }) => (
    <View style={{ flexDirection: 'row', gap: 8, marginTop: 16 }}>
      <Pressable style={[styles.modalBtn, { backgroundColor: palette.border }]} onPress={onCancel}>
        <Text style={{ color: palette.text, fontWeight: '700' }}>Cancel</Text>
      </Pressable>
      <Pressable
        style={[styles.modalBtn, { backgroundColor: confirmColor, flex: 1 }]}
        onPress={onConfirm}
        disabled={disabled}
      >
        {actionLoading ? (
          <ActivityIndicator color="white" size="small" />
        ) : (
          <Text style={{ color: 'white', fontWeight: '700' }}>{confirmLabel}</Text>
        )}
      </Pressable>
    </View>
  );

  if (adminLoading) {
    return (
      <SafeAreaView
        style={[
          styles.container,
          { justifyContent: 'center', alignItems: 'center', backgroundColor: palette.background },
        ]}
        edges={['top', 'bottom']}
      >
        <ActivityIndicator color={palette.tint} />
      </SafeAreaView>
    );
  }

  if (!isAdmin) {
    return (
      <SafeAreaView
        style={[
          styles.container,
          { justifyContent: 'center', alignItems: 'center', backgroundColor: palette.background },
        ]}
        edges={['top', 'bottom']}
      >
        <Text style={{ color: palette.text, fontSize: 16, fontWeight: '600' }}>
          Admin access required
        </Text>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: palette.background }]}
      edges={['top', 'bottom']}
    >
      <Stack.Screen
        options={{
          title: 'Admin · User Detail',
          headerLeft: () => (
            <Pressable
              onPress={() => {
                safeGoBack(router);
              }}
              style={{ paddingLeft: 8 }}
            >
              <MaterialIcons name="chevron-left" size={24} color={palette.tint} />
            </Pressable>
          ),
        }}
      />
      {loading ? (
        <View style={{ padding: 24, alignItems: 'center' }}>
          <ActivityIndicator color={palette.tint} />
        </View>
      ) : null}
      {error ? <Text style={[styles.error, { color: palette.mutedText }]}>{error}</Text> : null}
      {!loading && !error && detail ? (
        <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
          {/* User Info Header */}
          <View style={[styles.header, { borderBottomColor: palette.border }]}>
            <Text style={[styles.title, { color: palette.text }]}>
              {detail.user?.display_name || '(no name)'}
            </Text>
            <Text style={[styles.meta, { color: palette.mutedText }]}>{detail.user?.email}</Text>
            <View style={{ flexDirection: 'row', gap: 6, marginTop: 6 }}>
              <View
                style={[
                  styles.badge,
                  { backgroundColor: palette.card, borderColor: palette.border },
                ]}
              >
                <Text style={[styles.badgeText, { color: palette.text }]}>
                  {detail.user?.email_verified ? 'VERIFIED' : 'UNVERIFIED'}
                </Text>
              </View>
              {detail.user?.banned ? (
                <View
                  style={[styles.badge, { backgroundColor: '#FEE2E2', borderColor: '#FCA5A5' }]}
                >
                  <Text style={[styles.badgeText, { color: '#991B1B' }]}>BANNED</Text>
                </View>
              ) : null}
            </View>
            <Pressable style={[styles.btn, { backgroundColor: palette.tint }]} onPress={onDownload}>
              <Text style={styles.btnText}>Download Ads CSV</Text>
            </Pressable>
          </View>

          {/* Moderation Actions */}
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: palette.text }]}>Moderation Actions</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <Pressable
                style={[styles.actionBtn, { backgroundColor: '#3B82F6' }]}
                onPress={() => setWarnModalVisible(true)}
              >
                <MaterialIcons name="warning" size={16} color="white" />
                <Text style={styles.actionBtnText}>Issue Warning</Text>
              </Pressable>
              <Pressable
                style={[styles.actionBtn, { backgroundColor: '#F59E0B' }]}
                onPress={() => setSuspendModalVisible(true)}
              >
                <MaterialIcons name="pause-circle-filled" size={16} color="white" />
                <Text style={styles.actionBtnText}>Suspend</Text>
              </Pressable>
              {detail.user?.banned ? (
                <Pressable
                  style={[styles.actionBtn, { backgroundColor: '#10B981' }]}
                  onPress={onUnban}
                >
                  <MaterialIcons name="check-circle" size={16} color="white" />
                  <Text style={styles.actionBtnText}>Unban</Text>
                </Pressable>
              ) : (
                <Pressable
                  style={[styles.actionBtn, { backgroundColor: '#EF4444' }]}
                  onPress={onBan}
                >
                  <MaterialIcons name="block" size={16} color="white" />
                  <Text style={styles.actionBtnText}>Ban User</Text>
                </Pressable>
              )}
            </View>
          </View>

          {/* Moderation History */}
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: palette.text }]}>Moderation History</Text>
            {modLoading ? (
              <ActivityIndicator style={{ marginTop: 8 }} color={palette.tint} />
            ) : warnings.length === 0 ? (
              <Text style={[styles.meta, { color: palette.mutedText, marginTop: 4 }]}>
                No warnings or actions on record.
              </Text>
            ) : (
              <>
                <View style={{ flexDirection: 'row', gap: 12, marginBottom: 8 }}>
                  <Text style={[styles.meta, { color: palette.mutedText }]}>
                    Total: {moderation?.totalWarnings ?? 0} warnings
                  </Text>
                  <Text style={[styles.meta, { color: '#F59E0B' }]}>
                    {moderation?.totalStrikes ?? 0} strikes
                  </Text>
                </View>
                {warnings.map((w: any) => (
                  <View
                    key={w.id}
                    style={[
                      styles.card,
                      {
                        backgroundColor: palette.surface,
                        borderColor: palette.border,
                        borderLeftWidth: 3,
                        borderLeftColor: severityColor(w.severity),
                      },
                    ]}
                  >
                    <View
                      style={{
                        flexDirection: 'row',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <View
                        style={[
                          styles.badge,
                          {
                            backgroundColor: severityColor(w.severity) + '20',
                            borderColor: severityColor(w.severity),
                          },
                        ]}
                      >
                        <Text style={[styles.badgeText, { color: severityColor(w.severity) }]}>
                          {(w.severity || 'warning').toUpperCase().replace('_', ' ')}
                        </Text>
                      </View>
                      <Text style={[{ fontSize: 11, color: palette.mutedText }]}>
                        {new Date(w.created_at).toLocaleDateString()}
                      </Text>
                    </View>
                    <Text style={[{ marginTop: 6, color: palette.text, fontSize: 13 }]}>
                      {w.reason}
                    </Text>
                  </View>
                ))}
              </>
            )}
          </View>

          {/* User's Ads */}
          <View style={styles.section}>
            <Text style={[styles.sectionTitle, { color: palette.text }]}>Ads ({ads.length})</Text>
            {ads.length === 0 ? (
              <Text style={[styles.meta, { color: palette.mutedText }]}>No ads.</Text>
            ) : (
              ads.map((item: any) => (
                <View
                  key={String(item.id)}
                  style={[
                    styles.card,
                    {
                      backgroundColor: palette.surface,
                      borderColor: palette.border,
                    },
                  ]}
                >
                  <Text style={[styles.cardTitle, { color: palette.text }]}>
                    {item.business_name || '(no business)'}
                  </Text>
                  <Text style={[styles.meta, { color: palette.mutedText }]}>
                    Status: {item.status || 'draft'} · Payment: {item.payment_status || 'unpaid'}
                  </Text>
                  <Text style={[styles.meta, { color: palette.mutedText }]}>
                    Zip {item.target_zip_code || ''}
                  </Text>
                  <Text style={[styles.meta, { color: palette.mutedText }]}>
                    Dates: {(datesByAd[item.id] || []).join(', ') || '—'}
                  </Text>
                </View>
              ))
            )}
          </View>
        </ScrollView>
      ) : null}

      {/* Warn Modal */}
      {renderActionModal({
        visible: warnModalVisible,
        title: 'Issue Warning',
        subtitle: `To: ${detail?.user?.display_name || detail?.user?.email || ''}`,
        children: (
          <>
            <Text style={[styles.label, { color: palette.text }]}>Severity</Text>
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
              {(['warning', 'strike', 'final_warning'] as Severity[]).map(s => (
                <Pressable
                  key={s}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: warnSeverity === s ? severityColor(s) : 'transparent',
                      borderColor: severityColor(s),
                    },
                  ]}
                  onPress={() => setWarnSeverity(s)}
                >
                  <Text
                    style={{
                      color: warnSeverity === s ? 'white' : severityColor(s),
                      fontSize: 12,
                      fontWeight: '700',
                    }}
                  >
                    {s.toUpperCase().replace('_', ' ')}
                  </Text>
                </Pressable>
              ))}
            </View>

            <Text style={[styles.label, { color: palette.text }]}>Reason</Text>
            {renderReasonInput({
              value: warnReason,
              onChangeText: setWarnReason,
              placeholder: 'Describe the violation...',
            })}

            {renderModalActions({
              onCancel: () => setWarnModalVisible(false),
              onConfirm: onWarn,
              disabled: actionLoading || !warnReason.trim(),
              confirmColor: severityColor(warnSeverity),
              confirmLabel: 'Send Warning',
            })}
          </>
        ),
      })}

      {/* Suspend Modal */}
      {renderActionModal({
        visible: suspendModalVisible,
        title: 'Suspend User',
        subtitle: `Temporarily suspend: ${detail?.user?.display_name || detail?.user?.email || ''}`,
        children: (
          <>
            <Text style={[styles.label, { color: palette.text }]}>Duration (days)</Text>
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
              {['1', '3', '7', '14', '30'].map(d => (
                <Pressable
                  key={d}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: suspendDays === d ? '#F59E0B' : 'transparent',
                      borderColor: '#F59E0B',
                    },
                  ]}
                  onPress={() => setSuspendDays(d)}
                >
                  <Text
                    style={{
                      color: suspendDays === d ? 'white' : '#F59E0B',
                      fontSize: 12,
                      fontWeight: '700',
                    }}
                  >
                    {d}d
                  </Text>
                </Pressable>
              ))}
            </View>

            <Text style={[styles.label, { color: palette.text }]}>Reason</Text>
            {renderReasonInput({
              value: suspendReason,
              onChangeText: setSuspendReason,
              placeholder: 'Reason for suspension...',
            })}

            {renderModalActions({
              onCancel: () => setSuspendModalVisible(false),
              onConfirm: onSuspend,
              disabled: actionLoading || !suspendReason.trim(),
              confirmColor: '#F59E0B',
              confirmLabel: `Suspend ${suspendDays} Day(s)`,
            })}
          </>
        ),
      })}

      {/* Ban Modal */}
      {renderActionModal({
        visible: banModalVisible,
        title: 'Ban User',
        subtitle: `Permanently ban: ${detail?.user?.display_name || detail?.user?.email || ''}`,
        children: (
          <>
            <Text style={[styles.label, { color: palette.text }]}>Reason (optional)</Text>
            {renderReasonInput({
              value: banReason,
              onChangeText: setBanReason,
              placeholder: 'Reason for ban...',
            })}

            {renderModalActions({
              onCancel: () => setBanModalVisible(false),
              onConfirm: confirmBan,
              disabled: actionLoading,
              confirmColor: '#EF4444',
              confirmLabel: 'Ban Permanently',
            })}
          </>
        ),
      })}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { padding: 16, gap: 6, borderBottomWidth: 1 },
  title: { fontWeight: '800', fontSize: 18 },
  meta: {},
  badge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, borderWidth: 1 },
  badgeText: { fontWeight: '800', fontSize: 10 },
  btn: {
    alignSelf: 'flex-start',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginTop: 8,
  },
  btnText: { color: 'white', fontWeight: '800' },
  section: { padding: 16 },
  sectionTitle: { fontWeight: '800', fontSize: 16, marginBottom: 10 },
  card: { padding: 12, borderRadius: 12, borderWidth: 1, marginBottom: 8 },
  cardTitle: { fontWeight: '800' },
  error: { color: '#b91c1c', padding: 12 },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  actionBtnText: { color: 'white', fontWeight: '700', fontSize: 13 },
  label: { fontWeight: '700', fontSize: 13, marginBottom: 6 },
  chip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, borderWidth: 1 },
  textInput: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
    fontSize: 14,
    minHeight: 60,
    textAlignVertical: 'top',
  },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalContent: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    paddingBottom: 40,
  },
  modalTitle: { fontWeight: '800', fontSize: 18, marginBottom: 4 },
  modalBtn: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default AdminUserDetailScreen;
