import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { Image } from 'expo-image';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Linking,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
// @ts-ignore
import { User } from '@/api/entities';
import { getApiBaseUrl } from '@/api/http';
import { uploadFile } from '@/api/upload';
import { Input } from '@/components/ui/input';
import { Colors } from '@/constants/Colors';
import { useColorScheme } from '@/hooks/useColorScheme';
import { analytics, ANALYTICS_EVENTS } from '@/utils/analytics';
import {
  BIO_MAX_LENGTH,
  DISPLAY_NAME_MAX_LENGTH,
  sanitizeText,
  validateBio,
  validateDisplayName,
  validateZipCode,
} from '@/utils/formUtils';
import { optimizeImageUrl } from '@/utils/imageUrl';
import { materializeICloudAssetIfNeeded } from '@/utils/materializeICloudAsset';
import { safeGoBack } from '@/utils/navigation';
import { pickerMediaTypesProp } from '@/utils/picker';
import { toUserMessage } from '@/utils/toUserMessage';

// Field validation errors
interface FieldErrors {
  displayName?: string;
  zipCode?: string;
  graduationYear?: string;
  bio?: string;
}

const SPORTS_OPTIONS = [
  'Football',
  'Basketball',
  'Baseball',
  'Soccer',
  'Volleyball',
  'Track & Field',
  'Swimming',
  'Hockey',
  'Tennis',
  'Golf',
  'Wrestling',
  'Other',
];

export default function EditProfileScreen() {
  const router = useRouter();
  const colorScheme = useColorScheme();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  // Profile fields - username is edited separately via /settings/edit-username
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [location, setLocation] = useState('');
  const [zipCode, setZipCode] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState<Date | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarTouched, setAvatarTouched] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [headerImageUrl, setHeaderImageUrl] = useState<string | null>(null);
  const [headerImageTouched, setHeaderImageTouched] = useState(false);
  const [uploadingHeaderImage, setUploadingHeaderImage] = useState(false);
  const [headerImageOffset, setHeaderImageOffset] = useState(0); // normalized -1..1
  const [headerImageOffsetTouched, setHeaderImageOffsetTouched] = useState(false);

  // Sports interests
  const [sportsInterests, setSportsInterests] = useState<string[]>([]);

  // User info
  const [me, setMe] = useState<any>(null);

  const HEADER_IMAGE_DRAG_LIMIT = 120;
  const clampValue = (value: number, min: number, max: number) =>
    Math.min(max, Math.max(min, value));
  const headerImagePanStart = useRef(0);
  const headerImageAnimatedOffset = useRef(new Animated.Value(0)).current;

  const loadUserData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const me: any = await User.me({ force: true });
      setMe(me);
      const prefs = me?.preferences || {};

      // Direct fields
      setDisplayName(me?.display_name || '');
      setBio(me?.bio || '');
      setAvatarUrl(me?.avatar_url || null);
      const headerImagePref =
        prefs?.header_image_url || prefs?.profile_header_image_url || me?.header_image_url;
      setHeaderImageUrl(headerImagePref || null);
      setHeaderImageTouched(false);
      setHeaderImageOffset(
        typeof prefs?.header_image_focus_y === 'number'
          ? clampValue(prefs.header_image_focus_y, -1, 1)
          : 0
      );
      setHeaderImageOffsetTouched(false);

      // Fields from preferences
      setLocation(prefs?.location || me?.location || '');
      setZipCode(prefs?.zip_code || me?.zip_code || '');

      // Handle date of birth from preferences or direct field
      const dobValue = prefs?.dob || prefs?.date_of_birth || me?.dob || me?.date_of_birth;
      if (dobValue) {
        try {
          const date = new Date(dobValue);
          setDateOfBirth(date);
        } catch {
          if (__DEV__) console.warn('Invalid date format:', dobValue);
          setDateOfBirth(null);
        }
      }

      // Handle sports interests - check preferences first, then direct field, then legacy location
      const interests = prefs?.sports_interests || me?.sports_interests || [];
      setSportsInterests(Array.isArray(interests) ? interests : []);
    } catch (e: any) {
      if (__DEV__) console.error('Error loading profile:', e);
      setError('You must sign in to edit your profile.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUserData();
  }, [loadUserData]);

  // Reload data when screen comes into focus
  useFocusEffect(
    useCallback(() => {
      void loadUserData();
    }, [loadUserData])
  );

  const toggleSport = (sport: string) => {
    setSportsInterests(
      prev =>
        prev.includes(sport)
          ? prev.filter(s => s !== sport)
          : prev.length < 3
            ? [...prev, sport]
            : prev // Don't add more if already at max
    );
  };

  const formatDateForAPI = (date: Date | null) => {
    if (!date) return undefined;
    return date.toISOString().split('T')[0]; // YYYY-MM-DD format
  };

  const pickAvatarImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(
        'Permission required',
        'Gallery permission is needed to select a profile picture.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: () => Linking.openSettings() },
        ]
      );
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      ...pickerMediaTypesProp(),
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
      exif: false,
    });

    if (!result.canceled && result.assets && result.assets[0]) {
      await uploadAvatar(result.assets[0].uri);
    }
  };

  const takeAvatarPhoto = async () => {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('Permission required', 'Camera permission is needed to take a profile picture.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open Settings', onPress: () => Linking.openSettings() },
      ]);
      return;
    }

    const result = await ImagePicker.launchCameraAsync({
      ...pickerMediaTypesProp(),
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
      exif: false,
    });

    if (!result.canceled && result.assets && result.assets[0]) {
      await uploadAvatar(result.assets[0].uri);
    }
  };

  const uploadAvatar = async (uri: string) => {
    setUploadingAvatar(true);
    try {
      const localUri = await materializeICloudAssetIfNeeded(uri);

      // Compress and resize the image
      const manipulatedImage = await ImageManipulator.manipulateAsync(
        localUri,
        [{ resize: { width: 400, height: 400 } }],
        { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG }
      );

      // Upload to server
      const uploadResult = await uploadFile(
        getApiBaseUrl(),
        manipulatedImage.uri,
        'avatar.jpg',
        'image/jpeg'
      );

      if (uploadResult?.url) {
        setAvatarUrl(uploadResult.url);
        setAvatarTouched(true);
        Alert.alert('Success', 'Profile picture uploaded successfully!');
      } else {
        throw new Error('Upload failed - no URL returned');
      }
    } catch (error: any) {
      if (__DEV__) console.error('Avatar upload error:', error);
      Alert.alert(
        'Upload Failed',
        toUserMessage(error, 'Failed to upload profile picture. Please try again.')
      );
    } finally {
      setUploadingAvatar(false);
    }
  };

  const showAvatarOptions = () => {
    Alert.alert('Profile Picture', "Choose how you'd like to update your profile picture", [
      { text: 'Take Photo', onPress: takeAvatarPhoto },
      { text: 'Choose from Gallery', onPress: pickAvatarImage },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const pickHeaderImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert(
        'Permission required',
        'Gallery permission is needed to select a background image.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: () => Linking.openSettings() },
        ]
      );
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      ...pickerMediaTypesProp(),
      allowsEditing: true,
      // Profile background renders full width x 200px (~2:1) — crop to match.
      aspect: [2, 1],
      quality: 0.85,
      exif: false,
    });

    if (!result.canceled && result.assets && result.assets[0]) {
      await uploadHeaderImage(result.assets[0].uri);
    }
  };

  const uploadHeaderImage = async (uri: string) => {
    setUploadingHeaderImage(true);
    try {
      const localUri = await materializeICloudAssetIfNeeded(uri);

      const manipulatedImage = await ImageManipulator.manipulateAsync(
        localUri,
        [{ resize: { width: 1600 } }],
        { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG }
      );

      const uploadResult = await uploadFile(
        getApiBaseUrl(),
        manipulatedImage.uri,
        'profile-cover.jpg',
        'image/jpeg'
      );
      if (uploadResult?.url) {
        setHeaderImageUrl(uploadResult.url);
        setHeaderImageTouched(true);
        Alert.alert('Background updated', 'Your profile background image looks great!');
      } else {
        throw new Error('Upload failed - no URL returned');
      }
    } catch (error: any) {
      if (__DEV__) console.error('Header image upload error:', error);
      Alert.alert(
        'Upload Failed',
        toUserMessage(error, 'Failed to upload background image. Please try again.')
      );
    } finally {
      setUploadingHeaderImage(false);
    }
  };

  const removeHeaderImage = () => {
    setHeaderImageUrl(null);
    setHeaderImageTouched(true);
    setHeaderImageOffset(0);
    setHeaderImageOffsetTouched(true);
  };

  useEffect(() => {
    Animated.spring(headerImageAnimatedOffset, {
      toValue: headerImageOffset * HEADER_IMAGE_DRAG_LIMIT,
      useNativeDriver: true,
    }).start();
  }, [headerImageOffset, headerImageAnimatedOffset]);

  const headerImagePanResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => Boolean(headerImageUrl),
        onMoveShouldSetPanResponder: () => Boolean(headerImageUrl),
        onPanResponderGrant: () => {
          headerImagePanStart.current = headerImageOffset;
        },
        onPanResponderMove: (_evt, gestureState) => {
          if (!headerImageUrl) return;
          const next = clampValue(
            headerImagePanStart.current + gestureState.dy / HEADER_IMAGE_DRAG_LIMIT,
            -1,
            1
          );
          headerImageAnimatedOffset.setValue(next * HEADER_IMAGE_DRAG_LIMIT);
        },
        onPanResponderRelease: (_evt, gestureState) => {
          if (!headerImageUrl) return;
          const next = clampValue(
            headerImagePanStart.current + gestureState.dy / HEADER_IMAGE_DRAG_LIMIT,
            -1,
            1
          );
          setHeaderImageOffset(next);
          setHeaderImageOffsetTouched(true);
        },
        onPanResponderTerminationRequest: () => true,
        onPanResponderTerminate: () => {},
      }),
    [headerImageUrl, headerImageOffset, headerImageAnimatedOffset]
  );

  const onSave = async () => {
    // Validate fields before saving
    const errors: FieldErrors = {};
    const displayNameResult = validateDisplayName(displayName);
    if (displayNameResult.error) {
      errors.displayName = displayNameResult.error;
    }
    const bioResult = validateBio(bio);
    if (bioResult.error) {
      errors.bio = bioResult.error;
    }
    if (zipCode) {
      const zipResult = validateZipCode(zipCode);
      if (zipResult.error) errors.zipCode = zipResult.error;
    }

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      Alert.alert('Validation Error', 'Please fix the highlighted fields before saving.');
      return;
    }

    setSaving(true);
    try {
      // Prepare data for server - split into direct fields and preferences
      // Username is edited separately via /settings/edit-username
      const directFields: any = {
        bio: sanitizeText(bio) || null, // Explicitly send null when blank so backend clears it
        display_name: displayName.trim() || undefined,
      };

      // Include avatar URL only if the user actually uploaded a new one
      if (avatarTouched && avatarUrl) {
        directFields.avatar_url = avatarUrl;
      }

      // Store additional fields in preferences object
      const preferences: any = {};
      // Always send these so clearing a field actually persists
      preferences.location = location.trim() || null;
      preferences.zip_code = zipCode.trim() || null;
      if (dateOfBirth) preferences.dob = formatDateForAPI(dateOfBirth);
      preferences.sports_interests = sportsInterests.length > 0 ? sportsInterests : [];
      if (headerImageTouched) {
        preferences.header_image_url = headerImageUrl || null;
      }
      if (headerImageTouched || headerImageOffsetTouched) {
        preferences.header_image_focus_y = headerImageOffset;
      }
      // Save profile fields and preferences independently so one failure
      // does not block the other (e.g. avatar domain rejection vs background image)
      const errors: string[] = [];
      try {
        await User.updateMe(directFields);
      } catch (e: any) {
        if (__DEV__) console.error('updateMe error:', e);
        errors.push(toUserMessage(e, 'Failed to update profile fields'));
      }

      if (Object.keys(preferences).length > 0) {
        try {
          await User.updatePreferences(preferences);
        } catch (e: any) {
          if (__DEV__) console.error('updatePreferences error:', e);
          errors.push(toUserMessage(e, 'Failed to update preferences'));
        }
      }

      // Reload user data to reflect changes immediately
      await loadUserData();

      if (errors.length > 0) {
        Alert.alert('Partial Save', `Some changes may not have saved:\n${errors.join('\n')}`);
      } else {
        analytics.track(ANALYTICS_EVENTS.PROFILE_EDITED);
        Alert.alert('Saved', 'Profile updated successfully.', [
          { text: 'OK', onPress: () => safeGoBack(router) },
        ]);
      }
    } catch (e: any) {
      if (__DEV__) console.error('Save error:', e);
      Alert.alert('Error', toUserMessage(e, 'Failed to update profile'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: Colors[colorScheme].background }]}>
      <Stack.Screen
        options={{
          title: 'Edit Profile',
          headerStyle: { backgroundColor: Colors[colorScheme].background },
          headerTintColor: Colors[colorScheme].text,
          headerLeft: () => (
            <Pressable onPress={() => safeGoBack(router)} style={{ paddingLeft: 8 }}>
              <MaterialIcons name="chevron-left" size={24} color={Colors[colorScheme].tint} />
            </Pressable>
          ),
        }}
      />

      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={Colors[colorScheme].tint} />
          <Text style={[styles.loadingText, { color: Colors[colorScheme].mutedText }]}>
            Loading profile...
          </Text>
        </View>
      ) : (
        <ScrollView
          style={styles.scrollView}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
        >
          <View style={styles.content}>
            {/* Header */}
            <View style={styles.headerSection}>
              <Text style={[styles.pageTitle, { color: Colors[colorScheme].text }]}>
                Personalize Your Profile
              </Text>
              <Text style={[styles.pageSubtitle, { color: Colors[colorScheme].mutedText }]}>
                Help others get to know you better
              </Text>
            </View>

            {error ? (
              <View
                style={[styles.errorContainer, { backgroundColor: Colors[colorScheme].surface }]}
              >
                <Text style={[styles.error, { color: '#EF4444' }]}>{error}</Text>
              </View>
            ) : null}

            {/* Profile Picture Section */}
            <View
              style={[
                styles.section,
                {
                  backgroundColor: Colors[colorScheme].card,
                  borderColor: Colors[colorScheme].border,
                },
              ]}
            >
              <Text style={[styles.sectionTitle, { color: Colors[colorScheme].text }]}>
                <MaterialIcons name="camera-alt" size={20} color={Colors[colorScheme].tint} />{' '}
                Profile Picture
              </Text>

              <View style={styles.avatarSection}>
                <View style={styles.avatarContainer}>
                  {avatarUrl ? (
                    <Image
                      source={{ uri: optimizeImageUrl(avatarUrl, 160) }}
                      style={styles.avatar}
                      contentFit="cover"
                    />
                  ) : (
                    <View
                      style={[
                        styles.avatarPlaceholder,
                        { backgroundColor: Colors[colorScheme].surface },
                      ]}
                    >
                      <MaterialIcons
                        name="person-outline"
                        size={40}
                        color={Colors[colorScheme].mutedText}
                      />
                    </View>
                  )}

                  {uploadingAvatar && (
                    <View style={styles.avatarLoader}>
                      <ActivityIndicator size="small" color="#FFFFFF" />
                    </View>
                  )}
                </View>

                <Pressable
                  onPress={showAvatarOptions}
                  disabled={uploadingAvatar}
                  style={[
                    styles.changeAvatarButton,
                    {
                      backgroundColor: Colors[colorScheme].tint,
                      opacity: uploadingAvatar ? 0.6 : 1,
                    },
                  ]}
                >
                  <MaterialIcons name="camera-alt" size={16} color="#FFFFFF" />
                  <Text style={styles.changeAvatarText}>
                    {uploadingAvatar ? 'Uploading...' : 'Change Photo'}
                  </Text>
                </Pressable>
              </View>

              {/* Profile Background Image */}
              <View style={styles.bannerSection}>
                <Text style={[styles.bannerLabel, { color: Colors[colorScheme].text }]}>
                  <MaterialIcons name="image" size={18} color={Colors[colorScheme].tint} /> Profile
                  Background
                </Text>
                <View
                  style={[
                    styles.bannerPreview,
                    {
                      borderColor: Colors[colorScheme].border,
                      backgroundColor: Colors[colorScheme].surface,
                    },
                  ]}
                >
                  {headerImageUrl ? (
                    <Animated.View
                      style={[
                        styles.bannerImageWrapper,
                        {
                          transform: [{ translateY: headerImageAnimatedOffset }],
                        },
                      ]}
                      {...headerImagePanResponder.panHandlers}
                    >
                      <Image
                        source={{ uri: optimizeImageUrl(headerImageUrl, 1200) }}
                        style={styles.bannerImage}
                        contentFit="cover"
                      />
                    </Animated.View>
                  ) : (
                    <View style={styles.bannerPlaceholder}>
                      <MaterialIcons
                        name="auto-fix-high"
                        size={32}
                        color={Colors[colorScheme].mutedText}
                      />
                      <Text
                        style={[
                          styles.bannerPlaceholderText,
                          { color: Colors[colorScheme].mutedText },
                        ]}
                      >
                        Add a wide highlight photo to appear behind your avatar
                      </Text>
                    </View>
                  )}
                  {uploadingHeaderImage && (
                    <View style={styles.bannerOverlay}>
                      <ActivityIndicator color="#FFFFFF" />
                    </View>
                  )}
                </View>
                <View style={styles.bannerActions}>
                  <Pressable
                    onPress={pickHeaderImage}
                    disabled={uploadingHeaderImage}
                    style={[
                      styles.bannerButton,
                      {
                        backgroundColor: Colors[colorScheme].tint,
                        opacity: uploadingHeaderImage ? 0.6 : 1,
                      },
                    ]}
                  >
                    <MaterialIcons name="image" size={16} color="#FFFFFF" />
                    <Text style={styles.bannerButtonText}>
                      {uploadingHeaderImage
                        ? 'Uploading...'
                        : headerImageUrl
                          ? 'Change Background'
                          : 'Add Background'}
                    </Text>
                  </Pressable>
                  {headerImageUrl ? (
                    <Pressable
                      onPress={removeHeaderImage}
                      style={[styles.bannerButton, styles.bannerRemoveButton]}
                    >
                      <MaterialIcons name="delete-outline" size={16} color="#DC2626" />
                      <Text style={[styles.bannerButtonText, { color: '#DC2626' }]}>Remove</Text>
                    </Pressable>
                  ) : null}
                </View>
                {headerImageUrl ? (
                  <View style={styles.bannerAdjustmentRow}>
                    <Text
                      style={[styles.fieldNote, { color: Colors[colorScheme].mutedText, flex: 1 }]}
                    >
                      Drag the image to fine-tune what shows in your profile hero.
                    </Text>
                    <Pressable
                      onPress={() => {
                        setHeaderImageOffset(0);
                        setHeaderImageOffsetTouched(true);
                      }}
                      style={styles.bannerResetButton}
                    >
                      <MaterialIcons name="refresh" size={16} color={Colors[colorScheme].tint} />
                      <Text style={[styles.bannerButtonText, { color: Colors[colorScheme].tint }]}>
                        Reset Position
                      </Text>
                    </Pressable>
                  </View>
                ) : (
                  <Text style={[styles.fieldNote, { color: Colors[colorScheme].mutedText }]}>
                    Recommended 3:2 photo (at least 1200px wide) so your profile hero matches the
                    latest design.
                  </Text>
                )}
              </View>
            </View>

            {/* Basic Information Section */}
            <View
              style={[
                styles.section,
                {
                  backgroundColor: Colors[colorScheme].card,
                  borderColor: Colors[colorScheme].border,
                },
              ]}
            >
              <Text style={[styles.sectionTitle, { color: Colors[colorScheme].text }]}>
                <MaterialIcons name="account-circle" size={20} color={Colors[colorScheme].tint} />{' '}
                Basic Information
              </Text>

              {/* Username is edited via Settings > Edit Username */}
              <View style={styles.fieldGroup}>
                <View style={styles.labelRow}>
                  <Text style={[styles.label, { color: Colors[colorScheme].text }]}>
                    Display Name
                  </Text>
                  <Text
                    style={[
                      styles.charCount,
                      {
                        color:
                          displayName.length > DISPLAY_NAME_MAX_LENGTH
                            ? '#DC2626'
                            : Colors[colorScheme].mutedText,
                      },
                    ]}
                  >
                    {displayName.length}/{DISPLAY_NAME_MAX_LENGTH}
                  </Text>
                </View>
                <Input
                  value={displayName}
                  onChangeText={text => {
                    if (text.length <= DISPLAY_NAME_MAX_LENGTH) {
                      setDisplayName(text);
                    }
                    if (fieldErrors.displayName) {
                      setFieldErrors(prev => ({ ...prev, displayName: undefined }));
                    }
                  }}
                  placeholder="How should your name appear?"
                  placeholderTextColor={Colors[colorScheme].mutedText}
                  maxLength={DISPLAY_NAME_MAX_LENGTH}
                  style={[
                    styles.input,
                    {
                      borderColor: fieldErrors.displayName ? '#DC2626' : Colors[colorScheme].border,
                      backgroundColor: Colors[colorScheme].surface,
                      color: Colors[colorScheme].text,
                    },
                  ]}
                />
                {fieldErrors.displayName && (
                  <Text style={[styles.errorText, { color: '#DC2626' }]}>
                    {fieldErrors.displayName}
                  </Text>
                )}
              </View>

              <View style={styles.fieldGroup}>
                <Text style={[styles.label, { color: Colors[colorScheme].mutedText }]}>
                  Username
                </Text>
                <Pressable
                  onPress={() => router.push('/settings/edit-username')}
                  style={[
                    styles.input,
                    {
                      borderColor: Colors[colorScheme].border,
                      backgroundColor: Colors[colorScheme].surface,
                      flexDirection: 'row',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      paddingHorizontal: 12,
                      minHeight: 44,
                    },
                  ]}
                >
                  <Text style={{ color: Colors[colorScheme].text }}>
                    @{(me as any)?.username || 'not set'}
                  </Text>
                  <MaterialIcons
                    name="chevron-right"
                    size={20}
                    color={Colors[colorScheme].mutedText}
                  />
                </Pressable>
                <Text
                  style={[
                    styles.hint,
                    { color: Colors[colorScheme].mutedText, marginTop: 4, fontSize: 12 },
                  ]}
                >
                  Tap to edit your username
                </Text>
              </View>

              <View style={styles.fieldGroup}>
                <View style={styles.labelRow}>
                  <Text style={[styles.label, { color: Colors[colorScheme].text }]}>Bio</Text>
                  <Text
                    style={[
                      styles.charCount,
                      {
                        color:
                          bio.length > BIO_MAX_LENGTH ? '#DC2626' : Colors[colorScheme].mutedText,
                      },
                    ]}
                  >
                    {bio.length}/{BIO_MAX_LENGTH}
                  </Text>
                </View>
                <Input
                  value={bio}
                  onChangeText={text => {
                    if (text.length <= BIO_MAX_LENGTH) {
                      setBio(text);
                    }
                    if (fieldErrors.bio) {
                      setFieldErrors(prev => ({ ...prev, bio: undefined }));
                    }
                  }}
                  placeholder="Tell everyone about yourself..."
                  placeholderTextColor={Colors[colorScheme].mutedText}
                  multiline
                  numberOfLines={3}
                  maxLength={BIO_MAX_LENGTH}
                  style={[
                    styles.textArea,
                    {
                      borderColor: fieldErrors.bio ? '#DC2626' : Colors[colorScheme].border,
                      backgroundColor: Colors[colorScheme].surface,
                      color: Colors[colorScheme].text,
                    },
                  ]}
                />
                {fieldErrors.bio && (
                  <Text style={[styles.errorText, { color: '#DC2626' }]}>{fieldErrors.bio}</Text>
                )}
              </View>
            </View>

            {/* Sports & Interests Section */}
            <View
              style={[
                styles.section,
                {
                  backgroundColor: Colors[colorScheme].card,
                  borderColor: Colors[colorScheme].border,
                },
              ]}
            >
              <Text style={[styles.sectionTitle, { color: Colors[colorScheme].text }]}>
                <MaterialIcons name="sports-football" size={20} color={Colors[colorScheme].tint} />{' '}
                Sports & Interests
              </Text>
              <Text style={[styles.sectionNote, { color: Colors[colorScheme].mutedText }]}>
                Select up to 3 sports you're interested in
              </Text>

              <View style={styles.sportsGrid}>
                {SPORTS_OPTIONS.map(sport => (
                  <Pressable
                    key={sport}
                    style={[
                      styles.sportChip,
                      {
                        backgroundColor: sportsInterests.includes(sport)
                          ? Colors[colorScheme].tint
                          : Colors[colorScheme].surface,
                        borderColor: sportsInterests.includes(sport)
                          ? Colors[colorScheme].tint
                          : Colors[colorScheme].border,
                      },
                    ]}
                    onPress={() => toggleSport(sport)}
                  >
                    <Text
                      style={[
                        styles.sportChipText,
                        {
                          color: sportsInterests.includes(sport)
                            ? '#FFFFFF'
                            : Colors[colorScheme].text,
                        },
                      ]}
                    >
                      {sport}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <Text style={[styles.selectedCount, { color: Colors[colorScheme].mutedText }]}>
                Selected: {sportsInterests.length}/3
              </Text>
            </View>

            {/* Profile Theme Color editor removed (July 6 notes) — existing
                saved theme_color values still render on the profile; users just
                no longer pick a color here. */}

            {/* Save Button */}
            <View style={styles.saveSection}>
              <Pressable
                onPress={onSave}
                disabled={saving}
                style={[
                  styles.saveButton,
                  {
                    backgroundColor: saving
                      ? Colors[colorScheme].mutedText
                      : Colors[colorScheme].tint,
                    opacity: saving ? 0.6 : 1,
                  },
                ]}
              >
                <Text style={[styles.saveButtonText, { color: '#FFFFFF' }]}>
                  {saving ? 'Saving...' : 'Save Changes'}
                </Text>
              </Pressable>
            </View>
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
    padding: 32,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 16,
  },
  scrollView: {
    flex: 1,
  },
  content: {
    padding: 16,
    paddingBottom: 32,
  },
  headerSection: {
    marginBottom: 24,
    alignItems: 'center',
  },
  pageTitle: {
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
  },
  pageSubtitle: {
    fontSize: 16,
    textAlign: 'center',
    lineHeight: 22,
  },
  errorContainer: {
    padding: 16,
    borderRadius: 8,
    marginBottom: 16,
  },
  error: {
    textAlign: 'center',
    fontWeight: '600',
  },
  section: {
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    borderWidth: 1,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 16,
    alignItems: 'center',
  },
  sectionNote: {
    fontSize: 14,
    marginBottom: 12,
    lineHeight: 20,
  },
  fieldGroup: {
    marginBottom: 16,
  },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  fieldRow: {
    flexDirection: 'row',
    gap: 12,
  },
  label: {
    fontSize: 16,
    fontWeight: '600',
  },
  charCount: {
    fontSize: 13,
    fontWeight: '500',
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
  },
  textArea: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    fontSize: 16,
    minHeight: 80,
    textAlignVertical: 'top',
  },
  fieldNote: {
    fontSize: 12,
    marginTop: 4,
    lineHeight: 16,
  },
  hint: {
    fontSize: 12,
    marginTop: 4,
    lineHeight: 16,
  },
  errorText: {
    fontSize: 12,
    marginTop: 6,
    lineHeight: 16,
    fontWeight: '500',
  },
  sportsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 12,
  },
  sportChip: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    borderRadius: 20,
    borderWidth: 1.5,
  },
  sportChipText: {
    fontSize: 14,
    fontWeight: '600',
  },
  selectedCount: {
    fontSize: 12,
    textAlign: 'center',
  },
  saveSection: {
    marginTop: 8,
    paddingTop: 16,
  },
  saveButton: {
    borderRadius: 8,
    paddingVertical: 16,
  },
  saveButtonText: {
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  dateText: {
    fontSize: 16,
    flex: 1,
  },
  dateIcon: {
    position: 'absolute',
    right: 12,
  },
  title: { fontSize: 24, fontWeight: '700', marginBottom: 8 },

  // Avatar styles
  avatarSection: {
    alignItems: 'center',
    paddingVertical: 8,
  },
  avatarContainer: {
    position: 'relative',
    marginBottom: 16,
  },
  avatar: {
    width: 100,
    height: 100,
    borderRadius: 50,
  },
  avatarPlaceholder: {
    width: 100,
    height: 100,
    borderRadius: 50,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#D1D5DB',
    borderStyle: 'dashed',
  },
  avatarLoader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    borderRadius: 50,
    justifyContent: 'center',
    alignItems: 'center',
  },
  changeAvatarButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    gap: 6,
  },
  changeAvatarText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  bannerSection: {
    marginTop: 20,
    gap: 12,
  },
  bannerLabel: {
    fontSize: 16,
    fontWeight: '700',
  },
  bannerPreview: {
    height: 150,
    borderRadius: 16,
    borderWidth: 1,
    overflow: 'hidden',
    position: 'relative',
    justifyContent: 'center',
    alignItems: 'center',
  },
  bannerImage: {
    width: '100%',
    height: '100%',
  },
  bannerImageWrapper: {
    width: '100%',
    height: '100%',
  },
  bannerPlaceholder: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 24,
    gap: 8,
  },
  bannerPlaceholderText: {
    textAlign: 'center',
    fontSize: 13,
    lineHeight: 18,
  },
  bannerOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  bannerActions: {
    flexDirection: 'row',
    gap: 12,
    flexWrap: 'wrap',
  },
  bannerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
  },
  bannerButtonText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
  },
  bannerRemoveButton: {
    borderWidth: 1,
    borderColor: '#DC2626',
    backgroundColor: 'rgba(220,38,38,0.08)',
  },
  bannerAdjustmentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    marginTop: 4,
  },
  bannerResetButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: 'rgba(59,130,246,0.08)',
  },

  helperText: {
    fontSize: 12,
    marginTop: 4,
    fontStyle: 'italic',
  },
});
