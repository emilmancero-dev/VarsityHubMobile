import { Colors } from '@/constants/Colors';
import { useAdIAP } from '@/hooks/useAdIAP';
import { useColorScheme } from '@/hooks/useColorScheme';
import { useUnsavedChanges } from '@/hooks/useUnsavedChanges';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useFocusEffect } from '@react-navigation/native';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
// @ts-ignore
import { httpPost } from '@/api/http';
import { AD_GEOFENCE_RADIUS_KM } from '@/constants/adGeofencing';
import { safeGoBack } from '@/utils/navigation';
import { toUserMessage } from '@/utils/toUserMessage';
import { format } from 'date-fns';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Calendar, DateData } from 'react-native-calendars';
// @ts-ignore JS exports
import { Advertisement, Payments } from '@/api/entities';
import { getConfig } from '@/config/env';
import { captureBreadcrumb } from '@/utils/sentry';
import { usePaymentSheet } from '@/utils/stripe';
import { styles } from './ad-calendar.styles';

const weekdayRate = 4.99; // Per week (Mon-Thu slot)
const weekendRate = 7.99; // Per week (Fri-Sun slot)

const DAY_MS = 24 * 60 * 60 * 1000;

function utcTodayDate(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

const todayISO = (): string => utcTodayDate().toISOString().slice(0, 10);
// Use UTC date boundaries to match the server's booking horizon logic exactly.
const maxDateISO = (): string =>
  new Date(utcTodayDate().getTime() + 56 * DAY_MS).toISOString().slice(0, 10);

function _toggleSet(set: Set<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function getDayOfWeek(dateISO: string): number {
  return new Date(dateISO + 'T00:00:00').getDay();
}

function getWeekSlotDates(dateISO: string): string[] {
  // Returns all dates in the same week slot (Mon-Thu or Fri-Sun). Use UTC to match server adPricing.
  const date = new Date(dateISO + 'T00:00:00.000Z');
  const dow = date.getUTCDay();
  const dates: string[] = [];

  if (dow >= 1 && dow <= 4) {
    // Weekday slot: Mon-Thu
    const daysFromMonday = dow - 1;
    const monday = new Date(date);
    monday.setUTCDate(date.getUTCDate() - daysFromMonday);

    for (let i = 0; i < 4; i++) {
      const day = new Date(monday);
      day.setUTCDate(monday.getUTCDate() + i);
      dates.push(day.toISOString().slice(0, 10));
    }
  } else {
    let friday: Date;
    if (dow === 5) friday = new Date(date);
    else if (dow === 6) {
      friday = new Date(date);
      friday.setUTCDate(date.getUTCDate() - 1);
    } else {
      friday = new Date(date);
      friday.setUTCDate(date.getUTCDate() - 2);
    }
    for (let i = 0; i < 3; i++) {
      const day = new Date(friday);
      day.setUTCDate(friday.getUTCDate() + i);
      dates.push(day.toISOString().slice(0, 10));
    }
  }

  return dates;
}

function getWeekIdentifier(dateISO: string): string {
  // Use UTC to match server adPricing.calculateAdPriceCents
  const date = new Date(dateISO + 'T00:00:00.000Z');
  const dow = date.getUTCDay();
  if (dow >= 1 && dow <= 4) {
    const monday = new Date(date);
    monday.setUTCDate(date.getUTCDate() - (dow - 1));
    return `${monday.toISOString().slice(0, 10)}-weekday`;
  }
  let friday = new Date(date);
  if (dow === 5) {
    /* already Friday */
  } else if (dow === 6) friday.setUTCDate(date.getUTCDate() - 1);
  else friday.setUTCDate(date.getUTCDate() - 2);
  return `${friday.toISOString().slice(0, 10)}-weekend`;
}

function calculatePrice(selectedISO: Set<string>): number {
  const { weekdayBlocks, weekendBlocks } = getAdBlocks(selectedISO);
  return weekdayBlocks * weekdayRate + weekendBlocks * weekendRate;
}

function getAdBlocks(selectedISO: Set<string>): { weekdayBlocks: number; weekendBlocks: number } {
  if (selectedISO.size === 0) return { weekdayBlocks: 0, weekendBlocks: 0 };
  const weekSlots = new Set<string>();
  for (const d of selectedISO) weekSlots.add(getWeekIdentifier(d));
  let weekdayBlocks = 0;
  let weekendBlocks = 0;
  for (const slot of weekSlots) {
    if (slot.endsWith('-weekday')) weekdayBlocks++;
    else weekendBlocks++;
  }
  return { weekdayBlocks, weekendBlocks };
}

function getBookableSlotDates(dateISO: string, today: string, maxDate: string): string[] {
  return getWeekSlotDates(dateISO).filter(slotDate => slotDate >= today && slotDate <= maxDate);
}

function getCurrentBookableDates(datesISO: Iterable<string>): string[] {
  const today = todayISO();
  const maxDate = maxDateISO();
  return Array.from(new Set(Array.from(datesISO)))
    .filter(date => date >= today && date <= maxDate)
    .sort((a, b) => (a < b ? -1 : 1));
}

function getDatesOutsideBookingWindow(datesISO: Iterable<string>): {
  past: string[];
  future: string[];
} {
  const today = todayISO();
  const maxDate = maxDateISO();
  const dates = Array.from(new Set(Array.from(datesISO)));
  return {
    past: dates.filter(date => date < today).sort((a, b) => (a < b ? -1 : 1)),
    future: dates.filter(date => date > maxDate).sort((a, b) => (a < b ? -1 : 1)),
  };
}

function AdCalendarScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ adId?: string }>();
  const adId = Array.isArray(params.adId) ? params.adId[0] : params.adId || '';
  const colorScheme = useColorScheme() ?? 'light';
  const { width } = useWindowDimensions();
  const isLargeScreen = width >= 768;

  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { setDirty } = useUnsavedChanges({
    title: 'Discard Selection?',
    message: 'You have dates selected. Are you sure you want to go back?',
  });

  // Keep dirty state in sync with date selection
  React.useEffect(() => {
    setDirty(selected.size > 0);
  }, [selected, setDirty]);

  const [submitting, setSubmitting] = useState(false);
  const [_reserved, setReserved] = useState<Set<string>>(new Set());
  const [fullDates, setFullDates] = useState<Set<string>>(new Set()); // Dates with 2/2 slots filled
  const [_dateAvailability, setDateAvailability] = useState<
    Record<string, { slotsUsed: number; slotsRemaining: number }>
  >({});
  const [promo, setPromo] = useState('');
  const [preview, setPreview] = useState<any>(null);
  const [promoBusy, setPromoBusy] = useState(false);
  const [promoError, setPromoError] = useState<string | null>(null);
  const [quote, setQuote] = useState<{
    subtotal_cents: number;
    tax_cents: number;
    discount_cents: number;
    total_cents: number;
  } | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [zipCode, setZipCode] = useState<string>('');
  const [alternatives, setAlternatives] = useState<Array<{ zip: string; distance: number }>>([]);
  const [showingAlternatives, setShowingAlternatives] = useState(false);
  const [paymentsStatus, setPaymentsStatus] = useState<{
    stripe_configured?: boolean;
    has_webhook_secret?: boolean;
  } | null>(null);
  const [paymentsStatusLoading, setPaymentsStatusLoading] = useState(true);
  const [paymentsStatusError, setPaymentsStatusError] = useState<string | null>(null);
  const [showFreeSuccess, setShowFreeSuccess] = useState(false);
  const [adStatus, setAdStatus] = useState<string | null>(null);
  const freeSuccessOpacity = useRef(new Animated.Value(0)).current;
  const { initPaymentSheet, presentPaymentSheet } = usePaymentSheet();
  const { purchaseAd } = useAdIAP();

  // Load reserved dates for THIS ad only (allow other ads to share dates)
  // AND load date availability to block fully booked dates
  React.useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        if (!adId) {
          // No adId yet (new ad flow) => nothing to disable
          if (mounted) setReserved(new Set());
          return;
        }
        const res: any = await Advertisement.reservationsForAd(String(adId));
        if (!mounted) return;
        const dates = Array.isArray(res?.dates) ? res.dates : [];
        setReserved(new Set<string>(dates));

        // Get zip code from ad details and load availability
        if (adId) {
          try {
            const adDetails: any = await Advertisement.get(String(adId));
            if (mounted && adDetails?.status) setAdStatus(adDetails.status);
            if (adDetails?.target_zip_code) {
              setZipCode(adDetails.target_zip_code);
              await loadAvailability(adDetails.target_zip_code, String(adId));
            }
            if (mounted && adDetails?.status === 'approved' && dates.length > 0) {
              const bookableDates = getCurrentBookableDates(dates);
              setSelected(new Set(bookableDates));
            }
          } catch {
            // Non-critical — calendar still works without availability
          }
        }
      } catch {
        if (mounted) setReserved(new Set());
      }
    })();
    return () => {
      mounted = false;
    };
  }, [adId]);

  // Refresh ad status on screen focus (handles stale cache after rejection/approval)
  useFocusEffect(
    useCallback(() => {
      if (!adId) return;
      let mounted = true;
      void (async () => {
        try {
          const adDetails: any = await Advertisement.get(String(adId));
          if (mounted && adDetails?.status) setAdStatus(adDetails.status);
        } catch {
          // Non-critical — status may be stale but screen still works
        }
      })();
      return () => {
        mounted = false;
      };
    }, [adId])
  );

  React.useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const status = await Payments.configStatus();
        if (!mounted) return;
        setPaymentsStatus(status);
        setPaymentsStatusError(null);
      } catch {
        if (!mounted) return;
        setPaymentsStatusError('Unable to confirm payment readiness right now.');
      } finally {
        if (mounted) setPaymentsStatusLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  const loadAvailability = async (zip: string, excludeAdId?: string) => {
    try {
      const from = todayISO();
      const to = maxDateISO();

      const { httpGet } = await import('@/api/http');
      let url = `/ads/availability?zip=${encodeURIComponent(zip)}&from=${from}&to=${to}`;
      if (excludeAdId) url += `&exclude_ad_id=${encodeURIComponent(excludeAdId)}`;
      const data = await httpGet(url);

      if (data?.availability) {
        const fullDatesSet = new Set<string>();
        const availabilityMap: Record<string, { slotsUsed: number; slotsRemaining: number }> = {};

        Object.entries(data.availability).forEach(([dateISO, info]: [string, any]) => {
          availabilityMap[dateISO] = {
            slotsUsed: info.slotsUsed || 0,
            slotsRemaining: info.slotsRemaining || 0,
          };

          if (!info.available || info.slotsRemaining <= 0) {
            fullDatesSet.add(dateISO);
          }
        });

        setDateAvailability(availabilityMap);
        setFullDates(fullDatesSet);
      }
    } catch (e) {
      if (__DEV__) console.error('Error loading availability:', e);
    }
  };

  const localSubtotal = useMemo(() => calculatePrice(selected), [selected]);
  const subtotalCents = quote?.subtotal_cents ?? Math.round(localSubtotal * 100);
  const taxCents = quote?.tax_cents ?? 0;
  const discountCents = quote?.discount_cents ?? (preview?.valid ? preview.discount_cents || 0 : 0);
  const totalCents = quote?.total_cents ?? Math.max(0, subtotalCents - discountCents);
  const effective = useMemo(() => totalCents / 100, [totalCents]);
  const paymentsTemporarilyDisabled =
    Platform.OS !== 'ios' && paymentsStatus?.stripe_configured === false;
  const showPaymentsWarning =
    (!paymentsStatusLoading && paymentsTemporarilyDisabled) ||
    (!!paymentsStatusError && !paymentsTemporarilyDisabled && Platform.OS !== 'ios');
  const payButtonDisabled =
    submitting || selected.size === 0 || paymentsTemporarilyDisabled || paymentsStatusLoading;
  const submitForApprovalDisabled = submitting;
  const isPending = adStatus === 'pending';
  const isApproved = adStatus === 'approved';
  const isDraft = adStatus === 'draft' || adStatus === null;
  const isActive = adStatus === 'active';
  const isRejected = adStatus === 'rejected';
  const isArchived = adStatus === 'archived';
  const canPay = isApproved || isActive || isArchived; // Once approved, no re-approval for future runs

  const theme = Colors[colorScheme];
  React.useEffect(() => {
    let cancelled = false;
    if (!adId || adId.startsWith('local-') || selected.size === 0) {
      setQuote(null);
      setQuoteLoading(false);
      return;
    }

    const dates = Array.from(selected).sort((a, b) => (a < b ? -1 : 1));
    setQuoteLoading(true);
    void (async () => {
      try {
        const data: any = await httpPost('/payments/ad-quote', {
          ad_id: String(adId),
          dates,
          promo_code: preview?.valid ? preview.code : undefined,
        });
        if (!cancelled) setQuote(data);
      } catch (err) {
        if (!cancelled) {
          setQuote(null);
          if (__DEV__) console.error('Failed to fetch ad quote:', err);
        }
      } finally {
        if (!cancelled) setQuoteLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [adId, selected, preview?.valid, preview?.code]);
  const marked = useMemo(() => {
    const obj: Record<
      string,
      { selected: boolean; selectedColor?: string } | { disabled: boolean } | any
    > = {};

    // PRIORITY 1: Mark fully booked dates (3/3 slots filled) - grey X so user is aware
    for (const d of fullDates) {
      // Don't override if user has already selected this date
      if (!selected.has(d)) {
        obj[d] = {
          disabled: true,
          disableTouchEvent: true,
          textColor: theme.mutedText,
          customStyles: {
            container: {
              backgroundColor: theme.surface,
              borderWidth: 2,
              borderColor: theme.border,
            },
            text: {
              color: theme.mutedText,
              textDecorationLine: 'line-through',
              fontWeight: '600',
            },
          },
          marked: true,
        };
      }
    }

    // PRIORITY 2: Mark selected dates with BRIGHT weekday/weekend colors - HIGHLIGHTED
    for (const d of selected) {
      const dow = getDayOfWeek(d);
      const isWeekend = dow === 0 || dow === 5 || dow === 6; // Sun, Fri, Sat
      obj[d] = {
        selected: true,
        selectedColor: isWeekend ? '#EA580C' : '#2563EB', // Bright Orange for weekend, Bright Blue for weekday
        selectedTextColor: '#FFFFFF',
        marked: true,
        dotColor: '#FFFFFF',
        customStyles: {
          container: {
            backgroundColor: isWeekend ? '#EA580C' : '#2563EB',
            borderWidth: 3,
            borderColor: isWeekend ? '#C2410C' : '#1D4ED8',
            borderRadius: 8,
          },
          text: {
            color: '#FFFFFF',
            fontWeight: '700',
          },
        },
      };
    }

    return obj;
  }, [selected, fullDates, theme]);

  const onDayPress = (day: DateData) => {
    const iso = day.dateString; // yyyy-MM-dd
    const minDate = todayISO();
    const maxDate = maxDateISO();

    if (isDraft) {
      Alert.alert(
        'Submit for Review First',
        'Your ad creative must be approved before you can pick campaign dates.'
      );
      return;
    }

    if (isPending) {
      Alert.alert(
        'Awaiting Approval',
        'This ad is still under review. Dates unlock after the ad is approved.'
      );
      return;
    }

    if (adStatus === 'rejected') {
      Alert.alert(
        'Edit Required',
        'This ad was rejected. Update it and resubmit before scheduling dates.'
      );
      return;
    }

    if (iso < minDate) {
      Alert.alert('Date Unavailable', 'Ad dates must be today or in the future.');
      return;
    }

    // Prevent selection beyond 8 weeks
    if (iso > maxDate) {
      Alert.alert(
        'Booking Limit',
        'Ads can only be booked up to 8 weeks in advance to maintain predictable pricing.'
      );
      return;
    }

    // Prevent selection of fully booked dates
    if (fullDates.has(iso)) {
      void fetchAlternativeZips([iso]).catch(() => {});
      Alert.alert(
        'Date Fully Booked',
        'This date already has 2/2 ad slots filled. Check below for nearby available zip codes or select a different date.'
      );
      return;
    }

    // Get all dates in this week slot (Mon-Thu or Fri-Sun)
    const weekSlotDates = getBookableSlotDates(iso, minDate, maxDate);
    if (weekSlotDates.length === 0) {
      Alert.alert('Date Unavailable', 'Only current and future dates in this slot can be booked.');
      return;
    }

    // Check if ANY date in the week slot is already selected
    const isAnySelected = weekSlotDates.some(d => selected.has(d));

    setSelected(prev => {
      const next = new Set(prev);

      if (isAnySelected) {
        // If any date in this week slot is selected, DESELECT the entire week slot
        weekSlotDates.forEach(d => next.delete(d));
      } else {
        // Otherwise, SELECT the entire week slot (only if dates are available)
        weekSlotDates.forEach(d => {
          // Only add if not fully booked by OTHER ads
          if (!fullDates.has(d)) {
            next.add(d);
          }
        });
      }

      return next;
    });
  };

  const applyPromo = async () => {
    if (Platform.OS === 'ios') {
      setPreview(null);
      setPromoError('Promo codes are not available for iPhone in-app purchases.');
      return;
    }
    setPromoError(null);
    setPromoBusy(true);
    try {
      const subtotalCents = Math.round(localSubtotal * 100);
      const { httpPost } = await import('@/api/http');
      const data = await httpPost('/promos/preview', {
        code: promo,
        subtotal_cents: subtotalCents,
        service: 'booking',
      });
      if (!data?.valid) {
        setPreview(null);
        setPromoError(data?.reason || 'invalid');
      } else setPreview(data);
    } catch (e: any) {
      setPreview(null);
      setPromoError(toUserMessage(e, 'Failed to apply promo'));
    } finally {
      setPromoBusy(false);
    }
  };

  const fetchAlternativeZips = async (dates: string[]) => {
    if (!zipCode || dates.length === 0) return;

    try {
      const { httpGet } = await import('@/api/http');
      const dateString = dates.join(',');
      const data = await httpGet(
        `/ads/alternative-zips?zip=${encodeURIComponent(zipCode)}&dates=${encodeURIComponent(dateString)}`
      );
      if (data?.alternatives && Array.isArray(data.alternatives)) {
        setAlternatives(data.alternatives);
        setShowingAlternatives(true);
      }
    } catch (e: any) {
      if (__DEV__) console.error('Error fetching alternative zips:', e);
    }
  };

  const handleSubmitForApproval = async () => {
    if (!adId) {
      Alert.alert(
        'Ad Not Saved',
        'This ad was not saved to the server. Please go back and re-submit your ad.'
      );
      return;
    }
    if (adId.startsWith('local-')) {
      Alert.alert(
        'Ad Not Saved',
        'This ad was not saved to the server. Please go back and re-submit your ad.'
      );
      return;
    }
    setSubmitting(true);
    try {
      await Advertisement.submitForApproval(String(adId));
      setAdStatus('pending');
      setSelected(new Set());
      Alert.alert(
        'Submitted for Approval',
        'Your ad creative has been submitted for review. Once approved, you can return here to choose dates and pay.'
      );
    } catch (err: any) {
      if (__DEV__) console.error('Submit for approval failed:', err);
      const msg = toUserMessage(err, 'Failed to submit for approval. Please try again.');
      Alert.alert('Error', msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handlePayment = async () => {
    if (paymentsTemporarilyDisabled) {
      Alert.alert(
        'Payments Unavailable',
        'Ads checkout is temporarily disabled while payments are being configured. Please try again later.'
      );
      return;
    }

    if (!adId || selected.size === 0) {
      Alert.alert('Select at least one date');
      return;
    }

    if (Platform.OS === 'ios' && (promo.trim().length > 0 || preview?.valid)) {
      Alert.alert(
        'Promo Codes Unavailable',
        'Promo codes are not supported for iPhone in-app purchases. Remove the code and continue at the standard price.'
      );
      return;
    }

    // Guard against local-only ad IDs that were never persisted to the server
    if (adId.startsWith('local-')) {
      Alert.alert(
        'Ad Not Saved',
        'This ad was not saved to the server. Please go back and re-submit your ad.'
      );
      return;
    }

    // Validate 8-week limit on selected dates
    const invalidDates = getDatesOutsideBookingWindow(selected);
    if (invalidDates.past.length > 0) {
      Alert.alert('Date Unavailable', 'Ad dates must be today or in the future.');
      return;
    }
    if (invalidDates.future.length > 0) {
      Alert.alert(
        'Booking Limit Exceeded',
        'Some selected dates are beyond the 8-week booking window. Please remove them and try again.'
      );
      return;
    }

    const dates = Array.from(selected).sort((a, b) => (a < b ? -1 : 1));
    // Each booked date = 24 hours of full-day ad exposure, regardless of when
    // checkout happens or whether the campaign has started yet. This is what
    // the user actually purchased (date-slot model), not the time between now
    // and the end of the last selected date.
    const purchasedHours = dates.length * 24;

    if (Platform.OS === 'web') {
      setDirty(false);
      setSubmitting(true);
      try {
        const data: any = await httpPost('/payments/checkout', {
          ad_id: String(adId),
          dates,
          promo_code: promo || undefined,
          checkout_mode: 'web',
        });
        if (!data?.url || typeof data.url !== 'string') {
          throw new Error('Unable to start web checkout');
        }
        (globalThis as any).location?.assign?.(data.url);
        return;
      } catch (err: any) {
        if (__DEV__) console.error('Failed to start web ad checkout:', err);
        captureBreadcrumb(
          'Ad web checkout failed',
          'payments.ad',
          {
            ad_id: String(adId),
            error: err?.data?.error || err?.message || 'unknown_error',
            status: err?.status,
          },
          'error'
        );
        const raw = toUserMessage(err, 'Failed to start checkout.');
        Alert.alert('Error', raw);
        setDirty(selected.size > 0);
        setSubmitting(false);
        return;
      }
    }

    // Stripe must be configured — try build-time config first, then fetch from server
    let stripeKey = getConfig().stripePublishableKey;
    if (!stripeKey || !stripeKey.startsWith('pk_')) {
      try {
        const serverCfg = await Payments.getConfig();
        stripeKey = serverCfg?.stripe_publishable_key || '';
      } catch {
        /* server config fetch failed — fall through to error */
      }
    }
    if (!stripeKey || !stripeKey.startsWith('pk_')) {
      Alert.alert(
        'Payments Not Ready',
        'Payment configuration is missing. Please update the app or try again later.'
      );
      return;
    }

    // Disable unsaved changes guard during payment flow
    setDirty(false);

    setSubmitting(true);
    try {
      captureBreadcrumb('Ad checkout initiated', 'payments.ad', {
        ad_id: String(adId),
        dates_count: dates.length,
        has_promo_code: promo.trim().length > 0,
        platform: Platform.OS,
      });

      if (Platform.OS === 'ios') {
        // iOS: use Apple IAP directly — do NOT create a Stripe PaymentIntent (it would be orphaned)
        const { weekdayBlocks, weekendBlocks } = getAdBlocks(selected);
        if (weekdayBlocks <= 0 && weekendBlocks <= 0) {
          throw new Error('No ad blocks to purchase');
        }
        const result = await purchaseAd({
          adId: String(adId),
          dates,
          weekdayBlocks,
          weekendBlocks,
        });
        setSubmitting(false);
        captureBreadcrumb(
          'Native ad purchase returned',
          'payments.ad',
          {
            ad_id: String(adId),
            ok: result.ok,
            has_error: !!result.error,
          },
          result.ok ? 'info' : 'warning'
        );
        if (!result.ok) {
          if (result.error)
            Alert.alert(
              'Payment Error',
              toUserMessage(
                { message: result.error },
                'Unable to complete payment. Please try again.'
              )
            );
          return;
        }
        const paidAmount = `$${(totalCents / 100).toFixed(2)}`;
        router.replace({
          // nav-safe: sequential purchase flow — payment → confirmation
          pathname: '/ad-confirmation',
          params: {
            ad_id: String(adId),
            selectedDates: dates.join(', '),
            purchasedHours: String(purchasedHours),
            purchasedDays: String(dates.length),
            totalAmount: paidAmount,
          },
        });
        return;
      }

      // Android / non-iOS: use Stripe PaymentSheet
      captureBreadcrumb('Ad payment sheet request started', 'payments.ad', {
        ad_id: String(adId),
        dates_count: dates.length,
        has_promo_code: promo.trim().length > 0,
      });
      const data: any = await httpPost('/payments/create-payment-sheet', {
        ad_id: String(adId),
        dates,
        promo_code: promo || undefined,
      });

      if (data?.free) {
        captureBreadcrumb('Ad free promo checkout completed', 'payments.ad', {
          ad_id: String(adId),
          dates_count: dates.length,
        });
        setSubmitting(false);
        setShowFreeSuccess(true);
        freeSuccessOpacity.setValue(0);
        Animated.timing(freeSuccessOpacity, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }).start(() => {
          setTimeout(() => {
            router.replace({
              // nav-safe: sequential purchase flow — promo checkout → confirmation
              pathname: '/ad-confirmation',
              params: {
                ad_id: String(adId),
                selectedDates: dates.join(', '),
                totalAmount: '$0.00 (promo)',
                purchasedHours: String(purchasedHours),
                purchasedDays: String(dates.length),
              },
            });
          }, 1200);
        });
        return;
      }

      if (data?.paymentIntent) {
        // Android: Stripe PaymentSheet with Google Pay
        captureBreadcrumb('Ad payment sheet init started', 'payments.ad', {
          ad_id: String(adId),
        });
        let initError: any = null;
        const { error: err1 } = await initPaymentSheet({
          paymentIntentClientSecret: data.paymentIntent,
          customerEphemeralKeySecret: data.ephemeralKey,
          customerId: data.customer,
          merchantDisplayName: 'Varsity Hub',
          googlePay: { merchantCountryCode: 'US', testEnv: __DEV__ },
          paymentMethodOrder: ['google_pay', 'card'],
          allowsDelayedPaymentMethods: false,
        });
        initError = err1;

        if (initError) {
          if (__DEV__)
            console.warn(
              '[AdCalendar] PaymentSheet init failed with Google Pay, retrying card-only:',
              initError.message
            );
          const { error: err2 } = await initPaymentSheet({
            paymentIntentClientSecret: data.paymentIntent,
            customerEphemeralKeySecret: data.ephemeralKey,
            customerId: data.customer,
            merchantDisplayName: 'Varsity Hub',
            allowsDelayedPaymentMethods: false,
          });
          initError = err2;
        }

        if (initError) {
          if (__DEV__) console.error('[AdCalendar] PaymentSheet init failed:', initError);
          captureBreadcrumb(
            'Ad payment sheet init failed',
            'payments.ad',
            {
              ad_id: String(adId),
              error: initError.message || 'unknown_error',
            },
            'error'
          );
          Alert.alert(
            'Payment Error',
            toUserMessage(initError, 'Unable to initialize payment. Please try again.')
          );
          setSubmitting(false);
          return;
        }
        captureBreadcrumb('Ad payment sheet presented', 'payments.ad', {
          ad_id: String(adId),
        });
        const { error } = await presentPaymentSheet();
        if (error) {
          captureBreadcrumb(
            'Ad payment sheet failed',
            'payments.ad',
            {
              ad_id: String(adId),
              code: error.code,
              error: error.message || 'unknown_error',
            },
            error.code === 'Canceled' ? 'info' : 'error'
          );
          if (error.code !== 'Canceled')
            Alert.alert('Payment Failed', toUserMessage(error, 'Payment could not be completed.'));
          if (data.payment_intent_id) {
            httpPost('/payments/cancel-intent', {
              payment_intent_id: data.payment_intent_id,
            }).catch((cancelErr: any) => {
              console.warn(
                '[ad-calendar] Failed to cancel payment intent — potential leaked intent:',
                cancelErr?.message || cancelErr
              );
            });
          }
          return;
        }
        captureBreadcrumb('Ad payment sheet completed', 'payments.ad', {
          ad_id: String(adId),
          amount_cents: data.amount_cents,
        });
        const paidAmount = data.amount_cents
          ? `$${(data.amount_cents / 100).toFixed(2)}`
          : undefined;
        router.replace({
          // nav-safe: sequential purchase flow — payment → confirmation
          pathname: '/ad-confirmation',
          params: {
            ad_id: String(adId),
            selectedDates: dates.join(', '),
            purchasedHours: String(purchasedHours),
            purchasedDays: String(dates.length),
            ...(paidAmount ? { totalAmount: paidAmount } : {}),
          },
        });
        return;
      }
      throw new Error('Unexpected checkout response');
    } catch (err: any) {
      if (__DEV__) console.error('Failed to start checkout:', err);
      captureBreadcrumb(
        'Ad checkout failed',
        'payments.ad',
        {
          ad_id: String(adId),
          error: err?.data?.error || err?.message || 'unknown_error',
          status: err?.status,
        },
        'error'
      );
      const status = err?.status;
      const raw = err?.data?.error || err?.message || '';
      let title = 'Error';
      let msg: string;
      if (status === 403 && (raw === 'Email verification required' || /verification/i.test(raw))) {
        title = 'Verify Your Email';
        msg = 'Please verify your email before paying. Check your inbox for the verification link.';
      } else if (
        status === 403 &&
        (raw === 'COACH_AGREEMENT_REQUIRED' || /coach agreement/i.test(raw))
      ) {
        title = 'Coach Agreement Required';
        msg = 'You need to accept the coach agreement before booking ads.';
      } else if (
        status === 403 &&
        (raw === 'APPROVAL_REQUIRED' || /approval.*required|must be approved/i.test(raw))
      ) {
        title = 'Approval Required';
        msg = "Your ad must be approved before payment. You'll be notified when you can pay.";
      } else if (status === 401) {
        title = 'Session Expired';
        msg = 'Please sign in again to continue.';
      } else if (
        status === 500 &&
        (raw === 'Stripe not configured' || /stripe.*config/i.test(raw))
      ) {
        title = 'Payments Unavailable';
        msg = 'Payments are being configured. Please try again later.';
      } else if (status === 408 || err?.name === 'AbortError') {
        title = 'Connection Timeout';
        msg = 'The request timed out. Check your connection and try again.';
      } else if (
        !status &&
        (raw?.includes('fetch') || raw?.includes('network') || raw?.includes('Network'))
      ) {
        title = 'Connection Error';
        msg = 'Check your internet connection and try again.';
      } else if (/prod_|price_/i.test(raw)) {
        msg = 'An error occurred starting checkout. Please try again or contact support.';
      } else if (raw) {
        msg = toUserMessage(err, 'Unable to complete payment. Please try again.');
      } else {
        msg = 'An error occurred starting checkout. Please try again.';
      }
      Alert.alert(title, msg);
    } finally {
      setSubmitting(false);
      // Re-enable unsaved changes guard if dates still selected
      setDirty(selected.size > 0);
    }
  };

  const sortedDates = useMemo(
    () => Array.from(selected).sort((a, b) => (a < b ? -1 : 1)),
    [selected]
  );

  return (
    <SafeAreaView
      style={[styles.safeArea, { backgroundColor: Colors[colorScheme].background }]}
      edges={['top', 'left', 'right']}
    >
      <Stack.Screen
        options={{
          title: 'Schedule Your Ad',
          headerShown: false, // Use custom header with SafeAreaView
        }}
      />
      <View style={[styles.container, { backgroundColor: Colors[colorScheme].background }]}>
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
            onPress={() => safeGoBack(router)}
            style={[styles.iconBtn, { backgroundColor: Colors[colorScheme].surface }]}
            accessibilityRole="button"
            accessibilityLabel="Go back"
          >
            <Text style={[styles.iconBtnText, { color: Colors[colorScheme].text }]}>{'<'}</Text>
          </Pressable>
          <Text style={[styles.headerTitle, { color: Colors[colorScheme].text }]}>
            Schedule Your Ad
          </Text>
        </View>

        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <View style={[styles.contentInner, isLargeScreen ? styles.contentInnerLarge : null]}>
            {showPaymentsWarning && (
              <View
                style={[
                  styles.paymentBanner,
                  paymentsTemporarilyDisabled
                    ? styles.paymentBannerError
                    : styles.paymentBannerMuted,
                ]}
              >
                <Text
                  style={[
                    styles.paymentBannerTitle,
                    { color: paymentsTemporarilyDisabled ? '#92400E' : Colors[colorScheme].text },
                  ]}
                >
                  {paymentsTemporarilyDisabled ? 'Payments unavailable' : 'Payment status unknown'}
                </Text>
                <Text
                  style={[
                    styles.paymentBannerText,
                    {
                      color: paymentsTemporarilyDisabled
                        ? '#92400E'
                        : Colors[colorScheme].mutedText,
                    },
                  ]}
                >
                  {paymentsTemporarilyDisabled
                    ? 'Checkout is disabled until our payment provider is configured. Please try again later.'
                    : paymentsStatusError ||
                      'We could not confirm payment readiness. You can still attempt checkout, but it may fail until connectivity improves.'}
                </Text>
              </View>
            )}
            {zipCode && (
              <View
                style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ fontSize: 20 }}>📍</Text>
                  <Text style={[styles.cardTitle, { color: theme.text }]}>Coverage Area</Text>
                </View>
                <Text style={{ color: theme.text, fontSize: 14 }}>
                  Your ad will reach approximately{' '}
                  <Text style={{ fontWeight: '700' }}>{AD_GEOFENCE_RADIUS_KM} km</Text> around zip
                  code <Text style={{ fontWeight: '700' }}>{zipCode}</Text>. Booking remains
                  reserved for this exact zip code.
                </Text>
              </View>
            )}

            {showingAlternatives && alternatives.length > 0 && (
              <View
                style={[
                  styles.card,
                  {
                    backgroundColor: colorScheme === 'dark' ? '#422006' : '#FEF3C7',
                    borderColor: colorScheme === 'dark' ? '#92400E' : '#FCD34D',
                  },
                ]}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={{ fontSize: 20 }}>⚠️</Text>
                  <Text
                    style={[
                      styles.cardTitle,
                      { color: colorScheme === 'dark' ? '#FDE68A' : '#92400E' },
                    ]}
                  >
                    Date Unavailable - Try Nearby Zips
                  </Text>
                </View>
                <Text
                  style={{
                    color: colorScheme === 'dark' ? '#FDE68A' : '#92400E',
                    fontSize: 13,
                    marginBottom: 8,
                  }}
                >
                  The selected date is booked for zip code {zipCode}. Here are nearby alternatives:
                </Text>
                {alternatives.map((alt, idx) => (
                  <Pressable
                    key={idx}
                    accessibilityRole="button"
                    accessibilityLabel={`Switch to zip code ${alt.zip}, ${alt.distance} miles away`}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      paddingVertical: 8,
                      paddingHorizontal: 12,
                      backgroundColor: theme.card,
                      borderRadius: 8,
                      marginBottom: 6,
                      borderWidth: 1,
                      borderColor: theme.border,
                    }}
                    onPress={() => {
                      Alert.alert(
                        'Switch to Zip Code?',
                        `Would you like to create a new ad for zip code ${alt.zip} (${alt.distance} mi away)?`,
                        [
                          { text: 'Cancel', style: 'cancel' },
                          {
                            text: 'Switch',
                            onPress: () => {
                              router.replace(`/submit-ad?zip=${alt.zip}`);
                            },
                          },
                        ]
                      );
                    }}
                  >
                    <View>
                      <Text style={{ fontWeight: '600', fontSize: 15, color: theme.text }}>
                        {alt.zip}
                      </Text>
                      <Text style={{ fontSize: 12, color: theme.mutedText }}>
                        {alt.distance} miles away
                      </Text>
                    </View>
                    <Text style={{ color: theme.tint, fontSize: 13 }}>View →</Text>
                  </Pressable>
                ))}
              </View>
            )}

            <View style={[styles.card, { backgroundColor: Colors[colorScheme].card }]}>
              <Text style={[styles.cardTitle, { color: Colors[colorScheme].text }]}>
                Select Ad Campaign Dates
              </Text>
              <Text style={[styles.cardDesc, { color: Colors[colorScheme].mutedText }]}>
                {canPay
                  ? 'Choose one or more dates to run your ad. Selecting a date books the remaining days in that week slot only.'
                  : 'Ad dates unlock after the creative is approved. Submit the ad for review first, then return here to book dates.'}
              </Text>

              {/* Color Legend */}
              <View style={styles.legendContainer}>
                <View style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: '#2563EB' }]} />
                  <Text style={[styles.legendText, { color: Colors[colorScheme].text }]}>
                    Weekday (Mon-Thu) -{' '}
                    <Text style={{ fontWeight: '700' }}>${weekdayRate.toFixed(2)} per slot</Text>
                  </Text>
                </View>
                <View style={styles.legendItem}>
                  <View style={[styles.legendDot, { backgroundColor: '#EA580C' }]} />
                  <Text style={[styles.legendText, { color: Colors[colorScheme].text }]}>
                    Weekend (Fri-Sun) -{' '}
                    <Text style={{ fontWeight: '700' }}>${weekendRate.toFixed(2)} per slot</Text>
                  </Text>
                </View>
                <View style={styles.legendItem}>
                  <View
                    style={[
                      styles.legendDot,
                      {
                        backgroundColor: theme.mutedText,
                        width: 20,
                        height: 20,
                        borderRadius: 10,
                        alignItems: 'center',
                        justifyContent: 'center',
                      },
                    ]}
                  >
                    <MaterialIcons name="close" size={12} color={theme.surface} />
                  </View>
                  <Text style={[styles.legendText, { color: Colors[colorScheme].text }]}>
                    Sold out (grey X)
                  </Text>
                </View>
              </View>

              <Calendar
                onDayPress={onDayPress}
                markedDates={marked}
                markingType="custom"
                enableSwipeMonths
                minDate={todayISO()}
                maxDate={maxDateISO()}
                theme={
                  {
                    backgroundColor: colorScheme === 'light' ? '#FFFFFF' : Colors[colorScheme].card,
                    calendarBackground:
                      colorScheme === 'light' ? '#FFFFFF' : Colors[colorScheme].card,
                    textSectionTitleColor: Colors[colorScheme].mutedText,
                    selectedDayBackgroundColor: Colors[colorScheme].tint,
                    selectedDayTextColor: '#FFFFFF',
                    todayTextColor: Colors[colorScheme].tint,
                    dayTextColor: Colors[colorScheme].text,
                    textDisabledColor:
                      colorScheme === 'light' ? '#9CA3AF' : Colors[colorScheme].mutedText,
                    monthTextColor: Colors[colorScheme].text,
                    textMonthFontWeight: '700',
                    arrowColor: colorScheme === 'light' ? '#111827' : Colors[colorScheme].tint, // audit: intentional
                    textDayFontFamily: 'system',
                    textMonthFontFamily: 'system',
                    textDayHeaderFontFamily: 'system',
                    textDayFontSize: 14,
                    textMonthFontSize: 16,
                    textDayHeaderFontSize: 13,
                  } as any
                }
              />
              <Text style={[styles.calendarHint, { color: Colors[colorScheme].mutedText }]}>
                Booking available up to 8 weeks in advance
              </Text>

              {/* Ad Space Sharing Notice - Prominent */}
              <View
                style={[
                  styles.noticeBox,
                  {
                    backgroundColor: theme.surface,
                    borderColor: theme.tint,
                    borderWidth: 2,
                    borderLeftWidth: 6,
                  },
                ]}
              >
                <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
                  <Text style={{ fontSize: 24 }}>👥</Text>
                  <View style={{ flex: 1 }}>
                    <Text
                      style={[
                        styles.noticeTitle,
                        { color: theme.text, fontSize: 16, marginBottom: 6 },
                      ]}
                    >
                      Ad Space Shared with 1 Company
                    </Text>
                    <Text style={[styles.noticeText, { color: theme.mutedText, lineHeight: 20 }]}>
                      Your ad will rotate with up to{' '}
                      <Text style={{ fontWeight: '800', fontSize: 15 }}>1 other company</Text> on
                      selected dates.
                    </Text>
                  </View>
                </View>
              </View>
            </View>

            <View style={[styles.card, { backgroundColor: Colors[colorScheme].card }]}>
              <Text style={[styles.cardTitle, { color: Colors[colorScheme].text }]}>Pricing</Text>
              <View style={styles.rowBetween}>
                <Text style={{ color: Colors[colorScheme].text, fontSize: 15 }}>
                  Weekday Slot (Mon-Thu):
                </Text>
                <Text style={[styles.bold, { color: Colors[colorScheme].text, fontSize: 17 }]}>
                  ${weekdayRate.toFixed(2)}
                </Text>
              </View>
              <View style={styles.rowBetween}>
                <Text style={{ color: Colors[colorScheme].text, fontSize: 15 }}>
                  Weekend Slot (Fri-Sun):
                </Text>
                <Text style={[styles.bold, { color: Colors[colorScheme].text, fontSize: 17 }]}>
                  ${weekendRate.toFixed(2)}
                </Text>
              </View>
              <Text style={[styles.muted, { color: Colors[colorScheme].mutedText }]}>
                Select dates to see your total.
              </Text>
            </View>

            {Platform.OS !== 'ios' ? (
              <View style={[styles.card, { backgroundColor: Colors[colorScheme].card }]}>
                <Text style={[styles.cardTitle, { color: Colors[colorScheme].text }]}>
                  Promo Code
                </Text>
                <View style={{ flexDirection: 'row', gap: 8 }}>
                  <TextInput
                    placeholder="Enter code"
                    placeholderTextColor={Colors[colorScheme].mutedText}
                    autoCapitalize="characters"
                    value={promo}
                    onChangeText={setPromo}
                    accessibilityLabel="Promo code"
                    style={{
                      flex: 1,
                      height: 44,
                      borderRadius: 10,
                      borderWidth: 1,
                      borderColor: Colors[colorScheme].border,
                      paddingHorizontal: 12,
                      backgroundColor: Colors[colorScheme].surface,
                      color: Colors[colorScheme].text,
                    }}
                  />
                  <Pressable
                    onPress={applyPromo}
                    style={[
                      styles.payBtn,
                      { backgroundColor: Colors[colorScheme].tint, width: 120, height: 44 },
                    ]}
                    disabled={promoBusy}
                    accessibilityRole="button"
                    accessibilityLabel="Apply promo code"
                  >
                    {promoBusy ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <Text style={styles.payBtnText}>Apply</Text>
                    )}
                  </Pressable>
                </View>
                {promoError ? (
                  <Text style={{ color: '#EF4444' }}>Not valid: {promoError}</Text>
                ) : null}
                {preview?.valid ? (
                  <View style={{ marginTop: 8, gap: 4 }}>
                    <Text style={{ fontWeight: '600', color: Colors[colorScheme].text }}>
                      ✅ Promo Applied: {preview.code}
                    </Text>
                    <Text style={{ color: Colors[colorScheme].text }}>
                      Discount: ${((preview.discount_cents || 0) / 100).toFixed(2)}
                    </Text>
                    <Text
                      style={{ fontSize: 12, color: Colors[colorScheme].mutedText, marginTop: 4 }}
                    >
                      ⚠️ Limited offer: First 8 users only
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : null}

            <View style={[styles.card, { backgroundColor: Colors[colorScheme].card }]}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <Text style={[styles.cardTitle, { color: Colors[colorScheme].text }]}>
                  Campaign Summary
                </Text>
                {sortedDates.length > 0 && (
                  <View style={[styles.countBadge, { backgroundColor: Colors[colorScheme].tint }]}>
                    <Text style={styles.countBadgeText}>{sortedDates.length}</Text>
                  </View>
                )}
              </View>
              {sortedDates.length > 0 ? (
                <View style={{ gap: 12 }}>
                  <View>
                    <Text
                      style={[styles.bold, { color: Colors[colorScheme].text, marginBottom: 8 }]}
                    >
                      Selected Week Slots:
                    </Text>
                    <View style={styles.badgeWrap}>
                      {(() => {
                        // Group dates by week slot identifier
                        const weekSlots = new Map<string, string[]>();
                        sortedDates.forEach(iso => {
                          const identifier = getWeekIdentifier(iso);
                          if (!weekSlots.has(identifier)) {
                            weekSlots.set(identifier, []);
                          }
                          weekSlots.get(identifier)!.push(iso);
                        });

                        // Display one badge per week slot
                        return Array.from(weekSlots.entries()).map(([identifier, dates]) => {
                          const firstDate = dates[0];
                          const dow = getDayOfWeek(firstDate);
                          const isWeekend = dow === 0 || dow === 5 || dow === 6;
                          const rate = isWeekend ? weekendRate : weekdayRate;

                          // Format date range for the week slot
                          const sortedSlotDates = dates.sort();
                          const firstDateObj = new Date(sortedSlotDates[0] + 'T00:00:00');
                          const lastDateObj = new Date(
                            sortedSlotDates[sortedSlotDates.length - 1] + 'T00:00:00'
                          );
                          const dateRange =
                            sortedSlotDates.length === 1
                              ? format(firstDateObj, 'MMM d, yyyy')
                              : `${format(firstDateObj, 'MMM d')}-${format(lastDateObj, 'd, yyyy')}`;
                          const slotLabel = isWeekend ? 'Fri-Sun' : 'Mon-Thu';

                          return (
                            <View
                              key={identifier}
                              style={[
                                styles.dateBadge,
                                {
                                  backgroundColor:
                                    colorScheme === 'dark'
                                      ? isWeekend
                                        ? '#422006'
                                        : '#1E3A8A'
                                      : isWeekend
                                        ? '#FED7AA'
                                        : '#BFDBFE',
                                  borderColor: isWeekend ? '#EA580C' : '#2563EB',
                                },
                              ]}
                            >
                              <Text
                                style={[
                                  styles.dateBadgeText,
                                  {
                                    color:
                                      colorScheme === 'dark'
                                        ? isWeekend
                                          ? '#FDE68A'
                                          : '#93C5FD'
                                        : isWeekend
                                          ? '#7C2D12'
                                          : '#1E40AF',
                                  },
                                ]}
                              >
                                {dateRange} ({slotLabel})
                              </Text>
                              <Text
                                style={[
                                  styles.dateBadgeRate,
                                  {
                                    color:
                                      colorScheme === 'dark'
                                        ? isWeekend
                                          ? '#FDE68A'
                                          : '#93C5FD'
                                        : isWeekend
                                          ? '#9A3412'
                                          : '#1E3A8A',
                                  },
                                ]}
                              >
                                ${rate.toFixed(2)} slot
                              </Text>
                            </View>
                          );
                        });
                      })()}
                    </View>
                  </View>
                </View>
              ) : (
                <View
                  style={[
                    styles.emptyState,
                    {
                      backgroundColor: Colors[colorScheme].surface,
                      borderColor: Colors[colorScheme].border,
                    },
                  ]}
                >
                  <View
                    style={{
                      width: 40,
                      height: 40,
                      marginBottom: 8,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <MaterialIcons name="event" size={38} color={Colors[colorScheme].tint} />
                    <Text
                      style={{
                        position: 'absolute',
                        top: 14,
                        fontSize: 13,
                        fontWeight: '800',
                        color: Colors[colorScheme].tint,
                      }}
                    >
                      24
                    </Text>
                  </View>
                  <Text style={[styles.bold, { color: Colors[colorScheme].text }]}>
                    No dates selected
                  </Text>
                  <Text
                    style={[
                      styles.muted,
                      { color: Colors[colorScheme].mutedText, textAlign: 'center' },
                    ]}
                  >
                    Tap on dates in the calendar above to build your campaign
                  </Text>
                </View>
              )}

              {sortedDates.length > 0 &&
                (() => {
                  // Each booked day = 24 hours of ad exposure (full day, regardless of when it goes live)
                  const totalHrs = sortedDates.length * 24;
                  const includesToday = sortedDates.includes(todayISO());
                  return (
                    <>
                      <View style={[styles.rowBetween, { marginTop: 4 }]}>
                        <Text style={[styles.bold, { color: Colors[colorScheme].text }]}>
                          Total Hours Purchasing:
                        </Text>
                        <View style={styles.hoursHighlight}>
                          <Text style={styles.hoursHighlightText}>
                            {totalHrs} hrs ({sortedDates.length} day
                            {sortedDates.length !== 1 ? 's' : ''})
                          </Text>
                        </View>
                      </View>
                      {includesToday && (
                        <View style={styles.fullPriceNotice}>
                          <MaterialIcons name="info-outline" size={16} color="#92400E" />
                          <Text style={styles.fullPriceNoticeText}>
                            Booking today still charges the full slot price.
                          </Text>
                        </View>
                      )}
                    </>
                  );
                })()}

              <View style={[styles.sep, { backgroundColor: Colors[colorScheme].border }]} />

              <View style={styles.rowBetween}>
                <Text style={[styles.bold, { fontSize: 18, color: Colors[colorScheme].text }]}>
                  Subtotal:
                </Text>
                <Text style={{ fontSize: 18, fontWeight: '700', color: Colors[colorScheme].text }}>
                  ${(subtotalCents / 100).toFixed(2)}
                </Text>
              </View>
              {quoteLoading ? (
                <View style={styles.rowBetween}>
                  <Text style={[styles.bold, { fontSize: 16, color: Colors[colorScheme].text }]}>
                    Tax:
                  </Text>
                  <Text
                    style={{
                      fontSize: 16,
                      fontWeight: '700',
                      color: Colors[colorScheme].mutedText,
                    }}
                  >
                    Calculating...
                  </Text>
                </View>
              ) : taxCents > 0 ? (
                <View style={styles.rowBetween}>
                  <Text style={[styles.bold, { fontSize: 16, color: Colors[colorScheme].text }]}>
                    Tax:
                  </Text>
                  <Text
                    style={{ fontSize: 16, fontWeight: '700', color: Colors[colorScheme].text }}
                  >
                    ${(taxCents / 100).toFixed(2)}
                  </Text>
                </View>
              ) : null}
              {Platform.OS !== 'ios' && preview?.valid ? (
                <View style={styles.rowBetween}>
                  <Text style={[styles.bold, { fontSize: 16, color: Colors[colorScheme].text }]}>
                    Promo Discount:
                  </Text>
                  <Text style={{ fontSize: 16, color: '#10B981', fontWeight: '700' }}>
                    - ${((discountCents || 0) / 100).toFixed(2)}
                  </Text>
                </View>
              ) : null}
              <View style={styles.rowBetween}>
                <Text style={[styles.bold, { fontSize: 18, color: Colors[colorScheme].text }]}>
                  Total:
                </Text>
                <Text style={{ fontSize: 22, fontWeight: '800', color: Colors[colorScheme].text }}>
                  {quoteLoading ? 'Calculating...' : `$${effective.toFixed(2)}`}
                </Text>
              </View>
              {!quoteLoading && quote == null && (
                <Text style={{ fontSize: 11, color: Colors[colorScheme].mutedText, marginTop: 2 }}>
                  Tax is confirmed at checkout.
                </Text>
              )}

              {isPending && (
                <View
                  style={[
                    styles.pendingBanner,
                    {
                      backgroundColor: colorScheme === 'dark' ? '#422006' : '#FEF3C7',
                      borderColor: colorScheme === 'dark' ? '#92400E' : '#FCD34D',
                    },
                  ]}
                >
                  <MaterialIcons name="schedule" size={24} color="#92400E" />
                  <View style={{ flex: 1 }}>
                    <Text
                      style={[
                        styles.pendingBannerTitle,
                        { color: colorScheme === 'dark' ? '#FDE68A' : '#92400E' },
                      ]}
                    >
                      Pending Approval
                    </Text>
                    <Text
                      style={[
                        styles.pendingBannerText,
                        { color: colorScheme === 'dark' ? '#FDE68A' : '#92400E' },
                      ]}
                    >
                      Your ad creative is under review. You can book dates here once an admin
                      approves it.
                    </Text>
                  </View>
                </View>
              )}
              {isRejected && (
                <>
                  <View
                    style={[
                      styles.pendingBanner,
                      {
                        backgroundColor: colorScheme === 'dark' ? '#3F1D1D' : '#FEF2F2',
                        borderColor: colorScheme === 'dark' ? '#B91C1C' : '#FCA5A5',
                      },
                    ]}
                  >
                    <MaterialIcons
                      name="error-outline"
                      size={24}
                      color={colorScheme === 'dark' ? '#FCA5A5' : '#B91C1C'}
                    />
                    <View style={{ flex: 1 }}>
                      <Text
                        style={[
                          styles.pendingBannerTitle,
                          { color: colorScheme === 'dark' ? '#FCA5A5' : '#B91C1C' },
                        ]}
                      >
                        Edit Before Scheduling
                      </Text>
                      <Text
                        style={[
                          styles.pendingBannerText,
                          { color: colorScheme === 'dark' ? '#FECACA' : '#991B1B' },
                        ]}
                      >
                        This ad was rejected. Update the content and resubmit it before choosing
                        dates.
                      </Text>
                    </View>
                  </View>
                  <Pressable
                    onPress={() => {
                      void router.push({ pathname: '/edit-ad', params: { id: String(adId) } });
                    }}
                    accessibilityRole="button"
                    accessibilityLabel="Edit ad to resubmit"
                    style={[styles.payBtn, { backgroundColor: Colors[colorScheme].tint }]}
                  >
                    <Text style={styles.payBtnText}>Edit Ad to Resubmit</Text>
                  </Pressable>
                </>
              )}
              {canPay && (
                <>
                  <View
                    style={{
                      backgroundColor: colorScheme === 'dark' ? '#1C1400' : '#FFFBEB',
                      borderWidth: 1,
                      borderColor: colorScheme === 'dark' ? '#92400E' : '#FCD34D',
                      borderRadius: 8,
                      padding: 12,
                      marginBottom: 12,
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 8,
                    }}
                  >
                    <MaterialIcons name="warning-amber" size={18} color="#92400E" />
                    <Text
                      style={{
                        color: colorScheme === 'dark' ? '#FDE68A' : '#92400E',
                        fontSize: 13,
                        fontWeight: '600',
                        flex: 1,
                      }}
                    >
                      All Sales Final — No Refunds. By paying you confirm your purchase.
                    </Text>
                  </View>
                  <Pressable
                    disabled={payButtonDisabled}
                    onPress={handlePayment}
                    accessibilityRole="button"
                    accessibilityLabel={
                      paymentsTemporarilyDisabled
                        ? 'Checkout unavailable'
                        : `Pay $${effective.toFixed(2)}`
                    }
                    style={[
                      styles.payBtn,
                      { backgroundColor: Colors[colorScheme].tint },
                      payButtonDisabled && styles.payBtnDisabled,
                    ]}
                  >
                    {submitting ? (
                      <ActivityIndicator color="#FFFFFF" />
                    ) : (
                      <Text style={styles.payBtnText}>
                        {paymentsTemporarilyDisabled
                          ? 'Checkout unavailable'
                          : `Pay $${effective.toFixed(2)}`}
                      </Text>
                    )}
                  </Pressable>
                  {paymentsTemporarilyDisabled && (
                    <Text
                      style={[
                        styles.paymentBannerHelp,
                        { color: colorScheme === 'dark' ? '#FCA5A5' : '#B91C1C' },
                      ]}
                    >
                      Payments are temporarily disabled while Stripe is configured. Please try again
                      later.
                    </Text>
                  )}
                </>
              )}
              {isDraft && (
                <>
                  <Pressable
                    disabled={submitForApprovalDisabled}
                    onPress={handleSubmitForApproval}
                    accessibilityRole="button"
                    accessibilityLabel="Submit for Approval"
                    style={[
                      styles.payBtn,
                      { backgroundColor: Colors[colorScheme].tint },
                      submitForApprovalDisabled && styles.payBtnDisabled,
                    ]}
                  >
                    {submitting ? (
                      <ActivityIndicator color="#FFFFFF" />
                    ) : (
                      <Text style={styles.payBtnText}>Submit for Approval</Text>
                    )}
                  </Pressable>
                  <Text
                    style={[styles.paymentBannerHelp, { color: Colors[colorScheme].mutedText }]}
                  >
                    This submits the ad creative for review. Dates and payment unlock after
                    approval.
                  </Text>
                </>
              )}
              {isActive && selected.size === 0 && (
                <View
                  style={[
                    styles.pendingBanner,
                    {
                      backgroundColor: colorScheme === 'dark' ? '#064E3B' : '#D1FAE5',
                      borderColor: colorScheme === 'dark' ? '#047857' : '#10B981',
                    },
                  ]}
                >
                  <MaterialIcons name="check-circle" size={24} color="#10B981" />
                  <View style={{ flex: 1 }}>
                    <Text
                      style={[
                        styles.pendingBannerTitle,
                        { color: colorScheme === 'dark' ? '#6EE7B7' : '#047857' },
                      ]}
                    >
                      Your ad is live
                    </Text>
                    <Text
                      style={[
                        styles.pendingBannerText,
                        { color: colorScheme === 'dark' ? '#6EE7B7' : '#047857' },
                      ]}
                    >
                      Select new dates above to run this ad again — no re-approval needed.
                    </Text>
                    <Pressable
                      onPress={() => router.push('/my-ads')}
                      style={{ marginTop: 8 }}
                      accessibilityRole="link"
                      accessibilityLabel="View My Ads"
                    >
                      <Text style={{ color: Colors[colorScheme].tint, fontWeight: '600' }}>
                        View My Ads →
                      </Text>
                    </Pressable>
                  </View>
                </View>
              )}
              {isArchived && selected.size === 0 && (
                <View
                  style={[
                    styles.pendingBanner,
                    {
                      backgroundColor: colorScheme === 'dark' ? '#1E3A8A' : '#DBEAFE',
                      borderColor: colorScheme === 'dark' ? '#2563EB' : '#60A5FA',
                    },
                  ]}
                >
                  <MaterialIcons
                    name="history"
                    size={24}
                    color={colorScheme === 'dark' ? '#93C5FD' : '#1D4ED8'}
                  />
                  <View style={{ flex: 1 }}>
                    <Text
                      style={[
                        styles.pendingBannerTitle,
                        { color: colorScheme === 'dark' ? '#BFDBFE' : '#1D4ED8' },
                      ]}
                    >
                      Approved Media Ready to Run Again
                    </Text>
                    <Text
                      style={[
                        styles.pendingBannerText,
                        { color: colorScheme === 'dark' ? '#BFDBFE' : '#1E40AF' },
                      ]}
                    >
                      This campaign finished, but the ad creative is still approved. Select new
                      dates above to book it again.
                    </Text>
                  </View>
                </View>
              )}
            </View>
          </View>
        </ScrollView>
      </View>

      {/* Free promo success overlay */}
      {showFreeSuccess && (
        <Animated.View
          style={[styles.successOverlay, { opacity: freeSuccessOpacity, pointerEvents: 'none' }]}
        >
          <View style={styles.successBadge}>
            <Text style={[styles.successCheck, { color: Colors[colorScheme].text }]}>✓</Text>
            <Text style={[styles.successLabel, { color: Colors[colorScheme].text }]}>
              Ad Reserved!
            </Text>
            <Text style={[styles.successSub, { color: Colors[colorScheme].mutedText }]}>
              Promo applied — redirecting...
            </Text>
          </View>
        </Animated.View>
      )}
    </SafeAreaView>
  );
}

export default AdCalendarScreen;
