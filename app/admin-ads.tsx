import {
  AdminGuardState,
  AdminScreenShell,
  adminScreenSharedStyles as sharedStyles,
} from '@/components/AdminScreenShared';
import { Colors } from '@/constants/Colors';
import { useColorScheme } from '@/hooks/useColorScheme';
import { useRequireAdmin } from '@/hooks/useRequireAdmin';
import { getCompositeAdBadge } from '@/utils/adStatusBadge';
import { optimizeImageUrl } from '@/utils/imageUrl';
import { safeGoBack } from '@/utils/navigation';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
// @ts-ignore
import { Advertisement as AdsApi } from '@/api/entities';
import { toUserMessage } from '@/utils/toUserMessage';

type AdStatus = 'draft' | 'pending' | 'approved' | 'active' | 'paused';

function AdminAdsScreen() {
  const colorScheme = useColorScheme() ?? 'light';
  const router = useRouter();
  const params = useLocalSearchParams<{
    ad_id?: string;
    action?: 'approve' | 'reject';
  }>();
  const { isAdmin, loading: adminLoading } = useRequireAdmin();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [items, setItems] = useState<any[]>([]);
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedAds, setSelectedAds] = useState<Set<string>>(new Set());
  const [updating, setUpdating] = useState(false);
  const [reviewingAdId, setReviewingAdId] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<'all' | AdStatus>('all');
  // Cross-platform modal for approve/reject notes (Alert.prompt is iOS-only)
  const [reviewModal, setReviewModal] = useState<{
    adId: string;
    action: 'approve' | 'reject';
    bannerModerationStatus?: string | null;
  } | null>(null);
  const [reviewNote, setReviewNote] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [detailAd, setDetailAd] = useState<any>(null);
  // Track the specific email/deep-link signature we last handled so a second
  // approval email opened in the same app session still works.
  const lastHandledLinkRef = useRef<string | null>(null);

  const isSessionExpiryError = (err: any) => {
    const status = err?.status || err?.response?.status;
    const serverData = err?.data || err?.response?.data;
    const message = String(
      serverData?.error || serverData?.message || err?.message || ''
    ).toLowerCase();
    return (
      err?.isSessionExpired === true || (status === 401 && message.includes('session expired'))
    );
  };

  const load = useCallback(async () => {
    if (!isAdmin) return;
    setLoading(true);
    setError(null);
    try {
      const list = await AdsApi.listAll();
      setItems(Array.isArray(list) ? list : []);
    } catch (e: any) {
      setError(
        e?.status === 403 ? 'Access denied (admin only).' : toUserMessage(e, 'Failed to load ads')
      );
    } finally {
      setLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const adId = String(params.ad_id || '').trim();
    const action = params.action === 'approve' || params.action === 'reject' ? params.action : null;
    if (!isAdmin || items.length === 0 || !adId) return;

    const signature = `${adId}|${action ?? ''}`;
    if (lastHandledLinkRef.current === signature) return;

    const matchedAd = items.find(ad => String(ad.id) === adId);
    if (!matchedAd) return;

    lastHandledLinkRef.current = signature;
    if (action) {
      setReviewNote('');
      setOverrideReason('');
      setReviewModal({
        adId: matchedAd.id,
        action,
        bannerModerationStatus: matchedAd.banner_moderation_status,
      });
      return;
    }
    setDetailAd(matchedAd);
  }, [isAdmin, items, params.action, params.ad_id]);

  const toggleAdSelection = (adId: string) => {
    const newSet = new Set(selectedAds);
    if (newSet.has(adId)) {
      newSet.delete(adId);
    } else {
      newSet.add(adId);
    }
    setSelectedAds(newSet);
  };

  const selectAll = () => {
    const filtered = filteredItems;
    if (selectedAds.size === filtered.length) {
      setSelectedAds(new Set());
    } else {
      setSelectedAds(new Set(filtered.map(a => String(a.id))));
    }
  };

  const bulkApprove = () => {
    const pendingIds = Array.from(selectedAds).filter(
      id => items.find(a => String(a.id) === id)?.status === 'pending'
    );
    if (pendingIds.length === 0) return;
    Alert.alert(
      'Approve Ads',
      `Approve ${pendingIds.length} pending ad${pendingIds.length > 1 ? 's' : ''}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Approve',
          onPress: async () => {
            setUpdating(true);
            try {
              const results = await Promise.allSettled(
                pendingIds.map(adId => AdsApi.review(adId, 'approve'))
              );
              const sessionExpiry = results.find(
                r => r.status === 'rejected' && isSessionExpiryError(r.reason)
              );
              if (sessionExpiry) {
                return;
              }
              const failed = results.filter(r => r.status === 'rejected').length;
              if (failed > 0) {
                Alert.alert(
                  'Partial Success',
                  `Approved ${pendingIds.length - failed} ad(s), ${failed} failed`
                );
              } else {
                Alert.alert(
                  'Success',
                  `Approved ${pendingIds.length} ad${pendingIds.length > 1 ? 's' : ''}`
                );
              }
              setSelectedAds(new Set());
              setBulkMode(false);
              await load();
            } catch (e: any) {
              if (isSessionExpiryError(e)) {
                return;
              }
              Alert.alert('Error', toUserMessage(e, 'Failed to approve ads'));
            } finally {
              setUpdating(false);
            }
          },
        },
      ]
    );
  };

  const bulkReject = async () => {
    const pendingIds = Array.from(selectedAds).filter(
      id => items.find(a => String(a.id) === id)?.status === 'pending'
    );
    if (pendingIds.length === 0) return;

    Alert.alert(
      'Reject Ads',
      `Reject ${pendingIds.length} ad${pendingIds.length > 1 ? 's' : ''}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reject',
          style: 'destructive',
          onPress: async () => {
            setUpdating(true);
            try {
              const results = await Promise.allSettled(
                pendingIds.map(adId => AdsApi.review(adId, 'reject'))
              );
              const sessionExpiry = results.find(
                r => r.status === 'rejected' && isSessionExpiryError(r.reason)
              );
              if (sessionExpiry) {
                return;
              }
              const failed = results.filter(r => r.status === 'rejected').length;
              if (failed > 0) {
                Alert.alert(
                  'Partial Success',
                  `Rejected ${pendingIds.length - failed} ad(s), ${failed} failed`
                );
              } else {
                Alert.alert(
                  'Success',
                  `Rejected ${pendingIds.length} ad${pendingIds.length > 1 ? 's' : ''}`
                );
              }
              setSelectedAds(new Set());
              setBulkMode(false);
              await load();
            } catch (e: any) {
              if (isSessionExpiryError(e)) {
                return;
              }
              Alert.alert('Error', toUserMessage(e, 'Failed to reject ads'));
            } finally {
              setUpdating(false);
            }
          },
        },
      ]
    );
  };

  const bulkDelete = async () => {
    if (selectedAds.size === 0) return;

    Alert.alert(
      'Delete Ads',
      `Delete ${selectedAds.size} ad${selectedAds.size > 1 ? 's' : ''}? This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setUpdating(true);
            try {
              const adIds = Array.from(selectedAds);
              const results = await Promise.allSettled(adIds.map(adId => AdsApi.delete(adId)));
              const sessionExpiry = results.find(
                r => r.status === 'rejected' && isSessionExpiryError(r.reason)
              );
              if (sessionExpiry) {
                return;
              }
              const failed = results.filter(r => r.status === 'rejected').length;
              if (failed > 0) {
                Alert.alert(
                  'Partial Success',
                  `Deleted ${adIds.length - failed} ad(s), ${failed} failed`
                );
              } else {
                Alert.alert('Success', `Deleted ${adIds.length} ad${adIds.length > 1 ? 's' : ''}`);
              }
              setSelectedAds(new Set());
              setBulkMode(false);
              await load();
            } catch (e: any) {
              if (isSessionExpiryError(e)) {
                return;
              }
              Alert.alert('Error', toUserMessage(e, 'Failed to delete ads'));
            } finally {
              setUpdating(false);
            }
          },
        },
      ]
    );
  };

  const theme = Colors[colorScheme];

  if (adminLoading) {
    return <AdminGuardState backgroundColor={theme.background} textColor={theme.text} loading />;
  }
  if (!isAdmin) {
    return <AdminGuardState backgroundColor={theme.background} textColor={theme.text} />;
  }

  const filteredItems =
    filterStatus === 'all' ? items : items.filter(ad => ad.status === filterStatus);

  const getCompositeBadgeColors = (tone: ReturnType<typeof getCompositeAdBadge>['tone']) => {
    switch (tone) {
      case 'live':
        return { bg: '#DCFCE7', border: '#22C55E', text: '#166534' };
      case 'scheduled':
        return { bg: '#DBEAFE', border: '#60A5FA', text: '#1D4ED8' };
      case 'completed':
        return { bg: theme.surface, border: theme.border, text: theme.mutedText };
      case 'approved':
        return { bg: '#DBEAFE', border: '#3B82F6', text: '#1D4ED8' };
      case 'pending':
        return { bg: '#FEF3C7', border: '#F59E0B', text: '#92400E' };
      case 'rejected':
        return { bg: '#FEE2E2', border: '#DC2626', text: '#991B1B' };
      case 'archived':
        return { bg: theme.surface, border: theme.border, text: theme.mutedText };
      default:
        return { bg: theme.surface, border: theme.border, text: theme.text };
    }
  };

  const getModerationColors = (status?: string | null) => {
    switch (status) {
      case 'clean':
        return { bg: '#DCFCE7', border: '#22C55E', text: '#166534', label: 'Banner clean' };
      case 'flagged':
        return { bg: '#FEE2E2', border: '#DC2626', text: '#991B1B', label: 'Banner flagged' };
      case 'error':
        return { bg: '#FEF3C7', border: '#F59E0B', text: '#92400E', label: 'Moderation failed' };
      default:
        return null;
    }
  };

  const summarizeModerationLabels = (labels: any) => {
    if (!Array.isArray(labels) || labels.length === 0) return null;
    return labels
      .slice(0, 2)
      .map((label: any) => {
        const name = String(label?.name || 'Unknown');
        const confidence =
          typeof label?.confidence === 'number' ? Math.round(label.confidence) : null;
        return confidence ? `${name} ${confidence}%` : name;
      })
      .join(' • ');
  };

  const renderItem = ({ item }: { item: any }) => {
    const isSelected = selectedAds.has(String(item.id));

    return (
      <Pressable
        style={[
          styles.card,
          { backgroundColor: theme.card, borderColor: theme.border },
          bulkMode &&
            isSelected && {
              borderColor: theme.tint,
              borderWidth: 2,
            },
        ]}
        onPress={() => {
          if (bulkMode) {
            toggleAdSelection(String(item.id));
          } else {
            setDetailAd(item);
          }
        }}
      >
        <View style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start' }}>
          {bulkMode && (
            <View
              style={{
                width: 24,
                height: 24,
                borderRadius: 12,
                borderWidth: 2,
                borderColor: isSelected ? theme.tint : '#d1d5db',
                backgroundColor: isSelected ? theme.tint : 'transparent',
                alignItems: 'center',
                justifyContent: 'center',
                marginTop: 4,
              }}
            >
              {isSelected && <Ionicons name="checkmark" size={16} color="#ffffff" />}
            </View>
          )}

          {item.banner_url ? (
            <Image
              source={{ uri: optimizeImageUrl(item.banner_url, 600) }}
              style={styles.bannerPreview}
              contentFit="cover"
            />
          ) : (
            <View
              style={[
                styles.bannerPreview,
                { alignItems: 'center', justifyContent: 'center', backgroundColor: theme.surface },
              ]}
            >
              <Ionicons name="image-outline" size={24} color={theme.mutedText} />
            </View>
          )}

          <View style={{ flex: 1 }}>
            {(() => {
              const badge = getCompositeAdBadge(item.status, item.payment_status);
              const badgeColors = getCompositeBadgeColors(badge.tone);
              return (
                <>
                  <Text style={[styles.title, { color: theme.text }]}>
                    {item.business_name || '(no name)'}
                  </Text>
                  <Text style={[styles.meta, { color: theme.mutedText }]} numberOfLines={1}>
                    {item.contact_name || ''} {item.contact_email ? `· ${item.contact_email}` : ''}
                  </Text>
                  <Text style={[styles.meta, { color: theme.mutedText }]}>
                    <Ionicons name="location" size={12} /> Zip: {item.target_zip_code || 'N/A'}
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                    <View
                      style={[
                        styles.badgeSmall,
                        {
                          backgroundColor: badgeColors.bg,
                          borderColor: badgeColors.border,
                        },
                      ]}
                    >
                      <Text style={[styles.badgeSmallText, { color: badgeColors.text }]}>
                        {badge.label.toUpperCase()}
                      </Text>
                    </View>
                    {getModerationColors(item.banner_moderation_status) && (
                      <View
                        style={[
                          styles.badgeSmall,
                          {
                            backgroundColor: getModerationColors(item.banner_moderation_status)?.bg,
                            borderColor: getModerationColors(item.banner_moderation_status)?.border,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.badgeSmallText,
                            { color: getModerationColors(item.banner_moderation_status)?.text },
                          ]}
                        >
                          {getModerationColors(item.banner_moderation_status)?.label}
                        </Text>
                      </View>
                    )}
                  </View>
                  {item.payment_status ? (
                    <Text style={[styles.meta, { color: theme.mutedText, marginTop: 6 }]}>
                      Payment state: {String(item.payment_status).toUpperCase()}
                    </Text>
                  ) : null}
                  {item.banner_moderation_status === 'flagged' &&
                  summarizeModerationLabels(item.banner_moderation_labels) ? (
                    <Text style={[styles.meta, { color: '#B91C1C', marginTop: 6 }]}>
                      {summarizeModerationLabels(item.banner_moderation_labels)}
                    </Text>
                  ) : null}
                </>
              );
            })()}
          </View>
        </View>

        {!bulkMode && (
          <>
            <View style={{ height: 12 }} />
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {item.status === 'pending' && (
                <>
                  <Pressable
                    style={[
                      styles.btn,
                      {
                        backgroundColor: '#22c55e',
                        flex: 1,
                        opacity: reviewingAdId === item.id ? 0.6 : 1,
                      },
                    ]}
                    disabled={reviewingAdId === item.id}
                    onPress={() => {
                      setReviewNote('');
                      setOverrideReason('');
                      setReviewModal({
                        adId: item.id,
                        action: 'approve',
                        bannerModerationStatus: item.banner_moderation_status,
                      });
                    }}
                  >
                    {reviewingAdId === item.id ? (
                      <ActivityIndicator size={16} color="#fff" />
                    ) : (
                      <Ionicons name="checkmark-circle" size={16} color="#fff" />
                    )}
                    <Text style={styles.btnText}>
                      {reviewingAdId === item.id ? 'Saving...' : 'Approve'}
                    </Text>
                  </Pressable>
                  <Pressable
                    style={[
                      styles.btn,
                      {
                        backgroundColor: '#dc2626',
                        flex: 1,
                        opacity: reviewingAdId === item.id ? 0.6 : 1,
                      },
                    ]}
                    disabled={reviewingAdId === item.id}
                    onPress={() => {
                      setReviewNote('');
                      setOverrideReason('');
                      setReviewModal({
                        adId: item.id,
                        action: 'reject',
                        bannerModerationStatus: item.banner_moderation_status,
                      });
                    }}
                  >
                    <Ionicons name="close-circle" size={16} color="#fff" />
                    <Text style={styles.btnText}>Reject</Text>
                  </Pressable>
                </>
              )}
              <Pressable
                style={[
                  styles.btn,
                  styles.btnSecondary,
                  item.status === 'pending' || item.status === 'approved'
                    ? { flex: 0, paddingHorizontal: 16 }
                    : { flex: 1 },
                ]}
                onPress={() => void router.push({ pathname: '/edit-ad', params: { id: item.id } })}
              >
                <Ionicons name="pencil" size={16} color={theme.text} />
                {item.status !== 'pending' && item.status !== 'approved' && (
                  <Text style={[styles.btnText, { color: theme.text }]}>Edit</Text>
                )}
              </Pressable>
            </View>
          </>
        )}
      </Pressable>
    );
  };

  const renderHeaderRight = () => (
    <View style={{ flexDirection: 'row', gap: 12, marginRight: 8 }}>
      {bulkMode && (
        <>
          <Pressable onPress={selectAll} style={{ padding: 8 }}>
            <Text style={{ color: theme.tint, fontWeight: '600' }}>
              {selectedAds.size === filteredItems.length ? 'Deselect' : 'Select All'}
            </Text>
          </Pressable>
          <Pressable
            onPress={bulkApprove}
            disabled={selectedAds.size === 0 || updating}
            style={{ padding: 8 }}
          >
            <Text
              style={{ color: selectedAds.size > 0 ? '#22c55e' : '#9ca3af', fontWeight: '600' }}
            >
              Approve ({selectedAds.size})
            </Text>
          </Pressable>
          <Pressable
            onPress={bulkReject}
            disabled={selectedAds.size === 0 || updating}
            style={{ padding: 8 }}
          >
            <Text
              style={{ color: selectedAds.size > 0 ? '#f59e0b' : '#9ca3af', fontWeight: '600' }}
            >
              Reject ({selectedAds.size})
            </Text>
          </Pressable>
          <Pressable
            onPress={bulkDelete}
            disabled={selectedAds.size === 0 || updating}
            style={{ padding: 8 }}
          >
            <Text
              style={{ color: selectedAds.size > 0 ? '#dc2626' : '#9ca3af', fontWeight: '600' }}
            >
              Delete ({selectedAds.size})
            </Text>
          </Pressable>
        </>
      )}
      <Pressable onPress={() => setBulkMode(!bulkMode)} style={{ padding: 8 }}>
        <Ionicons
          name={bulkMode ? 'close' : 'checkmark-circle-outline'}
          size={24}
          color={bulkMode ? '#dc2626' : theme.tint}
        />
      </Pressable>
      <Pressable onPress={() => void router.push('/submit-ad')} style={{ padding: 8 }}>
        <Ionicons name="add-circle" size={24} color={theme.tint} />
      </Pressable>
    </View>
  );

  return (
    <AdminScreenShell
      title="Admin · Ads"
      backgroundColor={theme.background}
      onBack={() => safeGoBack(router)}
      headerRight={renderHeaderRight}
    >
      {/* Filter Tabs */}
      <View style={{ flexDirection: 'row', padding: 12, gap: 8, backgroundColor: theme.surface }}>
        {(['all', 'pending', 'approved', 'active', 'paused', 'draft'] as const).map(status => (
          <Pressable
            key={status}
            onPress={() => setFilterStatus(status)}
            style={[
              styles.filterTab,
              {
                backgroundColor: filterStatus === status ? theme.tint : theme.card,
                borderColor: filterStatus === status ? theme.tint : theme.border,
              },
            ]}
          >
            <Text
              style={{
                color: filterStatus === status ? '#fff' : theme.text,
                fontWeight: '600',
                fontSize: 13,
              }}
            >
              {status.charAt(0).toUpperCase() + status.slice(1)}
              {status !== 'all' && ` (${items.filter(a => a.status === status).length})`}
            </Text>
          </Pressable>
        ))}
      </View>

      {loading ? (
        <View style={{ padding: 24, alignItems: 'center' }}>
          <ActivityIndicator color={theme.tint} />
        </View>
      ) : null}

      {error ? (
        <Text style={[sharedStyles.centeredError, { color: '#dc2626' }]}>{error}</Text>
      ) : null}

      {!loading && !error && (
        <FlatList
          data={filteredItems}
          keyExtractor={a => String(a.id)}
          renderItem={renderItem}
          ItemSeparatorComponent={() => <View style={{ height: 12 }} />}
          contentContainerStyle={{ padding: 16, paddingBottom: 24 }}
          ListEmptyComponent={
            <View style={{ padding: 32, alignItems: 'center' }}>
              <Ionicons name="megaphone-outline" size={64} color={theme.mutedText} />
              <Text
                style={{ color: theme.mutedText, fontSize: 16, marginTop: 16, textAlign: 'center' }}
              >
                No ads found
                {filterStatus !== 'all' && ` with status "${filterStatus}"`}
              </Text>
            </View>
          }
        />
      )}
      {/* Ad Review Modal (cross-platform replacement for Alert.prompt) */}
      <Modal visible={!!reviewModal} transparent animationType="slide">
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
              backgroundColor: colorScheme === 'dark' ? '#1F2937' : 'white',
              borderRadius: 16,
              padding: 20,
              width: '100%',
              maxWidth: 400,
            }}
          >
            <Text style={{ fontSize: 18, fontWeight: '800', color: theme.text, marginBottom: 8 }}>
              {reviewModal?.action === 'approve' ? 'Approve Ad' : 'Reject Ad'}
            </Text>
            {reviewModal?.action === 'approve' &&
              reviewModal?.bannerModerationStatus === 'flagged' && (
                <View
                  style={{
                    backgroundColor: '#FEE2E2',
                    borderRadius: 8,
                    padding: 10,
                    marginBottom: 12,
                  }}
                >
                  <Text
                    style={{ color: '#991B1B', fontWeight: '700', fontSize: 13, marginBottom: 2 }}
                  >
                    ⚠️ Banner flagged by moderation
                  </Text>
                  <Text style={{ color: '#991B1B', fontSize: 12 }}>
                    You must provide an override reason to approve this ad.
                  </Text>
                </View>
              )}
            <Text style={{ color: theme.mutedText, marginBottom: 8 }}>
              {reviewModal?.action === 'approve'
                ? 'Add an optional note for the advertiser:'
                : 'Add a reason for the advertiser (optional):'}
            </Text>
            <TextInput
              style={{
                borderWidth: 1,
                borderColor: theme.border,
                borderRadius: 8,
                padding: 10,
                color: theme.text,
                backgroundColor: colorScheme === 'dark' ? '#111827' : '#F9FAFB',
                minHeight: 60,
                textAlignVertical: 'top',
              }}
              value={reviewNote}
              onChangeText={setReviewNote}
              placeholder="Note (optional)..."
              placeholderTextColor={theme.mutedText}
              multiline
            />
            {reviewModal?.action === 'approve' &&
              reviewModal?.bannerModerationStatus === 'flagged' && (
                <>
                  <Text
                    style={{ color: theme.mutedText, marginTop: 12, marginBottom: 6, fontSize: 13 }}
                  >
                    Override reason <Text style={{ color: '#DC2626' }}>*</Text> (required, min 10
                    chars):
                  </Text>
                  <TextInput
                    style={{
                      borderWidth: 1,
                      borderColor: overrideReason.trim().length > 0 ? theme.border : '#DC2626',
                      borderRadius: 8,
                      padding: 10,
                      color: theme.text,
                      backgroundColor: colorScheme === 'dark' ? '#111827' : '#F9FAFB',
                      minHeight: 60,
                      textAlignVertical: 'top',
                    }}
                    value={overrideReason}
                    onChangeText={setOverrideReason}
                    placeholder="Why is it safe to approve despite the flag?"
                    placeholderTextColor={theme.mutedText}
                    multiline
                  />
                </>
              )}
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 16 }}>
              <Pressable
                style={{
                  flex: 1,
                  paddingVertical: 10,
                  borderRadius: 8,
                  backgroundColor: theme.border,
                  alignItems: 'center',
                }}
                onPress={() => setReviewModal(null)}
              >
                <Text style={{ color: theme.text, fontWeight: '700' }}>Cancel</Text>
              </Pressable>
              <Pressable
                style={{
                  flex: 1,
                  paddingVertical: 10,
                  borderRadius: 8,
                  backgroundColor:
                    reviewModal?.action === 'approve' &&
                    reviewModal?.bannerModerationStatus === 'flagged' &&
                    overrideReason.trim().length < 10
                      ? '#9CA3AF'
                      : reviewModal?.action === 'approve'
                        ? '#22c55e'
                        : '#dc2626',
                  alignItems: 'center',
                }}
                disabled={
                  reviewModal?.action === 'approve' &&
                  reviewModal?.bannerModerationStatus === 'flagged' &&
                  overrideReason.trim().length < 10
                }
                onPress={async () => {
                  if (!reviewModal) return;
                  const { adId, action, bannerModerationStatus } = reviewModal;
                  setReviewModal(null);
                  setReviewingAdId(adId);
                  const isFlagged = action === 'approve' && bannerModerationStatus === 'flagged';
                  try {
                    await AdsApi.review(
                      adId,
                      action,
                      reviewNote.trim() || undefined,
                      isFlagged ? true : undefined,
                      isFlagged ? overrideReason.trim() : undefined
                    );
                    Alert.alert('Success', `Ad ${action === 'approve' ? 'approved' : 'rejected'}`);
                    await load();
                  } catch (e: any) {
                    if (isSessionExpiryError(e)) {
                      return;
                    }
                    Alert.alert('Error', toUserMessage(e, `Failed to ${action}`));
                  } finally {
                    setReviewingAdId(null);
                  }
                }}
              >
                <Text style={{ color: 'white', fontWeight: '700' }}>
                  {reviewModal?.action === 'approve' ? 'Approve' : 'Reject'}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Ad Detail Modal */}
      <Modal
        visible={!!detailAd}
        transparent
        animationType="slide"
        onRequestClose={() => setDetailAd(null)}
      >
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }}>
          <View
            style={{
              backgroundColor: theme.background,
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              maxHeight: '85%',
              paddingBottom: 34,
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
                paddingHorizontal: 16,
                paddingVertical: 14,
                borderBottomWidth: 1,
                borderBottomColor: theme.border,
              }}
            >
              <Text style={{ fontSize: 18, fontWeight: '700', color: theme.text }}>Ad Details</Text>
              <Pressable onPress={() => setDetailAd(null)}>
                <Ionicons name="close" size={24} color={theme.text} />
              </Pressable>
            </View>
            <ScrollView style={{ paddingHorizontal: 16, paddingTop: 12 }}>
              {detailAd?.banner_url ? (
                <Image
                  source={{ uri: optimizeImageUrl(detailAd.banner_url, 1200) }}
                  style={{ width: '100%', height: 200, borderRadius: 12, marginBottom: 16 }}
                  contentFit="cover"
                />
              ) : null}
              <Text style={{ fontSize: 20, fontWeight: '700', color: theme.text, marginBottom: 4 }}>
                {detailAd?.business_name || 'Untitled'}
              </Text>
              <Text style={{ fontSize: 14, color: theme.mutedText, marginBottom: 12 }}>
                Status: {String(detailAd?.status || 'draft').toUpperCase()} · Payment:{' '}
                {String(detailAd?.payment_status || 'unpaid').toUpperCase()}
              </Text>
              {detailAd?.description ? (
                <Text style={{ fontSize: 15, color: theme.text, marginBottom: 12, lineHeight: 22 }}>
                  {detailAd.description}
                </Text>
              ) : null}
              {getModerationColors(detailAd?.banner_moderation_status) ? (
                <View
                  style={{
                    backgroundColor: getModerationColors(detailAd?.banner_moderation_status)?.bg,
                    borderColor: getModerationColors(detailAd?.banner_moderation_status)?.border,
                    borderWidth: 1,
                    borderRadius: 12,
                    padding: 12,
                    marginBottom: 16,
                  }}
                >
                  <Text
                    style={{
                      color: getModerationColors(detailAd?.banner_moderation_status)?.text,
                      fontWeight: '800',
                      marginBottom: 4,
                    }}
                  >
                    {getModerationColors(detailAd?.banner_moderation_status)?.label}
                  </Text>
                  {detailAd?.banner_moderation_score ? (
                    <Text style={{ color: theme.text, marginBottom: 4 }}>
                      Highest confidence: {Math.round(detailAd.banner_moderation_score)}%
                    </Text>
                  ) : null}
                  {summarizeModerationLabels(detailAd?.banner_moderation_labels) ? (
                    <Text
                      style={{
                        color: theme.text,
                        marginBottom: detailAd?.banner_moderation_error ? 4 : 0,
                      }}
                    >
                      {summarizeModerationLabels(detailAd?.banner_moderation_labels)}
                    </Text>
                  ) : null}
                  {detailAd?.banner_moderation_error ? (
                    <Text style={{ color: theme.text }}>{detailAd.banner_moderation_error}</Text>
                  ) : null}
                </View>
              ) : null}
              <View style={{ gap: 6, marginBottom: 16 }}>
                <Text style={{ fontSize: 14, color: theme.mutedText }}>
                  Contact: {detailAd?.contact_name} · {detailAd?.contact_email}
                </Text>
                <Text style={{ fontSize: 14, color: theme.mutedText }}>
                  Target Zip: {detailAd?.target_zip_code || 'N/A'}
                </Text>
                {detailAd?.target_url ? (
                  <Text style={{ fontSize: 14, color: theme.tint }}>
                    URL: {detailAd.target_url}
                  </Text>
                ) : null}
              </View>
              {detailAd?.status === 'pending' && (
                <View style={{ flexDirection: 'row', gap: 8, marginBottom: 20 }}>
                  <Pressable
                    style={{
                      flex: 1,
                      paddingVertical: 12,
                      borderRadius: 8,
                      backgroundColor: '#22c55e',
                      alignItems: 'center',
                    }}
                    onPress={() => {
                      setDetailAd(null);
                      setReviewNote('');
                      setOverrideReason('');
                      setReviewModal({
                        adId: detailAd.id,
                        action: 'approve',
                        bannerModerationStatus: detailAd.banner_moderation_status,
                      });
                    }}
                  >
                    <Text style={{ color: '#fff', fontWeight: '700' }}>Approve</Text>
                  </Pressable>
                  <Pressable
                    style={{
                      flex: 1,
                      paddingVertical: 12,
                      borderRadius: 8,
                      backgroundColor: '#dc2626',
                      alignItems: 'center',
                    }}
                    onPress={() => {
                      setDetailAd(null);
                      setReviewNote('');
                      setOverrideReason('');
                      setReviewModal({
                        adId: detailAd.id,
                        action: 'reject',
                        bannerModerationStatus: detailAd.banner_moderation_status,
                      });
                    }}
                  >
                    <Text style={{ color: '#fff', fontWeight: '700' }}>Reject</Text>
                  </Pressable>
                </View>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </AdminScreenShell>
  );
}

const styles = StyleSheet.create({
  card: sharedStyles.elevatedListCard,
  title: sharedStyles.listTitle,
  meta: sharedStyles.listMeta,
  badgeSmall: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    borderWidth: 1,
  },
  badgeSmallText: { fontWeight: '800', fontSize: 10 },
  btn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 40,
    borderRadius: 10,
    backgroundColor: '#111827',
  },
  btnSecondary: {
    backgroundColor: '#F3F4F6',
    borderWidth: 1,
    borderColor: '#D1D5DB',
  },
  btnText: { color: 'white', fontWeight: '700', fontSize: 14 },
  bannerPreview: {
    width: 100,
    height: 70,
    borderRadius: 8,
    backgroundColor: '#D1D5DB',
  },
  filterTab: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1.5,
  },
});

export default AdminAdsScreen;
