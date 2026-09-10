import { toUserMessage } from '@/utils/toUserMessage';
import CoachAccessRedirecting from '@/components/CoachAccessRedirecting';
import {
  EditScreenHeader,
  EditScreenLoading,
  EditScreenSubmitButton,
  EditTextField,
  editScreenSharedStyles as sharedStyles,
} from '@/components/EditScreenShared';
import { Colors } from '@/constants/Colors';
import { useAuth } from '@/context/AuthProvider';
import { useColorScheme } from '@/hooks/useColorScheme';
import { useRequireTeamManagement } from '@/hooks/useRequireTeamManagement';
import { handleCoachAccessError } from '@/utils/coachAccess';
import { uploadEventBannerFromUri } from '@/utils/eventBannerUpload';
import { buildEventDetailHref } from '@/utils/eventRoutes';
import { optimizeImageUrl } from '@/utils/imageUrl';
import { safeGoBack } from '@/utils/navigation';
import { pickerMediaTypesProp } from '@/utils/picker';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as ImagePicker from 'expo-image-picker';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
// @ts-ignore
import { Event } from '@/api/entities';

export default function EditEventScreen() {
  const { user } = useAuth();
  // Role-barrier model: event create/edit/approve-deny is an "authorized
  // user" function (manager/assistant_coach included) — gate on the
  // membership-aware hook, not the coach-role-only useRequireCoach that
  // wrongly bounced non-coach staff. Server still authorizes per-event.
  const { canManage: canAccessCoachTools, loading: coachLoading } = useRequireTeamManagement();
  const router = useRouter();
  const { id, fallback } = useLocalSearchParams<{ id?: string; fallback?: string }>();
  const colorScheme = useColorScheme() ?? 'light';
  const insets = useSafeAreaInsets();
  const explicitFallback =
    typeof fallback === 'string' && fallback.trim().startsWith('/')
      ? fallback.trim()
      : id
        ? buildEventDetailHref(String(id))
        : '/(tabs)/discover';

  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [title, setTitle] = useState('');
  const [originalTitle, setOriginalTitle] = useState('');
  const [isApprovedEvent, setIsApprovedEvent] = useState(false);
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('');
  const [dateStr, setDateStr] = useState('');
  const [bannerUrl, setBannerUrl] = useState<string | null>(null);
  const [uploadingBanner, setUploadingBanner] = useState(false);
  const loadEvent = useCallback(async () => {
    if (!id || coachLoading || !canAccessCoachTools) return;
    setLoading(true);
    try {
      const data = await Event.get(String(id));
      if (!data || typeof data.id === 'undefined') {
        Alert.alert('Error', 'Event not found.');
        safeGoBack(router, explicitFallback);
        return;
      }
      if (!data.can_cancel) {
        Alert.alert('Access Denied', 'You do not have permission to edit this event.');
        safeGoBack(router, explicitFallback);
        return;
      }
      setTitle(data.title || '');
      setOriginalTitle(data.title || '');
      setIsApprovedEvent(data.approval_status === 'approved');
      setDescription(data.description || '');
      setLocation(data.location || '');
      setBannerUrl(data.banner_url || data.cover_image_url || null);
      // Format date for editing — show ISO local datetime string
      if (data.date) {
        const d = new Date(data.date);
        if (!isNaN(d.getTime())) {
          // Format as YYYY-MM-DDTHH:MM for display
          const pad = (n: number) => String(n).padStart(2, '0');
          setDateStr(
            `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
          );
        }
      }
    } catch (e: any) {
      if (handleCoachAccessError(router, e, 'editing events', user)) {
        return;
      }
      if (__DEV__) console.error('[edit-event] Failed to load event:', e);
      Alert.alert('Error', 'Failed to load event data.');
      safeGoBack(router, explicitFallback);
    } finally {
      setLoading(false);
    }
  }, [canAccessCoachTools, coachLoading, explicitFallback, id, router, user]);

  useEffect(() => {
    if (coachLoading || !canAccessCoachTools) return;
    void loadEvent();
  }, [canAccessCoachTools, coachLoading, loadEvent]);

  // All useCallback hooks must run on every render — declared above the
  // coach-gate early returns so React's hook-order invariant holds.
  const uploadBannerFromUri = useCallback(async (uri: string) => {
    setUploadingBanner(true);
    try {
      const nextUrl = await uploadEventBannerFromUri(uri);
      setBannerUrl(nextUrl);
    } finally {
      setUploadingBanner(false);
    }
  }, []);

  const handleBannerPickerResult = useCallback(
    async (result: ImagePicker.ImagePickerResult) => {
      if (!result.canceled && result.assets[0]) {
        try {
          await uploadBannerFromUri(result.assets[0].uri);
        } catch (error: any) {
          Alert.alert(
            'Upload Failed',
            toUserMessage(error, 'Failed to upload event photo. Please try again.')
          );
        }
      }
    },
    [uploadBannerFromUri]
  );

  const selectBannerImage = useCallback(
    async ({
      requestPermission,
      permissionMessage,
      launchPicker,
    }: {
      requestPermission: () => Promise<
        ImagePicker.CameraPermissionResponse | ImagePicker.MediaLibraryPermissionResponse
      >;
      permissionMessage: string;
      launchPicker: () => Promise<ImagePicker.ImagePickerResult>;
    }) => {
      const { status } = await requestPermission();
      if (status !== 'granted') {
        Alert.alert('Permission required', permissionMessage, [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: () => Linking.openSettings() },
        ]);
        return;
      }

      await handleBannerPickerResult(await launchPicker());
    },
    [handleBannerPickerResult]
  );

  const pickBannerFromLibrary = useCallback(async () => {
    await selectBannerImage({
      requestPermission: ImagePicker.requestMediaLibraryPermissionsAsync,
      permissionMessage: 'Photo library permission is needed to upload an event photo.',
      launchPicker: () =>
        ImagePicker.launchImageLibraryAsync({
          ...pickerMediaTypesProp(),
          allowsEditing: true,
          // Event cards render banners at 4:5 (app/feed.tsx FullBleedCardImage) —
          // crop at the displayed ratio so uploads aren't re-cropped at render time.
          aspect: [4, 5],
          quality: 0.9,
          exif: false,
        }),
    });
  }, [selectBannerImage]);

  const takeBannerPhoto = useCallback(async () => {
    await selectBannerImage({
      requestPermission: ImagePicker.requestCameraPermissionsAsync,
      permissionMessage: 'Camera permission is needed to take an event photo.',
      launchPicker: () =>
        ImagePicker.launchCameraAsync({
          ...pickerMediaTypesProp(),
          allowsEditing: true,
          // Event cards render banners at 4:5 (app/feed.tsx FullBleedCardImage) —
          // crop at the displayed ratio so uploads aren't re-cropped at render time.
          aspect: [4, 5],
          quality: 0.9,
          exif: false,
        }),
    });
  }, [selectBannerImage]);

  const showBannerOptions = useCallback(() => {
    Alert.alert('Event Photo', 'Choose how you want to update the event photo.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Photo Library', onPress: () => void pickBannerFromLibrary() },
      { text: 'Take Photo', onPress: () => void takeBannerPhoto() },
    ]);
  }, [pickBannerFromLibrary, takeBannerPhoto]);

  if (coachLoading) {
    return (
      <SafeAreaView
        style={[
          styles.container,
          sharedStyles.loadingContainer,
          { backgroundColor: Colors[colorScheme].background },
        ]}
        edges={['top', 'bottom']}
      >
        <ActivityIndicator size="large" color={Colors[colorScheme].tint} />
      </SafeAreaView>
    );
  }

  if (!canAccessCoachTools) {
    return (
      <CoachAccessRedirecting
        backgroundColor={Colors[colorScheme].background}
        spinnerColor={Colors[colorScheme].tint}
        textColor={Colors[colorScheme].mutedText}
      />
    );
  }

  const onSubmit = async () => {
    if (!title.trim() && !isApprovedEvent) {
      Alert.alert('Title required', 'Please enter an event title.');
      return;
    }

    // Validate date if provided
    let parsedDate: string | undefined;
    if (dateStr.trim()) {
      const d = new Date(dateStr.trim());
      if (isNaN(d.getTime())) {
        Alert.alert(
          'Invalid Date',
          'Please enter a valid date in YYYY-MM-DDTHH:MM format (e.g. 2026-04-15T18:00).'
        );
        return;
      }
      parsedDate = d.toISOString();
    }

    setSubmitting(true);
    try {
      const updateData: Record<string, any> = {
        description: description.trim() || undefined,
        location: location.trim() || undefined,
        banner_url: bannerUrl ?? null,
      };
      // Only include title if it changed — approved events reject title changes from coaches
      if (title.trim() !== originalTitle) {
        updateData.title = title.trim();
      }
      if (parsedDate) {
        updateData.date = parsedDate;
      }

      await Event.update(String(id), updateData);
      Alert.alert('Success', 'Event updated successfully.', [
        { text: 'OK', onPress: () => safeGoBack(router, explicitFallback) },
      ]);
    } catch (e: any) {
      if (handleCoachAccessError(router, e, 'editing events', user)) {
        return;
      }
      if (__DEV__) console.error('[edit-event] Update failed:', e);
      const msg = toUserMessage(e, 'Failed to update event.');
      Alert.alert('Error', msg);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <EditScreenLoading
        title="Edit Event"
        message="Loading event..."
        backgroundColor={Colors[colorScheme].background}
        tintColor={Colors[colorScheme].tint}
        textColor={Colors[colorScheme].text}
      />
    );
  }

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: Colors[colorScheme].background }]}
      edges={['bottom']}
    >
      <Stack.Screen options={{ title: 'Edit Event', headerShown: false }} />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 32 }}
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
      >
        {/* Header */}
        <EditScreenHeader
          title="Edit Event"
          textColor={Colors[colorScheme].text}
          topPadding={12 + insets.top}
          onBack={() => safeGoBack(router, explicitFallback)}
        />

        {/* Form Fields */}
        <View style={styles.formSection}>
          <View style={sharedStyles.inputGroup}>
            <Text style={[sharedStyles.inputLabel, { color: Colors[colorScheme].text }]}>
              Title {isApprovedEvent ? '(locked — event is approved)' : '*'}
            </Text>
            <TextInput
              style={[
                sharedStyles.textInput,
                {
                  backgroundColor: Colors[colorScheme].surface,
                  borderColor: Colors[colorScheme].border,
                  color: isApprovedEvent ? Colors[colorScheme].mutedText : Colors[colorScheme].text,
                  opacity: isApprovedEvent ? 0.6 : 1,
                },
              ]}
              value={title}
              onChangeText={isApprovedEvent ? undefined : setTitle}
              editable={!isApprovedEvent}
              placeholder="Event title"
              placeholderTextColor={Colors[colorScheme].mutedText}
            />
          </View>

          <View style={sharedStyles.inputGroup}>
            <View style={sharedStyles.labelRow}>
              <Text style={[sharedStyles.inputLabel, { color: Colors[colorScheme].text }]}>
                Description
              </Text>
              <Text
                style={[
                  sharedStyles.charCount,
                  { color: description.length > 1000 ? '#DC2626' : Colors[colorScheme].mutedText },
                ]}
              >
                {description.length}/1000
              </Text>
            </View>
            <TextInput
              style={[
                sharedStyles.textArea,
                styles.eventTextArea,
                {
                  backgroundColor: Colors[colorScheme].surface,
                  borderColor: description.length > 1000 ? '#DC2626' : Colors[colorScheme].border,
                  color: Colors[colorScheme].text,
                },
              ]}
              value={description}
              onChangeText={text => {
                if (text.length <= 1000) setDescription(text);
              }}
              placeholder="Event description (optional)"
              placeholderTextColor={Colors[colorScheme].mutedText}
              multiline
              numberOfLines={4}
              maxLength={1000}
            />
          </View>

          <View style={sharedStyles.inputGroup}>
            <Text style={[sharedStyles.inputLabel, { color: Colors[colorScheme].text }]}>
              Event Photo
            </Text>
            <Text style={[sharedStyles.fieldHint, { color: Colors[colorScheme].mutedText }]}>
              Update the image used on the event card and background so edited events do not stay
              blank.
            </Text>
            <View
              style={[
                styles.bannerCard,
                {
                  backgroundColor: Colors[colorScheme].surface,
                  borderColor: Colors[colorScheme].border,
                },
              ]}
            >
              {bannerUrl ? (
                <Image
                  source={{ uri: optimizeImageUrl(bannerUrl, 1200) }}
                  style={styles.bannerPreview}
                  resizeMode="cover"
                />
              ) : (
                <View
                  style={[
                    styles.bannerEmptyState,
                    { backgroundColor: Colors[colorScheme].background },
                  ]}
                >
                  <MaterialIcons name="image" size={28} color={Colors[colorScheme].mutedText} />
                  <Text style={[styles.bannerEmptyText, { color: Colors[colorScheme].mutedText }]}>
                    No event photo uploaded yet
                  </Text>
                </View>
              )}
              <View style={styles.bannerActionRow}>
                <Pressable
                  style={[
                    styles.bannerPrimaryButton,
                    { backgroundColor: Colors[colorScheme].tint },
                  ]}
                  onPress={showBannerOptions}
                  disabled={uploadingBanner}
                >
                  <MaterialIcons name="photo-camera" size={16} color="#FFFFFF" />
                  <Text style={styles.bannerPrimaryButtonText}>
                    {uploadingBanner ? 'Uploading...' : bannerUrl ? 'Change Photo' : 'Upload Photo'}
                  </Text>
                </Pressable>
                {bannerUrl ? (
                  <Pressable
                    style={[
                      styles.bannerSecondaryButton,
                      { borderColor: Colors[colorScheme].border },
                    ]}
                    onPress={() => setBannerUrl(null)}
                    disabled={uploadingBanner}
                  >
                    <MaterialIcons
                      name="delete-outline"
                      size={16}
                      color={Colors[colorScheme].text}
                    />
                    <Text
                      style={[
                        styles.bannerSecondaryButtonText,
                        { color: Colors[colorScheme].text },
                      ]}
                    >
                      Remove
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          </View>

          <EditTextField
            label="Location"
            value={location}
            onChangeText={setLocation}
            placeholder="Event location (optional)"
            textColor={Colors[colorScheme].text}
            mutedTextColor={Colors[colorScheme].mutedText}
            surfaceColor={Colors[colorScheme].surface}
            borderColor={Colors[colorScheme].border}
          />

          <View style={sharedStyles.inputGroup}>
            <Text style={[sharedStyles.inputLabel, { color: Colors[colorScheme].text }]}>
              Date & Time
            </Text>
            <TextInput
              style={[
                sharedStyles.textInput,
                {
                  backgroundColor: Colors[colorScheme].surface,
                  borderColor: Colors[colorScheme].border,
                  color: Colors[colorScheme].text,
                },
              ]}
              value={dateStr}
              onChangeText={setDateStr}
              placeholder="YYYY-MM-DDTHH:MM (e.g. 2026-04-15T18:00)"
              placeholderTextColor={Colors[colorScheme].mutedText}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Text style={[sharedStyles.fieldHint, { color: Colors[colorScheme].mutedText }]}>
              Format: YYYY-MM-DDTHH:MM (24-hour time)
            </Text>
          </View>
        </View>

        <EditScreenSubmitButton
          label="Update Event"
          tintColor={Colors[colorScheme].tint}
          disabled={submitting || uploadingBanner}
          loading={submitting || uploadingBanner}
          onPress={onSubmit}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  formSection: {
    marginBottom: 24,
    paddingHorizontal: 20,
  },
  eventTextArea: { minHeight: 100 },
  bannerCard: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 12,
    gap: 12,
  },
  bannerPreview: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: 12,
  },
  bannerEmptyState: {
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  bannerEmptyText: {
    fontSize: 14,
    fontWeight: '500',
  },
  bannerActionRow: {
    flexDirection: 'row',
    gap: 10,
  },
  bannerPrimaryButton: {
    flex: 1,
    minHeight: 42,
    borderRadius: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 12,
  },
  bannerPrimaryButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
  },
  bannerSecondaryButton: {
    minHeight: 42,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 14,
  },
  bannerSecondaryButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
});
