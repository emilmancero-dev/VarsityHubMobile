import { toUserMessage } from '@/utils/toUserMessage';
import CoachAccessRedirecting from '@/components/CoachAccessRedirecting';
import { Colors } from '@/constants/Colors';
import { useAuth } from '@/context/AuthProvider';
import { useColorScheme } from '@/hooks/useColorScheme';
import { useCreateTeamAccess } from '@/hooks/useCreateTeamAccess';
import { materializeICloudAssetIfNeeded } from '@/utils/materializeICloudAsset';
import { safeGoBack } from '@/utils/navigation';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useQueryClient } from '@tanstack/react-query';
import * as ImagePicker from 'expo-image-picker';
import { LinearGradient } from 'expo-linear-gradient';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView as RNScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
// @ts-ignore
import { Organization, Subscriptions, Team } from '@/api/entities';
import { getApiBaseUrl } from '@/api/http';
import { uploadFile } from '@/api/upload';
import KeyboardAwareScreen from '@/components/KeyboardAwareScreen';
import { normalizePlan, ROOKIE_PROGRAM_LIMIT } from '@/constants/plans';
import {
  GENDER_OPTIONS,
  LEVEL_OPTIONS,
  formatProgramLabel,
  type TeamGender,
  type TeamLevel,
} from '@/constants/programs';
import { SPORT_LABELS, SPORT_OPTIONS } from '@/constants/sports';
import { useOrgProgramsQuery, type OrgProgram } from '@/hooks/useOrgProgramsQuery';
import { getAuthSnapshot } from '@/utils/authState';
import { getCanonicalBillingState } from '@/utils/billingState';
import { handleCoachAccessError } from '@/utils/coachAccess';
import { sanitizeText } from '@/utils/formUtils';
import { getCoachRecoveryRoute } from '@/utils/roleChecks';

type TeamLimitSummary = {
  owned_teams: number;
  max_teams: number | null;
  can_create_more: boolean;
  remaining?: number;
  subscription_tier?: string;
  upgrade_required?: boolean;
  // Phase 4 (program-based billing): owned_programs is the billable-unit
  // count; metered is true only for Stripe-metered veterans (IAP veterans /
  // rookie / legend are false — no Stripe subscription quantity to update).
  owned_programs?: number;
  metered?: boolean;
};

type ApiErrorLike = {
  message?: string;
  code?: string;
  status?: number;
  data?: {
    code?: string;
    error?: string;
  };
  response?: {
    status?: number;
  };
};

type UserOrgPreference = {
  plan?: string | null;
  pending_plan?: string | null;
  payment_pending?: boolean | null;
  payment_approved?: boolean | null;
  subscription_tier?: string | null;
  preferences?: {
    organization_id?: string | null;
    role?: string | null;
    plan?: string | null;
    pending_plan?: string | null;
    payment_pending?: boolean | null;
    payment_approved?: boolean | null;
  };
  _count?: {
    teams?: number;
  };
};

// Maps a sport picker label (e.g. "Soccer") to its canonical taxonomy slug.
// Returns null for 'Other'/custom sport labels — those have no canonical
// slug, so program creation is skipped for them (team created ungrouped).
export function sportLabelToSlug(label: string): string | null {
  if (!label || label === 'Other') return null;
  const match = SPORT_OPTIONS.find(option => option.label === label);
  return match ? match.slug : null;
}

// Pure helper: derives the program_id/level fields merged into the team
// create payload. Kept outside the component so it can be unit tested
// directly — see __tests__/create-team-program-payload.test.ts.
export function buildProgramFields(opts: {
  selectedProgramId: string | null;
  createdProgramId: string | null;
  level: TeamLevel | null;
  gender?: TeamGender | null;
}): { program_id?: string; level?: TeamLevel; gender?: TeamGender } {
  const program_id = opts.selectedProgramId ?? opts.createdProgramId ?? undefined;
  return {
    ...(program_id ? { program_id } : {}),
    ...(opts.level ? { level: opts.level } : {}),
    ...(opts.gender ? { gender: opts.gender } : {}),
  };
}

// Pure helper: decides whether the Veteran plan's Stripe subscription
// quantity must be updated before creating a new team (Phase 4 program-based
// billing). Only Stripe-metered veterans (`/teams/limits` -> `metered: true`)
// have a Stripe quantity to meter — IAP veterans (Apple/Google, no Stripe
// subscription) are unlimited on their rail and must skip the quantity
// update entirely. `isNewProgram` must be false when the new team is joining
// a sport program the org already runs — the server's billable-program count
// (countBillableProgramsForContext in server/src/routes/teams.ts) only counts
// a program once it has an active team, so adding another team to an
// already-active program does NOT increase the count, and bumping the Stripe
// quantity in that case would over-bill by one unit permanently. Kept outside
// the component so it can be unit tested directly — see
// __tests__/create-team-metering-guard.test.tsx.
export function resolveVeteranMeteringAction(opts: {
  metered: boolean | null | undefined;
  programCount: number;
  rookieProgramLimit: number;
  isNewProgram: boolean;
}): { shouldMeterQuantity: boolean; newProgramCount: number; billableProgramCount: number } {
  const newProgramCount = opts.isNewProgram ? opts.programCount + 1 : opts.programCount;
  const billableProgramCount = Math.max(0, newProgramCount - opts.rookieProgramLimit);
  return {
    shouldMeterQuantity: opts.metered === true && opts.isNewProgram,
    newProgramCount,
    billableProgramCount,
  };
}

// Plan labels route through the canonical normalizer so legacy tier strings
// ('premium', 'pro') render their mapped plan, matching every other screen.
const formatPlanBadge = (tier?: string | null) => normalizePlan(tier ?? undefined).toUpperCase();
const formatPlanDisplay = (tier?: string | null) => {
  const normalized = normalizePlan(tier ?? undefined);
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
};

function CreateTeamScreen() {
  const { user: authUser, checkAuth } = useAuth();
  const {
    canAccessCreateTeam,
    hasManagedOrganizationAccess,
    loading: createTeamAccessLoading,
  } = useCreateTeamAccess();
  const router = useRouter();
  const params = useLocalSearchParams<{
    fallback?: string;
    orgId?: string;
    organization_id?: string;
    organization_name?: string;
  }>();
  const colorScheme = useColorScheme() ?? 'light';
  const insets = useSafeAreaInsets();
  const routeOrganizationId =
    typeof params.orgId === 'string' && params.orgId.trim().length > 0
      ? params.orgId.trim()
      : typeof params.organization_id === 'string' && params.organization_id.trim().length > 0
        ? params.organization_id.trim()
        : null;
  const routeOrganizationName =
    typeof params.organization_name === 'string' && params.organization_name.trim().length > 0
      ? params.organization_name.trim()
      : '';
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [sport, setSport] = useState('');
  const [customSport, setCustomSport] = useState('');
  const [clubType, setClubType] = useState<'sport' | 'extracurricular'>('sport');
  const [extracurricularCategory, setExtracurricularCategory] = useState('');
  const [seasonType, setSeasonType] = useState(''); // Fall, Spring, Summer, Winter
  const [seasonYear, setSeasonYear] = useState(''); // Year editable by user
  const [teamColor, setTeamColor] = useState(''); // Team primary color
  const [organizationName, setOrganizationName] = useState(''); // School/organization name
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [selectedProgramId, setSelectedProgramId] = useState<string | null>(null);
  const [creatingProgram, setCreatingProgram] = useState(false);
  const [teamGender, setTeamGender] = useState<TeamGender | null>(null);
  const [selectedLevel, setSelectedLevel] = useState<TeamLevel | null>(null);
  const [orgSearchResults, setOrgSearchResults] = useState<
    Array<{ id: string; name: string; description?: string }>
  >([]);
  const [orgSearching, setOrgSearching] = useState(false);
  const orgSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showOrgPicker, setShowOrgPicker] = useState(false);
  const [orgModalSearch, setOrgModalSearch] = useState('');
  const [logoUri, setLogoUri] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [nameError, setNameError] = useState('');
  const [colorError, setColorError] = useState('');
  const [limitsLoading, setLimitsLoading] = useState(true);
  const [teamLimits, setTeamLimits] = useState<TeamLimitSummary | null>(null);
  const [limitsError, setLimitsError] = useState<string | null>(null);
  const limitReached = !!teamLimits && teamLimits.can_create_more === false;
  const planBadgeText = formatPlanBadge(teamLimits?.subscription_tier);
  const planDisplayName = formatPlanDisplay(teamLimits?.subscription_tier);
  const maxTeamsLabel =
    teamLimits && typeof teamLimits.max_teams === 'number' && Number.isFinite(teamLimits.max_teams)
      ? teamLimits.max_teams
      : '∞';
  const remainingCount =
    teamLimits && typeof teamLimits.remaining === 'number'
      ? Math.max(teamLimits.remaining, 0)
      : null;
  const explicitFallback =
    typeof params.fallback === 'string' && params.fallback.trim().startsWith('/')
      ? params.fallback.trim()
      : selectedOrgId
        ? `/organization?id=${encodeURIComponent(selectedOrgId)}&tab=teams`
        : routeOrganizationId
          ? `/organization?id=${encodeURIComponent(routeOrganizationId)}&tab=teams`
          : '/organization?tab=teams';

  useEffect(() => {
    if (createTeamAccessLoading || canAccessCreateTeam) return;
    const recoveryRoute = getCoachRecoveryRoute(authUser as any);
    router.replace((recoveryRoute || '/(tabs)') as never);
  }, [authUser, canAccessCreateTeam, createTeamAccessLoading, router]);

  const sports = SPORT_LABELS;
  const queryClient = useQueryClient();

  const { data: orgPrograms, refetch: refetchOrgPrograms } = useOrgProgramsQuery({
    organizationId: selectedOrgId,
    enabled: !!selectedOrgId && clubType === 'sport',
  });

  // A program is scoped to one organization — drop any selection made under
  // a previous org so a stale program_id can't attach to the new org's team.
  useEffect(() => {
    setSelectedProgramId(null);
    setCreatingProgram(false);
    setTeamGender(null);
    setSelectedLevel(null);
  }, [selectedOrgId]);

  const handleSelectProgram = useCallback(
    (program: OrgProgram) => {
      if (selectedProgramId === program.id) {
        // Level lives inside the program section — deselecting hides the chips,
        // so drop the level too or it rides along invisibly into the payload.
        setSelectedProgramId(null);
        setSelectedLevel(null);
        return;
      }
      setSelectedProgramId(program.id);
      setCreatingProgram(false);
      // Prefill/lock the sport picker to the program's sport. An unresolvable
      // slug leaves nothing to lock onto, so clear rather than show a stale one.
      const sportOption = SPORT_OPTIONS.find(option => option.slug === program.sport);
      setSport(sportOption ? sportOption.label : '');
    },
    [selectedProgramId]
  );

  const handleToggleNewProgram = useCallback(() => {
    if (creatingProgram) {
      setCreatingProgram(false);
      setSelectedLevel(null);
      return;
    }
    setCreatingProgram(true);
    setSelectedProgramId(null);
  }, [creatingProgram]);

  // Predefined team colors
  const teamColors = [
    { name: 'Red', hex: '#DC2626' },
    { name: 'Blue', hex: '#2563EB' },
    { name: 'Green', hex: '#16A34A' },
    { name: 'Purple', hex: '#9333EA' },
    { name: 'Orange', hex: '#EA580C' },
    { name: 'Yellow', hex: '#EAB308' },
    { name: 'Navy', hex: '#1E3A8A' },
    { name: 'Maroon', hex: '#7F1D1D' },
    { name: 'Midnight', hex: '#0F172A' },
    { name: 'Gold', hex: '#F59E0B' },
    { name: 'White', hex: '#FFFFFF' },
    { name: 'Black', hex: '#000000' }, // audit: swatch data, not a text color
    { name: 'Silver', hex: '#C0C0C0' },
    { name: 'Metallic Gold', hex: '#D4AF37' },
    { name: 'Teal', hex: '#14B8A6' },
    { name: 'Pink', hex: '#EC4899' },
    { name: 'Lime', hex: '#84CC16' },
    { name: 'Brown', hex: '#92400E' },
  ];

  // Organization search inside modal
  const handleOrgModalSearch = useCallback((text: string) => {
    setOrgModalSearch(text);
    if (orgSearchTimer.current) clearTimeout(orgSearchTimer.current);
    if (text.trim().length < 2) {
      setOrgSearchResults([]);
      return;
    }
    orgSearchTimer.current = setTimeout(async () => {
      setOrgSearching(true);
      try {
        const results = (await Organization.list(text.trim(), 20)) as Array<{
          id: string;
          name: string;
          description?: string;
        }> | null;
        setOrgSearchResults(Array.isArray(results) ? results : []);
      } catch {
        setOrgSearchResults([]);
      } finally {
        setOrgSearching(false);
      }
    }, 350);
  }, []);

  const handleSelectOrg = useCallback((org: { id: string; name: string }) => {
    setOrganizationName(org.name);
    setSelectedOrgId(org.id);
    setOrgSearchResults([]);
    setOrgModalSearch('');
    setShowOrgPicker(false);
  }, []);

  useEffect(() => {
    return () => {
      if (orgSearchTimer.current) clearTimeout(orgSearchTimer.current);
    };
  }, []);

  // Pre-populate org from coach's profile if they have one
  useEffect(() => {
    if (selectedOrgId) return; // Already selected
    void (async () => {
      if (routeOrganizationId) {
        setSelectedOrgId(routeOrganizationId);
        if (routeOrganizationName) setOrganizationName(routeOrganizationName);
        try {
          const { Organization } = await import('@/api/entities');
          const org = await Organization.get(routeOrganizationId);
          if (org?.id && org?.name) {
            setSelectedOrgId(org.id);
            setOrganizationName(org.name);
          }
        } catch {
          // Keep the handed-off org context even if the refresh lookup fails.
        }
        return;
      }

      try {
        const me = (await getAuthSnapshot(checkAuth, authUser)) as UserOrgPreference | null;
        const orgId = me?.preferences?.organization_id;
        if (orgId) {
          const { Organization } = await import('@/api/entities');
          const org = await Organization.get(orgId);
          if (org?.id && org?.name) {
            setSelectedOrgId(org.id);
            setOrganizationName(org.name);
          }
        }
      } catch {
        /* ignore — user may not have an org yet */
      }
    })();
  }, [authUser, checkAuth, routeOrganizationId, routeOrganizationName, selectedOrgId]);

  // Auto-suggest year based on season selection
  const getSuggestedYear = (seasonName: string) => {
    const now = new Date();
    const currentMonth = now.getMonth(); // 0-11
    const currentYear = now.getFullYear();

    switch (seasonName) {
      case 'Fall':
        // Fall typically starts Aug-Sept, suggest current year if before Dec, else next year
        return currentMonth < 11 ? currentYear : currentYear + 1;
      case 'Winter':
        // Winter starts Dec-Jan, suggest current year if in Nov-Dec, else current year (for Jan-Mar)
        return currentMonth >= 10 ? currentYear : currentYear;
      case 'Spring':
        // Spring starts Mar-Apr, suggest current year if before Sept, else next year
        return currentMonth < 8 ? currentYear : currentYear + 1;
      case 'Summer':
        // Summer starts Jun-Jul, suggest current year if before Dec, else next year
        return currentMonth < 11 ? currentYear : currentYear + 1;
      default:
        return currentYear;
    }
  };

  // Handle season type selection
  const handleSeasonTypeSelect = (type: string) => {
    setSeasonType(type);
    const suggestedYear = getSuggestedYear(type);
    setSeasonYear(suggestedYear.toString());
  };

  // Combined season string for API
  const season = seasonType && seasonYear ? `${seasonType} ${seasonYear}` : '';

  const pickImage = async () => {
    const result = await ImagePicker.requestMediaLibraryPermissionsAsync();

    if (result.granted === false) {
      Alert.alert(
        'Permission Required',
        'Please allow access to your photos to upload a team logo.',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Open Settings', onPress: () => Linking.openSettings() },
        ]
      );
      return;
    }

    const pickerResult = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
      exif: false,
    });

    if (!pickerResult.canceled && pickerResult.assets[0]) {
      const localUri = await materializeICloudAssetIfNeeded(pickerResult.assets[0].uri);
      setLogoUri(localUri);
    }
  };

  const takePhoto = async () => {
    const result = await ImagePicker.requestCameraPermissionsAsync();

    if (result.granted === false) {
      Alert.alert('Permission Required', 'Please allow camera access to take a team logo photo.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Open Settings', onPress: () => Linking.openSettings() },
      ]);
      return;
    }

    const pickerResult = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
      exif: false,
    });

    if (!pickerResult.canceled && pickerResult.assets[0]) {
      const localUri = await materializeICloudAssetIfNeeded(pickerResult.assets[0].uri);
      setLogoUri(localUri);
    }
  };

  const showImagePicker = () => {
    Alert.alert('Select Team Logo', 'Choose how to add your team logo', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Photo Library', onPress: pickImage },
      { text: 'Take Photo', onPress: takePhoto },
    ]);
  };

  useEffect(() => {
    let mounted = true;
    const loadLimits = async () => {
      setLimitsLoading(true);
      setLimitsError(null);
      try {
        const summary: TeamLimitSummary = await Team.limits();
        if (!mounted) return;
        setTeamLimits(summary);
      } catch (error: unknown) {
        if (!mounted) return;
        const err = error as ApiErrorLike;
        setTeamLimits(null);
        const status = err?.status ?? err?.response?.status;
        const message =
          status === 401
            ? 'Sign in with a coach account to view your plan limits.'
            : toUserMessage(err, 'Unable to load plan limits.');
        setLimitsError(message);
      } finally {
        if (mounted) setLimitsLoading(false);
      }
    };
    void loadLimits();
    return () => {
      mounted = false;
    };
  }, []);

  const onSubmit = async () => {
    if (!name.trim()) {
      setNameError('Please enter a team name');
      return;
    }
    if (name.trim().length > 100) {
      setNameError('Team name must be 100 characters or fewer');
      return;
    }

    if (!selectedOrgId) {
      Alert.alert(
        'Organization Required',
        'Please select an existing league or organization before creating a team.'
      );
      return;
    }

    if (!teamColor) {
      setColorError('Please select a team color');
      return;
    }

    setSubmitting(true);
    try {
      let currentUser;
      try {
        currentUser = (await getAuthSnapshot(checkAuth, authUser)) as UserOrgPreference | null;
      } catch {
        Alert.alert('Sign in required', 'Please sign in to create a team.');
        setSubmitting(false);
        return;
      }
      if (!canAccessCreateTeam) {
        Alert.alert(
          'Access Restricted',
          'Only approved coaches or active organization managers can create teams.'
        );
        setSubmitting(false);
        return;
      }

      // Check plan tier limits
      const userRole = currentUser?.preferences?.role; // Already guaranteed coach above
      const userPlan = getCanonicalBillingState(currentUser).selected_plan;

      let latestLimits: TeamLimitSummary | null = teamLimits;
      try {
        const refreshedLimits: TeamLimitSummary = await Team.limits();
        latestLimits = refreshedLimits;
        setTeamLimits(latestLimits);
      } catch {
        // non-blocking
      }
      const programCount =
        latestLimits?.owned_programs ??
        latestLimits?.owned_teams ??
        currentUser?._count?.teams ??
        0;
      const canCreateMore = latestLimits?.can_create_more ?? true;

      // Only surface local billing prompts for coach-owned flows.
      if (userRole === 'coach') {
        if (!canCreateMore) {
          Alert.alert(
            'Upgrade Required',
            `Your ${userPlan === 'rookie' ? 'Rookie (free)' : userPlan === 'veteran' ? 'Veteran' : 'current'} plan has reached its team limit. Upgrade to add more teams.`,
            [
              { text: 'Cancel', style: 'cancel', onPress: () => setSubmitting(false) },
              {
                text: 'Upgrade',
                onPress: () => {
                  setSubmitting(false);
                  router.push('/settings/manage-subscription');
                },
              },
            ]
          );
          return;
        }

        if (userPlan === 'veteran') {
          // Joining a sport program the org already runs (an existing
          // program with an active team) does NOT introduce a new billable
          // unit — see countBillableProgramsForContext in
          // server/src/routes/teams.ts. Only creating a brand-new program
          // (creatingProgram) or an ungrouped team (no program at all — e.g.
          // a custom/"Other" sport, or an extracurricular club) adds one.
          const selectedProgram =
            clubType === 'sport' && selectedProgramId
              ? (orgPrograms ?? []).find(program => program.id === selectedProgramId)
              : undefined;
          const isJoiningEstablishedProgram = !!selectedProgram && selectedProgram.teams.length > 0;
          const isNewProgram = !isJoiningEstablishedProgram;

          const meteringAction = resolveVeteranMeteringAction({
            metered: latestLimits?.metered,
            programCount,
            rookieProgramLimit: ROOKIE_PROGRAM_LIMIT,
            isNewProgram,
          });

          if (!meteringAction.shouldMeterQuantity) {
            // IAP veteran (Apple/Google) — unlimited sports on this rail, no
            // Stripe subscription quantity to update — OR a Stripe-metered
            // veteran joining an already-established program, where the
            // billable program count doesn't change. Proceed straight to
            // team creation.
            await proceedWithTeamCreation();
            return;
          }

          // Veteran plan (Stripe-metered): per-sport-program monthly charge
          // - update subscription quantity before creating the team
          const { newProgramCount, billableProgramCount } = meteringAction;
          Alert.alert(
            'Add Sport',
            `Adding this sport will update your Veteran billing to $${(billableProgramCount * 0.99).toFixed(2)}/month (${billableProgramCount} billable sport${billableProgramCount === 1 ? '' : 's'} beyond the first ${ROOKIE_PROGRAM_LIMIT} free). Your subscription will be updated automatically.`,
            [
              { text: 'Cancel', style: 'cancel', onPress: () => setSubmitting(false) },
              {
                text: 'Continue',
                onPress: async () => {
                  try {
                    // Update subscription quantity before creating the team
                    await Subscriptions.updateQuantity(newProgramCount);
                    await proceedWithTeamCreation({ rollbackTeamCount: programCount });
                  } catch (error: unknown) {
                    const err = error as ApiErrorLike;
                    if (__DEV__) console.error('Failed to update subscription:', err);
                    Alert.alert(
                      'Error',
                      toUserMessage(
                        err,
                        'Failed to update subscription. Please try again or contact support.'
                      )
                    );
                    setSubmitting(false);
                  }
                },
              },
            ]
          );
          return; // Wait for user confirmation
        }

        // Legend plan: unlimited sports, proceed
      }

      // For non-coaches or Legend plan, proceed directly
      await proceedWithTeamCreation();
    } catch (error: unknown) {
      const e = error as ApiErrorLike;
      if (__DEV__) console.error('Team creation error:', e);
      if (handleCoachAccessError(router, e, 'creating teams', authUser as any)) {
        setSubmitting(false);
        return;
      } else if (e?.data?.code === 'ORG_CREATION_FAILED' || e?.code === 'ORG_CREATION_FAILED') {
        Alert.alert(
          'Organization Error',
          'Could not create your organization. Please try again or select an existing organization.'
        );
      } else {
        Alert.alert('Error', toUserMessage(e, 'Failed to create team. Please try again.'));
      }
      setSubmitting(false);
    }
  };

  const proceedWithTeamCreation = async (options?: { rollbackTeamCount?: number }) => {
    try {
      let logoUrl = null;

      // Upload logo if one was selected
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
          Alert.alert('Warning', 'Team created but logo upload failed. You can add a logo later.');
        }
      }
      // Team creation now requires an approved organization selection.

      // If the coach is starting a brand-new program, create it first so its
      // id can be attached to the team below. A canonical sport slug is
      // required — 'Other'/custom sports have none, so program creation is
      // skipped for them and the team is created ungrouped (today's behavior).
      let createdProgramId: string | null = null;
      if (clubType === 'sport' && creatingProgram && selectedOrgId) {
        const sportSlug = sportLabelToSlug(sport);
        if (sportSlug) {
          try {
            const programResponse: any = await Organization.createProgram(selectedOrgId, {
              sport: sportSlug,
            });
            createdProgramId = programResponse?.program?.id ?? null;
            // The new program must appear in the grouped coach surfaces that
            // read this cache key (manage-teams, my-team picker).
            void queryClient.invalidateQueries({ queryKey: ['org-programs', selectedOrgId] });
          } catch (error: unknown) {
            const err = error as ApiErrorLike;
            const isProgramExists = err?.status === 409 && err?.data?.error === 'PROGRAM_EXISTS';
            if (isProgramExists) {
              // Someone else created the same (sport) program first — recover by
              // refetching and using the existing one instead of failing team
              // creation.
              try {
                const refreshed = await refetchOrgPrograms();
                const match = (refreshed?.data ?? []).find(
                  (p: OrgProgram) => p.sport === sportSlug
                );
                createdProgramId = match?.id ?? null;
              } catch (refetchError) {
                if (__DEV__)
                  console.warn(
                    '[create-team] failed to refetch programs after PROGRAM_EXISTS',
                    refetchError
                  );
              }
            } else {
              if (__DEV__)
                console.warn(
                  '[create-team] program creation failed — creating team ungrouped',
                  err
                );
            }
          }
        }
      }

      const programFields =
        clubType === 'sport'
          ? buildProgramFields({
              selectedProgramId,
              createdProgramId,
              level: selectedLevel,
              gender: teamGender,
            })
          : {};

      const teamData = {
        name: sanitizeText(name),
        description: sanitizeText(description) || undefined,
        sport:
          clubType === 'sport'
            ? sport === 'Other'
              ? sanitizeText(customSport) || 'Other'
              : sport || undefined
            : undefined,
        club_type: clubType,
        extracurricular_category:
          clubType === 'extracurricular' ? extracurricularCategory.trim() || undefined : undefined,
        season: season || undefined,
        primary_color: teamColor || undefined,
        organization_id: selectedOrgId || undefined,
        logo_url: logoUrl || undefined, // Use uploaded URL
        ...programFields,
      };

      const response = await Team.create(teamData);
      const createdTeam = response?.team || response;
      // Keep the fallback on the canonical org-admin surface even if the
      // create response comes back without a usable team id.
      const teamId = createdTeam?.id ? String(createdTeam.id) : null;
      Alert.alert('Success!', 'Your team has been created successfully.', [
        {
          text: 'View Team',
          onPress: () => {
            if (teamId) {
              router.push({
                pathname: '/team-page',
                params: { id: teamId, from: 'program' },
              } as never);
            } else {
              if (__DEV__)
                console.warn(
                  '[create-team] API returned no team.id — falling back to organization tools'
                );
              const recoveryTarget = {
                pathname: '/organization',
                params: {
                  ...(selectedOrgId ? { id: selectedOrgId } : {}),
                  tab: 'teams',
                },
              } as never;
              router.replace(recoveryTarget); // nav-safe: recovery fallback when API returns no teamId
            }
          },
        },
      ]);
    } catch (error: unknown) {
      const e = error as ApiErrorLike;
      if (__DEV__) console.error('Team creation error in proceedWithTeamCreation:', e);
      let rollbackFailed = false;
      if (typeof options?.rollbackTeamCount === 'number') {
        try {
          await Subscriptions.updateQuantity(options.rollbackTeamCount);
        } catch (rollbackError) {
          rollbackFailed = true;
          if (__DEV__)
            console.error(
              'Failed to roll back subscription quantity after team creation error:',
              rollbackError
            );
        }
      }
      if (handleCoachAccessError(router, e, 'creating teams', authUser as any)) {
        return;
      } else if (e?.data?.code === 'ORG_CREATION_FAILED' || e?.code === 'ORG_CREATION_FAILED') {
        Alert.alert(
          'Organization Error',
          'Could not create your organization. Please try again or select an existing organization.'
        );
      } else {
        Alert.alert(
          'Error',
          rollbackFailed
            ? 'Failed to create team, and billing could not be restored automatically. Please check your subscription settings.'
            : toUserMessage(e, 'Failed to create team. Please try again.')
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (createTeamAccessLoading) {
    return (
      <SafeAreaView
        style={[styles.container, { backgroundColor: Colors[colorScheme].background }]}
        edges={['bottom']}
        children={[
          <Stack.Screen
            key="loading-screen-options"
            options={{ title: 'Create Team', headerShown: false }}
          />,
          <ActivityIndicator
            key="loading-spinner"
            style={{ marginTop: 40 }}
            color={Colors[colorScheme].tint}
          />,
        ]}
      />
    );
  }

  if (!canAccessCreateTeam) {
    return (
      <CoachAccessRedirecting
        backgroundColor={Colors[colorScheme].background}
        spinnerColor={Colors[colorScheme].tint}
        textColor={Colors[colorScheme].mutedText}
        message={
          hasManagedOrganizationAccess
            ? 'Loading your team creation tools...'
            : 'Redirecting to the right coach screen...'
        }
        edges={['bottom']}
      />
    );
  }

  return (
    <SafeAreaView
      style={[styles.container, { backgroundColor: Colors[colorScheme].background }]}
      edges={['bottom']}
    >
      <Stack.Screen options={{ title: 'Create Team', headerShown: false }} />
      <KeyboardAwareScreen
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: 32 }}
        showsVerticalScrollIndicator={false}
        children={[
          <View
            key="content-stack"
            children={[
              <View
                key="header"
                style={[styles.header, { paddingTop: 12 + insets.top }]}
                children={[
                  <Pressable
                    key="header-back"
                    style={styles.backButton}
                    onPress={() => safeGoBack(router, explicitFallback)}
                    accessibilityRole="button"
                    accessibilityLabel="Go back"
                    children={[
                      <MaterialIcons
                        key="header-back-icon"
                        name="arrow-back"
                        size={24}
                        color={Colors[colorScheme].text}
                      />,
                    ]}
                  />,
                  <Text
                    key="header-title"
                    style={[styles.headerTitle, { color: Colors[colorScheme].text }]}
                  >
                    Create Team
                  </Text>,
                  <View key="header-spacer" style={{ width: 32 }} />,
                ]}
              />,

              <View
                key="intro-card"
                style={[
                  styles.introCard,
                  {
                    backgroundColor: Colors[colorScheme].surface,
                    borderColor: Colors[colorScheme].border,
                  },
                ]}
                children={[
                  <LinearGradient
                    key="intro-icon"
                    colors={[Colors[colorScheme].tint, Colors[colorScheme].tint + 'CC']}
                    style={styles.introIcon}
                    children={[
                      <MaterialIcons key="intro-icon-glyph" name="group" size={28} color="#fff" />,
                    ]}
                  />,
                  <Text
                    key="intro-title"
                    style={[styles.introTitle, { color: Colors[colorScheme].text }]}
                  >
                    Start Your Team
                  </Text>,
                  <Text
                    key="intro-subtitle"
                    style={[styles.introSubtitle, { color: Colors[colorScheme].mutedText }]}
                  >
                    Create a team to organize players, schedule games, and manage your season.
                  </Text>,
                ]}
              />,

              !limitsLoading && (teamLimits || limitsError) ? (
                <View
                  key="limit-card"
                  style={[
                    styles.limitCard,
                    {
                      borderColor: limitReached ? '#F97316' : Colors[colorScheme].border,
                      backgroundColor: limitReached ? '#FEF3C7' : Colors[colorScheme].surface,
                    },
                  ]}
                  children={[
                    <View
                      key="limit-header"
                      style={styles.limitHeader}
                      children={[
                        <Text
                          key="limit-badge"
                          style={[
                            styles.limitBadge,
                            {
                              backgroundColor: Colors[colorScheme].tint + '15',
                              color: Colors[colorScheme].tint,
                            },
                          ]}
                        >
                          {planBadgeText}
                        </Text>,
                        limitReached && Platform.OS !== 'ios' ? (
                          <Pressable
                            key="limit-cta"
                            onPress={() => router.push('/settings/manage-subscription')}
                            style={styles.limitUpgradeLink}
                            accessibilityRole="button"
                            accessibilityLabel="View subscription plans"
                            children={[
                              <MaterialIcons
                                key="limit-cta-icon"
                                name="arrow-circle-right"
                                size={18}
                                color={Colors[colorScheme].tint}
                              />,
                              <Text
                                key="limit-cta-label"
                                style={[
                                  styles.limitUpgradeText,
                                  { color: Colors[colorScheme].tint },
                                ]}
                              >
                                View plans
                              </Text>,
                            ]}
                          />
                        ) : null,
                      ]}
                    />,
                    teamLimits ? (
                      <Text
                        key="limit-title"
                        style={[styles.limitTitle, { color: Colors[colorScheme].text }]}
                      >
                        {limitReached
                          ? 'Team limit reached'
                          : `You have created ${teamLimits.owned_teams ?? 0} of ${maxTeamsLabel} teams`}
                      </Text>
                    ) : null,
                    teamLimits ? (
                      <Text
                        key="limit-description"
                        style={[styles.limitDescription, { color: Colors[colorScheme].mutedText }]}
                      >
                        {limitReached
                          ? Platform.OS === 'ios'
                            ? "You've reached the maximum number of teams."
                            : 'Upgrade your plan to add more teams and authorized staff.'
                          : remainingCount === null
                            ? 'Unlimited teams on this plan.'
                            : `${remainingCount} team${remainingCount === 1 ? '' : 's'} remaining on your plan.`}
                      </Text>
                    ) : (
                      <Text
                        key="limit-error"
                        style={[styles.limitDescription, { color: Colors[colorScheme].mutedText }]}
                      >
                        {limitsError}
                      </Text>
                    ),
                  ]}
                />
              ) : null,

              <View
                key="form-section"
                style={styles.formSection}
                children={[
                  <View
                    key="team-name-group"
                    style={styles.fieldGroup}
                    children={[
                      <Text
                        key="team-name-label"
                        style={[styles.fieldLabel, { color: Colors[colorScheme].text }]}
                      >
                        Team Name <Text style={{ color: Colors[colorScheme].destructive }}>*</Text>
                      </Text>,
                      <View
                        key="team-name-input-wrapper"
                        style={[
                          styles.inputContainer,
                          {
                            backgroundColor: Colors[colorScheme].surface,
                            borderColor: Colors[colorScheme].border,
                          },
                        ]}
                        children={[
                          <MaterialIcons
                            key="team-name-icon"
                            name="emoji-events"
                            size={20}
                            color={Colors[colorScheme].mutedText}
                          />,
                          <TextInput
                            key="team-name-input"
                            value={name}
                            onChangeText={text => {
                              setName(text);
                              setNameError('');
                            }}
                            placeholder="e.g. Springfield Eagles"
                            placeholderTextColor={Colors[colorScheme].mutedText}
                            style={[styles.textInput, { color: Colors[colorScheme].text }]}
                            accessibilityLabel="Team name"
                            returnKeyType="done"
                            maxLength={100}
                          />,
                        ]}
                      />,
                      nameError ? (
                        <Text
                          key="team-name-error"
                          style={{ color: '#EF4444', fontSize: 13, marginTop: 4 }}
                        >
                          {nameError}
                        </Text>
                      ) : null,
                    ]}
                  />,

                  <View
                    key="team-logo-group"
                    style={styles.fieldGroup}
                    children={[
                      <Text
                        key="team-logo-label"
                        style={[styles.fieldLabel, { color: Colors[colorScheme].text }]}
                      >
                        Team Logo
                      </Text>,
                      <View
                        key="team-logo-section"
                        style={styles.logoSection}
                        children={[
                          <Pressable
                            key="logo-picker"
                            style={[
                              styles.logoContainer,
                              {
                                backgroundColor: Colors[colorScheme].surface,
                                borderColor: Colors[colorScheme].border,
                              },
                            ]}
                            onPress={showImagePicker}
                            accessibilityRole="button"
                            accessibilityLabel={logoUri ? 'Change team logo' : 'Add team logo'}
                            children={
                              logoUri ? (
                                <Image source={{ uri: logoUri }} style={styles.logoImage} />
                              ) : (
                                [
                                  <MaterialIcons
                                    key="logo-placeholder-icon"
                                    name="camera-alt"
                                    size={32}
                                    color={Colors[colorScheme].mutedText}
                                  />,
                                  <Text
                                    key="logo-placeholder-text"
                                    style={[
                                      styles.logoPlaceholderText,
                                      { color: Colors[colorScheme].mutedText },
                                    ]}
                                  >
                                    Add Logo
                                  </Text>,
                                ]
                              )
                            }
                          />,
                          <View
                            key="logo-actions"
                            style={styles.logoActions}
                            children={[
                              <Pressable
                                key="logo-add-button"
                                style={[
                                  styles.logoActionButton,
                                  { backgroundColor: Colors[colorScheme].tint },
                                ]}
                                onPress={showImagePicker}
                                accessibilityRole="button"
                                accessibilityLabel={logoUri ? 'Change logo' : 'Add logo'}
                                children={[
                                  <MaterialIcons
                                    key="logo-add-button-icon"
                                    name="add"
                                    size={20}
                                    color="#fff"
                                  />,
                                  <Text key="logo-add-button-text" style={styles.logoActionText}>
                                    {logoUri ? 'Change' : 'Add Logo'}
                                  </Text>,
                                ]}
                              />,
                              logoUri ? (
                                <Pressable
                                  key="logo-remove-button"
                                  style={[styles.logoActionButton, { backgroundColor: '#EF4444' }]}
                                  onPress={() => setLogoUri(null)}
                                  accessibilityRole="button"
                                  accessibilityLabel="Remove logo"
                                  children={[
                                    <MaterialIcons
                                      key="logo-remove-icon"
                                      name="delete-outline"
                                      size={20}
                                      color="#fff"
                                    />,
                                    <Text key="logo-remove-text" style={styles.logoActionText}>
                                      Remove
                                    </Text>,
                                  ]}
                                />
                              ) : null,
                            ]}
                          />,
                        ]}
                      />,
                      <Text
                        key="team-logo-hint"
                        style={[styles.fieldHint, { color: Colors[colorScheme].mutedText }]}
                      >
                        Upload a square logo (PNG or JPG) for your team. This will be displayed on
                        games and team profiles.
                      </Text>,
                    ]}
                  />,

                  <View
                    key="club-type-group"
                    style={styles.fieldGroup}
                    children={[
                      <Text
                        key="club-type-label"
                        style={[styles.fieldLabel, { color: Colors[colorScheme].text }]}
                      >
                        Team Type
                      </Text>,
                      <View
                        key="club-type-options"
                        style={styles.clubTypeContainer}
                        children={[
                          <Pressable
                            key="sport-team-button"
                            style={[
                              styles.clubTypeButton,
                              {
                                backgroundColor:
                                  clubType === 'sport'
                                    ? Colors[colorScheme].tint
                                    : Colors[colorScheme].surface,
                                borderColor:
                                  clubType === 'sport'
                                    ? Colors[colorScheme].tint
                                    : Colors[colorScheme].border,
                              },
                            ]}
                            onPress={() => {
                              setClubType('sport');
                              setExtracurricularCategory('');
                            }}
                            accessibilityRole="button"
                            accessibilityLabel="Sport Team"
                            accessibilityState={{ selected: clubType === 'sport' }}
                            children={[
                              <MaterialIcons
                                key="sport-team-icon"
                                name="sports-football"
                                size={20}
                                color={clubType === 'sport' ? '#fff' : Colors[colorScheme].text}
                              />,
                              <Text
                                key="sport-team-text"
                                style={[
                                  styles.clubTypeText,
                                  {
                                    color: clubType === 'sport' ? '#fff' : Colors[colorScheme].text,
                                  },
                                ]}
                              >
                                Sport Team
                              </Text>,
                            ]}
                          />,
                          <Pressable
                            key="extracurricular-button"
                            style={[
                              styles.clubTypeButton,
                              {
                                backgroundColor:
                                  clubType === 'extracurricular'
                                    ? Colors[colorScheme].tint
                                    : Colors[colorScheme].surface,
                                borderColor:
                                  clubType === 'extracurricular'
                                    ? Colors[colorScheme].tint
                                    : Colors[colorScheme].border,
                                opacity:
                                  (teamLimits?.subscription_tier || 'rookie').toLowerCase() ===
                                  'legend'
                                    ? 1
                                    : 0.5,
                              },
                            ]}
                            accessibilityRole="button"
                            accessibilityLabel="Extracurricular Club"
                            accessibilityState={{ selected: clubType === 'extracurricular' }}
                            onPress={async () => {
                              const userPlan = (
                                teamLimits?.subscription_tier || 'rookie'
                              ).toLowerCase();
                              if (userPlan !== 'legend') {
                                Alert.alert(
                                  'Legend Plan Required',
                                  'Extracurricular clubs (Theater, Chess, Debate, etc.) require the Legend plan ($20/year). Upgrade to create clubs beyond sports teams.',
                                  [
                                    { text: 'Cancel', style: 'cancel' },
                                    {
                                      text: 'Upgrade to Legend',
                                      onPress: () => router.push('/settings/manage-subscription'),
                                      style: 'default',
                                    },
                                  ]
                                );
                                return;
                              }
                              setClubType('extracurricular');
                              setSport('');
                            }}
                            children={[
                              <MaterialIcons
                                key="extracurricular-icon"
                                name="school"
                                size={20}
                                color={
                                  clubType === 'extracurricular' ? '#fff' : Colors[colorScheme].text
                                }
                              />,
                              <Text
                                key="extracurricular-text"
                                style={[
                                  styles.clubTypeText,
                                  {
                                    color:
                                      clubType === 'extracurricular'
                                        ? '#fff'
                                        : Colors[colorScheme].text,
                                  },
                                ]}
                              >
                                Extracurricular Club
                              </Text>,
                              (teamLimits?.subscription_tier || 'rookie').toLowerCase() !==
                              'legend' ? (
                                <View
                                  key="legend-badge"
                                  style={styles.legendBadge}
                                  children={[
                                    <Text key="legend-badge-text" style={styles.legendBadgeText}>
                                      LEGEND
                                    </Text>,
                                  ]}
                                />
                              ) : null,
                            ]}
                          />,
                        ]}
                      />,
                      clubType === 'extracurricular' ? (
                        <View
                          key="club-category-group"
                          style={styles.fieldGroup}
                          children={[
                            <Text
                              key="club-category-label"
                              style={[styles.fieldLabel, { color: Colors[colorScheme].text }]}
                            >
                              Club Category
                            </Text>,
                            <View
                              key="club-category-input-wrapper"
                              style={[
                                styles.inputContainer,
                                {
                                  backgroundColor: Colors[colorScheme].surface,
                                  borderColor: Colors[colorScheme].border,
                                },
                              ]}
                              children={[
                                <MaterialIcons
                                  key="club-category-icon"
                                  name="local-library"
                                  size={20}
                                  color={Colors[colorScheme].mutedText}
                                />,
                                <TextInput
                                  key="club-category-input"
                                  value={extracurricularCategory}
                                  onChangeText={setExtracurricularCategory}
                                  placeholder="e.g. Theater, Chess, Debate, Robotics"
                                  placeholderTextColor={Colors[colorScheme].mutedText}
                                  style={[styles.textInput, { color: Colors[colorScheme].text }]}
                                  accessibilityLabel="Club category"
                                />,
                              ]}
                            />,
                          ]}
                        />
                      ) : null,
                    ]}
                  />,

                  clubType === 'sport' ? (
                    <View
                      key="sport-group"
                      style={styles.fieldGroup}
                      children={[
                        <Text
                          key="sport-label"
                          style={[styles.fieldLabel, { color: Colors[colorScheme].text }]}
                        >
                          Sport
                        </Text>,
                        <RNScrollView
                          key="sport-options"
                          horizontal
                          showsHorizontalScrollIndicator={false}
                          contentContainerStyle={{ paddingHorizontal: 4 }}
                          children={sports.map(sportOption => (
                            <Pressable
                              key={sportOption}
                              style={[
                                styles.chipButton,
                                {
                                  backgroundColor:
                                    sport === sportOption
                                      ? Colors[colorScheme].tint
                                      : Colors[colorScheme].surface,
                                  borderColor:
                                    sport === sportOption
                                      ? Colors[colorScheme].tint
                                      : Colors[colorScheme].border,
                                  opacity: selectedProgramId ? 0.5 : 1,
                                },
                              ]}
                              onPress={() => {
                                // Sport is locked while an existing program is
                                // selected — unselect the program to free it.
                                if (selectedProgramId) return;
                                setSport(sport === sportOption ? '' : sportOption);
                              }}
                              disabled={!!selectedProgramId}
                              accessibilityRole="button"
                              accessibilityLabel={sportOption}
                              accessibilityState={{
                                selected: sport === sportOption,
                                disabled: !!selectedProgramId,
                              }}
                              children={[
                                <Text
                                  key={`${sportOption}-text`}
                                  style={[
                                    styles.chipText,
                                    {
                                      color:
                                        sport === sportOption ? '#fff' : Colors[colorScheme].text,
                                    },
                                  ]}
                                >
                                  {sportOption}
                                </Text>,
                              ]}
                            />
                          ))}
                        />,
                        sport === 'Other' ? (
                          <TextInput
                            key="sport-other-input"
                            style={{
                              marginTop: 10,
                              borderWidth: 1,
                              borderRadius: 8,
                              paddingHorizontal: 12,
                              paddingVertical: 10,
                              fontSize: 15,
                              backgroundColor: Colors[colorScheme].surface,
                              borderColor: Colors[colorScheme].border,
                              color: Colors[colorScheme].text,
                            }}
                            value={customSport}
                            onChangeText={setCustomSport}
                            placeholder="Enter your sport name"
                            placeholderTextColor={Colors[colorScheme].mutedText}
                            accessibilityLabel="Custom sport name"
                          />
                        ) : null,
                      ]}
                    />
                  ) : null,

                  <View
                    key="season-group"
                    style={styles.fieldGroup}
                    children={[
                      <Text
                        key="season-label"
                        style={[styles.fieldLabel, { color: Colors[colorScheme].text }]}
                      >
                        Season
                      </Text>,
                      <View
                        key="season-grid"
                        style={styles.seasonGrid}
                        children={['Fall', 'Winter', 'Spring', 'Summer'].map(type => (
                          <Pressable
                            key={type}
                            style={[
                              styles.seasonButton,
                              {
                                backgroundColor:
                                  seasonType === type
                                    ? Colors[colorScheme].tint + '15'
                                    : Colors[colorScheme].surface,
                                borderColor:
                                  seasonType === type
                                    ? Colors[colorScheme].tint
                                    : Colors[colorScheme].border,
                              },
                            ]}
                            onPress={() => handleSeasonTypeSelect(type)}
                            accessibilityRole="button"
                            accessibilityLabel={`${type} season`}
                            accessibilityState={{ selected: seasonType === type }}
                            children={[
                              <MaterialIcons
                                key={`${type}-icon`}
                                name="event"
                                size={16}
                                color={
                                  seasonType === type
                                    ? Colors[colorScheme].tint
                                    : Colors[colorScheme].mutedText
                                }
                              />,
                              <Text
                                key={`${type}-text`}
                                style={[
                                  styles.seasonButtonText,
                                  {
                                    color:
                                      seasonType === type
                                        ? Colors[colorScheme].tint
                                        : Colors[colorScheme].text,
                                  },
                                ]}
                              >
                                {type}
                              </Text>,
                            ]}
                          />
                        ))}
                      />,
                      seasonType ? (
                        <View
                          key="season-year-group"
                          style={[styles.yearInputContainer, { marginTop: 12 }]}
                          children={[
                            <Text
                              key="season-year-label"
                              style={[
                                styles.fieldLabelSmall,
                                { color: Colors[colorScheme].mutedText },
                              ]}
                            >
                              Year
                            </Text>,
                            <View
                              key="season-year-input-wrapper"
                              style={[
                                styles.yearInput,
                                {
                                  backgroundColor: Colors[colorScheme].surface,
                                  borderColor: Colors[colorScheme].border,
                                },
                              ]}
                              children={[
                                <TextInput
                                  key="season-year-input"
                                  value={seasonYear}
                                  onChangeText={setSeasonYear}
                                  placeholder="2025"
                                  keyboardType="number-pad"
                                  maxLength={4}
                                  placeholderTextColor={Colors[colorScheme].mutedText}
                                  style={[
                                    styles.yearInputText,
                                    { color: Colors[colorScheme].text },
                                  ]}
                                  accessibilityLabel="Season year"
                                />,
                              ]}
                            />,
                            season ? (
                              <Text
                                key="season-preview"
                                style={[
                                  styles.seasonPreview,
                                  { color: Colors[colorScheme].mutedText },
                                ]}
                              >
                                Season: {season}
                              </Text>
                            ) : null,
                          ]}
                        />
                      ) : null,
                    ]}
                  />,

                  <View
                    key="team-color-group"
                    style={styles.fieldGroup}
                    children={[
                      <Text
                        key="team-color-label"
                        style={[styles.fieldLabel, { color: Colors[colorScheme].text }]}
                      >
                        Team Color <Text style={{ color: Colors[colorScheme].destructive }}>*</Text>
                      </Text>,
                      <Text
                        key="team-color-hint"
                        style={[
                          styles.fieldHint,
                          { color: Colors[colorScheme].mutedText, marginBottom: 12 },
                        ]}
                      >
                        Select your team's primary color for branding
                      </Text>,
                      <View
                        key="team-color-grid"
                        style={styles.colorGrid}
                        children={teamColors.map(color => (
                          <Pressable
                            key={color.hex}
                            style={[
                              styles.colorButton,
                              {
                                backgroundColor: color.hex,
                                // audit: hairline keeps White/Silver swatches visible on light bg
                                borderWidth: teamColor === color.hex ? 3 : 1,
                                borderColor:
                                  teamColor === color.hex
                                    ? Colors[colorScheme].text
                                    : 'rgba(128,128,128,0.35)',
                              },
                            ]}
                            onPress={() => {
                              Keyboard.dismiss();
                              setTeamColor(color.hex);
                              setColorError('');
                            }}
                            accessibilityRole="button"
                            accessibilityLabel={`${color.name} color`}
                            accessibilityState={{ selected: teamColor === color.hex }}
                            children={
                              teamColor === color.hex
                                ? [
                                    <MaterialIcons
                                      key={`${color.hex}-check`}
                                      name="check"
                                      size={20}
                                      color={
                                        [
                                          '#FFFFFF',
                                          '#C0C0C0',
                                          '#EAB308',
                                          '#F59E0B',
                                          '#D4AF37',
                                        ].includes(color.hex)
                                          ? '#111827' /* audit: icon-on-swatch contrast, not a text color */
                                          : '#fff'
                                      }
                                    />,
                                  ]
                                : []
                            }
                          />
                        ))}
                      />,
                      teamColor ? (
                        <Text
                          key="team-color-preview"
                          style={[styles.colorPreview, { color: Colors[colorScheme].mutedText }]}
                        >
                          Selected: {teamColors.find(c => c.hex === teamColor)?.name}
                        </Text>
                      ) : null,
                      colorError ? (
                        <Text
                          key="team-color-error"
                          style={{ color: '#EF4444', fontSize: 13, marginTop: 4 }}
                        >
                          {colorError}
                        </Text>
                      ) : null,
                    ]}
                  />,

                  <View
                    key="organization-group"
                    style={styles.fieldGroup}
                    children={[
                      <Text
                        key="org-label"
                        style={[styles.fieldLabel, { color: Colors[colorScheme].text }]}
                      >
                        School / Organization
                      </Text>,
                      <Pressable
                        key="org-picker-trigger"
                        onPress={() => {
                          Keyboard.dismiss();
                          setOrgModalSearch('');
                          setOrgSearchResults([]);
                          setShowOrgPicker(true);
                        }}
                        style={[
                          styles.textInput,
                          {
                            backgroundColor: Colors[colorScheme].surface,
                            borderColor: selectedOrgId
                              ? Colors[colorScheme].tint
                              : organizationName
                                ? Colors[colorScheme].border
                                : Colors[colorScheme].border,
                            flexDirection: 'row',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                          },
                        ]}
                        accessibilityRole="button"
                        accessibilityLabel={
                          organizationName
                            ? `Selected organization: ${organizationName}`
                            : 'Select a school or organization'
                        }
                        children={[
                          <Text
                            key="org-picker-label"
                            style={{
                              color: organizationName
                                ? Colors[colorScheme].text
                                : Colors[colorScheme].mutedText,
                              fontSize: 15,
                              flex: 1,
                            }}
                            numberOfLines={1}
                          >
                            {organizationName || 'Select a school or organization'}
                          </Text>,
                          <MaterialIcons
                            key="org-picker-icon"
                            name="arrow-drop-down"
                            size={24}
                            color={Colors[colorScheme].mutedText}
                          />,
                        ]}
                      />,
                      selectedOrgId ? (
                        <View
                          key="org-selected-row"
                          style={{ flexDirection: 'row', alignItems: 'center', marginTop: 4 }}
                          children={[
                            <Text
                              key="org-selected-label"
                              style={{
                                color: Colors[colorScheme].tint,
                                fontSize: 13,
                                fontWeight: '600',
                                flex: 1,
                              }}
                            >
                              Linked to existing organization
                            </Text>,
                            <Pressable
                              key="org-selected-remove"
                              onPress={() => {
                                setSelectedOrgId(null);
                                setOrganizationName('');
                              }}
                              hitSlop={8}
                              accessibilityRole="button"
                              accessibilityLabel="Remove selected organization"
                              children={[
                                <Text
                                  key="org-selected-remove-label"
                                  style={{
                                    color: Colors[colorScheme].mutedText,
                                    fontSize: 16,
                                    lineHeight: 16,
                                  }}
                                >
                                  Remove
                                </Text>,
                              ]}
                            />,
                          ]}
                        />
                      ) : null,
                    ]}
                  />,

                  selectedOrgId && clubType === 'sport' ? (
                    <View
                      key="program-group"
                      style={styles.fieldGroup}
                      children={[
                        <Text
                          key="program-label"
                          style={[styles.fieldLabel, { color: Colors[colorScheme].text }]}
                        >
                          Program
                        </Text>,
                        <Text
                          key="program-hint"
                          style={[
                            styles.fieldHint,
                            { color: Colors[colorScheme].mutedText, marginBottom: 8 },
                          ]}
                        >
                          Group this team under an existing program, or start a new one
                        </Text>,
                        <RNScrollView
                          key="program-options"
                          horizontal
                          showsHorizontalScrollIndicator={false}
                          contentContainerStyle={{ paddingHorizontal: 4 }}
                          children={[
                            ...(orgPrograms ?? []).map(program => (
                              <Pressable
                                key={program.id}
                                style={[
                                  styles.chipButton,
                                  {
                                    backgroundColor:
                                      selectedProgramId === program.id
                                        ? Colors[colorScheme].tint
                                        : Colors[colorScheme].surface,
                                    borderColor:
                                      selectedProgramId === program.id
                                        ? Colors[colorScheme].tint
                                        : Colors[colorScheme].border,
                                  },
                                ]}
                                onPress={() => handleSelectProgram(program)}
                                accessibilityRole="button"
                                accessibilityLabel={formatProgramLabel(program)}
                                accessibilityState={{ selected: selectedProgramId === program.id }}
                                children={[
                                  <Text
                                    key={`${program.id}-text`}
                                    style={[
                                      styles.chipText,
                                      {
                                        color:
                                          selectedProgramId === program.id
                                            ? '#fff'
                                            : Colors[colorScheme].text,
                                      },
                                    ]}
                                  >
                                    {formatProgramLabel(program)}
                                  </Text>,
                                ]}
                              />
                            )),
                            <Pressable
                              key="program-new-chip"
                              style={[
                                styles.chipButton,
                                {
                                  backgroundColor: creatingProgram
                                    ? Colors[colorScheme].tint
                                    : Colors[colorScheme].surface,
                                  borderColor: creatingProgram
                                    ? Colors[colorScheme].tint
                                    : Colors[colorScheme].border,
                                },
                              ]}
                              onPress={handleToggleNewProgram}
                              accessibilityRole="button"
                              accessibilityLabel="New program"
                              accessibilityState={{ selected: creatingProgram }}
                              children={[
                                <Text
                                  key="program-new-chip-text"
                                  style={[
                                    styles.chipText,
                                    { color: creatingProgram ? '#fff' : Colors[colorScheme].text },
                                  ]}
                                >
                                  New program
                                </Text>,
                              ]}
                            />,
                          ]}
                        />,
                        <View
                          key="team-gender-group"
                          style={{ marginTop: 12 }}
                          children={[
                            <Text
                              key="team-gender-label"
                              style={[
                                styles.fieldLabelSmall,
                                { color: Colors[colorScheme].mutedText },
                              ]}
                            >
                              Gender (optional)
                            </Text>,
                            <View
                              key="team-gender-options"
                              style={{
                                flexDirection: 'row',
                                flexWrap: 'wrap',
                                gap: 8,
                                marginTop: 6,
                              }}
                              children={GENDER_OPTIONS.map(genderOption => (
                                <Pressable
                                  key={genderOption.value}
                                  style={[
                                    styles.chipButton,
                                    {
                                      backgroundColor:
                                        teamGender === genderOption.value
                                          ? Colors[colorScheme].tint
                                          : Colors[colorScheme].surface,
                                      borderColor:
                                        teamGender === genderOption.value
                                          ? Colors[colorScheme].tint
                                          : Colors[colorScheme].border,
                                    },
                                  ]}
                                  onPress={() =>
                                    setTeamGender(
                                      teamGender === genderOption.value ? null : genderOption.value
                                    )
                                  }
                                  accessibilityRole="button"
                                  accessibilityLabel={genderOption.label}
                                  accessibilityState={{
                                    selected: teamGender === genderOption.value,
                                  }}
                                  children={[
                                    <Text
                                      key={`${genderOption.value}-text`}
                                      style={[
                                        styles.chipText,
                                        {
                                          color:
                                            teamGender === genderOption.value
                                              ? '#fff'
                                              : Colors[colorScheme].text,
                                        },
                                      ]}
                                    >
                                      {genderOption.label}
                                    </Text>,
                                  ]}
                                />
                              ))}
                            />,
                          ]}
                        />,
                        selectedProgramId || creatingProgram ? (
                          <View
                            key="program-level-group"
                            style={{ marginTop: 14 }}
                            children={[
                              <Text
                                key="program-level-label"
                                style={[
                                  styles.fieldLabelSmall,
                                  { color: Colors[colorScheme].mutedText },
                                ]}
                              >
                                Level (optional)
                              </Text>,
                              <View
                                key="program-level-options"
                                style={{
                                  flexDirection: 'row',
                                  flexWrap: 'wrap',
                                  gap: 8,
                                  marginTop: 6,
                                }}
                                children={LEVEL_OPTIONS.map(levelOption => (
                                  <Pressable
                                    key={levelOption.value}
                                    style={[
                                      styles.chipButton,
                                      {
                                        backgroundColor:
                                          selectedLevel === levelOption.value
                                            ? Colors[colorScheme].tint
                                            : Colors[colorScheme].surface,
                                        borderColor:
                                          selectedLevel === levelOption.value
                                            ? Colors[colorScheme].tint
                                            : Colors[colorScheme].border,
                                      },
                                    ]}
                                    onPress={() =>
                                      setSelectedLevel(
                                        selectedLevel === levelOption.value
                                          ? null
                                          : levelOption.value
                                      )
                                    }
                                    accessibilityRole="button"
                                    accessibilityLabel={levelOption.label}
                                    accessibilityState={{
                                      selected: selectedLevel === levelOption.value,
                                    }}
                                    children={[
                                      <Text
                                        key={`${levelOption.value}-text`}
                                        style={[
                                          styles.chipText,
                                          {
                                            color:
                                              selectedLevel === levelOption.value
                                                ? '#fff'
                                                : Colors[colorScheme].text,
                                          },
                                        ]}
                                      >
                                        {levelOption.label}
                                      </Text>,
                                    ]}
                                  />
                                ))}
                              />,
                            ]}
                          />
                        ) : null,
                      ]}
                    />
                  ) : null,

                  <View
                    key="description-group"
                    style={styles.fieldGroup}
                    children={[
                      <View
                        key="description-header"
                        style={styles.fieldLabelRow}
                        children={[
                          <Text
                            key="description-label"
                            style={[styles.fieldLabel, { color: Colors[colorScheme].text }]}
                          >
                            Description
                          </Text>,
                          <Text
                            key="description-count"
                            style={[
                              styles.charCount,
                              {
                                color:
                                  description.length > 500
                                    ? Colors[colorScheme].destructive
                                    : Colors[colorScheme].mutedText,
                              },
                            ]}
                          >
                            {description.length}/500
                          </Text>,
                        ]}
                      />,
                      <View
                        key="description-input-wrapper"
                        style={[
                          styles.textAreaContainer,
                          {
                            backgroundColor: Colors[colorScheme].surface,
                            borderColor:
                              description.length > 500 ? '#DC2626' : Colors[colorScheme].border,
                          },
                        ]}
                        children={[
                          <TextInput
                            key="description-input"
                            value={description}
                            onChangeText={text => {
                              if (text.length <= 500) {
                                setDescription(text);
                              }
                            }}
                            placeholder="Tell players what this team is about..."
                            placeholderTextColor={Colors[colorScheme].mutedText}
                            style={[styles.textArea, { color: Colors[colorScheme].text }]}
                            multiline
                            numberOfLines={4}
                            textAlignVertical="top"
                            maxLength={1000}
                            accessibilityLabel="Team description"
                          />,
                        ]}
                      />,
                    ]}
                  />,
                ]}
              />,

              <View
                key="action-section"
                style={styles.actionSection}
                children={[
                  limitReached ? (
                    <View
                      key="limit-warning"
                      style={styles.limitWarning}
                      children={[
                        <MaterialIcons
                          key="limit-warning-icon"
                          name="error"
                          size={18}
                          color={colorScheme === 'dark' ? Colors[colorScheme].tint : '#B45309'}
                        />,
                        <Text key="limit-warning-text" style={styles.limitWarningText}>
                          {Platform.OS === 'ios'
                            ? "You've reached the maximum number of teams."
                            : `You've reached the ${planDisplayName} plan limit. Upgrade to create more teams.`}
                        </Text>,
                      ]}
                    />
                  ) : null,
                  <Pressable
                    key="create-button"
                    style={[
                      styles.createButton,
                      {
                        backgroundColor:
                          submitting || limitReached || !name.trim()
                            ? Colors[colorScheme].mutedText
                            : Colors[colorScheme].tint,
                        opacity: submitting || limitReached || !name.trim() ? 0.5 : 1,
                      },
                    ]}
                    onPress={onSubmit}
                    disabled={submitting || limitReached || !name.trim()}
                    accessibilityRole="button"
                    accessibilityLabel={submitting ? 'Creating team' : 'Create team'}
                    children={[
                      submitting ? (
                        <ActivityIndicator key="create-button-spinner" color="#fff" size="small" />
                      ) : (
                        <MaterialIcons
                          key="create-button-icon"
                          name="check"
                          size={20}
                          color="#fff"
                        />
                      ),
                      <Text key="create-button-label" style={styles.createButtonText}>
                        {submitting ? 'Creating Team...' : 'Create Team'}
                      </Text>,
                    ]}
                  />,
                ]}
              />,
            ]}
          />,
        ]}
      />

      {showOrgPicker ? (
        <Modal
          key="org-picker-modal"
          visible
          transparent
          animationType="slide"
          onRequestClose={() => setShowOrgPicker(false)}
        >
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={{ flex: 1 }}
            keyboardVerticalOffset={0}
            children={[
              <View
                key="org-picker-overlay"
                style={styles.orgPickerOverlay}
                children={[
                  <View
                    key="org-picker-container"
                    style={[
                      styles.orgPickerContainer,
                      { backgroundColor: Colors[colorScheme].background },
                    ]}
                    children={[
                      <View
                        key="org-picker-header"
                        style={[
                          styles.orgPickerHeader,
                          { borderBottomColor: Colors[colorScheme].border },
                        ]}
                        children={[
                          <Pressable
                            key="org-picker-cancel"
                            onPress={() => {
                              setShowOrgPicker(false);
                              setOrgModalSearch('');
                              setOrgSearchResults([]);
                            }}
                            accessibilityRole="button"
                            accessibilityLabel="Cancel"
                            children={[
                              <Text
                                key="org-picker-cancel-label"
                                style={[
                                  styles.orgPickerHeaderButton,
                                  { color: Colors[colorScheme].text },
                                ]}
                              >
                                Cancel
                              </Text>,
                            ]}
                          />,
                          <Text
                            key="org-picker-title"
                            style={[styles.orgPickerTitle, { color: Colors[colorScheme].text }]}
                          >
                            Select Organization
                          </Text>,
                          <View key="org-picker-header-spacer" style={{ width: 50 }} />,
                        ]}
                      />,
                      <View
                        key="org-picker-search-section"
                        style={{ paddingHorizontal: 16, paddingVertical: 12 }}
                        children={[
                          <View
                            key="org-picker-search-bar"
                            style={[
                              styles.orgPickerSearchBar,
                              {
                                backgroundColor: Colors[colorScheme].surface,
                                borderColor: Colors[colorScheme].border,
                              },
                            ]}
                            children={[
                              <MaterialIcons
                                key="org-picker-search-icon"
                                name="search"
                                size={20}
                                color={Colors[colorScheme].mutedText}
                              />,
                              <TextInput
                                key="org-picker-search-input"
                                value={orgModalSearch}
                                onChangeText={handleOrgModalSearch}
                                placeholder="Search organizations..."
                                placeholderTextColor={Colors[colorScheme].mutedText}
                                style={[
                                  styles.orgPickerSearchInput,
                                  { color: Colors[colorScheme].text },
                                ]}
                                autoFocus
                                accessibilityLabel="Search organizations"
                              />,
                              orgSearching ? (
                                <ActivityIndicator
                                  key="org-picker-search-spinner"
                                  size="small"
                                  color={Colors[colorScheme].tint}
                                />
                              ) : null,
                            ]}
                          />,
                        ]}
                      />,
                      <RNScrollView
                        key="org-picker-list"
                        style={styles.orgPickerList}
                        keyboardShouldPersistTaps="handled"
                        children={[
                          orgModalSearch.trim().length < 2 && orgSearchResults.length === 0 ? (
                            <View
                              key="org-picker-empty-initial"
                              style={styles.orgPickerEmpty}
                              children={[
                                <MaterialIcons
                                  key="org-picker-empty-icon"
                                  name="business"
                                  size={40}
                                  color={Colors[colorScheme].mutedText}
                                />,
                                <Text
                                  key="org-picker-empty-label"
                                  style={[
                                    styles.orgPickerEmptyText,
                                    { color: Colors[colorScheme].mutedText },
                                  ]}
                                >
                                  Type at least 2 characters to search
                                </Text>,
                              ]}
                            />
                          ) : null,
                          orgModalSearch.trim().length >= 2 &&
                          !orgSearching &&
                          orgSearchResults.length === 0 ? (
                            <View
                              key="org-picker-empty-results"
                              style={styles.orgPickerEmpty}
                              children={[
                                <Text
                                  key="org-picker-empty-results-label"
                                  style={[
                                    styles.orgPickerEmptyText,
                                    { color: Colors[colorScheme].mutedText },
                                  ]}
                                >
                                  No approved organizations found. Select an existing organization
                                  to continue.
                                </Text>,
                              ]}
                            />
                          ) : null,
                          ...orgSearchResults.map(org => (
                            <Pressable
                              key={org.id}
                              style={[
                                styles.orgPickerItem,
                                { borderBottomColor: Colors[colorScheme].border },
                                selectedOrgId === org.id && {
                                  backgroundColor: Colors[colorScheme].surface,
                                },
                              ]}
                              onPress={() => handleSelectOrg(org)}
                              accessibilityRole="button"
                              accessibilityLabel={`Select ${org.name}`}
                              children={[
                                <View
                                  key={`${org.id}-content`}
                                  style={styles.orgPickerItemContent}
                                  children={[
                                    <MaterialIcons
                                      key={`${org.id}-icon`}
                                      name="business"
                                      size={24}
                                      color={Colors[colorScheme].mutedText}
                                    />,
                                    <View
                                      key={`${org.id}-text`}
                                      style={{ flex: 1 }}
                                      children={[
                                        <Text
                                          key={`${org.id}-name`}
                                          style={[
                                            styles.orgPickerItemText,
                                            { color: Colors[colorScheme].text },
                                          ]}
                                        >
                                          {org.name}
                                        </Text>,
                                        org.description ? (
                                          <Text
                                            key={`${org.id}-description`}
                                            style={{
                                              color: Colors[colorScheme].mutedText,
                                              fontSize: 12,
                                            }}
                                            numberOfLines={1}
                                          >
                                            {org.description}
                                          </Text>
                                        ) : null,
                                      ]}
                                    />,
                                  ]}
                                />,
                                selectedOrgId === org.id ? (
                                  <MaterialIcons
                                    key={`${org.id}-check`}
                                    name="check"
                                    size={20}
                                    color={Colors[colorScheme].tint}
                                  />
                                ) : null,
                              ]}
                            />
                          )),
                        ]}
                      />,
                    ]}
                  />,
                ]}
              />,
            ]}
          />
        </Modal>
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8FAFC',
  },
  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 16,
  },
  backButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '800',
  },
  // Intro Card
  introCard: {
    margin: 16,
    padding: 24,
    borderRadius: 16,
    alignItems: 'center',
    borderWidth: 1,
  },
  limitCard: {
    marginHorizontal: 16,
    marginBottom: 16,
    padding: 16,
    borderRadius: 14,
    borderWidth: 1,
  },
  limitHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  limitBadge: {
    fontSize: 12,
    fontWeight: '700',
    paddingVertical: 4,
    paddingHorizontal: 10,
    borderRadius: 999,
    overflow: 'hidden',
  },
  limitUpgradeLink: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  limitUpgradeText: {
    fontWeight: '600',
  },
  limitTitle: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 4,
  },
  limitDescription: {
    fontSize: 14,
    lineHeight: 20,
  },
  introIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  introTitle: {
    fontSize: 24,
    fontWeight: '800',
    marginBottom: 8,
  },
  introSubtitle: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 22,
  },
  // Form
  formSection: {
    paddingHorizontal: 16,
  },
  fieldGroup: {
    marginBottom: 24,
  },
  fieldLabelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  fieldLabel: {
    fontSize: 16,
    fontWeight: '700',
  },
  charCount: {
    fontSize: 13,
    fontWeight: '500',
  },
  inputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    height: 52,
    borderRadius: 12,
    borderWidth: 1,
  },
  textInput: {
    flex: 1,
    fontSize: 16,
    marginLeft: 12,
  },
  // Sport chips
  chipButton: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    marginRight: 8,
    borderWidth: 1,
  },
  chipText: {
    fontSize: 14,
    fontWeight: '600',
  },
  clubTypeContainer: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 8,
  },
  clubTypeButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1,
    gap: 8,
    position: 'relative',
  },
  clubTypeText: {
    fontSize: 15,
    fontWeight: '600',
  },
  legendBadge: {
    position: 'absolute',
    top: 4,
    right: 4,
    backgroundColor: '#F59E0B',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  legendBadgeText: {
    fontSize: 9,
    fontWeight: '800',
    color: '#fff',
    textTransform: 'uppercase',
  },
  // Season grid
  seasonGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  seasonButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: 1,
    gap: 8,
    minWidth: '47%',
  },
  seasonButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  // Description
  textAreaContainer: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
    minHeight: 100,
  },
  textArea: {
    fontSize: 16,
    textAlignVertical: 'top',
    minHeight: 80,
  },
  // Action
  actionSection: {
    paddingHorizontal: 16,
    paddingTop: 24,
  },
  limitWarning: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: '#FEF3C7',
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
  },
  limitWarningText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
    color: 'transparent', // Will be overridden with theme color
  },
  createButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 52,
    borderRadius: 16,
    gap: 8,
  },
  createButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  // Logo styles
  logoSection: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  logoContainer: {
    width: 80,
    height: 80,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  logoImage: {
    width: '100%',
    height: '100%',
    borderRadius: 12,
  },
  logoPlaceholderText: {
    fontSize: 12,
    fontWeight: '600',
    marginTop: 4,
  },
  logoActions: {
    flex: 1,
    gap: 8,
  },
  logoActionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 6,
  },
  logoActionText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  fieldHint: {
    fontSize: 12,
    marginTop: 4,
    lineHeight: 16,
  },
  // Year input styles
  yearInputContainer: {
    gap: 8,
  },
  fieldLabelSmall: {
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  yearInput: {
    height: 48,
    paddingHorizontal: 16,
    borderRadius: 12,
    borderWidth: 1.5,
    justifyContent: 'center',
  },
  yearInputText: {
    fontSize: 16,
    fontWeight: '600',
  },
  seasonPreview: {
    fontSize: 14,
    fontWeight: '600',
    fontStyle: 'italic',
  },
  colorGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  colorButton: {
    width: 50,
    height: 50,
    borderRadius: 25,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 2,
    ...(Platform.OS === 'web'
      ? { boxShadow: '0px 2px 4px rgba(0, 0, 0, 0.2)' }
      : {
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 2 },
          shadowOpacity: 0.2,
          shadowRadius: 4,
        }),
  },
  colorPreview: {
    fontSize: 14,
    fontWeight: '600',
    marginTop: 8,
  },
  orgPickerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  orgPickerContainer: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    maxHeight: '80%',
  },
  orgPickerHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
  },
  orgPickerHeaderButton: {
    fontSize: 16,
    fontWeight: '600',
  },
  orgPickerTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  orgPickerSearchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    gap: 8,
  },
  orgPickerSearchInput: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 10,
  },
  orgPickerList: {
    maxHeight: 400,
  },
  orgPickerItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    borderBottomWidth: 1,
  },
  orgPickerItemContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    flex: 1,
  },
  orgPickerItemText: {
    fontSize: 16,
  },
  orgPickerEmpty: {
    padding: 32,
    alignItems: 'center',
    gap: 12,
  },
  orgPickerEmptyText: {
    fontSize: 14,
    textAlign: 'center',
  },
});

export default CreateTeamScreen;
