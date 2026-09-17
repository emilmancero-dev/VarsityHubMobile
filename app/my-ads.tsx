import { Colors } from '@/constants/Colors';
import { useAuth } from '@/context/AuthProvider';
import { useColorScheme } from '@/hooks/useColorScheme';
import { getCompositeAdBadge } from '@/utils/adStatusBadge';
import { getAuthSnapshot } from '@/utils/authState';
import { optimizeImageUrl } from '@/utils/imageUrl';
import { safeGoBack } from '@/utils/navigation';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Image } from 'expo-image';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
// @ts-ignore
import { Advertisement as AdsApi } from '@/api/entities';
import settings from '@/api/settings';

type ManagedAd = {
  id: string;
  business_name: string;
  contact_name: string;
  contact_email: string;
  banner_url?: string;
  zip_code: string;
  description?: string;
  created_at: string;
  status?: string;
  payment_status?: string;
  admin_note?: string | null;
  owner_id?: string | null;
  isLocal?: boolean;
};

function MyAdsScreen() {
  const router = useRouter();
  const { payment_success } = useLocalSearchParams<{ payment_success?: string }>();
  const colorScheme = useColorScheme() ?? 'light';
  const { user, checkAuth } = useAuth();
  const [loading, setLoading] = useState(true);
  const [ads, setAds] = useState<ManagedAd[]>([]);
  const [datesByAd, setDatesByAd] = useState<Record<string, string[]>>({});
  const [userId, setUserId] = useState<string | null>(null);
  const [userLoaded, setUserLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);
  const successOpacity = useRef(new Animated.Value(0)).current;
  const hasLoadedOnceRef = useRef(false);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const me: any = await getAuthSnapshot(checkAuth, user);
        if (!mounted) return;
        setUserId(me?.id ? String(me.id) : null);
      } catch {
        if (!mounted) return;
        setUserId(null);
      } finally {
        if (mounted) setUserLoaded(true);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [checkAuth, user]);

  const getLocalAdsKey = useCallback(() => {
    const base = settings.SETTINGS_KEYS.LOCAL_ADS;
    return userId ? `${base}_${userId}` : base;
  }, [userId]);

  const load = useCallback(
    async ({ silent = false }: { silent?: boolean } = {}) => {
      const shouldBlock = !silent && !hasLoadedOnceRef.current;
      if (shouldBlock) setLoading(true);
      if (!silent) setLoadError(null);
      try {
        let serverAds: any[] | null = null;
        try {
          const s = await AdsApi.listMine();
          serverAds = Array.isArray(s) ? s : [];
        } catch {
          serverAds = null;
        }

        const localAds = await settings.getJson<ManagedAd[]>(getLocalAdsKey(), []);
        const combined: ManagedAd[] = [];
        const add = (a: any) => {
          const id = String(a.id);
          if (combined.find(x => x.id === id)) return;
          combined.push({
            id,
            business_name: String(a.business_name || a.name || ''),
            contact_name: String(a.contact_name || ''),
            contact_email: String(a.contact_email || ''),
            banner_url: a.banner_url || undefined,
            zip_code: String(a.target_zip_code || a.zip_code || ''),
            description: a.description || undefined,
            created_at: a.created_at || new Date().toISOString(),
            status: a.status,
            payment_status: a.payment_status,
            admin_note: a.admin_note ?? null,
            owner_id: a.owner_id,
          });
        };
        if (serverAds) serverAds.forEach(add);
        localAds.forEach(add);
        setAds(combined);

        // One request for every ad's reserved dates (was a fan-out of one
        // request per ad). The server scopes the result to the caller's ads.
        const map: Record<string, string[]> = {};
        try {
          const r: any = await AdsApi.reservationsGroupedByAd();
          const byAd = r?.by_ad && typeof r.by_ad === 'object' ? r.by_ad : {};
          for (const ad of combined) {
            map[ad.id] = Array.isArray(byAd[ad.id]) ? byAd[ad.id] : [];
          }
        } catch {
          for (const ad of combined) map[ad.id] = [];
        }
        setDatesByAd(map);
        hasLoadedOnceRef.current = true;
        setLoadError(null);
      } catch (e: any) {
        if (__DEV__) console.error('[my-ads] Error loading ads:', e);
        if (!silent || !hasLoadedOnceRef.current) {
          setLoadError('Unable to load your ads. Please try again.');
        }
      } finally {
        if (shouldBlock) setLoading(false);
      }
    },
    [getLocalAdsKey]
  );

  useEffect(() => {
    if (userLoaded) {
      void load();
    }
  }, [userLoaded, load]);

  // Auto-refresh when screen regains focus (e.g. after payment)
  useFocusEffect(
    useCallback(() => {
      if (userLoaded && hasLoadedOnceRef.current) void load({ silent: true });
    }, [userLoaded, load])
  );

  useEffect(() => {
    if (payment_success === 'true') {
      setShowSuccess(true);
      successOpacity.setValue(0);
      Animated.sequence([
        Animated.timing(successOpacity, { toValue: 1, duration: 200, useNativeDriver: true }),
        Animated.delay(1100),
        Animated.timing(successOpacity, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start(() => setShowSuccess(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- successOpacity is an Animated.Value (ref-like), adding it causes infinite loops
  }, [payment_success]);

  const remove = async (id: string) => {
    Alert.alert(
      'Delete Ad',
      'This will permanently remove your ad. Your payment is non-refundable. This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                // Delete from server
                await AdsApi.delete(id);

                // Also remove from local storage (both scoped and base keys)
                const scopedKey = getLocalAdsKey();
                const scopedList = await settings.getJson<ManagedAd[]>(scopedKey, []);
                await settings.setJson(
                  scopedKey,
                  scopedList.filter(a => a.id !== id)
                );

                // Also clean base key in case legacy entries exist
                const baseKey = settings.SETTINGS_KEYS.LOCAL_ADS;
                if (baseKey !== scopedKey) {
                  const baseList = await settings.getJson<ManagedAd[]>(baseKey, []);
                  await settings.setJson(
                    baseKey,
                    baseList.filter(a => a.id !== id)
                  );
                }

                // Reload the list
                await load({ silent: true });

                Alert.alert('Success', 'Ad deleted successfully');
              } catch (error) {
                if (__DEV__) console.error('[my-ads2] Error deleting ad:', error);
                Alert.alert('Error', 'Failed to delete ad. Please try again.');
              }
            })();
          },
        },
      ]
    );
  };

  const categorizeAdDates = (dates: string[]) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const past: string[] = [];
    const future: string[] = [];

    dates.forEach(dateStr => {
      try {
        const date = new Date(dateStr + 'T00:00:00');
        if (date < today) {
          past.push(dateStr);
        } else {
          future.push(dateStr);
        }
      } catch {
        // If date parsing fails, assume future
        future.push(dateStr);
      }
    });

    return { past, future };
  };

  const formatDate = (d: string) => {
    try {
      return new Date(d + 'T00:00:00').toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    } catch {
      return d;
    }
  };

  const MetaRow = ({
    icon,
    text,
  }: {
    icon: React.ComponentProps<typeof MaterialIcons>['name'];
    text: string;
  }) => (
    <View style={styles.metaRow}>
      <MaterialIcons name={icon} size={14} color={Colors[colorScheme].mutedText} />
      <Text style={[styles.metaText, { color: Colors[colorScheme].mutedText }]}>{text}</Text>
    </View>
  );

  const renderAd = ({ item }: { item: ManagedAd }) => {
    const dates = datesByAd[item.id] || [];
    const { past, future } = categorizeAdDates(dates);
    const hasCompleted = past.length > 0;
    const hasUpcoming = future.length > 0;
    const hasDates = dates.length > 0;
    const isPaid = item.payment_status === 'paid';
    // A rejected ad comes back from the server as status:'draft' WITH an
    // admin_note (the rejection reason) — the server deliberately reuses 'draft'
    // rather than a 'rejected' status (ad-state-invariants.test.ts). A fresh
    // draft has no admin_note, so (draft + note) is the reliable "was rejected"
    // signal. Without this the ad renders as an ordinary draft and the reason
    // (which the API returns) is shown nowhere on the screen where the user acts.
    const rejectionReason =
      item.status === 'draft' && item.admin_note ? String(item.admin_note).trim() : '';
    const isRejected = rejectionReason.length > 0;
    const badge = isRejected
      ? { label: 'Rejected', tone: 'rejected' as const }
      : getCompositeAdBadge(item.status, item.payment_status);
    const requiresEditBeforeScheduling = isRejected;
    const primaryActionLabel = isRejected
      ? 'Edit to Resubmit'
      : item.status === 'draft'
        ? 'Submit for Review'
        : item.status === 'pending'
          ? 'Awaiting Review'
          : item.status === 'archived'
            ? 'Run Again'
            : isPaid && hasDates
              ? '✓ Paid - Schedule More'
              : hasDates
                ? 'Schedule More'
                : 'Schedule Dates';

    return (
      <View
        style={[
          styles.card,
          { backgroundColor: Colors[colorScheme].card, borderColor: Colors[colorScheme].border },
        ]}
      >
        {/* Banner Section */}
        <View style={styles.bannerContainer}>
          {item.banner_url ? (
            <Image
              source={{ uri: optimizeImageUrl(item.banner_url, 600) }}
              style={styles.banner}
              contentFit="cover"
            />
          ) : (
            <View
              style={[
                styles.banner,
                styles.bannerPlaceholder,
                { backgroundColor: Colors[colorScheme].surface },
              ]}
            >
              <MaterialIcons name="image" size={40} color={Colors[colorScheme].mutedText} />
              <Text
                style={[styles.bannerPlaceholderText, { color: Colors[colorScheme].mutedText }]}
              >
                No banner
              </Text>
            </View>
          )}
        </View>

        {/* Info Section */}
        <View style={styles.infoContainer}>
          <Text style={[styles.businessName, { color: Colors[colorScheme].text }]}>
            {item.business_name}
          </Text>

          <MetaRow icon="person-outline" text={item.contact_name} />
          <MetaRow icon="mail-outline" text={item.contact_email} />
          <MetaRow icon="location-on" text={`Zip ${item.zip_code}`} />

          {/* Status Badges */}
          <View style={styles.badgesContainer}>
            <View style={[styles.badge, badgeStyleForTone(badge.tone, colorScheme)]}>
              <Text style={[styles.badgeText, badgeTextStyleForTone(badge.tone)]}>
                {badge.label.toUpperCase()}
              </Text>
            </View>
          </View>

          {/* Rejection reason — surfaced where the user acts on it, not only in
              email/push. Present only when the ad came back rejected. */}
          {isRejected ? (
            <View
              style={[
                styles.rejectionNotice,
                { backgroundColor: Colors[colorScheme].surface, borderColor: '#DC2626' },
              ]}
            >
              <MaterialIcons name="error-outline" size={16} color="#DC2626" />
              <Text style={[styles.rejectionText, { color: Colors[colorScheme].text }]}>
                {rejectionReason}
              </Text>
            </View>
          ) : null}
        </View>

        {/* Dates Section */}
        <View style={[styles.datesSection, { borderTopColor: Colors[colorScheme].border }]}>
          {/* Completed Dates */}
          {hasCompleted && (
            <>
              <View style={styles.datesSectionHeader}>
                <Text style={[styles.datesSectionTitle, { color: Colors[colorScheme].text }]}>
                  Completed ✅ ({past.length})
                </Text>
              </View>
              <View style={styles.datesBadgeWrap}>
                {past.slice(0, 5).map(d => (
                  <View
                    key={d}
                    style={[
                      styles.dateBadge,
                      styles.dateBadgeCompleted,
                      colorScheme === 'dark' && styles.dateBadgeCompletedDark,
                      { borderColor: Colors[colorScheme].border },
                    ]}
                  >
                    <Text
                      style={[
                        styles.dateBadgeText,
                        styles.dateBadgeTextCompleted,
                        { color: colorScheme === 'dark' ? '#6EE7B7' : '#065F46' },
                      ]}
                    >
                      {formatDate(d)}
                    </Text>
                  </View>
                ))}
                {past.length > 5 && (
                  <View
                    style={[
                      styles.dateBadge,
                      styles.dateBadgeCompleted,
                      colorScheme === 'dark' && styles.dateBadgeCompletedDark,
                    ]}
                  >
                    <Text
                      style={[
                        styles.dateBadgeText,
                        styles.dateBadgeTextCompleted,
                        { color: colorScheme === 'dark' ? '#6EE7B7' : '#065F46' },
                      ]}
                    >
                      +{past.length - 5}
                    </Text>
                  </View>
                )}
              </View>
              <View style={{ height: 10 }} />
            </>
          )}

          {/* Upcoming Dates */}
          {hasUpcoming && (
            <>
              <View style={styles.datesSectionHeader}>
                <Text style={[styles.datesSectionTitle, { color: Colors[colorScheme].text }]}>
                  Upcoming 📅 ({future.length})
                </Text>
              </View>
              <View style={styles.datesBadgeWrap}>
                {future.slice(0, 5).map(d => (
                  <View
                    key={d}
                    style={[
                      styles.dateBadge,
                      styles.dateBadgeUpcoming,
                      colorScheme === 'dark' && styles.dateBadgeUpcomingDark,
                      { borderColor: Colors[colorScheme].border },
                    ]}
                  >
                    <Text style={[styles.dateBadgeText, styles.dateBadgeTextUpcoming]}>
                      {formatDate(d)}
                    </Text>
                  </View>
                ))}
                {future.length > 5 && (
                  <View
                    style={[
                      styles.dateBadge,
                      styles.dateBadgeUpcoming,
                      colorScheme === 'dark' && styles.dateBadgeUpcomingDark,
                    ]}
                  >
                    <Text style={[styles.dateBadgeText, styles.dateBadgeTextUpcoming]}>
                      +{future.length - 5}
                    </Text>
                  </View>
                )}
              </View>
              <View style={{ height: 10 }} />
            </>
          )}

          {/* No Dates */}
          {!hasDates && (
            <>
              <View style={styles.datesSectionHeader}>
                <MaterialIcons name="event" size={16} color={Colors[colorScheme].text} />
                <Text style={[styles.datesSectionTitle, { color: Colors[colorScheme].text }]}>
                  Scheduled Dates
                </Text>
                <View style={[styles.datesCount, { backgroundColor: Colors[colorScheme].surface }]}>
                  <Text style={[styles.datesCountText, { color: Colors[colorScheme].text }]}>
                    0
                  </Text>
                </View>
              </View>
              <Text style={[styles.noDatesText, { color: Colors[colorScheme].mutedText }]}>
                No dates scheduled yet
              </Text>
            </>
          )}
        </View>

        {/* Actions Section */}
        <View style={styles.actionsContainer}>
          <Pressable
            style={[
              styles.actionButton,
              styles.actionButtonPrimary,
              { backgroundColor: Colors[colorScheme].tint },
            ]}
            onPress={() => {
              if (requiresEditBeforeScheduling) {
                void router.push({ pathname: '/edit-ad', params: { id: item.id } });
                return;
              }
              void router.push({
                pathname: '/ad-calendar',
                params: { adId: item.id, isPaid: String(isPaid) },
              });
            }}
          >
            <MaterialIcons name="event" size={18} color="#FFFFFF" />
            <Text style={styles.actionButtonTextPrimary}>{primaryActionLabel}</Text>
          </Pressable>

          <Pressable
            style={[
              styles.actionButton,
              styles.actionButtonSecondary,
              {
                backgroundColor: Colors[colorScheme].surface,
                borderColor: Colors[colorScheme].border,
              },
            ]}
            onPress={() => {
              void router.push({ pathname: '/edit-ad', params: { id: item.id } });
            }}
          >
            <MaterialIcons name="edit" size={18} color={Colors[colorScheme].text} />
            <Text style={[styles.actionButtonTextSecondary, { color: Colors[colorScheme].text }]}>
              Edit
            </Text>
          </Pressable>

          <Pressable
            style={[
              styles.actionButton,
              styles.actionButtonSecondary,
              {
                backgroundColor: Colors[colorScheme].surface,
                borderColor: Colors[colorScheme].border,
              },
            ]}
            onPress={() => remove(item.id)}
          >
            <MaterialIcons name="delete-outline" size={18} color="#EF4444" />
            <Text style={[styles.actionButtonTextSecondary, { color: '#EF4444' }]}>Remove</Text>
          </Pressable>
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView
      style={[styles.safeArea, { backgroundColor: Colors[colorScheme].background }]}
      edges={['top', 'left', 'right']}
    >
      <Stack.Screen options={{ headerShown: false }} />

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
          hitSlop={8}
          style={{ padding: 4 }}
        >
          <MaterialIcons name="chevron-left" size={24} color={Colors[colorScheme].text} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: Colors[colorScheme].text, flex: 1 }]}>
          My Ads
        </Text>
        <Pressable
          style={[styles.addButton, { backgroundColor: Colors[colorScheme].tint }]}
          onPress={() => {
            void router.push('/submit-ad');
          }}
        >
          <MaterialIcons name="add" size={24} color="#FFFFFF" />
        </Pressable>
      </View>

      <View style={[styles.container, { backgroundColor: Colors[colorScheme].background }]}>
        {loading && (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={Colors[colorScheme].tint} />
            <Text style={[styles.loadingText, { color: Colors[colorScheme].mutedText }]}>
              Loading your ads...
            </Text>
          </View>
        )}

        {!loading && loadError && (
          <View style={styles.emptyContainer}>
            <MaterialIcons name="error-outline" size={64} color="#EF4444" />
            <Text style={[styles.emptyTitle, { color: Colors[colorScheme].text }]}>
              Something went wrong
            </Text>
            <Text style={[styles.emptyText, { color: Colors[colorScheme].mutedText }]}>
              {loadError}
            </Text>
            <Pressable
              style={[styles.emptyButton, { backgroundColor: Colors[colorScheme].tint }]}
              onPress={() => void load()}
            >
              <Text style={styles.emptyButtonText}>Try Again</Text>
            </Pressable>
          </View>
        )}

        {!loading && !loadError && ads.length === 0 ? (
          <View style={styles.emptyContainer}>
            <MaterialIcons name="campaign" size={80} color={Colors[colorScheme].mutedText} />
            <Text style={[styles.emptyTitle, { color: Colors[colorScheme].text }]}>No Ads Yet</Text>
            <Text style={[styles.emptyText, { color: Colors[colorScheme].mutedText }]}>
              Create your first advertisement to start promoting your business to local teams and
              families.
            </Text>
            <Pressable
              style={[styles.emptyButton, { backgroundColor: Colors[colorScheme].tint }]}
              onPress={() => {
                void router.push('/submit-ad');
              }}
            >
              <MaterialIcons name="add-circle-outline" size={20} color="#FFFFFF" />
              <Text style={styles.emptyButtonText}>Create Your First Ad</Text>
            </Pressable>
          </View>
        ) : null}

        {!loading && ads.length > 0 && (
          <FlatList
            data={ads}
            keyExtractor={a => a.id}
            renderItem={renderAd}
            ItemSeparatorComponent={() => <View style={{ height: 16 }} />}
            contentContainerStyle={{
              padding: 16,
              paddingBottom: Platform.OS === 'ios' ? 34 : 24,
            }}
            showsVerticalScrollIndicator={false}
          />
        )}
      </View>

      {showSuccess && (
        <Animated.View
          style={[styles.successOverlay, { opacity: successOpacity, pointerEvents: 'none' }]}
        >
          <View style={styles.successBadge}>
            <Text style={[styles.successCheck, { color: Colors[colorScheme].text }]}>✓</Text>
            <Text style={[styles.successLabel, { color: Colors[colorScheme].text }]}>
              Payment Successful
            </Text>
          </View>
        </Animated.View>
      )}
    </SafeAreaView>
  );
}

function badgeStyleForTone(tone: string, colorScheme: 'light' | 'dark' = 'light') {
  if (tone === 'live')
    return {
      backgroundColor: colorScheme === 'dark' ? '#065F46' : '#DCFCE7',
      borderColor: colorScheme === 'dark' ? '#10B981' : '#86EFAC',
    };
  if (tone === 'approved')
    return {
      backgroundColor: colorScheme === 'dark' ? '#064E3B' : '#D1FAE5',
      borderColor: colorScheme === 'dark' ? '#34D399' : '#6EE7B7',
    };
  if (tone === 'pending')
    return {
      backgroundColor: colorScheme === 'dark' ? '#92400E' : '#FEF9C3',
      borderColor: colorScheme === 'dark' ? '#FBBF24' : '#FDE68A',
    };
  if (tone === 'rejected')
    return {
      backgroundColor: colorScheme === 'dark' ? '#7F1D1D' : '#FEE2E2',
      borderColor: colorScheme === 'dark' ? '#EF4444' : '#FCA5A5',
    };
  if (tone === 'archived')
    return {
      backgroundColor: colorScheme === 'dark' ? '#374151' : '#F3F4F6',
      borderColor: colorScheme === 'dark' ? '#6B7280' : '#D1D5DB',
    };
  return {
    backgroundColor: colorScheme === 'dark' ? '#1E3A8A' : '#E0E7FF',
    borderColor: colorScheme === 'dark' ? '#3B82F6' : '#C7D2FE',
  };
}
function badgeTextStyleForTone(tone: string) {
  if (tone === 'live') return { color: '#10B981' };
  if (tone === 'approved') return { color: '#059669' };
  if (tone === 'pending') return { color: '#F59E0B' };
  if (tone === 'rejected') return { color: '#EF4444' };
  if (tone === 'archived') return { color: Colors.light.mutedText };
  return { color: '#3B82F6' };
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'android' ? 14 : 8,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  headerTitle: {
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  addButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    marginHorizontal: 16,
    marginVertical: 8,
    borderRadius: 16,
    borderWidth: 1,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 8,
    elevation: 3,
  },
  bannerContainer: {
    width: '100%',
    height: 140,
    position: 'relative',
  },
  banner: {
    width: '100%',
    height: '100%',
  },
  bannerPlaceholder: {
    width: '100%',
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#D1D5DB',
  },
  bannerPlaceholderText: {
    marginTop: 6,
    fontSize: 12,
    color: Colors.light.mutedText,
  },
  infoContainer: {
    padding: 16,
  },
  businessName: {
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 10,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  metaText: {
    fontSize: 14,
    marginLeft: 8,
    flex: 1,
  },
  badgesContainer: {
    flexDirection: 'row',
    marginTop: 10,
    flexWrap: 'wrap',
    gap: 8,
  },
  rejectionNotice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginTop: 10,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
  },
  rejectionText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
  },
  badge: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 12,
    borderWidth: 1,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  datesSection: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderTopWidth: 1,
  },
  datesSectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  datesSectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    marginLeft: 6,
    flex: 1,
  },
  datesCount: {
    backgroundColor: '#EF4444',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    minWidth: 24,
    alignItems: 'center',
  },
  datesCountText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#FFF',
  },
  datesBadgeWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  dateBadge: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: '#F3F4F6',
    borderWidth: 1,
    borderColor: '#D1D5DB',
  },
  dateBadgeCompleted: {
    backgroundColor: '#D1FAE5',
    borderColor: '#10B981',
  },
  dateBadgeCompletedDark: {
    backgroundColor: 'rgba(16, 185, 129, 0.2)',
    borderColor: '#10B981',
  },
  dateBadgeUpcoming: {
    backgroundColor: '#DBEAFE',
    borderColor: '#3B82F6',
  },
  dateBadgeUpcomingDark: {
    backgroundColor: 'rgba(59, 130, 246, 0.2)',
    borderColor: '#3B82F6',
  },
  dateBadgeText: {
    fontSize: 12,
    fontWeight: '500',
    color: Colors.light.text,
  },
  dateBadgeTextCompleted: {
    color: '#065F46',
    fontWeight: '600',
  },
  dateBadgeTextUpcoming: {
    color: '#1E40AF',
    fontWeight: '600',
  },
  noDatesText: {
    fontSize: 13,
    fontStyle: 'italic',
  },
  actionsContainer: {
    flexDirection: 'row',
    borderTopWidth: 1,
  },
  actionButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    gap: 6,
  },
  actionButtonPrimary: {
    borderRightWidth: 1,
  },
  actionButtonSecondary: {
    borderRightWidth: 1,
  },
  actionButtonTextPrimary: {
    fontSize: 14,
    fontWeight: '600',
  },
  actionButtonTextSecondary: {
    fontSize: 14,
    fontWeight: '600',
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 60,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 16,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingTop: 80,
  },
  emptyTitle: {
    fontSize: 22,
    fontWeight: '700',
    marginTop: 20,
    marginBottom: 8,
    textAlign: 'center',
  },
  emptyText: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 28,
  },
  emptyButton: {
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 12,
  },
  emptyButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFF',
  },
  successOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
    zIndex: 100,
  },
  successBadge: {
    backgroundColor: '#FFD700',
    borderRadius: 20,
    paddingVertical: 28,
    paddingHorizontal: 48,
    alignItems: 'center',
    gap: 8,
  },
  successCheck: {
    fontSize: 52,
    fontWeight: '800',
  },
  successLabel: {
    fontSize: 16,
    fontWeight: '700',
  },
});

export default MyAdsScreen;
