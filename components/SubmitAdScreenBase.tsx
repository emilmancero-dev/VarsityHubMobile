import settings from '@/api/settings';
import { httpGet } from '@/api/http';
import { Advertisement as AdsApi } from '@/api/entities';
import {
  AdFormHeader,
  AdFormPrimaryCta,
  adFormSharedStyles as sharedStyles,
} from '@/components/AdFormShared';
import { BannerUpload } from '@/components/BannerUpload';
import { ReachMapPreview } from '@/components/ReachMapPreview';
import { AD_GEOFENCE_RADIUS_KM } from '@/constants/adGeofencing';
import { Colors } from '@/constants/Colors';
import { useColorScheme } from '@/hooks/useColorScheme';
import { sanitizeText } from '@/utils/formUtils';
import { safeGoBack } from '@/utils/navigation';
import { promptForSignIn } from '@/utils/requireSignIn';
import { toUserMessage } from '@/utils/toUserMessage';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Stack, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets, type Edge } from 'react-native-safe-area-context';

type BannerFitValue = 'rotate' | 'fill' | 'stretch' | `rotate:${number}`;
type ServerBannerFitMode = 'cover' | 'contain' | 'fill';

type DraftAd = {
  id: string;
  business_name: string;
  contact_name: string;
  contact_email: string;
  banner_url?: string;
  banner_fit_mode?: BannerFitValue;
  target_url?: string;
  zip_code: string;
  description?: string;
  created_at: string;
  owner_id?: string | null;
  isLocal?: boolean;
};

export function SubmitAdScreenBase({
  zip,
  setZip,
  showReachPreview,
  safeAreaEdges,
  respectTopInset,
}: {
  zip: string;
  setZip: (value: string) => void;
  showReachPreview: boolean;
  safeAreaEdges: Edge[];
  respectTopInset: boolean;
}) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme() ?? 'light';
  const theme = Colors[colorScheme];
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [business, setBusiness] = useState('');
  const [bannerUrl, setBannerUrl] = useState<string | null>(null);
  const [bannerFitMode, setBannerFitMode] = useState<BannerFitValue>('fill');
  const [targetUrl, setTargetUrl] = useState('');
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const [scrollEnabled, setScrollEnabled] = useState(true);

  const normalizeUrl = (url: string): string => {
    const trimmed = url.trim();
    if (!trimmed) return '';
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return `https://${trimmed}`;
  };

  const normalizeBannerFitMode = (mode: BannerFitValue): ServerBannerFitMode => {
    if (String(mode).startsWith('rotate')) return 'contain';
    if (mode === 'stretch') return 'fill';
    return 'fill';
  };

  const canSubmit = useMemo(() => {
    if (!name.trim() || !email.trim() || !business.trim()) return false;
    if (!/^[A-Za-z0-9][A-Za-z0-9\s\-]{0,10}[A-Za-z0-9]$/.test(zip.trim())) return false;
    if (!bannerUrl) return false;
    if (!targetUrl.trim()) return false;
    return true;
  }, [name, email, business, zip, bannerUrl, targetUrl]);

  const handleBannerChange = (
    uri: string,
    fitMode: BannerFitValue,
    _position?: { x: number; y: number }
  ) => {
    setBannerUrl(uri);
    setBannerFitMode(fitMode);
  };

  const submit = async () => {
    if (!canSubmit || busy) return;
    setBusy(true);
    try {
      let currentUserId: string | null = null;
      let normalizedEmail = email.trim().toLowerCase();
      try {
        const me: any = await httpGet('/me', {}, 3000, 0);
        currentUserId = me?.id ? String(me.id) : null;
        if (!normalizedEmail && typeof me?.email === 'string') {
          normalizedEmail = me.email.trim().toLowerCase();
        }
      } catch (err) {
        if (__DEV__) {
          console.warn('[submit-ad] /me prefetch failed:', (err as Error)?.message ?? err);
        }
      }

      let serverId: string | null = null;
      let createError: string | null = null;
      try {
        const created: any = await AdsApi.create({
          contact_name: sanitizeText(name),
          contact_email: email.trim(),
          business_name: sanitizeText(business),
          banner_url: bannerUrl || undefined,
          banner_fit_mode: normalizeBannerFitMode(bannerFitMode),
          target_url: normalizeUrl(targetUrl) || undefined,
          target_zip_code: zip.trim(),
          radius: AD_GEOFENCE_RADIUS_KM,
          description: sanitizeText(desc) || undefined,
        });
        serverId = String(created?.id || '');
        if (created?.user_id) currentUserId = String(created.user_id);
        if (typeof created?.contact_email === 'string') {
          normalizedEmail = created.contact_email.trim().toLowerCase();
        }
      } catch (err: any) {
        createError = toUserMessage(err, 'Could not create ad on server');
        const status = Number(err?.status || 0);
        const raw = String(err?.message || err?.data?.error || '').toLowerCase();
        const code = String(err?.data?.code || err?.data?.error || '');
        if (
          status === 401 ||
          code === 'AUTH_REQUIRED' ||
          raw.includes('unauthorized') ||
          raw.includes('authentication required') ||
          raw.includes('auth_required')
        ) {
          promptForSignIn(() => router.push('/sign-in'), {
            message: 'Sign in to reserve ad space.',
          });
          return;
        }
        if (err?.status === 403) {
          const msg = raw;
          if (msg.includes('verification') || msg.includes('verified')) {
            Alert.alert(
              'Email Verification Required',
              'You need to verify your email before submitting an ad. Would you like to verify now?',
              [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Verify Now', onPress: () => router.push('/verify-email' as any) },
              ]
            );
            return;
          }
          if (code === 'PLAN_REQUIRED') {
            Alert.alert('Error', 'Unable to create ad. Please try again or contact support.');
            return;
          }
        }
      }

      if (!serverId) {
        Alert.alert(
          'Error',
          createError || 'Could not create your ad. Please check your connection and try again.'
        );
        return;
      }

      const adId = serverId;
      try {
        const draft: DraftAd = {
          id: adId,
          business_name: business.trim(),
          contact_name: name.trim(),
          contact_email: normalizedEmail || email.trim().toLowerCase(),
          banner_url: bannerUrl || undefined,
          banner_fit_mode: bannerFitMode,
          target_url: normalizeUrl(targetUrl) || undefined,
          zip_code: zip.trim(),
          description: desc.trim() || undefined,
          created_at: new Date().toISOString(),
          owner_id: currentUserId,
          isLocal: false,
        };
        const baseKey = settings.SETTINGS_KEYS.LOCAL_ADS;
        const scopedKey = currentUserId ? `${baseKey}_${currentUserId}` : baseKey;
        const arr = await settings.getJson<DraftAd[]>(scopedKey, []);
        const next = arr.filter(a => a.id !== adId).concat([draft]);
        await settings.setJson(scopedKey, next);
        if (currentUserId) {
          const legacy = await settings.getJson<DraftAd[]>(baseKey, []);
          const legacyFiltered = legacy.filter(a => a.id !== adId);
          if (legacyFiltered.length !== legacy.length) {
            await settings.setJson(baseKey, legacyFiltered);
          }
        }
      } catch (err) {
        if (__DEV__) {
          console.warn(
            '[submit-ad] Failed to cache draft locally:',
            (err as Error)?.message ?? err
          );
        }
      }

      router.push({ pathname: '/ad-calendar', params: { adId } });
    } catch (e: any) {
      Alert.alert('Error', toUserMessage(e, 'Failed to save your ad.'));
    } finally {
      setBusy(false);
    }
  };

  const topPadding = useMemo(
    () => (respectTopInset ? Math.max(insets.top + 12, 20) : 8),
    [insets.top, respectTopInset]
  );
  const bottomPadding = useMemo(() => Math.max(insets.bottom + 16, 32), [insets.bottom]);

  return (
    <SafeAreaView
      style={[sharedStyles.container, { backgroundColor: theme.background }]}
      edges={safeAreaEdges}
    >
      <Stack.Screen
        options={{
          title: 'Submit Ad',
          headerShown: true,
          headerLeft: () => (
            <Pressable
              onPress={() => safeGoBack(router)}
              style={{ padding: 8 }}
              accessibilityLabel="Go back"
            >
              <MaterialIcons name="arrow-back" size={24} color={theme.text} />
            </Pressable>
          ),
        }}
      />
      <ScrollView
        scrollEnabled={scrollEnabled}
        contentContainerStyle={[
          sharedStyles.scrollContent,
          { paddingTop: topPadding, paddingBottom: bottomPadding },
        ]}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        automaticallyAdjustKeyboardInsets
      >
        <AdFormHeader
          title="Submit a Local Ad"
          subtitle="Promote your business to local teams and families. Submit your ad creative for review first, then book dates after approval."
          textColor={theme.text}
          mutedTextColor={theme.mutedText}
        />

        <View
          style={[sharedStyles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}
        >
          <Text style={[sharedStyles.label, { color: theme.text }]}>Your Name *</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Jane Doe"
            style={[
              sharedStyles.input,
              { backgroundColor: theme.card, borderColor: theme.border, color: theme.text },
            ]}
            placeholderTextColor={theme.mutedText}
            autoCapitalize="words"
            maxLength={200}
          />

          <Text style={[sharedStyles.label, { color: theme.text }]}>Email Address *</Text>
          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="you@business.com"
            style={[
              sharedStyles.input,
              { backgroundColor: theme.card, borderColor: theme.border, color: theme.text },
            ]}
            placeholderTextColor={theme.mutedText}
            keyboardType="email-address"
            autoCapitalize="none"
            maxLength={320}
          />

          <Text style={[sharedStyles.label, { color: theme.text }]}>Business Name *</Text>
          <TextInput
            value={business}
            onChangeText={setBusiness}
            placeholder="Downtown Pizza & Grill"
            style={[
              sharedStyles.input,
              { backgroundColor: theme.card, borderColor: theme.border, color: theme.text },
            ]}
            placeholderTextColor={theme.mutedText}
          />

          <Text style={[sharedStyles.label, { color: theme.text }]}>Target Zip Code *</Text>
          <TextInput
            value={zip}
            onChangeText={setZip}
            placeholder="12345"
            style={[
              sharedStyles.input,
              { backgroundColor: theme.card, borderColor: theme.border, color: theme.text },
            ]}
            placeholderTextColor={theme.mutedText}
            keyboardType={Platform.OS === 'ios' ? 'number-pad' : 'numeric'}
            maxLength={12}
          />

          {showReachPreview ? (
            <ReachMapPreview zipCode={zip} radiusKm={AD_GEOFENCE_RADIUS_KM} />
          ) : null}

          <Text style={[sharedStyles.label, { color: theme.text }]}>Ad Banner *</Text>
          <BannerUpload
            value={bannerUrl || ''}
            onChange={handleBannerChange}
            aspectRatio={16 / 9}
            required={true}
            onScrollLock={showReachPreview ? locked => setScrollEnabled(!locked) : undefined}
            uploadFormFields={{ purpose: 'ad_banner' }}
          />
          {!bannerUrl ? (
            <Text style={[sharedStyles.muted, { color: theme.mutedText }]}>
              Banner image is required for your ad
            </Text>
          ) : null}

          <Text style={[sharedStyles.label, { color: theme.text }]}>Website Link *</Text>
          <TextInput
            value={targetUrl}
            onChangeText={setTargetUrl}
            placeholder="https://yourwebsite.com"
            style={[
              sharedStyles.input,
              { backgroundColor: theme.card, borderColor: theme.border, color: theme.text },
            ]}
            placeholderTextColor={theme.mutedText}
            keyboardType="url"
            autoCapitalize="none"
            autoCorrect={false}
          />
          {targetUrl.trim() ? (
            <Text style={[sharedStyles.helperText, { color: theme.mutedText }]}>
              🔗 Users can tap your ad to visit this website
            </Text>
          ) : null}

          <Text style={[sharedStyles.label, { color: theme.text }]}>Description (Optional)</Text>
          <TextInput
            value={desc}
            onChangeText={setDesc}
            placeholder="Tell us about your business or message..."
            style={[
              sharedStyles.input,
              sharedStyles.textArea,
              { backgroundColor: theme.card, borderColor: theme.border, color: theme.text },
            ]}
            placeholderTextColor={theme.mutedText}
            multiline
            numberOfLines={4}
            textAlignVertical="top"
            maxLength={1000}
          />
        </View>

        <AdFormPrimaryCta
          label="📅 Continue to Calendar"
          onPress={submit}
          disabled={!canSubmit || busy}
          loading={busy}
        />
      </ScrollView>
    </SafeAreaView>
  );
}
