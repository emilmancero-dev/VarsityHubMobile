import { toUserMessage } from '@/utils/toUserMessage';
import {
  EditScreenHeader,
  EditScreenLoading,
  EditScreenSubmitButton,
  EditTextField,
  editScreenSharedStyles as sharedStyles,
} from '@/components/EditScreenShared';
import { Colors } from '@/constants/Colors';
import { useColorScheme } from '@/hooks/useColorScheme';
import { optimizeImageUrl } from '@/utils/imageUrl';
import { materializeICloudAssetIfNeeded } from '@/utils/materializeICloudAsset';
import { safeGoBack } from '@/utils/navigation';
import { pickerMediaTypesProp } from '@/utils/picker';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import * as ImagePicker from 'expo-image-picker';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
// @ts-ignore
import { Organization, Team } from '@/api/entities';
import { getApiBaseUrl } from '@/api/http';
import { uploadFile } from '@/api/upload';
import { useAuth } from '@/context/AuthProvider';

function EditTeamScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const colorScheme = useColorScheme() ?? 'light';
  const insets = useSafeAreaInsets();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [sport, setSport] = useState('');
  const [season, setSeason] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [logoUri, setLogoUri] = useState<string | null>(null);
  const [existingLogoUrl, setExistingLogoUrl] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [team, setTeam] = useState<any>(null);
  const [isPrivate, setIsPrivate] = useState(false);
  const { user: currentUser } = useAuth();

  // Transfer ownership state
  const [, setIsOwner] = useState(false);
  const [showTransferModal, setShowTransferModal] = useState(false);
  const [members, setMembers] = useState<any[]>([]);
  const [memberSearch, setMemberSearch] = useState('');
  const [transferring, setTransferring] = useState(false);
  // Editing the team is FULL administration (canAdministerTeam: owner/head
  // coach/org owner) — NOT the staff tier. Managers/assistant_coaches can view
  // team tools but must not edit settings or archive; the load path below bounces
  // them (the server 403s them anyway), so the form never renders for them.
  // Archive uses the same boundary as canArchiveTeam (== canAdministerTeam).
  const [canArchive, setCanArchive] = useState(false);
  // Transfer: team owner/head coach or org owner.
  const [canTransfer, setCanTransfer] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const fallbackRoute = team?.organization_id
    ? `/organization?id=${encodeURIComponent(team.organization_id)}&tab=teams`
    : '/organization?tab=teams';

  const sports = [
    'Basketball',
    'Football',
    'Soccer',
    'Baseball',
    'Tennis',
    'Volleyball',
    'Swimming',
    'Track & Field',
    'Other',
  ];
  const seasons = (() => {
    const y = new Date().getFullYear();
    return [
      `Spring ${y}`,
      `Summer ${y}`,
      `Fall ${y}`,
      `Winter ${y}/${(y + 1) % 100}`,
      `Spring ${y + 1}`,
      `Summer ${y + 1}`,
      `Fall ${y + 1}`,
      `Winter ${y + 1}/${(y + 2) % 100}`,
    ];
  })();

  const loadTeam = useCallback(async () => {
    try {
      setLoading(true);
      if (!params.id) return;
      const summary: any = await Team.adminSummary(params.id);
      const teamData = summary?.team ?? (await Team.get(params.id));
      setTeam(teamData);
      setName(teamData.name || '');
      setDescription(teamData.description || '');
      setSport(teamData.sport || '');
      setSeason(teamData.season || '');
      setExistingLogoUrl(teamData.logo_url || teamData.avatar_url || null);
      setIsPrivate(!!teamData.is_private);

      // Editing requires the FULL-administration tier, not staff. The server is
      // authoritative via permissions.can_administer / team.can_administer_team.
      const perms = summary?.permissions ?? {};
      const administer = perms.can_administer === true || teamData?.can_administer_team === true;
      if (!administer) {
        Alert.alert(
          'Access Denied',
          'Only the team owner, head coach, or organization owner can edit this team.'
        );
        safeGoBack(router, fallbackRoute);
        return;
      }
      const membershipRole = perms.membership_role;
      setIsOwner(membershipRole === 'owner' || teamData?.my_role === 'owner');
      // Archive == administer; transfer is its own (owner/coach/org-owner) flag.
      setCanArchive(perms.can_archive === true || administer);
      setCanTransfer(perms.can_transfer === true);
      setMembers(Array.isArray(summary?.members) ? summary.members : []);

      const orgFromResponse = (teamData as any).organization;
      setOrganizationName(orgFromResponse?.name || '');
    } catch (error) {
      if (__DEV__) console.error('Failed to load team:', error);
      Alert.alert('Error', 'Failed to load team data. Please try again.');
      safeGoBack(router, fallbackRoute);
    } finally {
      setLoading(false);
    }
  }, [fallbackRoute, params.id, router]);

  useEffect(() => {
    if (params?.id) {
      void loadTeam();
    }
  }, [loadTeam, params?.id]);

  const handleArchiveTeam = useCallback(() => {
    if (!params.id || archiving) return;
    Alert.alert(
      'Archive Team',
      `Archive "${name || 'this team'}"? Members, pending invites, and followers will be removed, and team chats unlinked. Past games and events keep their history. This cannot be undone from the app.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Archive Team',
          style: 'destructive',
          onPress: async () => {
            try {
              setArchiving(true);
              await Team.delete(params.id as string);
              Alert.alert('Team Archived', `${name || 'The team'} has been archived.`, [
                { text: 'OK', onPress: () => safeGoBack(router, fallbackRoute) },
              ]);
            } catch (e: any) {
              const msg = toUserMessage(e, 'Failed to archive team');
              Alert.alert('Unable to archive team', msg);
            } finally {
              setArchiving(false);
            }
          },
        },
      ]
    );
  }, [archiving, fallbackRoute, name, params.id, router]);

  const setLogoFromPickerResult = async (pickerResult: ImagePicker.ImagePickerResult) => {
    if (!pickerResult.canceled && pickerResult.assets[0]) {
      const localUri = await materializeICloudAssetIfNeeded(pickerResult.assets[0].uri);
      setLogoUri(localUri);
    }
  };

  const pickLogoImage = async ({
    requestPermission,
    permissionMessage,
    launchPicker,
  }: {
    requestPermission: () => Promise<ImagePicker.PermissionResponse>;
    permissionMessage: string;
    launchPicker: () => Promise<ImagePicker.ImagePickerResult>;
  }) => {
    const result = await requestPermission();
    if (result.granted === false) {
      Alert.alert('Permission Required', permissionMessage, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open Settings', onPress: () => Linking.openSettings() },
      ]);
      return;
    }

    await setLogoFromPickerResult(await launchPicker());
  };

  const pickImage = async () => {
    await pickLogoImage({
      requestPermission: ImagePicker.requestMediaLibraryPermissionsAsync,
      permissionMessage: 'Please allow access to your photos to upload a team logo.',
      launchPicker: () =>
        ImagePicker.launchImageLibraryAsync({
          ...pickerMediaTypesProp(),
          allowsEditing: true,
          aspect: [1, 1],
          quality: 0.8,
          exif: false,
        }),
    });
  };

  const takePhoto = async () => {
    await pickLogoImage({
      requestPermission: ImagePicker.requestCameraPermissionsAsync,
      permissionMessage: 'Please allow camera access to take a team logo photo.',
      launchPicker: () =>
        ImagePicker.launchCameraAsync({
          allowsEditing: true,
          aspect: [1, 1],
          quality: 0.8,
          exif: false,
        }),
    });
  };

  const showImagePicker = () => {
    Alert.alert('Select Logo', 'Choose how you want to add a team logo', [
      { text: 'Camera', onPress: takePhoto },
      { text: 'Photo Library', onPress: pickImage },
      { text: 'Cancel', style: 'cancel' },
    ]);
  };

  const onSubmit = async (confirmedProgramPrivacy = false) => {
    if (!params.id) return;
    if (!name.trim()) {
      Alert.alert('Team name required', 'Please enter a team name to continue.');
      return;
    }

    // Whole-sport-follow exposure warning (audit: sport-follow-private-exposure).
    // A private team that belongs to a program is STILL shown to everyone who
    // follows the program — Program.follow fans out a TeamFollow to every
    // sub-team, and a follower can see a private team. Warn the coach the first
    // time they turn a program team private (public → private transition), before
    // it saves. Only a transition triggers it, so re-saving an already-private
    // program team never nags.
    const turningPrivateInProgram = isPrivate && !!team?.program_id && !team?.is_private;
    if (turningPrivateInProgram && !confirmedProgramPrivacy) {
      Alert.alert(
        'Private team in a program',
        'This team is part of a sport program. Making it private will still show it to everyone who follows the program — following the sport follows all of its teams. Make it private anyway?',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Make Private',
            style: 'destructive',
            onPress: () => void onSubmit(true),
          },
        ]
      );
      return;
    }

    setSubmitting(true);
    try {
      let logoUrl = existingLogoUrl; // Keep existing logo by default

      // Upload new logo if one was selected
      if (logoUri) {
        try {
          const uploaded = await uploadFile(
            getApiBaseUrl(),
            logoUri,
            'team-logo.jpg',
            'image/jpeg'
          );
          logoUrl = uploaded?.path || uploaded?.url;
        } catch (error) {
          if (__DEV__) console.error('Logo upload failed:', error);
          Alert.alert(
            'Warning',
            'Team updated but logo upload failed. Please try updating the logo again.'
          );
        }
      }

      // Handle organization - find existing or create new
      let organizationId: string | null | undefined = team?.organization_id ?? null; // Keep existing by default
      const trimmedOrgName = organizationName.trim();

      if (trimmedOrgName) {
        try {
          // Search for existing organization
          const existingOrgs = await Organization.list(trimmedOrgName, 10);

          if (Array.isArray(existingOrgs) && existingOrgs.length > 0) {
            // Check for exact match (case-insensitive)
            const exactMatch = existingOrgs.find(
              (org: any) => org.name?.toLowerCase() === trimmedOrgName.toLowerCase()
            );

            if (exactMatch) {
              organizationId = exactMatch.id;
            } else {
              // Use first result if no exact match
              organizationId = existingOrgs[0].id;
            }
          } else {
            // No matching organization found — org creation requires supporting documents,
            // which must go through the onboarding flow. Skip org assignment here.
            Alert.alert(
              'Organization Not Found',
              'No matching organization found. To create a new organization, go to Settings and set up a new league with supporting documents.'
            );
            // Continue without changing organization
          }
        } catch (err: any) {
          if (__DEV__) console.error('[EditTeam] Error handling organization:', err);
          if (__DEV__) console.error('[EditTeam] Error message:', err?.message);
          Alert.alert(
            'Warning',
            `Error with organization. Team will be updated without organization change.`
          );
          // Continue without changing organization if there's an error
        }
      } else {
        organizationId = null;
      }

      const teamData: Record<string, any> = {
        name: name.trim(),
        description: description.trim() || undefined,
        sport: sport || undefined,
        is_private: isPrivate,
        // Note: season is stored as display text in team state but database uses season_start/season_end
        // Don't send 'season' field - it doesn't exist in Team model
      };
      if (logoUrl) {
        teamData.logo_url = logoUrl;
      }
      // Always send organization fields when they change
      if (organizationId !== undefined) {
        teamData.organization_id = organizationId;
      }

      await Team.update(params.id, teamData);
      setExistingLogoUrl(logoUrl || null);
      setLogoUri(null);
      // Update local state so UI reflects saved data (including name)
      setTeam((prev: any) =>
        prev
          ? {
              ...prev,
              name: name.trim(),
              description: description.trim() || prev.description,
              sport: sport || prev.sport,
            }
          : prev
      );
      if (organizationId !== undefined) {
        setTeam((prev: any) =>
          prev
            ? {
                ...prev,
                organization_id: organizationId,
                organization: organizationId
                  ? { ...(prev.organization ?? {}), id: organizationId, name: trimmedOrgName }
                  : null,
              }
            : prev
        );
        setOrganizationName(organizationId ? trimmedOrgName : '');
      }
      Alert.alert('Success!', 'Your team has been updated successfully.', [
        { text: 'OK', onPress: () => safeGoBack(router, fallbackRoute) },
      ]);
    } catch (e: any) {
      if (__DEV__) console.error('Team update error:', e);
      if (__DEV__) console.error('Team update error status:', e?.status);
      if (__DEV__) console.error('Team update error data:', e?.data);
      if (__DEV__) console.error('Team update error message:', e?.message);
      const errorMsg = toUserMessage(e, 'Failed to update team. Please try again.');
      Alert.alert('Error', errorMsg);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <EditScreenLoading
        title="Edit Team"
        message="Loading team..."
        backgroundColor={Colors[colorScheme].background}
        tintColor={Colors[colorScheme].tint}
        textColor={Colors[colorScheme].text}
      />
    );
  }

  const currentLogoUri = logoUri || existingLogoUrl;

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: Colors[colorScheme].background }]}
      edges={['bottom']}
    >
      <Stack.Screen options={{ title: 'Edit Team', headerShown: false }} />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <EditScreenHeader
          title="Edit Team"
          textColor={Colors[colorScheme].text}
          topPadding={12 + insets.top}
          onBack={() => {
            safeGoBack(router, fallbackRoute);
          }}
        />

        {/* Intro Card */}
        <View
          style={[
            styles.introCard,
            {
              backgroundColor: Colors[colorScheme].surface,
              borderColor: Colors[colorScheme].border,
            },
          ]}
        >
          <LinearGradient
            colors={[Colors[colorScheme].tint, Colors[colorScheme].tint + 'CC']}
            style={styles.introIcon}
          >
            <MaterialIcons name="edit" size={28} color="#fff" />
          </LinearGradient>
          <Text style={[styles.introTitle, { color: Colors[colorScheme].text }]}>
            Update Your Team
          </Text>
          <Text style={[styles.introSubtitle, { color: Colors[colorScheme].mutedText }]}>
            Edit team information and update your team logo.
          </Text>
        </View>

        {/* Team Logo Section */}
        <View style={styles.formSection}>
          <Text style={[styles.sectionTitle, { color: Colors[colorScheme].text }]}>Team Logo</Text>
          <View
            style={[
              styles.logoSection,
              {
                backgroundColor: Colors[colorScheme].surface,
                borderColor: Colors[colorScheme].border,
              },
            ]}
          >
            <Pressable style={styles.logoContainer} onPress={showImagePicker}>
              {currentLogoUri ? (
                <Image
                  source={{ uri: optimizeImageUrl(currentLogoUri, 160) }}
                  style={styles.logoImage}
                />
              ) : (
                <View
                  style={[styles.logoPlaceholder, { backgroundColor: Colors[colorScheme].surface }]}
                >
                  <MaterialIcons
                    name="camera-alt"
                    size={32}
                    color={Colors[colorScheme].mutedText}
                  />
                </View>
              )}
              <View
                style={[
                  styles.logoOverlay,
                  {
                    backgroundColor: Colors[colorScheme].tint,
                    borderColor: Colors[colorScheme].background,
                  },
                ]}
              >
                <MaterialIcons name="camera-alt" size={20} color="#fff" />
              </View>
            </Pressable>
            <View style={styles.logoInfo}>
              <Text style={[styles.logoTitle, { color: Colors[colorScheme].text }]}>
                {currentLogoUri ? 'Change Logo' : 'Add Logo'}
              </Text>
              <Text style={[styles.logoDescription, { color: Colors[colorScheme].mutedText }]}>
                Upload a square logo (PNG or JPG) for your team. This will be displayed on games and
                team profiles.
              </Text>
            </View>
          </View>
        </View>

        {/* Form Fields */}
        <View style={styles.formSection}>
          <Text style={[styles.sectionTitle, { color: Colors[colorScheme].text }]}>
            Team Information
          </Text>

          <EditTextField
            label="Team Name *"
            value={name}
            onChangeText={setName}
            placeholder="Enter your team name"
            maxLength={100}
            textColor={Colors[colorScheme].text}
            mutedTextColor={Colors[colorScheme].mutedText}
            surfaceColor={Colors[colorScheme].surface}
            borderColor={Colors[colorScheme].border}
          />

          <View style={sharedStyles.inputGroup}>
            <View style={sharedStyles.labelRow}>
              <Text style={[sharedStyles.inputLabel, { color: Colors[colorScheme].text }]}>
                Description
              </Text>
              <Text
                style={[
                  sharedStyles.charCount,
                  { color: description.length > 500 ? '#DC2626' : Colors[colorScheme].mutedText },
                ]}
              >
                {description.length}/500
              </Text>
            </View>
            <TextInput
              style={[
                sharedStyles.textArea,
                styles.teamTextArea,
                {
                  backgroundColor: Colors[colorScheme].surface,
                  borderColor: description.length > 1000 ? '#DC2626' : Colors[colorScheme].border,
                  color: Colors[colorScheme].text,
                },
              ]}
              value={description}
              onChangeText={text => {
                if (text.length <= 1000) {
                  setDescription(text);
                }
              }}
              placeholder="Describe your team (optional)"
              placeholderTextColor={Colors[colorScheme].mutedText}
              multiline
              numberOfLines={3}
              maxLength={1000}
            />
          </View>

          <View style={sharedStyles.inputGroup}>
            <Text style={[sharedStyles.inputLabel, { color: Colors[colorScheme].text }]}>
              School / Organization
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
              value={organizationName}
              onChangeText={setOrganizationName}
              placeholder="e.g., Duke, UNC, Stamford High School"
              placeholderTextColor={Colors[colorScheme].mutedText}
            />
            <Text style={[sharedStyles.fieldHint, { color: Colors[colorScheme].mutedText }]}>
              Link this team to a school or organization
            </Text>
          </View>

          <View style={sharedStyles.inputGroup}>
            <Text style={[sharedStyles.inputLabel, { color: Colors[colorScheme].text }]}>
              Sport
            </Text>
            <View
              style={[
                styles.selectContainer,
                {
                  backgroundColor: Colors[colorScheme].surface,
                  borderColor: Colors[colorScheme].border,
                },
              ]}
            >
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.chipContainer}
              >
                {sports.map(sportOption => (
                  <Pressable
                    key={sportOption}
                    style={[
                      styles.chip,
                      sport === sportOption && { backgroundColor: Colors[colorScheme].tint },
                    ]}
                    onPress={() => setSport(sport === sportOption ? '' : sportOption)}
                  >
                    <Text
                      style={[
                        styles.chipText,
                        { color: sport === sportOption ? '#fff' : Colors[colorScheme].text },
                      ]}
                    >
                      {sportOption}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          </View>

          <View style={sharedStyles.inputGroup}>
            <Text style={[sharedStyles.inputLabel, { color: Colors[colorScheme].text }]}>
              Season
            </Text>
            <View
              style={[
                styles.selectContainer,
                {
                  backgroundColor: Colors[colorScheme].surface,
                  borderColor: Colors[colorScheme].border,
                },
              ]}
            >
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.chipContainer}
              >
                {seasons.map(seasonOption => (
                  <Pressable
                    key={seasonOption}
                    style={[
                      styles.chip,
                      season === seasonOption && { backgroundColor: Colors[colorScheme].tint },
                    ]}
                    onPress={() => setSeason(season === seasonOption ? '' : seasonOption)}
                  >
                    <Text
                      style={[
                        styles.chipText,
                        { color: season === seasonOption ? '#fff' : Colors[colorScheme].text },
                      ]}
                    >
                      {seasonOption}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          </View>

          {/* Privacy Toggle */}
          <View style={sharedStyles.inputGroup}>
            <Text style={[sharedStyles.inputLabel, { color: Colors[colorScheme].text }]}>
              Team Privacy
            </Text>
            <Pressable
              style={[
                styles.privacyToggle,
                {
                  backgroundColor: Colors[colorScheme].surface,
                  borderColor: isPrivate ? Colors[colorScheme].tint : Colors[colorScheme].border,
                },
              ]}
              onPress={() => setIsPrivate(p => !p)}
              accessibilityRole="switch"
              accessibilityState={{ checked: isPrivate }}
              accessibilityLabel={isPrivate ? 'Team is private' : 'Team is public'}
            >
              <MaterialIcons
                name={isPrivate ? 'lock' : 'public'}
                size={22}
                color={isPrivate ? Colors[colorScheme].tint : Colors[colorScheme].mutedText}
              />
              <View style={styles.privacyToggleText}>
                <Text style={[styles.privacyToggleLabel, { color: Colors[colorScheme].text }]}>
                  {isPrivate ? 'Private team' : 'Public team'}
                </Text>
                <Text style={[sharedStyles.fieldHint, { color: Colors[colorScheme].mutedText }]}>
                  {isPrivate
                    ? 'Hidden from public search. Only members, followers, and org admins can see the roster and full profile.'
                    : 'Discoverable in search. Anyone can view the team profile and follow.'}
                </Text>
              </View>
              <MaterialIcons
                name={isPrivate ? 'toggle-on' : 'toggle-off'}
                size={36}
                color={isPrivate ? Colors[colorScheme].tint : Colors[colorScheme].mutedText}
              />
            </Pressable>
          </View>
        </View>

        {/* Danger Zone — Transfer (owner/head coach/org owner) + Archive (== administer tier) */}
        {(canTransfer || canArchive) && (
          <View style={styles.formSection}>
            <Text style={[styles.sectionTitle, { color: '#DC2626' }]}>Danger Zone</Text>
            {canTransfer && (
              <>
                <Pressable
                  style={[styles.transferButton, { borderColor: '#DC2626' }]}
                  onPress={() => setShowTransferModal(true)}
                >
                  <MaterialIcons name="swap-horiz" size={20} color="#DC2626" />
                  <Text style={styles.transferButtonText}>Transfer Ownership</Text>
                </Pressable>
                <Text style={[sharedStyles.fieldHint, { color: Colors[colorScheme].mutedText }]}>
                  Transfer team ownership to another team member. You will become a manager.
                </Text>
              </>
            )}
            {canArchive && (
              <>
                <Pressable
                  style={[
                    styles.transferButton,
                    { borderColor: '#DC2626', marginTop: canTransfer ? 16 : 0 },
                  ]}
                  onPress={handleArchiveTeam}
                  disabled={archiving}
                >
                  {archiving ? (
                    <ActivityIndicator size="small" color="#DC2626" />
                  ) : (
                    <MaterialIcons name="archive" size={20} color="#DC2626" />
                  )}
                  <Text style={styles.transferButtonText}>
                    {archiving ? 'Archiving...' : 'Archive Team'}
                  </Text>
                </Pressable>
                <Text style={[sharedStyles.fieldHint, { color: Colors[colorScheme].mutedText }]}>
                  Archiving removes members, invites, and followers and unlinks team chats. Past
                  games and events keep their history.
                </Text>
              </>
            )}
          </View>
        )}

        <EditScreenSubmitButton
          label="Update Team"
          tintColor={Colors[colorScheme].tint}
          disabled={submitting}
          loading={submitting}
          // Wrap so the press event isn't passed as `confirmedProgramPrivacy`
          // (a truthy event would skip the private-in-program warning).
          onPress={() => onSubmit()}
        />
      </ScrollView>

      {/* Transfer Ownership Modal */}
      <Modal visible={showTransferModal} animationType="slide" transparent>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalContent, { backgroundColor: Colors[colorScheme].background }]}>
            <View style={styles.modalHeader}>
              <Text style={[styles.modalTitle, { color: Colors[colorScheme].text }]}>
                Transfer Ownership
              </Text>
              <Pressable
                onPress={() => {
                  setShowTransferModal(false);
                  setMemberSearch('');
                }}
                hitSlop={12}
              >
                <MaterialIcons name="close" size={24} color={Colors[colorScheme].text} />
              </Pressable>
            </View>

            <Text style={[styles.modalSubtitle, { color: Colors[colorScheme].mutedText }]}>
              Select a team member to become the new owner. You will be demoted to manager.
            </Text>

            <TextInput
              style={[
                sharedStyles.textInput,
                {
                  backgroundColor: Colors[colorScheme].surface,
                  borderColor: Colors[colorScheme].border,
                  color: Colors[colorScheme].text,
                  marginBottom: 12,
                },
              ]}
              value={memberSearch}
              onChangeText={setMemberSearch}
              placeholder="Search by name or email..."
              placeholderTextColor={Colors[colorScheme].mutedText}
              autoCapitalize="none"
            />

            <FlatList
              data={members.filter((m: any) => {
                // Exclude current owner
                const uid = m.user_id || m.user?.id;
                if (uid === currentUser?.id) return false;
                // Filter by search
                if (!memberSearch.trim()) return true;
                const q = memberSearch.toLowerCase();
                const name = (m.user?.display_name || m.display_name || '').toLowerCase();
                const email = (m.user?.email || m.email || '').toLowerCase();
                return name.includes(q) || email.includes(q);
              })}
              keyExtractor={(m: any) => m.id || m.user_id || m.user?.id}
              style={{ maxHeight: 300 }}
              ListEmptyComponent={
                <Text style={[styles.emptyText, { color: Colors[colorScheme].mutedText }]}>
                  No team members found.
                </Text>
              }
              renderItem={({ item: m }) => {
                const uid = m.user_id || m.user?.id;
                const displayName = m.user?.username || 'Unknown';
                const email = m.user?.email || m.email || '';
                const role = m.role || 'member';

                return (
                  <Pressable
                    style={[styles.memberRow, { borderColor: Colors[colorScheme].border }]}
                    onPress={() => {
                      Alert.alert(
                        'Confirm Transfer',
                        `Are you sure you want to transfer ownership to ${displayName}?\n\nThis cannot be undone. You will become a manager.`,
                        [
                          { text: 'Cancel', style: 'cancel' },
                          {
                            text: 'Transfer',
                            style: 'destructive',
                            onPress: async () => {
                              setTransferring(true);
                              try {
                                if (!params.id) return;
                                await Team.transferOwnership(params.id, uid);
                                setShowTransferModal(false);
                                setMemberSearch('');
                                setIsOwner(false);
                                Alert.alert(
                                  'Ownership Transferred',
                                  `${displayName} is now the team owner.`,
                                  [
                                    {
                                      text: 'OK',
                                      onPress: () => {
                                        safeGoBack(router, fallbackRoute);
                                      },
                                    },
                                  ]
                                );
                              } catch (e: any) {
                                const msg = toUserMessage(e, 'Failed to transfer ownership');
                                Alert.alert('Error', msg);
                              } finally {
                                setTransferring(false);
                              }
                            },
                          },
                        ]
                      );
                    }}
                    disabled={transferring}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.memberName, { color: Colors[colorScheme].text }]}>
                        {displayName}
                      </Text>
                      {email ? (
                        <Text
                          style={[styles.memberEmail, { color: Colors[colorScheme].mutedText }]}
                        >
                          {email}
                        </Text>
                      ) : null}
                    </View>
                    <View
                      style={[styles.rolePill, { backgroundColor: Colors[colorScheme].surface }]}
                    >
                      <Text style={[styles.roleLabel, { color: Colors[colorScheme].mutedText }]}>
                        {role}
                      </Text>
                    </View>
                  </Pressable>
                );
              }}
            />

            {transferring && (
              <View style={styles.transferringOverlay}>
                <ActivityIndicator size="large" color={Colors[colorScheme].tint} />
                <Text style={[{ color: Colors[colorScheme].text, marginTop: 8 }]}>
                  Transferring...
                </Text>
              </View>
            )}
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  introCard: {
    marginHorizontal: 20,
    marginBottom: 24,
    padding: 20,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
  },
  introIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  introTitle: {
    fontSize: 20,
    fontWeight: '700',
    marginBottom: 8,
    textAlign: 'center',
  },
  introSubtitle: {
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  formSection: {
    marginBottom: 24,
    paddingHorizontal: 20,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 16,
  },
  logoSection: {
    padding: 20,
    borderRadius: 16,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  logoContainer: {
    position: 'relative',
  },
  logoImage: {
    width: 80,
    height: 80,
    borderRadius: 40,
  },
  logoPlaceholder: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoOverlay: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#fff',
  },
  logoInfo: {
    flex: 1,
  },
  logoTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  logoDescription: {
    fontSize: 12,
    lineHeight: 16,
  },
  teamTextArea: { minHeight: 80 },
  selectContainer: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 8,
  },
  chipContainer: {
    paddingHorizontal: 16,
    gap: 8,
  },
  chip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: 'rgba(128,128,128,0.15)',
  },
  chipText: {
    fontSize: 14,
    fontWeight: '500',
  },
  privacyToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1.5,
  },
  privacyToggleText: {
    flex: 1,
  },
  privacyToggleLabel: {
    fontSize: 15,
    fontWeight: '700',
  },
  transferButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1.5,
  },
  transferButtonText: {
    color: '#DC2626',
    fontSize: 15,
    fontWeight: '700',
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    paddingBottom: 40,
    maxHeight: '70%',
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
  },
  modalSubtitle: {
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 16,
  },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
  },
  memberName: {
    fontSize: 16,
    fontWeight: '600',
  },
  memberEmail: {
    fontSize: 13,
    marginTop: 2,
  },
  rolePill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  roleLabel: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'capitalize',
  },
  emptyText: {
    textAlign: 'center',
    paddingVertical: 24,
    fontSize: 14,
  },
  transferringOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.3)',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
  },
});

export default EditTeamScreen;
