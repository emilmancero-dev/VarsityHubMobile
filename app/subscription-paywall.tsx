/**
 * League Subscription Paywall
 *
 * Only shown to league owners — coaches are covered by their league owner's plan.
 * iOS: Uses Apple IAP (react-native-iap) for MIDTIER / TOPTIER
 * Android: Uses Google Play Billing (react-native-iap) for MIDTIER / TOPTIER
 * Web: checkout is disabled (mobile app only)
 * Other fallback: Uses Stripe Payment Sheets
 */

// @ts-ignore
import { Payments } from '@/api/entities';
import { CoachTier, CoachTierBadge, CoachTierBenefits } from '@/components/CoachTierBadge';
import CustomActionModal from '@/components/CustomActionModal';
import { Colors } from '@/constants/Colors';
import { useColorScheme } from '@/hooks/useColorScheme';
import { useAuth } from '@/context/AuthProvider';
import { useVHubIAP } from '@/hooks/useIAP';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Stack, useRouter } from 'expo-router';
import { safeGoBack } from '@/utils/navigation';
import { toUserMessage } from '@/utils/toUserMessage';
import { openExternalUrl } from '@/utils/openExternalUrl';
import { usePaymentSheet } from '@/utils/stripe';
import { useCallback, useEffect, useState } from 'react';
import { captureBreadcrumb } from '@/utils/sentry';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PUBLIC_PRIVACY_POLICY_URL } from '@/constants/legal';
import { ROOKIE_PROGRAM_LIMIT } from '@/constants/plans';
import { SubscriptionDisclosureCard } from '@/components/subscription/SubscriptionDisclosureCard';
import { getFreshAuthSnapshot } from '@/utils/authState';
import { getCanonicalBillingState } from '@/utils/billingState';

const isIOS = Platform.OS === 'ios';

function SubscriptionPaywallScreen() {
  const router = useRouter();
  const colorScheme = useColorScheme() ?? 'light';
  const theme = Colors[colorScheme];
  const { checkAuth, user } = useAuth();
  const { width } = useWindowDimensions();
  const isLargeScreen = width >= 768;
  const [selectedTier, setSelectedTier] = useState<CoachTier>('veteran');
  const [loading, setLoading] = useState(false);
  const [promoCode, setPromoCode] = useState('');
  const availableTiers: CoachTier[] = ['rookie', 'veteran', 'legend'];
  const [isNonOwnerCoach, setIsNonOwnerCoach] = useState(false);
  const [checkingAccess, setCheckingAccess] = useState(true);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const me: any = await getFreshAuthSnapshot(checkAuth, user);
        if (!mounted) return;
        if (!me) {
          setIsNonOwnerCoach(false);
          return;
        }
        const billing = getCanonicalBillingState(me);
        if (billing.pending_plan === 'veteran' || billing.pending_plan === 'legend') {
          setSelectedTier(billing.pending_plan);
        }
        // Check if coach is covered by league owner
        if (me?.paid_by_owner === true) {
          setIsNonOwnerCoach(true);
        }
      } catch (error) {
        if (__DEV__) console.warn('[subscription-paywall] Failed to refresh auth snapshot:', error);
      }
      if (mounted) {
        setCheckingAccess(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [checkAuth, user, user?.id]);

  const waitForPaidPlanActivation = useCallback(async () => {
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const fresh: any = await checkAuth({ forceRefresh: true }).catch(() => null);
        const billing = getCanonicalBillingState(fresh);
        if (
          (billing.plan === 'veteran' || billing.plan === 'legend') &&
          !billing.payment_pending &&
          !billing.pending_plan
        ) {
          return true;
        }
      } catch {
        /* ignore — keep polling */
      }
    }
    return false;
  }, [checkAuth]);
  const { initPaymentSheet, presentPaymentSheet } = usePaymentSheet();
  const {
    connected: iapConnected,
    purchasing: iapPurchasing,
    purchase: iapPurchase,
    restore: iapRestore,
    getProduct,
    error: iapError,
  } = useVHubIAP();
  const [modal, setModal] = useState<{
    visible: boolean;
    title: string;
    message?: string;
    options: Array<{ label: string; onPress: () => void; color?: string }>;
  } | null>(null);

  // Get IAP price string for display (iOS and Android)
  const getIAPPrice = (tier: 'veteran' | 'legend'): string | null => {
    const product = getProduct(tier);
    return product?.displayPrice || null;
  };

  const handleSubscribe = async () => {
    captureBreadcrumb('Subscription checkout initiated from paywall', 'payments.subscription', {
      tier: selectedTier,
      platform: Platform.OS,
      has_promo_code: promoCode.trim().length > 0,
    });
    if (selectedTier === 'rookie') {
      Alert.alert(
        'Free Plan',
        'You are already on the free Rookie plan, or to downgrade please cancel your current subscription in your device settings.',
        [{ text: 'OK', onPress: () => safeGoBack(router) }]
      );
      return;
    }

    // iOS and Android: Use native IAP (Apple IAP / Google Play Billing)
    if (isIOS || Platform.OS === 'android') {
      if (!iapConnected) {
        const msg = isIOS
          ? 'Unable to connect to the App Store. Ensure you are using an EAS build (not Expo Go), have a Sandbox Apple ID for testing, and products are "Ready to Submit" in App Store Connect.'
          : 'Unable to connect to Google Play. Ensure you are using an EAS build (not Expo Go) and products are configured in Play Console.';
        setModal({
          visible: true,
          title: 'Store Unavailable',
          message: msg,
          options: [{ label: 'OK', onPress: () => setModal(null), color: '#2563EB' }],
        });
        return;
      }

      setLoading(true);
      try {
        const success = await iapPurchase(selectedTier as 'veteran' | 'legend');
        captureBreadcrumb('Native subscription purchase returned', 'payments.subscription', {
          tier: selectedTier,
          success,
          entry: 'subscription_paywall',
        });
        if (success) {
          const planActivated = await waitForPaidPlanActivation();
          if (planActivated) {
            captureBreadcrumb(
              'Subscription activation confirmed after native purchase',
              'payments.subscription',
              {
                tier: selectedTier,
                entry: 'subscription_paywall',
              }
            );
            Alert.alert('Success', 'Your subscription is now active!', [
              {
                text: 'OK',
                onPress: () => {
                  safeGoBack(router);
                },
              },
            ]);
          } else {
            captureBreadcrumb(
              'Subscription activation still pending after native purchase',
              'payments.subscription',
              {
                tier: selectedTier,
                entry: 'subscription_paywall',
              },
              'warning'
            );
            Alert.alert(
              'Payment Received',
              "Your subscription is being processed. You'll receive a confirmation email shortly.",
              [
                {
                  text: 'OK',
                  onPress: () => {
                    safeGoBack(router);
                  },
                },
              ]
            );
          }
        }
      } catch (err: any) {
        captureBreadcrumb(
          'Native subscription purchase failed from paywall',
          'payments.subscription',
          {
            tier: selectedTier,
            entry: 'subscription_paywall',
            error: err?.message || 'unknown_error',
          },
          'error'
        );
        setModal({
          visible: true,
          title: 'Purchase Failed',
          message: toUserMessage(err, 'Unable to complete purchase. Please try again.'),
          options: [{ label: 'OK', onPress: () => setModal(null), color: '#DC2626' }],
        });
      } finally {
        setLoading(false);
      }
      return;
    }

    if (Platform.OS === 'web') {
      setModal({
        visible: true,
        title: 'Web checkout unavailable',
        message:
          'Subscription checkout is currently supported in the mobile app only. Please continue on iOS or Android.',
        options: [{ label: 'OK', onPress: () => setModal(null), color: '#2563EB' }],
      });
      return;
    }

    // Non-mobile fallback: Use Stripe PaymentSheet
    setLoading(true);
    try {
      captureBreadcrumb('Subscription payment sheet request started', 'payments.subscription', {
        tier: selectedTier,
        entry: 'subscription_paywall',
        has_promo_code: promoCode.trim().length > 0,
      });
      const data: any = await Payments.createPaymentSheet({
        plan: selectedTier,
        promo_code: promoCode.trim() || undefined,
      });

      if (data?.paymentIntent && typeof data.paymentIntent === 'string') {
        captureBreadcrumb('Subscription payment sheet init started', 'payments.subscription', {
          tier: selectedTier,
          entry: 'subscription_paywall',
        });
        // Stripe fallback (non-mobile only) — no Apple Pay needed since iOS uses IAP
        const { error: initError } = await initPaymentSheet({
          paymentIntentClientSecret: data.paymentIntent,
          customerEphemeralKeySecret: data.ephemeralKey,
          customerId: data.customer,
          merchantDisplayName: 'Varsity Hub',
          googlePay:
            (Platform.OS as string) === 'android'
              ? { merchantCountryCode: 'US', testEnv: __DEV__ }
              : undefined,
          paymentMethodOrder: ['google_pay', 'card'],
        });
        if (initError) {
          captureBreadcrumb(
            'Subscription payment sheet init failed',
            'payments.subscription',
            {
              tier: selectedTier,
              entry: 'subscription_paywall',
              error: initError.message,
            },
            'error'
          );
          Alert.alert('Error', toUserMessage(initError, 'Payment setup failed. Please try again.'));
          return;
        }
        captureBreadcrumb('Subscription payment sheet presented', 'payments.subscription', {
          tier: selectedTier,
          entry: 'subscription_paywall',
        });
        const { error } = await presentPaymentSheet();
        if (error) {
          captureBreadcrumb(
            'Subscription payment sheet failed',
            'payments.subscription',
            {
              tier: selectedTier,
              entry: 'subscription_paywall',
              code: error.code,
              error: error.message || 'unknown_error',
            },
            error.code === 'Canceled' ? 'info' : 'error'
          );
          if (error.code !== 'Canceled')
            Alert.alert('Payment Failed', toUserMessage(error, 'Payment could not be completed.'));
          // Clean up: cancel the incomplete PaymentIntent so the subscription doesn't linger
          if (data.payment_intent_id) {
            Payments.cancelIntent(data.payment_intent_id).catch(() => {});
          }
          return;
        }
        captureBreadcrumb('Subscription payment sheet completed', 'payments.subscription', {
          tier: selectedTier,
          entry: 'subscription_paywall',
        });
        // Poll for plan activation (webhook may take a moment) — 15 attempts × 2s = 30s max
        const planActivated = await waitForPaidPlanActivation();
        if (!planActivated) {
          captureBreadcrumb(
            'Subscription activation pending after payment sheet',
            'payments.subscription',
            {
              tier: selectedTier,
              entry: 'subscription_paywall',
            },
            'warning'
          );
          Alert.alert(
            'Payment Received',
            'Your subscription is being processed. It may take a moment to activate.'
          );
        }
        safeGoBack(router);
      } else {
        throw new Error('No payment sheet data received');
      }
    } catch (error: any) {
      if (__DEV__) console.error('Subscription error:', error);
      captureBreadcrumb(
        'Subscription checkout failed from paywall',
        'payments.subscription',
        {
          tier: selectedTier,
          entry: 'subscription_paywall',
          error: error?.data?.error || error?.message || 'unknown_error',
          status: error?.status,
        },
        'error'
      );
      const status = error?.status;
      const raw = error?.data?.error || error?.message || '';
      let title = 'Error';
      let msg: string;
      if (status === 403 && (raw === 'Email verification required' || /verification/i.test(raw))) {
        title = 'Verify Your Email';
        msg =
          'Please verify your email before subscribing. Check your inbox for the verification link.';
      } else if (status === 401) {
        title = 'Session Expired';
        msg = 'Please sign in again to continue.';
      } else if (
        status === 500 &&
        (raw === 'Stripe not configured' || /stripe.*config/i.test(raw))
      ) {
        title = 'Payments Unavailable';
        msg = 'Payments are being configured. Please try again later.';
      } else if (status === 408 || error?.name === 'AbortError') {
        title = 'Connection Timeout';
        msg = 'The request timed out. Check your connection and try again.';
      } else if (
        !status &&
        (raw?.includes('fetch') || raw?.includes('network') || raw?.includes('Network'))
      ) {
        title = 'Connection Error';
        msg = 'Check your internet connection and try again.';
      } else if (/prod_|price_/i.test(raw)) {
        msg = 'Unable to process subscription. Please try again or contact support.';
      } else if (raw) {
        msg = toUserMessage(error, 'Unable to complete payment. Please try again.');
      } else {
        msg = 'Unable to process subscription. Please try again.';
      }
      setModal({
        visible: true,
        title,
        message: msg,
        options: [{ label: 'OK', onPress: () => setModal(null), color: '#DC2626' }],
      });
    } finally {
      setLoading(false);
    }
  };

  const isProcessing = loading || iapPurchasing;

  // Non-owner coaches cannot purchase — league owner manages subscription
  if (checkingAccess) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: Colors[colorScheme].background }]}>
        <Stack.Screen options={{ title: 'Choose Your Plan', headerShown: true }} />
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator size="large" color={Colors[colorScheme].tint} />
        </View>
      </SafeAreaView>
    );
  }

  if (isNonOwnerCoach) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: Colors[colorScheme].background }]}>
        <Stack.Screen
          options={{
            title: 'Subscription',
            headerLeft: () => (
              <Pressable
                onPress={() => {
                  safeGoBack(router);
                }}
                style={{ paddingLeft: 8 }}
                accessibilityRole="button"
                accessibilityLabel="Go back"
              >
                <MaterialIcons name="chevron-left" size={24} color={Colors[colorScheme].tint} />
              </Pressable>
            ),
            headerShown: true,
          }}
        />
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32 }}>
          <MaterialIcons name="verified-user" size={64} color={Colors[colorScheme].tint} />
          <Text style={[styles.title, { color: Colors[colorScheme].text, marginTop: 16 }]}>
            You&apos;re Covered
          </Text>
          <Text
            style={[
              styles.subtitle,
              { color: Colors[colorScheme].mutedText, marginTop: 8, textAlign: 'center' },
            ]}
          >
            Your league owner manages the subscription. Contact them if you need access to
            additional features.
          </Text>
          <Pressable
            style={[
              styles.ctaButton,
              { backgroundColor: Colors[colorScheme].tint, marginTop: 24, width: '80%' },
            ]}
            onPress={() => safeGoBack(router)}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Text style={styles.ctaButtonText}>Go Back</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: Colors[colorScheme].background }]}>
      <Stack.Screen
        options={{
          title: 'Choose Your Plan',
          headerLeft: () => (
            <Pressable
              onPress={() => {
                safeGoBack(router);
              }}
              style={{ paddingLeft: 8 }}
              accessibilityRole="button"
              accessibilityLabel="Go back"
            >
              <MaterialIcons name="chevron-left" size={24} color={Colors[colorScheme].tint} />
            </Pressable>
          ),
        }}
      />

      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={[styles.contentInner, isLargeScreen ? styles.contentInnerLarge : null]}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={[styles.title, { color: Colors[colorScheme].text }]}>
              Choose Your League Plan
            </Text>
            <Text style={[styles.subtitle, { color: Colors[colorScheme].mutedText }]}>
              Select the plan that fits your league&apos;s needs
            </Text>
          </View>

          {/* IAP Error Banner */}
          {(isIOS || Platform.OS === 'android') && iapError ? (
            <View
              style={[
                styles.errorBanner,
                colorScheme === 'dark' && {
                  backgroundColor: 'rgba(220, 38, 38, 0.12)',
                  borderColor: 'rgba(220, 38, 38, 0.4)',
                },
              ]}
            >
              <Text
                style={[styles.errorBannerText, colorScheme === 'dark' && { color: '#FCA5A5' }]}
              >
                Subscription plans are being set up. You can continue with the free Rookie plan for
                now.
              </Text>
            </View>
          ) : null}

          {/* Tier Selection Pills */}
          <View style={styles.tierSelector}>
            {availableTiers.map(tier => (
              <Pressable
                key={tier}
                style={[
                  styles.tierPill,
                  {
                    backgroundColor: Colors[colorScheme].card,
                    borderColor: Colors[colorScheme].border,
                  },
                  selectedTier === tier && styles.tierPillSelected,
                  selectedTier === tier && {
                    borderColor: getTierColor(tier),
                    backgroundColor: colorScheme === 'dark' ? 'rgba(255,255,255,0.08)' : '#F9FAFB',
                  },
                ]}
                onPress={() => setSelectedTier(tier)}
                accessibilityRole="button"
                accessibilityLabel={`Select ${tier} plan`}
                accessibilityState={{ selected: selectedTier === tier }}
              >
                <CoachTierBadge tier={tier} size="small" showLabel={true} />
                {tier === 'legend' && (
                  <View style={styles.popularBadge}>
                    <Text style={styles.popularText}>BEST VALUE</Text>
                  </View>
                )}
                {(isIOS || Platform.OS === 'android') &&
                tier !== 'rookie' &&
                getIAPPrice(tier as 'veteran' | 'legend') ? (
                  <Text style={[styles.iapPriceText, { color: Colors[colorScheme].mutedText }]}>
                    {getIAPPrice(tier as 'veteran' | 'legend')}
                  </Text>
                ) : null}
              </Pressable>
            ))}
          </View>

          {/* Selected Tier Benefits */}
          <View style={styles.benefitsSection}>
            <CoachTierBenefits tier={selectedTier} compact={false} />
          </View>

          <View style={styles.disclosureSection}>
            <SubscriptionDisclosureCard
              colorScheme={colorScheme}
              plan={selectedTier}
              storePrice={selectedTier === 'rookie' ? null : getIAPPrice(selectedTier)}
            />
          </View>

          {/* Comparison Table */}
          <View style={styles.comparisonSection}>
            <Text style={[styles.comparisonTitle, { color: Colors[colorScheme].text }]}>
              Compare Plans
            </Text>

            <View style={[styles.comparisonTable, { borderColor: Colors[colorScheme].border }]}>
              {/* Header Row */}
              <View
                style={[
                  styles.comparisonRow,
                  {
                    borderBottomColor: Colors[colorScheme].border,
                    backgroundColor: colorScheme === 'dark' ? 'rgba(255,255,255,0.05)' : '#F3F4F6',
                  },
                ]}
              >
                <View style={styles.comparisonFeature}>
                  <Text
                    style={[styles.comparisonHeaderText, { color: Colors[colorScheme].mutedText }]}
                  >
                    Feature
                  </Text>
                </View>
                <View style={styles.comparisonTier}>
                  <Text
                    style={[styles.comparisonHeaderText, { color: Colors[colorScheme].mutedText }]}
                  >
                    Rookie
                  </Text>
                </View>
                <View style={styles.comparisonTier}>
                  <Text
                    style={[styles.comparisonHeaderText, { color: Colors[colorScheme].mutedText }]}
                  >
                    Veteran
                  </Text>
                </View>
                <View style={styles.comparisonTier}>
                  <Text
                    style={[styles.comparisonHeaderText, { color: Colors[colorScheme].mutedText }]}
                  >
                    Legend
                  </Text>
                </View>
              </View>

              {/* Feature Rows */}
              {comparisonFeatures.map((feature, index) => (
                <View
                  key={index}
                  style={[
                    styles.comparisonRow,
                    { borderBottomColor: Colors[colorScheme].border },
                    index % 2 === 0 && {
                      backgroundColor:
                        colorScheme === 'dark' ? 'rgba(255,255,255,0.02)' : '#F9FAFB',
                    },
                  ]}
                >
                  <View style={styles.comparisonFeature}>
                    <Text
                      style={[styles.comparisonFeatureText, { color: Colors[colorScheme].text }]}
                    >
                      {feature.name}
                    </Text>
                  </View>
                  <View style={styles.comparisonTier}>
                    {renderFeatureValue(feature.rookie, colorScheme)}
                  </View>
                  <View style={styles.comparisonTier}>
                    {renderFeatureValue(feature.veteran, colorScheme)}
                  </View>
                  <View style={styles.comparisonTier}>
                    {renderFeatureValue(feature.legend, colorScheme)}
                  </View>
                </View>
              ))}
            </View>
          </View>

          {/* Promo Code Section — web/fallback only (Apple/Google don't allow promo codes through IAP) */}
          {!isIOS && Platform.OS !== 'android' && selectedTier !== 'rookie' && (
            <View
              style={[
                styles.promoSection,
                {
                  backgroundColor: Colors[colorScheme].surface || Colors[colorScheme].card,
                  borderColor: Colors[colorScheme].border,
                },
              ]}
            >
              <Text style={[styles.promoLabel, { color: Colors[colorScheme].text }]}>
                Have a promo code?
              </Text>
              <View style={styles.promoInputContainer}>
                <TextInput
                  style={[
                    styles.promoInput,
                    {
                      backgroundColor: Colors[colorScheme].background,
                      color: Colors[colorScheme].text,
                      borderColor: Colors[colorScheme].border,
                    },
                  ]}
                  placeholder="Enter code"
                  placeholderTextColor="#9CA3AF"
                  value={promoCode}
                  onChangeText={setPromoCode}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  editable={!isProcessing}
                  accessibilityLabel="Promo code"
                />
              </View>
              <Text style={[styles.promoHint, { color: theme.mutedText }]}>
                Promo codes will be applied at checkout
              </Text>
            </View>
          )}

          {/* CTA Button */}
          <View style={styles.ctaSection}>
            <Pressable
              style={[
                styles.ctaButton,
                { backgroundColor: getTierColor(selectedTier) },
                isProcessing && styles.ctaButtonDisabled,
              ]}
              onPress={handleSubscribe}
              disabled={isProcessing}
              accessibilityRole="button"
              accessibilityLabel={
                selectedTier === 'rookie'
                  ? 'Continue with Free Plan'
                  : `Upgrade to ${capitalize(selectedTier)}`
              }
            >
              {isProcessing ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <>
                  <Text style={styles.ctaButtonText}>
                    {selectedTier === 'rookie'
                      ? 'Continue with Free Plan'
                      : `Upgrade to ${capitalize(selectedTier)}`}
                  </Text>
                  {selectedTier !== 'rookie' && (
                    <MaterialIcons name="arrow-forward" size={20} color="#FFFFFF" />
                  )}
                </>
              )}
            </Pressable>

            <Text style={[styles.ctaSubtext, { color: theme.mutedText }]}>
              {selectedTier === 'legend' && 'Billed annually • Cancel anytime'}
              {selectedTier === 'veteran' &&
                (isIOS || Platform.OS === 'android'
                  ? 'Billed monthly • Unlimited sports • Cancel anytime'
                  : 'Billed monthly per sport • Cancel anytime')}
              {selectedTier === 'rookie' && 'Free • No credit card required'}
            </Text>

            {isIOS && selectedTier !== 'rookie' && (
              <Text style={[styles.ctaSubtext, { color: '#9CA3AF', fontSize: 11, marginTop: 4 }]}>
                Payment will be charged to your Apple ID account. Subscription automatically renews
                unless canceled at least 24 hours before the end of the current period. Manage
                subscriptions in Settings.
              </Text>
            )}
            {Platform.OS === 'android' && selectedTier !== 'rookie' && (
              <Text style={[styles.ctaSubtext, { color: '#9CA3AF', fontSize: 11, marginTop: 4 }]}>
                Payment will be charged to your Google Play account. Subscription automatically
                renews unless canceled at least 24 hours before the end of the current period.
                Manage subscriptions in Google Play.
              </Text>
            )}

            {/* Restore Purchases — required by Apple for IAP apps */}
            {(isIOS || Platform.OS === 'android') && selectedTier !== 'rookie' && (
              <>
                <Pressable
                  style={[styles.restoreButton, { marginTop: 16 }]}
                  accessibilityRole="button"
                  accessibilityLabel="Restore Purchases"
                  onPress={async () => {
                    if (isProcessing) return;
                    setLoading(true);
                    try {
                      const restoreStatus = await iapRestore();
                      await checkAuth({ forceRefresh: true }).catch(() => {});
                      if (restoreStatus === 'restored') {
                        Alert.alert('Restore Complete', 'Your subscription has been restored.', [
                          { text: 'OK', onPress: () => safeGoBack(router) },
                        ]);
                      } else if (restoreStatus === 'failed') {
                        Alert.alert(
                          'Restore Failed',
                          iapError ||
                            'We found previous purchases, but could not restore your VarsityHub subscription.'
                        );
                      } else {
                        Alert.alert(
                          'No Purchases Found',
                          'No previous subscription was found for this account.'
                        );
                      }
                    } catch {
                      Alert.alert(
                        'Restore Failed',
                        'Unable to restore purchases. Please try again.'
                      );
                    } finally {
                      setLoading(false);
                    }
                  }}
                  disabled={isProcessing}
                >
                  <Text style={[styles.restoreButtonText, { color: Colors[colorScheme].tint }]}>
                    Restore Purchases
                  </Text>
                </Pressable>

                <View style={styles.legalLinksRow}>
                  <Text style={[styles.legalLinksIntro, { color: theme.mutedText }]}>
                    By subscribing, you acknowledge our{' '}
                  </Text>
                  <Pressable
                    accessibilityRole="link"
                    accessibilityLabel="Open Privacy Policy"
                    onPress={() =>
                      void openExternalUrl(PUBLIC_PRIVACY_POLICY_URL, {
                        context: 'subscription_paywall_privacy_link',
                      })
                    }
                  >
                    <Text style={[styles.legalLinkText, { color: theme.tint }]}>
                      Privacy Policy
                    </Text>
                  </Pressable>
                  <Text style={[styles.legalLinksIntro, { color: theme.mutedText }]}>.</Text>
                </View>
              </>
            )}
          </View>
        </View>
      </ScrollView>

      {/* Action Modal */}
      {modal && (
        <CustomActionModal
          visible={modal.visible}
          title={modal.title}
          message={modal.message}
          options={modal.options}
          onClose={() => setModal(null)}
        />
      )}
    </SafeAreaView>
  );
}

// Helper functions
function getTierColor(tier: CoachTier): string {
  switch (tier) {
    case 'legend':
      return '#FFD700';
    case 'veteran':
      return '#C0C0C0';
    case 'rookie':
    default:
      return '#CD7F32';
  }
}

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function renderFeatureValue(value: string | boolean, scheme: 'light' | 'dark' = 'light') {
  if (typeof value === 'boolean') {
    return value ? (
      <MaterialIcons name="check-circle" size={20} color="#10B981" />
    ) : (
      <MaterialIcons name="cancel" size={20} color="#EF4444" />
    );
  }
  return (
    <Text style={[styles.comparisonValueText, { color: Colors[scheme].mutedText }]}>{value}</Text>
  );
}

// Comparison table data
const comparisonFeatures = [
  {
    name: 'Sports',
    rookie: String(ROOKIE_PROGRAM_LIMIT),
    veteran: 'Unlimited',
    legend: 'Unlimited',
  },
  { name: 'Dedicated Admin', rookie: false, veteran: true, legend: true },
  { name: 'Profile Badge', rookie: false, veteran: true, legend: true },
];

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    padding: 16,
    paddingBottom: 32,
    alignItems: 'center',
  },
  contentInner: {
    width: '100%',
  },
  contentInnerLarge: {
    maxWidth: 860,
  },
  header: {
    marginBottom: 24,
    alignItems: 'center',
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 16,
    textAlign: 'center',
  },
  errorBanner: {
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: '#FECACA',
    borderRadius: 8,
    padding: 12,
    marginBottom: 16,
  },
  errorBannerText: {
    color: '#DC2626',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  tierSelector: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 24,
  },
  tierPill: {
    flex: 1,
    padding: 12,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#D1D5DB',
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    position: 'relative',
  },
  tierPillSelected: {
    borderWidth: 2,
    backgroundColor: '#F9FAFB',
  },
  popularBadge: {
    position: 'absolute',
    top: -8,
    backgroundColor: '#DC2626',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
  },
  popularText: {
    fontSize: 9,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  iapPriceText: {
    fontSize: 13,
    fontWeight: '600',
    marginTop: 4,
  },
  benefitsSection: {
    marginBottom: 24,
  },
  comparisonSection: {
    marginBottom: 24,
  },
  disclosureSection: {
    marginBottom: 24,
  },
  comparisonTitle: {
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 12,
  },
  comparisonTable: {
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1,
  },
  comparisonRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
  },
  comparisonRowAlt: {},
  comparisonHeader: {},
  comparisonFeature: {
    flex: 2,
    padding: 12,
    justifyContent: 'center',
  },
  comparisonTier: {
    flex: 1,
    padding: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  comparisonHeaderText: {
    fontSize: 13,
    fontWeight: '700',
  },
  comparisonFeatureText: {
    fontSize: 14,
  },
  comparisonValueText: {
    fontSize: 14,
    fontWeight: '600',
  },
  promoSection: {
    marginBottom: 24,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
  },
  promoLabel: {
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 8,
  },
  promoInputContainer: {
    marginBottom: 8,
  },
  promoInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    fontWeight: '500',
  },
  promoHint: {
    fontSize: 12,
    fontStyle: 'italic',
  },
  ctaSection: {
    alignItems: 'center',
  },
  ctaButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 16,
    paddingHorizontal: 32,
    borderRadius: 12,
    width: '100%',
    minHeight: 56,
  },
  ctaButtonDisabled: {
    opacity: 0.6,
  },
  ctaButtonText: {
    fontSize: 18,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  ctaSubtext: {
    fontSize: 14,
    lineHeight: 20,
    marginTop: 12,
    textAlign: 'center',
  },
  restoreButton: {
    paddingVertical: 12,
    paddingHorizontal: 24,
    alignSelf: 'center',
  },
  restoreButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  legalLinksRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 8,
    paddingHorizontal: 12,
  },
  legalLinksIntro: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
  },
  legalLinkText: {
    fontSize: 14,
    fontWeight: '600',
    textDecorationLine: 'underline',
  },
});

export default SubscriptionPaywallScreen;
