import { Advertisement } from '@/api/entities';
import { Colors } from '@/constants/Colors';
import { flushPendingAdVerifications } from '@/hooks/useAdIAP';
import { useColorScheme } from '@/hooks/useColorScheme';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BackHeader } from '@/components/ui/BackHeader';
import { getAdScheduleBucket } from '@/utils/adStatusBadge';
import { safeGoBack } from '@/utils/navigation';

function ConfirmationDetailItem({
  icon,
  label,
  value,
  textColor,
  mutedTextColor,
}: {
  icon: React.ComponentProps<typeof MaterialIcons>['name'];
  label: string;
  value: ReactNode;
  textColor: string;
  mutedTextColor: string;
}) {
  return (
    <View style={styles.detailRow}>
      <MaterialIcons name={icon} size={24} color="#10B981" />
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text style={[styles.detailLabel, { color: mutedTextColor }]}>{label}</Text>
        <Text style={[styles.detailValue, { color: textColor }]}>{value}</Text>
      </View>
    </View>
  );
}

function AdConfirmationScreen() {
  const router = useRouter();
  const colorScheme = useColorScheme() ?? 'light';
  const theme = Colors[colorScheme];
  const { width } = useWindowDimensions();
  const isLargeScreen = width >= 768;
  const params = useLocalSearchParams<{
    ad_id?: string;
    businessName?: string;
    selectedDates?: string;
    totalAmount?: string;
    purchasedHours?: string;
    purchasedDays?: string;
  }>();

  const [adDetails, setAdDetails] = useState<any>(null);
  const [loading, setLoading] = useState(!!params.ad_id);
  const [paymentVerified, setPaymentVerified] = useState(false);
  const [pollError, setPollError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    void flushPendingAdVerifications();
  }, []);

  useEffect(() => {
    if (params.ad_id) {
      const adId = params.ad_id.trim();
      if (!adId || adId.length < 10) {
        if (__DEV__) console.error('[AdConfirmation] Invalid ad_id format:', adId);
        setLoading(false);
        return;
      }

      let attempt = 0;
      const maxPollAttempts = 10;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let cancelled = false;

      const poll = async () => {
        if (cancelled) return;
        try {
          const data = await Advertisement.get(adId);
          if (cancelled) return;
          if (!data || !data.id) throw new Error('Invalid ad data received');
          setAdDetails(data);
          if (data.payment_status === 'paid') {
            setPaymentVerified(true);
            setLoading(false);
            return;
          }
          attempt++;
          if (attempt < maxPollAttempts) {
            timer = setTimeout(poll, 3000);
          } else {
            setPollError(true);
            setLoading(false);
          }
        } catch (err) {
          if (cancelled) return;
          if (__DEV__) console.error('[AdConfirmation] Failed to load ad details:', err);
          attempt++;
          if (attempt < maxPollAttempts) {
            timer = setTimeout(poll, 3000);
          } else {
            setPollError(true);
            setLoading(false);
          }
        }
      };

      void poll();
      return () => {
        cancelled = true;
        if (timer) clearTimeout(timer);
      };
    } else {
      if (!params.businessName && !params.selectedDates && !params.totalAmount) {
        if (__DEV__) console.warn('[AdConfirmation] Missing ad_id and manual params');
      }
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- retryCount triggers re-poll
  }, [params.ad_id, retryCount]);

  const businessName = adDetails?.business_name || params.businessName || 'Your Business';
  const selectedDates =
    Array.isArray(adDetails?.dates) && adDetails.dates.length > 0
      ? adDetails.dates.join(', ')
      : params.selectedDates || 'your selected dates';
  const totalAmount = params.totalAmount || '$0.00';
  const _parsedHours = parseInt(params.purchasedHours ?? '', 10);
  const purchasedHours = Number.isFinite(_parsedHours) ? _parsedHours : null;
  const _parsedDays = parseInt(params.purchasedDays ?? '', 10);
  const purchasedDays = Number.isFinite(_parsedDays) ? _parsedDays : null;
  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: theme.background }]}
      edges={['top', 'bottom']}
    >
      <Stack.Screen options={{ headerShown: false }} />
      <BackHeader
        title="Ad Confirmation"
        backgroundColor={theme.background}
        textColor={theme.text}
        borderColor={theme.border}
      />

      {loading ? (
        <View style={styles.loadingContainer}>
          <View style={styles.stateInner}>
            <ActivityIndicator size="large" color="#10B981" />
            <Text style={[styles.loadingText, { color: theme.mutedText }]}>
              Activating your ad...
            </Text>
          </View>
        </View>
      ) : pollError && !paymentVerified ? (
        <View style={styles.loadingContainer}>
          <View style={styles.stateInner}>
            <MaterialIcons name="hourglass-top" size={48} color="#F59E0B" />
            <Text
              style={[styles.loadingText, { color: theme.text, fontWeight: '700', marginTop: 12 }]}
            >
              Payment Processing
            </Text>
            <Text style={[styles.loadingText, { color: theme.mutedText, marginTop: 4 }]}>
              Your payment is being processed. You'll receive an email confirmation once your ad is
              active.
            </Text>
            <Pressable
              onPress={() => {
                setPollError(false);
                setLoading(true);
                setRetryCount(c => c + 1);
              }}
              style={{
                marginTop: 20,
                backgroundColor: '#10B981',
                paddingHorizontal: 24,
                paddingVertical: 12,
                borderRadius: 8,
              }}
            >
              <Text style={{ color: '#fff', fontWeight: '600' }}>Try Again</Text>
            </Pressable>
            <Pressable onPress={() => setPollError(false)} style={{ marginTop: 12 }}>
              <Text style={{ color: theme.tint, fontWeight: '600' }}>Continue Anyway</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <View style={[styles.contentInner, isLargeScreen && styles.contentInnerLarge]}>
            {/* Success Animation */}
            <View style={styles.animationContainer}>
              <View
                style={[
                  styles.successCircle,
                  { backgroundColor: colorScheme === 'dark' ? '#065F46' : '#D1FAE5' },
                ]}
              >
                <MaterialIcons name="check-circle" size={100} color="#10B981" />
              </View>
            </View>

            {/* Success Message — title only claims "live" once the server has both
                confirmed payment AND transitioned the ad's status to active. While
                payment is still processing or the ad is sitting in approved-but-not-yet-active,
                the title hedges to match the subtitle so the screen doesn't overstate. */}
            {(() => {
              const isTrulyLive =
                paymentVerified &&
                (adDetails as any)?.status === 'active' &&
                getAdScheduleBucket(
                  Array.isArray((adDetails as any)?.dates) ? (adDetails as any).dates : []
                ) === 'live';
              return (
                <View style={styles.messageContainer}>
                  <Text style={[styles.title, { color: theme.text }]}>
                    {isTrulyLive ? 'Your Ad is Live!' : 'Payment Received — Ad Going Live Shortly'}
                  </Text>
                  <Text style={[styles.subtitle, { color: theme.mutedText }]}>
                    {isTrulyLive
                      ? 'Your payment was successful and your ad campaign is now active.'
                      : paymentVerified
                        ? 'Your payment is confirmed. Your ad will be active shortly — typically within a few minutes.'
                        : 'Your payment is being processed. Your ad will be active shortly.'}
                  </Text>
                </View>
              );
            })()}

            {/* Details Card */}
            <LinearGradient
              colors={colorScheme === 'dark' ? ['#1E1E1E', '#121212'] : ['#ffffff', '#f8fafc']}
              style={[styles.detailsCard, { borderColor: Colors[colorScheme].border }]}
            >
              <ConfirmationDetailItem
                icon="business"
                label="Business Name"
                value={businessName}
                textColor={Colors[colorScheme].text}
                mutedTextColor={Colors[colorScheme].mutedText}
              />

              <View style={[styles.divider, { backgroundColor: Colors[colorScheme].border }]} />

              <ConfirmationDetailItem
                icon="event"
                label="Campaign Dates"
                value={selectedDates}
                textColor={Colors[colorScheme].text}
                mutedTextColor={Colors[colorScheme].mutedText}
              />

              {purchasedHours !== null && (
                <>
                  <View style={[styles.divider, { backgroundColor: Colors[colorScheme].border }]} />
                  <ConfirmationDetailItem
                    icon="schedule"
                    label="Total Exposure"
                    value={`${purchasedHours} hours${
                      purchasedDays !== null
                        ? ` (${purchasedDays} day${purchasedDays === 1 ? '' : 's'})`
                        : ''
                    }`}
                    textColor={Colors[colorScheme].text}
                    mutedTextColor={Colors[colorScheme].mutedText}
                  />
                </>
              )}

              <ConfirmationDetailItem
                icon="payments"
                label="Total Paid"
                value={totalAmount}
                textColor={Colors[colorScheme].text}
                mutedTextColor={Colors[colorScheme].mutedText}
              />
            </LinearGradient>

            {/* Action Buttons */}
            <View style={styles.actions}>
              <Pressable
                style={[styles.primaryButton, { backgroundColor: '#10B981' }]}
                onPress={() => {
                  safeGoBack(router, '/my-ads');
                }}
              >
                <MaterialIcons name="work" size={20} color="#ffffff" />
                <Text style={styles.primaryButtonText}>View My Ads</Text>
              </Pressable>

              <Pressable
                style={[
                  styles.secondaryButton,
                  {
                    borderColor: theme.border,
                    backgroundColor: theme.card,
                  },
                ]}
                onPress={() => {
                  safeGoBack(router, '/(tabs)/feed');
                }}
              >
                <MaterialIcons name="home" size={20} color={theme.text} />
                <Text style={[styles.secondaryButtonText, { color: theme.text }]}>
                  Back to Feed
                </Text>
              </Pressable>
            </View>

            {/* Support Link */}
            <Pressable style={styles.supportLink} onPress={() => void router.push('/help')}>
              <MaterialIcons name="help-outline" size={16} color={theme.mutedText} />
              <Text style={[styles.supportText, { color: theme.mutedText }]}>
                Need help? Contact Support
              </Text>
            </Pressable>
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 16,
  },
  loadingText: {
    fontSize: 17,
    fontWeight: '600',
    lineHeight: 24,
    textAlign: 'center',
  },
  stateInner: {
    width: '100%',
    maxWidth: 560,
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  content: {
    padding: 24,
    paddingBottom: 48,
  },
  contentInner: {
    width: '100%',
    alignSelf: 'center',
  },
  contentInnerLarge: {
    maxWidth: 860,
  },
  animationContainer: {
    alignItems: 'center',
    marginTop: 20,
    marginBottom: 32,
  },
  successCircle: {
    width: 140,
    height: 140,
    borderRadius: 70,
    alignItems: 'center',
    justifyContent: 'center',
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 10px 20px rgba(16, 185, 129, 0.3)' }
      : {
          shadowColor: '#10B981',
          shadowOpacity: 0.3,
          shadowRadius: 20,
          shadowOffset: { width: 0, height: 10 },
        }),
    elevation: 8,
  },
  messageContainer: {
    alignItems: 'center',
    marginBottom: 32,
  },
  title: {
    fontSize: 28,
    fontWeight: '800',
    textAlign: 'center',
    marginBottom: 12,
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 17,
    textAlign: 'center',
    lineHeight: 26,
    maxWidth: 520,
  },
  previewSection: {
    borderRadius: 16,
    borderWidth: 1,
    padding: 16,
    marginBottom: 24,
    overflow: 'hidden',
  },
  previewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  previewTitle: {
    fontSize: 15,
    fontWeight: '700',
  },
  bannerContainer: {
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: 8,
  },
  bannerImage: {
    width: '100%',
    aspectRatio: 16 / 9,
  },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingTop: 8,
  },
  linkText: {
    fontSize: 13,
    flex: 1,
  },
  detailsCard: {
    borderRadius: 20,
    borderWidth: 1,
    padding: 24,
    marginBottom: 24,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 4px 12px rgba(0, 0, 0, 0.05)' }
      : {
          shadowColor: '#000',
          shadowOpacity: 0.05,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 4 },
        }),
    elevation: 3,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  detailLabel: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  detailValue: {
    fontSize: 17,
    fontWeight: '700',
  },
  divider: {
    height: 1,
    marginVertical: 20,
  },
  infoBox: {
    flexDirection: 'row',
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 32,
  },
  infoText: {
    fontSize: 15,
    lineHeight: 22,
  },
  actions: {
    gap: 12,
    marginBottom: 24,
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 16,
    borderRadius: 12,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 4px 8px rgba(16, 185, 129, 0.25)' }
      : {
          shadowColor: '#10B981',
          shadowOpacity: 0.25,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 4 },
        }),
    elevation: 4,
  },
  primaryButtonText: {
    color: '#ffffff',
    fontSize: 17,
    fontWeight: '700',
  },
  secondaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 16,
    borderRadius: 12,
    borderWidth: 1,
  },
  secondaryButtonText: {
    fontSize: 17,
    fontWeight: '600',
  },
  supportLink: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
  },
  supportText: {
    fontSize: 14,
    fontWeight: '600',
  },
});

export default AdConfirmationScreen;
