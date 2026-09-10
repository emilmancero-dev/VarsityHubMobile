import { useAuth } from '@/context/AuthProvider';
import { Colors } from '@/constants/Colors';
import { useColorScheme } from '@/hooks/useColorScheme';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { optimizeImageUrl } from '@/utils/imageUrl';
import { materializeICloudAssetIfNeeded } from '@/utils/materializeICloudAsset';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { safeGoBack } from '@/utils/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
// @ts-ignore
import { Organization } from '@/api/entities';
import { uploadFile } from '@/api/upload';
import { getApiBaseUrl } from '@/api/http';
import { sanitizeText } from '@/utils/formUtils';
import { toUserMessage } from '@/utils/toUserMessage';

const ORG_TYPES = [
  { label: 'School', value: 'school' },
  { label: 'Club', value: 'club' },
  { label: 'League', value: 'league' },
  { label: 'Other', value: 'other' },
];

// Auto-generated descriptions that should be treated as blank
const AUTO_DESC_PATTERN = /^(School|Organization)( in .+)?$/;

export default function EditOrganizationScreen() {
  const { user: _user } = useAuth();
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string; fallback?: string }>();
  const colorScheme = useColorScheme() ?? 'light';
  const theme = Colors[colorScheme];
  const fallbackRoute =
    typeof params.fallback === 'string' && params.fallback.trim().startsWith('/')
      ? params.fallback.trim()
      : params.id
        ? `/organization?id=${encodeURIComponent(params.id)}&tab=overview`
        : '/organization?tab=overview';

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [sport, setSport] = useState('');
  const [orgType, setOrgType] = useState('');
  const [location, setLocation] = useState('');
  const [zipCode, setZipCode] = useState('');
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [profilePictureUrl, setProfilePictureUrl] = useState<string | null>(null);
  const [backgroundUrl, setBackgroundUrl] = useState<string | null>(null);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [uploadingProfile, setUploadingProfile] = useState(false);
  const [uploadingBackground, setUploadingBackground] = useState(false);
  const [hasPermission, setHasPermission] = useState(false);
  // Transfer ownership state — owner-only, mirrors the team transfer flow.
  const [isOwner, setIsOwner] = useState(false);
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [members, setMembers] = useState<any[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [memberSearch, setMemberSearch] = useState('');
  const [transferring, setTransferring] = useState(false);

  const loadOrg = useCallback(async () => {
    if (!params.id) return;
    try {
      setLoading(true);
      const org: any = await Organization.get(params.id);

      // The detail payload now carries the canonical org access flags.
      if (!org?.can_edit && !org?.is_owner) {
        Alert.alert('Error', 'Only the organization owner can edit this organization.');
        safeGoBack(router, fallbackRoute);
        return;
      }
      setHasPermission(true);
      setIsOwner(org?.is_owner === true);

      setName(org.name || '');
      // Strip auto-generated descriptions — treat them as blank
      const desc = org.description || '';
      setDescription(AUTO_DESC_PATTERN.test(desc) ? '' : desc);
      setSport(org.sport || '');
      setOrgType(org.org_type || '');
      setLocation(org.location || '');
      setZipCode(org.zip_code || '');
      setLogoUrl(org.logo_url || null);
      setProfilePictureUrl(org.profile_picture_url || null);
      setBackgroundUrl(org.background_url || null);
    } catch {
      Alert.alert('Error', 'Failed to load organization.');
      safeGoBack(router, fallbackRoute);
    } finally {
      setLoading(false);
    }
  }, [fallbackRoute, params.id, router]);

  useEffect(() => {
    void loadOrg();
  }, [loadOrg]);

  const openTransferModal = useCallback(async () => {
    if (!params.id) return;
    setShowTransferModal(true);
    setLoadingMembers(true);
    try {
      const list = await Organization.members(params.id);
      setMembers(Array.isArray(list) ? list : []);
    } catch {
      setMembers([]);
      Alert.alert('Error', 'Failed to load organization members.');
    } finally {
      setLoadingMembers(false);
    }
  }, [params.id]);

  const handleTransferOwnership = useCallback(
    (newOwnerId: string, displayName: string) => {
      if (!params.id || transferring) return;
      Alert.alert(
        'Confirm Transfer',
        `Transfer ownership of this organization to ${displayName}?\n\nThis cannot be undone. You will become a manager.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Transfer',
            style: 'destructive',
            onPress: async () => {
              try {
                setTransferring(true);
                await Organization.transferOwnership(params.id as string, newOwnerId);
                setShowTransferModal(false);
                setMemberSearch('');
                Alert.alert(
                  'Ownership Transferred',
                  `${displayName} is now the organization owner.`,
                  [{ text: 'OK', onPress: () => safeGoBack(router, fallbackRoute) }]
                );
              } catch (e: any) {
                const msg = toUserMessage(e, 'Failed to transfer ownership');
                Alert.alert('Unable to transfer ownership', msg);
              } finally {
                setTransferring(false);
              }
            },
          },
        ]
      );
    },
    [fallbackRoute, params.id, router, transferring]
  );

  const pickImage = async (
    aspect: [number, number],
    fileName: string,
    setUrl: (url: string | null) => void,
    setUploading: (v: boolean) => void,
    label: string
  ) => {
    try {
      const r = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'] as any,
        allowsEditing: true,
        aspect,
        quality: 0.8,
      });
      if (!r.canceled && r.assets?.[0]) {
        setUploading(true);
        try {
          const localUri = await materializeICloudAssetIfNeeded(r.assets[0].uri);
          const res = await uploadFile(getApiBaseUrl(), localUri, fileName, 'image/jpeg');
          const url = res?.url || res?.path;
          if (url) setUrl(url);
        } catch (e: any) {
          Alert.alert('Upload Failed', toUserMessage(e, `Could not upload ${label}.`));
        } finally {
          setUploading(false);
        }
      }
    } catch {
      Alert.alert('Error', 'Failed to open image picker.');
    }
  };

  const pickLogo = () => pickImage([1, 1], 'org-logo.jpg', setLogoUrl, setUploadingLogo, 'logo');
  const pickProfile = () =>
    pickImage(
      [1, 1],
      'org-profile.jpg',
      setProfilePictureUrl,
      setUploadingProfile,
      'profile picture'
    );
  const pickBackground = () =>
    pickImage(
      // Crop at the ratio the org page actually renders (full width x 160px ≈ 2.4:1),
      // not 16:9 — otherwise the saved image gets cropped again at display time.
      [5, 2],
      'org-background.jpg',
      setBackgroundUrl,
      setUploadingBackground,
      'background'
    );

  const handleSave = async () => {
    if (!hasPermission) {
      Alert.alert('Error', 'Only the organization owner can edit this organization.');
      return;
    }
    if (!name.trim()) {
      Alert.alert('Required', 'Organization name is required.');
      return;
    }
    if (!params.id) return;
    setSaving(true);
    try {
      await Organization.update(params.id, {
        name: sanitizeText(name),
        description: sanitizeText(description) || null,
        logo_url: logoUrl || null,
        profile_picture_url: profilePictureUrl || null,
        background_url: backgroundUrl || null,
        sport: sanitizeText(sport) || null,
        // org_type is read-only — do not send
        location: sanitizeText(location) || null,
        zip_code: zipCode.trim() || null,
      });
      Alert.alert('Saved', 'Organization updated successfully.');
      safeGoBack(router, fallbackRoute);
    } catch (e: any) {
      const msg = toUserMessage(e, 'Failed to save changes.');
      Alert.alert('Error', msg);
    } finally {
      setSaving(false);
    }
  };

  if (loading || !hasPermission) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.center}>
          <ActivityIndicator size="large" color={theme.tint} />
        </View>
      </SafeAreaView>
    );
  }

  const renderImageUpload = (
    label: string,
    url: string | null,
    uploading: boolean,
    onPick: () => void,
    onRemove: () => void,
    style: any,
    iconSize: number,
    placeholderText: string
  ) => (
    <>
      <Text style={[styles.label, { color: theme.text }]}>{label}</Text>
      <Pressable
        style={[style, { borderColor: theme.border, backgroundColor: theme.card }]}
        onPress={onPick}
        disabled={uploading}
      >
        {uploading ? (
          <ActivityIndicator size="small" color={theme.tint} />
        ) : url ? (
          <Image
            source={{ uri: optimizeImageUrl(url, 600) }}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
          />
        ) : (
          <View style={styles.logoPlaceholder}>
            <Ionicons name="camera-outline" size={iconSize} color={theme.mutedText} />
            <Text style={[styles.logoPlaceholderText, { color: theme.mutedText }]}>
              {placeholderText}
            </Text>
          </View>
        )}
      </Pressable>
      {url && (
        <View style={styles.logoActions}>
          <Pressable
            onPress={onPick}
            style={[styles.logoActionBtn, { backgroundColor: theme.tint }]}
          >
            <Text style={{ color: '#fff', fontWeight: '600', fontSize: 14 }}>Change</Text>
          </Pressable>
          <Pressable
            onPress={onRemove}
            style={[styles.logoActionBtn, { backgroundColor: '#EF4444' }]}
          >
            <Text style={{ color: '#fff', fontWeight: '600', fontSize: 14 }}>Remove</Text>
          </Pressable>
        </View>
      )}
    </>
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]}>
      <Stack.Screen options={{ headerShown: false }} />

      {/* Header */}
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <Pressable onPress={() => safeGoBack(router, fallbackRoute)} hitSlop={12}>
          <Ionicons name="arrow-back" size={24} color={theme.text} />
        </Pressable>
        <Text style={[styles.headerTitle, { color: theme.text }]}>Edit Organization</Text>
        <Pressable onPress={handleSave} disabled={saving} hitSlop={12}>
          {saving ? (
            <ActivityIndicator size="small" color={theme.tint} />
          ) : (
            <Text style={[styles.saveBtn, { color: theme.tint }]}>Save</Text>
          )}
        </Pressable>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        automaticallyAdjustKeyboardInsets
      >
        {/* Preview public page — shows the org page exactly as a guest sees it */}
        {params.id ? (
          <Pressable
            onPress={() =>
              router.push({
                pathname: '/organization',
                params: { id: params.id as string, preview: '1' },
              })
            }
            style={[
              styles.previewButton,
              { borderColor: theme.border, backgroundColor: theme.card },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Preview how your page looks to the public"
          >
            <Ionicons name="eye-outline" size={18} color={theme.tint} />
            <Text style={[styles.previewButtonText, { color: theme.tint }]}>
              Preview public page
            </Text>
          </Pressable>
        ) : null}

        {/* Background Image */}
        {renderImageUpload(
          'Background Image',
          backgroundUrl,
          uploadingBackground,
          pickBackground,
          () => setBackgroundUrl(null),
          styles.backgroundSection,
          28,
          'Tap to add background'
        )}

        {/* Logo */}
        {renderImageUpload(
          'Organization Logo',
          logoUrl,
          uploadingLogo,
          pickLogo,
          () => setLogoUrl(null),
          styles.logoSection,
          32,
          'Tap to add logo'
        )}

        {/* Profile Picture */}
        {renderImageUpload(
          'Profile Picture',
          profilePictureUrl,
          uploadingProfile,
          pickProfile,
          () => setProfilePictureUrl(null),
          styles.logoSection,
          32,
          'Tap to add photo'
        )}

        {/* Name */}
        <Text style={[styles.label, { color: theme.text }]}>Organization Name *</Text>
        <TextInput
          style={[
            styles.input,
            { color: theme.text, backgroundColor: theme.card, borderColor: theme.border },
          ]}
          value={name}
          onChangeText={setName}
          placeholder="Organization name"
          placeholderTextColor={theme.mutedText}
          autoCapitalize="words"
        />

        {/* Description — leave blank if blank; no auto-generated text */}
        <Text style={[styles.label, { color: theme.text }]}>Description</Text>
        <TextInput
          style={[
            styles.input,
            styles.textArea,
            { color: theme.text, backgroundColor: theme.card, borderColor: theme.border },
          ]}
          value={description}
          onChangeText={setDescription}
          placeholder=""
          placeholderTextColor={theme.mutedText}
          multiline
          numberOfLines={4}
          textAlignVertical="top"
        />

        {/* Sport */}
        <Text style={[styles.label, { color: theme.text }]}>Sport</Text>
        <TextInput
          style={[
            styles.input,
            { color: theme.text, backgroundColor: theme.card, borderColor: theme.border },
          ]}
          value={sport}
          onChangeText={setSport}
          placeholder="e.g., Basketball, Football"
          placeholderTextColor={theme.mutedText}
        />

        {/* Org Type — read-only; cannot be changed after creation */}
        <Text style={[styles.label, { color: theme.text }]}>Type</Text>
        <View
          style={[styles.readOnlyField, { backgroundColor: theme.card, borderColor: theme.border }]}
        >
          <Text style={{ color: theme.mutedText, fontSize: 15 }}>
            {ORG_TYPES.find(t => t.value === orgType)?.label || 'Not set'}
          </Text>
          <Text style={{ color: theme.mutedText, fontSize: 11, marginTop: 2 }}>
            Cannot be changed after creation
          </Text>
        </View>

        {/* Location */}
        <Text style={[styles.label, { color: theme.text }]}>Location</Text>
        <TextInput
          style={[
            styles.input,
            { color: theme.text, backgroundColor: theme.card, borderColor: theme.border },
          ]}
          value={location}
          onChangeText={setLocation}
          placeholder="City, State"
          placeholderTextColor={theme.mutedText}
        />

        {/* ZIP Code */}
        <Text style={[styles.label, { color: theme.text }]}>ZIP Code</Text>
        <TextInput
          style={[
            styles.input,
            { color: theme.text, backgroundColor: theme.card, borderColor: theme.border },
          ]}
          value={zipCode}
          onChangeText={setZipCode}
          placeholder="12345"
          placeholderTextColor={theme.mutedText}
          keyboardType="number-pad"
          maxLength={10}
        />

        {/* Danger Zone — Transfer Ownership (owner only) */}
        {isOwner && (
          <View style={styles.dangerZone}>
            <Text style={[styles.label, { color: '#DC2626' }]}>Danger Zone</Text>
            <Pressable
              style={[styles.transferButton, { borderColor: '#DC2626' }]}
              onPress={openTransferModal}
            >
              <Ionicons name="swap-horizontal" size={20} color="#DC2626" />
              <Text style={styles.transferButtonText}>Transfer Ownership</Text>
            </Pressable>
            <Text style={{ color: theme.mutedText, fontSize: 12, marginTop: 6 }}>
              Transfer organization ownership to another member. You will become a manager.
            </Text>
          </View>
        )}
      </ScrollView>

      {/* Transfer Ownership Modal */}
      <Modal visible={showTransferModal} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalCard, { backgroundColor: theme.background }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: theme.text }]}>Transfer Ownership</Text>
              <Pressable
                onPress={() => {
                  setShowTransferModal(false);
                  setMemberSearch('');
                }}
                hitSlop={12}
              >
                <Ionicons name="close" size={22} color={theme.text} />
              </Pressable>
            </View>
            <Text style={{ color: theme.mutedText, fontSize: 13, marginBottom: 12 }}>
              Select a member to become the new owner. You will be demoted to manager.
            </Text>
            <TextInput
              style={[
                styles.input,
                { color: theme.text, backgroundColor: theme.card, borderColor: theme.border },
              ]}
              value={memberSearch}
              onChangeText={setMemberSearch}
              placeholder="Search members"
              placeholderTextColor={theme.mutedText}
            />
            {loadingMembers ? (
              <ActivityIndicator style={{ marginVertical: 24 }} color={theme.tint} />
            ) : (
              <FlatList
                style={{ marginTop: 12, maxHeight: 320 }}
                data={members.filter((m: any) => {
                  // Exclude the current owner and any existing owners.
                  if (String(m?.role || '').toLowerCase() === 'owner') return false;
                  const q = memberSearch.trim().toLowerCase();
                  if (!q) return true;
                  const name = String(
                    m?.user?.display_name || m?.user?.username || ''
                  ).toLowerCase();
                  return name.includes(q);
                })}
                keyExtractor={(m: any) => String(m?.id || m?.user?.id)}
                ListEmptyComponent={
                  <Text style={{ color: theme.mutedText, textAlign: 'center', marginVertical: 16 }}>
                    No eligible members found.
                  </Text>
                }
                renderItem={({ item }: { item: any }) => {
                  const uid = item?.user?.id || item?.user_id;
                  const displayName = item?.user?.username || 'Member';
                  return (
                    <Pressable
                      style={[styles.memberRow, { borderColor: theme.border }]}
                      disabled={transferring || !uid}
                      onPress={() => handleTransferOwnership(String(uid), displayName)}
                    >
                      <Text style={{ color: theme.text, fontSize: 15 }}>{displayName}</Text>
                      <Ionicons name="chevron-forward" size={18} color={theme.mutedText} />
                    </Pressable>
                  );
                }}
              />
            )}
            {transferring && (
              <View style={styles.transferringOverlay}>
                <ActivityIndicator size="large" color={theme.tint} />
                <Text style={{ color: theme.text, marginTop: 8 }}>Transferring...</Text>
              </View>
            )}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  previewButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 16,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  previewButtonText: { fontSize: 15, fontWeight: '600' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  dangerZone: { marginTop: 28 },
  transferButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 12,
    marginTop: 8,
  },
  transferButtonText: { color: '#DC2626', fontSize: 15, fontWeight: '700' },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    paddingBottom: 32,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  modalTitle: { fontSize: 18, fontWeight: '700' },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
    marginBottom: 8,
  },
  transferringOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  headerTitle: { fontSize: 17, fontWeight: '700' },
  saveBtn: { fontSize: 16, fontWeight: '700' },
  scroll: { flex: 1 },
  scrollContent: { padding: 16, paddingBottom: 40 },
  label: { fontSize: 14, fontWeight: '600', marginTop: 16, marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
  },
  textArea: { minHeight: 100 },
  readOnlyField: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    opacity: 0.7,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
  },
  logoSection: {
    width: 100,
    height: 100,
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  backgroundSection: {
    width: '100%',
    height: 140,
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoPlaceholder: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  logoPlaceholderText: {
    fontSize: 12,
    fontWeight: '500',
  },
  logoActions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
  },
  logoActionBtn: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 8,
  },
});
