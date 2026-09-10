import { toUserMessage } from '@/utils/toUserMessage';
import DateField from '@/components/ui/DateField';
import { Input } from '@/components/ui/input';
import PrimaryButton from '@/components/ui/PrimaryButton';
import { Type } from '@/ui/tokens';
import { Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Animated, Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
// @ts-ignore JS exports
import { User } from '@/api/entities';
import { uploadFile } from '@/api/upload';
import { ZipCodeMapPreview } from '@/components/ZipCodeMapPreview';
import { getConfig } from '@/config/env';
import { Colors } from '@/constants/Colors';
import { useAuth } from '@/context/AuthProvider';
import { useOnboarding, type Affiliation } from '@/context/OnboardingContext';
import { useColorScheme } from '@/hooks/useColorScheme';
import { BIO_MAX_LENGTH, USERNAME_REGEX } from '@/utils/formUtils';
import { materializeICloudAssetIfNeeded } from '@/utils/materializeICloudAsset';
import { safeGoBack } from '@/utils/navigation';
import { captureBreadcrumb, captureException } from '@/utils/sentry';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import OnboardingLayout from './components/OnboardingLayout';

const SPORT_BALLS = ['⚽', '🎾', '🏈', '🏀'];
const DEFAULT_HEADER_IMAGE_FOCUS_Y = 0;

function SportBallRow() {
  const [active, setActive] = useState(0);
  const scales = useRef(SPORT_BALLS.map(() => new Animated.Value(0.7))).current;
  const opacities = useRef(SPORT_BALLS.map(() => new Animated.Value(0.35))).current;

  useEffect(() => {
    // Animate the first emoji immediately on mount
    Animated.parallel([
      Animated.spring(scales[0], { toValue: 1.2, useNativeDriver: true, friction: 5 }),
      Animated.timing(opacities[0], { toValue: 1, duration: 300, useNativeDriver: true }),
    ]).start();

    const interval = setInterval(() => {
      setActive(prev => (prev + 1) % SPORT_BALLS.length);
    }, 800);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- opacities and scales are Animated.Values (ref-like), initial mount only
  }, []);

  useEffect(() => {
    SPORT_BALLS.forEach((_, i) => {
      Animated.parallel([
        Animated.spring(scales[i], {
          toValue: i === active ? 1.2 : 0.7,
          useNativeDriver: true,
          friction: 5,
        }),
        Animated.timing(opacities[i], {
          toValue: i === active ? 1 : 0.35,
          duration: 300,
          useNativeDriver: true,
        }),
      ]).start();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- opacities and scales are Animated.Values (ref-like), only active index should trigger
  }, [active]);

  return (
    <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 12, marginBottom: 8 }}>
      {SPORT_BALLS.map((emoji, i) => (
        <Animated.Text
          key={emoji}
          style={{
            fontSize: 28,
            opacity: opacities[i],
            transform: [{ scale: scales[i] }],
          }}
        >
          {emoji}
        </Animated.Text>
      ))}
    </View>
  );
}

export default function Step2Basic() {
  const router = useRouter();
  const colorScheme = useColorScheme() ?? 'light';
  const { user, markOnboardingCompleteLocally, registerPushToken } = useAuth();
  const { state: ob, setState: setOB, setProgress, dispatch, canNavigate } = useOnboarding();
  const [username, setUsername] = useState('');
  const [affiliation, setAffiliation] = useState<Affiliation>('other');
  const [dob, setDob] = useState('');
  const [zip, setZip] = useState('');
  const [checking, setChecking] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [availabilityError, setAvailabilityError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [emailVerified, setEmailVerified] = useState<boolean | null>(null);
  const [avatarUri, setAvatarUri] = useState<string | null>(null);
  const [headerImageUri, setHeaderImageUri] = useState<string | null>(null);
  const [bio, setBio] = useState('');
  void registerPushToken;

  const styles = useMemo(() => createStyles(colorScheme), [colorScheme]);

  // Prerequisite guard: step-1 must be completed (role selected) before step-2
  useEffect(() => {
    if (!ob.role) {
      if (__DEV__) console.warn('[step-2-basic] No role set — redirecting to step-1');
      router.replace('/onboarding/step-1-role');
    }
  }, [ob.role, router]);

  // Track the user's server-side username so availability checks can exclude it.
  // Keyed on the actual server value (not the edited input) to avoid mid-edit mismatches.
  const serverUsernameRef = useRef<string>('');
  const initialLoadDone = useRef(false);

  useEffect(() => {
    setEmailVerified(user?.email_verified ?? null);
  }, [user?.email_verified]);

  useEffect(() => {
    if (initialLoadDone.current) return;

    const userPrefs = ((user as any)?.preferences || {}) as Record<string, unknown>;
    const draftUsername =
      typeof ob.username === 'string' ? ob.username.trim().toLowerCase().replace(/\s+/g, '_') : '';
    const existingUsername = typeof user?.username === 'string' ? user.username : '';
    const normalized = draftUsername || existingUsername.toLowerCase();
    const draftZip =
      typeof ob.zip === 'string' && ob.zip.trim().length > 0
        ? ob.zip
        : typeof ob.zip_code === 'string' && ob.zip_code.trim().length > 0
          ? ob.zip_code
          : '';
    const storedZip =
      draftZip ||
      (typeof user?.zip_code === 'string' ? user.zip_code : '') ||
      (typeof userPrefs.zip_code === 'string' ? userPrefs.zip_code : '') ||
      (typeof userPrefs.zip === 'string' ? userPrefs.zip : '');
    const storedDob =
      (typeof ob.dob === 'string' && ob.dob) ||
      (typeof userPrefs.dob === 'string' && userPrefs.dob) ||
      (typeof (user as any)?.date_of_birth === 'string' &&
        String((user as any).date_of_birth).slice(0, 10)) ||
      '';
    const draftBio = typeof ob.bio === 'string' ? ob.bio : '';
    const hasBootstrapData =
      !!user || !!normalized || !!storedZip || !!storedDob || !!draftBio || !!ob.affiliation;

    if (!hasBootstrapData) return;

    initialLoadDone.current = true;
    serverUsernameRef.current = existingUsername.toLowerCase();
    if (normalized) setUsername(normalized);
    if (storedZip) setZip(storedZip);
    if (storedDob) setDob(storedDob);
    if (draftBio) setBio(draftBio);
    if (ob.affiliation) setAffiliation(ob.affiliation);

    if (normalized && existingUsername && normalized === existingUsername.toLowerCase()) {
      setAvailable(true);
      return;
    }

    if (normalized && USERNAME_REGEX.test(normalized)) {
      void (async () => {
        try {
          const r: any = await User.usernameAvailable(normalized);
          setAvailable(!!r?.available);
        } catch (error) {
          if (__DEV__) console.warn('[step-2-basic] Username availability check failed:', error);
          setAvailable(null);
        }
      })();
    }
  }, [ob.affiliation, ob.bio, ob.dob, ob.username, ob.zip, ob.zip_code, user]);
  useEffect(() => {
    if (ob.affiliation) setAffiliation(ob.affiliation);
    if (ob.dob) setDob(ob.dob || '');
  }, [ob.affiliation, ob.dob]);

  useEffect(() => {
    // Normalize live input (replace spaces with underscores, convert to lowercase)
    // This ensures validation matches backend requirements.
    // Spaces are normalized to underscores BEFORE validation.
    const normalized = username.trim().toLowerCase().replace(/\s+/g, '_');
    if (normalized !== username) {
      setUsername(normalized);
      return; // will re-run effect with normalized value
    }
    // Don't check if username is empty or invalid format
    if (!username || !USERNAME_REGEX.test(username)) {
      setAvailable(null);
      setAvailabilityError(false);
      setChecking(false);
      return;
    }

    // If the username matches the user's own server-side username, it's available by definition.
    // Compare against the immutable server value, not the live input, to avoid mid-edit races.
    if (serverUsernameRef.current && username === serverUsernameRef.current) {
      setAvailable(true);
      setChecking(false);
      return;
    }

    // Debounce username checks
    const timeoutId = setTimeout(async () => {
      setChecking(true);
      setAvailabilityError(false);
      try {
        const r: any = await User.usernameAvailable(username);
        setAvailable(!!r?.available);
      } catch (error) {
        if (__DEV__) console.warn('[step-2-basic] Username availability check failed:', error);
        setAvailable(null);
        setAvailabilityError(true);
      } finally {
        setChecking(false);
      }
    }, 500); // 500ms debounce

    return () => clearTimeout(timeoutId);
  }, [username]);

  const pickAvatar = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
      });
      if (!result.canceled && result.assets[0]) {
        const materialized = await materializeICloudAssetIfNeeded(result.assets[0].uri);
        setAvatarUri(materialized);
        captureBreadcrumb('Onboarding avatar selected', 'onboarding.step2', {
          role: ob.role || 'unknown',
        });
      }
    } catch (err) {
      if (__DEV__) console.warn('[step-2] Avatar pick failed:', err);
      captureBreadcrumb(
        'Onboarding avatar selection failed',
        'onboarding.step2',
        { role: ob.role || 'unknown' },
        'warning'
      );
    }
  };

  const pickHeaderImage = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [3, 2],
        quality: 0.85,
      });
      if (!result.canceled && result.assets[0]) {
        // iOS returns ph:// URIs for iCloud-only photos; force the bytes local
        // before we hand the URI to the upload pipeline. Matches BannerUpload.tsx:131.
        const materialized = await materializeICloudAssetIfNeeded(result.assets[0].uri);
        setHeaderImageUri(materialized);
        captureBreadcrumb('Onboarding cover image selected', 'onboarding.step2', {
          role: ob.role || 'unknown',
        });
      }
    } catch (err) {
      if (__DEV__) console.warn('[step-2] Cover image pick failed:', err);
      captureBreadcrumb(
        'Onboarding cover image selection failed',
        'onboarding.step2',
        { role: ob.role || 'unknown' },
        'warning'
      );
    }
  };

  const persistOptionalProfileMedia = useCallback(
    async (roleLabel: string) => {
      if (!avatarUri && !headerImageUri && !bio.trim()) return;

      try {
        let avatarUrl: string | undefined;
        let headerImageUrl: string | undefined;

        if (avatarUri) {
          captureBreadcrumb('Onboarding background avatar upload started', 'onboarding.step2', {
            role: roleLabel,
          });
          const uploaded = await uploadFile(
            getConfig().apiUrl,
            avatarUri,
            'avatar.jpg',
            'image/jpeg',
            {
              formFields: {
                onboarding: true,
                upload_context: 'onboarding_avatar',
              },
            }
          );
          avatarUrl = uploaded?.url || uploaded?.secure_url;
        }

        if (headerImageUri) {
          captureBreadcrumb('Onboarding background cover upload started', 'onboarding.step2', {
            role: roleLabel,
          });
          const uploaded = await uploadFile(
            getConfig().apiUrl,
            headerImageUri,
            'profile-cover.jpg',
            'image/jpeg',
            {
              formFields: {
                onboarding: true,
                upload_context: 'onboarding_header_image',
              },
            }
          );
          headerImageUrl = uploaded?.url || uploaded?.secure_url;
        }

        if (bio.trim() || avatarUrl) {
          await User.patchMe({
            ...(bio.trim() ? { bio: bio.trim() } : {}),
            ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
          });
        }

        if (headerImageUrl) {
          await User.updatePreferences({
            header_image_url: headerImageUrl,
            header_image_focus_y: DEFAULT_HEADER_IMAGE_FOCUS_Y,
          });
        }
      } catch (err) {
        if (__DEV__) console.warn('[step-2] Background profile media save failed:', err);
        captureBreadcrumb(
          'Onboarding background profile media save failed',
          'onboarding.step2',
          { role: roleLabel },
          'warning'
        );
      }
    },
    [avatarUri, bio, headerImageUri]
  );

  // Parse YYYY-MM-DD as local midnight to avoid UTC off-by-one
  const parseDobLocal = (s: string): Date => {
    const [y, mo, day] = s.split('-').map(Number);
    return new Date(y, mo - 1, day);
  };
  const dobError =
    dob && (parseDobLocal(dob).getFullYear() < 1920 || parseDobLocal(dob) > new Date());
  const isUnder13 =
    dob &&
    (() => {
      const d = parseDobLocal(dob);
      if (isNaN(d.getTime())) return false;
      const now = new Date();
      let age = now.getFullYear() - d.getFullYear();
      const m = now.getMonth() - d.getMonth();
      if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
      return age < 13;
    })();
  const isUnder18 =
    dob &&
    (() => {
      const d = parseDobLocal(dob);
      if (isNaN(d.getTime())) return false;
      const now = new Date();
      let age = now.getFullYear() - d.getFullYear();
      const m = now.getMonth() - d.getMonth();
      if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
      return age < 18;
    })();
  const usernameError =
    username.length > 0 &&
    (!USERNAME_REGEX.test(username) || username.length < 3 || username.length > 20);

  // Validation rules:
  // - Username: required, valid format, available
  // - DOB: required, valid date
  // - Affiliation: required ONLY for coaches (optional for fans)
  // - Zip code: required for coaches, optional for fans
  // - Coaches must be 18+
  const canContinue =
    USERNAME_REGEX.test(username) &&
    username.length >= 3 &&
    username.length <= 20 &&
    available === true &&
    dob &&
    !dobError &&
    !isUnder13 &&
    !(ob.role === 'coach' && isUnder18) &&
    (ob.role === 'fan' || (affiliation && zip.trim().length >= 5)); // Coaches need affiliation + zip

  const onBack = () => {
    // Prefer natural stack back when step-1 pushed us here, but still fall back
    // to the explicit previous step if the screen was opened directly.
    setProgress(0);
    safeGoBack(router, '/onboarding/step-1-role');
  };

  const onContinue = async () => {
    if (!canContinue) return;

    // COPPA: Block under-13 users - do not store any data
    if (isUnder13) {
      Alert.alert(
        'Age Requirement',
        'VarsityHub is not available for users under 13. Please have a parent or guardian contact support@varsityhub.app.',
        [{ text: 'Go Back', onPress: () => safeGoBack(router) }, { text: 'OK' }]
      );
      return;
    }

    // Prevent race conditions
    if (!canNavigate || saving) {
      if (__DEV__) console.warn('[STEP-2] Navigation blocked - saving or already navigating');
      return;
    }

    // Final normalization pass
    const finalUsername = username.trim().toLowerCase().replace(/\s+/g, '_');
    setSaving(true);
    dispatch({ type: 'SAVE_START' });
    captureBreadcrumb('Onboarding step 2 submit started', 'onboarding.step2', {
      role: ob.role || 'unknown',
      affiliation,
      has_avatar: !!avatarUri,
      has_cover: !!headerImageUri,
      has_bio: !!bio.trim(),
    });

    try {
      const updatedData = {
        username: finalUsername,
        affiliation,
        dob,
        zip: zip || undefined,
        zip_code: zip || null,
        step_2_visited: true,
      };

      setOB(prev => ({
        ...prev,
        ...updatedData,
      }));

      // Save username (not display_name) - this is the single identifier
      try {
        await User.patchMe({ username: finalUsername });
      } catch (patchErr: any) {
        // Detect username conflict specifically
        const msg = patchErr?.message || patchErr?.data?.error || '';
        if (
          msg.toLowerCase().includes('username') ||
          msg.toLowerCase().includes('unique') ||
          msg.toLowerCase().includes('taken')
        ) {
          setAvailable(false);
          throw new Error('That username was just taken. Please choose a different one.');
        }
        throw patchErr;
      }

      // Save preferences separately so we get a clear error if this specific call fails
      try {
        const prefsPayload: Record<string, any> = {
          affiliation,
          dob,
          ...(ob.role === 'coach' ? { role: 'coach' } : {}),
        };
        if (zip) prefsPayload.zip_code = zip;
        await User.updatePreferences(prefsPayload);
      } catch (prefsErr: any) {
        if (__DEV__)
          console.error(
            '[step-2-basic] Preferences save failed:',
            JSON.stringify(prefsErr?.data || prefsErr?.message)
          );
        throw prefsErr;
      }

      const currentRole = ob.role;
      const updatedDataWithRole = { ...updatedData, role: currentRole };

      if (currentRole === 'coach') {
        // Coaches go to the coach-application step after basic info.
        captureBreadcrumb('Onboarding step 2 completed', 'onboarding.step2', {
          role: 'coach',
          next: 'coach-application',
        });
        dispatch({ type: 'SAVE_SUCCESS', data: updatedDataWithRole });
        setProgress(2);
        router.push('/onboarding/coach-application' as any);
        void persistOptionalProfileMedia('coach');
      } else {
        // Fans are DONE — complete onboarding first (fast), then upload profile media in background
        await User.completeOnboarding({
          role: 'fan',
          username: finalUsername,
          dob,
          zip_code: zip || undefined,
          affiliation,
        });

        // Route fans through the permissions screen before entering the app.
        // Permissions (notifications + location) and push token registration
        // are handled there so iOS dialogs appear in-context, not mid-feed.
        captureBreadcrumb('Onboarding step 2 completed', 'onboarding.step2', {
          role: 'fan',
          next: 'fan-permissions',
        });
        dispatch({ type: 'SAVE_SUCCESS', data: updatedDataWithRole });
        router.push('/onboarding/fan-permissions' as any);

        void persistOptionalProfileMedia('fan');
        markOnboardingCompleteLocally().catch(() => {});
      }
    } catch (e: any) {
      if (__DEV__) console.error('[step-2-basic] Failed to save:', e, 'data:', e?.data);
      captureBreadcrumb(
        'Onboarding step 2 submit failed',
        'onboarding.step2',
        { role: ob.role || 'unknown' },
        'warning'
      );
      captureException(typeof e === 'string' ? new Error(e) : e, {
        tags: { context: 'onboarding-step-2' },
      });
      dispatch({ type: 'SAVE_FAIL', error: e });
      const errorMessage = toUserMessage(
        e,
        'Unable to save your information. Check your entries and try again.'
      );
      Alert.alert('Failed to save', errorMessage, [{ text: 'OK', style: 'default' }]);
    } finally {
      setSaving(false);
    }
  };

  return (
    <OnboardingLayout
      step={2}
      title="Basic Information"
      subtitle="We'll set up your account with a username and preferences"
      aboveTitle={<SportBallRow />}
      onBack={onBack}
      emailVerified={emailVerified === null ? undefined : emailVerified}
      onVerifyEmail={() => void router.push('/verify')}
    >
      <Stack.Screen options={{ headerShown: false }} />

      {/* Profile Picture (optional) */}
      <Pressable
        testID="onboarding-step2-avatar-picker"
        onPress={pickAvatar}
        style={{ alignSelf: 'center', marginBottom: 16 }}
        accessibilityLabel="Choose profile picture"
        accessibilityRole="button"
      >
        <View
          style={{
            width: 90,
            height: 90,
            borderRadius: 45,
            backgroundColor: Colors[colorScheme].surface,
            borderWidth: 2,
            borderColor: Colors[colorScheme].border,
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
          }}
        >
          {avatarUri ? (
            <Image source={{ uri: avatarUri }} style={{ width: 90, height: 90 }} />
          ) : (
            <Ionicons name="camera-outline" size={32} color={Colors[colorScheme].mutedText} />
          )}
        </View>
        <Text style={[styles.muted, { textAlign: 'center', marginTop: 4 }]}>Add photo</Text>
      </Pressable>

      <Pressable
        testID="onboarding-step2-header-picker"
        onPress={pickHeaderImage}
        style={{ marginBottom: 18 }}
        accessibilityLabel="Choose cover photo"
        accessibilityRole="button"
      >
        <View
          style={{
            height: 112,
            borderRadius: 16,
            borderWidth: 1,
            borderColor: Colors[colorScheme].border,
            backgroundColor: Colors[colorScheme].surface,
            overflow: 'hidden',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {headerImageUri ? (
            <Image source={{ uri: headerImageUri }} style={{ width: '100%', height: '100%' }} />
          ) : (
            <View style={{ alignItems: 'center', gap: 6 }}>
              <Ionicons name="image-outline" size={28} color={Colors[colorScheme].mutedText} />
              <Text style={styles.muted}>Add cover photo</Text>
            </View>
          )}
        </View>
        <Text style={[styles.muted, { marginTop: 6 }]}>Optional profile header image</Text>
      </Pressable>

      <Text style={styles.label}>Username</Text>
      <Input
        testID="onboarding-step2-username-input"
        value={username}
        onChangeText={setUsername}
        autoCapitalize="none"
        placeholder="username"
        style={{ marginBottom: 4, letterSpacing: 0 }}
        onEndEditing={async () => {
          if (!USERNAME_REGEX.test(username)) {
            setAvailable(null);
            return;
          }
          setAvailabilityError(false);
          try {
            const r: any = await User.usernameAvailable(username);
            setAvailable(!!r?.available);
          } catch (error) {
            if (__DEV__) console.warn('[onboarding] Username availability check failed:', error);
            setAvailable(null);
            setAvailabilityError(true);
          }
        }}
      />
      {usernameError ? (
        <Text style={styles.error}>
          Use 3-20 lowercase letters, numbers, underscores, or periods.
        </Text>
      ) : checking ? (
        <Text style={styles.muted}>Checking availability…</Text>
      ) : availabilityError ? (
        <Pressable
          testID="onboarding-step2-retry-username-check"
          onPress={async () => {
            setAvailabilityError(false);
            setChecking(true);
            try {
              const r: any = await User.usernameAvailable(username);
              setAvailable(!!r?.available);
            } catch {
              setAvailable(null);
              setAvailabilityError(true);
            } finally {
              setChecking(false);
            }
          }}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
          accessibilityRole="button"
          accessibilityLabel="Retry checking username availability"
        >
          <Text style={styles.error}>Couldn't check availability — tap to retry</Text>
        </Pressable>
      ) : available === false ? (
        <Text style={styles.error}>That username is taken</Text>
      ) : available === true && username.length > 0 ? (
        <Text style={styles.success}>Available!</Text>
      ) : null}

      {/* Organization Type - Only shown for coaches/organizers */}
      {ob.role === 'coach' && (
        <>
          <Text style={styles.label}>Organization Type</Text>
          <Text style={[styles.hint, { color: Colors[colorScheme].mutedText }]}>
            Select the type of organization you're affiliated with
            {ob.role !== 'coach' ? ' (optional)' : ''}
          </Text>
          <View style={styles.affiliationGrid}>
            {[
              { value: 'other', label: 'Other', icon: '📋' },
              { value: 'professional', label: 'Professional', icon: '🏟️' },
              { value: 'university', label: 'University', icon: '🎓' },
              { value: 'high_school', label: 'High School', icon: '🏫' },
              { value: 'club', label: 'Club', icon: '⚽' },
              { value: 'youth', label: 'Youth Org', icon: '🏀' },
            ].map(option => (
              <Pressable
                testID={`onboarding-step2-affiliation-${option.value}`}
                key={option.value}
                style={[
                  styles.affiliationButton,
                  affiliation === option.value && styles.affiliationButtonSelected,
                ]}
                onPress={() => setAffiliation(option.value as Affiliation)}
                accessibilityLabel={`${option.label} affiliation`}
                accessibilityRole="button"
                accessibilityHint="Double tap to select"
              >
                <Text style={styles.affiliationIcon}>{option.icon}</Text>
                <Text
                  style={[
                    styles.affiliationLabel,
                    affiliation === option.value && styles.affiliationLabelSelected,
                  ]}
                >
                  {option.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      )}

      <DateField
        label={ob.role === 'coach' ? 'Date of birth (Authorized User)' : 'Date of birth'}
        value={dob}
        onChange={setDob}
      />
      {dobError && <Text style={styles.error}>Please enter a valid date of birth</Text>}
      {isUnder13 && !dobError && (
        <Text style={styles.error}>
          VarsityHub is not available for users under 13. Please have a parent or guardian contact
          support@varsityhub.app.
        </Text>
      )}
      {!isUnder13 && isUnder18 && !dobError && ob.role === 'coach' && (
        <Text style={styles.error}>
          Coach and organizer accounts require users to be at least 18 years old.
        </Text>
      )}

      <Text style={styles.label}>
        Zip / Postal code {ob.role !== 'coach' && <Text style={styles.muted}>(optional)</Text>}
      </Text>
      <Input
        testID="onboarding-step2-zip-input"
        value={zip}
        onChangeText={setZip}
        autoCapitalize="characters"
        placeholder="e.g. 12345 or M5V 3L9"
        keyboardType="default"
        maxLength={10}
      />
      <ZipCodeMapPreview
        zipCode={zip}
        title="Your Area"
        subtitle="We'll use this to show you local content near ZIP {zip}"
        showCircle={false}
      />

      <Text style={styles.label}>
        Bio <Text style={styles.muted}>(optional)</Text>
      </Text>
      <TextInput
        testID="onboarding-step2-bio-input"
        value={bio}
        onChangeText={t => setBio(t.slice(0, BIO_MAX_LENGTH))}
        placeholder="Fan trying to show the most school spirit"
        placeholderTextColor={Colors[colorScheme].mutedText}
        multiline
        maxLength={BIO_MAX_LENGTH}
        style={{
          minHeight: 60,
          borderWidth: 1,
          borderColor: Colors[colorScheme].border,
          borderRadius: 10,
          padding: 12,
          color: Colors[colorScheme].text,
          backgroundColor: Colors[colorScheme].surface,
          fontSize: 15,
          textAlignVertical: 'top',
        }}
        accessibilityLabel="Bio"
      />
      <Text style={[styles.muted, { textAlign: 'right', fontSize: 12 }]}>{bio.length}/160</Text>

      <View style={{ marginTop: 20 }}>
        <PrimaryButton
          testID="onboarding-step2-continue-button"
          label="Continue"
          onPress={onContinue}
          disabled={!canContinue}
          loading={saving}
        />
      </View>
    </OnboardingLayout>
  );
}

const createStyles = (colorScheme: 'light' | 'dark') =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: Colors[colorScheme].background,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: Colors[colorScheme].border,
    },
    backButton: {
      width: 40,
      height: 40,
      justifyContent: 'center',
      alignItems: 'center',
    },
    headerTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: Colors[colorScheme].text,
    },
    title: {
      ...Type.h2,
      color: Colors[colorScheme].text,
      marginBottom: 8,
    },
    subtitle: {
      ...Type.body,
      color: Colors[colorScheme].mutedText,
      marginBottom: 12,
    },
    label: {
      fontSize: 16,
      fontWeight: '600',
      color: Colors[colorScheme].text,
      marginTop: 12,
      marginBottom: 6,
    },
    error: {
      fontSize: 14,
      color: colorScheme === 'dark' ? '#f87171' : '#ef4444',
      marginTop: 4,
    },
    success: {
      fontSize: 14,
      color: colorScheme === 'dark' ? '#4ade80' : '#22c55e',
      marginTop: 4,
    },
    muted: {
      fontSize: 14,
      color: Colors[colorScheme].mutedText,
      marginTop: 4,
    },
    hint: {
      fontSize: 13,
      lineHeight: 18,
      marginBottom: 8,
    },
    affiliationGrid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'space-between',
      gap: 6,
      marginBottom: 12,
    },
    affiliationButton: {
      width: '31%',
      paddingVertical: 10,
      paddingHorizontal: 8,
      borderRadius: 12,
      borderWidth: 2,
      borderColor: Colors[colorScheme].border,
      backgroundColor: Colors[colorScheme].surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    affiliationButtonSelected: {
      borderColor: Colors[colorScheme].tint,
      backgroundColor: colorScheme === 'dark' ? 'rgba(56,189,248,0.1)' : '#EFF6FF',
      borderWidth: 2,
    },
    affiliationIcon: {
      fontSize: 20,
      marginBottom: 2,
    },
    affiliationLabel: {
      fontSize: 12,
      fontWeight: '600',
      color: Colors[colorScheme].mutedText,
      textAlign: 'center',
    },
    affiliationLabelSelected: {
      color: Colors[colorScheme].tint,
      fontWeight: '700',
    },
  });
