import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useFocusEffect } from '@react-navigation/native';
import { Image } from 'expo-image';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
// @ts-ignore
import { Advertisement as AdsApi } from '@/api/entities';
import { getApiBaseUrl } from '@/api/http';
import settings from '@/api/settings';
import { uploadFile } from '@/api/upload';
import {
  AdFormHeader,
  AdFormLoading,
  AdFormPrimaryCta,
  adFormSharedStyles as sharedStyles,
} from '@/components/AdFormShared';
import { Colors } from '@/constants/Colors';
import { useColorScheme } from '@/hooks/useColorScheme';
import { getAdPaymentStatusLabel } from '@/utils/adPaymentStatusLabel';
import { sanitizeText } from '@/utils/formUtils';
import { optimizeImageUrl } from '@/utils/imageUrl';
import { materializeICloudAssetIfNeeded } from '@/utils/materializeICloudAsset';
import { safeGoBack } from '@/utils/navigation';
import { pickerMediaTypesProp } from '@/utils/picker';
import { toUserMessage } from '@/utils/toUserMessage';

type AdStatus = 'draft' | 'pending' | 'approved' | 'active' | 'rejected' | 'archived';
type PaymentStatus =
  | 'unpaid'
  | 'paid'
  | 'refunded'
  | 'pending_approval'
  | 'hold'
  | 'refund_pending';

export function EditAdScreenBase({
  renderReachPreview,
  showHeaderChevron = false,
}: {
  renderReachPreview?: (zipCode: string) => ReactNode;
  showHeaderChevron?: boolean;
}) {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const router = useRouter();
  const colorScheme = useColorScheme() ?? 'light';
  const theme = Colors[colorScheme];
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [contactName, setContactName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [business, setBusiness] = useState('');
  const [zip, setZip] = useState('');
  const [bannerUrl, setBannerUrl] = useState<string | null>(null);
  const [targetUrl, setTargetUrl] = useState('');
  const [ctaText, setCtaText] = useState('');
  const [desc, setDesc] = useState('');
  const [status, setStatus] = useState<AdStatus>('draft');
  const [payment, setPayment] = useState<PaymentStatus>('unpaid');
  const [uploading, setUploading] = useState(false);
  const [bookedDates, setBookedDates] = useState<string[]>([]);
  const isSubmitting = useRef(false);

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail.trim());
  const zipValid = !zip.trim() || /^[A-Za-z0-9][A-Za-z0-9\s\-]{0,10}[A-Za-z0-9]$/.test(zip.trim());
  const urlValid = !targetUrl.trim() || /^https?:\/\/.+/.test(targetUrl.trim());

  const canSave = useMemo(() => {
    return (
      !!id &&
      business.trim().length > 0 &&
      business.trim().length <= 200 &&
      contactEmail.trim().length > 0 &&
      emailValid &&
      contactName.trim().length <= 200 &&
      desc.trim().length <= 1000 &&
      zipValid &&
      urlValid
    );
  }, [id, business, contactEmail, contactName, desc, emailValid, zipValid, urlValid]);

  const load = useCallback(async () => {
    if (!id) {
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      try {
        const ad: any = await AdsApi.get(String(id));
        setContactName(ad?.contact_name || '');
        setContactEmail(ad?.contact_email || '');
        setBusiness(ad?.business_name || '');
        setZip(ad?.target_zip_code || '');
        setBannerUrl(ad?.banner_url || null);
        setTargetUrl(ad?.target_url || '');
        setCtaText(ad?.cta_text || '');
        setDesc(ad?.description || '');
        setStatus((ad?.status || 'draft') as AdStatus);
        setPayment((ad?.payment_status || 'unpaid') as PaymentStatus);
        if (ad?.payment_status === 'paid') {
          try {
            const res: any = await AdsApi.reservationsForAd(String(id));
            setBookedDates(Array.isArray(res?.dates) ? [...res.dates].sort() : []);
          } catch {
            setBookedDates([]);
          }
        }
      } catch {
        const local = await settings.getJson<any[]>(settings.SETTINGS_KEYS.LOCAL_ADS, []);
        const found = local.find(entry => String(entry.id) === String(id));
        if (found) {
          setContactName(found.contact_name || '');
          setContactEmail(found.contact_email || '');
          setBusiness(found.business_name || '');
          setZip(found.zip_code || '');
          setBannerUrl(found.banner_url || null);
          setTargetUrl(found.target_url || '');
          setDesc(found.description || '');
          setStatus((found.status || 'draft') as AdStatus);
          setPayment((found.payment_status || 'unpaid') as PaymentStatus);
        }
      }
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useFocusEffect(
    useCallback(() => {
      if (id) void load();
    }, [id, load])
  );

  const pickBanner = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        'Permission Required',
        'Please allow photo library access in Settings to upload a banner image.'
      );
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      ...pickerMediaTypesProp(),
      allowsEditing: true,
      aspect: [4, 3],
      selectionLimit: 1,
      quality: 0.9,
    } as any);
    if ((result as any).canceled || !(result as any).assets || !(result as any).assets[0]) return;

    const asset = (result as any).assets[0];
    try {
      setUploading(true);
      const localUri = await materializeICloudAssetIfNeeded(asset.uri);
      const manipulated = await ImageManipulator.manipulateAsync(
        localUri,
        [{ resize: { width: 1200 } }],
        { compress: 0.85, format: ImageManipulator.SaveFormat.JPEG }
      );
      const upload = await uploadFile(
        getApiBaseUrl(),
        manipulated.uri,
        asset.fileName || 'banner.jpg',
        'image/jpeg',
        { formFields: { purpose: 'ad_banner', ad_id: String(id) } }
      );
      setBannerUrl(upload?.url || upload?.path || null);
    } catch (error: any) {
      Alert.alert('Upload failed', toUserMessage(error, 'Please try again.'));
    } finally {
      setUploading(false);
    }
  };

  const save = async () => {
    if (!id || !canSave || saving || isSubmitting.current) return;
    isSubmitting.current = true;
    setSaving(true);
    try {
      await AdsApi.update(String(id), {
        contact_name: sanitizeText(contactName),
        contact_email: contactEmail.trim(),
        business_name: sanitizeText(business),
        banner_url: bannerUrl || undefined,
        target_url: targetUrl.trim()
          ? /^https?:\/\//i.test(targetUrl.trim())
            ? targetUrl.trim()
            : 'https://' + targetUrl.trim()
          : undefined,
        cta_text: sanitizeText(ctaText) || undefined,
        target_zip_code: zip.trim(),
        description: sanitizeText(desc) || undefined,
      });
      Alert.alert('Saved', 'Your ad was updated.');
      safeGoBack(router, '/my-ads');
    } catch (error: any) {
      Alert.alert(
        'Save failed',
        toUserMessage(error, 'Could not update the ad. Please try again.')
      );
    } finally {
      setSaving(false);
      isSubmitting.current = false;
    }
  };

  return (
    <SafeAreaView
      style={[sharedStyles.container, { backgroundColor: theme.background }]}
      edges={['bottom']}
    >
      <Stack.Screen
        options={{
          title: 'Edit Ad',
          headerShown: true,
          headerLeft: showHeaderChevron
            ? () => (
                <Pressable
                  onPress={() => safeGoBack(router, '/my-ads')}
                  style={{ paddingRight: 8 }}
                >
                  <MaterialIcons name="chevron-left" size={28} color="#007AFF" />
                </Pressable>
              )
            : undefined,
        }}
      />
      {loading ? (
        <AdFormLoading
          title="Edit Ad"
          message="Loading ad details..."
          textColor={theme.mutedText}
        />
      ) : (
        <ScrollView
          contentContainerStyle={sharedStyles.scrollContent}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          automaticallyAdjustKeyboardInsets
        >
          <AdFormHeader
            title="Edit Advertisement"
            subtitle="Update your ad details and settings"
            textColor={theme.text}
            mutedTextColor={theme.mutedText}
          />

          <View
            style={[
              sharedStyles.card,
              { backgroundColor: theme.surface, borderColor: theme.border },
            ]}
          >
            <Text style={[sharedStyles.label, { color: theme.text }]}>Business Name *</Text>
            <TextInput
              style={[
                sharedStyles.input,
                { backgroundColor: theme.card, borderColor: theme.border, color: theme.text },
              ]}
              value={business}
              onChangeText={setBusiness}
              placeholder="Acme Pizza"
              placeholderTextColor={theme.mutedText}
            />

            <Text style={[sharedStyles.label, { color: theme.text }]}>Contact Name</Text>
            <TextInput
              style={[
                sharedStyles.input,
                { backgroundColor: theme.card, borderColor: theme.border, color: theme.text },
              ]}
              value={contactName}
              onChangeText={setContactName}
              placeholder="John Smith"
              placeholderTextColor={theme.mutedText}
              autoCapitalize="words"
              maxLength={200}
            />

            <Text style={[sharedStyles.label, { color: theme.text }]}>Contact Email *</Text>
            <TextInput
              style={[
                sharedStyles.input,
                { backgroundColor: theme.card, borderColor: theme.border, color: theme.text },
              ]}
              value={contactEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              onChangeText={setContactEmail}
              placeholder="you@business.com"
              placeholderTextColor={theme.mutedText}
              maxLength={320}
            />

            <Text style={[sharedStyles.label, { color: theme.text }]}>Target Zip Code</Text>
            <TextInput
              style={[
                sharedStyles.input,
                { backgroundColor: theme.card, borderColor: theme.border, color: theme.text },
              ]}
              value={zip}
              onChangeText={setZip}
              keyboardType={Platform.OS === 'ios' ? 'number-pad' : 'numeric'}
              placeholder="12345"
              maxLength={12}
              placeholderTextColor={theme.mutedText}
            />

            {renderReachPreview?.(zip)}

            <Text style={[sharedStyles.label, { color: theme.text }]}>Banner Image</Text>
            {bannerUrl ? (
              <View style={[styles.bannerPreview, { backgroundColor: theme.surface }]}>
                <Image
                  source={{ uri: optimizeImageUrl(bannerUrl, 1200) }}
                  style={styles.bannerImage}
                  contentFit="contain"
                />
              </View>
            ) : (
              <View
                style={[
                  styles.bannerPlaceholder,
                  { backgroundColor: theme.surface, borderColor: theme.border },
                ]}
              >
                <Text style={[styles.bannerPlaceholderText, { color: theme.mutedText }]}>
                  No banner uploaded
                </Text>
                <Text style={[sharedStyles.muted, { color: theme.mutedText }]}>
                  Recommended: 16:9 ratio, PNG/JPG
                </Text>
              </View>
            )}
            <Pressable
              style={[styles.uploadBtn, uploading && styles.uploadBtnDisabled]}
              onPress={pickBanner}
              disabled={uploading}
            >
              {uploading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.uploadBtnText}>
                  {bannerUrl ? 'Replace Banner' : 'Upload Banner'}
                </Text>
              )}
            </Pressable>

            <Text style={[sharedStyles.label, { color: theme.text }]}>Website Link (Optional)</Text>
            <TextInput
              style={[
                sharedStyles.input,
                {
                  backgroundColor: theme.card,
                  borderColor: urlValid ? theme.border : '#cc0000',
                  color: theme.text,
                },
              ]}
              value={targetUrl}
              onChangeText={setTargetUrl}
              placeholder="https://example.com"
              autoCapitalize="none"
              keyboardType="url"
              placeholderTextColor={theme.mutedText}
            />
            {targetUrl.trim() && !urlValid ? (
              <Text style={[sharedStyles.helperText, { color: '#cc0000' }]}>
                Must start with https:// (e.g. https://example.com)
              </Text>
            ) : targetUrl.trim() ? (
              <Text style={[sharedStyles.helperText, { color: theme.mutedText }]}>
                Users can tap your ad to visit this website
              </Text>
            ) : null}

            <Text style={[sharedStyles.label, { color: theme.text }]}>Button Text (Optional)</Text>
            <TextInput
              style={[
                sharedStyles.input,
                { backgroundColor: theme.card, borderColor: theme.border, color: theme.text },
              ]}
              value={ctaText}
              onChangeText={setCtaText}
              placeholder="Learn More"
              placeholderTextColor={theme.mutedText}
              maxLength={50}
            />

            <Text style={[sharedStyles.label, { color: theme.text }]}>Description</Text>
            <TextInput
              style={[
                sharedStyles.input,
                sharedStyles.textArea,
                { backgroundColor: theme.card, borderColor: theme.border, color: theme.text },
              ]}
              value={desc}
              onChangeText={setDesc}
              multiline
              numberOfLines={4}
              placeholder="Tell us about your business or message..."
              textAlignVertical="top"
              placeholderTextColor={theme.mutedText}
              maxLength={1000}
            />

            <View
              style={[
                styles.infoCard,
                { backgroundColor: theme.surface, borderColor: theme.border },
              ]}
            >
              <Text style={[styles.infoLabel, { color: theme.mutedText }]}>Ad Status</Text>
              <Text style={[styles.infoValue, { color: theme.text }]}>
                {status.charAt(0).toUpperCase() + status.slice(1)}
              </Text>
            </View>

            <View
              style={[
                styles.infoCard,
                { backgroundColor: theme.surface, borderColor: theme.border },
              ]}
            >
              <Text style={[styles.infoLabel, { color: theme.mutedText }]}>Payment Status</Text>
              <Text style={[styles.infoValue, { color: theme.text }]}>
                {getAdPaymentStatusLabel(status, payment)}
              </Text>
            </View>
          </View>

          <AdFormPrimaryCta
            label="Save Changes"
            onPress={save}
            disabled={!canSave || saving}
            loading={saving}
          />

          {payment === 'paid' && bookedDates.length > 0 ? (
            <View
              style={[
                styles.bookedDatesCard,
                { backgroundColor: theme.surface, borderColor: theme.border },
              ]}
            >
              <Text style={[styles.bookedDatesTitle, { color: theme.text }]}>
                Scheduled Campaign Dates
              </Text>
              <View style={styles.bookedDatesWrap}>
                {bookedDates.map(date => (
                  <View key={date} style={[styles.bookedDateChip, { borderColor: theme.border }]}>
                    <Text style={[styles.bookedDateText, { color: theme.text }]}>
                      {new Date(`${date}T00:00:00`).toLocaleDateString('en-US', {
                        weekday: 'short',
                        month: 'short',
                        day: 'numeric',
                      })}
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          ) : (
            <Pressable
              onPress={() =>
                void router.push({ pathname: '/ad-calendar', params: { adId: String(id || '') } })
              }
              style={[
                styles.ctaSecondary,
                { backgroundColor: theme.surface, borderColor: theme.border },
              ]}
            >
              <Text style={[styles.ctaSecondaryText, { color: theme.text }]}>
                Schedule Campaign Dates
              </Text>
            </Pressable>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  infoCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
  },
  infoLabel: {
    fontSize: 14,
    fontWeight: '600',
  },
  infoValue: {
    fontSize: 14,
    fontWeight: '700',
  },
  bannerPreview: {
    width: '100%',
    height: 160,
    borderRadius: 8,
    overflow: 'hidden',
    marginBottom: 8,
  },
  bannerImage: {
    width: '100%',
    height: '100%',
  },
  bannerPlaceholder: {
    width: '100%',
    height: 120,
    borderRadius: 8,
    borderWidth: 2,
    borderStyle: 'dashed',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    marginBottom: 8,
  },
  bannerPlaceholderText: {
    fontSize: 15,
    fontWeight: '600',
  },
  uploadBtn: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    backgroundColor: '#111827',
    alignItems: 'center',
  },
  uploadBtnDisabled: {
    opacity: 0.5,
  },
  uploadBtnText: {
    color: 'white',
    fontWeight: '700',
    fontSize: 15,
  },
  ctaSecondary: {
    height: 52,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  ctaSecondaryText: {
    fontWeight: '800',
    fontSize: 17,
    letterSpacing: 0.3,
  },
  bookedDatesCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 14,
    marginBottom: 12,
  },
  bookedDatesTitle: {
    fontWeight: '800',
    fontSize: 16,
    marginBottom: 10,
  },
  bookedDatesWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  bookedDateChip: {
    borderWidth: 1,
    borderRadius: 6,
    paddingVertical: 4,
    paddingHorizontal: 10,
  },
  bookedDateText: {
    fontSize: 13,
    fontWeight: '600',
  },
});
